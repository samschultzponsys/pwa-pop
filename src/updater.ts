/*
 * Update checks and installs.
 *
 * Every install flavour checks GitHub Releases (at most every 12 h) and tells
 * the user once per new version. Installing is flavour-specific:
 *   AppImage            download, verify SHA-256, replace the AppImage file
 *   rpm / deb / pacman  download, verify SHA-256, install with pkexec + dnf/apt/pacman
 *   Flatpak             handled by Flatpak itself (Discover / `flatpak update`)
 *                       from the PWA Pop Flatpak repository on GitHub Pages
 *   tar.gz / source     notify only, with a link to the release
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { app, net } from 'electron';
import { ensureDir, IN_FLATPAK, releaseVersion, STATE_DIR } from './paths';

export const REPO = 'samschultzponsys/pwa-pop';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STATE_FILE = path.join(STATE_DIR, '_updates.json');

export type InstallKind = 'flatpak' | 'appimage' | 'rpm' | 'deb' | 'pacman' | 'manual' | 'dev';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  kind: InstallKind;
  canInstall: boolean;
  releaseUrl: string | null;
  notes: string;
  checkedAt: number;
  error?: string;
}

interface UpdateState {
  lastCheck?: number;
  latest?: string;
  releaseUrl?: string;
  notes?: string;
  assets?: Record<string, string>; // name -> download url
  notified?: string;
  autoCheck?: boolean;
}

function readState(): UpdateState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s: UpdateState) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

/** "v1.10" -> [1, 10]. Returns null for anything that isn't MAJOR.MINOR[.x]. */
export function parseVersion(v: string): [number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err)));
}

let kindCache: InstallKind | null = null;
export async function installKind(): Promise<InstallKind> {
  if (kindCache) return kindCache;
  let kind: InstallKind = 'manual';
  if (!app.isPackaged) kind = 'dev';
  else if (IN_FLATPAK) kind = 'flatpak';
  else if (process.env.APPIMAGE) kind = 'appimage';
  else {
    const exe = fs.realpathSync(process.execPath);
    if (await run('rpm', ['-qf', exe])) kind = 'rpm';
    else if (await run('dpkg', ['-S', exe])) kind = 'deb';
    else if (await run('pacman', ['-Qo', exe])) kind = 'pacman';
  }
  kindCache = kind;
  return kind;
}

function assetName(kind: InstallKind, v: string): string | null {
  switch (kind) {
    case 'appimage': return `pwa-pop-${v}-x86_64.AppImage`;
    case 'rpm': return `pwa-pop-${v}-x86_64.rpm`;
    case 'deb': return `pwa-pop-${v}-amd64.deb`;
    case 'pacman': return `pwa-pop-${v}-x64.pacman`;
    default: return null;
  }
}

function canInstall(kind: InstallKind): boolean {
  return kind === 'appimage' || kind === 'rpm' || kind === 'deb' || kind === 'pacman';
}

function info(s: UpdateState, kind: InstallKind, error?: string): UpdateInfo {
  const current = releaseVersion();
  const latest = s.latest ?? null;
  const available = !!latest && isNewer(latest, current);
  return {
    current, latest, available, kind,
    canInstall: available && canInstall(kind) && !!s.assets?.[assetName(kind, latest!) ?? ''],
    releaseUrl: s.releaseUrl ?? null, notes: s.notes ?? '', checkedAt: s.lastCheck ?? 0, error,
  };
}

async function fetchJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Ask GitHub for the newest release. `force` ignores the 12 h interval. */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const kind = await installKind();
  const s = readState();
  if (!force && s.lastCheck && Date.now() - s.lastCheck < CHECK_INTERVAL_MS) return info(s, kind);
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const v = parseVersion(String(rel.tag_name ?? ''));
    if (!v) throw new Error(`unexpected release tag ${rel.tag_name}`);
    s.latest = `${v[0]}.${v[1]}`;
    s.releaseUrl = rel.html_url;
    s.notes = String(rel.body ?? '').split('\n### Downloads')[0].trim();
    s.assets = Object.fromEntries((rel.assets ?? []).map((a: any) => [a.name, a.browser_download_url]));
    s.lastCheck = Date.now();
    writeState(s);
    return info(s, kind);
  } catch (e: any) {
    return info(s, kind, e?.message ?? String(e));
  }
}

