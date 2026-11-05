import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, resolveApp, resolveIconPath } from './config';
import {
  APPLICATIONS_DIR, AUTOSTART_DIR, assetPath, desktopQuote, ensureDir, ICON_DIR, IN_FLATPAK, launcherCommand, WAYLAND_FLAGS,
} from './paths';

export const desktopId = (id: string) => `webtray-${id}`;
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

/** Copy the icon somewhere stable (AppImage mounts are temporary). */
export function stableIcon(app: AppConfig): string {
  ensureDir(ICON_DIR);
  const resolved = resolveIconPath(app);
  if (resolved && resolved.toLowerCase().endsWith('.png')) {
    return resolved;
  }
  const fallback = path.join(ICON_DIR, 'webtray.png');
  fs.copyFileSync(assetPath('assets', 'icons', '256x256.png'), fallback);
  return resolved ?? fallback;
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
  for (const f of [desktopFile(id), autostartFile(id)]) {
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
