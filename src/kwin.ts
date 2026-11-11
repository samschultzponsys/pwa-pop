/*
 * Minimize to the tray on KDE Plasma (Wayland). KWin handles the minimize
 * button itself and never tells the app, so WebRoost loads a tiny KWin
 * script instead: when the window of an app with "minimize to the tray" is
 * minimized, it is taken off the taskbar (it lives in its tray icon); when it
 * is restored, it comes back. Nothing about drawing changes, so the worst a
 * failure can do is leave the window on the taskbar.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { loadApps } from './config';
import { desktopId } from './desktop';
import { CONFIG_DIR, ensureDir } from './paths';
import { debug } from './log';

const PLUGIN = 'webroost-minimize-to-tray';
const SCRIPT = path.join(CONFIG_DIR, 'kwin', `${PLUGIN}.js`);

export function onKdeWayland(): boolean {
  return !!process.env.WAYLAND_DISPLAY && /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '');
}

function kwin(method: string, ...args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting',
      '--method', `org.kde.kwin.Scripting.${method}`, ...args], { timeout: 5000 },
    (err, stdout, stderr) => {
      if (err) { debug(`kwin ${method} failed: ${(stderr || err.message).trim()}`); resolve(null); return; }
      resolve(stdout.trim());
    });
  });
}

export function scriptSource(ids: string[]): string {
  return `// Written by WebRoost: minimize to the tray for these apps.
const ids = new Set(${JSON.stringify(ids)});
function track(w) {
  if (!w || !ids.has(String(w.desktopFileName || '').replace(/\\.desktop$/, ''))) return;
  if (w.minimized) w.skipTaskbar = true;
  w.minimizedChanged.connect(function () { w.skipTaskbar = w.minimized; });
}
workspace.windowList().forEach(track);
workspace.windowAdded.connect(track);
`;
}

let last = '';

/** (Re)load the KWin script with every app that has minimize_to_tray. Returns true if KWin accepted it. */
export async function syncKwinScript(): Promise<boolean> {
  if (!onKdeWayland()) return false;
  let ids: string[] = [];
  try { ids = loadApps().filter((a) => a.minimize_to_tray).map((a) => desktopId(a.id)); } catch { /* bad config */ }
  const src = scriptSource(ids);
  if (src === last) return true;
  try {
    ensureDir(path.dirname(SCRIPT));
    fs.writeFileSync(SCRIPT, src);
  } catch (e) {
    debug(`could not write the KWin script: ${e}`);
    return false;
  }
  await kwin('unloadScript', PLUGIN);
  if (!ids.length) { last = src; debug('KWin minimize-to-tray script unloaded (no apps use it)'); return true; }
  const loaded = await kwin('loadScript', SCRIPT, PLUGIN);
  if (!loaded || /-1/.test(loaded)) return false;
  await kwin('start');
  last = src;
  debug(`KWin minimize-to-tray script loaded for ${ids.join(', ')}`);
  return true;
}
