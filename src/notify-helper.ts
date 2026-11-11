/*
 * Notification helper, run as plain Node (ELECTRON_RUN_AS_NODE) in its own
 * Flatpak sandbox started through the Flatpak portal (see popups.ts).
 *
 * KDE Plasma does not pop up notifications sent by the app process (or its
 * children) while it accepts the very same notification from a process the
 * portal started, so WebRoost sends its popups from here. Talks JSON lines on
 * stdin/stdout:
 *   in:  {op:"show", key, appName, icon, title, body, desktopEntry, urgent}
 *        {op:"close", key}
 *   out: {ev:"ready"} {ev:"shown", key} {ev:"failed", key, error}
 *        {ev:"click", key} {ev:"closed", key}
 */
import * as readline from 'readline';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbus = require('dbus-next');

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

async function main() {
  const bus = dbus.sessionBus();
  const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
  const n = obj.getInterface('org.freedesktop.Notifications');
  const keyById = new Map<number, string>();
  const idByKey = new Map<string, number>();

  n.on('ActionInvoked', (id: number, action: string) => {
    const key = keyById.get(id);
    if (key && action === 'default') out({ ev: 'click', key });
  });
  n.on('NotificationClosed', (id: number) => {
    const key = keyById.get(id);
    if (!key) return;
    keyById.delete(id); idByKey.delete(key);
    out({ ev: 'closed', key });
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.op === 'show') {
      try {
        const hints: Record<string, unknown> = { urgency: new dbus.Variant('y', m.urgent ? 2 : 1) };
        if (m.desktopEntry) hints['desktop-entry'] = new dbus.Variant('s', String(m.desktopEntry));
        const id: number = await n.Notify(String(m.appName || 'WebRoost'), 0, String(m.icon || ''),
          String(m.title || ' '), String(m.body || ''), ['default', 'Open'], hints, m.urgent ? 0 : -1);
        keyById.set(id, m.key); idByKey.set(m.key, id);
        out({ ev: 'shown', key: m.key });
      } catch (e: any) {
        out({ ev: 'failed', key: m.key, error: String(e?.message ?? e) });
      }
    } else if (m.op === 'close') {
      const id = idByKey.get(m.key);
      if (id !== undefined) { try { await n.CloseNotification(id); } catch { /* already gone */ } }
    }
  });
  // The app went away: so do we.
  rl.on('close', () => process.exit(0));
  out({ ev: 'ready' });
}

main().catch((e) => { out({ ev: 'fatal', error: String(e?.message ?? e) }); process.exit(1); });
