/* WebRoost manager UI — plain JS, talks to the main process via window.webroost. */
'use strict';

const api = window.webroost;
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

const HID_VENDORS = {
  0x6993: 'Yealink', 0x0b0e: 'Jabra', 0x047f: 'Poly / Plantronics', 0x1395: 'EPOS / Sennheiser',
  0x046d: 'Logitech', 0x2c7c: 'Yealink', 0x1d6b: 'Linux Foundation', 0x0d8c: 'C-Media', 0x08bb: 'TI',
};
const hex = (n) => '0x' + n.toString(16).padStart(4, '0');

let editing = null;      // original config when editing, null when adding
let iconDirty = false;   // canvas holds an icon that should be saved
let hidDevices = [];     // [{vendorId, productId?}]

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}

// ------------------------------------------------------------------ list
let apps = [];           // last list from the main process

async function refresh() {
  apps = await api.list();
  const list = $('#list');
  list.replaceChildren();
  $('#empty').classList.toggle('hidden', apps.length > 0);
  for (const a of apps) list.append(card(a));
}

/** "A", "A and B", "A, B and C". */
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

function card({ config: c, icon, baseIcon, installed, running, memoryMb }) {
  const toggle = (label, key) => el('label', { class: 'check' },
    el('input', {
      type: 'checkbox', checked: !!c[key],
      onchange: (e) => guard(async () => {
        await api.save({ ...c, [key]: e.target.checked }, null, c.id);
        toast(`${c.name}: ${label.toLowerCase()} ${e.target.checked ? 'on' : 'off'}`);
        refresh();
      }),
    }), label);

  return el('article', { class: 'card' },
    el('div', { class: 'head' },
      el('img', { src: icon || '../assets/icon.svg', alt: '' }),
      el('div', { class: 'grow' }, el('h3', {}, c.name), el('div', { class: 'url' }, c.url)),
    ),
    el('div', { class: 'badges' },
      el('span', { class: 'badge' }, c.id),
      el('span', { class: 'badge' + (running ? ' on' : '') }, running ? 'running' : 'not running'),
      memoryMb != null ? el('button', {
        class: 'badge' + (c.memory_limit_mb && memoryMb > c.memory_limit_mb * 0.9 ? ' warn' : ''),
        type: 'button', title: 'Memory used by this app (all its processes). Click for details.',
        onclick: () => openMemory(),
      }, `RAM ${fmtMb(memoryMb)}${c.memory_limit_mb ? ` / ${fmtMb(c.memory_limit_mb)}` : ''}`) : null,
      installed.menu ? el('span', { class: 'badge on' }, 'in menu') : null,
      installed.autostart ? el('span', { class: 'badge on' }, 'autostart') : null,
      (c.hid_devices || []).length ? el('span', { class: 'badge on' }, 'headset') : null,
      (c.handle_schemes || []).length ? el('span', { class: 'badge on', title: 'Opens tel:, callto: and sip: links' }, 'phone app') : null,
    ),
    el('div', { class: 'toggles' }, toggle('Autostart', 'autostart'), toggle('Start hidden', 'start_hidden')),
    el('div', { class: 'buttons' },
      el('button', { class: 'primary', onclick: () => guard(async () => { await api.launch(c.id); toast(running ? `Showing ${c.name}` : `Starting ${c.name}…`); setTimeout(refresh, 2500); }) }, running ? 'Show' : 'Open'),
      running ? el('button', { title: 'Quit the app (it leaves the tray)', onclick: () => guard(async () => { await api.quit(c.id); toast(`Quitting ${c.name}…`); setTimeout(refresh, 1500); }) }, 'Quit') : null,
      el('button', { onclick: () => openEditor(c, baseIcon) }, 'Edit'),
      el('button', { title: 'Make a second copy with its own login', onclick: () => openDuplicate(c, baseIcon) }, 'Duplicate'),
      installed.menu
        ? el('button', { class: 'ghost', onclick: () => guard(async () => { await api.uninstall(c.id); refresh(); }) }, 'Remove from menu')
        : el('button', { class: 'ghost', onclick: () => guard(async () => { await api.install(c.id); toast('Added to the application menu'); refresh(); }) }, 'Add to menu'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost danger', onclick: () => guard(async () => { if (await api.remove(c.id)) refresh(); }) }, 'Delete'),
    ),
  );
}

// ------------------------------------------------------- unique names
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const idTaken = (id) => apps.some((a) => a.config.id === id);
const nameTaken = (n) => apps.some((a) => a.config.name.toLowerCase() === n.toLowerCase());

/** "claude" -> claude-2 / "Claude (2)", "Claude (2)" -> claude-3 / "Claude (3)"… */
function nextCopy(id, name) {
  const baseId = id.replace(/-\d+$/, '');
  const baseName = name.replace(/\s*\(\d+\)$/, '');
  for (let n = 2; n < 100; n++) {
    const cid = `${baseId}-${n}`.slice(0, 48);
    const cname = `${baseName} (${n})`;
    if (!idTaken(cid) && !nameTaken(cname)) return { id: cid, name: cname, n };
  }
  return { id: `${baseId}-${Date.now() % 10000}`, name: `${baseName} (copy)`, n: 0 };
}

/** First colour no other app on the same site already uses. */
function nextColor(url) {
  let host = '';
  try { host = new URL(url).host; } catch { /* ignore */ }
  const used = new Set(apps.filter((a) => { try { return new URL(a.config.url).host === host; } catch { return false; } })
    .map((a) => a.config.icon_color).filter(Boolean));
  return iconColors.find((c) => !used.has(c)) || iconColors[0];
}

/** Siblings on the same site (for automatic colour/label when adding a second copy). */
function sameSite(url) {
  try { const h = new URL(url).host; return apps.filter((a) => new URL(a.config.url).host === h); } catch { return []; }
}

// ----------------------------------------------------------------- icons
const canvas = $('#icon-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let iconColors = [];
let iconAuto = false;      // icon was chosen automatically (site may upgrade it later)
let bgBackup = null;       // canvas content before "Remove background"
let previewTimer = null;

function setIconAuto(v) { iconAuto = v; }

function letterIcon(name, seed) {
  let h = 0;
  for (const ch of seed || name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  ctx.clearRect(0, 0, 256, 256);
  const g = ctx.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0, `hsl(${hue} 70% 55%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 75% 45%)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 240, 56);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 140px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || '?').trim().charAt(0).toUpperCase(), 128, 140);
  iconDirty = true;
  bgBackup = null;
  updatePreview();
}

function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawIcon(src) {
  const img = await loadImg(src);
  if (!img) return false;
  ctx.clearRect(0, 0, 256, 256);
  const w = img.naturalWidth || 256, h = img.naturalHeight || 256;
  const s = Math.min(256 / w, 256 / h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (256 - w * s) / 2, (256 - h * s) / 2, w * s, h * s);
  iconDirty = true;
  bgBackup = null;
  updateBgButton();
  updatePreview();
  return true;
}

/** Size and transparency of an icon candidate. */
async function analyze(src) {
  const img = await loadImg(src);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) clear++;
  return { src, size: Math.min(img.naturalWidth || 0, img.naturalHeight || 0) || 64, clear: clear > 64 * 64 * 0.03 };
}

/** Prefer icons with a transparent background; among those, the biggest. */
function rank(list) {
  return list.filter(Boolean).sort((a, b) =>
    (b.clear && b.size >= 32) - (a.clear && a.size >= 32) || b.size - a.size);
}

function showChoices(list) {
  const box = $('#icon-choices');
  box.replaceChildren();
  if (list.length < 2) return;
  box.append(el('span', { class: 'muted' }, 'Other icons from the site:'));
  for (const c of list) {
    box.append(el('button', {
      type: 'button', class: 'choice', title: `${c.size}px${c.clear ? ', transparent' : ''}`,
      onclick: () => { setIconAuto(true); drawIcon(c.src).then(() => autoRemoveWhitePlate()); },
    }, el('img', { src: c.src, alt: '' })));
  }
}

/** Colour distance in RGB. */
const dist = (d, i, r, g, b) => Math.hypot(d[i] - r, d[i + 1] - g, d[i + 2] - b);

/**
 * Make the icon's background transparent: flood-fill from the edges through
 * pixels that match the most common edge colour (or are already transparent),
 * then trim and re-centre the logo.
 */
function removeBackground() {
  const W = 256;
  const imgData = ctx.getImageData(0, 0, W, W);
  const d = imgData.data;
  // The background colour: most common colour on the first mostly-opaque ring
  // (plates are often inset with transparent rounded corners).
  const bg = plateColor(d, W);
  if (!bg) return false;
  const [r, g, b] = bg;
  const TOL = 42, SOFT = 70;
  const seen = new Uint8Array(W * W);
  const stack = [];
  for (let i = 0; i < W; i++) stack.push(i, (W - 1) * W + i, i * W, i * W + W - 1);
  let changed = 0;
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    const a = d[i + 3];
    const dd = dist(d, i, r, g, b);
    if (a >= 24 && dd > SOFT) continue; // reached the logo
    if (a >= 24) {
      // Fully remove close matches, fade the anti-aliased rim.
      d[i + 3] = dd <= TOL ? 0 : Math.round(a * (dd - TOL) / (SOFT - TOL));
      changed++;
      if (dd > TOL) continue;
    }
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < W - 1) stack.push(p + W);
  }
  if (changed < W * 4) return false;
  ctx.putImageData(imgData, 0, 0);
  trimAndCenter();
  return true;
}

/** Ring of pixels `k` px in from the edge. */
function ring(W, k) {
  const pts = [];
  for (let i = k; i < W - k; i++) pts.push([i, k], [i, W - 1 - k], [k, i], [W - 1 - k, i]);
  return pts;
}

/** [r,g,b] of a solid background plate, or null when the edges are not a plate. */
function plateColor(d, W) {
  for (let k = 0; k < W * 0.2; k += 2) {
    const pts = ring(W, k);
    const counts = new Map();
    let opaque = 0;
    for (const [x, y] of pts) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 200) continue;
      opaque++;
      const key = `${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (opaque < pts.length * 0.5) continue;
    const [key, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < opaque * 0.6) return null; // edges are busy: no plate
    return key.split(',').map((v) => (Number(v) << 4) + 8);
  }
  return null;
}

/** Crop to the visible pixels and scale back up with a little padding. */
function trimAndCenter() {
  const W = 256;
  const d = ctx.getImageData(0, 0, W, W).data;
  let x0 = W, y0 = W, x1 = -1, y1 = -1;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  const s = Math.min((W * 0.9) / w, (W * 0.9) / h);
  ctx.clearRect(0, 0, W, W);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, (W - w * s) / 2, (W - h * s) / 2, w * s, h * s);
}

/** Many sites only offer a logo on an opaque white plate: remove it automatically. */
function autoRemoveWhitePlate() {
  const c = plateColor(ctx.getImageData(0, 0, 256, 256).data, 256);
  if (c && c.every((v) => v >= 232)) toggleBackground();
}

function toggleBackground() {
  if (bgBackup) {
    ctx.putImageData(bgBackup, 0, 0);
    bgBackup = null;
  } else {
    const backup = ctx.getImageData(0, 0, 256, 256);
    if (!removeBackground()) { toast('No solid background found to remove'); return; }
    bgBackup = backup;
  }
  iconDirty = true;
  updateBgButton();
  updatePreview();
}

function updateBgButton() {
  $('#btn-bg').textContent = bgBackup ? 'Restore background' : 'Remove background';
}

function styleFields() {
  return { icon_color: $('#f-color').value || undefined, icon_label: $('#f-label').value.trim().toUpperCase() || undefined };
}

/** Show the icon exactly as the tray/menu will (colour + label applied). */
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    $('#icon-preview').src = await api.styleIcon(canvas.toDataURL('image/png'), styleFields());
  }, 60);
}

