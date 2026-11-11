import * as fs from 'fs';
import { debug, recentLog } from './log';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  app, BrowserWindow, clipboard, ipcMain, desktopCapturer, Menu, MenuItemConstructorOptions, NativeImage, Notification, powerMonitor,
  screen, session as electronSession, Session, shell, Tray, WebContents,
} from 'electron';
import { HidFilter, ResolvedApp, getApp, loadApps, upsertApp } from './config';
import { dialScript, findCallLink, numberFromLink, selectorScript } from './calls';
import { badgeIcon, parseUnread } from './badge';
import { defaultIcon, imageFromBuffer, imageHasTransparency, loadIconFile, styleIcon } from './icons';
import { desktopId, isInstalled, stableIcon } from './desktop';
import { NotificationBridge } from './notifications';
import { isSafeExternal, looksLikeAuth, OriginMatcher } from './origins';
import { assetPath, CONFIG_FILE, ensureDir, ICON_DIR, IN_FLATPAK, readVersionMarker, releaseVersion, spawnSelf } from './paths';
import { MemorySample, StateStore } from './state';
import { backgroundCheck, isNewer, UpdateInfo } from './updater';

/** Permissions granted to allowed origins unless the config adds more. */
const BASE_PERMISSIONS = [
  'media',                      // microphone + camera
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'speaker-selection',          // choose the headset as audio output (setSinkId)
  'fullscreen',
  'hid',                        // WebHID permission checks; device grants are filtered below
];

/**
 * Present a plain Chrome user agent. Electron inserts "<AppName>/<version>"
 * and "Electron/<version>", which makes some sites (Microsoft, Google sign-in,
 * WebRTC softphones) treat us as an unsupported browser.
 */

type UnreadSource = 'folder' | 'badge' | 'title' | 'rows';

/**
 * Runs in the page. Returns the Inbox unread count from the folder list
 * (-1 if there is no Inbox entry), the number of unread rows at the top of the
 * inbox message list (-1 when not looking at the inbox, or scrolled down), and
 * a few labels for diagnostics. Message subjects are not included.
 */
export const UNREAD_PROBE = `(() => {
  const probe = { folderLabels: [], rowCount: 0, unreadRows: -1, path: location.pathname };
  let folder = -1;
  const isInbox = (t) => /^\\s*inbox\\b/i.test(t);
  for (const e of document.querySelectorAll('[role=treeitem], [role=tree] [title], nav [aria-label], [data-folder-name]')) {
    const label = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('data-folder-name') || '')).trim();
    const lines = (e.innerText || '').split('\\n').map((x) => x.trim()).filter(Boolean);
    const text = label || lines.join(' ');
    if (!/inbox/i.test(text) || text.length > 120) continue;
    if (probe.folderLabels.length < 8) probe.folderLabels.push(label + ' | ' + lines.slice(0, 3).join(' / '));
    let n = -1;
    // Numbers may have separators: "Inbox - 105,093 items (4,270 unread)".
    const m = /\\binbox\\b.{0,60}?(\\d[\\d,.\\u00a0\\u202f\\u2009]*)\\s*(?:unread|new)/i.exec(label)
      || /(\\d[\\d,.\\u00a0\\u202f\\u2009]*)\\s*(?:unread|new)\\b[^\\d]{0,40}?\\binbox\\b/i.exec(label);
    if (m) n = Number(m[1].replace(/\\D/g, ''));
    else if (lines.length && isInbox(lines[0])) {
      const num = lines.slice(1).find((x) => /^\\d+$/.test(x));
      n = num ? Number(num) : 0;
    } else if (isInbox(label) && /^\\s*inbox\\s*$/i.test(label.split(',')[0]) && !/\\d/.test(label)) n = 0;
    if (n >= 0) folder = Math.max(folder, n);
  }
  let rows = -1;
  const inInbox = /^\\/mail(\\/\\d+)?\\/?(inbox(\\/.*)?)?$/i.test(location.pathname);
  const list = document.querySelectorAll('[role=listbox] [role=option], [role=grid] [role=row]');
  probe.rowCount = list.length;
  if (inInbox && list.length) {
    let scroller = list[0].parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
    if (!scroller || scroller.scrollTop < 40) {
      rows = 0;
      for (const r of list) if (/^\\s*unread\\b/i.test(r.getAttribute('aria-label') || '') || r.getAttribute('aria-label')?.toLowerCase().includes(' unread ')) rows++;
    }
  }
  probe.unreadRows = rows;
  return { folder, rows, probe };
})()`;

/** Runs in the page: sender/subject/preview of the first unread message row. */
export const TOP_UNREAD = `(() => {
  const TIME = /^(\\d{1,2}[:.]\\d{2}\\s*(am|pm)?|yesterday|today|(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?(\\s+\\d{1,2}[:.]\\d{2}\\s*(am|pm)?)?|\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?)$/i;
  const TIME_IN = /\\s+\\d{1,2}[:.]\\d{2}\\s*(?:am|pm)?\\s+/i;
  const rows = document.querySelectorAll('[role=listbox] [role=option], [role=grid] [role=row], [role=option], [role=listitem], [role=article]');
  for (const r of rows) {
    const label = (r.getAttribute('aria-label') || '').toLowerCase();
    if (!/\\bunread\\b/.test(label)) continue;
    // Each piece (sender, subject, time, preview) is its own element even
    // when the row's text is one line: read the innermost elements in order.
    const parts = [];
    for (const e of r.querySelectorAll('*')) {
      if (e.childElementCount || e.closest('[aria-hidden=true]') || /^(button|svg|path|i)$/i.test(e.tagName)) continue;
      const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t.length < 2 || TIME.test(t) || parts[parts.length - 1] === t) continue;
      parts.push(t);
    }
    if (parts.length >= 2) return parts.slice(0, 4);
    // Fallback: the row's text, split around the time.
    const text = (r.innerText || '').split('\\n').map((x) => x.trim()).filter((x) => x && !TIME.test(x));
    if (text.length === 1) return text[0].split(TIME_IN).filter(Boolean).slice(0, 4);
    if (text.length) return text.slice(0, 4);
    const al = r.getAttribute('aria-label').replace(/^\\s*unread[,\\s]*/i, '').trim();
    if (al) return [al];
  }
  return [];
})()`;

function gdbus(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications', ...args], { timeout: 4000 },
    (err, stdout, stderr) => resolve(err ? `error: ${(stderr || err.message).trim()}` : stdout.trim()));
  });
}

/**
 * For diagnostics: which notification server answers and whether it is in
 * Do Not Disturb ("Inhibited").
 */
