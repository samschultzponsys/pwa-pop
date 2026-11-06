/*
 * webtray / PWA Pop entry point.
 *
 *   webtray                      open the manager (add / edit apps)
 *   webtray --app <id> [--hidden] run one app in its own process with a tray icon
 *   webtray --install <id>       add a menu entry (+ autostart if configured)
 *   webtray --uninstall <id>     remove the menu + autostart entries
 *   webtray --list               list configured apps
 *   webtray --add <url> [--id x] [--name "X"] [--autostart] [--hidden]
 */
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, getApp, ID_RE, loadApps, upsertApp } from './config';
import { autostartFile, desktopFile, installApp, isInstalled, uninstallApp } from './desktop';
import { CONFIG_FILE, ensureDir, PROFILE_DIR, releaseVersion } from './paths';

const HELP = `PWA Pop (webtray) — run web apps as tray-resident desktop apps

Usage:
  webtray                         Open the PWA Pop manager window
  webtray --app <id> [--hidden]   Run the app <id> from apps.yaml
  webtray --install <id>          Write the menu entry (and autostart entry if autostart: true)
  webtray --uninstall <id>        Remove the menu and autostart entries
  webtray --list                  Show configured apps
  webtray --add <url> [--id <id>] [--name <name>] [--autostart] [--start-hidden]
                                  Add an app to apps.yaml
  webtray --check-update          Check GitHub for a newer PWA Pop
  webtray --update                Download, verify and install it (AppImage, rpm, deb, pacman)
  webtray --version | --help

Config: ${CONFIG_FILE}
`;

// Chromium switches that keep hidden windows fully alive (ringing calls!) and
// make us a native Wayland client on KDE.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,WebRTCPipeWireCapturer');

// A tray app must not die (or show a crash dialog) because of one stray error.
process.on('uncaughtException', (e) => { console.error('[webtray] uncaught exception:', e); });
process.on('unhandledRejection', (e) => { console.error('[webtray] unhandled rejection:', e); });

// Electron puts its own args first; skip them. Chromium switches are ignored.
const argv = process.argv.slice(app.isPackaged ? 1 : 2);

function flag(name: string): boolean { return argv.includes(name); }
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function cleanUserAgentFallback(ua: string): string {
  return ua.replace(/\(KHTML, like Gecko\)\s+(?:\S+\/\S+\s+)*?(Chrome\/)/, '(KHTML, like Gecko) $1').replace(/\sElectron\/\S+/g, '');
}

function out(msg: string) { process.stdout.write(msg + '\n'); }
function fail(msg: string): never { process.stderr.write(`webtray: ${msg}\n`); app.exit(1); process.exit(1); }

