import { ipcMain, nativeImage, NativeImage, Notification, Session, WebContents } from 'electron';
import { imageFromBuffer } from './icons';

export interface NotifyOptions {
  id: number;
  instance: string;
  title: string;
  body: string;
  icon: string;
  tag: string;
  silent: boolean;
  requireInteraction: boolean;
}

export interface NotificationHost {
  session: Session;
  appIcon(): NativeImage;
  isMuted(): boolean;
  urgent: boolean;
  raiseOnNotification: boolean;
  isAllowed(url: string): boolean;
  /** Show and focus the app window. */
  activate(): void;
}

interface Live { n: Notification; wc: WebContents; key: string; tag: string }

/**
 * Turns page notifications (via the preload shim) into native freedesktop
 * notifications. Native objects are kept referenced so their click handlers
 * survive garbage collection.
 */
export class NotificationBridge {
  private live = new Map<string, Live>();
  private iconCache = new Map<string, NativeImage>();

  constructor(private host: NotificationHost) {
    ipcMain.on('wt:notify', (e, opts: NotifyOptions) => { void this.show(e.sender, opts); });
    ipcMain.on('wt:notify-close', (e, id: number) => {
      for (const l of this.live.values()) if (l.wc === e.sender && l.key.endsWith(`:${id}`)) l.n.close();
    });
  }

  private send(wc: WebContents, id: number, type: string) {
    if (!wc.isDestroyed()) wc.send('wt:notify-event', id, type);
  }

  private async icon(url: string): Promise<NativeImage> {
    if (!url) return this.host.appIcon();
    const cached = this.iconCache.get(url);
    if (cached) return cached;
    let img: NativeImage | null = null;
    try {
      if (url.startsWith('data:')) {
        img = nativeImage.createFromDataURL(url);
        if (img.isEmpty()) {
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
          if (m) img = await imageFromBuffer(Buffer.from(m[3], m[2] ? 'base64' : 'utf8'), m[1]);
        }
      } else if (/^https?:/.test(url)) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const res = await this.host.session.fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) img = await imageFromBuffer(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? '');
      }
    } catch { /* fall through to the app icon */ }
    if (!img || img.isEmpty()) return this.host.appIcon();
    if (this.iconCache.size > 64) this.iconCache.clear();
    this.iconCache.set(url, img);
    return img;
  }

  private async show(wc: WebContents, o: NotifyOptions) {
    if (!this.host.isAllowed(wc.getURL())) { this.send(wc, o.id, 'error'); return; }
    const key = `${wc.id}:${o.instance}:${o.id}`;

    // Same tag replaces the previous notification, like Chrome does.
    if (o.tag) {
      for (const [k, l] of this.live) {
        if (l.wc === wc && l.tag === o.tag) { this.live.delete(k); l.n.close(); }
      }
    }

    if (this.host.isMuted()) {
      // Pretend it was shown so the page doesn't retry or error out.
      this.send(wc, o.id, 'show');
      setTimeout(() => this.send(wc, o.id, 'close'), 5000);
      return;
    }

    if (this.host.raiseOnNotification) this.host.activate();

    const urgent = this.host.urgent || o.requireInteraction;
    const n = new Notification({
      title: o.title || ' ',
      body: o.body,
      icon: await this.icon(o.icon),
      silent: o.silent,
      urgency: urgent ? 'critical' : 'normal',
      timeoutType: urgent ? 'never' : 'default',
    });
    const entry: Live = { n, wc, key, tag: o.tag };
    this.live.set(key, entry);
    n.on('show', () => this.send(wc, o.id, 'show'));
    n.on('click', () => {
      this.host.activate();
      this.send(wc, o.id, 'click');
    });
    n.on('close', () => {
      this.live.delete(key);
      this.send(wc, o.id, 'close');
    });
    n.on('failed', () => {
      this.live.delete(key);
      this.send(wc, o.id, 'error');
    });
    n.show();
  }

  /** Native notification raised by webtray itself (downloads etc.). */
  notify(title: string, body: string, onClick?: () => void) {
    if (this.host.isMuted()) return;
    const n = new Notification({ title, body, icon: this.host.appIcon() });
    const key = `self:${Date.now()}:${Math.random()}`;
    this.live.set(key, { n, wc: null as any, key, tag: '' });
    n.on('click', () => (onClick ?? (() => this.host.activate()))());
    n.on('close', () => this.live.delete(key));
    n.show();
  }
}
