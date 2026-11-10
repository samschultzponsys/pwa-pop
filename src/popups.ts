/*
 * Desktop popups. Inside Flatpak they are sent by a helper process started
 * through the Flatpak portal (notify-helper.ts): KDE Plasma keeps
 * notifications from the app's own processes out of the popup area (they only
 * reach the history), while the same notification from a portal-started
 * process pops up. Everywhere else, and if the helper can't run, Electron's
 * Notification is used.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { NativeImage, Notification } from 'electron';
import { debug } from './log';
import { ensureDir, IN_FLATPAK, STATE_DIR } from './paths';

export interface PopupOptions {
  title: string;
  body: string;
  icon: NativeImage;
  urgent: boolean;
  silent: boolean;
}

export interface PopupEvents {
  onShow?(): void;
  onClick?(): void;
  onClose?(): void;
  onFail?(error: string): void;
}

export interface PopupHandle { close(): void }

const ICON_CACHE = path.join(STATE_DIR, 'notify-icons');

/** Writes the icon where the desktop's notification server can read it. */
function iconFile(img: NativeImage): string {
  if (img.isEmpty()) return '';
  const png = img.resize({ width: 128, height: 128, quality: 'best' }).toPNG();
  const name = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16) + '.png';
  const file = path.join(ICON_CACHE, name);
  try {
    if (!fs.existsSync(file)) {
      ensureDir(ICON_CACHE);
      fs.writeFileSync(file, png);
      // Keep the cache small.
      const files = fs.readdirSync(ICON_CACHE);
      if (files.length > 200) for (const f of files.slice(0, 100)) fs.rmSync(path.join(ICON_CACHE, f), { force: true });
    }
    return file;
  } catch { return ''; }
}

export class Popups {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private broken = !IN_FLATPAK || process.env.WEBTRAY_NOTIFY === 'electron';
  private pending = new Map<string, { o: PopupOptions; ev: PopupEvents; fellBack: boolean; electron?: Notification }>();
  private seq = 0;

  constructor(private appName: string, private desktopEntry: string) {
    if (!this.broken) this.startHelper();
  }

  method(): string { return this.broken ? 'electron' : 'helper'; }

  private startHelper() {
    const script = path.join(__dirname, 'notify-helper.js');
    try {
      const child = spawn('flatpak-spawn', ['--watch-bus', '--clear-env', '--env=ELECTRON_RUN_AS_NODE=1', process.execPath, script], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.helper = child;
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { this.onHelper(JSON.parse(line)); } catch { /* ignore */ }
        }
      });
      child.stderr.on('data', (d: Buffer) => debug(`notify helper: ${d.toString().trim()}`));
      child.on('error', (e) => this.helperDown(`could not start: ${e.message}`));
      child.on('exit', (code) => this.helperDown(`exited (${code})`));
    } catch (e) {
      this.helperDown(String(e));
    }
  }

  private helperDown(why: string) {
    if (this.broken) return;
    debug(`notification helper ${why}; using Electron notifications`);
    this.broken = true;
    this.ready = false;
    this.helper = null;
    // Anything still waiting is shown the other way.
    for (const [key, p] of this.pending) if (!p.fellBack) this.fallback(key);
  }

  private onHelper(m: any) {
    if (m.ev === 'ready') { this.ready = true; debug('notification helper ready'); return; }
    if (m.ev === 'fatal') { this.helperDown(`failed: ${m.error}`); return; }
    const p = this.pending.get(m.key);
    if (!p) return;
    if (m.ev === 'shown') p.ev.onShow?.();
    else if (m.ev === 'click') p.ev.onClick?.();
    else if (m.ev === 'closed') { this.pending.delete(m.key); p.ev.onClose?.(); }
    else if (m.ev === 'failed') { debug(`helper notification failed: ${m.error}`); this.fallback(m.key); }
  }

  private fallback(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    p.fellBack = true;
    p.electron = this.electron(p.o, {
      ...p.ev,
      onClose: () => { this.pending.delete(key); p.ev.onClose?.(); },
    });
  }

  private electron(o: PopupOptions, ev: PopupEvents): Notification {
    const n = new Notification({
      title: o.title || ' ', body: o.body, icon: o.icon, silent: o.silent,
      urgency: o.urgent ? 'critical' : 'normal', timeoutType: o.urgent ? 'never' : 'default',
    });
    n.on('show', () => ev.onShow?.());
    n.on('click', () => ev.onClick?.());
    n.on('close', () => ev.onClose?.());
    n.on('failed', (_e: unknown, err: string) => ev.onFail?.(err));
    n.show();
    return n;
  }

  show(o: PopupOptions, ev: PopupEvents): PopupHandle {
    if (this.broken || !this.helper) {
      const n = this.electron(o, ev);
      return { close: () => n.close() };
    }
    const key = `p${++this.seq}`;
    const entry = { o, ev, fellBack: false } as { o: PopupOptions; ev: PopupEvents; fellBack: boolean; electron?: Notification };
    this.pending.set(key, entry);
    const msg = {
      op: 'show', key, appName: this.appName, icon: iconFile(o.icon), title: o.title, body: o.body,
      desktopEntry: this.desktopEntry, urgent: o.urgent,
    };
    try { this.helper.stdin.write(JSON.stringify(msg) + '\n'); } catch { this.fallback(key); }
    // No answer from the helper (still starting, or stuck): show it anyway.
    setTimeout(() => {
      const p = this.pending.get(key);
      if (p && !p.fellBack && !this.ready) this.fallback(key);
    }, 8000);
    return {
      close: () => {
        const p = this.pending.get(key);
        if (!p) return;
        if (p.electron) p.electron.close();
        else try { this.helper?.stdin.write(JSON.stringify({ op: 'close', key }) + '\n'); } catch { /* gone */ }
      },
    };
  }
}
