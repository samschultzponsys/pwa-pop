import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

/** True when running inside a Flatpak sandbox. */
export const IN_FLATPAK = !!process.env.FLATPAK_ID;

function hostConfigHome(): string {
  // Inside Flatpak XDG_CONFIG_HOME points at ~/.var/app/<id>/config. We want the
  // host's ~/.config/webtray (granted via --filesystem=xdg-config/webtray:create)
  // so the same apps.yaml works for every install flavour.
  if (IN_FLATPAK) return path.join(os.homedir(), '.config');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function hostDataHome(): string {
  if (IN_FLATPAK) return path.join(os.homedir(), '.local', 'share');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

export const CONFIG_HOME = hostConfigHome();
export const CONFIG_DIR = path.join(hostConfigHome(), 'webtray');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'apps.yaml');
export const ICON_DIR = path.join(CONFIG_DIR, 'icons');
export const STATE_DIR = path.join(CONFIG_DIR, 'state');
export const PROFILE_DIR = path.join(CONFIG_DIR, 'profiles');
export const APPLICATIONS_DIR = path.join(hostDataHome(), 'applications');
export const AUTOSTART_DIR = path.join(hostConfigHome(), 'autostart');

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Directory holding bundled assets (icon, renderer pages). */
export function assetPath(...parts: string[]): string {
  return path.join(app.getAppPath(), ...parts);
}

/**
 * The command a .desktop file / child process should use to start webtray.
 * Handles AppImage, Flatpak, packaged (rpm/deb/tar) and `electron .` dev runs.
 */
export function launcherCommand(): string[] {
  if (IN_FLATPAK) return ['flatpak', 'run', process.env.FLATPAK_ID as string];
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  if (app.isPackaged) {
    // Prefer the /usr/bin symlink when it points at us (rpm/deb installs).
    try {
      if (fs.realpathSync('/usr/bin/webtray') === fs.realpathSync(process.execPath)) return ['/usr/bin/webtray'];
    } catch { /* not installed system-wide */ }
    return [process.execPath];
  }
  return [process.execPath, app.getAppPath()];
}

/** Flags we always pass so Chromium picks native Wayland on KDE. */
export const WAYLAND_FLAGS = ['--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations'];

/** Quote an argument for a .desktop Exec= line. */
export function desktopQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:+,@]+$/.test(arg)) return arg;
  return '"' + arg.replace(/(["`$\\])/g, '\\$1') + '"';
}

/** Release version as MAJOR.MINOR (package.json keeps a .0 patch for npm). */
export function releaseVersion(): string {
  return app.getVersion().split('.').slice(0, 2).join('.');
}

/**
 * Start another webtray process (an app, or the manager) from this one.
 *
 * Inside Flatpak the `flatpak` command does not exist, and a plain child
 * process would die with this sandbox when the manager closes. So we ask the
 * Flatpak portal for a fresh sandbox of this same app via `flatpak-spawn`
 * (no --host, so no extra permissions). Resolves with an error message
 * instead of throwing, so a failed launch never crashes the caller.
 */
export function spawnSelf(args: string[]): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('child_process') as typeof import('child_process');
  const attempts: string[][] = [];
  // Keep running unsandboxed children if we were started that way.
  if (process.argv.includes('--no-sandbox')) args = [...args, '--no-sandbox'];
  if (IN_FLATPAK) {
    attempts.push(['flatpak-spawn', '--', '/app/bin/webtray', ...args]);
    attempts.push(['/app/bin/webtray', ...args]);
  } else {
    attempts.push([...launcherCommand(), ...args]);
  }
  const env = { ...process.env };
  // Each app must pick its own desktop id; don't leak the caller's.
  delete env.CHROME_DESKTOP;

  return new Promise((resolve) => {
    const tryNext = (i: number, lastError: string | null) => {
      if (i >= attempts.length) { resolve(lastError ?? 'could not start webtray'); return; }
      const [cmd, ...rest] = attempts[i];
      let settled = false;
      try {
        const log = process.env.WEBTRAY_SPAWN_LOG;
        const out = log ? require('fs').openSync(log, 'a') : 'ignore';
        const child = spawn(cmd, rest, { detached: true, stdio: ['ignore', out, out], env });
        child.once('error', (e) => {
          if (settled) return;
          settled = true;
          console.warn(`[webtray] failed to run ${cmd}: ${e.message}`);
          tryNext(i + 1, `${cmd}: ${e.message}`);
        });
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          child.unref();
          resolve(null);
        });
      } catch (e: any) {
        settled = true;
        tryNext(i + 1, `${cmd}: ${e?.message ?? e}`);
      }
    };
    tryNext(0, null);
  });
}