async function notificationServerReport(): Promise<string[]> {
  const info = await gdbus(['--method', 'org.freedesktop.Notifications.GetServerInformation']);
  const inhibited = await gdbus(['--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Notifications', 'Inhibited']);
  return [
    `notification server: ${info}`,
    `do not disturb (Inhibited): ${inhibited}`,
  ];
}

export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\(KHTML, like Gecko\)\s+(?:\S+\/\S+\s+)*?(Chrome\/)/, '(KHTML, like Gecko) $1')
    .replace(/\sElectron\/\S+/g, '');
}

function hidMatches(filters: HidFilter[], d: { vendorId: number; productId: number }): boolean {
  return filters.some((f) => f.vendorId === d.vendorId && (f.productId == null || f.productId === d.productId));
}

export class AppRuntime {
  private cfg: ResolvedApp;
  private matcher: OriginMatcher;
  private state: StateStore;
  private ses: Session;
  private win!: BrowserWindow;
  private tray: Tray | null = null;
  private children = new Set<BrowserWindow>();
  private baseIcon: NativeImage = defaultIcon();
  private unread = 0;
  private quitting = false;
  private shownAt = 0;
  private update: UpdateInfo | null = null;
  private notifications: NotificationBridge;
  private preload = path.join(__dirname, 'preload', 'app-preload.js');

  constructor(cfg: ResolvedApp, private startHidden: boolean, private pendingCall: string | null = null) {
    this.cfg = cfg;
    this.matcher = new OriginMatcher(cfg.allowed_origins);
    this.state = new StateStore(cfg.id);
    this.ses = electronSession.fromPartition(`persist:${cfg.id}`);
    this.notifications = new NotificationBridge({
      session: this.ses,
      appIcon: () => this.baseIcon,
      isMuted: () => !!this.state.data.muted,
      urgent: !!cfg.urgent_notifications,
      raiseOnNotification: !!cfg.raise_on_notification,
      isAllowed: (u) => this.matcher.matches(u),
      activate: () => this.showAll(),
      appName: cfg.name,
      desktopEntry: desktopId(cfg.id),
    });
  }

