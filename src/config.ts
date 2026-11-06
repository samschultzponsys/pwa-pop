import * as fs from 'fs';
import * as path from 'path';
import YAML, { isMap, isScalar, isSeq, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, ensureDir, expandHome, ICON_DIR } from './paths';

export interface HidFilter {
  vendorId: number;
  productId?: number;
}

/** One entry of ~/.config/webtray/apps.yaml, exactly as the user writes it. */
export interface AppConfig {
  id: string;
  name: string;
  url: string;
  icon?: string;
  start_hidden?: boolean;
  autostart?: boolean;
  allowed_origins?: string[];
  hid_devices?: HidFilter[];
  /** Extra Chromium permission names to auto-grant on allowed origins. */
  extra_permissions?: string[];
  /** Use critical urgency (stays on screen) for this app's notifications. */
  urgent_notifications?: boolean;
  /**
   * Show a notification whenever the unread count goes up (from the page's
   * app badge or title). For sites whose own notifications depend on web push,
   * which only Chrome has, such as the new Outlook.
   */
  notify_on_unread?: boolean;
  /** Show the window whenever the page raises a notification (e.g. incoming call). */
  raise_on_notification?: boolean;
  /** Regex with one capture group for the unread count. Default: \((\d+)\) */
  badge_regex?: string;
  user_agent?: string;
  /** Accept self-signed TLS certs on allowed origins (on-prem PBX etc.). */
  ignore_certificate_errors?: boolean;
  /** Reload the page after the machine resumes from suspend. */
  reload_on_resume?: boolean;
  width?: number;
  height?: number;
  /** Recolour the icon (duplicate apps): blue, green, purple, orange, teal, pink, red, yellow. */
  icon_color?: string;
  /** 1–2 characters shown in a coloured chip on the icon's top-left corner. */
  icon_label?: string;
  /** The icon was picked automatically: replace it with the site's own icon once signed in. */
  icon_auto?: boolean;
  /**
   * Memory limit in MB for this app (all its processes together). Over the
   * limit the page is reloaded, then the app is restarted if that was not
   * enough. Never while audio is playing (calls) or while you are using it.
   */
  memory_limit_mb?: number;
  /**
   * Open these link types in this app (click-to-call): e.g. [tel, callto, sip].
   * The app is registered as their handler and set as the default.
   */
  handle_schemes?: string[];
  /**
   * Send every keyboard shortcut to the page instead of handling Ctrl+W/R,
   * F5, F12, Alt+arrows and zoom in PWA Pop (remote desktop tools such as
   * MeshCentral, web terminals).
   */
  pass_shortcuts?: boolean;
  /** The minimize button hides the app to its tray icon instead of the taskbar. */
  minimize_to_tray?: boolean;
  /** CSS selectors for click-to-call, taught via the right-click menu. */
  dial_input?: string;
  dial_button?: string;
  dial_open?: string;
}

/** AppConfig with defaults filled in. */
export interface ResolvedApp extends AppConfig {
  allowed_origins: string[];
  hid_devices: HidFilter[];
  start_hidden: boolean;
  autostart: boolean;
  iconPath: string | null;
}

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const DEFAULT_CONFIG = `# PWA Pop / webtray configuration.
# Each entry becomes its own tray-resident desktop app: run it with
#   webtray --app <id>
# and add it to your menu with
#   webtray --install <id>
# See https://github.com/samschultzponsys/pwa-pop for every option.

- id: claude
  name: Claude
  url: https://claude.ai
  allowed_origins: ["https://claude.ai", "https://*.claude.ai", "https://accounts.google.com"]
`;

export function ensureConfigFile(): void {
  ensureDir(CONFIG_DIR);
  ensureDir(ICON_DIR);
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, DEFAULT_CONFIG);
}

function readDoc(): YAML.Document {
  ensureConfigFile();
  const text = fs.readFileSync(CONFIG_FILE, 'utf8');
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    throw new Error(`Invalid YAML in ${CONFIG_FILE}: ${doc.errors[0].message}`);
  }
  if (doc.contents == null) doc.contents = new YAMLSeq() as any;
  if (!isSeq(doc.contents)) {
    // Also accept `apps: [...]` at the top level.
    const apps = isMap(doc.contents) ? (doc.contents as YAMLMap).get('apps', true) : null;
    if (!isSeq(apps)) throw new Error(`${CONFIG_FILE} must be a YAML list of apps`);
  }
  return doc;
}

function appsSeq(doc: YAML.Document): YAMLSeq {
  if (isSeq(doc.contents)) return doc.contents as YAMLSeq;
  return (doc.contents as YAMLMap).get('apps', true) as unknown as YAMLSeq;
}

