/*
 * Click-to-call: tel:, callto: and sip: links.
 *
 * An app with `handle_schemes` registers its desktop entry for those link
 * types (and can be made the system default). When a link arrives, the
 * number is typed into the web softphone's dialpad and the call button is
 * pressed, which is what Yeastar's own Linkus browser extension does. The
 * dialpad is found automatically, or from selectors the user taught it with
 * the right-click menu (dial_input / dial_button / dial_open).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_HOME } from './paths';

export const CALL_SCHEMES = ['tel', 'callto', 'sip', 'sips'];

/** First tel:/callto:/sip: link in an argument list. */
export function findCallLink(argv: string[], schemes = CALL_SCHEMES): string | null {
  const re = new RegExp(`^(${schemes.map((s) => s.replace(/[^a-z0-9+.-]/gi, '')).join('|')}):`, 'i');
  return argv.find((a) => re.test(a)) ?? null;
}

/**
 * "callto:+12059797522", "tel:+1-205-979-7522;ext=102", "sip:102@pbx.example.com",
 * "callto://+1205…" -> "+12059797522" / "102". Keeps digits, a leading +, * and #.
 */
export function numberFromLink(link: string): string {
  let rest = link.replace(/^[a-z][a-z0-9+.-]*:/i, '');
  try { rest = decodeURIComponent(rest); } catch { /* keep as is */ }
  rest = rest.replace(/^\/\//, '').split(/[;?]/)[0];
  if (/^sips?:/i.test(link)) rest = rest.split('@')[0];
  const plus = rest.trim().startsWith('+');
  const digits = rest.replace(/[^0-9*#]/g, '');
  return (plus ? '+' : '') + digits;
}

export interface DialSelectors { input?: string; button?: string; open?: string; dry?: boolean }

/**
 * Runs inside the softphone page. Finds the dialpad number field, types the
 * number and clicks the call button. Returns 'clicked', 'no-button' (caller
 * sends a real Enter key) or 'no-input'.
 */
export function dialScript(num: string, sel: DialSelectors): string {
  return `(${async function (num: string, sel: DialSelectors) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const visible = (e: Element | null) => {
      if (!e) return false;
      const r = (e as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const q = (s?: string) => { try { return s ? document.querySelector(s) : null; } catch { return null; } };
    const label = (e: Element) => {
      const cls = typeof (e as any).className === 'string' ? (e as any).className : ((e as any).className?.baseVal || '');
      const text = (e.textContent || '').trim();
      return [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder'),
        (e as any).name, e.id, cls, text.length < 30 ? text : ''].filter(Boolean).join(' ').toLowerCase();
    };
    const findInput = () => (q(sel.input) as HTMLInputElement | null)
      || ([...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=password])')] as HTMLInputElement[])
        .filter(visible).find((e) => e.type === 'tel' || /dial|number|phone|keypad|call/.test(label(e))) || null;
    const findButton = () => (q(sel.button) as HTMLElement | null)
      || ([...document.querySelectorAll('button, [role=button], a, [class*=call], [class*=dial]')] as HTMLElement[])
        .filter(visible)
        .filter((e) => !/video|hang|end-?call|record|transfer|history|recent|log|contact|forward|voicemail|conference|setting/.test(label(e)))
        .find((e) => /(^|[\s_-])(call|dial|audio-?call|make-?call|call-?out|outbound)([\s_-]|$)/.test(label(e))) || null;

    if (!findInput() && sel.open) { const o = q(sel.open) as HTMLElement | null; if (o) { o.click(); await sleep(500); } }
    let input: HTMLInputElement | null = null;
    for (let i = 0; i < 40 && !(input = findInput()); i++) await sleep(500); // page may still be loading
    if (!input) return 'no-input';
    input.focus();
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, num);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(350);
    const btn = findButton();
    if (sel.dry) {
      if (btn) { const o = btn.style.outline; btn.style.outline = '3px solid #e5394d'; setTimeout(() => { btn.style.outline = o; }, 4000); }
      return btn ? 'dry-button' : 'dry-no-button';
    }
    if (btn) {
      // Report where the button is: the app clicks it with a real mouse event,
      // which every framework accepts (a scripted click() isn't always enough).
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(50);
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return `button:${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
      btn.click();
      return 'clicked';
    }
    input.focus();
    return 'no-button';
  }})(${JSON.stringify(num)}, ${JSON.stringify(sel)})`;
}

/** Runs in the page: a stable CSS selector for the element at (x, y). */
export function selectorScript(x: number, y: number, kind: 'input' | 'button' | 'open'): string {
  return `(${function (x: number, y: number, kind: string) {
    let e = document.elementFromPoint(x, y) as Element | null;
    if (!e) return null;
    if (kind === 'input') e = e.closest('input, textarea') || e.querySelector?.('input') || e;
    else e = e.closest('button, [role=button], a, [class*=call], [class*=dial], [class*=tab], li') || e;
    const esc = (s: string) => (window as any).CSS?.escape ? (window as any).CSS.escape(s) : s.replace(/"/g, '\\"');
    const unique = (s: string) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const tag = e.tagName.toLowerCase();
    if (e.id && !/\d{3,}/.test(e.id) && unique('#' + esc(e.id))) return '#' + esc(e.id);
    for (const a of ['name', 'aria-label', 'placeholder', 'title', 'data-testid', 'data-test', 'data-id']) {
      const v = e.getAttribute(a);
      if (v) { const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`; if (unique(s)) return s; }
    }
    const parts: string[] = [];
    let cur: Element | null = e;
    while (cur && cur !== document.body && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/\d{3,}/.test(cur.id)) { parts.unshift('#' + esc(cur.id)); break; }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }})(${Math.round(x)}, ${Math.round(y)}, ${JSON.stringify(kind)})`;
}

// ------------------------------------------------- default handler (mimeapps)

const MIMEAPPS = () => path.join(CONFIG_HOME, 'mimeapps.list');

/**
 * Files that decide default apps: mimeapps.list, plus desktop-specific ones
 * such as kde-mimeapps.list that take priority over it (only if present).
 */
function mimeappsFiles(): string[] {
  const files = [MIMEAPPS()];
  for (const d of (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':').filter(Boolean)) {
    const f = path.join(CONFIG_HOME, `${d}-mimeapps.list`);
    if (/^[a-z0-9_-]+$/.test(d) && fs.existsSync(f) && !files.includes(f)) files.unshift(f);
  }
  return files;
}

function editMimeapps(edit: (sections: Map<string, Map<string, string>>) => void, file = MIMEAPPS()) {
  const sections = new Map<string, Map<string, string>>();
  const order: string[] = [];
  let cur = '';
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const h = /^\s*\[(.+)\]\s*$/.exec(line);
      if (h) { cur = h[1]; if (!sections.has(cur)) { sections.set(cur, new Map()); order.push(cur); } continue; }
      const kv = /^([^#=][^=]*)=(.*)$/.exec(line);
      if (kv && cur) sections.get(cur)!.set(kv[1].trim(), kv[2].trim());
    }
  } catch { /* no file yet */ }
  edit(sections);
  for (const k of sections.keys()) if (!order.includes(k)) order.push(k);
  const out = order.filter((k) => sections.get(k)!.size)
    .map((k) => `[${k}]\n` + [...sections.get(k)!].map(([a, b]) => `${a}=${b}`).join('\n')).join('\n\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', out);
    fs.renameSync(file + '.tmp', file);
  } catch {
    // Inside Flatpak only the file itself is shared (no temp file or rename
    // next to it): write it in place.
    try { fs.rmSync(file + '.tmp', { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(file, out);
  }
}

/** Make `desktopFileName` the default app for the given link schemes. */
export function setDefaultCallHandler(desktopFileName: string, schemes: string[]) {
  for (const file of mimeappsFiles()) editMimeapps((sec) => {
    const def = sec.get('Default Applications') ?? new Map<string, string>();
    const added = sec.get('Added Associations') ?? new Map<string, string>();
    for (const s of schemes) {
      const mime = `x-scheme-handler/${s}`;
      def.set(mime, `${desktopFileName};`);
      const list = (added.get(mime) || '').split(';').filter((x) => x && x !== desktopFileName);
      added.set(mime, [desktopFileName, ...list].join(';') + ';');
    }
    sec.set('Default Applications', def);
    sec.set('Added Associations', added);
  }, file);
}

/** Remove `desktopFileName` from every link-scheme association. */
export function clearCallHandler(desktopFileName: string) {
  try {
    for (const file of mimeappsFiles()) {
    if (!fs.existsSync(file)) continue;
    editMimeapps((sec) => {
      for (const m of sec.values()) {
        for (const [k, v] of [...m]) {
          if (!k.startsWith('x-scheme-handler/')) continue;
          const list = v.split(';').filter((x) => x && x !== desktopFileName);
          if (list.length) m.set(k, list.join(';') + ';'); else m.delete(k);
        }
      }
    }, file);
    }
  } catch { /* best effort */ }
}
