/**
 * Origin allow-list matching. Patterns look like origins and may use a
 * leading wildcard label: "https://*.office.com" matches office.com and every
 * subdomain. A port may be given ("https://pbx.local:8088").
 */
export class OriginMatcher {
  private rules: { scheme: string; host: string; wildcard: boolean; port: string }[];

  constructor(patterns: string[]) {
    this.rules = [];
    for (const raw of patterns) {
      const m = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?([^/:]+)(?::(\d+))?\/?$/i.exec(raw.trim());
      if (!m) {
        console.warn(`[webtray] ignoring invalid allowed_origins entry: ${raw}`);
        continue;
      }
      this.rules.push({
        scheme: m[1].toLowerCase(),
        wildcard: !!m[2],
        host: m[3].toLowerCase(),
        port: m[4] ?? '',
      });
    }
  }

  matches(url: string | URL | null | undefined): boolean {
    if (!url) return false;
    let u: URL;
    try { u = typeof url === 'string' ? new URL(url) : url; } catch { return false; }
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port;
    return this.rules.some((r) => {
      if (r.scheme !== scheme) return false;
      if (r.port !== port) return false;
      if (r.wildcard) return host === r.host || host.endsWith('.' + r.host);
      return host === r.host;
    });
  }
}

/** Schemes we are willing to hand to the desktop's default handler. */
export function isSafeExternal(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return !['file:', 'javascript:', 'data:', 'blob:', 'about:', 'chrome:', 'devtools:', 'view-source:'].includes(p);
  } catch {
    return false;
  }
}
