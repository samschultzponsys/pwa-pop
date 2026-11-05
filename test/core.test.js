// Unit tests for the pure parts of webtray. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtray-test-'));
process.env.XDG_CONFIG_HOME = tmp;
process.env.XDG_DATA_HOME = path.join(tmp, 'data');

const { OriginMatcher, isSafeExternal } = require('../dist/origins');
const { parseUnread } = require('../dist/badge');
const config = require('../dist/config');

test('origin matching', () => {
  const m = new OriginMatcher(['https://outlook.office.com', 'https://*.microsoftonline.com', 'https://pbx.local:8088']);
  assert.ok(m.matches('https://outlook.office.com/mail/inbox'));
  assert.ok(m.matches('https://login.microsoftonline.com/common/oauth2'));
  assert.ok(m.matches('https://microsoftonline.com/'));
  assert.ok(m.matches('https://pbx.local:8088/login'));
  assert.ok(!m.matches('https://pbx.local/login'));
  assert.ok(!m.matches('http://outlook.office.com/'));
  assert.ok(!m.matches('https://evil-outlook.office.com.attacker.net/'));
  assert.ok(!m.matches('https://notmicrosoftonline.com/'));
  assert.ok(!m.matches('not a url'));
});

test('external url safety', () => {
  assert.ok(isSafeExternal('https://example.com'));
  assert.ok(isSafeExternal('mailto:a@b.c'));
  assert.ok(!isSafeExternal('file:///etc/passwd'));
  assert.ok(!isSafeExternal('javascript:alert(1)'));
});

test('unread parsing', () => {
  assert.strictEqual(parseUnread('(3) Inbox - Outlook'), 3);
  assert.strictEqual(parseUnread('Inbox (12) — Mail'), 12);
  assert.strictEqual(parseUnread('Claude'), 0);
  assert.strictEqual(parseUnread('Inbox - 5 unread', '(\\d+) unread'), 5);
});

test('config round trip keeps comments and hex ids', () => {
  config.ensureConfigFile();
  const file = path.join(tmp, 'webtray', 'apps.yaml');
  fs.writeFileSync(file, `# my comment\n- id: linkus\n  name: Linkus\n  url: https://pbx.example.com/\n  hid_devices: [{ vendorId: 0x6993 }]\n`);
  assert.strictEqual(config.loadApps()[0].hid_devices[0].vendorId, 0x6993);
  config.upsertApp({ id: 'claude', name: 'Claude', url: 'https://claude.ai', hid_devices: [{ vendorId: 0x0b0e, productId: 0x24 }] });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# my comment/);
  assert.match(text, /vendorId: 0x6993/);
  assert.match(text, /vendorId: 0xb0e/);
  const apps = config.loadApps();
  assert.deepStrictEqual(apps.map((a) => a.id), ['linkus', 'claude']);
  const r = config.resolveApp(apps[0]);
  assert.deepStrictEqual(r.allowed_origins, ['https://pbx.example.com']);
  assert.ok(config.removeApp('claude'));
  assert.deepStrictEqual(config.loadApps().map((a) => a.id), ['linkus']);
});

test('config validation', () => {
  const file = path.join(tmp, 'webtray', 'apps.yaml');
  fs.writeFileSync(file, `- id: Bad Id\n  url: https://x.com\n`);
  assert.throws(() => config.loadApps(), /id/);
  fs.writeFileSync(file, `- id: a\n  url: nope\n`);
  assert.throws(() => config.loadApps(), /url/);
});