export function autoCheckEnabled(): boolean { return readState().autoCheck !== false; }
export function setAutoCheck(on: boolean) { const s = readState(); s.autoCheck = on; writeState(s); }

/**
 * Check in the background and call `notify` once per new version across all
 * webtray processes (the version is recorded in the shared state file).
 */
export async function backgroundCheck(notify: (u: UpdateInfo) => void): Promise<void> {
  if (!autoCheckEnabled() || !app.isPackaged) return;
  const u = await checkForUpdates(false);
  if (!u.available || !u.latest) return;
  const s = readState();
  if (s.notified === u.latest) return;
  s.notified = u.latest;
  writeState(s);
  notify(u);
}

async function download(url: string, dest: string, onProgress?: (p: number) => void): Promise<void> {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total && onProgress) onProgress(got / total);
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function verify(file: string, name: string, assets: Record<string, string>) {
  const sumsUrl = assets['SHA256SUMS.txt'];
  if (!sumsUrl) throw new Error('the release has no SHA256SUMS.txt; refusing to install an unverified file');
  const res = await net.fetch(sumsUrl);
  const sums = await res.text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(' ' + name) || l.trim().endsWith('*' + name));
  if (!line) throw new Error(`${name} is not listed in SHA256SUMS.txt`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256(file);
  if (expected !== actual) throw new Error(`checksum mismatch for ${name}`);
}

function pkexecInstall(kind: InstallKind, file: string): Promise<void> {
  let cmd: string[];
  if (kind === 'rpm') {
    cmd = fs.existsSync('/usr/bin/dnf') ? ['dnf', 'install', '-y', file]
      : fs.existsSync('/usr/bin/zypper') ? ['zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', file]
        : ['rpm', '-U', '--replacepkgs', file];
  } else if (kind === 'deb') cmd = ['apt-get', 'install', '-y', file];
  else cmd = ['pacman', '-U', '--noconfirm', file];
  return new Promise((resolve, reject) => {
    const p = spawn('pkexec', cmd, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`pkexec is not available (${e.message})`)));
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else if (code === 126 || code === 127) reject(new Error('the administrator password was not given'));
      else reject(new Error(err.trim().split('\n').pop() || `installer exited with code ${code}`));
    });
  });
}

/** Download, verify and install the latest version. Returns a message for the user. */
export async function installUpdate(onProgress?: (p: number) => void): Promise<string> {
  const kind = await installKind();
  const s = readState();
  const u = info(s, kind);
  if (!u.available || !u.latest) return 'PWA Pop is up to date.';
  const name = assetName(kind, u.latest);
  const url = name ? s.assets?.[name] : undefined;
  if (!name || !url) throw new Error('this kind of install cannot update itself; download the new version from the release page');

  const dir = path.join(os.homedir(), '.cache', 'webtray', 'updates');
  ensureDir(dir);
  const file = path.join(dir, name);
  await download(url, file + '.part', onProgress);
  fs.renameSync(file + '.part', file);
  await verify(file, name, s.assets!);

  if (kind === 'appimage') {
    const target = process.env.APPIMAGE as string;
    const tmp = target + '.new';
    try {
      fs.copyFileSync(file, tmp);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
    } catch (e: any) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`could not replace ${target}: ${e.message}`);
    }
  } else {
    await pkexecInstall(kind, file);
  }
  fs.rmSync(file, { force: true });
  return `PWA Pop ${u.latest} is installed. Running apps switch to it when you restart them (Quit from the tray, then open them again).`;
}
