/* PWA Pop manager UI — plain JS, talks to the main process via window.webtray. */
'use strict';

const api = window.webtray;
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
async function refresh() {
  const apps = await api.list();
  const list = $('#list');
  list.replaceChildren();
  $('#empty').classList.toggle('hidden', apps.length > 0);
  for (const a of apps) list.append(card(a));
}

function card({ config: c, icon, installed, running }) {
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
      installed.menu ? el('span', { class: 'badge on' }, 'in menu') : null,
      installed.autostart ? el('span', { class: 'badge on' }, 'autostart') : null,
      (c.hid_devices || []).length ? el('span', { class: 'badge on' }, 'headset') : null,
    ),
    el('div', { class: 'toggles' }, toggle('Autostart', 'autostart'), toggle('Start hidden', 'start_hidden')),
    el('div', { class: 'buttons' },
      el('button', { class: 'primary', onclick: () => guard(async () => { await api.launch(c.id); toast(`Starting ${c.name}…`); setTimeout(refresh, 2500); }) }, running ? 'Show' : 'Open'),
      el('button', { onclick: () => openEditor(c, icon) }, 'Edit'),
      installed.menu
        ? el('button', { class: 'ghost', onclick: () => guard(async () => { await api.uninstall(c.id); refresh(); }) }, 'Remove from menu')
        : el('button', { class: 'ghost', onclick: () => guard(async () => { await api.install(c.id); toast('Added to the application menu'); refresh(); }) }, 'Add to menu'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost danger', onclick: () => guard(async () => { if (await api.remove(c.id)) refresh(); }) }, 'Delete'),
    ),
  );
}

// ----------------------------------------------------------------- icons
const canvas = $('#icon-canvas');
const ctx = canvas.getContext('2d');

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
}

function drawIcon(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, 256, 256);
      const w = img.naturalWidth || 256, h = img.naturalHeight || 256;
      const s = Math.min(256 / w, 256 / h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (256 - w * s) / 2, (256 - h * s) / 2, w * s, h * s);
      iconDirty = true;
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
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

async function openEditor(cfg, iconUrl) {
  editing = cfg || null;
  iconDirty = false;
  setError('');
  showNotes([]);
  $('#hid-found').replaceChildren();
  $('#hid-status').textContent = '';
  $('#editor-title').textContent = cfg ? `Edit ${cfg.name}` : 'Add app';
  $('#f-url').value = cfg?.url || '';
  $('#f-name').value = cfg?.name || '';
  $('#f-id').value = cfg?.id || '';
  $('#f-id').dataset.touched = cfg ? '1' : '';
  $('#f-autostart').checked = !!cfg?.autostart;
  $('#f-hidden').checked = !!cfg?.start_hidden;
  $('#f-urgent').checked = !!cfg?.urgent_notifications;
  $('#f-raise').checked = !!cfg?.raise_on_notification;
  $('#f-resume').checked = !!cfg?.reload_on_resume;
  $('#f-cert').checked = !!cfg?.ignore_certificate_errors;
  $('#f-menu').checked = true;
  $('#f-origins').value = (cfg?.allowed_origins || []).join('\n');
  $('#f-perms').value = (cfg?.extra_permissions || []).join(', ');
  hidDevices = (cfg?.hid_devices || []).map((d) => ({ ...d }));
  renderHid();
  ctx.clearRect(0, 0, 256, 256);
  if (iconUrl) { await drawIcon(iconUrl); iconDirty = false; }
  dlg.showModal();
  if (!cfg) $('#f-url').focus();
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
    if (!editing || !$('#f-name').value) $('#f-name').value = info.name;
    if (!$('#f-id').dataset.touched) $('#f-id').value = info.id;
    const existing = new Set(originsFromText());
    info.allowed_origins.forEach((o) => existing.add(o));
    $('#f-origins').value = [...existing].join('\n');
    showNotes(info.notes);
    if (!(info.icon && await drawIcon(info.icon))) letterIcon(info.name, new URL(info.url).hostname);
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
  const cfg = { ...(editing || {}), id, name, url, allowed_origins: origins };
  const opt = (key, on) => { if (on) cfg[key] = true; else delete cfg[key]; };
  cfg.autostart = $('#f-autostart').checked;
  cfg.start_hidden = $('#f-hidden').checked;
  opt('urgent_notifications', $('#f-urgent').checked);
  opt('raise_on_notification', $('#f-raise').checked);
  opt('reload_on_resume', $('#f-resume').checked);
  opt('ignore_certificate_errors', $('#f-cert').checked);
  const perms = $('#f-perms').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (perms.length) cfg.extra_permissions = perms; else delete cfg.extra_permissions;
  if (hidDevices.length) cfg.hid_devices = hidDevices; else delete cfg.hid_devices;

  if (!iconDirty && !cfg.icon) letterIcon(name, new URL(url).hostname);
  const icon = iconDirty ? canvas.toDataURL('image/png') : null;

  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    await api.save(cfg, icon, editing?.id ?? null);
    if ($('#f-menu').checked) await api.install(id);
    dlg.close();
    toast(`${name} saved`);
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
$('#btn-icon').addEventListener('click', () => guard(async () => { const d = await api.pickIcon(); if (d) await drawIcon(d); }));
$('#btn-hid').addEventListener('click', () => guard(detectHid));
$('#form').addEventListener('submit', save);
$('#btn-config').addEventListener('click', () => api.openConfig());
$('#btn-manager-entry').addEventListener('click', () => guard(async () => { await api.installManager(); toast('PWA Pop added to the application menu'); }));
window.addEventListener('focus', refresh);

(async () => {
  const info = await api.info();
  $('#version').textContent = `PWA Pop ${info.version}`;
  $('#config-path').textContent = info.configFile;
  $('#btn-manager-entry').classList.toggle('hidden', !info.appImage);
  await refresh();
})();
