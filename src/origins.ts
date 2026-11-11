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
        console.warn(`[webroost] ignoring invalid allowed_origins entry: ${raw}`);
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

/**
 * Does this URL look like part of a sign-in flow (OAuth/OIDC, SAML, SSO, MFA)?
 * Such pages stay inside the app even when their origin isn't allowed, so
 * logins through company identity providers return to the app.
 */
export function looksLikeAuth(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|accounts\.google\.com|appleid\.apple\.com|okta\.com|oktapreview\.com|duosecurity\.com|auth0\.com|onelogin\.com|pingidentity\.com|pingone\.com|jumpcloud\.com|sso\.connectwise\.com|home\.connectwise\.com|login\.connectwise\.com|github\.com\/login)$/.test(host)) return true;
  if (/(^|[.-])(sso|login|signin|auth|idp|adfs|sts|identity|id|accounts?|oauth|oidc|saml|mfa|okta|keycloak)([.-]|$)/.test(host)) return true;
  const path = u.pathname.toLowerCase();
  if (/\/(oauth2?|oidc|openid|openid-connect|saml2?|sso|adfs|authorize|auth|login|signin|sign-in|logon|mfa|2fa|callback|consent|connect\/authorize|protocol\/openid-connect)(\/|$|\.)/.test(path)) return true;
  const q = u.searchParams;
  return ['client_id', 'redirect_uri', 'response_type', 'samlrequest', 'samlresponse', 'relaystate', 'wa', 'wtrealm', 'code_challenge']
    .some((k) => [...q.keys()].some((x) => x.toLowerCase() === k));
}