// ---------------------------------------------------------------- editor
const dlg = $('#editor');

function originsFromText() {
  return $('#f-origins').value.split(/[\s,]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function renderHid() {
  const box = $('#hid-list');
  box.replaceChildren();
  if (!hidDevices.length) box.append(el('span', { class: 'muted' }, 'No devices configured.'));
  hidDevices.forEach((d, i) => box.append(el('div', { class: 'hid-item' },
    el('span', {}, HID_VENDORS[d.vendorId] || 'Vendor'),
    el('code', {}, `vendorId ${hex(d.vendorId)}${d.productId != null ? `  productId ${hex(d.productId)}` : ''}`),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'link', onclick: () => { hidDevices.splice(i, 1); renderHid(); } }, 'Remove'),
  )));
}

async function detectHid() {
  $('#hid-status').textContent = 'Scanning…';
  try { await navigator.hid.requestDevice({ filters: [] }); } catch { /* the chooser is cancelled on purpose */ }
  const list = await api.hidLast();
  const found = $('#hid-found');
  found.replaceChildren();
  const seen = new Set();
  const unique = list.filter((d) => { const k = `${d.vendorId}:${d.productId}`; if (seen.has(k)) return false; seen.add(k); return true; });
  $('#hid-status').textContent = unique.length ? `${unique.length} device(s) found` : 'No HID devices found. Is the headset plugged in (and the udev rule installed)?';
  for (const d of unique) {
    found.append(el('div', { class: 'hid-item' },
      el('span', {}, d.name || HID_VENDORS[d.vendorId] || 'HID device'),
      el('code', {}, `${hex(d.vendorId)}:${hex(d.productId)}`),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'link', onclick: () => { addHid({ vendorId: d.vendorId }); } }, 'Any from vendor'),
      el('button', { type: 'button', class: 'link', onclick: () => { addHid({ vendorId: d.vendorId, productId: d.productId }); } }, 'This model'),
    ));
  }
}

