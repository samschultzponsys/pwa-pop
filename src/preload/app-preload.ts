/*
 * Preload for every hosted web app. Runs sandboxed; it may only import
 * 'electron'. It replaces the page's Notification API with a thin shim that
 * routes through the main process so that:
 *   - clicking a notification always shows + focuses the app window,
 *   - notifications can be muted from the tray,
 *   - they keep working while the window is hidden.
 * Page event handlers (onclick/onclose/onshow) still fire as normal.
 */
import { contextBridge, ipcRenderer } from 'electron';

// Tell the main process when the page stops/starts being visible. On KDE
// Wayland the compositor handles the minimize button itself, so this is how
// "minimize to tray" notices a minimize.
// Registered before the page's own listeners (capture on window), so it still
// sees every change when the page is told it stays visible (below).
let unloading = false;
window.addEventListener('pagehide', () => { unloading = true; }, true);
window.addEventListener('beforeunload', () => { unloading = true; }, true);
window.addEventListener('visibilitychange', () => {
  // A page going away also reports "hidden": that isn't a minimize.
  if (unloading && document.visibilityState === 'hidden') return;
  ipcRenderer.send('wt:visibility', document.visibilityState);
}, true);

// --wt-keep-visible (apps with notify_on_unread): the page always believes it
// is visible, like a desktop mail client, so it keeps refreshing its mail
// list and unread counts while hidden in the tray.
const keepVisible = (process.argv || []).includes('--wt-keep-visible');

type Listener = (id: number, type: string) => void;
const listeners: Listener[] = [];
ipcRenderer.on('wt:notify-event', (_e, id: number, type: string) => {
  for (const l of listeners) l(id, type);
});

contextBridge.exposeInMainWorld('__webroost', {
  show: (opts: unknown) => ipcRenderer.send('wt:notify', opts),
  close: (id: number) => ipcRenderer.send('wt:notify-close', id),
  onEvent: (cb: Listener) => { listeners.push(cb); },
  badge: (count: number | null) => ipcRenderer.send('wt:badge', count),
});

function installShim(keepVisible: boolean): void {
  const w = window as any;
  if (keepVisible && !w.__webroostVisible) {
    w.__webroostVisible = true;
    try {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
      w.addEventListener('visibilitychange', (e: Event) => e.stopImmediatePropagation(), true);
    } catch { /* ignore */ }
  }
  const bridge = w.__webroost;
  const Real: any = w.Notification;
  if (!bridge || !Real || w.__webroostShim) return;
  w.__webroostShim = true;

  let seq = 0;
  const live = new Map<number, any>();
  const instance = Math.random().toString(36).slice(2);

  const absolute = (u: unknown) => {
    if (!u) return '';
    try { return new URL(String(u), location.href).href; } catch { return ''; }
  };

  class Notification extends EventTarget {
    static get permission() { return Real.permission; }
    static requestPermission(cb?: (p: string) => void) { return Real.requestPermission(cb); }
    static get maxActions() { return 0; }

    title: string; body: string; icon: string; tag: string; data: any; silent: boolean;
    requireInteraction: boolean; dir: string; lang: string; badge: string; image: string;
    renotify: boolean; actions: any[]; timestamp: number; vibrate: number[];
    onclick: any = null; onclose: any = null; onshow: any = null; onerror: any = null;
    private _id: number;

    constructor(title: string, options: any = {}) {
      super();
      if (arguments.length === 0) throw new TypeError("Failed to construct 'Notification': 1 argument required");
      options = options || {};
      this.title = String(title);
      this.body = options.body == null ? '' : String(options.body);
      this.icon = absolute(options.icon);
      this.image = absolute(options.image);
      this.badge = absolute(options.badge);
      this.tag = options.tag == null ? '' : String(options.tag);
      this.data = options.data === undefined ? null : options.data;
      this.silent = !!options.silent;
      this.requireInteraction = !!options.requireInteraction;
      this.renotify = !!options.renotify;
      this.dir = options.dir || 'auto';
      this.lang = options.lang || '';
      this.actions = [];
      this.vibrate = [];
      this.timestamp = options.timestamp || Date.now();
      this._id = ++seq;
      for (const type of ['click', 'close', 'show', 'error']) {
        this.addEventListener(type, (ev) => {
          const h = (this as any)['on' + type];
          if (typeof h === 'function') h.call(this, ev);
        });
      }
      if (Real.permission !== 'granted') {
        setTimeout(() => this.dispatchEvent(new Event('error')), 0);
        return;
      }
      live.set(this._id, this);
      bridge.show({
        id: this._id, instance, title: this.title, body: this.body, icon: this.icon,
        tag: this.tag, silent: this.silent, requireInteraction: this.requireInteraction,
      });
    }

    close() { bridge.close(this._id); }
  }

  bridge.onEvent((id: number, type: string) => {
    const n = live.get(id);
    if (!n) return;
    n.dispatchEvent(new Event(type, { cancelable: type === 'click' }));
    if (type === 'close' || type === 'error') live.delete(id);
  });

  Object.defineProperty(w, 'Notification', { value: Notification, writable: true, configurable: true });

  // We are an installed app: report display-mode "standalone" like Chrome does
  // for installed PWAs. Some sites (the new Outlook) only set their unread
  // badge when they think they are installed.
  const mm = w.matchMedia && w.matchMedia.bind(w);
  if (mm) {
    w.matchMedia = function (query: string) {
      const mql = mm(query);
      const q = String(query).replace(/\s+/g, '').toLowerCase();
      if (q.includes('display-mode:standalone') || q.includes('display-mode:window-controls-overlay') === false && q.includes('display-mode:browser')) {
        const standalone = q.includes('display-mode:standalone');
        try { Object.defineProperty(mql, 'matches', { get: () => standalone, configurable: true }); } catch { /* ignore */ }
      }
      return mql;
    };
  }

  // App badge (unread count) as used by installed PWAs such as the new Outlook.
  const nav = w.Navigator && w.Navigator.prototype;
  if (nav) {
    nav.setAppBadge = function (count?: number) {
      bridge.badge(count === undefined ? -1 : Math.max(0, Math.floor(Number(count) || 0)));
      return Promise.resolve();
    };
    nav.clearAppBadge = function () { bridge.badge(0); return Promise.resolve(); };
  }

  // Pages often show notifications through their service worker registration.
  const SWR = w.ServiceWorkerRegistration;
  if (SWR && SWR.prototype) {
    SWR.prototype.showNotification = function (title: string, options?: any) {
      if (Real.permission !== 'granted') {
        return Promise.reject(new TypeError('No notification permission has been granted for this origin.'));
      }
      new Notification(title, options);
      return Promise.resolve();
    };
  }
}

// Run the shim in the page's own JavaScript world, before page scripts.
try {
  (contextBridge as any).executeInMainWorld({ func: installShim, args: [keepVisible] });
} catch (e) {
  console.warn('[webroost] notification shim unavailable', e);
}
