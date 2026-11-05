import { net } from 'electron';

export interface SiteInfo {
  url: string;
  finalUrl: string;
  id: string;
  name: string;
  allowed_origins: string[];
  icon: string | null;   // data: URL in whatever format the site serves
  hasManifest: boolean;
  themeColor: string | null;
  notes: string[];
}

/** Extra origins that well-known apps need for sign-in to stay in-app. */
const PRESETS: { match: RegExp; origins: string[]; name?: string; note?: string }[] = [
  {
    match: /(^|\.)(outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com|outlook\.cloud\.microsoft)$/,
    name: 'Outlook',
    origins: [
      'https://outlook.office.com', 'https://outlook.office365.com', 'https://outlook.cloud.microsoft',
      'https://*.office.com', 'https://login.microsoftonline.com', 'https://login.microsoft.com',
      'https://login.live.com', 'https://account.live.com',
    ],
    note: 'Added Microsoft 365 sign-in origins. Add your ADFS / IdP origin if your organisation uses one.',
  },
  {
    match: /(^|\.)teams\.(microsoft|live)\.com$/,
    name: 'Teams',
    origins: ['https://teams.microsoft.com', 'https://teams.live.com', 'https://*.teams.microsoft.com', 'https://login.microsoftonline.com', 'https://login.live.com'],
  },
  {
    match: /(^|\.)claude\.ai$/,
    name: 'Claude',
    origins: ['https://claude.ai', 'https://*.claude.ai', 'https://accounts.google.com', 'https://appleid.apple.com'],
    note: 'Added Google / Apple sign-in origins.',
  },
  {
    match: /(^|\.)google\.com$/,
    origins: ['https://*.google.com', 'https://accounts.google.com'],
  },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function fetchWithTimeout(url: string, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await net.fetch(url, { signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

async function fetchIcon(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, 6000);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0] || 'image/png';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

interface IconCandidate { url: string; size: number; score: number }

function sizeOf(sizes: string | null | undefined): number {
  if (!sizes) return 0;
  if (sizes === 'any') return 1024;
  return Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s.split('x')[0], 10) || 0));
}

export async function inspectSite(input: string): Promise<SiteInfo> {
  let url = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url);
  const notes: string[] = [];
  const info: SiteInfo = {
    url, finalUrl: url, id: slug(parsed.hostname.replace(/^www\./, '').split('.')[0]),
    name: parsed.hostname.replace(/^www\./, ''), allowed_origins: [parsed.origin], icon: null,
    hasManifest: false, themeColor: null, notes,
  };

  let html = '';
  try {
    const res = await fetchWithTimeout(url);
    info.finalUrl = res.url || url;
    html = (await res.text()).slice(0, 400_000);
  } catch (e: any) {
    notes.push(`Could not load the page (${e?.message ?? e}). You can still save it; the icon will be taken from the site on first run.`);
  }

  const final = new URL(info.finalUrl);
  const origins = new Set([parsed.origin, final.origin]);
  if (final.origin !== parsed.origin) notes.push(`The site redirected to ${final.origin} (probably a sign-in page); it was added to the allowed origins.`);

  const icons: IconCandidate[] = [];
  const sameSite = final.origin === parsed.origin;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const appName = /<meta[^>]+name=["']application-name["'][^>]*>/i.exec(html)?.[0];
  if (!sameSite) { /* a sign-in page's title is not the app's name */ }
  else if (appName && attr(appName, 'content')) info.name = decodeEntities(attr(appName, 'content')!);
  else if (title && decodeEntities(title)) info.name = decodeEntities(title).split(/\s[|\-–—]\s/)[0];
  const theme = /<meta[^>]+name=["']theme-color["'][^>]*>/i.exec(html)?.[0];
  if (theme) info.themeColor = attr(theme, 'content');

  for (const tag of sameSite ? html.match(/<link\b[^>]*>/gi) ?? [] : []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    const abs = new URL(decodeEntities(href), info.finalUrl).href;
    if (rel.split(/\s+/).includes('manifest')) {
      try {
        const res = await fetchWithTimeout(abs);
        const m = await res.json();
        info.hasManifest = true;
        const name = m.short_name || m.name;
        if (name) info.name = String(name);
        if (m.theme_color) info.themeColor = m.theme_color;
        if (m.start_url) {
          const start = new URL(m.start_url, abs);
          if (start.origin === final.origin || start.origin === parsed.origin) info.url = start.href;
        }
        for (const ic of m.icons ?? []) {
          if (!ic?.src) continue;
          const purpose = String(ic.purpose || 'any');
          icons.push({
            url: new URL(ic.src, abs).href,
            size: sizeOf(ic.sizes),
            score: (purpose.includes('any') ? 2 : 0) + (String(ic.type || '').includes('png') ? 1 : 0),
          });
        }
        notes.push('Found a web app manifest: name, start URL and icon were taken from it.');
      } catch { /* ignore bad manifests */ }
    } else if (rel.includes('icon')) {
      const size = sizeOf(attr(tag, 'sizes')) || (rel.includes('apple-touch') ? 180 : 32);
      icons.push({ url: abs, size, score: href.endsWith('.svg') ? 1 : 0 });
    }
  }
  icons.push({ url: new URL('/favicon.ico', parsed.origin).href, size: 16, score: -1 });

  icons.sort((a, b) => (b.size >= 128 ? 1000 : b.size) - (a.size >= 128 ? 1000 : a.size) || b.score - a.score || b.size - a.size);
  for (const c of icons) {
    info.icon = await fetchIcon(c.url);
    if (info.icon) break;
  }

  for (const p of PRESETS) {
    if (p.match.test(parsed.hostname) || p.match.test(final.hostname)) {
      p.origins.forEach((o) => origins.add(o));
      if (p.name) info.name = p.name;
      if (p.note) notes.push(p.note);
    }
  }
  info.allowed_origins = [...origins];
  info.id = slug(info.name.split(/\s+/)[0] || info.id);
  return info;
}
