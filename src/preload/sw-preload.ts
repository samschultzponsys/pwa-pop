/*
 * Preload for the hosted apps' service workers. Electron drops notifications a
 * service worker shows (registration.showNotification) without telling it, and
 * modern web apps such as the new Outlook send their desktop notifications
 * exactly that way. This replaces showNotification inside the worker with a
 * bridge to the main process, which shows a native notification. A click is
 * sent back to the worker as a "notificationclick" event so the app can open
 * the right email/chat.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Listener = (id: number, type: string) => void;
const listeners: Listener[] = [];
ipcRenderer.on('wt:notify-event', (_e, id: number, type: string) => {
  for (const l of listeners) l(id, type);
});

contextBridge.exposeInMainWorld('__webtraySW', {
  show: (opts: unknown) => ipcRenderer.send('wt:notify', opts),
  close: (id: number) => ipcRenderer.send('wt:notify-close', id),
  onEvent: (cb: Listener) => { listeners.push(cb); },
  badge: (count: number | null) => ipcRenderer.send('wt:badge', count),
});

function installSwShim(): void {
  const g = self as any;
  const bridge = g.__webtraySW;
  const SWR = g.ServiceWorkerRegistration;
  if (!bridge || !SWR || g.__webtraySWShim) return;
  g.__webtraySWShim = true;

  let seq = 0;
  const live = new Map<number, any>();
  const instance = 'sw-' + Math.random().toString(36).slice(2);
  const absolute = (u: unknown) => {
    if (!u) return '';
    try { return new URL(String(u), g.location.href).href; } catch { return ''; }
  };

  SWR.prototype.showNotification = function (title: string, options?: any) {
    options = options || {};
    const id = ++seq;
    const n: any = {
      title: String(title), body: options.body == null ? '' : String(options.body),
      tag: options.tag == null ? '' : String(options.tag), data: options.data === undefined ? null : options.data,
      icon: absolute(options.icon), image: absolute(options.image), badge: absolute(options.badge),
      actions: Array.isArray(options.actions) ? options.actions : [], requireInteraction: !!options.requireInteraction,
      silent: !!options.silent, renotify: !!options.renotify, timestamp: options.timestamp || Date.now(),
      dir: options.dir || 'auto', lang: options.lang || '', vibrate: [],
      close: () => { bridge.close(id); live.delete(id); },
    };
    if (n.tag) for (const [k, v] of live) if (v.tag === n.tag) live.delete(k);
    live.set(id, n);
    bridge.show({
      id, instance, title: n.title, body: n.body, icon: n.icon, tag: n.tag,
      silent: n.silent, requireInteraction: n.requireInteraction,
    });
    return Promise.resolve();
  };

  const WN = g.WorkerNavigator && g.WorkerNavigator.prototype;
  if (WN) {
    WN.setAppBadge = function (count?: number) {
      bridge.badge(count === undefined ? -1 : Math.max(0, Math.floor(Number(count) || 0)));
      return Promise.resolve();
    };
    WN.clearAppBadge = function () { bridge.badge(0); return Promise.resolve(); };
  }

  SWR.prototype.getNotifications = function (filter?: { tag?: string }) {
    const tag = filter && filter.tag;
    return Promise.resolve([...live.values()].filter((n) => !tag || n.tag === tag));
  };

  bridge.onEvent((id: number, type: string) => {
    const n = live.get(id);
    if (!n) return;
    if (type === 'click' || type === 'close') {
      const ev: any = new g.ExtendableEvent(type === 'click' ? 'notificationclick' : 'notificationclose');
      Object.defineProperty(ev, 'notification', { value: n });
      Object.defineProperty(ev, 'action', { value: '' });
      // waitUntil() throws on synthetic events; the work it wraps still runs.
      Object.defineProperty(ev, 'waitUntil', { value: (p: unknown) => { void Promise.resolve(p).catch(() => {}); } });
      g.dispatchEvent(ev);
      if (type === 'close') live.delete(id);
    }
  });
}

try {
  (contextBridge as any).executeInMainWorld({ func: installSwShim });
} catch (e) {
  console.warn('[webtray] service worker notification shim unavailable', e);
}
