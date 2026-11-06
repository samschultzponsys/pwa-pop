import * as fs from 'fs';
import * as path from 'path';
import {
  app, BrowserWindow, clipboard, desktopCapturer, Menu, MenuItemConstructorOptions, NativeImage, powerMonitor,
  screen, session as electronSession, Session, shell, Tray, WebContents,
} from 'electron';
import { HidFilter, ResolvedApp, getApp } from './config';
import { badgeIcon, parseUnread } from './badge';
import { defaultIcon, imageFromBuffer, imageHasTransparency, loadIconFile, styleIcon } from './icons';
import { isInstalled, stableIcon } from './desktop';
import { NotificationBridge } from './notifications';
import { isSafeExternal, OriginMatcher } from './origins';
import { assetPath, ensureDir, ICON_DIR, IN_FLATPAK, spawnSelf } from './paths';
import { StateStore } from './state';
import { backgroundCheck, UpdateInfo } from './updater';

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
const debug = (msg: string) => { if (process.env.WEBTRAY_DEBUG) console.log(`[webtray] ${msg}`); };

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

  constructor(cfg: ResolvedApp, private startHidden: boolean) {
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
  }

  // ------------------------------------------------------------ memory limit
  private lastAudible = 0;
  private lastInput = 0;
  private reloadedForMemoryAt = 0;

  /** Sum of all this app's processes (browser, GPU, utility, renderers), in MB. */
  private memoryMb(): number {
    const kb = app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
    return Math.round(kb / 1024);
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
      const mb = this.memoryMb();
      this.state.update({ memoryMb: mb, memoryAt: Date.now() });
      const limit = Number(this.cfg.memory_limit_mb) || 0;
      if (!limit || mb <= limit) return;
      if (this.busy()) { debug(`memory ${mb} MB over ${limit} MB, waiting (in use / audio)`); return; }
      const now = Date.now();
      if (now - this.reloadedForMemoryAt > 10 * 60_000) {
        // Step 1: reloading the page frees most memory and keeps the login.
        this.reloadedForMemoryAt = now;
        console.warn(`[webtray:${this.cfg.id}] memory ${mb} MB over limit ${limit} MB: reloading`);
        for (const w of this.children) if (!w.isDestroyed()) w.close();
        this.win.webContents.reload();
        this.notifications.notify(`${this.cfg.name} was reloaded to free memory`, `It was using ${fmt(mb)} (limit ${fmt(limit)}).`);
      } else if (now - this.reloadedForMemoryAt > 2 * 60_000) {
        // Step 2: still over a while after the reload, so restart the whole app.
        console.warn(`[webtray:${this.cfg.id}] memory ${mb} MB still over limit ${limit} MB after reload: restarting`);
        this.notifications.notify(`${this.cfg.name} is restarting to free memory`, `It was using ${fmt(mb)} (limit ${fmt(limit)}).`);
        this.restart();
      }
    };
    setInterval(tick, 60_000);
    setTimeout(tick, 15_000);
  }

  /** Relaunch this app process, keeping it hidden if it is hidden now. */
  restart() {
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
      if (err) console.warn(`[webtray:${this.cfg.id}] restart failed: ${err}`);
      app.exit(0);
    });
  }

  /** Check GitHub Releases shortly after start and then every 12 h. */
  private scheduleUpdateChecks() {
    const check = () => backgroundCheck((u) => {
      this.update = u;
      this.refreshMenu();
      this.notifications.notify(
        `PWA Pop ${u.latest} is available`,
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
      id: 'webtray-sw-notifications',
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
      if (!ok) console.warn(`[webtray:${this.cfg.id}] denied permission "${permission}" for ${url}`);
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
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
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
    win.on('show', () => this.refreshMenu());
    win.on('hide', () => this.refreshMenu());

    win.once('ready-to-show', () => { if (!this.startHidden) this.showAll(); });

    this.attachWebContents(win.webContents, win, false);
    const wc = win.webContents;
    wc.on('page-title-updated', (_e, title) => this.setUnread(parseUnread(title, this.cfg.badge_regex)));
    wc.on('did-finish-load', () => { if (this.state.data.zoom) wc.setZoomFactor(this.state.data.zoom); });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      console.warn(`[webtray:${this.cfg.id}] renderer gone (${details.reason}); reloading`);
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
      if (url === 'about:blank' || url === '' || this.matcher.matches(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, parent: this.win, autoHideMenuBar: true, icon: this.baseIcon,
            backgroundColor: '#ffffff', webPreferences: this.webPreferences(),
          },
        };
      }
      this.openExternal(url);
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      this.children.add(child);
      child.setMenuBarVisibility(false);
      child.on('closed', () => this.children.delete(child));
      this.attachWebContents(child.webContents, child, true);
    });

    wc.on('will-navigate', (e) => {
      if (this.matcher.matches(e.url)) return;
      e.preventDefault();
      this.openExternal(e.url);
      const current = wc.getURL();
      if (isChild && (!current || current === 'about:blank')) win.close();
    });
    // Server-side redirects (SSO hops) are allowed to finish in-app; log the
    // ones that leave the allow-list to help users tune allowed_origins.
    wc.on('will-redirect', (e) => {
      if (!this.matcher.matches(e.url)) console.warn(`[webtray:${this.cfg.id}] redirect outside allowed_origins: ${e.url}`);
    });

    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p));
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
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
    shell.openExternal(url).catch((e) => console.warn(`[webtray] openExternal failed for ${url}`, e));
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
        label: 'Mute notifications', type: 'checkbox', checked: !!this.state.data.muted,
        click: (item) => { this.state.update({ muted: item.checked }, true); this.refreshMenu(); },
      },
      { type: 'separator' },
      ...(this.update?.available
        ? [{ label: `Update PWA Pop to ${this.update.latest}…`, click: () => this.openManager() }] : []),
      { label: 'Manage apps…', click: () => this.openManager() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.quit() },
    ]));
  }

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
      console.warn('[webtray] config reload failed, keeping previous config', e);
    }
    this.win.webContents.reload();
  }

  private openManager() {
    void spawnSelf(['--manager']).then((err) => {
      if (err) this.notifications.notify('PWA Pop', `Could not open the manager: ${err}`);
    });
  }

  quit() {
    this.quitting = true;
    this.state.flush();
    this.tray?.destroy();
    app.quit();
  }

  // -------------------------------------------------------------- lifecycle
  private setupLifecycle() {
    app.on('second-instance', (_e, argv) => {
      debug(`second-instance ${argv.join(' ')}`);
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