function addHid(f) {
  if (!hidDevices.some((d) => d.vendorId === f.vendorId && d.productId === f.productId)) hidDevices.push(f);
  renderHid();
}

function showNotes(notes) {
  const ul = $('#notes');
  ul.replaceChildren(...(notes || []).map((n) => el('li', {}, n)));
}

function setError(msg) {
  $('#error').textContent = msg || '';
  $('#error').classList.toggle('hidden', !msg);
}

let template = null;     // config whose extra options are kept on save (edit or duplicate source)

async function openEditor(cfg, iconUrl, mode = cfg ? 'edit' : 'add') {
  editing = mode === 'edit' ? cfg : null;
  template = cfg || null;
  iconDirty = false;
  bgBackup = null;
  setIconAuto(!!cfg?.icon_auto);
  setError('');
  showNotes([]);
  showChoices([]);
  $('#hid-found').replaceChildren();
  $('#hid-status').textContent = '';
  $('#editor-title').textContent = mode === 'edit' ? `Edit ${cfg.name}` : mode === 'duplicate' ? 'Duplicate app' : 'Add app';
  $('#dup-note').classList.toggle('hidden', mode !== 'duplicate');
  $('#f-url').value = cfg?.url || '';
  $('#f-name').value = cfg?.name || '';
  $('#f-id').value = cfg?.id || '';
  $('#f-id').dataset.touched = cfg ? '1' : '';
  $('#f-autostart').checked = !!cfg?.autostart;
  $('#f-hidden').checked = !!cfg?.start_hidden;
  $('#f-urgent').checked = !!cfg?.urgent_notifications;
  $('#f-raise').checked = !!cfg?.raise_on_notification;
  $('#f-unread').checked = !!cfg?.notify_on_unread;
  $('#f-unread-only').checked = !!cfg?.notify_only_with_message;
  $('#f-unread-total').checked = !!cfg?.notify_show_unread_total;
  $('#f-keepsignin').checked = !cfg?.forget_session_cookies;
  $('#f-resume').checked = !!cfg?.reload_on_resume;
  $('#f-keys').checked = !!cfg?.pass_shortcuts;
  // New apps minimize to the tray by default; existing apps keep their setting.
  $('#f-mintray').checked = cfg ? !!cfg.minimize_to_tray : true;
  $('#f-cert').checked = !!cfg?.ignore_certificate_errors;
  $('#f-memlimit').value = cfg?.memory_limit_mb || '';
  $('#f-calls').checked = !!(cfg?.handle_schemes || []).length;
  const phoneApp = apps.find((a) => (a.config.handle_schemes || []).length && a.config.id !== cfg?.id);
  $('#f-calls').parentElement.title = phoneApp ? `Ticking this takes over from ${phoneApp.config.name}` : '';
  $('#f-menu').checked = true;
  $('#f-origins').value = (cfg?.allowed_origins || []).join('\n');
  $('#f-perms').value = (cfg?.extra_permissions || []).join(', ');
  $('#f-color').value = cfg?.icon_color || '';
  $('#f-label').value = cfg?.icon_label || '';
  hidDevices = (cfg?.hid_devices || []).map((d) => ({ ...d }));
  renderHid();
  ctx.clearRect(0, 0, 256, 256);
  if (iconUrl) await drawIcon(iconUrl);
  iconDirty = mode === 'duplicate' && !!iconUrl; // a copy needs its own icon file
  updateBgButton();
  updatePreview();
  dlg.showModal();
  if (mode === 'add') $('#f-url').focus();
  else if (mode === 'duplicate') { $('#f-name').focus(); $('#f-name').select(); }
}

