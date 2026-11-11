/*
 * webroost / WebRoost entry point.
 *
 *   webroost                      open the manager (add / edit apps)
 *   webroost --app <id> [--hidden] run one app in its own process with a tray icon
 *   webroost --install <id>       add a menu entry (+ autostart if configured)
 *   webroost --uninstall <id>     remove the menu + autostart entries
 *   webroost --list               list configured apps
 *   webroost --add <url> [--id x] [--name "X"] [--autostart] [--hidden]
 */
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, getApp, ID_RE, loadApps, upsertApp } from './config';
import { autostartFile, desktopFile, desktopId, installApp, isInstalled, migrateDesktopEntries, uninstallApp } from './desktop';
import { StateStore } from './state';
import { onKdeWayland } from './kwin';
import { setDefaultCallHandler } from './calls';
import { CONFIG_FILE, ensureDir, migrateLegacyConfig, PROFILE_DIR, releaseVersion, writeVersionMarker } from './paths';

const HELP = `WebRoost (webroost) — run web apps as tray-resident desktop apps

Usage:
  webroost                         Open the WebRoost manager window
  webroost --app <id> [--hidden]   Run the app <id> from apps.yaml
  webroost --install <id>          Write the menu entry (and autostart entry if autostart: true)
  webroost --uninstall <id>        Remove the menu and autostart entries
  webroost --list                  Show configured apps
  webroost --add <url> [--id <id>] [--name <name>] [--autostart] [--start-hidden]
                                  Add an app to apps.yaml
  webroost --restart-all           Ask running apps to restart (after an update)
  webroost --check-update          Check GitHub for a newer WebRoost
  webroost --update                Download, verify and install it (AppImage, rpm, deb, pacman)
  webroost --version | --help

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
process.on('uncaughtException', (e) => { console.error('[webroost] uncaught exception:', e); });
process.on('unhandledRejection', (e) => { console.error('[webroost] unhandled rejection:', e); });

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
function fail(msg: string): never { process.stderr.write(`webroost: ${msg}\n`); app.exit(1); process.exit(1); }

function cli(): boolean {
  // First start after the PWA Pop -> WebRoost rename: bring settings and logins along.
  migrateLegacyConfig();
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
    out(`Added "${id}" to ${CONFIG_FILE}. Run: webroost --install ${id}`);
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
    out(`WebRoost ${u.current} is up to date (installed as ${g.label}). ${g.summary}`);
    return;
  }
  out(`WebRoost ${u.latest} is available (you have ${u.current}, installed as ${u.kind}).`);
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
  if (flag('--restart-all')) {
    // Run by the update commands right after installing: tell every running
    // WebRoost app to restart onto this version (they wait for a quiet moment).
    writeVersionMarker(true);
    out(`Asked running WebRoost apps to restart onto ${releaseVersion()}. They restart when you're not on a call or typing in them.`);
    app.exit(0);
    return;
  }
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
    // Ties windows, taskbar badges and icons to webroost-<id>.desktop.
    process.env.CHROME_DESKTOP = `${desktopId(cfg.id)}.desktop`;
    app.commandLine.appendSwitch('class', desktopId(cfg.id));
    // Minimize to the tray. Wayland compositors handle the minimize button
    // themselves; the app only learns of it when the page turns "hidden"
    // (see the visibility relay in the preload). Chromium's
    // disable-backgrounding-occluded-windows stops that from happening, so
    // drop it for these apps. XWayland (where minimizing is reported
    // directly) is opt-in: on some systems its drawing fails inside the
    // Flatpak and the window never appears.
    if (cfg.minimize_to_tray && process.env.WAYLAND_DISPLAY) {
      const xwaylandBroken = !!new StateStore(cfg.id).data.xwaylandBroken;
      if (process.env.WEBROOST_XWAYLAND === '1' && process.env.DISPLAY && !xwaylandBroken) {
        app.commandLine.appendSwitch('ozone-platform', 'x11');
        app.disableHardwareAcceleration();
      } else if (!onKdeWayland()) {
        // KDE uses a KWin script instead (src/kwin.ts).
        app.commandLine.removeSwitch('disable-backgrounding-occluded-windows');
      }
    }
    if (!app.requestSingleInstanceLock({ id: cfg.id })) { app.exit(0); return; }
    try { migrateDesktopEntries([cfg]); } catch { /* best effort */ }
    // The phone app keeps the tel:/callto:/sip: default (something else may
    // have taken it, or an older version couldn't write it inside Flatpak).
    if (cfg.handle_schemes?.length && isInstalled(cfg.id).menu) {
      try { setDefaultCallHandler(`${desktopId(cfg.id)}.desktop`, cfg.handle_schemes); } catch (e) { console.warn('[webroost] could not set the phone-link default', e); }
    }
    // We got the lock, so this app wasn't running: nothing to quit.
    if (flag('--quit')) { app.exit(0); return; }
    writeVersionMarker();
    const hidden = flag('--hidden') || cfg.start_hidden;
    app.whenReady().then(async () => {
      const { AppRuntime } = await import('./runtime');
      const { findCallLink } = await import('./calls');
      const call = cfg.handle_schemes?.length ? findCallLink(process.argv, cfg.handle_schemes) : null;
      await new AppRuntime(cfg, hidden && !call, call).start();
    }).catch((e) => fail(e?.stack ?? String(e)));
    return;
  }

  // Manager UI.
  app.setName('WebRoost');
  ensureDir(PROFILE_DIR);
  app.setPath('userData', path.join(PROFILE_DIR, '_manager'));
  process.env.CHROME_DESKTOP = process.env.FLATPAK_ID ? `${process.env.FLATPAK_ID}.desktop` : 'webroost.desktop';
  app.commandLine.appendSwitch('class', 'webroost');
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  try { migrateDesktopEntries(loadApps()); } catch { /* best effort */ }
  writeVersionMarker();
  app.whenReady().then(async () => {
    const { runManager } = await import('./manager');
    await runManager();
  }).catch((e) => fail(e?.stack ?? String(e)));
}

main();