function validate(raw: any, index: number): AppConfig {
  const where = `app #${index + 1}`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: expected a mapping`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    throw new Error(`${where}: "id" must be lowercase letters, digits, - or _ (got ${JSON.stringify(raw.id)})`);
  }
  if (typeof raw.url !== 'string') throw new Error(`${raw.id}: "url" is required`);
  try { new URL(raw.url); } catch { throw new Error(`${raw.id}: "url" is not a valid URL`); }
  if (raw.hid_devices != null && !Array.isArray(raw.hid_devices)) throw new Error(`${raw.id}: hid_devices must be a list`);
  for (const d of raw.hid_devices ?? []) {
    if (typeof d?.vendorId !== 'number') throw new Error(`${raw.id}: every hid_devices entry needs a numeric vendorId`);
  }
  if (raw.allowed_origins != null && !Array.isArray(raw.allowed_origins)) throw new Error(`${raw.id}: allowed_origins must be a list`);
  return { ...raw, name: typeof raw.name === 'string' ? raw.name : raw.id } as AppConfig;
}

export function loadApps(): AppConfig[] {
  const doc = readDoc();
  const list = (appsSeq(doc).toJSON() as any[]) ?? [];
  const apps = list.map(validate);
  const seen = new Set<string>();
  for (const a of apps) {
    if (seen.has(a.id)) throw new Error(`Duplicate app id "${a.id}" in ${CONFIG_FILE}`);
    seen.add(a.id);
  }
  return apps;
}

export function resolveIconPath(app: AppConfig): string | null {
  const candidates = [app.icon ? expandHome(app.icon) : null, path.join(ICON_DIR, `${app.id}.png`)];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

export function resolveApp(app: AppConfig): ResolvedApp {
  const origin = new URL(app.url).origin;
  const allowed = app.allowed_origins && app.allowed_origins.length ? [...app.allowed_origins] : [origin];
  if (!allowed.some((o) => o === origin)) allowed.unshift(origin);
  return {
    ...app,
    allowed_origins: allowed,
    hid_devices: app.hid_devices ?? [],
    start_hidden: !!app.start_hidden,
    autostart: !!app.autostart,
    iconPath: resolveIconPath(app),
  };
}

export function getApp(id: string): ResolvedApp {
  const app = loadApps().find((a) => a.id === id);
  if (!app) throw new Error(`No app with id "${id}" in ${CONFIG_FILE}. Run "webtray --list".`);
  return resolveApp(app);
}

/** Make HID ids print as 0x6993 rather than 26003 when we write the file. */
function hexifyHid(node: unknown): void {
  if (!isMap(node)) return;
  const hid = node.get('hid_devices', true);
  if (!isSeq(hid)) return;
  for (const item of hid.items) {
    if (!isMap(item)) continue;
    for (const key of ['vendorId', 'productId']) {
      const v = item.get(key, true);
      if (isScalar(v) && typeof v.value === 'number') {
        (v as Scalar).format = 'HEX';
      }
    }
  }
}

function clean(app: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(app)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === false && k !== 'autostart' && k !== 'start_hidden') continue;
    out[k] = v;
  }
  return out;
}

/** Insert or replace an app, preserving comments elsewhere in the file. */
export function upsertApp(app: AppConfig): void {
  validate(app, 0);
  const doc = readDoc();
  const seq = appsSeq(doc);
  const node = doc.createNode(clean(app));
  hexifyHid(node);
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? pair.key.value : null;
      if (k === 'allowed_origins' && isSeq(pair.value)) pair.value.flow = true;
      if (k === 'hid_devices' && isSeq(pair.value)) for (const it of pair.value.items) if (isMap(it)) it.flow = true;
    }
  }
  const idx = seq.items.findIndex((it) => isMap(it) && it.get('id') === app.id);
  if (idx >= 0) {
    const old = seq.items[idx] as any;
    (node as any).commentBefore = old?.commentBefore;
    seq.items[idx] = node as any;
  } else {
    seq.items.push(node as any);
  }
  writeDoc(doc);
}

export function removeApp(id: string): boolean {
  const doc = readDoc();
  const seq = appsSeq(doc);
  const idx = seq.items.findIndex((it) => isMap(it) && it.get('id') === id);
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  writeDoc(doc);
  return true;
}

function writeDoc(doc: YAML.Document): void {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, doc.toString({ lineWidth: 0 }));
  fs.renameSync(tmp, CONFIG_FILE);
}
