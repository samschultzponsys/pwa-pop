import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { AppConfig, ID_RE, loadApps, removeApp, resolveApp, upsertApp } from './config';
import { installApp, installManagerEntry, isInstalled, setAutostart, uninstallApp } from './desktop';
import { CONFIG_FILE, ensureDir, ICON_DIR, PROFILE_DIR, assetPath, IN_FLATPAK, readVersionMarker, releaseVersion, spawnSelf } from './paths';
import { isNewer } from './updater';
import { cleanUserAgent } from './runtime';
import { inspectSite } from './inspect';
import { StateStore } from './state';
import { IconStyle, styleIcon } from './icons';
import { COLOR_ORDER } from './iconstyle';
import { applyImport, buildExport, parseExport } from './transfer';
import { autoCheckEnabled, checkForUpdates, downloadUpdate, installUpdate, setAutoCheck, updateGuide } from './updater';

/**
 * Is the app running? Chromium keeps a "SingletonSocket" in the profile; if
 * something accepts a connection on it, the app is up. (The PID in
 * SingletonLock is useless inside Flatpak: every sandbox has its own PIDs.)
 */
function isRunning(id: string): Promise<boolean> {
  const sock = path.join(PROFILE_DIR, id, 'SingletonSocket');
  if (!fs.existsSync(sock)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = net.connect(sock);
    let settled = false;
    const done = (v: boolean) => { if (settled) return; settled = true; c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

function loadImage(file: string | null): Electron.NativeImage | null {
  if (!file) return null;
  try {
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/** Icon as a data URL for the UI, optionally with a duplicate's colour/label. */
function iconDataUrl(file: string | null, style?: IconStyle): string | null {
  const img = loadImage(file);
  if (!img) {
    if (!file) return null;
    try {
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return null;
    }
  }
  return (style ? styleIcon(img, style) : img).resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
}

async function launch(id: string): Promise<void> {
  const err = await spawnSelf(['--app', id]);
  if (err) throw new Error(`Could not start ${id}: ${err}`);
}

/** Only one primary phone app: take phone links away from every other app. */
function makePrimaryPhoneApp(cfg: AppConfig) {
  if (!cfg.handle_schemes?.length) return;
  for (const other of loadApps()) {
    if (other.id === cfg.id || !other.handle_schemes?.length) continue;
    const { handle_schemes: _drop, ...rest } = other;
    upsertApp(rest as AppConfig);
    if (isInstalled(other.id).menu) installApp(rest as AppConfig);
  }
}

let lastHidList: { name: string; vendorId: number; productId: number }[] = [];

function registerIpc(win: BrowserWindow) {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  h('apps:list', () => Promise.all(loadApps().map(async (a) => {
    const r = resolveApp(a);
    const running = await isRunning(a.id);
    const st = new StateStore(a.id).data;
    const memoryMb = running && st.memoryAt && Date.now() - st.memoryAt < 3 * 60_000 ? st.memoryMb : undefined;
    return {
      config: a, icon: iconDataUrl(r.iconPath, a), baseIcon: iconDataUrl(r.iconPath),
      installed: isInstalled(a.id), running, memoryMb,
    };
  })));

  h('apps:memory', () => Promise.all(loadApps().map(async (a) => {
    const running = await isRunning(a.id);
    const st = new StateStore(a.id).data;
    const fresh = running && !!st.memoryAt && Date.now() - st.memoryAt < 3 * 60_000;
    return {
      id: a.id, name: a.name, running, limit: a.memory_limit_mb ?? null, phone: !!a.handle_schemes?.length,
      at: st.memoryAt ?? null, sample: fresh ? st.memory ?? null : null,
      history: running ? (st.memoryHistory ?? []) : [],
    };
  })));

  h('apps:inspect', (url: string) => inspectSite(url));

  h('apps:save', (cfg: AppConfig, iconPng: string | null, previousId: string | null) => {
    if (!ID_RE.test(cfg.id)) throw new Error('The ID may only contain lowercase letters, digits, - and _.');
    if (previousId !== cfg.id && loadApps().some((a) => a.id === cfg.id)) throw new Error(`An app with ID "${cfg.id}" already exists.`);
    if (iconPng) {
      ensureDir(ICON_DIR);
      const file = path.join(ICON_DIR, `${cfg.id}.png`);
      fs.writeFileSync(file, nativeImage.createFromDataURL(iconPng).toPNG());
      cfg.icon = file;
      // A fresh automatic icon may be upgraded again once the user signs in.
      if (cfg.icon_auto) new StateStore(cfg.id).update({ iconAdopted: false }, true);
    }
    if (previousId && previousId !== cfg.id) {
      const wasInstalled = isInstalled(previousId);
      uninstallApp(previousId);
      removeApp(previousId);
      upsertApp(cfg);
      if (wasInstalled.menu) installApp(cfg);
    } else {
      upsertApp(cfg);
    }
    makePrimaryPhoneApp(cfg);
    if (isInstalled(cfg.id).menu) installApp(cfg);
    else setAutostart(cfg, !!cfg.autostart);
    return true;
  });

  h('apps:remove', async (id: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Remove', 'Remove and delete login data'], defaultId: 0, cancelId: 0,
      message: `Remove ${id}?`,
      detail: 'This removes it from apps.yaml, the application menu and autostart. Quit the app first if it is running.',
    });
    if (response === 0) return false;
    uninstallApp(id);
    removeApp(id);
    if (response === 2 && !(await isRunning(id))) fs.rmSync(path.join(PROFILE_DIR, id), { recursive: true, force: true });
    return true;
  });

  h('apps:launch', async (id: string) => { await launch(id); return true; });
  h('apps:quit', async (id: string) => {
    // A second instance with --quit tells the running one to quit.
    const err = await spawnSelf(['--app', id, '--quit']);
    if (err) throw new Error(`Could not quit ${id}: ${err}`);
    return true;
  });
  h('apps:install', (id: string) => {
    const cfg = loadApps().find((a) => a.id === id);
    if (!cfg) throw new Error(`Unknown app ${id}`);
    return installApp(cfg);
  });
  h('apps:uninstall', (id: string) => uninstallApp(id));

  h('app:pickIcon', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose an icon', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const f = r.filePaths[0];
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
  });

  h('apps:export', async () => {
    const data = buildExport();
    if (!data.apps.length) throw new Error('There are no apps to export yet.');
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Export apps',
      defaultPath: path.join(app.getPath('downloads'), `webroost-apps-${stamp}.webroost`),
      filters: [{ name: 'WebRoost export', extensions: ['webroost'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return { file: r.filePath, count: data.apps.length };
  });

  h('apps:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import apps', properties: ['openFile'],
      filters: [{ name: 'WebRoost export', extensions: ['webroost', 'pwapop', 'json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const data = parseExport(fs.readFileSync(r.filePaths[0], 'utf8'));
    const have = new Set(loadApps().map((a) => a.id));
    const clash = data.apps.filter((a) => have.has(a.id));
    const list = data.apps.map((a) => `• ${a.name}${have.has(a.id) ? '  (already here)' : ''}`).join('\n');
    const buttons = clash.length ? ['Cancel', 'Add new apps only', 'Add and replace existing'] : ['Cancel', 'Import'];
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons, defaultId: buttons.length - 1, cancelId: 0,
      message: `Import ${data.apps.length} app${data.apps.length === 1 ? '' : 's'}?`,
      detail: `${list}\n\nSettings and icons are imported and each app is added to the application menu (and autostart where set). You will need to sign in to each app again on this computer.`,
    });
    if (response === 0) return null;
    const { written, skipped } = applyImport(data, clash.length ? response === 2 : true);
    for (const cfg of written) {
      try { installApp(cfg); } catch (e) { console.warn(`[webroost] could not install ${cfg.id}: ${e}`); }
      makePrimaryPhoneApp(cfg);
    }
    return { imported: written.length, skipped: skipped.length };
  });

  h('app:hidLast', () => lastHidList);
  h('icon:style', (dataUrl: string, style: IconStyle) => {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return dataUrl;
    return styleIcon(img, style).resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
  });
  h('icon:colors', () => COLOR_ORDER);
  h('app:openConfig', () => shell.openPath(CONFIG_FILE));
  h('app:installManager', () => installManagerEntry());
  h('app:info', () => ({
    version: releaseVersion(), configFile: CONFIG_FILE, flatpak: IN_FLATPAK, appImage: !!process.env.APPIMAGE,
  }));
  h('update:check', (force: boolean) => checkForUpdates(!!force));
  h('update:install', () => installUpdate((p) => {
    if (!win.isDestroyed()) { win.setProgressBar(p); win.webContents.send('update:progress', p); }
  }).then(async (msg) => {
    // Start the freshly installed version once so running apps restart onto it.
    await spawnSelf(['--restart-all']);
    return msg;
  }).finally(() => { if (!win.isDestroyed()) win.setProgressBar(-1); }));
  h('update:guide', () => updateGuide());
  h('update:download', () => downloadUpdate((p) => {
    if (!win.isDestroyed()) { win.setProgressBar(p); win.webContents.send('update:progress', p); }
  }).finally(() => { if (!win.isDestroyed()) win.setProgressBar(-1); }));
  h('app:copy', (text: string) => { clipboard.writeText(String(text)); return true; });
  h('update:getAuto', () => autoCheckEnabled());
  h('update:setAuto', (on: boolean) => { setAutoCheck(!!on); return true; });
  h('app:openExternal', (url: string) => { if (/^https?:/.test(url)) void shell.openExternal(url); });
}

export async function runManager(): Promise<void> {
  const ses = session.fromPartition('persist:webroost-manager');
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  // "Detect headset": we capture the WebHID chooser list and cancel the chooser.
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'hid');
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    lastHidList = details.deviceList.map((d) => ({ name: d.name, vendorId: d.vendorId, productId: d.productId }));
    callback();
  });

  const win = new BrowserWindow({
    width: 980, height: 760, minWidth: 640, minHeight: 480,
    title: 'WebRoost', icon: assetPath('assets', 'icons', '256x256.png'),
    autoHideMenuBar: true, show: false, backgroundColor: '#f5f6fa',
    webPreferences: {
      partition: 'persist:webroost-manager',
      preload: path.join(__dirname, 'preload', 'manager-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  registerIpc(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  app.on('window-all-closed', () => app.quit());
  await win.loadFile(assetPath('renderer', 'manager.html'));
  watchForNewVersion(win);
}

/**
 * After an update, reopen the manager on the new version too (the apps do the
 * same). Waits while an edit form is open so nothing unsaved is lost.
 */
function watchForNewVersion(win: BrowserWindow) {
  const startedAt = Date.now();
  let restarting = false;
  setInterval(async () => {
    if (restarting || win.isDestroyed()) return;
    const m = readVersionMarker();
    if (!m) return;
    if (!isNewer(m.version, releaseVersion()) && !(m.restartAll && m.at > startedAt)) return;
    try {
      const editing: boolean = await win.webContents.executeJavaScript(
        "!!(document.querySelector('#editor')?.open || document.querySelector('#guide')?.open)", true);
      if (editing) return;
    } catch { return; }
    restarting = true;
    app.releaseSingleInstanceLock();
    const err = await spawnSelf([]);
    if (err) { console.warn(`[webroost] manager restart failed: ${err}`); restarting = false; return; }
    app.exit(0);
  }, 15_000);
}