/** A second copy of an app: own ID, profile (login), colour and label. */
function openDuplicate(c, baseIcon) {
  const { id, name, n } = nextCopy(c.id, c.name);
  const copy = {
    ...c, id, name,
    autostart: false,
    icon_color: nextColor(c.url),
    icon_label: n ? String(n) : '',
  };
  delete copy.icon;
  // Only one app should own phone links.
  delete copy.handle_schemes;
  openEditor(copy, baseIcon, 'duplicate');
}

async function fetchDetails() {
  const url = $('#f-url').value.trim();
  if (!url) return;
  const btn = $('#btn-fetch');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  setError('');
  try {
    const info = await api.inspect(url);
    $('#f-url').value = info.url;
    let name = info.name, id = info.id;
    // Adding a site you already have? Default to a distinct copy.
    if (!editing && (idTaken(id) || nameTaken(name))) {
      const c = nextCopy(id, name);
      id = c.id; name = c.name;
      if (!$('#f-color').value && sameSite(info.url).length) $('#f-color').value = nextColor(info.url);
      if (!$('#f-label').value && c.n) $('#f-label').value = String(c.n);
    }
    if (!editing || !$('#f-name').value) $('#f-name').value = name;
    if (!$('#f-id').dataset.touched) $('#f-id').value = id;
    const existing = new Set(originsFromText());
    info.allowed_origins.forEach((o) => existing.add(o));
    $('#f-origins').value = [...existing].join('\n');
    showNotes(info.notes);
    // The new Outlook only notifies through Chrome's web push: use the unread fallback.
    if (/(^|\.)outlook\.(office|office365|live)\.com$|(^|\.)outlook\.cloud\.microsoft$/.test(new URL(info.url).hostname)) $('#f-unread').checked = true;
    const ranked = rank(await Promise.all((info.icons || []).map(analyze)));
    if (ranked.length && await drawIcon(ranked[0].src)) {
      setIconAuto(true);
      autoRemoveWhitePlate();
    } else {
      letterIcon(name, new URL(info.url).hostname);
      setIconAuto(true);
    }
    showChoices(ranked);
  } catch (e) {
    setError(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch details';
  }
}

async function save(ev) {
  ev.preventDefault();
  setError('');
  let url = $('#f-url').value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { setError('That web address is not valid.'); return; }
  const name = $('#f-name').value.trim() || new URL(url).hostname;
  const id = $('#f-id').value.trim();
  const origins = originsFromText();
  if (!origins.length) origins.push(new URL(url).origin);

  // Keep options the form doesn't know about (badge_regex, user_agent…).
  const cfg = { ...(template || {}), id, name, url, allowed_origins: origins };
  const opt = (key, on) => { if (on) cfg[key] = true; else delete cfg[key]; };
  cfg.autostart = $('#f-autostart').checked;
  cfg.start_hidden = $('#f-hidden').checked;
  opt('urgent_notifications', $('#f-urgent').checked);
  opt('raise_on_notification', $('#f-raise').checked);
  opt('notify_on_unread', $('#f-unread').checked);
  opt('notify_only_with_message', $('#f-unread-only').checked);
  opt('notify_show_unread_total', $('#f-unread-total').checked);
  opt('forget_session_cookies', !$('#f-keepsignin').checked);
  opt('reload_on_resume', $('#f-resume').checked);
  opt('pass_shortcuts', $('#f-keys').checked);
  opt('minimize_to_tray', $('#f-mintray').checked);
  opt('ignore_certificate_errors', $('#f-cert').checked);
  opt('icon_auto', iconAuto);
  if ($('#f-calls').checked) cfg.handle_schemes = ['tel', 'callto', 'sip']; else delete cfg.handle_schemes;
  const memText = $('#f-memlimit').value.trim();
  const mem = parseInt(memText, 10);
  if (memText && !(mem >= 200)) { setError('The memory limit must be at least 200 MB (leave it empty for no limit).'); $('#f-memlimit').focus(); return; }
  if (memText) cfg.memory_limit_mb = mem; else delete cfg.memory_limit_mb;
  const style = styleFields();
  if (style.icon_color) cfg.icon_color = style.icon_color; else delete cfg.icon_color;
  if (style.icon_label) cfg.icon_label = style.icon_label; else delete cfg.icon_label;
  const perms = $('#f-perms').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (perms.length) cfg.extra_permissions = perms; else delete cfg.extra_permissions;
  if (hidDevices.length) cfg.hid_devices = hidDevices; else delete cfg.hid_devices;

  if (!iconDirty && !cfg.icon) { letterIcon(name, new URL(url).hostname); opt('icon_auto', true); }
  const icon = iconDirty ? canvas.toDataURL('image/png') : null;

  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    await api.save(cfg, icon, editing?.id ?? null);
    // Phone links need the menu entry (that is what the desktop opens them with).
    if ($('#f-menu').checked || cfg.handle_schemes) await api.install(id);
    dlg.close();
    toast(template && !editing ? `${name} created — open it and sign in with the other account` : `${name} saved`);
    await refresh();
  } catch (e) {
    setError(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ wire
$('#btn-add').addEventListener('click', () => openEditor(null));
document.querySelector('[data-action=add]').addEventListener('click', () => openEditor(null));
$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-fetch').addEventListener('click', fetchDetails);
$('#f-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchDetails(); } });
$('#f-url').addEventListener('change', () => { if (!$('#f-name').value) fetchDetails(); });
$('#f-id').addEventListener('input', () => { $('#f-id').dataset.touched = '1'; });
$('#f-name').addEventListener('input', () => {
  if (!$('#f-id').dataset.touched) $('#f-id').value = $('#f-name').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
});
$('#btn-icon').addEventListener('click', () => guard(async () => { const d = await api.pickIcon(); if (d && await drawIcon(d)) setIconAuto(false); }));
$('#btn-bg').addEventListener('click', toggleBackground);
$('#f-color').addEventListener('change', updatePreview);
$('#f-label').addEventListener('input', updatePreview);
$('#btn-hid').addEventListener('click', () => guard(detectHid));
$('#form').addEventListener('submit', save);
$('#btn-config').addEventListener('click', () => api.openConfig());
$('#btn-export').addEventListener('click', () => guard(async () => {
  const r = await api.exportApps();
  if (r) toast(`Exported ${r.count} app${r.count === 1 ? '' : 's'} to ${r.file}`);
}));
const importApps = () => guard(async () => {
  const r = await api.importApps();
  if (!r) return;
  await refresh();
  toast(`Imported ${r.imported} app${r.imported === 1 ? '' : 's'}${r.skipped ? `, kept ${r.skipped} existing` : ''}. Open each one to sign in.`);
});
$('#btn-import').addEventListener('click', importApps);
document.querySelector('[data-action=import]').addEventListener('click', importApps);
$('#btn-manager-entry').addEventListener('click', () => guard(async () => { await api.installManager(); toast('WebRoost added to the application menu'); }));
window.addEventListener('focus', refresh);
// Keep "running" / Open / Show / Quit current while the manager is open.
setInterval(() => { if (!document.hidden && document.hasFocus() && !$('#editor').open) refresh().catch(() => {}); }, 10000);

// --------------------------------------------------------------- updates
let lastUpdate = null;
function showUpdate(u) {
  lastUpdate = u;
  const banner = $('#update-banner');
  if (!u || !u.available) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  $('#update-title').textContent = `WebRoost ${u.latest} is available`;
  const how = {
    flatpak: 'Click "How to update" for the steps for this Flatpak.',
    appimage: 'Installing replaces this AppImage file.',
    rpm: 'Installing asks for your password and updates the package.',
    deb: 'Installing asks for your password and updates the package.',
    pacman: 'Installing asks for your password and updates the package.',
    manual: 'Click "How to update" for the steps.',
    dev: 'You are running from source: git pull to update.',
  }[u.kind] || '';
  $('#update-text').textContent = `You have ${u.current}. ${how}`;
  $('#btn-update-install').classList.toggle('hidden', !u.canInstall);
  $('#btn-update-howto').classList.toggle('hidden', u.canInstall);
}

async function checkUpdate(force) {
  const u = await api.checkUpdate(force);
  showUpdate(u);
  loadGuide().catch(() => {});
  showMoved().catch(() => {});
  if (force) {
    if (u.error) toast(`Update check failed: ${u.error}`);
    else if (!u.available) toast(`WebRoost ${u.current} is the latest version`);
  }
}

// "How to update" for this install method (Flatpak, AppImage, rpm, deb…).
let guide = null;
async function loadGuide() {
  guide = await api.updateGuide();
  $('#install-kind').textContent = `Installed as ${guide.label}`;
}

async function showGuide() {
  await loadGuide();
  $('#guide-kind').textContent = guide.label;
  $('#guide-where').textContent = guide.where ? `(${guide.where})` : '';
  $('#guide-summary').textContent = guide.summary;
  $('#guide-steps').replaceChildren(...guide.steps.map((st) => el('div', { class: 'guide-step' },
    el('span', {}, st.text),
    st.download ? el('div', {}, el('button', {
      type: 'button', class: 'primary', id: 'btn-guide-download',
      onclick: (e) => guard(async () => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        try {
          const file = await api.downloadUpdate();
          btn.textContent = 'Downloaded ✓';
          toast(`Saved to ${file}`);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Download';
          throw err;
        }
      }),
    }, 'Download')) : null,
    st.command ? el('div', { class: 'cmd' },
      el('code', {}, st.command),
      el('button', { type: 'button', onclick: () => guard(async () => { await api.copy(st.command); toast('Copied, paste it into a terminal'); }) }, 'Copy'),
    ) : null,
  )));
  $('#guide').showModal();
}

$('#btn-guide').addEventListener('click', () => guard(showGuide));
$('#btn-credit').addEventListener('click', () => api.openExternal('https://github.com/samschultzponsys/webroost'));
$('#btn-update-howto').addEventListener('click', () => guard(showGuide));
$('#btn-guide-releases').addEventListener('click', () => api.openExternal(lastUpdate?.releaseUrl || 'https://github.com/samschultzponsys/webroost/releases/latest'));
$('#btn-check-update').addEventListener('click', () => guard(() => checkUpdate(true)));
$('#btn-update-notes').addEventListener('click', () => { if (lastUpdate?.releaseUrl) api.openExternal(lastUpdate.releaseUrl); });
$('#btn-update-install').addEventListener('click', () => guard(async () => {
  const btn = $('#btn-update-install');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const msg = await api.installUpdate();
    $('#update-title').textContent = 'Update installed';
    $('#update-text').textContent = msg;
    btn.classList.add('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Install update';
  }
}));
api.onUpdateProgress((p) => {
  const pct = `Downloading… ${Math.round(p * 100)}%`;
  const g = document.getElementById('btn-guide-download');
  if (g && g.disabled && !g.textContent.includes('✓')) g.textContent = pct;
  else $('#btn-update-install').textContent = pct;
});
$('#f-autoupdate').addEventListener('change', (e) => guard(() => api.setAutoUpdate(e.target.checked)));

(async () => {
  const info = await api.info();
  $('#version').textContent = `WebRoost ${info.version}`;
  $('#config-path').textContent = info.configFile;
  $('#btn-manager-entry').classList.toggle('hidden', !info.appImage);
  loadGuide().catch(() => {});
  iconColors = await api.iconColors();
  const sel = $('#f-color');
  for (const c of iconColors) sel.append(el('option', { value: c }, c.charAt(0).toUpperCase() + c.slice(1)));
  await refresh();
  $('#f-autoupdate').checked = await api.getAutoUpdate();
  if ($('#f-autoupdate').checked) checkUpdate(false).catch(() => {});
})();

// ---------------------------------------------------------------- memory
const memDlg = $('#memory');
let memTimer = null;

function sparkline(history, limit) {
  const pts = history.filter(([, mb]) => mb > 0);
  if (pts.length < 2) return '<svg viewBox="0 0 170 34"></svg>';
  const now = Date.now();
  const t0 = now - 6 * 3600_000;
  const top = Math.max(...pts.map(([, mb]) => mb), limit || 0) * 1.1 || 1;
  const x = (t) => ((t - t0) / (now - t0)) * 170;
  const y = (mb) => 34 - (mb / top) * 32;
  const line = pts.map(([t, mb]) => `${x(t).toFixed(1)},${y(mb).toFixed(1)}`).join(' ');
  const area = `${x(pts[0][0]).toFixed(1)},34 ${line} ${x(pts[pts.length - 1][0]).toFixed(1)},34`;
  const lim = limit ? `<line class="limit" x1="0" x2="170" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}"/>` : '';
  return `<svg viewBox="0 0 170 34" preserveAspectRatio="none" role="img" aria-label="Memory over the last 6 hours"><polygon class="area" points="${area}"/><polyline points="${line}"/>${lim}</svg>`;
}

async function renderMemory() {
  const data = await api.memory();
  const live = data.filter((a) => a.sample);
  const idle = data.filter((a) => !a.sample);
  const total = live.reduce((n, a) => n + a.sample.total, 0);
  const core = live.reduce((n, a) => n + a.sample.core, 0);
  const pages = live.reduce((n, a) => n + a.sample.pages, 0);
  const approx = live.some((a) => a.sample.method !== 'pss');

  const summary = $('#mem-summary');
  summary.replaceChildren(
    el('div', { class: 'mem-stat' }, el('b', {}, live.length ? fmtMb(total) : '—'), el('span', {}, `${live.length} running app${live.length === 1 ? '' : 's'}${approx ? ' (approximate)' : ''}`)),
    el('div', { class: 'mem-stat' }, el('b', {}, live.length ? fmtMb(pages) : '—'), el('span', {}, 'pages')),
    el('div', { class: 'mem-stat' }, el('b', {}, live.length ? fmtMb(core) : '—'), el('span', {}, 'browser cores')),
  );
  // What one shared core for everything except the phone app would save.
  const shareable = live.filter((a) => !a.phone);
  const kept = live.filter((a) => a.phone).map((a) => a.name);
  if (shareable.length >= 2) {
    const cores = shareable.map((a) => a.sample.core);
    const save = cores.reduce((n, c) => n + c, 0) - Math.max(...cores);
    summary.append(el('div', { class: 'mem-save' },
      el('b', {}, `About ${fmtMb(save)} could be saved`),
      ` if ${andList(shareable.map((a) => a.name))} shared one browser core instead of ${shareable.length}`,
      kept.length ? ` (keeping ${andList(kept)} in ${kept.length === 1 ? 'its' : 'their'} own process${kept.length === 1 ? '' : 'es'})` : '', '.'));
  }

  const max = Math.max(1, ...live.map((a) => Math.max(a.sample.total, a.limit || 0)));
  const list = $('#mem-list');
  list.replaceChildren(...live.sort((a, b) => b.sample.total - a.sample.total).map((a) => {
    const s = a.sample;
    const icon = apps.find((x) => x.config.id === a.id)?.icon || '../assets/icon.svg';
    const peak = Math.max(s.total, ...a.history.map(([, mb]) => mb));
    const near = a.limit && s.total > a.limit * 0.9;
    const spark = el('div', { class: 'mem-spark' });
    spark.innerHTML = sparkline(a.history, a.limit);
    spark.append(el('span', {}, `6 h peak ${fmtMb(peak)}`));
    // Widths via CSSOM: the page's CSP doesn't allow inline style attributes.
    const coreSeg = el('div', { class: 'core' });
    const pageSeg = el('div', { class: 'pages' });
    coreSeg.style.width = `${(s.core / max) * 100}%`;
    pageSeg.style.width = `${(s.pages / max) * 100}%`;
    const bar = el('div', { class: 'mem-bar', title: `Core ${fmtMb(s.core)} · pages ${fmtMb(s.pages)}` }, coreSeg, pageSeg);
    return el('div', { class: 'mem-row' },
      el('img', { src: icon, alt: '' }),
      el('div', { class: 'mem-main' },
        el('div', { class: 'mem-title' },
          el('b', {}, a.name),
          el('span', { class: 'num' + (near ? ' warn' : '') }, fmtMb(s.total)),
          a.limit ? el('span', { class: 'muted' + (near ? ' warn' : '') }, `of ${fmtMb(a.limit)} limit`) : null,
          el('span', { class: 'muted' }, `core ${fmtMb(s.core)} · pages ${fmtMb(s.pages)}`)),
        bar),
      spark,
      el('details', {},
        el('summary', {}, `${s.processes.length} processes`),
        el('div', { class: 'mem-procs' }, ...s.processes.flatMap((p) => [el('span', {}, p.name === p.type ? p.type : `${p.type} · ${p.name}`), el('span', {}, fmtMb(p.mb))]))),
    );
  }));
  if (!live.length) list.append(el('p', { class: 'hint' }, 'No app is running, or none has measured itself yet (they do within a minute of starting).'));
  $('#mem-idle').textContent = idle.length ? `Not running or not measured yet: ${idle.map((a) => a.name).join(', ')}.` : '';
  const newest = Math.max(0, ...live.map((a) => a.at || 0));
  $('#mem-updated').textContent = newest ? `updated ${new Date(newest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function openMemory() {
  guard(async () => {
    await renderMemory();
    if (!memDlg.open) memDlg.showModal();
    clearInterval(memTimer);
    memTimer = setInterval(() => { if (memDlg.open) guard(renderMemory); }, 15_000);
  });
}
memDlg.addEventListener('close', () => clearInterval(memTimer));
$('#btn-memory').addEventListener('click', openMemory);

// ------------------------------------------------- moved from PWA Pop
async function showMoved() {
  const m = await api.migration();
  if (!m) return;
  $('#moved-text').textContent = `Your ${m.apps} app${m.apps === 1 ? '' : 's'}, their icons and logins were brought over, and the menu and autostart entries now start WebRoost. `
    + (m.flatpak ? 'Remove the old PWA Pop Flatpak whenever you like:' : 'The old pwa-pop package is replaced when this one is installed.');
  if (m.flatpak) {
    const cmd = 'flatpak uninstall --user io.github.samschultzponsys.PwaPop';
    $('#moved-cmd code').textContent = cmd;
    $('#moved-cmd').classList.remove('hidden');
    $('#btn-moved-copy').onclick = () => guard(async () => { await api.copy(cmd); toast('Copied'); });
  }
  $('#moved-banner').classList.remove('hidden');
  $('#btn-moved-ok').onclick = () => guard(async () => { await api.migrationDone(); $('#moved-banner').classList.add('hidden'); });
}
