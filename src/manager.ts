import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { AppConfig, ID_RE, loadApps, removeApp, resolveApp, upsertApp } from './config';
import { installApp, installManagerEntry, isInstalled, setAutostart, uninstallApp } from './desktop';
import { CONFIG_FILE, ensureDir, ICON_DIR, PROFILE_DIR, assetPath, IN_FLATPAK, releaseVersion, spawnSelf } from './paths';
import { cleanUserAgent } from './runtime';
import { inspectSite } from './inspect';
import { autoCheckEnabled, checkForUpdates, installUpdate, setAutoCheck } from './updater';

/**
 * Is the app running? Chromium keeps a "SingletonSocket" in the profile. If
 * something accepts a connection on it, the app is up. This also works across
 * Flatpak sandboxes, where the PID in SingletonLock belongs to another PID
 * namespace and can't be checked.
 */
function isRunning(id: string): Promise<boolean> {
  const dir = path.join(PROFILE_DIR, id);
  try {
    const target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = parseInt(target.split('-').pop() ?? '', 10);
    if (pid) { process.kill(pid, 0); return Promise.resolve(true); }
  } catch { /* fall back to the socket */ }
  const sock = path.join(dir, 'SingletonSocket');
  if (!fs.existsSync(sock)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = net.connect(sock);
    const done = (v: boolean) => { c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

function iconDataUrl(file: string | null): string | null {
  if (!file) return null;
  try {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

async function launch(id: string): Promise<void> {
  const err = await spawnSelf(['--app', id]);
  if (err) throw new Error(`Could not start ${id}: ${err}`);
}

let lastHidList: { name: string; vendorId: number; productId: number }[] = [];

function registerIpc(win: BrowserWindow) {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  h('apps:list', () => Promise.all(loadApps().map(async (a) => {
    const r = resolveApp(a);
    return { config: a, icon: iconDataUrl(r.iconPath), installed: isInstalled(a.id), running: await isRunning(a.id) };
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

  h('app:hidLast', () => lastHidList);
  h('app:openConfig', () => shell.openPath(CONFIG_FILE));
  h('app:installManager', () => installManagerEntry());
  h('app:info', () => ({
    version: releaseVersion(), configFile: CONFIG_FILE, flatpak: IN_FLATPAK, appImage: !!process.env.APPIMAGE,
  }));
  h('update:check', (force: boolean) => checkForUpdates(!!force));
  h('update:install', () => installUpdate((p) => {
    if (!win.isDestroyed()) { win.setProgressBar(p); win.webContents.send('update:progress', p); }
  }).finally(() => { if (!win.isDestroyed()) win.setProgressBar(-1); }));
  h('update:getAuto', () => autoCheckEnabled());
  h('update:setAuto', (on: boolean) => { setAutoCheck(!!on); return true; });
  h('app:openExternal', (url: string) => { if (/^https?:/.test(url)) void shell.openExternal(url); });
}

export async function runManager(): Promise<void> {
  const ses = session.fromPartition('persist:webtray-manager');
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
    title: 'PWA Pop', icon: assetPath('assets', 'icons', '256x256.png'),
    autoHideMenuBar: true, show: false, backgroundColor: '#f5f6fa',
    webPreferences: {
      partition: 'persist:webtray-manager',
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
}
