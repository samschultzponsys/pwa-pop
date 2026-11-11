import * as fs from 'fs';
import * as path from 'path';
import { nativeImage } from 'electron';
import { defaultIcon, styleIcon } from './icons';
import { clearCallHandler, setDefaultCallHandler } from './calls';
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
export const desktopId = (id: string) => (IN_FLATPAK && process.env.FLATPAK_ID ? `${process.env.FLATPAK_ID}.${id}` : `webroost-${id}`);
/**
 * Entry names used by earlier versions: "webtray-<id>" (native packages, and
 * Flatpak before 1.7) and "io.github.samschultzponsys.PwaPop.<id>" (the
 * Flatpak before the rename to WebRoost).
 */
const LEGACY_FLATPAK_ID = 'io.github.samschultzponsys.PwaPop';
const legacyDesktopIds = (id: string) => [`webtray-${id}`, `${LEGACY_FLATPAK_ID}.${id}`];
export const desktopFile = (id: string) => path.join(APPLICATIONS_DIR, `${desktopId(id)}.desktop`);
export const autostartFile = (id: string) => path.join(AUTOSTART_DIR, `${desktopId(id)}.desktop`);

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function execLine(args: string[], fieldCode = ''): string {
  const cmd = launcherCommand();
  // Chromium switches must not go to `flatpak run` itself, only to the app.
  const flags = IN_FLATPAK ? [] : WAYLAND_FLAGS;
  // Field codes such as %u must not be quoted.
  return [...cmd, ...flags, ...args].map(desktopQuote).join(' ') + (fieldCode ? ` ${fieldCode}` : '');
}

/**
 * The icon file a .desktop entry points at. It lives in ~/.config/webroost/icons
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
    Comment: `${app.name} — runs in the tray with WebRoost`,
    Exec: execLine(args, extra['X-WebRoost-FieldCode'] ?? ''),
    Icon: icon,
    Terminal: 'false',
    Categories: 'Network;WebBrowser;',
    StartupNotify: 'true',
    StartupWMClass: desktopId(app.id),
    'X-WebRoost-Id': app.id,
    ...extra,
  };
  delete fields['X-WebRoost-FieldCode'];
  return '[Desktop Entry]\n' + Object.entries(fields).map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n') + '\n';
}

export interface InstallResult { desktop: string; autostart: string | null }

export function installApp(app: AppConfig): InstallResult {
  const r = resolveApp(app);
  const icon = stableIcon(app);
  ensureDir(APPLICATIONS_DIR);
  const schemes = (app.handle_schemes ?? []).filter((x) => /^[a-z][a-z0-9+.-]*$/i.test(x));
  const extra: Record<string, string> = schemes.length
    ? { MimeType: schemes.map((x) => `x-scheme-handler/${x};`).join(''), 'X-WebRoost-FieldCode': '%u' }
    : {};
  fs.writeFileSync(desktopFile(app.id), entry(app, icon, ['--app', app.id], extra), { mode: 0o755 });
  const file = `${desktopId(app.id)}.desktop`;
  try {
    clearCallHandler(file);
    if (schemes.length) setDefaultCallHandler(file, schemes);
  } catch (e) {
    console.warn('[webroost] could not register the link handler', e);
  }
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
  clearCallHandler(`${desktopId(id)}.desktop`);
  for (const old of legacyDesktopIds(id)) clearCallHandler(`${old}.desktop`);
  const legacy = legacyDesktopIds(id).flatMap((old) => [path.join(APPLICATIONS_DIR, `${old}.desktop`), path.join(AUTOSTART_DIR, `${old}.desktop`)]);
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
  const icon = path.join(ICON_DIR, 'webroost.png');
  fs.copyFileSync(assetPath('assets', 'icons', '256x256.png'), icon);
  const file = path.join(APPLICATIONS_DIR, 'webroost.desktop');
  fs.writeFileSync(file, entry({ id: 'manager', name: 'WebRoost', url: 'about:blank' }, icon, [], {
    Comment: 'Turn web apps into tray-resident desktop apps',
    StartupWMClass: 'webroost',
    'X-WebRoost-Id': 'manager',
  }));
  return file;
}

/**
 * Bring menu and autostart entries up to date:
 *  - entries written under an earlier name (webtray-<id>, the PWA Pop Flatpak's
 *    io.github.samschultzponsys.PwaPop.<id>) are rewritten under the current
 *    one and removed, together with their tel:/sip: default-handler entry;
 *  - Flatpak entries whose Exec line is out of date (no --branch) are rewritten.
 */
export function migrateDesktopEntries(apps: AppConfig[]): void {
  // The manager's own menu entry from PWA Pop (native packages).
  const oldManager = path.join(APPLICATIONS_DIR, 'webtray.desktop');
  if (fs.existsSync(oldManager)) {
    try { installManagerEntry(); fs.rmSync(oldManager, { force: true }); } catch { /* best effort */ }
  }
  for (const app of apps) {
    if (IN_FLATPAK) {
      for (const f of [desktopFile(app.id), autostartFile(app.id)]) {
        try {
          if (!fs.existsSync(f)) continue;
          const want = execLine(['--app', app.id]);
          const has = /^Exec=(.*)$/m.exec(fs.readFileSync(f, 'utf8'))?.[1] ?? '';
          if (!has.startsWith(want)) {
            if (f === desktopFile(app.id)) installApp(app); else setAutostart(app, true);
          }
        } catch { /* best effort */ }
      }
    }
    for (const old of legacyDesktopIds(app.id)) {
      if (old === desktopId(app.id)) continue;
      const oldMenu = path.join(APPLICATIONS_DIR, `${old}.desktop`);
      const oldAuto = path.join(AUTOSTART_DIR, `${old}.desktop`);
      const hadMenu = fs.existsSync(oldMenu), hadAuto = fs.existsSync(oldAuto);
      if (!hadMenu && !hadAuto) continue;
      try {
        clearCallHandler(`${old}.desktop`);
        if (hadMenu) installApp(app);
        if (hadAuto) setAutostart(app, true);
        fs.rmSync(oldMenu, { force: true });
        fs.rmSync(oldAuto, { force: true });
        console.log(`[webroost] moved ${old}.desktop to ${desktopId(app.id)}.desktop`);
      } catch (e) {
        console.warn(`[webroost] could not migrate desktop entries for ${app.id}`, e);
      }
    }
  }
}