  async start(): Promise<void> {
    this.baseIcon = styleIcon(await loadIconFile(this.cfg.iconPath), this.cfg);
    // No application menu: its default accelerators (Ctrl+W, Ctrl+Q…) would
    // close or quit the app. Editing shortcuts keep working without it.
    Menu.setApplicationMenu(null);
    this.setupSession();
    this.createWindow();
    this.createTray();
    this.setupLifecycle();
    this.scheduleUpdateChecks();
    this.watchMemory();
    this.watchSessionCookies();
    this.watchForNewVersion();
    this.watchUnreadInPage();
    ipcMain.on('wt:badge', (_e, count: number) => this.onAppBadge(Number(count)));
    ipcMain.on('wt:visibility', (e, state: string) => {
      if (e.sender === this.win.webContents) {
        debug(`page visibility: ${state} (window visible=${this.win.isVisible()} minimized=${this.win.isMinimized()} focused=${this.win.isFocused()})`);
      }
      // Page hidden while its window is still "shown": the compositor minimized it.
      if (state === 'hidden' && e.sender === this.win.webContents && this.cfg.minimize_to_tray
        && this.win.isVisible() && Date.now() - this.shownAt > 1000) {
        debug('page hidden while window shown: treating as minimize');
        this.hideAll();
      }
    });
    this.watchConfig();
    debug(`WebRoost ${releaseVersion()} running ${this.cfg.id} on ${app.commandLine.getSwitchValue('ozone-platform') || 'auto'} display: notify_on_unread=${!!this.cfg.notify_on_unread} minimize_to_tray=${!!this.cfg.minimize_to_tray} urgent=${!!this.cfg.urgent_notifications} session=${process.env.XDG_SESSION_TYPE ?? '?'}`);
    this.ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus !== 'running') return;
      const sw = this.ses.serviceWorkers.getWorkerFromVersionID(versionId);
      if (sw && !this.badgeWorkers.has(versionId)) {
        this.badgeWorkers.add(versionId);
        sw.ipc.on('wt:badge', (_e, count: number) => this.onAppBadge(Number(count)));
      }
    });
    if (this.pendingCall) {
      const link = this.pendingCall;
      this.pendingCall = null;
      this.win.webContents.once('did-finish-load', () => setTimeout(() => void this.dial(link), 1500));
    }
  }

  // ------------------------------------------------------------ click-to-call
  private dialing = false;

  /** Type the number from a tel:/callto:/sip: link into the softphone and press call. */
  async dial(link: string, dry = false) {
    const num = numberFromLink(link);
    if (!num) return;
    this.showAll();
    if (this.dialing) return;
    this.dialing = true;
    const wc = this.win.webContents;
    try {
      debug(`dialing ${num} (from ${link})`);
      const sel = { input: this.cfg.dial_input, button: this.cfg.dial_button, open: this.cfg.dial_open, dry };
      const result: string = await wc.executeJavaScript(dialScript(num, sel), true);
      debug(`dial result: ${result}`);
      if (dry) {
        this.notifications.notify(`${this.cfg.name}: click-to-call test`, result === 'no-input'
          ? 'No number field found. Right-click the dialpad field and choose "Use for click-to-call: number field".'
          : result === 'dry-button' ? 'Number field found and filled; the call button is outlined in red. Nothing was dialed.'
            : 'Number field found and filled, but no call button: Enter will be pressed instead. Right-click the call button and choose "Call button" to set it.');
        return;
      }
      if (result === 'no-button') {
        // Press a real Enter in the number field (some dialpads only call on Enter).
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      } else if (result === 'no-input') {
        clipboard.writeText(num);
        this.notifications.notify(`${this.cfg.name}: couldn't find the dialpad`,
          `${num} is on the clipboard. Right-click the number field in ${this.cfg.name} and choose "Use for click-to-call: number field" so it dials directly next time.`);
      }
    } catch (e) {
      clipboard.writeText(num);
      console.warn(`[webroost:${this.cfg.id}] dial failed`, e);
    } finally {
      this.dialing = false;
    }
  }

  /** Remember a click-to-call selector picked with the right-click menu. */
  private async learnSelector(wc: WebContents, x: number, y: number, kind: 'input' | 'button' | 'open') {
    try {
      const selector: string | null = await wc.executeJavaScript(selectorScript(x, y, kind), true);
      if (!selector) return;
      const key = kind === 'input' ? 'dial_input' : kind === 'button' ? 'dial_button' : 'dial_open';
      const current = loadApps().find((a) => a.id === this.cfg.id);
      if (!current) return;
      upsertApp({ ...current, [key]: selector });
      (this.cfg as any)[key] = selector;
      const what = kind === 'input' ? 'number field' : kind === 'button' ? 'call button' : 'dialpad tab';
      this.notifications.notify(`${this.cfg.name}: click-to-call ${what} saved`, selector);
    } catch (e) {
      console.warn('[webroost] could not save selector', e);
    }
  }

  // ------------------------------------------------------------ memory limit
  private lastAudible = 0;
  private lastInput = 0;
  private reloadedForMemoryAt = 0;

  /** Sum of all this app's processes (browser, GPU, utility, renderers), in MB. */
  /**
   * Memory of all this app's processes. Uses PSS from /proc (shared pages
   * split between the processes sharing them), so totals don't count the
   * shared Chromium libraries several times; falls back to the working set.
   */
  private memorySample(): MemorySample {
    let pss = 0, rss = 0, core = 0, pages = 0, total = 0;
    const processes: MemorySample['processes'] = [];
    for (const m of app.getAppMetrics()) {
      let kb = 0;
      try {
        // Sandboxed children may live in another PID namespace (Flatpak):
        // only trust /proc when that PID really is one of our processes.
        const cmd = fs.readFileSync(`/proc/${m.pid}/cmdline`, 'utf8');
        const ours = m.pid === process.pid || (cmd.includes(path.basename(process.execPath)) && cmd.includes('--type='));
        if (!ours) throw new Error('not ours');
        const t = fs.readFileSync(`/proc/${m.pid}/smaps_rollup`, 'utf8');
        const hit = /^Pss:\s+(\d+)\s*kB/m.exec(t);
        if (hit) { kb = Number(hit[1]); pss++; }
      } catch { /* not visible from here (sandboxed child) */ }
      if (!kb) { kb = m.memory?.workingSetSize ?? 0; rss++; }
      const mb = kb / 1024;
      total += mb;
      if (m.type === 'Tab') pages += mb; else core += mb;
      processes.push({ type: m.type, name: m.name || m.serviceName || m.type, mb: Math.round(mb) });
    }
    processes.sort((a, b) => b.mb - a.mb);
    return {
      total: Math.round(total), core: Math.round(core), pages: Math.round(pages),
      method: rss === 0 ? 'pss' : pss === 0 ? 'rss' : 'mixed', processes,
    };
  }

  /** Busy = a call or media is (or just was) playing, or the user is typing/clicking in the window. */
  private busy(): boolean {
    const now = Date.now();
    const wcs = [this.win, ...this.children].filter((w) => !w.isDestroyed()).map((w) => w.webContents);
    if (wcs.some((wc) => wc.isCurrentlyAudible())) this.lastAudible = now;
    if (now - this.lastAudible < 60_000) return true;
    return this.win.isVisible() && this.win.isFocused() && now - this.lastInput < 120_000;
  }

  private watchMemory() {
    this.win.webContents.on('before-input-event', () => { this.lastInput = Date.now(); });
    const fmt = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
    const tick = () => {
      if (this.quitting || this.win.isDestroyed()) return;
      const sample = this.memorySample();
      const mb = sample.total;
      const now0 = Date.now();
      const history = (this.state.data.memoryHistory ?? []).filter(([t]) => now0 - t < 6 * 3600_000);
      history.push([now0, mb]);
      this.state.update({ memoryMb: mb, memoryAt: now0, memory: sample, memoryHistory: history });
      const limit = Number(this.cfg.memory_limit_mb) || 0;
      if (!limit || mb <= limit) return;
      if (this.busy()) { debug(`memory ${mb} MB over ${limit} MB, waiting (in use / audio)`); return; }
      const now = Date.now();
      if (now - this.reloadedForMemoryAt > 10 * 60_000) {
        // Step 1: reloading the page frees most memory and keeps the login.
        this.reloadedForMemoryAt = now;
        console.warn(`[webroost:${this.cfg.id}] memory ${mb} MB over limit ${limit} MB: reloading`);
        for (const w of this.children) if (!w.isDestroyed()) w.close();
        this.win.webContents.reload();
        this.notifications.notify(`${this.cfg.name} was reloaded to free memory`, `It was using ${fmt(mb)} (limit ${fmt(limit)}).`);
      } else if (now - this.reloadedForMemoryAt > 2 * 60_000) {
        // Step 2: still over a while after the reload, so restart the whole app.
        console.warn(`[webroost:${this.cfg.id}] memory ${mb} MB still over limit ${limit} MB after reload: restarting`);
        this.notifications.notify(`${this.cfg.name} is restarting to free memory`, `It was using ${fmt(mb)} (limit ${fmt(limit)}).`);
        this.restart();
      }
    };
    setInterval(tick, 60_000);
    setTimeout(tick, 15_000);
  }

  // ------------------------------------------------------ live config reload
  /** Apply setting changes from the manager (apps.yaml) without a restart. */
  private watchConfig() {
    let last = 0;
    try { last = fs.statSync(CONFIG_FILE).mtimeMs; } catch { /* no file */ }
    setInterval(() => {
      let m = 0;
      try { m = fs.statSync(CONFIG_FILE).mtimeMs; } catch { return; }
      if (m === last) return;
      last = m;
      try {
        const fresh = getApp(this.cfg.id);
        const before = this.cfg;
        this.cfg = { ...fresh, iconPath: fresh.iconPath ?? before.iconPath };
        this.matcher = new OriginMatcher(fresh.allowed_origins);
        if (fresh.notify_on_unread && !before.notify_on_unread) this.watchUnreadInPage();
        // Minimize to the tray switches between Wayland and XWayland (see
        // main.ts), which only takes effect on a restart.
        if (!!fresh.minimize_to_tray !== !!before.minimize_to_tray && process.env.WAYLAND_DISPLAY && !process.env.WEBROOST_NATIVE_WAYLAND) {
          debug('minimize_to_tray changed: restarting to switch display mode');
          setTimeout(() => void this.restart(), 1500);
        }
        if (fresh.icon_color !== before.icon_color || fresh.icon_label !== before.icon_label || fresh.icon !== before.icon) {
          void loadIconFile(this.cfg.iconPath).then((img) => {
            this.baseIcon = styleIcon(img, this.cfg);
            if (!this.win.isDestroyed()) this.win.setIcon(this.baseIcon);
            this.setUnread(this.unread, true);
          });
        }
        if (fresh.name !== before.name) this.tray?.setToolTip(fresh.name);
        this.refreshMenu();
        debug('settings reloaded from apps.yaml');
      } catch (e) {
        console.warn(`[webroost:${this.cfg.id}] could not reload settings`, e);
      }
    }, 3000);
  }

  // ------------------------------------------- unread count from the page
  /*
   * The unread count can come from several places. Each source keeps its own
   * last value; the first value a source reports is a baseline (never "new
   * mail"). The count shown and the one that triggers notify_on_unread comes
   * from the most precise source available:
   *   folder  "Inbox, 3 unread" in the page's folder list (Outlook)
   *   badge   navigator.setAppBadge() from the page or its service worker
   *   title   "(3) Inbox" style page titles, once one has carried a count
   *   rows    unread rows at the top of the inbox message list (Outlook with
   *           the folder pane collapsed)
   *
   * Earlier versions stopped reading the page as soon as the site had called
   * setAppBadge once. The new Outlook does that at start-up but later only
   * updates the badge from web push, which Electron does not have, so the
   * count froze and new mail never notified.
   */
  private counts: Partial<Record<UnreadSource, number>> = {};
  private lastUnreadNotify = 0;
  /** Newest unread message seen in the list, so a popup never shows an older one. */
  private lastTopUnread = '';
  private notifyingUnread = false;
  private titleHadCount = false;
  private unreadWatcher: NodeJS.Timeout | null = null;
  private domMissLogged = false;
  private lastProbe: unknown = null;

  private activeSource(): UnreadSource | null {
    const c = this.counts;
    if (c.folder !== undefined) return 'folder';
    if (c.badge !== undefined) return 'badge';
    if (c.title !== undefined && this.titleHadCount) return 'title';
    if (c.rows !== undefined) return 'rows';
    if (c.title !== undefined) return 'title';
    return null;
  }

  private reportUnread(src: UnreadSource, n: number) {
    if (!Number.isFinite(n) || n < 0) return;
    const prev = this.counts[src];
    if (prev === n) return;
    this.counts[src] = n;
    if (src === 'title' && n > 0) this.titleHadCount = true;
    if (prev === undefined) debug(`unread source ${src}: ${n} (baseline)`);
    else debug(`unread source ${src}: ${prev} -> ${n}`);

    const active = this.activeSource();
    // Any source going up means new mail: Outlook's folder count can lag or
    // stall while its app badge (new mail since last look) still moves, and
    // the other way round. Several sources rising together give one popup.
    // Unread rows change when you switch Focused/Other or scroll, so they
    // only count while nothing better is available.
    if (prev !== undefined && n > prev && (src !== 'rows' || active === 'rows')) {
      const quietStart = Date.now() - this.startedAt < 20_000;
      const siteNotified = Date.now() - this.notifications.lastSiteNotification < 15_000;
      const recent = Date.now() - this.lastUnreadNotify < 30_000;
      if (!this.cfg.notify_on_unread) debug('  not notifying: notify_on_unread is off');
      else if (quietStart) debug('  not notifying: still starting up');
      else if (siteNotified) debug('  not notifying: the site showed its own notification');
      else if (recent) debug('  not notifying: already notified for this mail');
      else {
        this.lastUnreadNotify = Date.now();
        const total = active ? this.counts[active]! : n;
        void this.notifyNewItems(n - prev, total);
      }
    }
    this.setUnread(active ? this.counts[active]! : 0);
  }

  /** Reads the folder list and message list of the page every 10 s. */
  private watchUnreadInPage() {
    if (!this.cfg.notify_on_unread || this.unreadWatcher) return;
    const tick = async () => {
      if (this.quitting || this.win.isDestroyed() || !this.cfg.notify_on_unread) return;
      try {
        const r: { folder: number; rows: number; probe: unknown } =
          await this.win.webContents.executeJavaScript(UNREAD_PROBE, true);
        this.lastProbe = r.probe;
        if (!this.notifyingUnread) {
          const top = await this.topUnread();
          if (top.length) this.lastTopUnread = top.join('|');
        }
        if (r.folder >= 0) this.reportUnread('folder', r.folder);
        if (r.rows >= 0) this.reportUnread('rows', r.rows);
        if (r.folder < 0 && r.rows < 0 && !this.domMissLogged) {
          this.domMissLogged = true;
          debug('unread: no Inbox folder count or inbox message list found on the page yet');
        }
      } catch { /* page navigating */ }
    };
    this.unreadWatcher = setInterval(() => void tick(), 10_000);
    // Every few minutes, note the counts in the log so diagnostics show
    // whether the page kept updating while hidden in the tray.
    setInterval(() => {
      if (!this.cfg.notify_on_unread || this.win.isDestroyed()) return;
      debug(`unread check: ${JSON.stringify(this.counts)} window ${this.win.isVisible() ? 'shown' : 'in tray'}`);
    }, 5 * 60_000);
  }

  /** Tray "Save diagnostics…": a text file to send when something is off. */
  private async saveDiagnostics() {
    let page: unknown = null;
    try {
      page = await this.win.webContents.executeJavaScript(`({
        url: location.origin + location.pathname,
        title: document.title,
        visibility: document.visibilityState,
        notificationPermission: typeof Notification === 'undefined' ? 'none' : Notification.permission,
        shimInstalled: !!window.__webroostShim,
        probe: (${UNREAD_PROBE}).probe,
      })`, true);
    } catch (e) { page = `could not read the page: ${e}`; }
    const server = await notificationServerReport();
    const out = [
      `WebRoost ${releaseVersion()} diagnostics for "${this.cfg.id}" — ${new Date().toString()}`,
      `session: ${process.env.XDG_SESSION_TYPE ?? '?'} desktop: ${process.env.XDG_CURRENT_DESKTOP ?? '?'} flatpak: ${IN_FLATPAK}`,
      `notifications supported: ${Notification.isSupported()} muted: ${!!this.state.data.muted} sent by: ${this.notifications.popups.method()}`,
      ...server,
      `unread shown: ${this.unread} active source: ${this.activeSource() ?? 'none'} sources: ${JSON.stringify(this.counts)}`,
      '',
      'Settings:',
      JSON.stringify({ ...this.cfg, dial_input: undefined, dial_button: undefined, dial_open: undefined }, null, 2),
      '',
      'Page:',
      JSON.stringify(page, null, 2),
      '',
      'Recent log:',
      ...recentLog(),
    ].join('\n');
    const dir = app.getPath('downloads');
    const file = path.join(dir, `webroost-${this.cfg.id}-diagnostics.txt`);
    try {
      ensureDir(dir);
      fs.writeFileSync(file, out);
      this.notifications.notify('Diagnostics saved', file, () => shell.showItemInFolder(file));
    } catch (e) {
      this.notifications.notify(`${this.cfg.name}: could not save diagnostics`, String(e));
    }
  }

  /**
   * Notification for new items. Shows the newest unread message (sender,
   * subject, preview) when the page lists it, as in Outlook's message list;
   * otherwise just the count.
   */
  private async topUnread(): Promise<string[]> {
    try { return await this.win.webContents.executeJavaScript(TOP_UNREAD, true); } catch { return []; }
  }

  private async notifyNewItems(added: number, total: number) {
    // The count often moves a few seconds before the new message is drawn in
    // the list, and with many unread mails the first unread row may still be
    // an older one. Wait for a newer top unread row, up to ~10 s.
    this.notifyingUnread = true;
    const before = this.lastTopUnread;
    let lines: string[] = [];
    try {
      for (const wait of [0, 2000, 3000, 5000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const top = await this.topUnread();
        if (top.length && top.join('|') !== before) { lines = top; break; }
      }
    } finally {
      this.notifyingUnread = false;
    }
    if (lines.length) this.lastTopUnread = lines.join('|');
    else debug('  new message not found in the list; showing the count only');
    const many = added > 1 ? ` (+${added - 1} more)` : '';
    const totalText = `${total.toLocaleString()} unread`;
    if (lines.length) {
      const [first, ...rest] = lines;
      const body = rest.join('\n').slice(0, 300);
      this.notifications.notify(`${first.slice(0, 80)}${many}`, body || totalText);
    } else {
      this.notifications.notify(added === 1 ? 'New message' : `${added} new messages`, totalText);
    }
  }

  // ------------------------------------------------ restart after an update
  private readonly startedAt = Date.now();
  private updatePending: string | null = null;

  /**
   * After an update, the first new-version process (manager, app or the
   * `--restart-all` step of the update commands) records its version. Older
   * running apps then restart onto it at a quiet moment: not during a call
   * and not while you're typing.
   */
  private watchForNewVersion() {
    const tick = () => {
      if (this.quitting) return;
      const m = readVersionMarker();
      if (!m) return;
      const newer = isNewer(m.version, releaseVersion());
      const forced = !!m.restartAll && m.at > this.startedAt;
      if (!newer && !forced) return;
      if (this.updatePending !== m.version) {
        this.updatePending = m.version;
        this.refreshMenu();
      }
      if (this.busy() || (this.win.isVisible() && this.win.isFocused())) { debug(`update ${m.version} waiting: app in use`); return; }
      console.warn(`[webroost:${this.cfg.id}] restarting onto WebRoost ${m.version}`);
      this.restart();
    };
    setInterval(tick, 30_000);
    setTimeout(tick, 5_000);
  }

  // ------------------------------------------------ stay signed in
  /**
   * Session cookies (no expiry) are dropped whenever the app exits, which
   * signs you out of SSO/OIDC sites such as ConnectWise after every update or
   * reboot. Re-save them with an expiry so they survive, like Chrome's
   * session restore. Runs every few minutes (a reboot gives no warning) and
   * before restarts.
   */
  private async keepSessionCookies(): Promise<void> {
    if (this.cfg.forget_session_cookies) return;
    try {
      const all = await this.ses.cookies.get({});
      const expirationDate = Date.now() / 1000 + 14 * 24 * 3600;
      let n = 0;
      for (const c of all) {
        if (!c.session) continue;
        const host = (c.domain ?? '').replace(/^\./, '');
        const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`;
        try {
          await this.ses.cookies.set({
            url, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
            sameSite: c.sameSite, expirationDate,
            ...(c.hostOnly ? {} : { domain: c.domain }),
          });
          n++;
        } catch { /* e.g. __Host- cookies with a domain: skip */ }
      }
      await this.ses.cookies.flushStore();
      if (n) debug(`kept ${n} session cookie(s) for the next start`);
    } catch (e) {
      debug(`keeping session cookies failed: ${e}`);
    }
  }

  private watchSessionCookies() {
    setInterval(() => void this.keepSessionCookies(), 3 * 60_000);
    setTimeout(() => void this.keepSessionCookies(), 60_000);
  }

  /** Relaunch this app process, keeping it hidden if it is hidden now. */
  async restart() {
    await this.keepSessionCookies();
    const args = ['--app', this.cfg.id];
    if (!this.win.isVisible()) args.push('--hidden');
    this.quitting = true;
    this.state.flush();
    this.tray?.destroy();
    // Let go of the single-instance lock first, or the new copy would just
    // hand over to this (exiting) one and quit.
    app.releaseSingleInstanceLock();
    // Start the new copy as a detached process (inside Flatpak: in a fresh
    // sandbox via the portal, since children die with this sandbox).
    void spawnSelf(args).then((err) => {
      if (err) console.warn(`[webroost:${this.cfg.id}] restart failed: ${err}`);
      app.exit(0);
    });
  }

  /** Check GitHub Releases shortly after start and then every 12 h. */
  private scheduleUpdateChecks() {
    const check = () => backgroundCheck((u) => {
      this.update = u;
      this.refreshMenu();
      this.notifications.notify(
        `WebRoost ${u.latest} is available`,
        u.canInstall ? 'Click to install the update.' : u.kind === 'flatpak'
          ? 'It will arrive through Discover / flatpak update.' : 'Click to see what is new.',
        () => this.openManager(),
      );
    }).catch(() => { /* offline: try again later */ });
    setTimeout(check, 60_000 + Math.random() * 60_000);
    setInterval(check, 12 * 60 * 60 * 1000 + Math.random() * 600_000);
  }

  // ---------------------------------------------------------------- session
  private granted(): Set<string> {
    return new Set([...BASE_PERMISSIONS, ...(this.cfg.extra_permissions ?? [])]);
  }

  private setupSession() {
    const ses = this.ses;

    // Service-worker notifications (new Outlook, Teams…) — see preload/sw-preload.ts.
    ses.registerPreloadScript({
      type: 'service-worker',
      id: 'webroost-sw-notifications',
      filePath: path.join(__dirname, 'preload', 'sw-preload.js'),
    });
    const attachWorker = (versionId: number) => {
      const sw = ses.serviceWorkers.getWorkerFromVersionID(versionId);
      if (sw) this.notifications.attachServiceWorker(sw);
    };
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') attachWorker(versionId);
    });
    for (const id of Object.keys(ses.serviceWorkers.getAllRunning())) attachWorker(Number(id));
    ses.setUserAgent(this.cfg.user_agent || cleanUserAgent(ses.getUserAgent()));
    ses.setSpellCheckerLanguages([app.getLocale() || 'en-US']);

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const url = details.requestingUrl || wc.getURL();
      const ok = this.matcher.matches(url) && this.granted().has(permission);
      if (!ok) console.warn(`[webroost:${this.cfg.id}] denied permission "${permission}" for ${url}`);
      callback(ok);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
      const url = origin || details.requestingUrl || details.securityOrigin || '';
      return this.matcher.matches(url) && this.granted().has(permission);
    });

    // --- WebHID: pick the configured headset automatically and keep the grant.
    let pendingHid: { cb: (id?: string) => void; timer: NodeJS.Timeout } | null = null;
    ses.on('select-hid-device', (event, details, callback) => {
      event.preventDefault();
      const filters = this.cfg.hid_devices;
      if (!filters.length || !this.matcher.matches(details.frame?.url)) { callback(); return; }
      const dev = details.deviceList.find((d) => hidMatches(filters, d));
      if (dev) { callback(dev.deviceId); return; }
      // Wait a little in case the headset is being plugged in right now.
      if (pendingHid) { clearTimeout(pendingHid.timer); pendingHid.cb(); }
      pendingHid = { cb: callback, timer: setTimeout(() => { pendingHid?.cb(); pendingHid = null; }, 10000) };
    });
    ses.on('hid-device-added', (_e, details) => {
      if (pendingHid && hidMatches(this.cfg.hid_devices, details.device)) {
        clearTimeout(pendingHid.timer);
        pendingHid.cb(details.device.deviceId);
        pendingHid = null;
      }
    });
    ses.setDevicePermissionHandler((details) => {
      if (details.deviceType !== 'hid') return false;
      return this.matcher.matches(details.origin) && hidMatches(this.cfg.hid_devices, details.device as any);
    });

    // --- Screen sharing (only when display-capture is listed in extra_permissions).
    ses.setDisplayMediaRequestHandler((request, callback) => {
      if (!this.granted().has('display-capture') || !this.matcher.matches(request.securityOrigin)) {
        callback({});
        return;
      }
      // On Wayland this goes through the xdg-desktop-portal picker.
      desktopCapturer.getSources({ types: ['screen', 'window'] })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    });

    // --- Downloads go straight to ~/Downloads with a notification.
    ses.on('will-download', (_e, item) => {
      const dir = app.getPath('downloads');
      ensureDir(dir);
      const parsed = path.parse(item.getFilename() || 'download');
      let target = path.join(dir, parsed.base);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${parsed.name} (${i})${parsed.ext}`);
      item.setSavePath(target);
      item.once('done', (_ev, st) => {
        if (st === 'completed') {
          this.notifications.notify(`${this.cfg.name}: download complete`, path.basename(target), () => shell.showItemInFolder(target));
        }
      });
    });
  }

  // ----------------------------------------------------------------- window
  private webPreferences(): Electron.WebPreferences {
    return {
      partition: `persist:${this.cfg.id}`,
      preload: this.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Run the notification bridge in embedded frames too (Outlook raises
      // notifications from frames). This does not enable Node.js.
      nodeIntegrationInSubFrames: true,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: this.cfg.notify_on_unread ? ['--wt-keep-visible'] : [],
    };
  }

  private restoreBounds() {
    const b = this.state.data.bounds;
    const width = b?.width ?? this.cfg.width ?? 1200;
    const height = b?.height ?? this.cfg.height ?? 800;
    let x = b?.x, y = b?.y;
    if (x != null && y != null) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return x! < a.x + a.width - 50 && x! + width > a.x + 50 && y! < a.y + a.height - 50 && y! + height > a.y;
      });
      if (!visible) x = y = undefined;
    }
    return { width, height, x, y };
  }

  private createWindow() {
    const win = new BrowserWindow({
      ...this.restoreBounds(),
      title: this.cfg.name,
      icon: this.baseIcon,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: this.webPreferences(),
    });
    this.win = win;
    win.setMenuBarVisibility(false);
    if (this.state.data.maximized) win.maximize();

    const saveBounds = () => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      this.state.update({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.on('maximize', saveBounds);
    win.on('unmaximize', saveBounds);

    win.on('close', (e) => {
      saveBounds();
      this.state.flush();
      if (!this.quitting) {
        e.preventDefault();
        this.hideAll();
      }
    });
    win.on('minimize', () => {
      debug('window minimize event');
      if (this.cfg.minimize_to_tray) this.hideAll();
    });
    win.on('restore', () => debug('window restore event'));
    win.on('blur', () => debug('window blur'));
    win.on('focus', () => debug('window focus'));
    win.on('show', () => this.refreshMenu());
    win.on('hide', () => this.refreshMenu());

    win.once('ready-to-show', () => { if (!this.startHidden) this.showAll(); });

    this.attachWebContents(win.webContents, win, false);
    const wc = win.webContents;
    wc.on('page-title-updated', (_e, title) => {
      this.reportUnread('title', parseUnread(title, this.cfg.badge_regex));
    });
    wc.on('did-finish-load', () => { if (this.state.data.zoom) wc.setZoomFactor(this.state.data.zoom); });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      console.warn(`[webroost:${this.cfg.id}] renderer gone (${details.reason}); reloading`);
      setTimeout(() => { if (!win.isDestroyed()) wc.reload(); }, 2000);
    });
    // Use the site's own icon once we are past any sign-in page.
    if ((!this.cfg.iconPath || this.cfg.icon_auto) && !this.state.data.iconAdopted) {
      const tryAdopt = () => { void this.adoptSiteIcon(); };
      wc.on('did-finish-load', tryAdopt);
      wc.on('page-favicon-updated', tryAdopt);
    }

    void win.loadURL(this.cfg.url);
  }

  /** Navigation guard, popups, context menu and shortcuts for any webContents we own. */
  private attachWebContents(wc: WebContents, win: BrowserWindow, isChild: boolean) {
    wc.setWindowOpenHandler(({ url }) => {
      // Sign-in popups (OAuth/OIDC/SAML) open as child windows even on other origins.
      if (url === 'about:blank' || url === '' || this.matcher.matches(url) || looksLikeAuth(url)) {
        const auth = !this.matcher.matches(url) && looksLikeAuth(url);
        // Sign-in popups get a small window; the site's own pop-ups (e.g. a
        // ConnectWise time entry) open at the size you last gave one, not the
        // narrow size the site asks for.
        const size = auth ? { width: 560, height: 720 } : this.popupSize();
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...size, parent: this.win, autoHideMenuBar: true, icon: this.baseIcon,
            backgroundColor: '#ffffff', webPreferences: this.webPreferences(),
          },
        };
      }
      this.openExternal(url);
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child, details) => {
      this.children.add(child);
      child.setMenuBarVisibility(false);
      child.on('closed', () => this.children.delete(child));
      this.attachWebContents(child.webContents, child, true);
      const auth = !!details.url && !this.matcher.matches(details.url) && looksLikeAuth(details.url);
      if (!auth) {
        // window.open() width/height features can still win; apply ours again.
        const { width, height } = this.popupSize();
        child.setSize(width, height);
        if (!win.isDestroyed()) {
          const p = win.getBounds();
          child.setPosition(Math.round(p.x + (p.width - width) / 2), Math.round(p.y + Math.max(0, (p.height - height) / 2)));
        }
        let t: NodeJS.Timeout | null = null;
        child.on('resize', () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => {
            if (child.isDestroyed() || child.isMaximized() || child.isFullScreen()) return;
            const [w, h] = child.getSize();
            if (w >= 400 && h >= 300) this.state.update({ popupSize: { width: w, height: h } });
          }, 600);
        });
      }
    });

    wc.on('will-navigate', (e) => {
      if (this.matcher.matches(e.url)) return;
      // Sign-in flows stay in the app: the identity provider's pages, and
      // every further step while we're already on a page outside the
      // allowed origins (MFA, consent…), until it returns to the app.
      const current = wc.getURL();
      const inFlow = !!current && current !== 'about:blank' && !this.matcher.matches(current);
      if (looksLikeAuth(e.url) || inFlow) {
        debug(`sign-in step kept in app: ${e.url}`);
        return;
      }
      e.preventDefault();
      this.openExternal(e.url);
      if (isChild && (!current || current === 'about:blank')) win.close();
    });
    // Server-side redirects (SSO hops) are allowed to finish in-app; log the
    // ones that leave the allow-list to help users tune allowed_origins.
    wc.on('will-redirect', (e) => {
      if (!this.matcher.matches(e.url)) console.warn(`[webroost:${this.cfg.id}] redirect outside allowed_origins: ${e.url}`);
    });

    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p));
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || this.cfg.pass_shortcuts) return;
      const ctrl = input.control || input.meta;
      const key = input.key.toLowerCase();
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      if ((ctrl && key === 'r' && !input.shift) || input.key === 'F5') act(() => wc.reload());
      else if (ctrl && input.shift && key === 'r') act(() => wc.reloadIgnoringCache());
      else if ((ctrl && input.shift && key === 'i') || input.key === 'F12') act(() => wc.toggleDevTools());
      else if (ctrl && (key === '=' || key === '+')) act(() => this.zoom(wc, 0.1));
      else if (ctrl && key === '-') act(() => this.zoom(wc, -0.1));
      else if (ctrl && key === '0') act(() => this.zoom(wc, 0));
      else if (input.alt && input.key === 'ArrowLeft') act(() => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack());
      else if (input.alt && input.key === 'ArrowRight') act(() => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward());
      // Ignore auto-repeat and keys replayed right after the window reappears,
      // otherwise a held Ctrl+W would hide the window again immediately.
      else if (ctrl && key === 'w' && !isChild) {
        e.preventDefault();
        if (!input.isAutoRepeat && Date.now() - this.shownAt > 500) this.hideAll();
      }
    });
  }

  private zoom(wc: WebContents, delta: number) {
    const z = delta === 0 ? 1 : Math.min(3, Math.max(0.3, wc.getZoomFactor() + delta));
    wc.setZoomFactor(z);
    if (wc === this.win.webContents) this.state.update({ zoom: z });
  }

  private openExternal(url: string) {
    if (!isSafeExternal(url)) return;
    shell.openExternal(url).catch((e) => console.warn(`[webroost] openExternal failed for ${url}`, e));
  }

  private contextMenu(wc: WebContents, p: Electron.ContextMenuParams) {
    const items: MenuItemConstructorOptions[] = [];
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (p.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.linkURL) {
      items.push({ label: 'Open link in browser', click: () => this.openExternal(p.linkURL) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
      items.push({ label: 'Save image…', click: () => wc.downloadURL(p.srcURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' });
      items.push({ role: 'cut', enabled: p.editFlags.canCut });
    }
    items.push({ role: 'copy', enabled: p.editFlags.canCopy });
    if (p.isEditable) items.push({ role: 'paste', enabled: p.editFlags.canPaste }, { role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste });
    items.push({ role: 'selectAll' }, { type: 'separator' });
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Reload', click: () => wc.reload() });
    items.push({ label: 'Open page in browser', click: () => this.openExternal(wc.getURL()) });
    if (this.cfg.handle_schemes?.length) {
      items.push({ type: 'separator' }, {
        label: 'Use for click-to-call',
        submenu: [
          { label: 'Number field (dialpad input)', click: () => void this.learnSelector(wc, p.x, p.y, 'input') },
          { label: 'Call button', click: () => void this.learnSelector(wc, p.x, p.y, 'button') },
          { label: 'Dialpad tab (opens the number field)', click: () => void this.learnSelector(wc, p.x, p.y, 'open') },
          { type: 'separator' },
          { label: 'Test (fills in 123, does not call)', click: () => void this.dial('tel:123', true) },
        ],
      });
    }
    items.push({ type: 'separator' }, { label: 'Inspect element', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
  }

  private adopting = false;

  /**
   * Replace an automatically chosen icon with the best icon the signed-in page
   * offers (web app manifest, <link rel=icon>, apple-touch-icon), preferring
   * icons with a transparent background. Runs once per app.
   */
  private async adoptSiteIcon() {
    const wc = this.win.webContents;
    if (this.adopting || this.state.data.iconAdopted || wc.isDestroyed()) return;
    let page: URL;
    try { page = new URL(wc.getURL()); } catch { return; }
    if (page.origin !== new URL(this.cfg.url).origin) return; // still on a sign-in page
    this.adopting = true;
    try {
      const found: { href: string; sizes: string; rel: string }[] = await wc.executeJavaScript(`(async () => {
        const out = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')]
          .map((l) => ({ href: l.href, sizes: (l.sizes && l.sizes.value) || '', rel: l.rel }));
        const m = document.querySelector('link[rel="manifest"]');
        if (m) {
          try {
            const j = await (await fetch(m.href, { credentials: 'include' })).json();
            for (const i of j.icons || []) {
              if (String(i.purpose || 'any').includes('any')) out.push({ href: new URL(i.src, m.href).href, sizes: i.sizes || '', rel: 'manifest' });
            }
          } catch (e) {}
        }
        out.push({ href: new URL('/favicon.ico', location.href).href, sizes: '', rel: 'favicon' });
        return out;
      })()`, true);
      let best: { img: NativeImage; clear: boolean; size: number } | null = null;
      for (const c of found.slice(0, 12)) {
        try {
          const res = await this.ses.fetch(c.href);
          if (!res.ok) continue;
          const img = await imageFromBuffer(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? '');
          if (!img || img.isEmpty()) continue;
          const size = Math.min(img.getSize().width, img.getSize().height);
          if (size < 16) continue;
          const clear = imageHasTransparency(img);
          const better = !best
            || (clear && !best.clear && size >= 32)
            || (clear === best.clear && size > best.size);
          if (better) best = { img, clear, size };
        } catch { /* try the next one */ }
      }
      if (!best) return;
      // Only write into our own icon folder; a hand-picked icon elsewhere is never touched.
      const file = this.cfg.iconPath && path.dirname(this.cfg.iconPath) === ICON_DIR
        ? this.cfg.iconPath : path.join(ICON_DIR, `${this.cfg.id}.png`);
      if (this.cfg.iconPath && file !== this.cfg.iconPath) return;
      ensureDir(ICON_DIR);
      fs.writeFileSync(file, best.img.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
      this.state.update({ iconAdopted: true }, true);
      this.cfg.iconPath = file;
      this.baseIcon = styleIcon(await loadIconFile(file), this.cfg);
      this.win.setIcon(this.baseIcon);
      this.setUnread(this.unread, true);
      if (isInstalled(this.cfg.id).menu) stableIcon(this.cfg);
      debug(`adopted site icon (${best.size}px, transparent: ${best.clear})`);
    } catch (e) {
      debug(`icon adoption failed: ${e}`);
    } finally {
      this.adopting = false;
    }
  }

  // ----------------------------------------------------------- show / hide
  private windows(): BrowserWindow[] {
    return [this.win, ...this.children].filter((w) => !w.isDestroyed());
  }

  showAll() {
    debug('showAll');
    this.shownAt = Date.now();
    for (const w of this.windows()) {
      if (w.isMinimized()) w.restore();
      w.show();
    }
    this.win.focus();
    this.refreshMenu();
  }

  /** Size for the site's own pop-up windows: the last one you set, else most of the main window. */
  private popupSize(): { width: number; height: number } {
    const saved = this.state.data.popupSize;
    const area = screen.getDisplayMatching(this.win.getBounds()).workAreaSize;
    const base = saved ?? {
      width: Math.max(1000, Math.round(this.win.getBounds().width * 0.85)),
      height: Math.max(720, Math.round(this.win.getBounds().height * 0.85)),
    };
    return { width: Math.min(base.width, area.width), height: Math.min(base.height, area.height) };
  }

  hideAll() {
    debug('hideAll');
    for (const w of [...this.children].reverse()) if (!w.isDestroyed()) w.hide();
    this.win.hide();
    this.refreshMenu();
  }

  toggle() {
    if (this.win.isVisible() && !this.win.isMinimized()) this.hideAll();
    else this.showAll();
  }

  // ------------------------------------------------------------------- tray
  private createTray() {
    this.tray = new Tray(this.trayImage());
    this.tray.setToolTip(this.cfg.name);
    this.tray.on('click', () => this.toggle());
    this.tray.on('middle-click' as any, () => this.toggle());
    this.refreshMenu();
  }

  private trayImage(): NativeImage {
    const base = this.baseIcon.resize({ width: 64, height: 64, quality: 'best' });
    return this.unread > 0 ? badgeIcon(base, this.unread) : base;
  }

  private refreshMenu() {
    if (!this.tray) return;
    const visible = this.win && !this.win.isDestroyed() && this.win.isVisible();
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: visible ? `Hide ${this.cfg.name}` : `Show ${this.cfg.name}`, click: () => (visible ? this.hideAll() : this.showAll()) },
      { label: 'Reload', click: () => this.reload() },
      {
        label: 'Send test notification',
        click: () => this.notifications.notify('Test notification', 'If you can read this, WebRoost can show popups. Click to open the app.'),
      },
      { label: 'Save diagnostics…', click: () => void this.saveDiagnostics() },
      {
        label: 'Mute notifications', type: 'checkbox', checked: !!this.state.data.muted,
        click: (item) => { this.state.update({ muted: item.checked }, true); this.refreshMenu(); },
      },
      { type: 'separator' },
      ...(this.updatePending
        ? [{ label: `Restart to finish updating (${this.updatePending})`, click: () => this.restart() }] : []),
      ...(this.update?.available
        ? [{ label: `Update WebRoost to ${this.update.latest}…`, click: () => this.openManager() }] : []),
      { label: 'Manage apps…', click: () => this.openManager() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.quit() },
    ]));
  }

  private badgeWorkers = new Set<number>();

  /** navigator.setAppBadge() from the page or its service worker. */
  private onAppBadge(count: number) {
    // -1: setAppBadge() without a number, a "something new" flag: count it as 1.
    this.reportUnread('badge', count < 0 ? 1 : count);
  }

  /** Shows a count on the tray icon and taskbar. */
  private setUnread(n: number, force = false) {
    if (n === this.unread && !force) return;
    this.unread = n;
    this.tray?.setImage(this.trayImage());
    this.tray?.setToolTip(n > 0 ? `${this.cfg.name} — ${n} unread` : this.cfg.name);
    app.setBadgeCount(n);
  }

  private reload() {
    // Pick up config edits (allowed origins, HID filters…) without a restart.
    try {
      const fresh = getApp(this.cfg.id);
      this.cfg = fresh;
      this.matcher = new OriginMatcher(fresh.allowed_origins);
    } catch (e) {
      console.warn('[webroost] config reload failed, keeping previous config', e);
    }
    this.win.webContents.reload();
  }

  private openManager() {
    void spawnSelf(['--manager']).then((err) => {
      if (err) this.notifications.notify('WebRoost', `Could not open the manager: ${err}`);
    });
  }

  async quit() {
    if (this.quitting) { app.quit(); return; }
    this.quitting = true;
    this.state.flush();
    this.tray?.destroy();
    // Don't let a slow cookie store hold up the exit.
    await Promise.race([this.keepSessionCookies(), new Promise((r) => setTimeout(r, 2000))]);
    app.quit();
  }

  // -------------------------------------------------------------- lifecycle
  private setupLifecycle() {
    app.on('second-instance', (_e, argv) => {
      debug(`second-instance ${argv.join(' ')}`);
      if (argv.includes('--quit')) { this.quit(); return; }
      const call = this.cfg.handle_schemes?.length ? findCallLink(argv, this.cfg.handle_schemes) : null;
      if (call) { void this.dial(call); return; }
      if (argv.includes('--hidden')) return;
      this.showAll();
    });
    app.on('before-quit', () => { this.quitting = true; this.state.flush(); });
    app.on('window-all-closed', () => { /* stay in tray */ });
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => this.quit());

    app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
      if (this.cfg.ignore_certificate_errors && this.matcher.matches(url)) {
        event.preventDefault();
        callback(true);
      } else callback(false);
    });

    powerMonitor.on('resume', () => {
      if (this.cfg.reload_on_resume) setTimeout(() => this.win.webContents.reload(), 3000);
    });
  }
}

export function bundledIconPath(): string {
  return assetPath('assets', 'icons', '256x256.png');
}
