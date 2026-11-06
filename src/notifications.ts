import { ipcMain, nativeImage, NativeImage, Notification, ServiceWorkerMain, Session, WebContents, WebFrameMain } from 'electron';
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

/** Where a notification came from: a page (WebContents) or a service worker. */
interface Source {
  key: string;
  url(): string;
  send(id: number, type: string): void;
}

interface Live { n: Notification; src: Source | null; key: string; tag: string; id: number }

const debug = (msg: string) => { if (process.env.WEBTRAY_DEBUG) console.log(`[webtray] ${msg}`); };

/**
 * Turns page notifications (via the preload shim) into native freedesktop
 * notifications. Native objects are kept referenced so their click handlers
 * survive garbage collection.
 */
export class NotificationBridge {
  private live = new Map<string, Live>();
  private iconCache = new Map<string, NativeImage>();

  private pages = new WeakMap<WebContents, Source>();
  private frames = new Map<string, Source>();
  private workers = new Set<number>();

  constructor(private host: NotificationHost) {
    ipcMain.on('wt:notify', (e, opts: NotifyOptions) => { void this.show(this.pageSource(e.sender, e.senderFrame), opts); });
    ipcMain.on('wt:notify-close', (e, id: number) => this.closeFrom(this.pageSource(e.sender, e.senderFrame), id));
  }

  /** The page or embedded frame a notification came from (events go back to that frame). */
  private pageSource(wc: WebContents, frame?: WebFrameMain | null): Source {
    const main = !frame || frame === wc.mainFrame;
    if (main) {
      let src = this.pages.get(wc);
      if (!src) {
        src = {
          key: `wc${wc.id}`,
          url: () => (wc.isDestroyed() ? '' : wc.getURL()),
          send: (id, type) => { if (!wc.isDestroyed()) wc.send('wt:notify-event', id, type); },
        };
        this.pages.set(wc, src);
      }
      return src;
    }
    const key = `wc${wc.id}f${frame!.processId}.${frame!.routingId}`;
    let src = this.frames.get(key);
    if (!src) {
      const f = frame!;
      src = {
        key,
        url: () => { try { return f.url; } catch { return ''; } },
        send: (id, type) => { try { if (!f.isDestroyed()) f.send('wt:notify-event', id, type); } catch { /* frame gone */ } },
      };
      this.frames.set(key, src);
    }
    return src;
  }

  /** Accept notifications from a running service worker (see preload/sw-preload.ts). */
  attachServiceWorker(sw: ServiceWorkerMain) {
    if (this.workers.has(sw.versionId)) return;
    this.workers.add(sw.versionId);
    const src: Source = {
      key: `sw${sw.versionId}`,
      url: () => sw.scope,
      send: (id, type) => { try { if (!sw.isDestroyed()) sw.send('wt:notify-event', id, type); } catch { /* worker stopped */ } },
    };
    sw.ipc.on('wt:notify', (_e, opts: NotifyOptions) => { void this.show(src, opts); });
    sw.ipc.on('wt:notify-close', (_e, id: number) => this.closeFrom(src, id));
    // Version ids are never reused, so a stopped worker's entry is harmless.
  }

  private closeFrom(src: Source, id: number) {
    for (const l of this.live.values()) if (l.src === src && l.id === id) l.n.close();
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

  private async show(src: Source, o: NotifyOptions) {
    debug(`notification from ${src.key} (${src.url()}): ${o.title}`);
    if (!this.host.isAllowed(src.url())) {
      console.warn(`[webtray] notification from ${src.url()} blocked: origin not in allowed_origins`);
      src.send(o.id, 'error');
      return;
    }
    const key = `${src.key}:${o.instance}:${o.id}`;

    // Same tag replaces the previous notification, like Chrome does.
    if (o.tag) {
      for (const [k, l] of this.live) {
        if (l.src === src && l.tag === o.tag) { this.live.delete(k); l.n.close(); }
      }
    }

    if (this.host.isMuted()) {
      // Pretend it was shown so the page doesn't retry or error out.
      debug('notifications are muted');
      src.send(o.id, 'show');
      setTimeout(() => src.send(o.id, 'close'), 5000);
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
    const entry: Live = { n, src, key, tag: o.tag, id: o.id };
    this.live.set(key, entry);
    n.on('show', () => src.send(o.id, 'show'));
    n.on('click', () => {
      this.host.activate();
      src.send(o.id, 'click');
    });
    n.on('close', () => {
      this.live.delete(key);
      src.send(o.id, 'close');
    });
    n.on('failed', (_e: unknown, err: string) => {
      console.warn(`[webtray] notification failed: ${err}`);
      this.live.delete(key);
      src.send(o.id, 'error');
    });
    n.show();
  }

  /** Native notification raised by webtray itself (downloads etc.). */
  notify(title: string, body: string, onClick?: () => void) {
    if (this.host.isMuted()) return;
    const n = new Notification({ title, body, icon: this.host.appIcon() });
    const key = `self:${Date.now()}:${Math.random()}`;
    this.live.set(key, { n, src: null, key, tag: '', id: 0 });
    n.on('click', () => (onClick ?? (() => this.host.activate()))());
    n.on('close', () => this.live.delete(key));
    n.show();
  }
}
