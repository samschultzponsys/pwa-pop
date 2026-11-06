import * as fs from 'fs';
import * as path from 'path';
import { nativeImage } from 'electron';
import { defaultIcon, styleIcon } from './icons';
import { AppConfig, resolveApp, resolveIconPath } from './config';
import {
  APPLICATIONS_DIR, AUTOSTART_DIR, assetPath, desktopQuote, ensureDir, ICON_DIR, IN_FLATPAK, launcherCommand, WAYLAND_FLAGS,
} from './paths';

/**
 * Desktop-entry id for an app; also the window's Wayland app_id / X11 class,
 * which is how the taskbar finds the app's own icon. Inside Flatpak, KDE and
 * GNOME only accept ids that start with the Flatpak's id (the same scheme
 * Chrome's Flatpak uses for PWAs), so there it is "<flatpak-id>.<app-id>".
 */
export const desktopId = (id: string) => (IN_FLATPAK && process.env.FLATPAK_ID ? `${process.env.FLATPAK_ID}.${id}` : `webtray-${id}`);
const legacyDesktopId = (id: string) => `webtray-${id}`;
export const desktopFile = (id: string) => path.join(APPLICATIONS_DIR, `${desktopId(id)}.desktop`);
export const autostartFile = (id: string) => path.join(AUTOSTART_DIR, `${desktopId(id)}.desktop`);

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function execLine(args: string[]): string {
  const cmd = launcherCommand();
  // Chromium switches must not go to `flatpak run` itself, only to the app.
  const flags = IN_FLATPAK ? [] : WAYLAND_FLAGS;
  return [...cmd, ...flags, ...args].map(desktopQuote).join(' ');
}

/**
 * The icon file a .desktop entry points at. It lives in ~/.config/webtray/icons
 * (AppImage mounts are temporary) and includes a duplicate's colour/label.
 */
export function stableIcon(app: AppConfig): string {
  ensureDir(ICON_DIR);
  const resolved = resolveIconPath(app);
  const styled = !!(app.icon_color || app.icon_label);
  if (resolved && !styled && /\.(png|svg)$/i.test(resolved)) return resolved;
  let img = resolved ? nativeImage.createFromPath(resolved) : nativeImage.createEmpty();
  if (img.isEmpty()) img = defaultIcon();
  const out = path.join(ICON_DIR, `${app.id}.menu.png`);
  fs.writeFileSync(out, styleIcon(img, app).resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  return out;
}

function entry(app: AppConfig, icon: string, args: string[], extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    Type: 'Application',
    Version: '1.5',
    Name: app.name,
    GenericName: 'Web App',
    Comment: `${app.name} — runs in the tray with PWA Pop`,
    Exec: execLine(args),
    Icon: icon,
    Terminal: 'false',
    Categories: 'Network;WebBrowser;',
    StartupNotify: 'true',
    StartupWMClass: desktopId(app.id),
    'X-WebTray-Id': app.id,
    ...extra,
  };
  return '[Desktop Entry]\n' + Object.entries(fields).map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n') + '\n';
}

export interface InstallResult { desktop: string; autostart: string | null }

export function installApp(app: AppConfig): InstallResult {
  const r = resolveApp(app);
  const icon = stableIcon(app);
  ensureDir(APPLICATIONS_DIR);
  fs.writeFileSync(desktopFile(app.id), entry(app, icon, ['--app', app.id]), { mode: 0o755 });
  let auto: string | null = null;
  if (r.autostart) auto = setAutostart(app, true);
  else setAutostart(app, false);
  return { desktop: desktopFile(app.id), autostart: auto };
}

export function setAutostart(app: AppConfig, enabled: boolean): string | null {
  const file = autostartFile(app.id);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return null;
  }
  ensureDir(AUTOSTART_DIR);
  fs.writeFileSync(file, entry(app, stableIcon(app), ['--app', app.id, '--hidden'], {
    'X-GNOME-Autostart-enabled': 'true',
    'X-GNOME-Autostart-Delay': '3',
    // Make sure the system tray (StatusNotifierWatcher) exists before we start.
    'X-KDE-autostart-after': 'panel',
    'X-KDE-autostart-phase': '2',
    NoDisplay: 'true',
  }));
  return file;
}

export function uninstallApp(id: string): string[] {
  const removed: string[] = [];
  const legacy = [path.join(APPLICATIONS_DIR, `${legacyDesktopId(id)}.desktop`), path.join(AUTOSTART_DIR, `${legacyDesktopId(id)}.desktop`)];
  for (const f of [desktopFile(id), autostartFile(id), ...legacy]) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
  }
  return removed;
}

export function isInstalled(id: string) {
  return { menu: fs.existsSync(desktopFile(id)), autostart: fs.existsSync(autostartFile(id)) };
}

/** Menu entry for the manager UI itself (useful for AppImage users). */
export function installManagerEntry(): string {
  ensureDir(APPLICATIONS_DIR);
  ensureDir(ICON_DIR);
  const icon = path.join(ICON_DIR, 'webtray.png');
  fs.copyFileSync(assetPath('assets', 'icons', '256x256.png'), icon);
  const file = path.join(APPLICATIONS_DIR, 'webtray.desktop');
  fs.writeFileSync(file, entry({ id: 'manager', name: 'PWA Pop', url: 'about:blank' }, icon, [], {
    Comment: 'Turn web apps into tray-resident desktop apps',
    StartupWMClass: 'webtray',
    'X-WebTray-Id': 'manager',
  }));
  return file;
}

/**
 * Flatpak installs from before 1.7 wrote webtray-<id>.desktop, which KDE
 * ignores for sandboxed windows (every window showed the PWA Pop icon).
 * Rewrite those entries under the Flatpak-prefixed name.
 */
export function migrateDesktopEntries(apps: AppConfig[]): void {
  if (!IN_FLATPAK) return;
  for (const app of apps) {
    const oldMenu = path.join(APPLICATIONS_DIR, `${legacyDesktopId(app.id)}.desktop`);
    const oldAuto = path.join(AUTOSTART_DIR, `${legacyDesktopId(app.id)}.desktop`);
    const hadMenu = fs.existsSync(oldMenu), hadAuto = fs.existsSync(oldAuto);
    if (!hadMenu && !hadAuto) continue;
    try {
      if (hadMenu) installApp(app);
      if (hadAuto) setAutostart(app, true);
      fs.rmSync(oldMenu, { force: true });
      fs.rmSync(oldAuto, { force: true });
    } catch (e) {
      console.warn(`[webtray] could not migrate desktop entries for ${app.id}`, e);
    }
  }
}
