import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// WEBTRAY_* settings from before the rename (PWA Pop) still work.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('WEBTRAY_') && v !== undefined) {
    const nk = 'WEBROOST_' + k.slice('WEBTRAY_'.length);
    if (process.env[nk] === undefined) process.env[nk] = v;
  }
}

/** True when running inside a Flatpak sandbox. */
export const IN_FLATPAK = !!process.env.FLATPAK_ID;

function hostConfigHome(): string {
  // Inside Flatpak XDG_CONFIG_HOME points at ~/.var/app/<id>/config. We want the
  // host's ~/.config/webroost (granted via --filesystem=xdg-config/webroost:create)
  // so the same apps.yaml works for every install flavour.
  if (IN_FLATPAK) return path.join(os.homedir(), '.config');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function hostDataHome(): string {
  if (IN_FLATPAK) return path.join(os.homedir(), '.local', 'share');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

export const CONFIG_HOME = hostConfigHome();
export const CONFIG_DIR = path.join(hostConfigHome(), 'webroost');
/** Where PWA Pop (the name before WebRoost) kept everything. */
export const LEGACY_CONFIG_DIR = path.join(hostConfigHome(), 'webtray');
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

/** Branch of the running Flatpak ("stable"), from the sandbox's /.flatpak-info. */
export function flatpakBranch(): string | null {
  try {
    const info = process.env.WEBROOST_FLATPAK_INFO || '/.flatpak-info'; // override for tests
    const m = /^branch=(.+)$/m.exec(fs.readFileSync(info, 'utf8'));
    return m && /^[\w.-]+$/.test(m[1].trim()) ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * The command a .desktop file / child process should use to start webroost.
 * Handles AppImage, Flatpak, packaged (rpm/deb/tar) and `electron .` dev runs.
 */
export function launcherCommand(): string[] {
  if (IN_FLATPAK) {
    // Name our own branch: with several installed (old "master" bundles and
    // "stable"), a plain `flatpak run` starts whichever is "current".
    const branch = flatpakBranch();
    return ['flatpak', 'run', ...(branch ? [`--branch=${branch}`] : []), process.env.FLATPAK_ID as string];
  }
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  if (app.isPackaged) {
    // Prefer the /usr/bin symlink when it points at us (rpm/deb installs).
    try {
      if (fs.realpathSync('/usr/bin/webroost') === fs.realpathSync(process.execPath)) return ['/usr/bin/webroost'];
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
 * Start another webroost process (an app, or the manager) from this one.
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
    attempts.push(['flatpak-spawn', '--latest-version', '--', '/app/bin/webroost', ...args]);
    attempts.push(['/app/bin/webroost', ...args]);
  } else {
    attempts.push([...launcherCommand(), ...args]);
  }
  const env = { ...process.env };
  // Each app must pick its own desktop id; don't leak the caller's.
  delete env.CHROME_DESKTOP;

  return new Promise((resolve) => {
    const tryNext = (i: number, lastError: string | null) => {
      if (i >= attempts.length) { resolve(lastError ?? 'could not start webroost'); return; }
      const [cmd, ...rest] = attempts[i];
      let settled = false;
      try {
        const log = process.env.WEBROOST_SPAWN_LOG;
        const out = log ? require('fs').openSync(log, 'a') : 'ignore';
        const child = spawn(cmd, rest, { detached: true, stdio: ['ignore', out, out], env });
        child.once('error', (e) => {
          if (settled) return;
          settled = true;
          console.warn(`[webroost] failed to run ${cmd}: ${e.message}`);
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

// ------------------------------------------------- version marker (updates)

/** Shared file where every starting WebRoost process records its version. */
export const VERSION_MARKER = path.join(STATE_DIR, '_version.json');

export interface VersionMarker { version: string; at: number; restartAll?: boolean }

export function readVersionMarker(): VersionMarker | null {
  try { return JSON.parse(fs.readFileSync(VERSION_MARKER, 'utf8')); } catch { return null; }
}

/** Record this process's version (never downgrade the marker). */
export function writeVersionMarker(restartAll = false): void {
  const mine = releaseVersion();
  const cur = readVersionMarker();
  const num = (v: string) => v.split('.').map(Number);
  const newer = (a: string, b: string) => { const [x, y] = num(a), [p, q] = num(b); return x !== p ? x > p : y > q; };
  if (cur && newer(cur.version, mine) && !restartAll) return;
  try {
    ensureDir(STATE_DIR);
    fs.writeFileSync(VERSION_MARKER + '.tmp', JSON.stringify({ version: mine, at: Date.now(), restartAll } satisfies VersionMarker));
    fs.renameSync(VERSION_MARKER + '.tmp', VERSION_MARKER);
  } catch { /* best effort */ }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * First start after the rename: copy ~/.config/webtray (apps, icons, window
 * state and the apps' browser profiles with their logins) to
 * ~/.config/webroost. A copy, not a move: inside Flatpak the two folders are
 * separate mounts. The old folder is left with a note and can be deleted.
 * Several apps start at once at login, so one copies and the others wait.
 */
export function migrateLegacyConfig(): void {
  const done = path.join(CONFIG_DIR, 'apps.yaml');
  const legacyFile = path.join(LEGACY_CONFIG_DIR, 'apps.yaml');
  if (fs.existsSync(done) || !fs.existsSync(legacyFile)) return;
  ensureDir(CONFIG_DIR);
  const lock = path.join(CONFIG_DIR, '.migrating');
  try {
    fs.mkdirSync(lock);
  } catch {
    // Another WebRoost process is copying: wait for it (up to 5 minutes).
    const until = Date.now() + 5 * 60_000;
    while (fs.existsSync(lock) && !fs.existsSync(done) && Date.now() < until) sleepSync(250);
    return;
  }
  try {
    const skip = /^(Singleton(Lock|Socket|Cookie)|lockfile|\.migrating)$/;
    for (const entry of fs.readdirSync(LEGACY_CONFIG_DIR)) {
      if (entry === 'apps.yaml' || skip.test(entry)) continue;
      fs.cpSync(path.join(LEGACY_CONFIG_DIR, entry), path.join(CONFIG_DIR, entry), {
        recursive: true, force: false, errorOnExist: false, preserveTimestamps: true,
        filter: (src) => !skip.test(path.basename(src)),
      });
    }
    // Icon paths in apps.yaml point into the old folder.
    const yaml = fs.readFileSync(legacyFile, 'utf8').split(LEGACY_CONFIG_DIR + path.sep).join(CONFIG_DIR + path.sep);
    fs.writeFileSync(done + '.tmp', yaml);
    fs.renameSync(done + '.tmp', done); // apps.yaml last: it marks the copy complete
    try {
      fs.writeFileSync(path.join(LEGACY_CONFIG_DIR, 'MOVED-TO-WEBROOST.txt'),
        `PWA Pop is now WebRoost. Everything in this folder was copied to ${CONFIG_DIR} on ${new Date().toString()}.\n` +
        'Once WebRoost works for you, this folder can be deleted.\n');
    } catch { /* read-only: fine */ }
    console.log(`[webroost] copied settings and logins from ${LEGACY_CONFIG_DIR} to ${CONFIG_DIR}`);
  } catch (e) {
    console.warn('[webroost] could not copy the PWA Pop settings', e);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