function cli(): boolean {
  if (flag('--help') || flag('-h')) { out(HELP); return true; }
  if (flag('--version') || flag('-v')) { out(releaseVersion()); return true; }

  if (flag('--list')) {
    const apps = loadApps();
    if (!apps.length) out(`No apps configured in ${CONFIG_FILE}`);
    for (const a of apps) {
      const i = isInstalled(a.id);
      const tags = [i.menu ? 'menu' : null, i.autostart ? 'autostart' : null].filter(Boolean).join(', ');
      out(`${a.id.padEnd(14)} ${a.name.padEnd(18)} ${a.url}${tags ? `  [${tags}]` : ''}`);
    }
    return true;
  }

  const install = opt('--install');
  if (flag('--install')) {
    if (!install) fail('--install needs an app id');
    const cfg = loadApps().find((a) => a.id === install) ?? fail(`no app "${install}" in ${CONFIG_FILE}`);
    const r = installApp(cfg);
    out(`Installed ${r.desktop}`);
    if (r.autostart) out(`Installed ${r.autostart}`);
    return true;
  }

  const uninstall = opt('--uninstall');
  if (flag('--uninstall')) {
    if (!uninstall) fail('--uninstall needs an app id');
    const removed = uninstallApp(uninstall);
    if (!removed.length) out(`Nothing to remove for "${uninstall}" (${desktopFile(uninstall)}, ${autostartFile(uninstall)})`);
    for (const f of removed) out(`Removed ${f}`);
    return true;
  }

  const add = opt('--add');
  if (flag('--add')) {
    if (!add) fail('--add needs a URL');
    let url: URL;
    try { url = new URL(/^[a-z]+:\/\//i.test(add) ? add : `https://${add}`); } catch { fail(`invalid URL: ${add}`); }
    const id = opt('--id') ?? url.hostname.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!ID_RE.test(id)) fail(`invalid id "${id}", use --id`);
    if (loadApps().some((a) => a.id === id)) fail(`an app with id "${id}" already exists`);
    const cfg: AppConfig = {
      id, name: opt('--name') ?? id.charAt(0).toUpperCase() + id.slice(1), url: url.href,
      allowed_origins: [url.origin],
    };
    if (flag('--autostart')) cfg.autostart = true;
    if (flag('--start-hidden')) cfg.start_hidden = true;
    upsertApp(cfg);
    out(`Added "${id}" to ${CONFIG_FILE}. Run: webtray --install ${id}`);
    return true;
  }
  return false;
}

async function updateCli(install: boolean): Promise<void> {
  const { checkForUpdates, installUpdate, updateGuide } = await import('./updater');
  const u = await checkForUpdates(true);
  if (u.error) fail(`update check failed: ${u.error}`);
  if (!u.available) {
    const g = await updateGuide();
    out(`PWA Pop ${u.current} is up to date (installed as ${g.label}). ${g.summary}`);
    return;
  }
  out(`PWA Pop ${u.latest} is available (you have ${u.current}, installed as ${u.kind}).`);
  if (!install) return;
  if (!u.canInstall) {
    const g = await updateGuide();
    out(`Installed as ${g.label}${g.where ? ` (${g.where})` : ''}. ${g.summary}`);
    for (const st of g.steps) out(`  ${st.text}${st.command ? `\n    ${st.command}` : ''}`);
    if (u.releaseUrl) out(`Release page: ${u.releaseUrl}`);
    return;
  }
  let last = -1;
  out(await installUpdate((p) => {
    const pct = Math.floor(p * 10) * 10;
    if (pct !== last) { last = pct; process.stdout.write(`  downloading… ${pct}%\n`); }
  }));
}

function main() {
  if (flag('--update') || flag('--check-update')) {
    app.setPath('userData', path.join(PROFILE_DIR, '_cli'));
    app.whenReady()
      .then(() => updateCli(flag('--update')))
      .then(() => app.exit(0), (e) => fail(e?.message ?? String(e)));
    return;
  }
  try {
    if (cli()) { app.exit(0); return; }
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }

  const appId = opt('--app');
  if (flag('--app') && !appId) fail('--app needs an app id');

  if (appId) {
    let cfg;
    try { cfg = getApp(appId); } catch (e: any) { fail(e.message); }
    // One Chromium profile (and therefore one single-instance lock) per app.
    app.setName(cfg.name);
    app.userAgentFallback = cleanUserAgentFallback(app.userAgentFallback);
    ensureDir(PROFILE_DIR);
    app.setPath('userData', path.join(PROFILE_DIR, cfg.id));
    // Ties windows, taskbar badges and icons to webtray-<id>.desktop.
    process.env.CHROME_DESKTOP = `webtray-${cfg.id}.desktop`;
    app.commandLine.appendSwitch('class', `webtray-${cfg.id}`);
    if (!app.requestSingleInstanceLock({ id: cfg.id })) { app.exit(0); return; }
    const hidden = flag('--hidden') || cfg.start_hidden;
    app.whenReady().then(async () => {
      const { AppRuntime } = await import('./runtime');
      await new AppRuntime(cfg, hidden).start();
    }).catch((e) => fail(e?.stack ?? String(e)));
    return;
  }

  // Manager UI.
  app.setName('PWA Pop');
  ensureDir(PROFILE_DIR);
  app.setPath('userData', path.join(PROFILE_DIR, '_manager'));
  process.env.CHROME_DESKTOP = process.env.FLATPAK_ID ? `${process.env.FLATPAK_ID}.desktop` : 'webtray.desktop';
  app.commandLine.appendSwitch('class', 'webtray');
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  app.whenReady().then(async () => {
    const { runManager } = await import('./manager');
    await runManager();
  }).catch((e) => fail(e?.stack ?? String(e)));
}

main();
