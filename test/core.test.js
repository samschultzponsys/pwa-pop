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

test('release version comparison (MAJOR.MINOR, .9 rolls over)', () => {
  const { isNewer, parseVersion } = require('../dist/updater');
  assert.deepStrictEqual(parseVersion('v1.2'), [1, 2]);
  assert.deepStrictEqual(parseVersion('1.2.0'), [1, 2]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.ok(isNewer('v1.2', '1.1'));
  assert.ok(isNewer('v2.0', '1.9'));
  assert.ok(isNewer('v1.10', '1.9'));
  assert.ok(!isNewer('v1.1', '1.1'));
  assert.ok(!isNewer('v1.0', '1.1'));
  assert.ok(!isNewer('garbage', '1.1'));
});

test('icon recolouring and transparency detection', () => {
  const { recolor, dominantHue, hasTransparency, drawChip } = require('../dist/iconstyle');
  const W = 16;
  const bm = { data: Buffer.alloc(W * W * 4), width: W, height: W };
  // Opaque orange square (BGRA) with a transparent border.
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
    const i = (y * W + x) * 4;
    bm.data[i] = 20; bm.data[i + 1] = 110; bm.data[i + 2] = 230; bm.data[i + 3] = 255;
  }
  assert.ok(hasTransparency(bm));
  const before = dominantHue(bm);
  assert.ok(before >= 15 && before <= 35, `orange hue, got ${before}`);
  recolor(bm, 215);
  const after = dominantHue(bm);
  assert.ok(after >= 205 && after <= 225, `blue after recolour, got ${after}`);
  assert.strictEqual(bm.data[3], 0, 'transparent pixels stay transparent');
  drawChip(bm, '2', [37, 99, 235]);
  const full = { data: Buffer.alloc(W * W * 4, 255), width: W, height: W };
  assert.ok(!hasTransparency(full));
});
