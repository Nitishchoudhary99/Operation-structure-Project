/* SmartTrader Cloud ERP - web app (no build step, no framework).
   Hash routes (#/sales/INV, #/doc/12 ...) render pages from the JSON API in src/worker.js. */

import { csvCell, toCsv } from '/csv.js';

/* ======================================================================= helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n < 0 ? '−' : '') + '₹' + Math.abs(Number(n || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* an amount in a foreign currency (export invoices): "USD 1,234.50" */
const fcMoney = (n, c) => `${n < 0 ? '−' : ''}${c} ${Math.abs(Number(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr0 = (n) => (n < 0 ? '−' : '') + '₹' + Math.abs(Number(n || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const qtyf = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fdate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
const r2 = (x) => Math.round(x * 100) / 100;

const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Other Territory'];
document.body.insertAdjacentHTML('beforeend', `<datalist id="states">${STATES.map((x) => `<option value="${x}">`).join('')}</datalist>
  <datalist id="units">${['Pcs', 'Kg', 'Gram', 'Litre', 'ml', 'Box', 'Pack', 'Bag', 'Dozen', 'Metre', 'Pair', 'Set', 'Bottle', 'Tin'].map((x) => `<option value="${x}">`).join('')}</datalist>`);

let ME = null;                  // { user, org, can, doc_types, gst_rates, today }
const cache = {};               // masters used by forms; cleared after writes

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data || {}; } }
/* Offline: the last copy of what a bill needs (the business, customers, items, godowns, accounts) stays on this device,
   and bills, receipts and expenses made without internet wait in an outbox. Each carries an Idempotency-Key, so a
   bill sent twice (the answer was lost, or it was synced again) is saved once. Signing out clears both. */
const OFF_GET = /^\/api\/(me|parties|items|warehouses|accounts|settings\/print|settings\/fields)$/;
const OFF_POST = /^\/api\/(docs|payments|expenses)$/;
const idb = (() => {
  let p = null;
  return () => p || (p = new Promise((ok, no) => {
    const r = indexedDB.open('smarttrader-offline', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('get'); r.result.createObjectStore('queue', { keyPath: 'key' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
})();
async function idbDo(store, mode, fn, open = idb) {
  try {
    const db = await open();
    return await new Promise((ok, no) => { const tx = db.transaction(store, mode), req = fn(tx.objectStore(store)); tx.oncomplete = () => ok(req ? req.result : undefined); tx.onerror = () => no(tx.error); });
  } catch (e) { return undefined; }      // private mode or no IndexedDB: no offline copy, nothing breaks
}
const offOwner = () => (ME ? `${ME.user.id}:${ME.org.id}` : '');
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const queueAll = async () => ((await idbDo('queue', 'readonly', (s) => s.getAll())) || []).filter((x) => x.owner === offOwner()).sort((a, b) => a.at - b.at);
const offClear = () => Promise.all([idbDo('get', 'readwrite', (s) => s.clear()), idbDo('queue', 'readwrite', (s) => s.clear())]);
/* Screens opened again within 20 seconds show at once from memory (what a page reads while it is drawn); any change
   (a save, a payment, a sync) empties it, so a page never shows its own old data after a write. */
const pageCache = new Map();
let rendering = false;
async function api(method, path, body, opt = {}) {
  if (method === 'GET' && rendering) {
    const hit = pageCache.get(path);
    if (hit && Date.now() - hit.at < 20000) return structuredClone(hit.data);
  }
  if (method !== 'GET') pageCache.clear();
  const key = method === 'POST' && OFF_POST.test(path) ? opt.key || newKey() : '';
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {                                    // no internet
    if (method === 'GET' && OFF_GET.test(path)) {
      const hit = await idbDo('get', 'readonly', (s) => s.get(path));
      if (hit && (path === '/api/me' || hit.owner === offOwner())) return { ...hit.data, _offline: true };
    }
    if (key && !opt.noQueue && ME) {
      await idbDo('queue', 'readwrite', (s) => s.put({ key, owner: offOwner(), method, path, body, at: Date.now(), label: opt.label || queueLabel(path, body) }));
      outboxBadge();
      return { queued: true, key };
    }
    throw new ApiError('No internet. Check the connection and try again.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && !path.startsWith('/api/auth')) { ME = null; idbDo('get', 'readwrite', (s) => s.clear()); signedOut(); throw new ApiError('Please sign in.', 401); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  if (path === '/api/me') remember(true);
  if (method === 'GET' && rendering && pageCache.size < 60) pageCache.set(path, { at: Date.now(), data: structuredClone(data) });
  if (method === 'GET' && OFF_GET.test(path)) {
    const owner = path === '/api/me' ? `${data.user.id}:${data.org.id}` : offOwner();
    idbDo('get', 'readwrite', (s) => s.put({ owner, data, at: Date.now() }, path));
  }
  return data;
}
function queueLabel(path, b) {
  const party = b && b.party_id && cache.parties ? (cache.parties.find((p) => p.id === +b.party_id) || {}).name : '';
  if (path === '/api/docs') return `${(ME.doc_types[b.type] || {}).label || 'Bill'}${party ? ' · ' + party : ''}`;
  if (path === '/api/payments') return `${b.kind === 'receipt' ? 'Receipt' : 'Payment'} ₹${b.amount}${party ? ' · ' + party : ''}`;
  return `Expense ₹${b.amount}`;
}
/* send what waits in the outbox, oldest first; a refused one stays with its reason, no internet stops the round */
let syncing = false;
async function syncOutbox() {
  if (syncing || !ME || !navigator.onLine) return;
  syncing = true;
  let sent = 0;
  try {
    for (const it of await queueAll()) {
      try {
        await api(it.method, it.path, it.body, { key: it.key, noQueue: true });
        await idbDo('queue', 'readwrite', (s) => s.delete(it.key)); sent++;
      } catch (e) {
        if (!e.status) break;
        await idbDo('queue', 'readwrite', (s) => s.put({ ...it, error: e.message, status: e.status, data: e.data || {} }));
      }
    }
  } finally {
    syncing = false;
    if (sent) { dirty('items', 'accounts', 'parties'); toast(`${sent} saved entr${sent === 1 ? 'y' : 'ies'} sent to the cloud`); }
    outboxBadge();
  }
}
async function outboxBadge() {
  const b = $('#outbox'); if (!b) return;
  const q = await queueAll(), bad = q.filter((x) => x.error).length;
  b.hidden = !q.length;
  b.innerHTML = `&#8635; ${q.length}<span class="hide-sm"> to sync</span>${bad ? ' <b>!</b>' : ''}`;
}
const GET = (p) => api('GET', p);
const POST = (p, b = {}, opt) => api('POST', p, b, opt);
async function master(name) {
  if (!cache[name]) cache[name] = (await GET('/api/' + name)).rows;
  return cache[name];
}
const dirty = (...names) => names.forEach((n) => delete cache[n]);

/* Short message at the bottom. kind: 'ok' (green tick, default), 'err' (red), 'info' (plain) */
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.className = 't-' + kind;
  t.innerHTML = (kind === 'ok' ? '<b aria-hidden="true">&#10003;</b> ' : kind === 'err' ? '<b aria-hidden="true">!</b> ' : '') + esc(msg);
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), kind === 'err' ? 4000 : 2600);
}
/* An empty list that says what to do next, with a button */
const emptyCta = (text, btn = '') => `<div class="empty-cta"><p>${text}</p>${btn}</div>`;

function table(cols, rows, { onRow, foot, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const th = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.h}</th>`).join('');
  const tr = rows.map((r, i) => `<tr ${onRow ? `class="click" data-i="${i}"` : ''}>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}" data-h="${esc(String(c.h).replace(/<[^>]*>/g, ''))}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('');
  const tf = foot ? `<tfoot><tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${foot[c.k] ?? ''}</td>`).join('')}</tr></tfoot>` : '';
  return `<div class="tbl-wrap"><table class="t" data-rows="${rows.length}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${tf}</table></div>`;
}
/* Every list made with table() gets, without each screen doing anything: a click on a heading sorts by it (again: the other
   way), and from 8 rows a filter box, the count, "Download as Excel (CSV)" of what is shown, and from 100 rows "Show all".
   Rows are moved, never redrawn, so whatever a screen wired to them keeps working. */
/* ---- searchable dropdowns: a long list (customers, suppliers, items, accounts) gets a type-to-find box. The <select>
   stays the source of the value (forms read it, screens set it and listen to it), so nothing that uses it changes. ---- */
const COMBO_MIN = 12;
function enhanceSelects(root) {
  for (const sel of $$('select:not([data-combo]):not([multiple])', root)) {
    if (sel.options.length < COMBO_MIN || sel.closest('.no-combo, .dtools, .wed, .voice, .cmdk')) continue;
    sel.dataset.combo = '1';
    const box = document.createElement('div'); box.className = 'combo';
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'text', className: 'combo-in', autocomplete: 'off', spellcheck: false });
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-expanded', 'false'); inp.setAttribute('aria-autocomplete', 'list');
    const lab = sel.closest('label');
    inp.setAttribute('aria-label', sel.getAttribute('aria-label') || (lab ? lab.childNodes[0].textContent.trim() : '') || 'Choose');
    if (sel.style.cssText) box.style.cssText = sel.style.cssText;
    const list = document.createElement('div'); list.className = 'combo-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
    sel.before(box); box.append(inp, list, sel);
    sel.classList.add('combo-src'); sel.tabIndex = -1;
    let items = [], at = 0, typed = false;
    const opts = () => [...sel.options].filter((o) => !o.disabled);
    const sync = () => { const o = sel.options[sel.selectedIndex]; inp.value = o && o.value !== '' ? o.text : ''; inp.placeholder = sel.options[0] && sel.options[0].value === '' ? sel.options[0].text : 'Type to find…'; };
    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); if (typed) { typed = false; sync(); } };
    const draw = () => {
      const q = typed ? inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
      const all = opts().filter((o) => o.value !== '' || !q.length);
      const hit = q.length ? all.filter((o) => q.every((w) => o.text.toLowerCase().includes(w))) : all;
      items = hit.slice(0, 60); at = Math.min(at, Math.max(0, items.length - 1));
      list.innerHTML = items.length ? items.map((o, i) => `<div role="option" class="combo-opt${i === at ? ' on' : ''}${o.value === sel.value ? ' sel' : ''}" data-i="${i}" aria-selected="${i === at}">${esc(o.text)}</div>`).join('')
        + (hit.length > items.length ? `<div class="combo-more">${hit.length - items.length} more: keep typing</div>` : '') : '<div class="combo-more">Nothing matches</div>';
      list.hidden = false; inp.setAttribute('aria-expanded', 'true');
      const on = $('.combo-opt.on', list); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const choose = (o) => { typed = false; if (o && sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } sync(); list.hidden = true; inp.setAttribute('aria-expanded', 'false'); };
    inp.addEventListener('focus', () => { inp.select(); at = Math.max(0, opts().findIndex((o) => o.value === sel.value)); draw(); });
    inp.addEventListener('input', () => { typed = true; at = 0; draw(); });
    inp.addEventListener('blur', () => setTimeout(close, 120));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) draw(); else if (items.length) { at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw(); } }
      else if (e.key === 'Enter') { if (!list.hidden && items[at]) { e.preventDefault(); e.stopPropagation(); choose(items[at]); } }
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
      else if (e.key === 'Tab' && typed && items[at]) choose(items[at]);
    });
    list.addEventListener('mousedown', (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); choose(items[+d.dataset.i]); } });
    sel.addEventListener('change', sync);
    sel.addEventListener('invalid', () => { box.classList.add('bad'); inp.focus(); });
    sel.addEventListener('change', () => box.classList.remove('bad'));
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true });
    sync();
  }
}
/* remembered list views: sort, filter and hidden columns of each list, per screen, on this device */
const viewKey = (tb) => `st:view:${ME ? ME.org.id : 0}:${location.hash.replace(/^#\/?/, '').split('?')[0]}:${[...tb.tHead.rows[0].cells].map((c) => c.textContent.trim()).join('|').slice(0, 200)}`;
const loadView = (k) => { try { return JSON.parse(storeGet(k) || 'null') || {}; } catch (e) { return {}; } };
const SHOW_FIRST = 100;
const cellValue = (td) => {
  const t = (td ? td.innerText || td.textContent : '').trim();
  const n = t.replace(/[₹,\s]|Dr|Cr/g, '').replace(/^−/, '-');
  if (/^-?\d+(\.\d+)?%?$/.test(n)) return { n: parseFloat(n) };
  if (/^\d{1,2} [A-Z][a-z]{2} \d{4}/.test(t)) { const d = Date.parse(t.slice(0, 11)); if (!isNaN(d)) return { n: d }; }
  return { s: t.toLowerCase() };
};
function enhanceTables(root) {
  for (const tb of $$('table.t[data-rows]:not([data-enh])', root)) {
    tb.dataset.enh = '1';
    if (tb.closest('.doc-paper, .modal, .receipt, .lines, .no-tools')) continue;
    const body = tb.tBodies[0], rows = [...body.rows], n = rows.length;
    if (n < 2) continue;
    const heads = [...tb.tHead.rows[0].cells], vk = viewKey(tb), saved = loadView(vk);
    const keep = (patch) => { const v = { ...loadView(vk), ...patch }; storeSet(vk, JSON.stringify(v)); };
    const showCol = (i, on) => { for (const r of [tb.tHead.rows[0], ...body.rows, ...(tb.tFoot ? tb.tFoot.rows : [])]) if (r.cells[i]) r.cells[i].hidden = !on; };
    heads.forEach((th, i) => {
      if (!th.textContent.trim()) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sortbtn'; b.innerHTML = th.innerHTML; b.title = 'Sort';
      th.innerHTML = ''; th.appendChild(b);
      b.onclick = () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        heads.forEach((h) => h.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        const keyed = [...body.rows].map((r, k) => ({ r, k, v: cellValue(r.cells[i]) }));
        keyed.sort((a, c) => {
          const x = a.v, y = c.v;
          const d = x.n !== undefined && y.n !== undefined ? x.n - y.n : x.n !== undefined ? -1 : y.n !== undefined ? 1 : (x.s || '').localeCompare(y.s || '', 'en-IN', { numeric: true });
          return d * dir || a.k - c.k;
        });
        keyed.forEach(({ r }) => body.appendChild(r));
        if (!b.dataset.silent) keep({ sort: [i, dir] });
        paint();
      };
    });
    (saved.hide || []).forEach((i) => { if (heads[i] && heads[i].textContent.trim()) showCol(i, false); });
    let q = n >= 8 ? (saved.q || '').toLowerCase() : '', all = n <= SHOW_FIRST;
    const bar = document.createElement('div');
    bar.className = 'ttools';
    const named = heads.map((h, i) => [h.textContent.trim(), i]).filter(([h]) => h);
    if (n >= 8) {
      bar.innerHTML = `<input type="search" placeholder="Filter these ${n} rows" aria-label="Filter rows" autocomplete="off" value="${esc(saved.q || '')}"><span class="muted small" data-count></span>
        ${named.length >= 4 ? `<details class="more-menu colmenu"><summary class="btn sm">Columns</summary><div class="menu">${named.map(([h, i]) => `<label class="check"><input type="checkbox" data-col="${i}" ${heads[i].hidden ? '' : 'checked'}> ${esc(h)}</label>`).join('')}
          <button type="button" class="btn sm" data-reset>Reset this list</button></div></details>` : ''}
        <button type="button" class="btn sm" data-csv>Download (CSV)</button>`;
      tb.closest('.tbl-wrap').before(bar);
      $('input', bar).oninput = (e) => { q = e.target.value.trim().toLowerCase(); keep({ q: e.target.value.trim() }); paint(); };
      bar.addEventListener('change', (e) => {
        const c = e.target.closest('[data-col]'); if (!c) return;
        showCol(+c.dataset.col, c.checked);
        keep({ hide: heads.map((h, i) => (h.hidden ? i : -1)).filter((i) => i >= 0) });
      });
      bar.addEventListener('click', (e) => { if (e.target.closest('[data-reset]')) { storeSet(vk, '{}'); render(); } });
      $('[data-csv]', bar).onclick = () => {
        const cols = heads.map((h, i) => [h.textContent.trim(), i]).filter(([h]) => h && !h.hidden);
        const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const lines = [cols.map(([h]) => csvCell(h)).join(',')];
        for (const r of body.rows) if (!r.dataset.out) lines.push(cols.map(([, i]) => csvCell(((r.cells[i] || {}).textContent || '').replace(/\s+/g, ' ').trim())).join(','));
        const name = (($('.page-head h1') || {}).textContent || 'list').trim().replace(/[^\w\u0900-\u097F]+/g, '-').toLowerCase();
        download(`${name}-${ME ? ME.today : ''}.csv`, lines.join('\n'));
      };
    }
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'btn sm showall';
    more.onclick = () => { all = true; paint(); };
    tb.closest('.tbl-wrap').after(more);
    function paint() {
      const words = q.split(/\s+/).filter(Boolean);
      let shown = 0, match = 0;
      for (const r of body.rows) {
        const hit = !words.length || words.every((w) => r.textContent.toLowerCase().includes(w));
        if (hit) { r.removeAttribute('data-out'); match++; } else r.dataset.out = '1';
        const vis = hit && (all || shown < SHOW_FIRST);
        r.hidden = !vis; if (vis) shown++;
      }
      const c = $('[data-count]', bar);
      if (c) c.textContent = words.length ? `${match} of ${n}` : `${n} rows`;
      more.hidden = all || match <= SHOW_FIRST;
      more.textContent = `Show all ${match} rows`;
    }
    // the last sort of this list comes back (the click sorts and paints)
    if (saved.sort && heads[saved.sort[0]] && $('.sortbtn', heads[saved.sort[0]])) {
      const b = $('.sortbtn', heads[saved.sort[0]]); b.dataset.silent = '1';
      if (saved.sort[1] === -1) heads[saved.sort[0]].setAttribute('aria-sort', 'ascending');
      b.click(); delete b.dataset.silent;
    } else paint();
  }
}
function bindRows(el, rows, fn) {
  $$('tr.click', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) fn(rows[+tr.dataset.i]); }));
}
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  // the BOM tells Excel the CSV is UTF-8; other files (the GSTR-1 JSON) must go out exactly as they are
  a.href = URL.createObjectURL(new Blob([type === 'text/csv' ? '﻿' + text : text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Modal form. fields: [{k, label, type, options, value, wide, step}]; onSubmit(values) may throw to show an error. */
function modal(title, fields, onSubmit, { submit = 'Save', intro = '' } = {}) {
  const root = $('#modal-root');
  const input = (f) => {
    const v = f.value ?? '';
    if (f.type === 'select') return `<select name="${f.k}">${f.options.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    if (f.type === 'textarea') return `<textarea name="${f.k}" rows="3">${esc(v)}</textarea>`;
    if (f.type === 'checkbox') return `<input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}>`;
    return `<input name="${f.k}" type="${f.type || 'text'}" value="${esc(v)}" ${f.list ? `list="${f.list}" autocomplete="off"` : ''} ${f.step ? `step="${f.step}"` : f.type === 'number' ? 'step="any"' : ''} ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
  };
  const lab = (f) => `<label class="f ${f.wide ? 'wide' : ''} ${f.type === 'checkbox' ? 'check' : ''}">${f.type === 'checkbox' ? input(f) + ' ' : ''}<span>${esc(f.label)}${f.required ? ' <i class="req">*</i>' : ''}</span>${f.type === 'checkbox' ? '' : input(f)}${f.help ? `<small class="help">${esc(f.help)}</small>` : ''}</label>`;
  const main = fields.filter((f) => !f.more), more = fields.filter((f) => f.more);
  root.innerHTML = `<div class="modal-bg"><form class="modal" novalidate>
      <h2>${esc(title)}</h2>${intro}<div class="err" hidden></div>
      <div class="form">${main.map(lab).join('')}</div>
      ${more.length ? `<details class="more"><summary>More details <span class="muted">(optional)</span></summary><div class="form">${more.map(lab).join('')}</div></details>` : ''}
      <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(submit)}</button></div>
    </form></div>`;
  const form = $('form', root), close = () => { root.innerHTML = ''; };
  $('[data-x]', root).onclick = close;
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  enhanceSelects(form);
  const first = $('input,select:not(.combo-src),textarea', form); if (first && matchMedia('(pointer: fine)').matches) first.focus();
  const esc1 = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc1); } };
  document.addEventListener('keydown', esc1);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.k];
      vals[f.k] = f.type === 'checkbox' ? el.checked : el.value;
    }
    const btn = $('button.primary', form); btn.disabled = true;
    try { await onSubmit(vals, form); close(); } catch (err) {
      const box = $('.err', form); box.hidden = false; box.textContent = err.message; box.scrollIntoView({ block: 'nearest' });
    } finally { btn.disabled = false; }
  };
  return form;
}
const opts = (rows, label = (r) => r.name, value = (r) => r.id) => rows.map((r) => ({ v: value(r), t: label(r) }));
/* ---- custom fields (Settings > Custom fields): inputs named cf_<key>, values sent as `extra` ---- */
const cfDefs = (entity, side = '') => ((ME && ME.org.fields) || []).filter((f) => f.entity === entity && (!side || !f.side || f.side === side));
const cfModal = (entity, extra = {}, side = '') => cfDefs(entity, side).map((f) => ({ k: 'cf_' + f.key, label: f.label + (f.required ? ' *' : ''), value: extra[f.key] ?? '',
  type: f.type === 'select' ? 'select' : f.type, options: f.type === 'select' ? [{ v: '', t: '—' }, ...f.options.map((o) => ({ v: o, t: o }))] : undefined, required: !!f.required }));
const cfInputs = (entity, extra = {}, side = '') => cfModal(entity, extra, side).map((f) => `<label class="f">${esc(f.label)}${f.type === 'select'
  ? `<select name="${f.k}">${f.options.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(f.value) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`
  : `<input name="${f.k}" type="${f.type === 'number' ? 'number" step="any' : f.type}" value="${esc(f.value)}">`}</label>`).join('');
function splitCf(v) {
  const out = { extra: {} };
  for (const [k, x] of Object.entries(v)) { if (k.startsWith('cf_')) out.extra[k.slice(3)] = x; else out[k] = x; }
  return out;
}
const cfRead = (root) => Object.fromEntries($$('[name^=cf_]', root).map((i) => [i.name.slice(3), i.value]));
const cfCols = (entity, side = '') => cfDefs(entity, side).map((f) => ({ h: esc(f.label), cls: 'hide-sm', f: (r) => esc((r.extra || {})[f.key] ?? ''), csv: (r) => (r.extra || {})[f.key] ?? '' }));
const cashOpts = async () => opts((await master('accounts')).filter((a) => a.is_cash), (a) => `${a.name} (${inr(a.balance)})`);

/* Indian-system amount in words for invoices */
function words(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = (x) => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + two(x % 100);
  const rs = Math.floor(Math.abs(n)), ps = Math.round((Math.abs(n) - rs) * 100);
  let x = rs, out = [];
  const parts = [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']];
  for (const [d, nm] of parts) { if (x >= d) { out.push((d === 1e7 ? words(Math.floor(x / d)).replace(/ Rupees.*$/, '').replace(/ Only$/, '') : two(Math.floor(x / d))) + ' ' + nm); x %= d; } }
  if (x) out.push(three(x));
  return 'Rupees ' + (out.join(' ') || 'Zero') + (ps ? ' and ' + two(ps) + ' Paise' : '') + ' Only';
}

/* ======================================================================= auth screens */
/* The visitors' home page (tools/gen-seo-pages.py writes it into #app) stays for anyone who is not signed in and has no
   app address; public/boot.js hides it on a device where someone is signed in (the st:in flag kept here). */
const LANDING = (document.querySelector('#app .landing') || {}).outerHTML || '';
function remember(on) { try { if (on) localStorage.setItem('st:in', '1'); else localStorage.removeItem('st:in'); } catch (e) { /* storage off */ } }
const bareHome = () => /^#?\/?$/.test(location.hash);
function signedOut() {
  let was = false;
  try { was = localStorage.getItem('st:in') === '1'; } catch (e) { /* storage off */ }
  remember(false);
  document.documentElement.classList.remove('in');
  if (!was && bareHome() && LANDING) { if (!$('#app .landing')) $('#app').innerHTML = LANDING; return; }
  renderAuth();
}
function renderAuth(mode = /^#\/?signup/.test(location.hash) ? 'signup' : 'login') {
  $('#app').innerHTML = `<div class="auth">
    <div class="pitch">
      <h1>SmartTrader Cloud ERP</h1>
      <p>Everything a growing Indian business runs on, in one place, on any device.</p>
      <ul>
        <li>Purchase: PO &rarr; Goods Receipt &rarr; Bill &rarr; Payment</li>
        <li>Sales: Quote &rarr; Order &rarr; Delivery &rarr; GST Invoice &rarr; Receipt</li>
        <li>Multi-godown stock with average cost and reorder alerts</li>
        <li>True double-entry books: P&amp;L, Balance Sheet, GST summary</li>
        <li>Khata with WhatsApp &amp; UPI payment reminders</li>
        <li>Staff logins with roles, full audit trail</li>
      </ul>
      <p class="seo-links"><a href="/gst-billing-software/">GST billing</a> · <a href="/khata-book-app/">Khata book</a> · <a href="/inventory-management-software/">Inventory</a> · <a href="/pricing/">Pricing: free plan</a></p>
    </div>
    <div class="box"><form id="auth-form">
      <div class="brandline show-sm"><i>&#x2197;</i>SmartTrader ERP <span class="muted">· GST billing, stock &amp; khata</span></div>
      <p class="langlink"><a href="#" id="authlang" lang="${LANG === 'hi' ? 'en' : 'hi'}">${LANG === 'hi' ? 'Show in English' : 'हिंदी में देखें'}</a></p>
      <h1>${mode === 'login' ? 'Sign in' : mode === 'forgot' ? 'Forgot your password?' : 'Create your business account'}</h1>
      <div class="err" hidden></div>
      ${/drive=signin/.test(location.hash) && mode === 'login' ? '<p class="panel warnbox">You were signed out while Google was open. Sign in, then tap <b>Connect Google Drive</b> in Settings again.</p>' : ''}
      ${mode === 'forgot' ? '<p class="muted">Enter the email you sign in with. We will e-mail you a link to set a new password.</p>' : ''}
      ${mode === 'signup' ? `
        <label class="f">Business name<input name="business" required></label>
        <label class="f">Your name<input name="name" required></label>
        <div class="row"><label class="f grow">State<input name="state" list="states" autocomplete="off" placeholder="e.g. Rajasthan" required></label>
        <label class="f grow">GSTIN (optional)<input name="gstin" maxlength="15"></label></div>` : ''}
      <label class="f">Email<input name="email" type="email" autocomplete="email" required></label>
      ${mode === 'forgot' ? '' : `<label class="f">Password<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8"></label>`}
      ${mode === 'login' ? '<p class="forgot"><a href="#" data-m="forgot">Forgot password?</a></p>' : ''}
      <button class="btn primary">${mode === 'login' ? 'Sign in' : mode === 'forgot' ? 'Send reset link' : 'Create account'}</button>
      <p class="muted">${mode === 'login' ? `New here? <a href="#" data-m="signup">Create a free account</a>` : mode === 'forgot' ? `Remembered it? <a href="#" data-m="login">Sign in</a>` : `Already have an account? <a href="#" data-m="login">Sign in</a>`}</p>
    </form></div></div>`;
  $$('[data-m]').forEach((a) => a.onclick = (e) => { e.preventDefault(); renderAuth(e.target.dataset.m); });
  $('#authlang').onclick = (e) => { e.preventDefault(); switchLang(); };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = $('button', e.target); btn.disabled = true;
    try {
      if (mode === 'forgot') {
        const r = await POST('/api/auth/forgot', body);
        e.target.innerHTML = `<h1>${r.mail ? 'Check your email' : 'Ask your business owner'}</h1>
          <p>${r.mail ? `If <b>${esc(body.email)}</b> has a SmartTrader account, a link to set a new password is on its way. Check your inbox and spam folder. The link works once, for 30 minutes.`
            : 'Password reset by e-mail is not switched on yet. Ask your business owner to set a new password for you in Settings &rarr; Users &rarr; Set password.'}</p>
          <p class="muted"><a href="#" data-m="login">Back to sign in</a></p>`;
        $$('[data-m]', e.target).forEach((a) => a.onclick = (ev) => { ev.preventDefault(); renderAuth('login'); });
        return;
      }
      const r = await POST('/api/auth/' + mode, body);
      if (mode === 'login' && r.need_code) { askCode(e.target); return; }
      if (mode === 'signup' && r.verify) {         // the account is made when the owner opens the e-mailed link
        e.target.innerHTML = `<h1>Check your email</h1>
          <p>We sent a link to <b>${esc(body.email)}</b>. Open it to confirm your address and start your free trial. Look in the spam folder too. The link works once, for 24 hours.</p>
          <p class="muted">Wrong address? <a href="#" data-m="signup">Start again</a></p>`;
        $$('[data-m]', e.target).forEach((a) => a.onclick = (ev) => { ev.preventDefault(); renderAuth('signup'); });
        return;
      }
      if (/^#\/?(signup|login)/.test(location.hash)) history.replaceState(null, '', '/#/dashboard');
      await boot();
    } catch (err) {
      if (err.data && err.data.need_code) askCode(e.target);
      const b = $('.err', e.target); b.hidden = false; b.textContent = err.message;
    } finally { btn.disabled = false; }
  };
}
/* two-step sign-in: the password was right, so the form asks for the code from the authenticator app */
function askCode(form) {
  if (!$('#codef', form)) {
    $('button.primary', form).insertAdjacentHTML('beforebegin', `<label class="f" id="codef">Code from your authenticator app
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required placeholder="6-digit code"></label>
      <p class="muted small">Phone not with you? Type one of your backup codes.</p>`);
    $('button.primary', form).textContent = 'Verify and sign in';
    $('.err', form).hidden = true;
  }
  $('[name=code]', form).value = '';
  $('[name=code]', form).focus();
}

/* Forgot password: the e-mail link opens #/reset/<token> (no login needed) */
function renderReset(token) {
  $('#app').innerHTML = `<div class="auth"><div class="box"><form id="reset-form">
    <div class="brandline"><i>&#x2197;</i>SmartTrader ERP</div>
    <h1>Set a new password</h1>
    <div class="err" hidden></div>
    <label class="f">New password<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
    <label class="f">Type it again<input name="password2" type="password" autocomplete="new-password" required minlength="8"></label>
    <button class="btn primary">Save and sign in</button>
    <p class="muted"><a href="/">Back to sign in</a></p>
  </form></div></div>`;
  $('#reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target)), b = $('.err', e.target), btn = $('button', e.target);
    b.hidden = true;
    if (v.password !== v.password2) { b.hidden = false; b.textContent = 'The two passwords are not the same.'; return; }
    btn.disabled = true;
    try {
      const r = await POST('/api/auth/reset', { token, password: v.password });
      if (r.signin) {          // two-step sign-in is on: the link alone does not sign in
        e.target.innerHTML = '<h1>Password changed</h1><p>Two-step sign-in is on for this account, so sign in with the new password and the code from your authenticator app.</p><p><a class="btn primary" href="/#/login">Sign in</a></p>';
        return;
      }
      history.replaceState(null, '', '/#/dashboard');
      await boot();
    } catch (err) { b.hidden = false; b.textContent = err.message; } finally { btn.disabled = false; }
  };
}

/* The sign-up e-mail link opens #/verify/<token>: one tap creates the business and signs the owner in */
function renderVerify(token) {
  $('#app').innerHTML = `<div class="auth"><div class="box"><form id="verify-form">
    <div class="brandline"><i>&#x2197;</i>SmartTrader ERP</div>
    <h1>Confirm your email</h1>
    <div class="err" hidden></div>
    <p>Tap the button to create your business account and start your free trial.</p>
    <button class="btn primary">Confirm and start</button>
    <p class="muted"><a href="/">Back to sign in</a></p>
  </form></div></div>`;
  $('#verify-form').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('.err', e.target), btn = $('button', e.target);
    b.hidden = true; btn.disabled = true;
    try {
      await POST('/api/auth/verify', { token });
      history.replaceState(null, '', '/#/dashboard');
      await boot();
    } catch (err) { b.hidden = false; b.textContent = err.message; } finally { btn.disabled = false; }
  };
}

/* ======================================================================= shell & router */
/* Modules most small shops do not need. Simple mode (the default) hides them; Settings → Advanced shows them.
   Nothing is deleted: the screens and data stay, only the menu and buttons change. */
const ADVANCED = new Set(['sales/SO', 'sales/DN', 'sales/QUOTE', 'purchase/PO', 'gate/in', 'purchase/GRN', 'gate/out', 'stockcount', 'pending', 'wave', 'dispatch']);
const ADV_DOCS = ['QUOTE', 'SO', 'DN', 'PO', 'GRN'];
const simple = () => !ME || (ME.org.mode || 'simple') !== 'advanced';
/* Settings → Orders & dispatch turns on the order flow (Sales Order → pack → courier) even in Simple mode */
const dispatchOn = () => !!(ME && ME.org && ME.org.workflow && ME.org.workflow.dispatch);
const DISP = new Set(['sales/SO', 'sales/DN', 'pending', 'wave', 'dispatch']);
/* Settings → Business type & menu: each module of the app on or off for the whole business (orgs.setup.modules). A module
   left unset follows Simple / Advanced mode; one the owner set wins over it. Opt-in modules (job cards) show only when on. */
const MODULES = [
  ['pos', 'Quick Bill counter (POS)', 'Fast billing with barcode, camera and Bolkar (voice)', ['pos']],
  ['orders', 'Sales orders, delivery & dispatch', 'Order first, pack and deliver later: delivery notes, pick lists, Dispatch Desk', ['sales/SO', 'sales/DN', 'dispatch', 'pending', 'wave']],
  ['quotes', 'Quotations / estimates', 'Send a price first; turn it into an order or bill in one tap', ['sales/QUOTE']],
  ['procure', 'Purchase orders, goods receipt & gate', 'PO → GRN → bill, receive goods by scan, gate entry, transit claims', ['purchase/PO', 'purchase/GRN', 'gate/in', 'gate/out', 'receive', 'claims']],
  ['khata', 'Khata, vasooli & vaade', 'Udhaar book, WhatsApp reminders, payment promises', ['khata', 'reminders', 'vaade']],
  ['loyalty', 'Loyalty points', 'Customers earn points on bills and use them later', ['loyalty']],
  ['shop', 'Online catalogue', 'Your rate list on a link; orders come on WhatsApp', ['shop']],
  ['channels', 'Amazon / Flipkart / web store orders', 'Import marketplace orders, settlements and returns', ['channels']],
  ['restaurant', 'Tables & KOT', 'Restaurant tables, kitchen tickets, table bills', ['tables', 'kots']],
  ['jobs', 'Repair & service job cards', 'Device / vehicle intake, status, WhatsApp updates, bill from the job', ['jobs']],
  ['wms', 'Bins, racks & stock count', 'Where each item sits, guided put-away, cycle count', ['bins', 'putaway', 'stockcount']],
  ['batch', 'Batch & expiry', 'Medicines, food, cosmetics: first to expire goes first', ['expiry']],
  ['serial', 'Serial / IMEI & warranty', 'Mobiles, electronics, appliances', ['serials']],
  ['mfg', 'Production (recipe / BOM)', 'Make goods from raw material', ['production']],
  ['recurring', 'Recurring bills', 'Rent, AMC, tuition, monthly supply: bills make themselves', ['recurring']],
  ['staff', 'Staff attendance & salary', 'Attendance, advances, salary slips, PF / ESI / professional tax, ECR file', ['staff', 'statutory']],
  ['books', 'Advanced accounts', 'Bank reconciliation, fixed assets, TDS, journals, chart of accounts', ['bankrec', 'assets', 'tds', 'journal', 'accounts', 'daybook']],
];
const SCREEN_MOD = new Map(MODULES.flatMap(([k, , , scr]) => scr.map((h) => [h, k])));
const OPT_IN = new Set(['jobs']);
const modState = (h) => { const m = ((ME && ME.org && ME.org.setup) || {}).modules || {}, k = SCREEN_MOD.get(h) || h; return Object.hasOwn(m, k) ? m[k] === true : null; };
const ordersOn = () => dispatchOn() || modState('orders') === true;
const flowOk = (h) => !simple() || (ordersOn() && DISP.has(h));
const docFlowOk = (k) => !simple() || !ADV_DOCS.includes(k) || (ordersOn() && ['SO', 'DN'].includes(k)) || (k === 'QUOTE' && modState('quotes') === true)
  || (['PO', 'GRN'].includes(k) && modState('procure') === true);
/* which permission area a menu entry needs (custom roles may not see every area); the gate register also opens with 'gate' */
const navArea = (h) => h === 'dispatch' ? ['items', 'sales'] : h === 'jobs' ? 'sales' : /^(receipts|payments|expenses|accounts|journal|staff|statutory|bankrec|assets|tds)$/.test(h) ? 'finance' : /^(sales\/|pos$|recurring$|channels$|shop$|loyalty$|tables$|table\/|kots$)/.test(h) ? 'sales' : /^(purchase\/|receive$)/.test(h) ? 'purchase'
  : /^gate\/in$/.test(h) ? ['purchase', 'gate'] : /^gate\/out$/.test(h) ? ['items', 'gate'] : h === 'claims' ? ['purchase', 'finance'] : h === 'wa-inbox' ? ['sales', 'khata', 'finance']
  : /^(items|stock|stockcount|pending|bins|expiry|stock-ageing|serials|production|wave|putaway)$/.test(h) ? 'items' : /^(parties|reminders)$/.test(h) ? 'masters' : /^(khata|vaade)$/.test(h) ? 'khata'
  : /^(reports\/|tally$|daybook$|gstr$)/.test(h) ? 'reports' : h === 'plan' ? 'settings' : '';
const seen = (h) => {
  if (h === 'cash') return !ME.view || ME.view.finance !== false || ME.view.reports !== false;
  if (h === 'wa-inbox' && !(ME.wa_bot && ME.org.wa_bot)) return false;      // only once the shop turned the bot on
  const a = navArea(h);
  return !a || !ME.view || [].concat(a).some((x) => ME.view[x] !== false);
};
/* Each user's own menu (Settings → Users → Menu): a job picks the screens, or the owner ticks them one by one, plus the
   screen the app opens on. Without one, the role picks the job. Only the menu changes; what a user may do stays with the role. */
const JOBS = {
  all: { t: 'Owner / manager: everything', home: 'dashboard' },
  counter: { t: 'Billing counter', home: 'pos', screens: ['pos', 'jobs', 'sales/INV', 'sales/SRET', 'receipts', 'khata', 'parties', 'items', 'stock', 'serials', 'wa-inbox'] },
  store: { t: 'Godown / store keeper', home: 'receive', screens: ['receive', 'dispatch', 'gate/in', 'purchase/GRN', 'purchase/PO', 'purchase/PRET', 'putaway', 'bins', 'items', 'stock', 'expiry', 'serials',
    'production', 'stockcount', 'wave', 'pending', 'gate/out', 'stock-ageing', 'claims'] },
  packer: { t: 'Packing & dispatch (godown)', home: 'dispatch', screens: ['dispatch', 'pending', 'wave', 'sales/SO', 'sales/DN', 'items', 'stock', 'bins', 'receive', 'putaway', 'stockcount'] },
  gate: { t: 'Gate / security guard', home: 'gate/in', screens: ['gate/in', 'gate/out'] },
  waiter: { t: 'Waiter / captain (restaurant)', home: 'tables', screens: ['tables', 'kots', 'pos'] },
  accounts: { t: 'Accountant', home: 'dashboard', screens: ['dashboard', 'sales/INV', 'sales/SRET', 'sales/CNOTE', 'receipts', 'purchase/BILL', 'purchase/PRET', 'purchase/DNOTE', 'payments',
    'parties', 'khata', 'reminders', 'vaade', 'staff', 'statutory', 'expenses', 'bankrec', 'assets', 'tds', 'accounts', 'journal', 'daybook', 'reports/pnl', 'reports/balance-sheet', 'reports/trial-balance', 'reports/gst', 'gstr', 'reports/ageing',
    'reports/register', 'cash', 'tally', 'claims', 'wa-inbox'] },
  sales: { t: 'Salesman', home: 'sales/INV', screens: ['dashboard', 'pos', 'tables', 'jobs', 'sales/INV', 'shop', 'loyalty', 'sales/QUOTE', 'sales/SO', 'sales/DN', 'sales/SRET', 'receipts', 'channels', 'recurring', 'parties', 'khata',
    'reminders', 'vaade', 'items', 'stock', 'wa-inbox'] },
};
const ROLE_JOB = { owner: 'all', admin: 'all', accountant: 'accounts', store: 'store', sales: 'sales' };
/* screens that follow a document flow the business may have switched off (Simple mode) */
const FLOW = new Set(['sales/SO', 'sales/DN', 'sales/QUOTE', 'purchase/PO', 'wave', 'pending', 'dispatch']);
/* the menu in force: the user's own (Settings → Users → Menu), else the role's (Settings → Roles), else the role's usual job */
const myUi = () => {
  const u = ME.ui || {}, r = ME.role_ui || {}, own = !!(u.job || u.screens);
  return { job: own ? u.job : r.job, screens: own ? u.screens : r.screens, home: u.home || r.home || '' };
};
/* the owner sees, in the last 7 days of a trial or paid plan, that it ends and what stops (staff logins above the free
   plan's limit are paused), with the way to keep it */
function planWarn() {
  const p = ME.plan || {};
  if (ME.user.role_key !== 'owner' || !p.until || p.key === 'free') return '';
  const left = Math.round((new Date(p.until + 'T00:00:00') - new Date(ME.today + 'T00:00:00')) / 864e5);
  if (left > 7 || left < 0) return '';
  return `<div class="closing">Your <b>${esc(p.label)}</b> plan ends ${left === 0 ? '<b>today</b>' : `in <b>${left} day${left === 1 ? '' : 's'}</b> (${fdate(p.until)})`}. After that the Free plan allows 1 user, so staff logins are paused. <a href="#/plan">Keep the plan</a></div>`;
}
const jobOf = (ui = myUi()) => (JOBS[ui.job] ? ui.job : ROLE_JOB[ME.user.role_key] || 'all');
/* is this menu entry on the user's menu? (whether the role may open it is seen()) */
function onMenu(h) {
  const ui = myUi();
  if (ui.screens) return ui.screens.includes(h);
  const m = modState(h);                       // the owner's module switch (Settings → Business type & menu) wins
  if (m === false || (OPT_IN.has(h) && m !== true)) return false;
  const job = JOBS[jobOf(ui)];
  if (!job.screens) return m === true || !ADVANCED.has(h) || flowOk(h);
  return job.screens.includes(h) && (m === true || !FLOW.has(h) || flowOk(h));
}
const myHome = () => { const ui = myUi(); const h = ui.home || JOBS[jobOf(ui)].home; return h === 'dashboard' || seen(h) ? h : 'dashboard'; };
const limits = () => (ME && ME.rules) || {};
/* the oldest date the role may put on a bill or payment ('' = any) */
const minDate = () => {
  const n = limits().backdate_days;
  if (n === null || n === undefined) return '';
  const t = new Date(ME.today + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};
const NAV = [
  ['', [['dashboard', 'Dashboard']]],
  ['Sales', [['pos', 'Quick Bill (POS)'], ['tables', 'Tables (Restaurant)'], ['sales/INV', 'Invoices'], ['shop', 'Online Catalogue'], ['loyalty', 'Loyalty Points'], ['channels', 'Online Orders (Amazon…)'], ['recurring', 'Recurring Bills'], ['jobs', 'Repair / Job Cards'], ['sales/SO', 'Sales Orders'], ['dispatch', 'Dispatch Desk'], ['sales/DN', 'Delivery Notes'], ['sales/QUOTE', 'Quotations'], ['sales/SRET', 'Sales Returns'], ['sales/CNOTE', 'Credit Notes (rate diff)'], ['receipts', 'Receipts']]],
  ['Purchase', [['receive', 'Receive Goods (scan)'], ['purchase/PO', 'Purchase Orders'], ['gate/in', 'Gate Entry (inward)'], ['purchase/GRN', 'Goods Receipts (GRN)'], ['purchase/BILL', 'Purchase Bills'], ['purchase/PRET', 'Purchase Returns'], ['purchase/DNOTE', 'Debit Notes (rate diff)'], ['claims', 'Transit Claims'], ['payments', 'Payments']]],
  ['Inventory', [['items', 'Items'], ['stock', 'Stock & Godowns'], ['stock-ageing', 'Stock Ageing'], ['bins', 'Bins & Racks'], ['expiry', 'Batch & Expiry'], ['serials', 'Serial / IMEI'], ['production', 'Production (BOM)'], ['wave', 'Wave Pick List'], ['stockcount', 'Stock Count'], ['gate/out', 'Gate Pass (outward)'], ['pending', 'Pending Orders']]],
  ['Contacts', [['parties', 'Customers & Suppliers'], ['khata', 'Khata Book'], ['reminders', 'Vasooli (Collections)'], ['vaade', 'Vaade (Promises)'], ['wa-inbox', 'WhatsApp Inbox']]],
  ['Accounts', [['staff', 'Staff & Salary'], ['statutory', 'PF / ESI Return'], ['expenses', 'Expenses'], ['bankrec', 'Bank Reconciliation'], ['assets', 'Fixed Assets'], ['tds', 'TDS'], ['accounts', 'Chart of Accounts'], ['journal', 'Journal Voucher'], ['daybook', 'Day Book']]],
  ['Reports', [['reports/pnl', 'Profit & Loss'], ['reports/balance-sheet', 'Balance Sheet'], ['reports/trial-balance', 'Trial Balance'], ['reports/gst', 'GST Summary'], ['gstr', 'GST Returns (GSTR-1, 2B)'], ['reports/ageing', 'Outstanding (Ageing)'], ['reports/register', 'Registers'], ['cash', 'Kal ka Cash'], ['tally', 'Tally Export']]],
  ['Settings', [['settings', 'Settings'], ['plan', 'Plan & Billing']]],
];

/* the + New menu: the everyday actions, only those the user's role may do */
const NEW_MENU = [['new/INV', 'Sales invoice', 'sales', 'sales/INV', 'doc'], ['jobs?new=1', 'Job card (repair)', 'sales', 'jobs', 'doc'], ['new/SO', 'Sales order', 'sales', 'sales/SO', 'doc'], ['pos', 'Quick bill (POS)', 'sales', 'pos', 'bolt'], ['new/BILL', 'Purchase bill', 'purchase', 'purchase/BILL', 'cart'],
  ['receive', 'Receive goods', 'purchase', 'receive', 'box'], ['gate/in?new=1', 'Gate entry', 'gate', 'gate/in', 'truck'], ['receipts?new=1', 'Receive payment', 'finance', 'receipts', 'in'],
  ['payments?new=1', 'Pay a supplier', 'finance', 'payments', 'out'], ['expenses?new=1', 'Expense', 'finance', 'expenses', 'wallet'], ['khata?new=1', 'Khata entry', 'khata', 'khata', 'book'],
  ['items?new=1', 'Product / item', 'items', 'items', 'tag'], ['parties?new=1', 'Customer / supplier', 'masters', 'parties', 'user'], ['stock', 'See stock', 'items', 'stock', 'layers']];
/* one line-icon set (24-unit grid, drawn with the text colour) for the quick actions and the dashboard */
const ICONS = {
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>', bolt: '<path d="M13 2 5 14h6l-1 8 8-12h-6z"/>', cart: '<path d="M3 4h2l2.5 11h10L20 7H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>', truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  in: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v3h16v-3"/>', out: '<path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M4 17v3h16v-3"/>', wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9H3z"/><path d="M3 7V5h13v2M16 13h2"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>', tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>', home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
};
const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ''}</svg>`;

/* Simple mode (the default) keeps the everyday screens in the menu and puts the specialist ones under "More features",
   one tap away and remembered open. Advanced mode, or a menu the owner made for a user, shows its screens as they are. */
const EXTRA = new Set(['channels', 'recurring', 'sales/CNOTE', 'purchase/DNOTE', 'claims', 'receive', 'stock-ageing', 'bins', 'expiry', 'serials', 'production', 'putaway',
  'vaade', 'wa-inbox', 'staff', 'statutory', 'bankrec', 'assets', 'tds', 'accounts', 'journal', 'daybook', 'reports/balance-sheet', 'reports/trial-balance', 'reports/register', 'cash', 'tally']);
function navHtml() {
  const groups = NAV.map(([g, all]) => [g, all.filter(([h]) => onMenu(h) && seen(h))]);
  const fold = simple() && !myUi().screens && jobOf() === 'all';
  const block = (list) => list.filter(([, it]) => it.length).map(([g, it]) => `${g ? `<div class="nav-group">${g}</div>` : ''}${it.map(([h, t]) => `<a href="#/${h}" data-h="${h}">${t}</a>`).join('')}`).join('');
  if (!fold) return block(groups);
  const extra = (h) => EXTRA.has(h) && modState(h) !== true;      // a module the owner switched on stays in the main menu
  const main = groups.map(([g, it]) => [g, it.filter(([h]) => !extra(h))]), more = groups.map(([g, it]) => [g, it.filter(([h]) => extra(h))]);
  const n = more.reduce((k, [, it]) => k + it.length, 0);
  if (!n) return block(groups);
  const here = location.hash.replace(/^#\/?/, '').split('?')[0];
  let open = EXTRA.has(here);
  try { open = open || localStorage.getItem('st:navmore') === '1'; } catch (e) { /* storage off */ }
  return block(main) + `<details class="nav-more" id="navmore" ${open ? 'open' : ''}><summary>More features <span>${n}</span></summary>${block(more)}</details>`;
}
/* Hide amounts: blurs totals and money columns on this device, for a counter screen customers can see */
function hideAmounts(on) {
  document.body.classList.toggle('hide-amt', on);
  const b = $('#hideamt'); if (b) { b.setAttribute('aria-pressed', String(on)); $('span', b).textContent = on ? 'Show' : 'Hide'; }
}
const storeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } };
/* Hindi screens (public/i18n-hi.js): whole English labels are swapped for Hindi as they are drawn, by one observer on the page.
   Names, numbers and what people type never match a label, so they stay as they are; printed bills and codes are left alone. */
const LANG = storeGet('st:lang') === 'hi' ? 'hi' : 'en';
let HI = null;
const KEEP_SEL = 'script,style,textarea,.doc-paper,.labels,.codes,.mono,[data-keep]';
function swapText(n) {
  const t = n.nodeValue, k = t.trim();
  if (!k || !Object.hasOwn(HI, k) || !n.parentElement || n.parentElement.closest(KEEP_SEL)) return;
  n.nodeValue = t.replace(k, HI[k]);
}
function hindi(root) {
  if (!HI || !root) return;
  if (root.nodeType === 3) { swapText(root); return; }
  if (root.nodeType !== 1 || root.closest(KEEP_SEL)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) swapText(n);
  for (const el of [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')]) {
    for (const a of ['placeholder', 'title', 'aria-label']) { const v = (el.getAttribute(a) || '').trim(); if (v && Object.hasOwn(HI, v)) el.setAttribute(a, HI[v]); }
  }
}
let hindiOn = false;
async function startHindi() {
  if (LANG !== 'hi' || hindiOn) return;
  hindiOn = true;
  try { ({ HI } = await import('/i18n-hi.js')); } catch (e) { return; }
  document.documentElement.lang = 'hi';
  hindi(document.body);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) hindi(n); }).observe(document.body, { childList: true, subtree: true });
}
const switchLang = () => { storeSet('st:lang', LANG === 'hi' ? 'en' : 'hi'); location.reload(); };
function shell() {
  // the gate entry is a quick action only for those who do not make bills (guard, godown)
  const news = NEW_MENU.filter(([, , a, h]) => ME.can[a] && onMenu(h) && (h !== 'gate/in' || !onMenu('purchase/BILL')));
  $('#app').innerHTML = `<div class="shell">
    <nav class="side" id="side">
      <div class="brand"><i>&#x2197;</i><span>SmartTrader<small>${esc(ME.org.name)}</small></span></div>
      ${navHtml()}
      <div class="side-foot"><div class="muted">${esc(ME.user.name)} &middot; ${esc(ME.user.role)}${onMenu('settings') ? '' : ' &middot; <a href="#/settings">My account</a>'}</div>
        <button class="btn sm" id="install" hidden>Install app</button><a class="btn sm" href="https://wa.me/919068446139?text=${encodeURIComponent('Hi, I need help with SmartTrader ERP')}" target="_blank" rel="noopener" title="WhatsApp support: +91 90684 46139">Help</a><button class="btn sm" id="logout">Sign out</button></div>
    </nav>
    <div class="main">
      <header class="top">
        <button class="btn sm burger" id="burger" aria-label="Menu">&#9776;</button>
        <strong class="orgname">${esc(ME.org.name)}</strong>
        <a class="btn sm outbox" id="outbox" href="#/outbox" hidden title="Saved without internet, waiting to be sent"></a>
        <button class="btn sm hideamt" id="hideamt" type="button" title="Hide amounts on screen (for when customers can see it)" aria-pressed="false">₹<span>Hide</span></button>
        <button class="btn sm" id="langbtn" type="button" title="${LANG === 'hi' ? 'Show the app in English' : 'ऐप हिंदी में देखें'}" lang="${LANG === 'hi' ? 'en' : 'hi'}">${LANG === 'hi' ? 'EN' : 'हिं'}</button>
        <div class="gsearch"><input id="gq" type="search" placeholder="Search items, customers, bills…" autocomplete="off" aria-label="Search" enterkeyhint="search">
          <div class="gres" id="gres" hidden></div></div>
        <button class="btn sm cmdbtn hide-sm" id="cmdbtn" type="button" title="Go to or do anything (Ctrl K)">${icon('grid')}<kbd>Ctrl K</kbd></button>
        <div class="bellbox"><button class="btn sm bell" id="bell" type="button" aria-haspopup="true" aria-expanded="false" title="What needs doing">${icon('bell')}<span class="bcount" id="bcount" hidden></span></button>
          <div class="menu bellmenu" id="bellmenu" hidden></div></div>
        ${news.length ? `<div class="newmenu"><button class="btn primary" id="newbtn" aria-haspopup="true" aria-expanded="false">+ <span>New</span></button>
          <div class="menu qmenu" id="newmenu" hidden>${news.map(([h, t, , , ic]) => `<a href="#/${h}">${icon(ic)}<span>${t}</span></a>`).join('')}</div></div>` : ''}
      </header>
      ${planWarn()}${ME.org.close_after && ME.user.role_key === 'owner' ? `<div class="closing">This business will be deleted on <b>${fdate(ME.org.close_after.slice(0, 10))}</b>. <a href="#/settings/security">Keep it (cancel)</a> · <a href="#/settings?backup=1">Download a backup</a></div>` : ''}
      <main class="page" id="page"></main>
    </div></div><div class="scrim" id="scrim"></div>
    <nav class="bnav" id="bnav" aria-label="Main">${bnavItems().map(([h, t, ic, act]) => `<a href="${h ? '#/' + h : '#'}" ${act ? `data-bn="${act}"` : `data-h="${h}"`}>${icon(ic)}<span>${t}</span></a>`).join('')}</nav>`;
  hideAmounts(storeGet('st:hideamt') === '1');
  $('#langbtn').onclick = switchLang;
  $('#hideamt').onclick = () => { const on = !document.body.classList.contains('hide-amt'); hideAmounts(on); storeSet('st:hideamt', on ? '1' : '0'); };
  $('#burger').onclick = () => menu(!$('#side').classList.contains('open'));
  if ($('#navmore')) $('#navmore').addEventListener('toggle', (e) => { try { localStorage.setItem('st:navmore', e.target.open ? '1' : '0'); } catch (err) { /* storage off */ } });
  $('#scrim').onclick = () => menu(false);
  // a tap on a menu entry closes the menu at once (the slide runs on the GPU while the page loads)
  $('#side').addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) menu(false); });
  $('#logout').onclick = async () => {
    const waiting = (await queueAll()).length;
    if (waiting && !confirm(`${waiting} entr${waiting === 1 ? 'y was' : 'ies were'} saved without internet and not sent yet. Signing out deletes ${waiting === 1 ? 'it' : 'them'}. Sign out anyway?`)) return;
    await POST('/api/auth/logout').catch(() => {}); await offClear(); ME = null; remember(false); location.hash = ''; renderAuth();
  };
  const nb = $('#newbtn'), nm = $('#newmenu');
  if (nb) {
    nb.onclick = (e) => { e.stopPropagation(); nm.hidden = !nm.hidden; nb.setAttribute('aria-expanded', String(!nm.hidden)); fitMenu(nm); };
    nm.onclick = () => { nm.hidden = true; };
  }
  wireSearch();
  $('#cmdbtn').onclick = palette;
  wireBell();
  $('#bnav').addEventListener('click', (e) => {
    const a = e.target.closest('[data-bn]'); if (!a) return;
    e.preventDefault();
    if (a.dataset.bn === 'menu') menu(true);
    if (a.dataset.bn === 'new') quickSheet();
  });
  // lists that arrive after a screen has drawn (a report tab, a search) get the same sort / filter / download
  let pend = 0;
  new MutationObserver(() => { if (!pend) pend = requestAnimationFrame(() => { pend = 0; enhanceTables($('#page')); enhanceSelects($('#page')); }); }).observe($('#page'), { childList: true, subtree: true });
}
/* the phone's bottom bar: home, the billing screen this user has, quick actions, money owed, the full menu */
function bnavItems() {
  const ok = (h) => onMenu(h) && seen(h);
  const bill = ok('pos') ? ['pos', 'Bill', 'bolt'] : ok('sales/INV') ? ['new/INV', 'Bill', 'doc'] : ok('receive') ? ['receive', 'Receive', 'box'] : null;
  const owe = ok('khata') ? ['khata', 'Khata', 'book'] : ok('parties') ? ['parties', 'Parties', 'user'] : ok('stock') ? ['stock', 'Stock', 'layers'] : null;
  return [['dashboard', 'Home', 'home'], bill, ['', 'New', 'plus', 'new'], owe, ['', 'Menu', 'menu', 'menu']].filter(Boolean);
}
function quickSheet() {
  const acts = NEW_MENU.filter(([, , a, h]) => ME.can[a] && onMenu(h));
  modal('Quick actions', [], async () => {}, { submit: 'Close', intro: `<div class="qmenu qsheet">${acts.map(([h, t, , , ic]) => `<a href="#/${h}">${icon(ic)}<span>${t}</span></a>`).join('')}</div>` });
  $('.qsheet').addEventListener('click', (e) => { if (e.target.closest('a')) $('#modal-root').innerHTML = ''; });
}
/* the bell: the Today list (what needs doing), counted on the button and one tap each from the menu */
let bellAt = 0;
async function refreshBell() {
  const btn = $('#bell'); if (!btn) return;
  let t = null;
  try { t = await GET('/api/today'); } catch (e) { return; }
  const rows = (t && t.rows || []).filter((r) => TODAY[r.key]);
  const c = $('#bcount'); c.hidden = !rows.length; c.textContent = rows.length > 9 ? '9+' : String(rows.length);
  btn.title = rows.length ? `${rows.length} thing${rows.length === 1 ? '' : 's'} need doing` : 'Nothing needs doing';
  $('#bellmenu').innerHTML = `<div class="bellh"><b>What needs doing</b><a href="#/dashboard">Dashboard</a></div>` + (rows.length ? rows.map((r) => {
    let [tone, text, href, cta] = TODAY[r.key]; if (LANG === 'hi' && TODAY_HI[r.key]) [text, cta] = TODAY_HI[r.key];
    return `<a class="t-${tone}" href="${href}"><i></i><span>${esc(text(r.n, r))}${r.value ? ` <b>${inr0(r.value)}</b>` : ''}</span><em>${cta} ›</em></a>`;
  }).join('') : '<p class="muted small" style="padding:8px 12px">Nothing pending. Sab theek hai ✓</p>');
  bellAt = Date.now();
}
/* A dropdown hangs from its button's right edge; on a phone the bell and "More" sit far from the right, so a
   menu opened there ran off the left side of the screen. It is moved back onto the screen, and kept above
   the bottom bar (scrolling inside when it is taller than the room left). */
function fitMenu(m) {
  if (!m || m.hidden || !m.isConnected) return;
  m.style.transform = ''; m.style.maxHeight = ''; m.style.overflowY = '';
  const r = m.getBoundingClientRect();
  if (!r.width) return;
  const vw = document.documentElement.clientWidth, pad = 8;
  const dx = r.left < pad ? pad - r.left : r.right > vw - pad ? Math.max(pad - r.left, vw - pad - r.right) : 0;
  if (dx) m.style.transform = `translateX(${Math.round(dx)}px)`;
  const bar = $('.bnav'), barH = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0;
  const room = window.innerHeight - barH - r.top - pad;
  if (r.height > room && room > 120) { m.style.maxHeight = Math.floor(room) + 'px'; m.style.overflowY = 'auto'; }
}
document.addEventListener('toggle', (e) => { const d = e.target; if (d && d.matches && d.matches('details.more-menu') && d.open) fitMenu($(':scope > .menu', d)); }, true);
window.addEventListener('resize', () => { $$('details.more-menu[open] > .menu, #bellmenu:not([hidden]), #newmenu:not([hidden])').forEach(fitMenu); });
function wireBell() {
  const btn = $('#bell'), box = $('#bellmenu');
  btn.onclick = (e) => { e.stopPropagation(); box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); fitMenu(box); if (!box.hidden && Date.now() - bellAt > 60000) refreshBell().then(() => fitMenu(box)); };
  box.onclick = (e) => { if (e.target.closest('a')) box.hidden = true; };
  refreshBell();
  setInterval(() => { if (document.visibilityState === 'visible' && ME) refreshBell(); }, 5 * 60000);
}
/* buttons marked data-act (the page has no inline scripts, so a strict Content-Security-Policy can be used) */
const ACTS = { print: () => window.print(), back: () => history.back(), reload: () => location.reload() };
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act && Object.hasOwn(ACTS, act.dataset.act)) { e.preventDefault(); ACTS[act.dataset.act](); return; }
  const nm = $('#newmenu'); if (nm && !e.target.closest('.newmenu')) nm.hidden = true;
  const gr = $('#gres'); if (gr && !e.target.closest('.gsearch')) gr.hidden = true;
  const bm = $('#bellmenu'); if (bm && !e.target.closest('.bellbox')) bm.hidden = true;
  $$('.more-menu[open]').forEach((d) => { if (!d.contains(e.target) || e.target.closest('.menu')) d.removeAttribute('open'); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input,textarea,select') && $('#gq')) { e.preventDefault(); $('#gq').focus(); }
});

/* Search in the top bar: items, customers & suppliers, bills (one API call, after a short pause in typing) */
function wireSearch() {
  const q = $('#gq'), box = $('#gres');
  let timer = 0, last = '';
  const show = (r, text) => {
    const doc = (d) => `<a href="#/doc/${d.id}"><b>${esc(d.number)}</b> <span class="muted">${esc(d.label)} &middot; ${esc(d.party || '')} &middot; ${inr(d.total)}</span></a>`;
    const party = (p) => `<a href="#/${ME.view && ME.view.masters === false ? 'khata' : 'party'}/${p.id}"><b>${esc(p.name)}</b> <span class="muted">${esc(p.kind)}${p.phone ? ' &middot; ' + esc(p.phone) : ''}</span></a>`;
    const item = (i) => `<a href="#/item/${i.id}"><b>${esc(i.name)}</b> <span class="muted">${inr(shownPrice(i))}${i.is_service ? '' : ` &middot; ${qtyf(i.qty_on_hand)} ${esc(i.unit)} in stock`}</span></a>`;
    const grp = (t, rows, f) => rows.length ? `<div class="g">${t}</div>${rows.map(f).join('')}` : '';
    const html = grp('Bills & documents', r.docs, doc) + grp('Customers & suppliers', r.parties, party) + grp('Items', r.items, item);
    box.innerHTML = html || `<div class="none">Nothing found for “${esc(text)}”.</div>`;
    box.hidden = false;
  };
  q.oninput = () => {
    clearTimeout(timer);
    const text = q.value.trim();
    if (text.length < 2) { box.hidden = true; return; }
    timer = setTimeout(async () => {
      if (text === last) { box.hidden = false; return; }
      try { const r = await GET('/api/search?q=' + encodeURIComponent(text)); if (q.value.trim() === text) { last = text; show(r, text); } } catch (e) { /* offline: ignore */ }
    }, 280);
  };
  q.onfocus = () => { if (q.value.trim().length >= 2 && box.innerHTML) box.hidden = false; };
  q.onkeydown = (e) => {
    if (e.key === 'Escape') { box.hidden = true; q.blur(); }
    if (e.key === 'Enter') { const a = $('a', box); if (a) { e.preventDefault(); box.hidden = true; q.value = ''; last = ''; q.blur(); location.hash = a.getAttribute('href'); } }
  };
  box.onclick = (e) => { if (e.target.closest('a')) { box.hidden = true; q.value = ''; last = ''; } };
}

const ROUTES = [];
const route = (re, fn) => ROUTES.push([re, fn]);

async function render() {
  if (!ME) return;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = hash.split('?');
  const q = new URLSearchParams(qs || '');
  $$('.side a, .bnav a[data-h]').forEach((a) => a.classList.toggle('on', path === a.dataset.h || (path.startsWith(a.dataset.h + '/') && a.dataset.h !== '')));
  menu(false);
  const page = $('#page');
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    page.innerHTML = '<div class="muted">Loading&hellip;</div>';
    page.onclick = page.onkeydown = page.onchange = null;     // a page's own handlers must not outlive it
    rendering = true;
    document.body.classList.toggle('no-bnav', /^(new\/|pos$|table\/|receive$|stockcount$)/.test(path));
    try { await fn(page, m, q); enhanceTables(page); enhanceSelects(page); rememberPage(hash); const tab = $('.tabs a.on', page); if (tab && tab.parentNode.scrollWidth > tab.parentNode.clientWidth) tab.parentNode.scrollLeft = tab.offsetLeft - tab.parentNode.offsetLeft - 16; } catch (e) {
      if (e.status === 0) offlinePage(page);
      else if (e.status !== 401) page.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    } finally { rendering = false; }
    window.scrollTo(0, 0);
    return;
  }
  page.innerHTML = '<div class="empty">Page not found.</div>';
}
const go = (h) => { location.hash = '#/' + h; };

/* ---- recent pages: the last screens this user opened on this device (titles as shown) ---- */
const recentKey = () => (ME ? `st:recent:${ME.org.id}:${ME.user.id}` : '');
function recentPages() { try { return JSON.parse(storeGet(recentKey()) || '[]') || []; } catch (e) { return []; } }
function rememberPage(hash) {
  const h1 = $('#page .page-head h1');
  const t = h1 ? h1.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  if (!t || /^(new|login)/.test(hash)) return;
  const list = recentPages().filter((x) => x.h !== hash);
  list.unshift({ h: hash, t });
  storeSet(recentKey(), JSON.stringify(list.slice(0, 8)));
}

/* ---- command palette (Ctrl+K / ⌘K): screens, quick actions, plain words ("unpaid", "low stock", "gst"), recent pages,
   and the business's own items, customers and bills. Only what this user's role may open is offered. ---- */
const INTENTS = [
  [/\b(unpaid|overdue|due|dues|baaki|baki|udhaar|udhar|vasooli|collect)/, 'reminders', 'Customers who owe money'],
  [/\b(low stock|reorder|kam stock|khatam|out of stock)/, 'new/PO?reorder=1', 'Order what is running low'],
  [/\b(gst|gstr|return|2b|itc)/, 'gstr', 'GST returns'],
  [/\b(profit|loss|p&l|pnl|munafa|nuksan)/, 'reports/pnl', 'Profit & Loss'],
  [/\b(cash|bank|balance|paisa)/, 'cash', 'Cash and bank (Kal ka Cash)'],
  [/\b(backup|drive|restore)/, 'settings?backup=1', 'Backup'],
  [/\b(staff|salary|attendance|hajri)/, 'staff', 'Staff & Salary'],
  [/\b(expir|batch)/, 'expiry', 'Batch & Expiry'],
  [/\b(sales today|aaj|today)/, 'reports/register?type=INV', 'Today’s sales register'],
];
const navAll = () => NAV.flatMap(([g, list]) => list.map(([h, t]) => ({ h, t, g }))).filter((x) => onMenu(x.h) && seen(x.h));
const fuzzy = (text, q) => {
  const t = text.toLowerCase(); if (t.includes(q)) return 100 - t.indexOf(q);
  let i = 0; for (const ch of t) { if (ch === q[i]) i++; if (i === q.length) return 10; }
  return 0;
};
function palette() {
  if ($('#cmdk')) return;
  const root = document.createElement('div');
  root.id = 'cmdk';
  root.innerHTML = `<div class="modal-bg"><div class="cmdk" role="dialog" aria-label="Go to or do anything">
    <input id="cmdq" type="search" placeholder="Type a screen, an action, a customer, an item or a bill number…" autocomplete="off" aria-label="Search">
    <div class="cmdl" id="cmdl" role="listbox"></div>
    <div class="cmdf muted small"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span><kbd>?</kbd> all shortcuts</span></div></div></div>`;
  document.body.appendChild(root);
  const inp = $('#cmdq', root), list = $('#cmdl', root);
  let items = [], at = 0, timer = 0, seq = 0;
  const close = () => { root.remove(); document.removeEventListener('keydown', keys, true); };
  const open = (h) => { close(); if (h) location.hash = '#/' + h.replace(/^#\/?/, ''); };
  const draw = () => {
    let g = '';
    list.innerHTML = items.length ? items.map((x, i) => { const head = x.g !== g ? `<div class="g">${esc(x.g)}</div>` : ''; g = x.g;
      return `${head}<a href="#/${esc(x.h)}" role="option" data-i="${i}" class="${i === at ? 'on' : ''}" aria-selected="${i === at}"><b>${esc(x.t)}</b>${x.s ? ` <span class="muted">${esc(x.s)}</span>` : ''}</a>`; }).join('')
      : '<div class="none">Nothing matches. Try a customer name, an item or a bill number.</div>';
    const on = $('a.on', list); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const build = (qRaw, found) => {
    const q = qRaw.trim().toLowerCase(), out = [];
    const acts = NEW_MENU.filter(([, , a, h]) => ME.can[a] && onMenu(h)).map(([h, t]) => ({ h, t, g: 'Quick actions' }));
    if (!q) {
      out.push(...recentPages().slice(0, 5).map((x) => ({ h: x.h, t: x.t, g: 'Recent' })), ...acts.slice(0, 6));
      out.push(...navAll().slice(0, 8).map((x) => ({ ...x, s: x.g, g: 'Go to' })));
    } else {
      for (const [re, h, t] of INTENTS) if (re.test(q) && (onMenu(h.split(/[/?]/)[0]) || onMenu(h.split('?')[0]))) out.push({ h, t, g: 'Suggested' });
      const hi = (t) => (HI && HI[t]) || '';
      const score = (x) => Math.max(fuzzy(x.t, q), fuzzy(hi(x.t), q), x.g ? fuzzy(x.g, q) / 4 : 0);
      out.push(...acts.map((x) => ({ ...x, sc: score(x) })).filter((x) => x.sc).sort((a, b) => b.sc - a.sc));
      out.push(...navAll().map((x) => ({ ...x, s: x.g, sc: score(x), g: 'Go to' })).filter((x) => x.sc).sort((a, b) => b.sc - a.sc).slice(0, 8));
      if (found) {
        out.push(...found.docs.map((d) => ({ h: `doc/${d.id}`, t: d.number, s: `${d.label} · ${d.party || ''} · ${inr(d.total)}`, g: 'Bills & documents' })));
        out.push(...found.parties.map((p) => ({ h: `${ME.view && ME.view.masters === false ? 'khata' : 'party'}/${p.id}`, t: p.name, s: p.kind + (p.phone ? ' · ' + p.phone : ''), g: 'Customers & suppliers' })));
        out.push(...found.items.map((i) => ({ h: `item/${i.id}`, t: i.name, s: `${inr(shownPrice(i))}${i.is_service ? '' : ` · ${qtyf(i.qty_on_hand)} ${i.unit} in stock`}`, g: 'Items' })));
      }
    }
    items = out.slice(0, 40); at = 0; draw();
  };
  inp.oninput = () => {
    const text = inp.value; build(text);
    clearTimeout(timer);
    if (text.trim().length < 2) return;
    const my = ++seq;
    timer = setTimeout(async () => { try { const r = await GET('/api/search?q=' + encodeURIComponent(text.trim())); if (my === seq) build(text, r); } catch (e) { /* offline: screens still work */ } }, 220);
  };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw(); } }
    else if (e.key === 'Enter' && document.activeElement === inp) { e.preventDefault(); if (items[at]) open(items[at].h); }
  };
  document.addEventListener('keydown', keys, true);
  list.onclick = (e) => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); open(items[+a.dataset.i].h); } };
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  build(''); inp.focus();
}
const SHORTCUTS = [['Ctrl K  /  ⌘K', 'Go to or do anything'], ['/', 'Search items, customers, bills'], ['N', 'Quick actions (+ New)'], ['G then D', 'Dashboard'],
  ['G then I', 'Invoices'], ['G then P', 'Purchase bills'], ['G then S', 'Stock'], ['G then K', 'Khata'], ['G then R', 'Profit & Loss'], ['F9', 'Complete the sale (Quick Bill)'], ['?', 'This list']];
const GO_KEYS = { d: 'dashboard', i: 'sales/INV', p: 'purchase/BILL', s: 'stock', k: 'khata', r: 'reports/pnl' };
let gPending = 0;
document.addEventListener('keydown', (e) => {
  if (!ME || !$('#page')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable]') || $('#cmdk') || $('#modal-root .modal')) return;
  const k = e.key.toLowerCase();
  if (gPending && Date.now() - gPending < 1200 && GO_KEYS[k]) { gPending = 0; if (onMenu(GO_KEYS[k]) && seen(GO_KEYS[k])) go(GO_KEYS[k]); return; }
  gPending = 0;
  if (k === 'g') gPending = Date.now();
  else if (k === 'n' && $('#newbtn')) { e.preventDefault(); $('#newbtn').click(); }
  else if (e.key === '?') modal('Keyboard shortcuts', [], async () => {}, { submit: 'Close', intro: `<table class="t no-tools keys">${SHORTCUTS.map(([a, b]) => `<tr><td><kbd>${esc(a)}</kbd></td><td>${esc(b)}</td></tr>`).join('')}</table>` });
});
/* open / close the phone menu (and its backdrop); scrolls the current page's entry into view when it opens */
function menu(open) {
  const side = $('#side'), scrim = $('#scrim');
  if (!side) return;
  side.classList.toggle('open', open);
  if (scrim) scrim.classList.toggle('on', open);
  document.body.classList.toggle('menu-open', open);
  if (open) { const on = $('.side a.on', side); if (on) on.scrollIntoView({ block: 'center' }); }
}
/* ?new=1 opens a form once; the flag is removed from the address so saving (which re-renders the page) does not open it again */
function takeNew(q) {
  if (!q.get('new')) return false;
  history.replaceState(null, '', location.hash.replace(/([?&])new=1&?/, '$1').replace(/[?&]$/, ''));
  return true;
}
const head = (title, actions = '') => `<div class="page-head"><h1>${title}</h1><span class="spacer"></span>${actions}</div>`;

/* ======================================================================= dashboard */
/* ======================================================================= dashboard and Dashboard Maker */
/* A dashboard is a list of widgets, each with a size (1 to 4 columns), and the period it shows. Every number comes from the
   server for this user's role (src/widgets.js). With no saved dashboard the user gets a ready one for their job; "Customize"
   turns the page into an editor: templates, a widget library, drag or arrows to arrange, sizes, undo / redo, save. */
const DASH_TEMPLATES = {
  owner: ['Business owner', [['today_tasks', 4], ['sales_period', 1], ['receivables', 1], ['payables', 1], ['profit', 1], ['sales_trend', 2], ['cash_flow', 2], ['customer_dues', 2], ['low_stock', 2], ['product_sales', 2], ['recent_activity', 2]]],
  retail: ['Retail store', [['today_tasks', 4], ['sales_today', 1], ['sales_period', 1], ['avg_invoice', 1], ['cash_balance', 1], ['sales_trend', 2], ['product_sales', 2], ['low_stock', 2], ['recent_invoices', 2], ['out_of_stock', 1], ['sales_returns', 1]]],
  wholesale: ['Wholesale business', [['today_tasks', 4], ['sales_period', 1], ['receivables', 1], ['purchase_period', 1], ['payables', 1], ['customer_sales', 2], ['customer_dues', 2], ['supplier_dues', 2], ['fast_moving', 2], ['pending_orders', 1], ['stock_value', 1]]],
  distributor: ['Distributor', [['today_tasks', 4], ['sales_period', 1], ['pending_orders', 1], ['stock_value', 1], ['receivables', 1], ['godown_stock', 2], ['fast_moving', 2], ['slow_moving', 2], ['customer_dues', 2]]],
  finance: ['Finance', [['cash_balance', 1], ['bank_balance', 1], ['receivables', 1], ['payables', 1], ['profit', 1], ['expenses', 1], ['gst_payable', 1], ['sales_period', 1], ['cash_flow', 4], ['customer_dues', 2], ['supplier_dues', 2]]],
  sales: ['Sales', [['today_tasks', 4], ['sales_today', 1], ['sales_period', 1], ['avg_invoice', 1], ['new_customers', 1], ['sales_trend', 4], ['customer_sales', 2], ['product_sales', 2], ['recent_invoices', 2], ['customer_dues', 2]]],
  inventory: ['Inventory', [['today_tasks', 4], ['stock_value', 1], ['out_of_stock', 1], ['pending_orders', 1], ['purchase_period', 1], ['low_stock', 2], ['godown_stock', 2], ['fast_moving', 2], ['slow_moving', 2]]],
  blank: ['Blank', []],
};
/* first run: the kind of business picks the dashboard and the screens worth knowing about first */
/* Business packs (Settings → Business type & menu, and the first-run picker): what a kind of Indian business needs on day
   one. Each pack switches modules on (the rest off), picks the dashboard and what a new item starts with. Everything stays
   changeable, module by module, and each role / user can still get its own menu. */
const PACKS = [
  { k: 'kirana', t: 'Kirana / general store', hi: 'किराना / जनरल स्टोर', ico: '🛒', about: 'Fast counter billing, udhaar khata, loyalty, WhatsApp rate list',
    on: ['pos', 'khata', 'loyalty', 'shop', 'staff'], dash: 'retail', defs: { unit: 'Pcs' }, tips: [['pos', 'Quick Bill with barcode and Bolkar'], ['reminders', 'Vasooli (collections)'], ['shop', 'Online catalogue on WhatsApp']] },
  { k: 'wholesale', t: 'Wholesale / distributor', hi: 'होलसेल / डिस्ट्रीब्यूटर', ico: '🚚', about: 'Orders → delivery → bill, party rates, collections, godown bins',
    on: ['orders', 'quotes', 'procure', 'khata', 'wms', 'staff'], dash: 'wholesale', defs: {}, tips: [['parties', 'Wholesale price lists for customers'], ['reminders', 'Vasooli (collections)'], ['dispatch', 'Dispatch Desk']] },
  { k: 'clothing', t: 'Clothing / footwear / boutique', hi: 'कपड़ा / जूते / बुटीक', ico: '👗', about: 'Sizes & colours with QR labels, counter billing, loyalty, exchanges',
    on: ['pos', 'khata', 'loyalty', 'shop', 'staff'], dash: 'retail', defs: { unit: 'Pcs', gst_rate: 5 }, tips: [['items?variants=1', 'Add sizes & colours'], ['pos', 'Quick Bill with scan'], ['loyalty', 'Loyalty points']] },
  { k: 'online', t: 'Online seller (Instagram / WhatsApp)', hi: 'ऑनलाइन सेलर', ico: '📦', about: 'Orders, COD confirm, scan-to-pack, courier label, tracking, RTO',
    on: ['orders', 'khata', 'shop', 'channels'], dash: 'retail', defs: { unit: 'Pcs' }, workflow: { dispatch: true, confirm_cod: true, default_pay: 'cod' },
    tips: [['settings/workflow', 'Set up orders & dispatch'], ['items?variants=1', 'Add sizes & colours'], ['dispatch', 'Dispatch Desk']] },
  { k: 'pharmacy', t: 'Medical / pharmacy', hi: 'मेडिकल / फार्मेसी', ico: '💊', about: 'Batch & expiry (first to expire goes first), strips & boxes, counter billing',
    on: ['pos', 'khata', 'batch', 'procure', 'staff'], dash: 'inventory', defs: { track_batch: true }, tips: [['expiry', 'Batch and expiry'], ['pos', 'Quick Bill'], ['reminders', 'Vasooli (collections)']] },
  { k: 'electronics', t: 'Mobile / electronics shop', hi: 'मोबाइल / इलेक्ट्रॉनिक्स', ico: '📱', about: 'IMEI / serial with warranty lookup, repair job cards, EMI-style khata',
    on: ['pos', 'khata', 'serial', 'jobs', 'loyalty'], dash: 'retail', defs: { track_serial: true, gst_rate: 18 }, tips: [['serials', 'Serial / IMEI lookup'], ['jobs', 'Repair job cards'], ['pos', 'Quick Bill']] },
  { k: 'repair', t: 'Repair & service centre', hi: 'रिपेयर / सर्विस सेंटर', ico: '🔧', about: 'Job cards for phones, AC, bikes, computers: status, WhatsApp updates, bill',
    on: ['jobs', 'pos', 'khata', 'serial'], dash: 'retail', defs: {}, tips: [['jobs?new=1', 'Open a job card'], ['jobs', 'Job board'], ['reminders', 'Vasooli (collections)']] },
  { k: 'hardware', t: 'Hardware / building material / sanitary', hi: 'हार्डवेयर / बिल्डिंग मटेरियल', ico: '🧱', about: 'Box / bag / piece units, quotations, site deliveries, contractor khata',
    on: ['orders', 'quotes', 'khata', 'procure'], dash: 'wholesale', defs: {}, tips: [['items', 'Give items a second unit (Box / Bag)'], ['sales/QUOTE', 'Quotations'], ['vaade', 'Vaade (payment promises)']] },
  { k: 'restaurant', t: 'Restaurant / cafe / dhaba', hi: 'रेस्टोरेंट / कैफ़े / ढाबा', ico: '🍽️', about: 'Tables, KOT to kitchen, quick bills, staff salary',
    on: ['restaurant', 'pos', 'khata', 'staff', 'loyalty'], dash: 'retail', defs: { unit: 'Plate', gst_rate: 5 }, tips: [['tables', 'Tables and KOT'], ['pos', 'Quick Bill'], ['loyalty', 'Loyalty points']] },
  { k: 'maker', t: 'Manufacturer / workshop', hi: 'मैन्युफैक्चरर / वर्कशॉप', ico: '🏭', about: 'Recipe / BOM production, purchase orders, orders → dispatch, stock bins',
    on: ['mfg', 'procure', 'orders', 'quotes', 'wms', 'staff', 'books'], dash: 'inventory', defs: {}, tips: [['production', 'Production (recipe / BOM)'], ['purchase/PO', 'Purchase orders'], ['stock-ageing', 'Stock ageing']] },
  { k: 'services', t: 'Services / agency / professional', hi: 'सर्विस / एजेंसी', ico: '💼', about: 'Quotations, recurring bills (AMC, retainers), receipts, TDS',
    on: ['quotes', 'recurring', 'khata', 'books'], dash: 'finance', defs: {}, tips: [['sales/QUOTE', 'Quotations'], ['recurring', 'Recurring bills'], ['reminders', 'Vasooli (collections)']] },
  { k: 'export', t: 'Exporter', hi: 'एक्सपोर्टर', ico: '🌍', about: 'Foreign-currency invoices, LUT, shipping bills, orders and purchase',
    on: ['quotes', 'orders', 'procure', 'books'], dash: 'finance', defs: {}, tips: [['parties', 'Customers abroad: state "Other Country"'], ['gstr', 'GST returns'], ['cash', 'Kal ka Cash']] },
];
const packModules = (p) => Object.fromEntries(MODULES.map(([k]) => [k, p.on.includes(k)]));
const BIZ = PACKS.map((p) => [p.k, p.t, p.dash, p.tips]);
/* apply a pack: modules, item defaults, the online seller's dispatch set-up, and (optionally) its dashboard */
async function applyPack(p, { dash = true } = {}) {
  await api('PUT', '/api/settings/setup', { biz: p.k, modules: packModules(p), item_defaults: p.defs || {} });
  if (p.workflow) await api('PUT', '/api/settings/workflow', p.workflow);
  if (dash && typeof DASH_TEMPLATES !== 'undefined' && DASH_TEMPLATES[p.dash]) {
    try { await POST('/api/dashboards', { name: p.t.split(' / ')[0].split(' (')[0], layout: { range: '30d', widgets: DASH_TEMPLATES[p.dash][1] }, is_default: true }); } catch (e) { /* the dashboard is a nicety */ }
  }
  ME = await GET('/api/me'); shell(); wireInstall();
}
const JOB_TEMPLATE = { all: 'owner', counter: 'retail', store: 'inventory', accounts: 'finance', sales: 'sales', gate: 'inventory', waiter: 'retail' };
const greet = () => { const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const pct = (a, b) => (b ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null);
function spark(values, cls = '') {
  if (!values || values.length < 2) return '';
  const W = 120, H = 32, max = Math.max(...values, 0), min = Math.min(...values, 0), span = max - min || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * W, H - 2 - (v - min) / span * (H - 4)]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${line} ${W},${H}" class="sa"/><polyline points="${line}" class="sl"/><circle cx="${lx}" cy="${ly}" r="2.4" class="sd"/></svg>`;
}
const shortLabel = (k, monthly) => (monthly ? new Date(k + '-01').toLocaleString('en-IN', { month: 'short', year: '2-digit' }) : new Date(k).toLocaleString('en-IN', { day: 'numeric', month: 'short' }));
function seriesChart(d) {
  const W = 600, H = 170, n = d.labels.length;
  if (!n) return '<div class="wempty">No data in this period.</div>';
  const max = Math.max(1, ...d.series.flatMap((s) => s.values));
  const y = (v) => H - 4 - Math.max(0, v) / max * (H - 12);
  let body = '';
  if (d.bars) {
    const bw = W / n, k = d.series.length;
    d.series.forEach((s, j) => s.values.forEach((v, i) => { body += `<rect x="${(i * bw + bw * 0.12 + j * bw * 0.76 / k).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw * 0.76 / k - 1).toFixed(1)}" height="${(H - 4 - y(v)).toFixed(1)}" class="b${j}"><title>${shortLabel(d.labels[i], d.monthly)} · ${s.name}: ${inr0(v)}</title></rect>`; }));
  } else {
    d.series.slice().reverse().forEach((s) => {
      const pts = s.values.map((v, i) => `${(n === 1 ? W / 2 : i / (n - 1) * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      if (!s.faint) body += `<polygon points="0,${H} ${pts} ${W},${H}" class="ca"/>`;
      body += `<polyline points="${pts}" class="${s.faint ? 'cf' : 'cl'}"/>`;
    });
    const s0 = d.series[0];
    body += s0.values.map((v, i) => `<rect x="${(i / Math.max(1, n - 1) * W - W / n / 2).toFixed(1)}" y="0" width="${(W / n).toFixed(1)}" height="${H}" class="hit"><title>${shortLabel(d.labels[i], d.monthly)}: ${inr0(v)}${d.series[1] ? ` (before: ${inr0(d.series[1].values[i] || 0)})` : ''}</title></rect>`).join('');
  }
  const total = d.series.map((s) => s.values.reduce((a, b) => a + b, 0));
  const mid = Math.floor((n - 1) / 2);
  return `<div class="ctop"><span class="muted small">up to ${inr0(max)}</span><span class="legend">${d.series.map((s, j) => `<span><i class="k${d.bars ? 'b' + j : s.faint ? 'f' : 'l'}"></i>${esc(s.name)} <b>${inr0(total[j])}</b></span>`).join('')}</span></div>
    <svg class="wchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(d.series.map((s, j) => `${s.name} ${inr0(total[j])}`).join(', '))}">
      <line x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}" class="ax"/><line x1="0" y1="${y(max / 2)}" x2="${W}" y2="${y(max / 2)}" class="gr"/>${body}</svg>
    <div class="cx muted small"><span>${shortLabel(d.labels[0], d.monthly)}</span>${n > 2 ? `<span>${shortLabel(d.labels[mid], d.monthly)}</span>` : ''}<span>${shortLabel(d.labels[n - 1], d.monthly)}</span></div>`;
}
function widgetBody(meta, d, extra) {
  if (!d) return '<div class="wskel" aria-hidden="true"><i></i><i></i><i></i></div>';
  if (d.kind === 'denied') return '<div class="wempty">Your role does not show this.</div>';
  if (d.kind === 'error') return `<div class="wempty">${esc(d.error)}</div>`;
  if (d.kind === 'today') return extra.today || '<div class="wempty">Nothing needs doing right now.</div>';
  if (d.kind === 'kpi') {
    const money = d.unit !== 'count', val = money ? inr0(d.value) : Number(d.value || 0).toLocaleString('en-IN');
    const ch = d.prev === undefined ? null : pct(d.value, d.prev), good = ch === null ? '' : (ch >= 0) !== !!meta.down ? 'up' : 'down';
    return `<div class="kv num">${val}</div>
      ${ch === null ? '' : `<div class="kd ${ch === 0 ? '' : good}"><b>${ch > 0 ? '▲' : ch < 0 ? '▼' : '•'} ${Math.abs(ch)}%</b> <span class="muted">vs ${esc(d.vs || 'before')}</span></div>`}
      ${d.prev !== undefined && !d.prev && d.value ? `<div class="kd"><span class="muted">nothing ${esc(d.vs || 'before')}</span></div>` : ''}
      ${d.sub ? `<div class="ks muted small ${d.tone || ''}">${esc(d.sub)}</div>` : ''}${spark(d.spark)}`;
  }
  if (d.kind === 'series') return seriesChart(d);
  if (d.kind === 'bars') {
    if (!d.rows.length) return '<div class="wempty">Nothing in this period.</div>';
    const max = Math.max(...d.rows.map((r) => r.value), 1);
    return `<ol class="hbars">${d.rows.map((r) => `<li><a ${r.href ? `href="#/${esc(r.href)}"` : ''}><span class="hl"><b>${esc(r.label)}</b>${r.note ? `<small class="${r.warn ? 'neg' : 'muted'}">${esc(r.note)}</small>` : ''}</span>
      <span class="hv num">${d.unit === 'qty' ? Number(r.value).toLocaleString('en-IN') : inr0(r.value)}</span><span class="hb"><i style="width:${Math.max(2, r.value / max * 100).toFixed(1)}%"></i></span></a></li>`).join('')}</ol>`;
  }
  if (d.kind === 'list') {
    if (!d.rows.length) return '<div class="wempty">Nothing to show.</div>';
    return `<ul class="wlist">${d.rows.map((r) => `<li><a ${r.href ? `href="#/${esc(r.href)}"` : ''}><span class="hl"><b>${esc(r.label)}</b>${r.note ? `<small class="${r.warn ? 'neg' : 'muted'}">${esc(r.note)}</small>` : ''}</span>
      <span class="num">${esc(r.value)}${r.status ? ` ${badge(r.status)}` : ''}</span></a></li>`).join('')}</ul>`;
  }
  return '';
}
route(/^dashboard$/, async (el, m, q) => {
  const L = await GET('/api/dashboards');
  const meta = Object.fromEntries(L.widgets.map((w) => [w.id, w]));
  const allowed = (list) => list.filter(([w]) => meta[w]).map(([w, size]) => ({ w, size }));
  const recommended = () => { const key = JOB_TEMPLATE[jobOf()] || 'owner'; return { id: 0, name: 'Recommended', layout: { range: '30d', widgets: allowed(DASH_TEMPLATES[key][1]) }, mine: false }; };
  const boards = [recommended(), ...L.dashboards];
  let cur = boards.find((b) => b.id === +(q.get('d') || 0)) || boards.find((b) => b.id === L.default_id) || boards[0];
  let range = q.get('range') || cur.layout.range || 'month', editing = false, draft = null, hist = [], fut = [], data = {}, extra = {};
  const canEdit = () => cur.id === 0 || cur.mine || L.can_share;
  const bizKey = `st:biz:${ME.org.id}`;
  const bizCard = () => {
    const got = BIZ.find((b) => b[0] === ((ME.org.setup || {}).biz || storeGet(bizKey)));
    if (got) {
      const tips = got[3].filter(([h]) => onMenu(h.split('?')[0]) && seen(h.split('?')[0]));
      return storeGet(bizKey + ':tips') === 'off' || !tips.length ? '' : `<div class="panel biztips"><b>For your ${esc(got[1].split(' / ')[0].toLowerCase())}:</b>
        ${tips.map(([h, t]) => `<a class="btn sm" href="#/${h}">${esc(t)}</a>`).join('')}<span class="spacer"></span><button type="button" class="btn sm" data-biz-off aria-label="Hide these suggestions">×</button></div>`;
    }
    if (L.dashboards.length || !L.can_share || storeGet(bizKey) === 'skip') return '';
    return `<div class="panel bizpick"><div><h2>What kind of business do you run?</h2><p class="muted">Your menu, tools, dashboard and new-item settings are set for it. Change anything later in Settings → Business type &amp; menu.</p></div>
      <div class="bizchips">${PACKS.map((p) => `<button type="button" class="chip" data-biz="${p.k}">${p.ico} ${esc(p.t)}</button>`).join('')}<button type="button" class="chip ghost" data-biz="skip">Skip</button></div></div>`;
  };
  el.onclick = async (e) => {          // page handlers are cleared on each screen change, so this never doubles up
    const b = e.target.closest('[data-biz]');
    if (b) {
      const k = b.dataset.biz; storeSet(bizKey, k);
      if (k !== 'skip') {
        const got = BIZ.find((x) => x[0] === k), pk = PACKS.find((x) => x.k === k);
        if (ME.can.settings) {           // the owner: the whole pack (menu, tools, item defaults, dashboard), then the page to fine-tune it
          try { await applyPack(pk); toast(`Set up for ${pk.t}`); } catch (er) { toast(er.message, 'err'); }
          go(`settings/business?applied=1${k === 'online' ? '&next=workflow' : ''}`); return;
        }
        try { await POST('/api/dashboards', { name: got[1].split(' / ')[0].split(' (')[0], layout: { range: '30d', widgets: allowed(DASH_TEMPLATES[got[2]][1]) }, is_default: true }); toast('Dashboard set for your business'); } catch (er) { toast(er.message, 'err'); }
      }
      render(); return;
    }
    if (e.target.closest('[data-biz-off]')) { storeSet(bizKey + ':tips', 'off'); e.target.closest('.biztips').remove(); }
  };
  const widgets = () => (editing ? draft.widgets : cur.layout.widgets).filter((x) => meta[x.w]);
  const load = async () => {
    const list = widgets(), ids = [...new Set(list.filter((x) => !meta[x.w].client).map((x) => x.w))];
    data = {};
    const tasks = [ids.length ? GET(`/api/dash/widgets?ids=${ids.join(',')}&range=${encodeURIComponent(range)}`).then((r) => { data = r.widgets; extra.period = r.period; }) : Promise.resolve()];
    if (list.some((x) => x.w === 'today_tasks')) {
      tasks.push(Promise.all([GET('/api/today').catch(() => null), ME.view && ME.view.khata === false ? null : GET('/api/vaade/summary').catch(() => null)])
        .then(([td, vs]) => { extra.today = (todayCard(td) + vaadaCard(vs)) || ''; }));
    }
    await Promise.all(tasks);
    for (const x of list) if (meta[x.w].client) data[x.w] = { kind: meta[x.w].client };
  };
  const card = (x, i) => {
    const w = meta[x.w];
    return `<section class="wcard s${x.size}" data-i="${i}" ${editing ? 'draggable="true"' : ''} aria-label="${esc(w.label)}">
      <header>${editing ? '<span class="grip" aria-hidden="true">⠿</span>' : ''}<h3>${esc(w.label)}</h3>${!editing && w.link ? `<a class="wgo" href="#/${esc(w.link)}" aria-label="Open ${esc(w.label)}">Open ›</a>` : ''}
        ${editing ? `<span class="wed"><button type="button" class="btn sm" data-mv="-1" aria-label="Move ${esc(w.label)} earlier">←</button><button type="button" class="btn sm" data-mv="1" aria-label="Move ${esc(w.label)} later">→</button>
          <select data-sz aria-label="Width of ${esc(w.label)}">${[[1, 'Small'], [2, 'Half'], [3, 'Wide'], [4, 'Full']].map(([v, t]) => `<option value="${v}" ${x.size === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <button type="button" class="btn sm danger" data-rm aria-label="Remove ${esc(w.label)}">×</button></span>` : ''}</header>
      <div class="wbody">${widgetBody(w, data[x.w], extra)}</div></section>`;
  };
  const draw = () => {
    const opts = boards.map((b) => `<option value="${b.id}" ${b.id === cur.id ? 'selected' : ''}>${esc(b.name)}${b.id && !b.mine ? ' (shared)' : ''}${b.id && b.id === L.default_id ? ' ★' : ''}</option>`).join('');
    const acts = NEW_MENU.filter(([, , a, h]) => ME.can[a] && onMenu(h)).slice(0, 6);
    const p = extra.period;
    el.innerHTML = `<div class="dhead">
        <div class="dgreet"><h1>${greet()}, ${esc(String(ME.user.name || '').split(' ')[0])}</h1><p class="muted">${editing ? 'Arrange your dashboard: add widgets, drag them or use the arrows, pick a width, then save.' : "Here's what's happening in your business."}${p && !editing ? ` <span class="small">${esc(p.label)}: ${fdate(p.from)}${p.from !== p.to ? ' – ' + fdate(p.to) : ''}</span>` : ''}</p></div>
        <div class="dtools">${editing ? `
          <button type="button" class="btn" id="dadd">+ Add widget</button><button type="button" class="btn" id="dtpl">Templates</button>
          <button type="button" class="btn" id="dundo" ${hist.length ? '' : 'disabled'} title="Undo (Ctrl Z)">Undo</button><button type="button" class="btn" id="dredo" ${fut.length ? '' : 'disabled'} title="Redo">Redo</button>
          <button type="button" class="btn" id="dreset">Reset</button><span class="spacer"></span><button type="button" class="btn" id="dcancel">Cancel</button><button type="button" class="btn primary" id="dsave">Save</button>`
          : `<label class="sel"><span class="sr">Dashboard</span><select id="dpick">${opts}<option value="new">+ New dashboard…</option></select></label>
          <label class="sel"><span class="sr">Period</span><select id="drange">${Object.entries(L.ranges).map(([k, t]) => `<option value="${k}" ${k === range ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          ${canEdit() ? '<button type="button" class="btn" id="dedit">Customize</button>' : ''}`}</div></div>
      ${editing ? `<div class="panel dmeta"><label class="f">Name<input id="dname" maxlength="60" value="${esc(draft.name)}"></label>
          <label class="f">Opens with<select id="drange2">${Object.entries(L.ranges).map(([k, t]) => `<option value="${k}" ${k === draft.range ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" id="ddef" ${draft.is_default ? 'checked' : ''}> Open this dashboard first</label>
          ${L.can_share ? `<label class="check"><input type="checkbox" id="dshare" ${draft.shared ? 'checked' : ''}> Share with everyone in the business <small class="muted">(each person sees only what their role allows)</small></label>` : ''}
          ${cur.id && cur.mine ? '<span class="spacer"></span><button type="button" class="btn sm" id="ddup">Duplicate</button><button type="button" class="btn sm danger" id="ddel">Delete</button>' : ''}</div>`
        : `${bizCard()}${getStarted(L.setup)}<nav class="qacts" aria-label="Quick actions">${acts.map(([h, t, , , ic]) => `<a href="#/${h}">${icon(ic)}<span>${t}</span></a>`).join('')}</nav>`}
      <div class="dgrid ${editing ? 'editing' : ''}" id="dgrid">${widgets().map(card).join('') || `<div class="wempty big">${editing ? 'Add widgets from the library, or start from a template.' : 'This dashboard is empty. Press Customize to add widgets.'}</div>`}</div>`;
    wire();
  };
  const snap = () => { hist.push(JSON.stringify(draft)); if (hist.length > 50) hist.shift(); fut = []; };
  const change = async (fn, reload) => { snap(); fn(); if (reload) { draw(); await load(); } draw(); };
  const library = () => {
    const have = new Set(draft.widgets.map((x) => x.w)), cats = [...new Set(L.widgets.map((w) => w.cat))];
    modal('Add a widget', [], async () => {}, { submit: 'Done', intro: `<input type="search" id="wlq" placeholder="Search widgets: sales, stock, cash…" aria-label="Search widgets" autocomplete="off">
      <div class="wlib">${cats.map((c) => `<div class="wcat" data-cat="${esc(c)}"><h4>${esc(c)}</h4>${L.widgets.filter((w) => w.cat === c).map((w) => `<button type="button" class="wpick" data-add="${w.id}" data-q="${esc((w.label + ' ' + c).toLowerCase())}">
        <b>${esc(w.label)}</b><small class="muted">${have.has(w.id) ? 'on the dashboard · add again' : w.size >= 2 ? 'chart or list' : 'figure'}</small></button>`).join('')}</div>`).join('')}</div>` });
    const box = $('#modal-root');
    $('#wlq', box).oninput = (e) => { const t = e.target.value.trim().toLowerCase(); $$('.wpick', box).forEach((b) => { b.hidden = !!t && !b.dataset.q.includes(t); }); $$('.wcat', box).forEach((c) => { c.hidden = !$$('.wpick:not([hidden])', c).length; }); };
    $('.wlib', box).onclick = (e) => { const b = e.target.closest('[data-add]'); if (!b) return; const w = meta[b.dataset.add]; change(() => draft.widgets.push({ w: w.id, size: w.size }), true); b.querySelector('small').textContent = 'added'; toast(`${w.label} added`); };
  };
  const templates = () => modal('Start from a template', [], async () => {}, { submit: 'Close', intro: `<div class="tpls">${Object.entries(DASH_TEMPLATES).map(([k, [name, list]]) => `<button type="button" class="tpl" data-tpl="${k}"><b>${esc(name)}</b>
      <small class="muted">${list.length ? allowed(list).map((x) => meta[x.w].label).slice(0, 5).join(', ') + (allowed(list).length > 5 ? '…' : '') : 'Start empty and add your own'}</small></button>`).join('')}</div>
      <p class="muted small">This replaces the widgets now on the dashboard. You can undo it.</p>` }) && $('.tpls', $('#modal-root')).addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]'); if (!b) return;
    $('#modal-root').innerHTML = '';
    change(() => { draft.widgets = allowed(DASH_TEMPLATES[b.dataset.tpl][1]); if (draft.name === 'Recommended' || !draft.name) draft.name = DASH_TEMPLATES[b.dataset.tpl][0]; }, true);
  });
  const startEdit = (base) => {
    editing = true; hist = []; fut = [];
    draft = { name: base.id === 0 ? 'My dashboard' : base.name, range: base.layout.range || 'month', widgets: base.layout.widgets.filter((x) => meta[x.w]).map((x) => ({ ...x })),
      is_default: base.id ? base.id === L.default_id : false, shared: !!base.shared };
    draw();
  };
  const save = async (asNew) => {
    const body = { name: draft.name, layout: { range: draft.range, widgets: draft.widgets }, is_default: draft.is_default, shared: L.can_share ? draft.shared : undefined };
    const update = cur.id && (cur.mine || L.can_share) && !asNew;
    const r = update ? await api('PUT', `/api/dashboards/${cur.id}`, body) : await POST('/api/dashboards', body);
    if (!body.is_default && cur.id && cur.id === L.default_id && update) await api('PUT', '/api/dashboards-default', { id: 0 });
    const id = update ? cur.id : Math.max(0, ...r.dashboards.filter((b) => b.mine).map((b) => b.id));
    toast('Dashboard saved'); show(`dashboard?d=${id}`);
  };
  const show = (h) => { editing = false; if (location.hash === '#/' + h) render(); else go(h); };
  function wire() {
    const g = $('#dgrid');
    if (!editing) {
      $('#drange').onchange = async (e) => { range = e.target.value; draw(); await load(); draw(); };
      $('#dpick').onchange = (e) => {
        if (e.target.value === 'new') { cur = { id: 0, name: 'New dashboard', layout: { range, widgets: [] }, mine: true }; startEdit(cur); draft.name = 'New dashboard'; templates(); return; }
        go(`dashboard?d=${e.target.value}`);
      };
      if ($('#dedit')) $('#dedit').onclick = () => startEdit(cur);
      return;
    }
    $('#dadd').onclick = library; $('#dtpl').onclick = templates;
    $('#dundo').onclick = async () => { if (!hist.length) return; fut.push(JSON.stringify(draft)); draft = JSON.parse(hist.pop()); draw(); await load(); draw(); };
    $('#dredo').onclick = async () => { if (!fut.length) return; hist.push(JSON.stringify(draft)); draft = JSON.parse(fut.pop()); draw(); await load(); draw(); };
    $('#dreset').onclick = () => change(() => { draft.widgets = recommended().layout.widgets; }, true);
    $('#dcancel').onclick = () => { editing = false; draw(); };
    $('#dsave').onclick = () => save(false).catch((er) => toast(er.message, 'err'));
    $('#dname').oninput = (e) => { draft.name = e.target.value; };
    $('#drange2').onchange = (e) => change(() => { draft.range = e.target.value; });
    $('#ddef').onchange = (e) => { draft.is_default = e.target.checked; };
    if ($('#dshare')) $('#dshare').onchange = (e) => { draft.shared = e.target.checked; };
    if ($('#ddup')) $('#ddup').onclick = () => { draft.name = `${draft.name} (copy)`; save(true).catch((er) => toast(er.message, 'err')); };
    if ($('#ddel')) $('#ddel').onclick = async () => { if (!confirm(`Delete the dashboard "${cur.name}"?`)) return; await api('DELETE', `/api/dashboards/${cur.id}`); toast('Dashboard deleted'); show('dashboard'); };
    g.onclick = (e) => {
      const sec = e.target.closest('.wcard'); if (!sec) return;
      const i = +sec.dataset.i, b = e.target.closest('button');
      if (b && b.dataset.mv) { const j = i + +b.dataset.mv; if (j < 0 || j >= draft.widgets.length) return; change(() => { const [x] = draft.widgets.splice(i, 1); draft.widgets.splice(j, 0, x); }); }
      if (b && b.hasAttribute('data-rm')) change(() => draft.widgets.splice(i, 1));
    };
    g.onchange = (e) => { const s = e.target.closest('[data-sz]'); if (s) change(() => { draft.widgets[+s.closest('.wcard').dataset.i].size = +s.value; }); };
    let from = -1;
    g.ondragstart = (e) => { const sec = e.target.closest('.wcard'); if (!sec) return; from = +sec.dataset.i; sec.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(from)); };
    g.ondragover = (e) => { if (from < 0) return; e.preventDefault(); $$('.wcard.over', g).forEach((x) => x.classList.remove('over')); const t = e.target.closest('.wcard'); if (t) t.classList.add('over'); };
    g.ondragend = () => { from = -1; $$('.wcard', g).forEach((x) => x.classList.remove('dragging', 'over')); };
    g.ondrop = (e) => { e.preventDefault(); const t = e.target.closest('.wcard'); if (from < 0 || !t) return; const to = +t.dataset.i, f = from; from = -1; if (to !== f) change(() => { const [x] = draft.widgets.splice(f, 1); draft.widgets.splice(to, 0, x); }); else draw(); };
  }
  const undoKey = (e) => {
    if (!editing || !location.hash.startsWith('#/dashboard')) { if (!location.hash.startsWith('#/dashboard')) document.removeEventListener('keydown', undoKey); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest('input,textarea')) { e.preventDefault(); (e.shiftKey ? $('#dredo') : $('#dundo')).click(); }
  };
  document.addEventListener('keydown', undoKey);
  draw(); await load(); draw();
});

/* Today: everything that needs doing, one row each, one tap to the screen that does it */
const TODAY = {
  overdue: ['red', (n) => `${n} invoice${n > 1 ? 's' : ''} overdue`, '#/reminders', 'Send reminders'],
  promises: ['red', (n) => `${n} promised payment${n > 1 ? 's' : ''} due`, '#/vaade', 'Check'],
  disputed: ['red', (n) => `${n} customer${n > 1 ? 's' : ''} disputed their balance`, '#/reminders', 'See'],
  expired: ['red', (n) => `${n} batch${n > 1 ? 'es' : ''} past expiry still in stock`, '#/expiry', 'See'],
  recurring: ['red', (n) => `${n} recurring bill${n > 1 ? 's' : ''} could not be made`, '#/recurring', 'Fix'],
  recurring_send: ['amber', (n) => `${n} new recurring bill${n > 1 ? 's' : ''} to send to customers`, '#/recurring', 'Send'],
  approve: ['amber', (n) => `${n} purchase order${n > 1 ? 's' : ''} waiting for your approval`, '#/purchase/PO?status=pending', 'Approve'],
  bills_due: ['amber', (n) => `${n} supplier bill${n > 1 ? 's' : ''} due within 7 days`, '#/reports/ageing?kind=payable', 'Pay'],
  expiring: ['amber', (n) => `${n} batch${n > 1 ? 'es' : ''} expire within 30 days`, '#/expiry', 'Sell first'],
  low_stock: ['amber', (n) => `${n} item${n > 1 ? 's' : ''} at reorder level`, '#/new/PO?reorder=1', 'Order'],
  to_deliver: ['blue', (n) => `${n} sales order${n > 1 ? 's' : ''} to deliver`, '#/pending', 'Open'],
  to_pack: ['blue', (n) => `${n} order${n > 1 ? 's' : ''} to pack`, '#/dispatch', 'Pack'],
  jobs_ready: ['blue', (n) => `${n} repair job${n > 1 ? 's' : ''} ready: tell the customer`, '#/jobs?status=ready', 'Open'],
  jobs_late: ['red', (n) => `${n} repair job${n > 1 ? 's' : ''} past the promised date`, '#/jobs', 'Open'],
  to_ship: ['amber', (n) => `${n} parcel${n > 1 ? 's' : ''} packed, not handed to the courier`, '#/dispatch?tab=packed', 'Ship'],
  to_receive: ['blue', (n) => `${n} purchase order${n > 1 ? 's' : ''} to receive`, '#/pending', 'Open'],
  at_gate: ['amber', (n) => `${n} vehicle${n > 1 ? 's' : ''} at the gate, goods not received`, '#/receive', 'Receive'],
  in_transit: ['blue', (n) => `${n} bill${n > 1 ? 's' : ''} booked, goods still on the way`, '#/receive', 'Receive'],
  claims: ['amber', (n) => `${n} transit claim${n > 1 ? 's' : ''} to follow up, not paid yet`, '#/claims', 'Follow up'],
  wa_asks: ['red', (n) => `${n} customer${n > 1 ? 's' : ''} wrote on WhatsApp and wait for your answer`, '#/wa-inbox', 'Answer'],
  put_away: ['blue', (n) => `${n} item${n > 1 ? 's' : ''} not put away in bins`, '#/bins', 'Put away'],
  attendance: ['blue', (n) => `Mark today's attendance (${n} staff)`, '#/staff', 'Mark'],
  salary_due: ['amber', (n) => `Last month's salary not paid for ${n} staff`, '#/staff?month=last', 'Pay'],
  drive_failing: ['red', () => 'Google Drive backup is not working', '#/settings?backup=1', 'Fix'],
  backup_none: ['amber', () => 'Your business data has no backup yet', '#/settings?backup=1', 'Back up'],
  backup_old: ['amber', (n) => `No backup of your data for ${n} days`, '#/settings?backup=1', 'Back up'],
  tds_due: ['amber', () => 'TDS kept back from suppliers, to pay to the government by the 7th', '#/tds', 'Pay'],
  // Munim ji: from the business's own records
  cash_short: ['red', () => 'Cash and bank are short of the supplier bills due this week', '#/cash', 'Plan'],
  sales_drop: ['amber', (n) => `Sales this week are ${n}% below your usual week`, '#/reports/register?type=INV', 'See'],
  below_cost: ['amber', (n) => `${n} bill${n > 1 ? 's' : ''} this week sold items below their cost`, '#/sales/INV', 'Check'],
  big_discount: ['amber', (n) => `${n} bill${n > 1 ? 's' : ''} this week gave 20% or more discount`, '#/sales/INV', 'Check'],
  lost_customers: ['blue', (n, r) => `${n} regular customer${n > 1 ? 's have' : ' has'} not bought in 30 days${r && r.names ? ': ' + r.names.join(', ') + (n > r.names.length ? '…' : '') : ''}`, '#/parties', 'Call'],
};
/* the same lines in Hindi (Hindi screens): the text and the button; the link stays */
const TODAY_HI = {
  to_pack: [(n) => `${n} ऑर्डर पैक करने हैं`, 'पैक करें'], jobs_ready: [(n) => `${n} रिपेयर तैयार: ग्राहक को बताएँ`, 'खोलें'], jobs_late: [(n) => `${n} रिपेयर वादे की तारीख से लेट`, 'खोलें'], to_ship: [(n) => `${n} पार्सल पैक, कूरियर को नहीं दिए`, 'भेजें'],
  overdue: [(n) => `${n} बिल की तारीख निकल गई`, 'याद दिलाएँ'], promises: [(n) => `${n} वादे का भुगतान आज तक`, 'देखें'], disputed: [(n) => `${n} ग्राहकों ने बाकी पर आपत्ति की`, 'देखें'],
  expired: [(n) => `${n} बैच एक्सपायर, फिर भी स्टॉक में`, 'देखें'], recurring: [(n) => `${n} दोहराने वाले बिल नहीं बन सके`, 'ठीक करें'], recurring_send: [(n) => `${n} नए दोहराने वाले बिल ग्राहकों को भेजने हैं`, 'भेजें'],
  approve: [(n) => `${n} खरीद ऑर्डर आपकी मंज़ूरी के लिए`, 'मंज़ूर करें'], bills_due: [(n) => `${n} सप्लायर बिल 7 दिन में देय`, 'चुकाएँ'], expiring: [(n) => `${n} बैच 30 दिन में एक्सपायर`, 'पहले बेचें'],
  low_stock: [(n) => `${n} आइटम कम स्टॉक पर`, 'मँगाएँ'], to_deliver: [(n) => `${n} सेल्स ऑर्डर डिलीवर करने हैं`, 'खोलें'], to_receive: [(n) => `${n} खरीद ऑर्डर का माल आना है`, 'खोलें'],
  at_gate: [(n) => `${n} गाड़ी गेट पर, माल नहीं लिया`, 'माल लें'], in_transit: [(n) => `${n} बिल दर्ज, माल रास्ते में`, 'माल लें'], claims: [(n) => `${n} रास्ते के क्लेम बाकी`, 'पीछा करें'],
  wa_asks: [(n) => `${n} ग्राहकों ने WhatsApp पर लिखा, जवाब बाकी`, 'जवाब दें'], put_away: [(n) => `${n} आइटम रैक में नहीं रखे`, 'रखें'], attendance: [(n) => `आज की हाज़िरी लगाएँ (${n} स्टाफ)`, 'लगाएँ'],
  salary_due: [(n) => `${n} स्टाफ की पिछले महीने की तनख्वाह बाकी`, 'चुकाएँ'], drive_failing: [() => 'Google Drive बैकअप नहीं चल रहा', 'ठीक करें'], backup_none: [() => 'आपके डेटा का अभी कोई बैकअप नहीं', 'बैकअप लें'],
  backup_old: [(n) => `${n} दिन से डेटा का बैकअप नहीं`, 'बैकअप लें'], tds_due: [() => 'सप्लायर से काटा TDS, 7 तारीख तक सरकार को जमा करें', 'जमा करें'],
  cash_short: [() => 'इस हफ़्ते के सप्लायर बिलों के लिए नकद और बैंक में पैसे कम हैं', 'योजना देखें'], sales_drop: [(n) => `इस हफ़्ते बिक्री आम हफ़्ते से ${n}% कम`, 'देखें'],
  below_cost: [(n) => `इस हफ़्ते ${n} बिल में सामान लागत से कम में बिका`, 'जाँचें'], big_discount: [(n) => `इस हफ़्ते ${n} बिल में 20% या ज़्यादा छूट दी गई`, 'जाँचें'],
  lost_customers: [(n, r) => `${n} पुराने ग्राहकों ने 30 दिन से कुछ नहीं खरीदा${r && r.names ? ': ' + r.names.join(', ') + (n > r.names.length ? '…' : '') : ''}`, 'फ़ोन करें'],
};
function todayCard(t) {
  if (!t) return '';
  const rows = t.rows.filter((r) => TODAY[r.key]);
  if (!rows.length) return `<div class="panel today ok"><b>Aaj ke kaam</b> <span class="muted">· Nothing pending today. Sab theek hai ✓</span></div>`;
  return `<div class="panel today"><div class="row"><h3 style="margin:0">Aaj ke kaam <span class="muted">· Today</span></h3><span class="spacer"></span><span class="muted">${rows.length} ${LANG === 'hi' ? 'काम' : 'to do'}</span></div>
    <div class="todo">${rows.map((r) => { let [tone, text, href, cta] = TODAY[r.key]; if (LANG === 'hi' && TODAY_HI[r.key]) [text, cta] = TODAY_HI[r.key];
      if (r.key === 'to_deliver' && dispatchOn()) href = '#/dispatch';
      return `<a class="t-${tone}" href="${href}"><i></i><span>${esc(text(r.n, r))}${r.value ? ` <b>${inr0(r.value)}</b>` : ''}</span><em>${cta} &rsaquo;</em></a>`; }).join('')}</div></div>`;
}

/* First-run checklist on the dashboard. Each step ticks itself from real data; it hides once all are done
   (or when the owner taps Hide). */
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone || lsGet('st_installed') === '1';
function getStarted(setup) {
  if (!setup || !ME.can.sales || lsGet('st_gs_hide_' + ME.org.id)) return '';
  const o = ME.org;
  const steps = [
    [!!(o.address && o.upi_id), 'Add business details and UPI ID', 'Address prints on bills; UPI lets customers pay you in one tap.', '#/settings', 'Open settings'],
    [setup.items, 'Add your first item', 'Name, price and GST. Bills fill them in for you.', '#/items?new=1', 'Add item'],
    [setup.customers, 'Add your first customer', 'Keep their bills, payments and balance together.', '#/parties?new=1', 'Add customer'],
    [setup.invoices, 'Make your first invoice', 'Save it, then share on WhatsApp or print.', '#/new/INV', 'New invoice'],
    [isInstalled(), 'Install the app on this phone or computer', 'Opens like any app, from your home screen.', '', 'Install'],
  ];
  const done = steps.filter((x) => x[0]).length;
  if (done === steps.length) return '';
  return `<div class="panel getstarted"><div class="row"><h2 style="margin:0">Get started</h2><span class="muted">${done} of ${steps.length} done</span><span class="spacer"></span>
      <button class="btn sm" data-gshide>Hide</button></div>
    <div class="gsbar"><i style="width:${Math.round(done / steps.length * 100)}%"></i></div>
    <ol class="gs">${steps.map(([ok, t, h, href, b], i) => `<li class="${ok ? 'done' : ''}"><span class="tick" aria-hidden="true">${ok ? '&#10003;' : i + 1}</span>
      <div><b>${t}</b><div class="muted">${h}</div></div>${ok ? '<span class="muted">Done</span>' : href ? `<a class="btn sm primary" href="${href}">${b}</a>` : `<button class="btn sm primary" data-install>${b}</button>`}</li>`).join('')}</ol></div>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-gshide]')) { lsSet('st_gs_hide_' + ME.org.id, '1'); e.target.closest('.getstarted').remove(); toast('Checklist hidden', 'info'); }
  if (e.target.closest('[data-install]')) {
    if (installEvt) { installEvt.prompt(); const c = await installEvt.userChoice; installEvt = null; if (c.outcome === 'accepted') { lsSet('st_installed', '1'); render(); } }
    else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) alert('In Safari: tap the Share button, then “Add to Home Screen”.');
    else if (confirm('Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”. Tap OK once done.')) { lsSet('st_installed', '1'); render(); }
  }
});

/* ======================================================================= document lists */
route(/^(sales|purchase)\/([A-Z]+)$/, async (el, m, q) => {
  const type = m[2], T = ME.doc_types[type];
  const make = !['SRET', 'PRET'].includes(type);
  const p = new URLSearchParams({ type, q: q.get('q') || '', status: q.get('status') || '', from: q.get('from') || '', to: q.get('to') || '' });
  for (const [k, v] of q) if (k.startsWith('cf.')) p.set(k, v);
  [...p.keys()].forEach((k) => { if (!p.get(k)) p.delete(k); });
  const cfF = cfDefs('doc', T.side).slice(0, 3);
  const { rows } = await GET('/api/docs?' + p);
  const money = ['INV', 'BILL'].includes(type);
  const cols = [
    { h: 'Number', k: 'number', f: (r) => `<a href="#/doc/${r.id}">${esc(r.number)}</a>` }, { h: 'Date', k: 'date', f: (r) => fdate(r.date) },
    { h: T.side === 'sales' ? 'Customer' : 'Supplier', k: 'party' },
    ...(money ? [{ h: 'Due', k: 'due_date', f: (r) => fdate(r.due_date), cls: 'hide-sm' }] : []),
    { h: 'Taxable', k: 'taxable', num: 1, cls: 'hide-sm', f: (r) => inr(r.taxable) }, { h: 'Total', k: 'total', num: 1, f: (r) => inr(r.total) },
    ...(money ? [{ h: 'Balance', k: 'balance', num: 1, f: (r) => inr(r.balance) }] : []), ...cfCols('doc', T.side),
    { h: 'Status', k: 'status', f: (r) => badge(r.status) }];
  el.innerHTML = head(esc(T.label) + 's', `<button class="btn" id="csv">Export CSV</button>${make ? `<a class="btn primary" href="#/new/${type}">+ New ${esc(T.label)}</a>` : ''}`) + `
    <div class="panel"><form class="row flt" id="flt">
      <input name="q" type="search" placeholder="Search number or party" value="${esc(q.get('q') || '')}" style="max-width:260px">
      <button type="button" class="btn sm show-sm" id="moref" aria-expanded="false">More filters</button>
      <select name="status" style="max-width:160px"><option value="">All statuses</option>${['open', 'partial', 'closed', 'unpaid', 'paid', 'converted', 'cancelled'].map((s) => `<option ${q.get('status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <input type="date" name="from" aria-label="From date" value="${esc(q.get('from') || '')}" style="max-width:160px"><input type="date" name="to" aria-label="To date" value="${esc(q.get('to') || '')}" style="max-width:160px">
      ${cfF.map((f) => f.type === 'select' ? `<select name="cf.${f.key}" style="max-width:160px"><option value="">${esc(f.label)}: all</option>${f.options.map((o) => `<option ${q.get('cf.' + f.key) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input name="cf.${f.key}" placeholder="${esc(f.label)}" value="${esc(q.get('cf.' + f.key) || '')}" style="max-width:160px">`).join('')}
      <button class="btn">Search</button></form>
      ${!make ? `<p class="muted" style="margin:10px 0 0">To make a ${esc(T.label.toLowerCase())}, open the original ${type === 'SRET' ? 'invoice' : 'bill'} and choose <b>Return goods</b>.</p>` : ''}
      ${ME.doc_types[type].note ? `<p class="muted" style="margin:10px 0 0">Tip: open the ${T.side === 'sales' ? 'invoice' : 'bill'} and choose <b>${T.side === 'sales' ? 'Credit note' : 'Debit note'}</b> to adjust it line by line; it is then settled against that ${T.side === 'sales' ? 'invoice' : 'bill'}.</p>` : ''}</div>
    <div class="panel flush">${table(cols, rows, { onRow: true, empty: [...q.keys()].length ? 'Nothing matches these filters.' : emptyCta(`No ${esc(T.label.toLowerCase())}s yet.${type === 'INV' ? ' Make your first bill: choose a customer, add items, save. You can share it on WhatsApp.' : ''}`,
      make && ME.can[T.side] ? `<a class="btn primary" href="#/new/${type}">+ New ${esc(T.label)}</a>` : '') })}</div>`;
  bindRows(el, rows, (r) => go('doc/' + r.id));
  $('#flt').onsubmit = (e) => { e.preventDefault(); const f = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v !== '')); go(`${m[1]}/${type}?${f}`); };
  $('#moref').onclick = () => { const o = $('#flt').classList.toggle('open'); $('#moref').setAttribute('aria-expanded', String(o)); };
  if ([...q.keys()].some((k) => k !== 'q')) $('#flt').classList.add('open');
  $('#csv').onclick = () => download(`${type}-register.csv`, toCsv(cols.map((c) => ({ ...c, csv: undefined })), rows));
});

/* ======================================================================= document editor */
route(/^new\/([A-Z]+)$/, async (el, m, q) => {
  const type = m[1], T = ME.doc_types[type];
  if (!T) throw new Error('Unknown document type.');
  const [parties, items, whs, cashAccts] = await Promise.all([master('parties'), master('items'), master('warehouses'), cashOpts()]);
  const side = T.side === 'sales' ? 'customer' : 'supplier';
  const plist = parties.filter((p) => p.kind === side || p.kind === 'both');
  let draft = { type, date: ME.today, lines: [{}], party_id: '', warehouse_id: whs[0] && whs[0].id };
  // goods receipt from a gate entry: take the supplier and, when the vehicle came against a PO, the PO lines
  let ge = null;
  if (q.get('ge')) {
    ge = await GET('/api/gate/' + q.get('ge'));
    if (ge.ref_doc_id && !q.get('from')) draft = { ...draft, ...(await GET(`/api/docs/${ge.ref_doc_id}/convert?to=${type}`)) };
    if (!draft.party_id) draft.party_id = ge.party_id;
  }
  if (q.get('from')) draft = { ...draft, ...(await GET(`/api/docs/${q.get('from')}/convert?to=${type}${q.get('short') ? '&short=1' : ''}`)) };
  // the bill of a repair job (src/jobs.js): the customer and a labour line from the job; add the parts used from stock
  const jobId = type === 'INV' && +q.get('job') ? +q.get('job') : 0;
  if (jobId) {
    const j = await GET('/api/jobs/' + jobId);
    draft = { ...draft, party_id: j.party_id, notes: `Job ${j.number}: ${j.device}${j.serial ? ' (' + j.serial + ')' : ''}`,
      lines: [{ description: `Repair / service: ${j.device} (${j.problem})`.slice(0, 300), qty: 1, rate: j.estimate || '', gst_rate: 18 }] };
  }
  else if (q.get('scan')) { try { const sd = JSON.parse(sessionStorage.getItem('st_scan') || 'null'); if (sd && sd.type === type) draft = { ...draft, ...sd }; } catch (e) { /* no draft */ } }
  else if (q.get('copy')) draft = { ...draft, ...(await GET(`/api/docs/${encodeURIComponent(q.get('copy'))}/copy`)) };
  // purchase order for everything at or below its reorder level
  if (q.get('reorder') && type === 'PO') {
    const low = (await GET('/api/reports/stock')).rows.filter((r) => r.suggested_order > 0);
    if (low.length) draft.lines = low.map((r) => { const it = items.find((i) => i.id === r.id) || {}; return { item_id: r.id, qty: r.suggested_order, rate: it.purchase_price || r.avg_cost, gst_rate: it.gst_rate }; });
  }
  const fromDoc = !!draft.ref_id;
  const isNote = !!T.note, isShort = !!draft.short;     // isShort: goods that never came, claimed back at the bill's price
  // a purchase bill can be booked before its goods come; the supplier's own bill number guards against entering it twice
  const billFirst = type === 'BILL' && draft.ref_type !== 'GRN', refField = billFirst || type === 'GRN';
  const isSale = T.side === 'sales', money = ['INV', 'BILL'].includes(type), LOY = ME.org.loyalty || {};
  // batches (items that track batch & expiry): typed when goods come in, chosen (or first-to-expire) when they go out
  const movesStock = !!T.stock && !(type === 'INV' && draft.ref_type === 'DN') && !(type === 'BILL' && draft.ref_type === 'GRN');
  const tracks = (id) => { const it = items.find((i) => i.id === +id); return !!(it && it.track_batch); };
  const tracksSn = (id) => { const it = items.find((i) => i.id === +id); return !!(it && it.track_serial); };
  // serial / IMEI numbers: typed or scanned (one per line) when goods come in, picked when they go out (empty = the oldest)
  const snCell = (l) => {
    if (!movesStock) return l.serials ? `<div class="sn muted">S/N: ${esc(l.serials)}<input type="hidden" name="serials" value="${esc(l.serials)}"></div>` : '';
    const hide = tracksSn(l.item_id) || l.serials ? '' : ' hidden';
    return `<div class="sn"${hide}><textarea name="serials" rows="2" placeholder="${T.stock === 'in' ? 'IMEI / serial numbers: scan or type, one per line' : 'IMEI / serial: scan or tap below (empty = oldest in stock)'}" aria-label="Serial numbers">${esc((l.serials || '').split(/,\s*/).filter(Boolean).join('\n'))}</textarea>
      ${l.src_serials && l.src_serials !== l.serials ? `<small class="help">On ${esc(draft.ref_number || 'the original')}: ${esc(l.src_serials)}</small>` : ''}${T.stock === 'out' ? '<div class="snpick" data-snpick></div>' : ''}</div>`;
  };
  const lotCell = (l) => {
    if (!movesStock) return (l.batch_no ? `<div class="lot muted">${batchLine(l)}<input type="hidden" name="batch_no" value="${esc(l.batch_no)}"><input type="hidden" name="expiry" value="${esc(l.expiry || '')}"></div>` : '') + snCell(l);
    const hide = tracks(l.item_id) || l.batch_no ? '' : ' hidden';
    return snCell(l) + (T.stock === 'in'
      ? `<div class="lot"${hide}><input name="batch_no" placeholder="Batch no." maxlength="40" value="${esc(l.batch_no || '')}" aria-label="Batch number"><input name="expiry" type="month" value="${esc((l.expiry || '').slice(0, 7))}" aria-label="Expiry month" title="Expiry"></div>`
      : `<div class="lot"${hide}><select name="batch_no" data-batches aria-label="Batch"><option value="">Batch: first to expire</option>${l.batch_no ? `<option value="${esc(l.batch_no.split(',')[0].trim())}" selected>${esc(l.batch_no.split(',')[0].trim())}</option>` : ''}</select></div>`);
  };
  const itemOpt = (sel) => `<option value="">Choose item…</option>` + items.map((i) => `<option value="${i.id}" ${+sel === i.id ? 'selected' : ''}>${esc(i.name)}${i.is_service ? '' : ` (${qtyf(i.qty_on_hand)} ${esc(i.unit)})`}</option>`).join('');
  const gstOpt = (sel) => ME.gst_rates.map((g) => `<option value="${g}" ${+sel === g ? 'selected' : ''}>${g}%</option>`).join('');
  // a second unit (1 Box = 12 Pcs): a small picker under the quantity; qty and rate are typed in the unit picked
  const altOf = (id) => { const it = items.find((i) => i.id === +id); return it && it.alt_unit && it.alt_factor > 0 && !isNote ? it : null; };
  const lineUf = (l) => (l.uom && l.uom_factor > 0 && altOf(l.item_id) ? l.uom_factor : 0);
  const uomOpts = (it, cur) => (it ? `<option value="">${esc(it.unit)}</option><option value="${esc(it.alt_unit)}" ${cur ? 'selected' : ''}>${esc(it.alt_unit)} (${qtyf(it.alt_factor)} ${esc(it.unit)})</option>` : '');
  const uomSel = (id, cur) => `<select name="uom" class="uom" aria-label="Unit" ${altOf(id) ? '' : 'hidden'}>${uomOpts(altOf(id), cur)}</select>`;
  const altF = (tr) => { const u = $('[name=uom]', tr), it = u && u.value ? altOf(($('[name=item_id]', tr) || {}).value) : null; return it ? it.alt_factor : 1; };
  const lineRow = (l) => `<tr>
      <td class="c-item">${fromDoc ? `<b>${esc(l.item || l.description)}</b>${isNote && l.orig_rate !== undefined ? `<div class="muted">billed at ${inr(l.orig_rate)}</div>` : ''}<input type="hidden" name="item_id" value="${esc(l.item_id || '')}"><input type="hidden" name="src_line_id" value="${esc(l.src_line_id || '')}"><input type="hidden" name="description" value="${esc(l.description || '')}">`
        : `<select name="item_id" aria-label="Item">${itemOpt(l.item_id)}</select><input name="description" placeholder="or type a name / note" value="${esc(l.description || '')}" style="margin-top:4px"><div class="lastrate small" hidden></div>`}${lotCell(l)}</td>
      <td class="c-n" data-l="Qty"><input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(lineUf(l) ? Math.round(l.qty / lineUf(l) * 1000) / 1000 : l.qty ?? 1)}" aria-label="Quantity">${uomSel(l.item_id, lineUf(l) ? l.uom : '')}</td>
      <td class="c-n" data-l="${isNote && !isShort ? 'Rate diff ₹' : 'Rate ₹'}"><input name="rate" type="number" step="any" min="0" inputmode="decimal" value="${esc(lineUf(l) && l.rate !== '' && l.rate != null ? r2(l.rate * lineUf(l)) : l.rate ?? '')}" aria-label="Rate"${isShort ? ' readonly' : ''}></td>
      <td class="c-n" data-l="Disc %"><input name="discount_pct" type="number" step="any" min="0" max="100" inputmode="decimal" value="${esc(l.discount_pct ?? 0)}" aria-label="Discount percent"></td>
      <td class="c-n" data-l="GST"><select name="gst_rate" aria-label="GST rate">${gstOpt(l.gst_rate ?? 0)}</select></td>
      <td class="num c-amt" data-amt data-l="Amount"></td>
      <td class="c-del">${fromDoc && !isNote && ['SRET', 'PRET'].includes(type) ? '' : '<button type="button" class="btn sm danger" data-del aria-label="Remove line">&times;</button>'}</td></tr>`;
  const canScan = T.side === 'purchase' && !fromDoc && !isNoteType(type);
  el.innerHTML = head(`New ${esc(T.label)}${fromDoc ? ` <span class="muted">from ${esc(draft.ref_number)}</span>` : ''}`,
    (canScan ? '<button type="button" class="btn primary" id="scanbill">&#128247; Scan supplier bill</button><input type="file" id="scanfile" accept="image/*,application/pdf" hidden>' : '')
    + (!fromDoc && !isNoteType(type) ? '<button type="button" class="btn" id="voicebill" title="Speak the items">&#127908; Bolkar bill</button>' : '')) + `
    ${q.get('scan') && draft.scan_note ? `<div class="panel ${draft.scan_ok ? '' : 'warnbox'}">${draft.scan_note}</div>` : ''}
    <form id="docf"><div class="err" hidden></div>
    ${ge ? `<div class="panel warnbox">Receiving against gate entry <b>${esc(ge.number)}</b>: vehicle ${esc(ge.vehicle_no)}${ge.challan_no ? `, challan ${esc(ge.challan_no)}` : ''}${ge.packages ? `, ${ge.packages} packages` : ''}.</div>` : ''}
    ${isShort ? `<div class="panel warnbox">Goods that never came on ${esc(draft.ref_number)}: they are claimed back from the supplier at the bill's price, and ${esc(draft.ref_number)} stops waiting for them. Keep only the lines and quantities that are short.</div>`
      : isNote ? `<div class="panel muted">${isSale ? 'A credit note lowers what the customer owes' : 'A debit note lowers what you owe the supplier'} without any goods moving: rate difference, discount, short supply or damage claim. Enter the difference per unit on each line that changes.</div>` : ''}
    <div class="panel"><div class="form">
      <label class="f">${isSale ? 'Customer' : 'Supplier'}
        ${fromDoc ? `<input value="${esc((parties.find((p) => p.id === draft.party_id) || {}).name || '')}" disabled><input type="hidden" name="party_id" value="${draft.party_id}">`
          : `<select name="party_id" required><option value="">Choose…</option>${plist.map((p) => `<option value="${p.id}" ${p.id === +draft.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}</label>
      ${fromDoc ? '' : `<label class="f">&nbsp;<button type="button" class="btn" id="newparty">+ New ${side}</button></label>`}
      <label class="f">Date<input type="date" name="date" value="${esc(draft.date)}"${minDate() ? ` min="${minDate()}"` : ''}></label>
      ${refField ? `<label class="f">${type === 'GRN' ? 'Supplier challan / bill no.' : 'Supplier bill no.'}<input name="party_ref" maxlength="40" value="${esc(draft.party_ref || '')}" autocomplete="off"></label>` : ''}
      ${billFirst ? `<label class="f check wide"><input type="checkbox" name="transit"> <span>Goods not received yet (on the way)<small class="help">Stock comes in when the goods arrive: Purchase → Receive Goods.</small></span></label>` : ''}
      ${money ? '' : `${type === 'PO' || type === 'SO' || type === 'QUOTE' ? `<label class="f">${type === 'QUOTE' ? 'Valid until' : 'Expected by'}<input type="date" name="due_date" placeholder="auto"></label>` : ''}`}
      ${money ? `<details class="more-opts"${innerWidth > 860 || q.get('repeat') ? ' open' : ''}><summary>More options<span class="muted"> &middot; ${isSale && !isNote && !fromDoc ? 'price list, ' : ''}due date${!fromDoc && !isNote ? ', repeat' : ''}</span></summary><div class="form">
        ${isSale && !isNote && !fromDoc ? `<label class="f">Price<select name="price_mode"><option value="">Auto (customer's list${wholesaleMin() ? `, wholesale from ${wholesaleMin()} pcs` : ''})</option><option value="retail">Retail</option><option value="wholesale">Wholesale</option></select></label>` : ''}
        <label class="f">Due date<input type="date" name="due_date" placeholder="auto"></label>
        ${!fromDoc && !isNote ? `<label class="f">Repeat this ${isSale ? 'invoice' : 'bill'}<select name="repeat">${[['', 'No, just once'], ...Object.entries(EVERY_T)].map(([v, t]) => `<option value="${v}" ${v === (q.get('repeat') || '') ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <small class="help">Rent, tuition, AMC: a new one is made by itself${isSale ? ' and sent to the customer' : ''}.</small></label>` : ''}
      </div></details>` : ''}
      ${whs.length > 1 ? `<label class="f">Godown<select name="warehouse_id">${whs.map((w) => `<option value="${w.id}" ${w.id === +draft.warehouse_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>`
        : `<input type="hidden" name="warehouse_id" value="${whs[0] ? whs[0].id : ''}">`}
      ${cfInputs('doc', draft.extra || {}, T.side)}
    </div></div>
    ${isSale && !fromDoc && !isNote ? `<div class="panel expbox" id="expbox" hidden><h3>&#127760; Export invoice</h3><div class="form">
      <label class="f">GST on this export<select name="export_type"><option value="WOPAY">No IGST: under LUT / bond (zero rated)</option><option value="WPAY">With IGST paid (refund later)</option></select></label>
      <label class="f">Currency<select name="currency"><option value="">INR (rupees)</option>${(ME.currencies || []).map((c) => `<option value="${c}">${c}</option>`).join('')}</select></label>
      <label class="f">Rupees for 1 <span data-curname>unit</span><input name="fx_rate" type="number" step="any" min="0" inputmode="decimal" placeholder="83.25"><small class="help">The rate on the invoice date (customs notified, or your bank's).</small></label>
      <label class="f">Port code<input name="port_code" maxlength="10" placeholder="INNSA1"></label><label class="f">Shipping bill no.<input name="sb_no" maxlength="20" placeholder="later is fine"></label>
      <label class="f">Shipping bill date<input name="sb_date" type="date"></label></div><p class="muted small" data-exphelp></p></div>` : ''}
    ${fromDoc && draft.export_type ? `<div class="panel muted small">&#127760; Export ${draft.export_type === 'WPAY' ? 'with IGST' : 'under LUT, no IGST'}${draft.currency ? ` in ${esc(draft.currency)} at ₹${draft.fx_rate}` : ''}: the same terms as ${esc(draft.ref_number)}. Rates below are in rupees.</div>` : ''}
    ${isNote ? '' : `<label class="check incl-all"><input type="checkbox" id="inclall" ${(draft.incl ?? (isSale && !draft.lines.some((l) => l.rate) && (inclPref() || items.some((x) => x.price_incl)))) ? 'checked' : ''}> Rates include GST (MRP)</label>`}
    ${fromDoc || isNote ? '' : `<div class="panel scanbar no-print"><div class="row"><label class="pqty">Qty<input id="dqty" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Pieces for the next scan"></label><input id="dscan" placeholder="Scan QR / barcode to add an item (or type its code)" autocomplete="off" enterkeyhint="done" style="flex:1;min-width:0" aria-label="Scan item code">${canCamera() ? '<button type="button" class="btn primary" id="dcam">&#128247; Scan</button>' : ''}</div>
      <div class="muted small">Many pieces of one design / colour / size: type the quantity, then scan once.</div><div id="dslog" class="pk-log small" aria-live="polite"></div>${isSale && wholesaleMin() ? `<div class="muted small" id="wsnote">Wholesale price on every item once the order has ${wholesaleMin()} pieces or more.</div>` : ''}</div>`}
    <div class="panel flush"><div class="tbl-wrap"><table class="t lines"><thead><tr><th>Item</th><th>Qty</th><th>${isNote ? 'Rate diff (₹/unit)' : 'Rate (₹)'}</th><th>Disc %</th><th>GST</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody id="lines">${draft.lines.map(lineRow).join('')}</tbody></table></div>
      ${fromDoc ? '' : '<div style="padding:10px"><button type="button" class="btn sm" id="addline">+ Add line</button></div>'}</div>
    <div class="grid g2">
      <div class="panel"><label class="f">Design <span class="muted">(how this bill looks)</span><select name="design">${designOptions(draft.design || '', true)}</select></label><label class="f">Notes / terms<textarea name="notes" rows="3">${esc(draft.notes || '')}</textarea></label>
        ${money ? `<div class="form" style="margin-top:12px"><label class="f">${isSale ? 'Amount received now' : 'Amount paid now'} (₹)<input type="number" step="any" min="0" inputmode="decimal" name="pay_amount" placeholder="0"><small class="help">Leave empty for credit (udhaar).</small></label>
          <label class="f">${isSale ? 'Money went into' : 'Paid from'}<select name="pay_account">${cashAccts.map((o) => `<option value="${o.v}">${esc(o.t)}</option>`).join('')}</select></label></div>` : ''}
        ${type === 'INV' && LOY.on ? '<div class="pts" id="ptsbox" hidden></div>' : ''}</div>
      <div class="panel"><div class="totals" id="totals"></div></div>
    </div>
    <div class="panel warnbox cwarn" id="cwarn" role="status" hidden></div>
    <div class="row savebar"><span class="sb-total" id="sbtotal"></span><span class="spacer"></span><a class="btn hide-sm" href="#" data-act="back">Cancel</a><button class="btn primary" id="save">Save ${esc(T.label)}</button></div></form>`;

  const form = $('#docf'), tbody = $('#lines');
  // loyalty points (Sales → Loyalty Points): the customer's balance, and how many of them pay part of this invoice
  let pts = null;
  const ptsUse = () => Math.max(0, Math.floor(+((form.elements.redeem_points || {}).value || 0)));
  const ptsMost = () => pts && pts.can_use ? Math.max(0, Math.min(pts.balance, Math.floor((+form.dataset.total || 0) * LOY.max_pct / 100 / LOY.point_value + 1e-9))) : 0;
  const ptsValue = () => r2(Math.min(ptsUse(), ptsMost()) * LOY.point_value);
  const showPts = () => {
    const box = $('#ptsbox'); if (!box) return;
    box.hidden = !(pts && pts.earns && pts.on);
    if (box.hidden) return;
    box.innerHTML = pts.balance > 0 && pts.can_use
      ? `<label class="f">&#11088; Loyalty points to use <small class="muted">${esc(pts.party.name)} has <b>${pts.balance}</b> (worth ${inr(pts.value)})</small>
          <span class="row"><input type="number" name="redeem_points" min="0" step="1" inputmode="numeric" placeholder="0" style="max-width:120px"><button type="button" class="btn sm" data-ptsmax></button></span>
          <small class="help">1 point = ${inr(LOY.point_value)} &middot; up to ${LOY.max_pct}% of a bill &middot; earns ${LOY.earn_per > 1 ? `1 point per ${inr(LOY.earn_per)}` : '1 point per rupee'}</small></label>`
      : `<p class="muted small">&#11088; ${esc(pts.party.name)}: ${pts.balance} loyalty point${pts.balance === 1 ? '' : 's'}${pts.balance > 0 && LOY.min_points ? ` (usable from ${LOY.min_points})` : ''}. This bill earns ${LOY.earn_per > 1 ? `1 point per ${inr(LOY.earn_per)}` : '1 point per rupee'}.</p>`;
    const b = $('[data-ptsmax]', box);
    if (b) b.onclick = () => { form.elements.redeem_points.value = ptsMost() || ''; recalc(); };
  };
  /* export (the customer's state is "Other Country"): LUT or IGST, a currency and its rupee rate, the shipping bill. Once a currency
     has its rate, the rates on screen are in that currency (they are sent as such, and the server turns them into rupees). */
  const isExp = () => !!$('#expbox') && /^other country$/i.test(String((parties.find((x) => x.id === +((form.elements.party_id || {}).value || 0)) || {}).state || '').trim());
  const basis = { cur: '', fx: 0 };          // what the rates on screen are in now
  const expCur = () => (isExp() ? form.elements.currency.value : '');
  const expFx = () => +((form.elements.fx_rate || {}).value || 0);
  const shown = (v) => (basis.cur && basis.fx ? r2(v / basis.fx) : v);
  const rebase = () => {
    const cur = expCur(), fx = expFx();
    if (cur === basis.cur) { if (cur && fx) basis.fx = fx; return; }
    if (cur && !fx) return;                  // wait for the rate
    const oldFx = basis.fx || fx;
    $$('tr', tbody).forEach((tr) => {
      const r = $('[name=rate]', tr); if (!r || r.value === '') return;
      const rupees = basis.cur ? +r.value * oldFx : +r.value;
      r.value = cur ? r2(rupees / fx) : r2(rupees);
    });
    basis.cur = cur; basis.fx = cur ? fx : 0;
  };
  const expHelp = () => {
    const box = $('#expbox'); if (!box) return;
    box.hidden = !isExp();
    if (box.hidden) { if (basis.cur) { form.elements.currency.value = ''; rebase(); } return; }
    const c = form.elements.currency.value;
    $('[data-curname]', box).textContent = c || 'unit';
    $('[data-exphelp]', box).textContent = (form.elements.export_type.value === 'WPAY' ? 'IGST at each item\'s rate is charged and paid; claim it back as a refund. '
      : `No GST: the invoice says "supply meant for export under LUT"${ME.org.lut ? ` with your LUT ${ME.org.lut}` : ' (add your LUT number in Settings → Business)'}. `)
      + (c ? (basis.cur ? `Rates below are in ${c}; the invoice shows both ${c} and rupees.` : `Type the rupee rate for 1 ${c}; the rates below then turn into ${c}.`) : 'Rates below are in rupees.');
  };
  const loadPts = async () => {
    pts = null;
    const pid = +((form.elements.party_id || {}).value || 0);
    if (type === 'INV' && LOY.on && pid) { try { pts = await GET('/api/loyalty/' + pid); } catch (e) { pts = null; } }
    if (pid === +((form.elements.party_id || {}).value || 0)) { showPts(); recalc(); }
  };
  // bolkar bill: the lines spoken go on the bill (an empty first line is used first), each priced as if chosen by hand
  if ($('#voicebill')) $('#voicebill').onclick = () => voiceOrder(items, (got) => {
    for (const g of got) {
      let tr = $$('tr', tbody).find((r) => !(($('select[name=item_id]', r) || {}).value) && !(($('[name=description]', r) || {}).value));
      if (!tr) { tbody.insertAdjacentHTML('beforeend', lineRow({})); tr = tbody.lastElementChild; wireRow(tr); }
      $('[name=qty]', tr).value = g.qty;
      const sel = $('select[name=item_id]', tr); sel.value = g.item_id; sel.dispatchEvent(new Event('change'));
    }
    if (got.length) toast(`${got.length} line${got.length === 1 ? '' : 's'} added`);
    recalc();
  });
  if ($('#scanbill')) { $('#scanbill').onclick = () => $('#scanfile').click(); $('#scanfile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scanBillFlow(f, type); }; }
  const partyOf = () => parties.find((p) => p.id === +form.elements.party_id.value);
  // udhaar check (Vaada Pakka): a banner while the sale is on credit, for a risky customer
  let risk = null, riskFor = 0;
  const creditBanner = () => {
    const box = $('#cwarn'); if (!box) return;
    const paid = (form.elements.pay_amount ? +form.elements.pay_amount.value || 0 : 0) + ptsValue();
    box.hidden = !(risk && risk.risky && paid < (+form.dataset.total || 0));
    if (!box.hidden) box.innerHTML = creditText(risk);
  };
  const loadRisk = async () => {
    const pid = +form.elements.party_id.value || 0;
    if (type !== 'INV' || pid === riskFor) return;
    riskFor = pid; risk = pid ? await creditCheck(pid) : null;
    if (riskFor === pid) creditBanner();
  };
  if (type === 'INV') { form.elements.party_id.addEventListener('change', loadRisk); if (form.elements.pay_amount) form.elements.pay_amount.addEventListener('input', creditBanner); }
  const incl = () => !!($('#inclall') && $('#inclall').checked);
  /* the price a line starts from: the wholesale price for a wholesale customer or from the item's wholesale quantity, else the selling price
     (the same rule the server uses when a rate is left out); and what this customer paid for it last */
  const partyNow = () => parties.find((x) => x.id === +((form.elements.party_id || {}).value || 0)) || {};
  // pieces of stock items on this document (a box counts its pieces), for "wholesale from N pieces in one order"
  const orderPcs = () => $$('tr', tbody).reduce((sum, tr) => {
    const it = items.find((i) => i.id === +(($('[name=item_id]', tr) || {}).value || 0));
    return sum + (it && !it.is_service ? (+(($('[name=qty]', tr) || {}).value) || 0) * altF(tr) : 0);
  }, 0);
  const priceMode = () => ((form.elements.price_mode || {}).value || '');
  const listRate = (it, qty, on = incl()) => {
    const pm = priceMode();
    const whole = it.wholesale_price > 0 && (pm === 'wholesale' || (pm !== 'retail' && (partyNow().price_level === 'wholesale' || (it.wholesale_min > 0 && qty >= it.wholesale_min)
      || (isSale && wholesaleMin() > 0 && orderPcs() >= wholesaleMin()))));
    return whole ? (on ? it.wholesale_price_incl : it.wholesale_price) : (on ? it.sale_price_incl : it.sale_price);
  };
  let lastRates = {};
  const showLast = (tr) => {
    const box = $('.lastrate', tr); if (!box) return;
    const id = +(($('[name=item_id]', tr) || {}).value || 0), last = lastRates[id];
    const it = isSale && !isNote && id ? items.find((i) => i.id === id) : null;
    const noPrice = !!(it && !(listRate(it, +(($('[name=qty]', tr) || {}).value) || 0) > 0) && !(+(($('[name=rate]', tr) || {}).value) > 0));
    box.hidden = !last && !noPrice;
    box.innerHTML = (noPrice ? `<span class="norate">No sale price saved for this item: type the rate.</span> ` : '')
      + (last ? `<span class="muted">Last to this customer</span> <b>${inr(last.rate)}${last.discount_pct ? ` −${last.discount_pct}%` : ''}</b> <span class="muted">${fdate(last.date)}</span> <button type="button" class="btn sm" data-uselast>Use</button>` : '');
  };
  const loadLast = async () => {
    lastRates = {};
    const pid = +((form.elements.party_id || {}).value || 0);
    if (isSale && !isNote && pid) { try { lastRates = (await GET('/api/rates?party_id=' + pid)).rates || {}; } catch (e) { lastRates = {}; } }
    $$('tr', tbody).forEach((tr) => {
      showLast(tr);
      const it = items.find((i) => i.id === +(($('[name=item_id]', tr) || {}).value || 0));
      if (it && isSale && !isNote && tr.dataset.auto === '1') { const f = altF(tr); $('[name=rate]', tr).value = shown(r2(listRate(it, (+$('[name=qty]', tr).value || 0) * f) * f)); }
    });
    recalc();
  };
  const recalc = () => {
    const p = partyOf(), ex = isExp(), inter = ex || !!(p && p.state && ME.org.state && p.state.toLowerCase() !== ME.org.state.toLowerCase());
    const lut = ex && form.elements.export_type.value === 'WOPAY', inc = incl() && !ex;
    const M = (v) => (basis.cur ? fcMoney(v, basis.cur) : inr(v));
    let taxable = 0, tax = 0;
    $$('tr', tbody).forEach((tr) => {
      const g = (n) => +($(`[name=${n}]`, tr).value || 0), base = g('qty') * g('rate') * (1 - g('discount_pct') / 100), gr = lut ? 0 : g('gst_rate');
      // with GST in the rate the line total is the rate itself and the tax is taken out of it
      const t = inc ? r2(base * 100 / (100 + gr)) : r2(base), x = inc ? r2(r2(base) - t) : r2(t * gr / 100);
      taxable += t; tax += x; $('[data-amt]', tr).textContent = M(t + x);
    });
    const exact = r2(taxable + tax), total = !basis.cur && (money || isNote || ['SRET', 'PRET'].includes(type)) ? Math.round(exact) : exact;
    $('#totals').innerHTML = `<div><span>Taxable value</span><span>${M(taxable)}</span></div>
      ${inter ? `<div><span>IGST${lut ? ' (LUT: none)' : ''}</span><span>${M(tax)}</span></div>` : `<div><span>CGST</span><span>${inr(tax / 2)}</span></div><div><span>SGST</span><span>${inr(tax / 2)}</span></div>`}
      ${total !== exact ? `<div><span>Round off</span><span>${inr(total - exact)}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${M(total)}</span></div>${basis.cur ? `<div class="muted small"><span>In rupees at ₹${basis.fx}</span><span>${inr(r2(total * basis.fx))}</span></div>` : ''}`;
    $('#sbtotal').innerHTML = `Total <b>${M(total)}</b>`;
    form.dataset.total = total;
    // points: what they pay, and the rest still to pay
    const most = ptsMost(), pb = $('[data-ptsmax]');
    if (pb) { pb.textContent = most ? `Use ${most}` : 'None on this bill'; pb.disabled = !most; form.elements.redeem_points.max = most; }
    const pv = ptsValue();
    if (pv > 0) {
      $('#totals').insertAdjacentHTML('beforeend', `<div><span>&#11088; Paid with ${Math.min(ptsUse(), most)} points</span><span>&minus;${inr(pv)}</span></div><div><span>To pay</span><span>${inr(total - pv)}</span></div>`);
      $('#sbtotal').innerHTML = `To pay <b>${inr(total - pv)}</b> <span class="muted small">(${inr(total)} &minus; points)</span>`;
    }
    if (type === 'INV') creditBanner();
  };
  const lotCache = new Map();
  const lotsOf = (id, wid) => {
    const key = id + ':' + wid;
    if (!lotCache.has(key)) lotCache.set(key, GET(`/api/items/${id}/lots?warehouse_id=${wid}`).catch(() => ({ batches: [], serials: [] })));
    return lotCache.get(key);
  };
  const fillSerials = async (tr) => {
    const box = $('[data-snpick]', tr), id = +(($('[name=item_id]', tr) || {}).value || 0), wid = +form.elements.warehouse_id.value || 0;
    if (!box || !id || !tracksSn(id)) return;
    const list = (await lotsOf(id, wid)).serials || [];
    box.innerHTML = list.length ? `<span class="muted">In stock:</span> ${list.slice(0, 40).map((x) => `<button type="button" class="snchip" data-sn="${esc(x.serial)}">${esc(x.serial)}</button>`).join('')}${list.length > 40 ? ` <span class="muted">+${list.length - 40} more: scan or type</span>` : ''}`
      : '<span class="muted">No serial numbers in stock here.</span>';
  };
  const fillBatches = async (tr) => {
    fillSerials(tr);
    const bsel = $('[data-batches]', tr), id = +(($('[name=item_id]', tr) || {}).value || 0), wid = +form.elements.warehouse_id.value || 0;
    if (!bsel || !id || !tracks(id)) return;
    const list = (await lotsOf(id, wid)).batches || [], cur = bsel.value;
    bsel.innerHTML = '<option value="">Batch: first to expire</option>' + list.map((b) => `<option value="${esc(b.batch_no)}">${esc(b.batch_no)}${b.expiry ? ` · exp ${mmyy(b.expiry)}` : ''} · ${qtyf(b.qty)} left</option>`).join('')
      + (cur && !list.some((b) => b.batch_no === cur) ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '');
    bsel.value = cur;
  };
  const wireRow = (tr) => {
    const sel = $('select[name=item_id]', tr);
    if (sel) sel.onchange = () => {
      const it = items.find((i) => i.id === +sel.value);
      const us = $('[name=uom]', tr);
      if (us) { const a = altOf(sel.value); us.innerHTML = uomOpts(a, ''); us.hidden = !a; us.value = ''; }
      if (it) {
        if (!isNote) {
          const lr = isSale ? listRate(it, +$('[name=qty]', tr).value || 0) : (it.purchase_price || it.avg_cost);
          // an item with no sale price saved gets an empty rate to type, not a silent ₹0
          $('[name=rate]', tr).value = lr > 0 ? (isSale ? shown(lr) : lr) : '';
        }
        tr.dataset.auto = '1';
        $('[name=gst_rate]', tr).value = it.gst_rate;
        $('[name=description]', tr).value = '';
      }
      const lot = $('.lot', tr);
      if (lot) { lot.hidden = !(it && it.track_batch); const b = $('[name=batch_no]', lot); if (b && !lot.hidden && b.tagName === 'SELECT') { b.value = ''; fillBatches(tr); } }
      const sn = $('.sn', tr);
      if (sn) { sn.hidden = !(it && it.track_serial); $('[name=serials]', sn).value = ''; if (!sn.hidden) fillSerials(tr); }
      showLast(tr);
      recalc();
    };
    // a rate the user typed stays; one the app filled follows the quantity across the wholesale step
    const rateIn = $('[name=rate]', tr), qtyIn = $('[name=qty]', tr);
    if (rateIn) rateIn.addEventListener('input', () => { tr.dataset.auto = ''; rateIn.classList.remove('need'); showLast(tr); });
    if (qtyIn && isSale && !isNote) qtyIn.addEventListener('input', () => {
      const it = items.find((i) => i.id === +((sel || {}).value || 0)), f = altF(tr);
      if (it && tr.dataset.auto === '1') rateIn.value = shown(r2(listRate(it, (+qtyIn.value || 0) * f) * f));
    });
    // switching Box ↔ Pcs keeps the line's value: the quantity and the rate are turned over by the box size
    const us = $('[name=uom]', tr);
    if (us) us.addEventListener('change', () => {
      const it = altOf((sel || $('[name=item_id]', tr) || {}).value); if (!it) return;
      const toAlt = !!us.value, f = it.alt_factor, q = +qtyIn.value || 0, r = +rateIn.value || 0;
      qtyIn.value = Math.round((toAlt ? q / f : q * f) * 1000) / 1000;
      if (rateIn.value !== '') rateIn.value = r2(toAlt ? r * f : r / f);
      recalc();
    });
    const use = $('.lastrate', tr);
    if (use) use.onclick = (e) => {
      if (!e.target.closest('[data-uselast]')) return;
      const last = lastRates[+((sel || {}).value || 0)]; if (!last) return;
      const g = +(($('[name=gst_rate]', tr) || {}).value || 0);
      rateIn.value = shown(incl() ? r2(last.rate * (100 + g) / 100) : last.rate);
      if (last.discount_pct) $('[name=discount_pct]', tr).value = last.discount_pct;
      tr.dataset.auto = ''; recalc();
    };
    // scanning serials sets the quantity; a tap on a serial in stock adds it
    const snBox = $('textarea[name=serials]', tr);
    const snCount = () => { const n = snBox.value.split(/[\s,;]+/).filter(Boolean).length; if (n) { $('[name=qty]', tr).value = n; recalc(); } };
    if (snBox) snBox.addEventListener('input', snCount);
    const pick = $('[data-snpick]', tr);
    if (pick) pick.onclick = (e) => {
      const b = e.target.closest('[data-sn]'); if (!b) return;
      const have = snBox.value.split(/[\s,;]+/).filter(Boolean);
      snBox.value = (have.includes(b.dataset.sn) ? have.filter((x) => x !== b.dataset.sn) : [...have, b.dataset.sn]).join('\n');
      b.classList.toggle('on', !have.includes(b.dataset.sn)); snCount();
    };
    fillBatches(tr);
    const del = $('[data-del]', tr);
    // the last line too: it goes, and an empty line takes its place to choose another item
    if (del) del.onclick = () => {
      tr.remove();
      if (!$$('tr', tbody).length) { tbody.insertAdjacentHTML('beforeend', lineRow({})); wireRow(tbody.lastElementChild); enhanceSelects(tbody.lastElementChild); }
      recalc(); stockWarn();
    };
  };
  $$('tr', tbody).forEach(wireRow);
  // the whole order crossed (or fell below) the wholesale step: every rate the app filled follows; typed rates stay
  let wasWhole = null;
  const reprice = () => $$('tr', tbody).forEach((tr) => {
    const it = items.find((i) => i.id === +(($('[name=item_id]', tr) || {}).value || 0)), f = altF(tr);
    if (it && tr.dataset.auto === '1') $('[name=rate]', tr).value = shown(r2(listRate(it, (+$('[name=qty]', tr).value || 0) * f) * f));
  });
  if (form.elements.price_mode) form.elements.price_mode.addEventListener('change', () => { reprice(); stockWarn(); recalc(); });
  // a sales order or quotation asks for more than is in stock: a warning on the line (stock goes out only on the delivery note)
  const stockWarn = () => {
    if (!isSale || isNote || !['SO', 'QUOTE', 'INV'].includes(type) || wfOf().stock_check === 'off') return;
    const want = new Map();
    $$('tr', tbody).forEach((tr) => { const id = +(($('[name=item_id]', tr) || {}).value || 0); if (id) want.set(id, (want.get(id) || 0) + (+(($('[name=qty]', tr) || {}).value) || 0) * altF(tr)); });
    $$('tr', tbody).forEach((tr) => {
      const id = +(($('[name=item_id]', tr) || {}).value || 0), it = items.find((i) => i.id === id), cell = $('.c-item', tr);
      let w = $('.stockwarn', tr);
      // free to sell = in stock − already promised to open orders
      const free = it ? (it.available ?? it.qty_on_hand ?? 0) : 0;
      const short = it && !it.is_service && want.get(id) > free + 0.0005;
      if (!short) { if (w) w.remove(); return; }
      if (!w) { cell.insertAdjacentHTML('beforeend', '<div class="stockwarn neg small" role="status"></div>'); w = $('.stockwarn', tr); }
      w.textContent = `⚠ Only ${qtyf(Math.max(0, free))} ${it.unit || ''} free (asked ${qtyf(want.get(id))})${it.reserved ? ` · ${qtyf(it.qty_on_hand)} in stock, ${qtyf(it.reserved)} on other orders` : ''}`;
    });
  };
  form.addEventListener('input', () => stockWarn());
  form.addEventListener('change', () => stockWarn());
  const wholeStep = () => {
    if (!isSale || isNote || !wholesaleMin() || priceMode()) return;
    const now = orderPcs() >= wholesaleMin();
    if (now === wasWhole) return;
    wasWhole = now;
    $$('tr', tbody).forEach((tr) => {
      const it = items.find((i) => i.id === +(($('[name=item_id]', tr) || {}).value || 0)), f = altF(tr);
      if (it && tr.dataset.auto === '1') $('[name=rate]', tr).value = shown(r2(listRate(it, (+$('[name=qty]', tr).value || 0) * f) * f));
    });
    const n = $('#wsnote'); if (n) n.innerHTML = now ? `<b class="pos">Wholesale price applied: ${qtyf(orderPcs())} pieces in this order.</b>` : `Wholesale price on every item once the order has ${wholesaleMin()} pieces or more (now ${qtyf(orderPcs())}).`;
  };
  form.addEventListener('input', wholeStep);
  form.addEventListener('change', wholeStep);
  // scanning: each scan adds the item, or one more piece of it when it is already on a line (one QR per design, colour, size)
  const scanLog = [];
  const scanned = async (raw) => {
    const code = String(raw || '').trim();
    if (!code) return false;
    const say = (ok, t) => { scanLog.push({ ok, t }); const b = $('#dslog'); if (b) b.innerHTML = scanLog.slice(-4).reverse().map((x) => `<div class="${x.ok ? 'pos' : 'neg'}">${esc(x.t)}</div>`).join(''); beep(ok); };
    let it;
    try { it = await GET('/api/items/lookup?code=' + encodeURIComponent(code)); }
    catch (e) {
      if (e.status !== 404) { say(false, `✗ ${e.message}`); return false; }
      it = await teachCode(code, (e.data && e.data.candidates) || [], items);
      if (!it) { say(false, `✗ ${code.slice(0, 60)}: not added`); return false; }
    }
    if (!items.some((i) => i.id === it.id)) {             // an item made after this screen opened
      items.push(it);
      $$('select[name=item_id]', tbody).forEach((sl) => sl.insertAdjacentHTML('beforeend', `<option value="${it.id}">${esc(it.name)}</option>`));
    }
    // the quantity typed before the scan (5 pieces: one scan), then back to 1 for the next one
    const qBox = $('#dqty'), times = Math.max(1, Math.round(+(qBox || {}).value || 1));
    if (qBox) qBox.value = 1;
    const n = (it.pack_qty || 1) * times;
    let tr = $$('tr', tbody).find((r) => +((($('select[name=item_id]', r) || {}).value) || 0) === it.id && !(($('[name=uom]', r) || {}).value));
    if (tr) {
      const q = $('[name=qty]', tr);
      q.value = Math.round(((+q.value || 0) + n) * 1000) / 1000;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      tr = $$('tr', tbody).find((r) => !(($('select[name=item_id]', r) || {}).value) && !(($('[name=description]', r) || {}).value));
      if (!tr) { tbody.insertAdjacentHTML('beforeend', lineRow({})); tr = tbody.lastElementChild; wireRow(tr); enhanceSelects(tr); }
      $('[name=qty]', tr).value = n;
      const sl = $('select[name=item_id]', tr); sl.value = it.id; sl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    wholeStep(); recalc();
    tr.classList.remove('scan-hit'); void tr.offsetWidth; tr.classList.add('scan-hit');
    stockWarn();
    say(true, `✓ ${it.name} — ${qtyf(+$('[name=qty]', tr).value)} on this ${T.label.toLowerCase()}${it.qty_on_hand !== undefined ? ` · ${qtyf(it.available ?? it.qty_on_hand)} free${it.reserved ? ` (${qtyf(it.reserved)} on orders)` : ''}` : ''}`);
    return true;
  };
  if ($('#dscan')) $('#dscan').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value; e.target.value = '';
    await scanned(v); e.target.focus();
  });
  if ($('#dcam')) $('#dcam').onclick = () => cameraScan(scanned);
  form.addEventListener('input', recalc);
  form.addEventListener('change', recalc);
  if ($('#addline')) $('#addline').onclick = () => { tbody.insertAdjacentHTML('beforeend', lineRow({})); wireRow(tbody.lastElementChild); enhanceSelects(tbody.lastElementChild); recalc(); };
  // Enter in a line moves to the next line's quantity; on the last line it adds a line and puts the cursor on its item
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input[name=qty], input[name=rate], input[name=discount_pct], input[name=description]')) return;
    e.preventDefault();
    const tr = e.target.closest('tr'), next = tr.nextElementSibling;
    if (next) { const f = $(`[name=${e.target.name}]`, next) || $('[name=qty]', next); if (f) { f.focus(); f.select && f.select(); } return; }
    if ($('#addline')) { $('#addline').click(); const it = $('.combo-in, select[name=item_id]', tbody.lastElementChild); if (it) it.focus(); }
  });
  if (form.elements.party_id && form.elements.party_id.tagName === 'SELECT' && isSale && !isNote) { form.elements.party_id.addEventListener('change', loadLast); if (form.elements.party_id.value) loadLast(); }
  if (form.elements.warehouse_id && form.elements.warehouse_id.tagName === 'SELECT') form.elements.warehouse_id.addEventListener('change', () => $$('tr', tbody).forEach(fillBatches));
  if ($('#newparty')) $('#newparty').onclick = () => partyForm({ kind: side }, async (p) => {
    parties.push(p); const s = form.elements.party_id;
    s.insertAdjacentHTML('beforeend', `<option value="${p.id}">${esc(p.name)}</option>`); s.value = p.id; recalc();
  });
  // switching the box re-reads each rate the other way (an item's own price, else the typed rate with or without its GST)
  if ($('#inclall')) $('#inclall').onchange = () => {
    const on = incl();
    if (isSale) inclPref(on);
    $$('tr', tbody).forEach((tr) => {
      const r = $('[name=rate]', tr); if (!r || r.value === '') return;
      const it = items.find((i) => i.id === +(($('[name=item_id]', tr) || {}).value || 0)), g = +(($('[name=gst_rate]', tr) || {}).value || 0);
      r.value = it && isSale && tr.dataset.auto === '1' ? listRate(it, +$('[name=qty]', tr).value || 0, on) : r2(on ? +r.value * (100 + g) / 100 : +r.value * 100 / (100 + g));
    });
    recalc();
  };
  if (type === 'INV' && LOY.on && form.elements.party_id) { form.elements.party_id.addEventListener('change', loadPts); if (form.elements.party_id.value) loadPts(); }
  if ($('#expbox')) {
    form.elements.party_id.addEventListener('change', () => { expHelp(); recalc(); });
    for (const n of ['currency', 'fx_rate', 'export_type']) form.elements[n].addEventListener('change', () => { rebase(); expHelp(); recalc(); });
    expHelp();
  }
  recalc(); loadRisk();
  // one Idempotency-Key for this form: a second tap, or a save sent again after its answer was lost on a bad
  // connection, gets the first invoice back instead of making another (a refused save frees the key)
  const saveKey = newKey();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    if (isExp() && expCur() && expFx() > 0 && expCur() !== basis.cur) { rebase(); recalc(); }
    const sent = [];
    const lines = $$('tr', tbody).map((tr) => {
      const g = (n) => { const x = $(`[name=${n}]`, tr); return x ? x.value : ''; };
      const uom = g('uom');
      return { tr, item_id: +g('item_id') || null, description: g('description'), qty: g('qty'), rate: g('rate'), discount_pct: g('discount_pct'), gst_rate: g('gst_rate'), src_line_id: +g('src_line_id') || undefined,
        ...(uom ? { uom, uom_qty: g('qty') } : {}),
        batch_no: g('batch_no'), expiry: g('expiry'), serials: g('serials'), incl: incl() || undefined };
    }).filter((l) => +l.qty > 0 && (!isNote || +l.rate > 0)).map(({ tr, ...l }) => { sent.push(tr); return l; });
    const body = { type, party_id: +f.party_id.value, date: f.date.value, warehouse_id: +f.warehouse_id.value, notes: f.notes.value, lines, ref_id: draft.ref_id, extra: cfRead(form), design: f.design ? f.design.value : '' };
    if (ge) body.gate_entry_id = ge.id;
    if (f.party_ref) body.party_ref = f.party_ref.value.trim();
    if (f.transit && f.transit.checked) body.transit = true;
    if (isShort) body.short = true;
    if (f.due_date && f.due_date.value) body.due_date = f.due_date.value;
    if (f.pay_amount && +f.pay_amount.value > 0) body.payment = { amount: +f.pay_amount.value, account_id: +f.pay_account.value };
    if (ptsValue() > 0) body.redeem_points = Math.min(ptsUse(), ptsMost());
    if (isExp()) {
      if (expCur() && !(expFx() > 0)) { toast(`Type the rupee rate for 1 ${expCur()}.`, 'err'); return; }
      if (expCur() !== basis.cur) rebase();
      Object.assign(body, { export_type: f.export_type.value, currency: basis.cur, fx_rate: basis.cur ? expFx() : 0, rates_in: basis.cur ? 'fc' : undefined,
        port_code: f.port_code.value, sb_no: f.sb_no.value, sb_date: f.sb_date.value || undefined });
    }
    if (type === 'INV') body.credit_ok = false;
    if (isSale && !isNote && type !== 'SRET') body.zero_ok = false;
    const btn = $('#save'); btn.disabled = true;
    const save = async () => {
      try {
        const d = await POST('/api/docs', body, { key: saveKey });
        if (d.queued) { toast('No internet: saved on this device. It is sent by itself when you are back online.', 'info'); go('outbox'); return; }
        dirty('items', 'parties', 'accounts');
        if (jobId) { try { await api('PUT', '/api/jobs/' + jobId, { action: 'bill', inv_id: d.id }); } catch (er) { toast(`${d.number} saved, but not linked to the job: ${er.message}`, 'err'); } }
        if (f.repeat && f.repeat.value) {
          try {
            const rr = await POST(`/api/docs/${d.id}/recurring`, { every: f.repeat.value });
            toast(`${d.number} saved. The next one is made by itself on ${fdate(rr.next_on)}, then ${EVERY_T[f.repeat.value].toLowerCase()}.`); go('recurring'); return;
          } catch (er) { toast(`${d.number} saved, but it could not be set to repeat: ${er.message}`, 'err'); go('doc/' + d.id); return; }
        }
        toast(d.transit === 1 ? `${d.number} saved. When the goods come, receive them in Purchase → Receive Goods.` : `${d.number} saved`); go('doc/' + d.id);
      } catch (err) {
        if (err.status === 409 && err.data.credit_warning) {
          return creditSheet(err.data.credit_warning, { yes: () => { body.credit_ok = true; save(); },
            cash: () => { if (f.pay_amount) { f.pay_amount.value = form.dataset.total || ''; f.pay_amount.focus(); f.pay_amount.scrollIntoView({ block: 'center' }); creditBanner(); } } });
        }
        if (err.status === 409 && err.data.zero_rate) {
          return zeroSheet(err.data.zero_rate, { yes: () => { body.zero_ok = true; save(); },
            fix: (z) => { const tr = sent[z.line - 1], r = tr && $('[name=rate]', tr); if (r) { r.classList.add('need'); r.scrollIntoView({ block: 'center' }); r.focus(); } } });
        }
        const b = $('.err', form); b.hidden = false; b.textContent = err.message; window.scrollTo(0, 0);
      }
    };
    try { await save(); } finally { btn.disabled = false; }
  };
});

/* ======================================================================= document view / print */
/* The printable document (invoice, bill, order...). Used in the app and on the customer's public link. */
/* Invoice designs (same keys as LAYOUTS in src/custom.js) */
const DESIGNS = [['classic', 'Classic'], ['modern', 'Modern'], ['elegant', 'Elegant'], ['bold', 'Bold'], ['minimal', 'Minimal'], ['gst', 'GST detailed (HSN summary)'],
  ['compact', 'Thermal 80 mm'], ['compact58', 'Thermal 58 mm']];
const designOptions = (cur, withDefault) => (withDefault ? `<option value="">Default (${esc((DESIGNS.find(([k]) => k === ((ME.org.print || {}).layout || 'classic')) || DESIGNS[0])[1])})</option>` : '')
  + DESIGNS.map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
/* HSN-wise tax summary (GST detailed design) */
function hsnSummary(d, inter) {
  const g = new Map();
  for (const l of d.lines) {
    const k = (l.hsn || '-') + '|' + l.gst_rate, r = g.get(k) || { hsn: l.hsn || '-', rate: l.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += +l.taxable || 0; r.cgst += +l.cgst || 0; r.sgst += +l.sgst || 0; r.igst += +l.igst || 0; g.set(k, r);
  }
  const rows = [...g.values()];
  return `<table class="dl hsn"><thead><tr><th>HSN/SAC</th><th class="num">Taxable</th><th class="num">Rate</th>${inter ? '<th class="num">IGST</th>' : '<th class="num">CGST</th><th class="num">SGST</th>'}<th class="num">Total tax</th></tr></thead><tbody>`
    + rows.map((r) => `<tr><td>${esc(r.hsn)}</td><td class="num">${inr(r.taxable)}</td><td class="num">${r.rate}%</td>${inter ? `<td class="num">${inr(r.igst)}</td>` : `<td class="num">${inr(r.cgst)}</td><td class="num">${inr(r.sgst)}</td>`}<td class="num">${inr(r.cgst + r.sgst + r.igst)}</td></tr>`).join('')
    + '</tbody></table>';
}

/* batch and expiry as printed: "Batch B2 · Exp 12/26" */
const mmyy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(2, 4)}` : '');
const batchLine = (l) => (l.batch_no ? `<div class="muted">Batch ${esc(l.batch_no)}${l.expiry ? ` · Exp ${mmyy(l.expiry)}` : ''}</div>` : '');
const lotLine = (l) => batchLine(l) + (l.serials ? `<div class="muted">S/N: ${esc(l.serials)}</div>` : '');
/* loyalty points on a printed invoice: what it earned and used, and the balance now */
const pointsLine = (d, tag = 'p') => (d.points && d.type === 'INV' && d.status !== 'cancelled'
  ? `<${tag} class="ptsp">&#11088; Loyalty points: earned <b>${d.points.earned}</b>${d.points.used ? `, used <b>${d.points.used}</b>` : ''} &middot; balance <b>${d.points.balance}</b></${tag}>` : '');
function docPaper(d) {
  const o = d.org, p = d.party || {}, P = o.print || {};
  const isTax = ['INV', 'BILL', 'SRET', 'PRET', 'CNOTE', 'DNOTE'].includes(d.type);
  const exp = d.export_type && d.side === 'sales', fc = d.currency && d.fx_rate > 0 ? { c: d.currency, fx: d.fx_rate } : null;
  const F = (v) => fcMoney(v / fc.fx, fc.c);
  const title = d.type === 'INV' ? (exp ? 'EXPORT INVOICE' : P.title || (o.gstin ? 'TAX INVOICE' : 'INVOICE')) : String(d.label || '').toUpperCase();
  const L = DESIGNS.some(([k]) => k === d.design) ? d.design : DESIGNS.some(([k]) => k === P.layout) ? P.layout : 'classic';
  const inter = !!d.inter_state, compact = L === 'compact' || L === 'compact58', ours = d.side === 'sales' || d.type === 'PO';
  // columns nobody uses on this bill are left out (no discount anywhere, no HSN anywhere)
  const hasDisc = d.lines.some((l) => +l.discount_pct), hasHsn = d.lines.some((l) => l.hsn);
  const color = /^#[0-9a-f]{6}$/i.test(P.color || '') ? P.color : '#0f766e';
  const bank = ours && P.bank_account ? `<p class="bank"><b>Bank details</b><br>${[P.bank_name, 'A/c ' + P.bank_account, P.bank_ifsc && 'IFSC ' + P.bank_ifsc, P.bank_branch].filter(Boolean).map(esc).join(' &middot; ')}</p>` : '';
  const upi = d.type === 'INV' && o.upi_id && d.balance > 0 && P.show_upi !== false && !d.export_type;   // a buyer abroad pays by bank, not UPI
  // a line sold in a second unit (2 Box of 12 Pcs) prints in that unit, with the pieces under it
  const uf = (l) => (l.uom && l.uom_factor > 0 && !fc ? l.uom_factor : 0);
  const qtyTxt = (l) => (uf(l) ? `${qtyf(Math.round(l.qty / uf(l) * 1000) / 1000)} ${esc(l.uom)}` : `${qtyf(l.qty)} ${esc(l.unit || '')}`);
  const rateTxt = (l) => (uf(l) ? `${inr(l.rate * uf(l))}<div class="muted">per ${esc(l.uom)} of ${qtyf(uf(l))} ${esc(l.unit || '')}</div>` : fc ? `${F(l.rate)}<div class="muted">${inr(l.rate)}</div>` : inr(l.rate));
  const lineCells = (l, i) => compact
    ? `<td>${esc(l.item || l.description)}${l.print_extra ? `<div class="muted">${esc(l.print_extra)}</div>` : ''}${lotLine(l)}<div class="muted">${qtyTxt(l)} &times; ${uf(l) ? inr(l.rate * uf(l)) : fc ? F(l.rate) : inr(l.rate)}${l.discount_pct ? ` &minus;${l.discount_pct}%` : ''}${l.gst_rate ? ` &middot; GST ${l.gst_rate}%` : ''}</div></td><td class="num">${inr(l.total)}</td>`
    : `<td>${i + 1}</td><td>${esc(l.item || l.description)}${l.item && l.description && l.description !== l.item ? `<div class="muted">${esc(l.description)}</div>` : ''}${l.print_extra ? `<div class="muted">${esc(l.print_extra)}</div>` : ''}${lotLine(l)}</td>${hasHsn ? `<td>${esc(l.hsn || '')}</td>` : ''}
        <td class="num">${qtyTxt(l)}${uf(l) ? `<div class="muted">${qtyf(l.qty)} ${esc(l.unit || '')}</div>` : ''}</td><td class="num">${rateTxt(l)}</td>${hasDisc ? `<td class="num">${l.discount_pct ? l.discount_pct + '%' : ''}</td>` : ''}<td class="num">${inr(l.taxable)}</td><td class="num">${l.gst_rate}%</td>
        ${inter ? `<td class="num">${inr(l.igst)}</td>` : `<td class="num">${inr(l.cgst)}</td><td class="num">${inr(l.sgst)}</td>`}<td class="num">${inr(l.total)}${fc ? `<div class="muted">${F(l.total)}</div>` : ''}</td>`;
  const heads = compact ? '<th>Item</th><th class="num">Amount</th>'
    : `<th>#</th><th>Item</th>${hasHsn ? '<th>HSN</th>' : ''}<th class="num">Qty</th><th class="num">Rate</th>${hasDisc ? '<th class="num">Disc</th>' : ''}<th class="num">Taxable</th><th class="num">GST</th>${inter ? '<th class="num">IGST</th>' : '<th class="num">CGST</th><th class="num">SGST</th>'}<th class="num">Amount</th>`;
  return `<div class="paper-fit"><button type="button" class="fit-btn no-print" hidden>&#128269; Zoom</button><div class="paper-box"><div class="doc-paper fit L-${L} F-${P.font === 'serif' ? 'serif' : 'sans'}" style="--ac:${color}">
      <div class="hdr"><div class="org">${d.logo_url ? `<img class="logo" src="${esc(d.logo_url)}" alt="">` : ''}<div><div class="oname">${esc(o.name)}</div><div>${esc(o.address)}</div>
        <div>${[o.gstin ? 'GSTIN: ' + esc(o.gstin) : '', o.state ? 'State: ' + esc(o.state) : ''].filter(Boolean).join(' &middot; ')}</div><div>${esc(o.phone)}</div></div></div>
        <div class="meta"><div class="title">${esc(title)}</div><div>No: <b>${esc(d.number)}</b></div><div>Date: ${fdate(d.date)}</div>
        ${d.due_date ? `<div>${d.type === 'QUOTE' ? 'Valid till' : 'Due'}: ${fdate(d.due_date)}</div>` : ''}${d.parent ? `<div>Ref: ${esc(d.parent.number)}</div>` : ''}${d.party_ref ? `<div>Supplier ref: ${esc(d.party_ref)}</div>` : ''}
        ${fc ? `<div>Currency: <b>${esc(fc.c)}</b> &middot; 1 ${esc(fc.c)} = ₹${fc.fx}</div>` : ''}${exp && d.port_code ? `<div>Port: ${esc(d.port_code)}</div>` : ''}
        ${exp && d.sb_no ? `<div>Shipping bill: ${esc(d.sb_no)}${d.sb_date ? ` dt ${fdate(d.sb_date)}` : ''}</div>` : ''}</div></div>
      <div class="parties"><div><b>${d.side === 'sales' ? 'Bill to' : 'Supplier'}</b><br>${esc(p.name)}<br>${esc(p.address || '')}${exp && p.country ? `, ${esc(p.country)}` : ''}<br>${p.gstin ? 'GSTIN: ' + esc(p.gstin) + '<br>' : ''}${esc(p.phone || '')}</div>
        <div><b>Place of supply</b><br>${esc(d.place_of_supply || '-')}${exp ? ' (96)' : ''}<br>${exp ? (d.export_type === 'WPAY' ? 'Export with IGST' : 'Export under LUT, zero rated') : isTax ? (inter ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)') : ''}${d.warehouse ? '<br>Godown: ' + esc(d.warehouse) : ''}</div></div>
      ${(d.print_fields || []).length ? `<div class="cfp">${d.print_fields.map((f) => `<span><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join('')}</div>` : ''}
      <div class="tbl-wrap"><table class="dl"><thead><tr>${heads}</tr></thead>
      <tbody>${d.lines.map((l, i) => `<tr>${lineCells(l, i)}</tr>`).join('')}</tbody></table></div>
      ${L === 'gst' && isTax ? `<div class="tbl-wrap hsn-wrap"><b>HSN-wise tax summary</b>${hsnSummary(d, inter)}</div>` : ''}
      <div class="foot"><div class="words"><b>Amount in words:</b> ${esc(words(d.total))}${d.notes ? `<p><b>Notes:</b> ${esc(d.notes)}</p>` : ''}${pointsLine(d)}
        ${exp && d.type === 'INV' ? `<p class="expdecl"><b>${d.export_type === 'WPAY' ? 'SUPPLY MEANT FOR EXPORT WITH PAYMENT OF INTEGRATED TAX (IGST).'
          : `SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING${o.lut ? ` (LUT ARN ${esc(o.lut)})` : ''} WITHOUT PAYMENT OF INTEGRATED TAX (IGST).`}</b></p>` : ''}
        ${upi ? `<p>Pay by UPI: <b>${esc(o.upi_id)}</b></p>` : ''}${bank}</div>
        <div class="totals"><div><span>Taxable</span><span>${inr(d.taxable)}</span></div>
          ${inter ? `<div><span>IGST</span><span>${inr(d.igst)}</span></div>` : `<div><span>CGST</span><span>${inr(d.cgst)}</span></div><div><span>SGST</span><span>${inr(d.sgst)}</span></div>`}
          ${d.round_off ? `<div><span>Round off</span><span>${inr(d.round_off)}</span></div>` : ''}<div class="grand"><span>Total</span><span>${inr(d.total)}</span></div>
          ${fc ? `<div class="grand"><span>Total</span><span>${F(d.total)}</span></div>` : ''}</div></div>
      ${d.irn || d.ewb_no ? `<div style="margin-top:12px;font-size:12px">${d.irn ? `IRN: <b>${esc(d.irn)}</b>${d.ack_no ? ` &middot; Ack No: ${esc(d.ack_no)}` : ''}${d.ack_date ? ` &middot; Ack Date: ${esc(d.ack_date)}` : ''}<br>` : ''}${d.ewb_no ? `E-way bill: <b>${esc(d.ewb_no)}</b>${d.ewb_date ? ` &middot; ${esc(d.ewb_date)}` : ''}` : ''}</div>` : ''}
      ${ours && P.terms ? `<div class="terms"><b>Terms &amp; conditions</b><div>${esc(P.terms).replace(/\n/g, '<br>')}</div></div>` : ''}
      <div class="foot"><div id="upiqr"></div><div class="sign">For ${esc(o.name)}<br>${d.sign_url ? `<img class="sig" src="${esc(d.sign_url)}" alt="">` : '<br><br>'}<br>${P.signatory ? esc(P.signatory) + '<br>' : ''}Authorised signatory</div></div>
      ${P.footer ? `<div class="pfoot">${esc(P.footer)}</div>` : ''}
    </div></div></div>`;
}

let driveRefresh = null;      // set by Settings: re-checks Google Drive when the owner comes back from Google
document.addEventListener('visibilitychange', () => { if (!document.hidden && driveRefresh && $('#gdrive')) driveRefresh(); });

/* A bill keeps its page width (see .paper-fit in app.css). Where the screen is narrower, the whole page is shown
   smaller, like a PDF preview, and re-fitted when the phone is turned or the window resized. Zoom shows it full size. */
const paperSeen = new WeakMap();
const paperWatch = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => es.forEach((e) => {
  const w = Math.round(e.contentRect.width);
  if (paperSeen.get(e.target) !== w) { paperSeen.set(e.target, w); fitPaper(e.target); }
})) : null;
function fitPaper(wrap) {
  const paper = wrap.querySelector('.doc-paper'), btn = wrap.querySelector('.fit-btn');
  if (!paper) return;
  paper.style.zoom = '';
  const avail = wrap.clientWidth, natural = paper.offsetWidth, full = wrap.classList.contains('full');
  const z = natural > avail + 1 ? Math.max(0.2, avail / natural) : 1;
  if (z < 1 && !full) paper.style.zoom = z.toFixed(4);
  if (btn) { btn.hidden = z >= 0.95; btn.innerHTML = full ? 'Fit to screen' : '&#128269; Zoom'; }      // a few pixels short is not worth a button
}
function fitPapers(root) {
  $$('.paper-fit', root || document).forEach((w) => { fitPaper(w); if (paperWatch) paperWatch.observe(w); });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.fit-btn');
  if (!b) return;
  const w = b.closest('.paper-fit');
  w.classList.toggle('full'); fitPaper(w);
});

/* goods of a bill booked before they came, damaged or lost on the way: our loss, or a claim on the transporter / insurer.
   The supplier is still owed the bill (to have the supplier credit it, use Close short instead). */
function writeOffForm(d) {
  const open = d.lines.filter((l) => l.to_receive > 0.0005);
  const f = modal(`Write off on ${d.number}`, [
    { k: 'mode', label: 'Who bears it?', type: 'select', options: [{ v: 'loss', t: 'Our loss (damaged, lost, stolen)' }, { v: 'claim', t: 'Transporter / insurance will pay' }] },
    { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'reason', label: 'What happened (damage report…)', wide: true },
    { k: 'against', label: 'Claim against (transporter / insurer)', help: 'For a claim: followed up in Purchase → Transit Claims.' }, { k: 'claim_ref', label: 'LR / claim no.' }],
  async (v, fm) => {
    const lines = $$('[data-wo]', fm).map((i) => ({ line_id: +i.dataset.wo, qty: +i.value || 0 })).filter((l) => l.qty > 0);
    if (!lines.length) throw new Error('Type how many pieces were damaged or lost.');
    const w = await POST(`/api/docs/${d.id}/write-off`, { ...v, lines });
    toast(`${w.number}: ${inr(w.value)} written off, GST ${inr(w.gst)} reversed`); render();
  }, { submit: 'Write off', intro: `<p class="muted">The supplier is still owed the full bill. These pieces leave “Goods in Transit” as a loss (or a claim on the transporter / insurer), and the GST paid on them is reversed, as GST law wants for goods lost or destroyed. If the supplier will credit them instead, use <b>Close short</b>.</p>
    <div class="tbl-wrap"><table class="t lines"><thead><tr><th>Item</th><th class="num">Still to come</th><th>Damaged / lost</th></tr></thead><tbody>${open.map((l) => `<tr><td>${esc(l.item || l.description)}</td>
      <td class="num">${qtyf(l.to_receive)} ${esc(l.unit || '')}</td><td class="c-n"><input type="number" step="any" min="0" max="${l.to_receive}" data-wo="${l.id}" inputmode="decimal" aria-label="Damaged or lost: ${esc(l.item || '')}"></td></tr>`).join('')}</tbody></table></div>` });
  return f;
}

route(/^doc\/(\d+)$/, async (el, m) => {
  const d = await GET('/api/docs/' + m[1]);
  const T = ME.doc_types[d.type], o = d.org, p = d.party || {};
  // a receipt (GRN) is made from a bill only when the bill was booked before its goods (Receive Goods screen)
  const next = Object.entries(ME.doc_types).filter(([k, v]) => v.from.includes(d.type) && docFlowOk(k) && !(k === 'GRN' && d.type === 'BILL'));
  const toCome = d.transit === 1 ? d.lines.reduce((s, l) => s + (l.to_receive || 0), 0) : 0;
  const hasOpen = d.lines.some((l) => l.remaining > 0.0005);
  const main = [], more = [];   // main: the few big buttons; more: everything else, in a menu
  const waiting = d.status === 'pending';      // a big purchase order waiting for the owner or an admin
  if (waiting && ME.can.settings) main.push('<button class="btn primary" id="approve">Approve</button>');
  if (d.status !== 'cancelled') {
    if (toCome > 0.0005 && ME.can.purchase) {
      main.push(`<a class="btn primary" href="#/receive?bill=${d.id}">Receive goods</a>`);
      more.push(`<a class="btn" href="#/new/DNOTE?from=${d.id}&short=1">Close short: supplier credits it</a>`, '<button class="btn" id="woff">Write off: damaged / lost on the way</button>');
    }
    if (['INV', 'BILL'].includes(d.type) && d.balance > 0) main.push(`<button class="btn" id="pay">${d.type === 'INV' ? 'Receive payment' : 'Record payment'}</button>`);
    if (['INV', 'SRET', 'CNOTE', 'QUOTE', 'SO'].includes(d.type)) { main.push(`<button class="btn got" id="wa">WhatsApp</button>`); more.push(...(p.phone ? ['<button class="btn" id="sms">Send SMS</button>'] : []), `<button class="btn" id="link">Copy customer link</button>`, ...(ME.can.sales ? ['<button class="btn" id="unshare">Stop sharing link</button>'] : [])); }
    for (const [k, v] of next) if (!waiting && (hasOpen || v.note)) more.push(`<a class="btn" href="#/new/${k}?from=${d.id}">${['SRET', 'PRET'].includes(k) ? 'Return goods' : v.note ? (k === 'CNOTE' ? 'Credit note' : 'Debit note') : 'Make ' + esc(v.label)}</a>`);
    if (d.type === 'SO' && hasOpen && !waiting && (ME.can.sales || (ME.can.stock && !limits().no_dispatch))) main.push(`<a class="btn primary" href="#/pack/${d.id}">Pack &amp; check (scan)</a>`);
    if (['SO', 'DN', 'INV'].includes(d.type)) more.push(`<a class="btn" href="#/shiplabel/${d.id}">Shipping label</a>`);
    if ((!simple() || dispatchOn()) && ['SO', 'DN'].includes(d.type)) more.push(`<a class="btn" href="#/picklist/${d.id}">Pick list</a>`);
    if (dispatchOn() && ['SO', 'DN'].includes(d.type) && onMenu('dispatch')) more.push('<a class="btn" href="#/dispatch">Dispatch Desk</a>');
    if (['BILL', 'GRN', 'PO'].includes(d.type) && ME.can.items) more.push(`<a class="btn" href="#/labels-doc/${d.id}">Print item labels (QR / barcode)</a>`);
    if (!simple() && ['INV', 'SRET', 'CNOTE'].includes(d.type)) more.push(`<a class="btn" href="/api/docs/${d.id}/einvoice" id="einv">E-invoice JSON</a>`);
    if (!simple() && ['INV', 'DN'].includes(d.type)) more.push(`<button class="btn" id="ewb">E-way bill</button>`);
    if (!simple() && ['INV', 'SRET', 'DN'].includes(d.type)) more.push(`<button class="btn" id="refs">${d.irn || d.ewb_no ? 'Edit' : 'Add'} IRN / EWB no.${d.export_type ? ' / shipping bill' : ''}</button>`);
    else if (d.export_type && d.type === 'INV') more.push(`<button class="btn" id="refs">${d.sb_no ? 'Edit' : 'Add'} shipping bill</button>`);
    if (['INV', 'BILL', 'QUOTE', 'SO', 'PO'].includes(d.type)) more.push(`<a class="btn" href="#/new/${d.type}?copy=${d.id}">Repeat (new copy, today)</a>`);
    if (['INV', 'BILL'].includes(d.type)) more.push('<button class="btn" id="recur">Make it every month / week…</button>');
    if (!limits().no_cancel) more.push(`<button class="btn danger" id="cancel">Cancel ${esc((T && T.label) || 'document')}</button>`);
  }
  if (d.status !== 'cancelled' && ['INV', 'SRET', 'CNOTE', 'QUOTE', 'SO', 'DN'].includes(d.type)) more.unshift('<button class="btn" id="pdfdl">Download PDF file</button>');
  main.push(`<button class="btn primary" data-act="print">Print / PDF</button>`);
  const actions = [...main, more.length ? `<details class="more-menu"><summary class="btn" aria-label="More actions">More &#9662;</summary><div class="menu">${more.join('')}</div></details>` : ''];
  el.innerHTML = head(`${esc(d.number)} ${badge(d.status)}`, actions.join('')) + `
    ${toCome > 0.0005 ? `<div class="panel warnbox no-print">Goods on the way: <b>${qtyf(toCome)}</b> of ${qtyf(d.lines.filter((l) => l.item_id && !l.is_service).reduce((s, l) => s + l.qty, 0))} still to come${d.lines.some((l) => l.to_receive > 0.0005 && l.to_receive < l.qty) ? ' (part received)' : ''}. Stock goes up as they are received.</div>` : ''}
    ${d.short ? `<div class="panel muted no-print">Shortage: goods billed on ${d.parent ? esc(d.parent.number) : 'the bill'} that never came.</div>` : ''}
    ${(d.write_offs || []).length ? `<div class="panel flush no-print"><h2 class="ph">Damaged / lost on the way</h2>${table([
      { h: 'No.', f: (w) => `<b>${esc(w.number)}</b><div class="muted">${fdate(w.date)}</div>` },
      { h: 'Written off as', f: (w) => (w.mode === 'claim' ? `<a href="#/claim/${w.id}">Claim${w.against ? ' on ' + esc(w.against) : ' on transporter / insurer'}</a>${w.status === 'done' ? `<div class="muted">${w.due > 0 ? `${inr(w.due)} still due` : 'settled'}</div>` : ''}` : 'Our loss')
        + (w.reason ? `<div class="muted">${esc(w.reason)}</div>` : '') },
      { h: 'Value + GST reversed', num: 1, f: (w) => `${inr(w.value)} + ${inr(w.gst)}` },
      { h: '', f: (w) => (w.status === 'cancelled' ? badge('cancelled') : ME.can.purchase && !limits().no_cancel ? `<button class="btn sm danger" data-wox="${w.id}">Cancel</button>` : '') }], d.write_offs)}</div>` : ''}
    ${waiting ? `<div class="panel warnbox no-print">This purchase order is above the approval limit of ${inr0(ME.org.approvals.po_above)}. ${ME.can.settings ? 'Check it and tap <b>Approve</b>; to refuse it, cancel it.' : 'The owner or an admin has to approve it before goods can be received against it.'}</div>` : ''}
    <div class="panel no-print"><div class="row">
      ${d.parent ? `<span>From <a href="#/doc/${d.parent.id}">${esc(d.parent.number)}</a></span>` : ''}
      ${d.children.length ? `<span>Follow-ups: ${d.children.map((c) => `<a href="#/doc/${c.id}">${esc(c.number)}</a> ${badge(c.status)}`).join(' ')}</span>` : ''}
      ${['SO', 'DN', 'INV'].includes(d.type) && d.status !== 'cancelled' ? `<label class="f inline-f">Payment<select id="paymode" ${ME.can.sales || ME.can.stock ? '' : 'disabled'}>${PAY_OPTS.map(([v, t]) => `<option value="${v}" ${(d.pay_mode || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
      ${d.type === 'SO' && d.ship === 'confirmed' ? '<span class="badge b-paid">Confirmed by customer</span>' : ''}
      ${d.type === 'DN' && d.ship ? `<span>${shipText(d)}</span>` : ''}
      ${['INV', 'BILL'].includes(d.type) ? `<span class="spacer"></span><span>Paid <b>${inr(d.paid)}</b> &middot; Balance <b>${inr(d.balance)}</b></span>` : ''}
      <label class="f inline-f">Design<select id="design">${designOptions(d.design || '', true)}</select></label>
    </div>${d.settlements.length ? `<div class="muted" style="margin-top:8px">Settled by: ${d.settlements.map((s) => `${esc(s.number)} (${inr(s.amount)})`).join(', ')}</div>` : ''}</div>
    ${docPaper(d)}`;
  fitPapers(el);
  if ($('#paymode')) $('#paymode').onchange = async (e) => {
    try { await api('PUT', '/api/dispatch/' + d.id, { action: 'pay_mode', pay_mode: e.target.value }); toast(e.target.value ? `Marked ${e.target.value === 'cod' ? 'COD' : 'prepaid'}` : 'Saved'); } catch (err) { toast(err.message, 'err'); render(); }
  };
  if (d.type === 'INV' && o.upi_id && d.balance > 0 && o.print.show_upi !== false) upiQr($('#upiqr'), o, d.balance, d.number, 'Scan to pay with any UPI app');
  $('#design').onchange = async (e) => {
    try { await api('PUT', `/api/docs/${d.id}/design`, { design: e.target.value }); toast('Design changed'); render(); } catch (err) { toast(err.message, 'err'); }
  };
  if ($('#einv')) $('#einv').onclick = (e) => { e.preventDefault(); fileDownload(`/api/docs/${d.id}/einvoice`); };
  if ($('#woff')) $('#woff').onclick = () => writeOffForm(d);
  $$('[data-wox]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Cancel this write-off? The goods are counted as still to come again, and the loss and GST reversal are taken back.')) return;
    try { await POST(`/api/write-offs/${b.dataset.wox}/cancel`, {}); toast('Write-off cancelled'); render(); } catch (e) { toast(e.message, 'err'); }
  });
  if ($('#ewb')) $('#ewb').onclick = () => modal('E-way bill (bulk upload JSON)', [
    { k: 'distance', label: 'Distance (km)', type: 'number', required: true }, { k: 'vehicle_no', label: 'Vehicle number', placeholder: 'RJ14AB1234' },
    { k: 'mode', label: 'Mode', type: 'select', options: [{ v: '1', t: 'Road' }, { v: '2', t: 'Rail' }, { v: '3', t: 'Air' }, { v: '4', t: 'Ship' }] },
    { k: 'transporter_id', label: 'Transporter ID (GSTIN/TRANSIN)' }, { k: 'transporter_name', label: 'Transporter name' },
    { k: 'trans_doc_no', label: 'LR / RR number' }, { k: 'trans_doc_date', label: 'LR date', type: 'date' }],
  async (v) => fileDownload(`/api/docs/${d.id}/ewaybill?${new URLSearchParams(v)}`), { submit: 'Download JSON',
    intro: '<p class="muted">Upload the file at ewaybillgst.gov.in → e-Waybill → Generate Bulk. Then save the e-way bill number here with “Add IRN / EWB no.”</p>' });
  if ($('#recur')) $('#recur').onclick = () => {
    const nm = new Date(ME.today + 'T00:00:00Z'); nm.setUTCMonth(nm.getUTCMonth() + 1);
    modal(`Repeat ${d.number} automatically`, [
      { k: 'every', label: 'Make it', type: 'select', value: 'month', options: Object.entries(EVERY_T).map(([v, t]) => ({ v, t })) },
      { k: 'next_on', label: 'First new one on', type: 'date', value: nm.toISOString().slice(0, 10), required: true },
      { k: 'ends_on', label: 'Stop after (optional)', type: 'date', value: '' },
      ...(d.type === 'INV' ? [{ k: 'send', label: 'The customer gets each new bill', type: 'select', value: ME.org.auto_wa ? 'auto' : 'ask', options: Object.entries(SEND_T).map(([v, t]) => ({ v, t })) }] : [])],
    async (v) => { await POST(`/api/docs/${d.id}/recurring`, v); toast(`Done. A new one is made by itself, ${EVERY_T[v.every].toLowerCase()}.`); go('recurring'); },
    { submit: 'Start', intro: `<p class="muted">On each date SmartTrader makes a new ${d.type === 'INV' ? 'invoice' : 'bill'} with the same ${d.type === 'INV' ? 'customer' : 'supplier'} and items, says which period it is for${d.type === 'INV' ? ', and sends it to the customer with a UPI link' : ''}. Change the items, skip a month or add more customers later under Recurring Bills. हर महीने अपने आप नया बिल।</p>` });
  };
  if ($('#refs')) $('#refs').onclick = () => modal('GST portal numbers', [
    { k: 'irn', label: 'IRN (e-invoice)', value: d.irn, wide: true }, { k: 'ack_no', label: 'Ack No', value: d.ack_no }, { k: 'ack_date', label: 'Ack date', value: d.ack_date },
    { k: 'ewb_no', label: 'E-way bill no.', value: d.ewb_no }, { k: 'ewb_date', label: 'E-way bill date', value: d.ewb_date },
    ...(d.export_type ? [{ k: 'port_code', label: 'Port code (e.g. INNSA1)', value: d.port_code }, { k: 'sb_no', label: 'Shipping bill no.', value: d.sb_no },
      { k: 'sb_date', label: 'Shipping bill date', type: 'date', value: d.sb_date }] : [])],
  async (v) => { await api('PUT', `/api/docs/${d.id}/gst-refs`, v); toast('Saved'); render(); },
  { intro: '<p class="muted">Upload the e-invoice JSON on einvoice1.gst.gov.in (or through your GSP), then paste the IRN and Ack details here. They print on the invoice.</p>' });
  if ($('#approve')) $('#approve').onclick = async () => {
    try { await POST(`/api/docs/${d.id}/approve`); toast(`${d.number} approved`); render(); } catch (e) { toast(e.message, 'err'); }
  };
  const c = $('#cancel');
  if (c) c.onclick = async () => {
    if (!confirm(`Cancel ${d.number}? Its stock and accounting entries will be reversed.`)) return;
    try { await POST(`/api/docs/${d.id}/cancel`); dirty('items', 'accounts', 'parties'); toast('Cancelled'); render(); } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#pay')) $('#pay').onclick = () => paymentForm(d.type === 'INV' ? 'receipt' : 'payment', { party_id: d.party_id, amount: d.balance, doc: d });
  const send = () => sendDialog({ title: `Send ${d.number}`, lang: p.lang, load: (l) => GET(`/api/docs/${d.id}/share?lang=${l}`), pdf: () => docPdf(d) });
  if ($('#wa')) $('#wa').onclick = send;
  if ($('#sms')) $('#sms').onclick = send;
  if ($('#pdfdl')) $('#pdfdl').onclick = async (e) => {
    const b = e.currentTarget, t = b.textContent; b.disabled = true; b.textContent = 'Making PDF…';
    try { saveFile(await docPdf(d)); } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; b.textContent = t; }
  };
  if ($('#unshare')) $('#unshare').onclick = async () => {
    if (!confirm('Stop sharing this document? The link already sent to the customer will stop working. You can share it again later with a new link.')) return;
    try { await POST(`/api/docs/${d.id}/share/revoke`); toast('Link turned off'); } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#link')) $('#link').onclick = async () => {
    const r = await GET(`/api/docs/${d.id}/share`);
    try { await navigator.clipboard.writeText(r.url); toast('Customer link copied'); } catch (e) { prompt('Copy this link:', r.url); }
  };
});

/* ======================================================================= payments & receipts */
/* TDS sections with their usual rates (src/tds.js TDS_SECTIONS; the rate can be changed on the payment) */
const TDS_SECT = [['194C', 'Contractor: individual / HUF', 1], ['194C', 'Contractor: company / firm', 2], ['194J', 'Professional fees', 10], ['194J', 'Technical services / royalty', 2],
  ['194I', 'Rent: land, building, furniture', 10], ['194I', 'Rent: plant & machinery', 2], ['194H', 'Commission / brokerage', 2], ['194Q', 'Purchase of goods', 0.1], ['194A', 'Interest (not bank)', 10]];
async function paymentForm(kind, { party_id = '', amount = '', doc, date = '', reference = '', account_id = '', after } = {}) {
  const parties = (await master('parties')).filter((p) => kind === 'receipt' ? p.kind !== 'supplier' : p.kind !== 'customer');
  const accts = await cashOpts(), saveKey = newKey();
  const f = modal(kind === 'receipt' ? 'Receive payment' : 'Pay supplier', [
    { k: 'party_id', label: kind === 'receipt' ? 'From customer' : 'To supplier', type: 'select', options: [{ v: '', t: 'Choose…' }, ...opts(parties, (p) => `${p.name} (bal ${inr(p.balance)})`)], value: party_id, required: true },
    { k: 'amount', label: kind === 'receipt' ? 'Amount (₹)' : 'Bill amount settled (₹)', type: 'number', value: amount, required: true },
    { k: 'account_id', label: kind === 'receipt' ? 'Money went into' : 'Paid from', type: 'select', options: accts, value: account_id, help: 'Cash, bank or UPI.' },
    { k: 'date', label: 'Date', type: 'date', value: date || ME.today },
    { k: 'reference', label: 'UTR / cheque no.', more: true, value: reference, help: 'From the bank or UPI app, to find it later.' },
    ...(kind === 'payment' ? [{ k: 'tds_section', label: 'TDS deducted (section)', type: 'select', more: true, options: [{ v: '', t: 'No TDS' }, ...TDS_SECT.map(([s, t, r]) => ({ v: `${s}|${r}`, t: `${s} ${t} (${r}%)` }))] },
      { k: 'tds_rate', label: 'TDS rate (%)', type: 'number', more: true, help: 'The supplier gets the amount less TDS; the TDS is paid to the government by the 7th (Accounts → TDS).' }]
      : [{ k: 'tds_rate', label: 'TDS the customer deducted (%)', type: 'number', more: true, help: 'E.g. 2 or 10. The bill is settled in full; the TDS is claimed in your income-tax return.' }]),
    { k: 'notes', label: 'Notes', more: true },
  ], async (v) => {
    const body = { ...v, kind, party_id: +v.party_id, account_id: +v.account_id };
    if (v.tds_section) { const [s, r] = v.tds_section.split('|'); body.tds_section = s; body.tds_rate = +v.tds_rate || +r; }
    if (doc) body.allocations = [{ doc_id: doc.id, amount: Math.min(+v.amount, doc.balance) }];
    const r = await POST('/api/payments', body, { key: saveKey });
    if (r.queued) { toast('No internet: saved on this device, sent when online.', 'info'); return; }
    dirty('accounts', 'parties'); toast(`${r.number} saved${r.tds ? ` · TDS ${inr(r.tds / 100)} kept back` : ''}`);
    if (after) after(r);
    else if (kind === 'receipt') setTimeout(() => sendReceipt(r, (parties.find((x) => x.id === +v.party_id) || {}).lang), 0);
    else render();
  }, { intro: `<p class="muted">${doc ? `Against ${esc(doc.number)}.` : 'Applied to the oldest open ' + (kind === 'receipt' ? 'invoices' : 'bills') + ' first; any extra is kept as an advance.'}</p>` });
  // with TDS: what actually moves
  const net = document.createElement('p'); net.className = 'muted small'; net.hidden = true; $('.actions', f).before(net);
  if (f.elements.tds_section) f.elements.tds_section.addEventListener('change', (e) => { f.elements.tds_rate.value = e.target.value ? e.target.value.split('|')[1] : ''; });
  const upd = () => {
    const sec = f.elements.tds_section ? f.elements.tds_section.value : '', rate = +f.elements.tds_rate.value || (sec ? +sec.split('|')[1] : 0), amt = +f.elements.amount.value || 0;
    const t = Math.round(amt * rate) / 100;
    net.hidden = !(rate && amt);
    net.innerHTML = kind === 'payment' ? `TDS ${inr(t)} kept back · the supplier gets <b>${inr(amt - t)}</b>` : `The customer deducted ${inr(t)} TDS · money received <b>${inr(amt - t)}</b>`;
  };
  f.addEventListener('input', upd); f.addEventListener('change', upd);
}
/* the customer's receipt on WhatsApp at once, naming who collected it: cash taken by staff cannot quietly go missing */
const sendReceipt = (r, lang) => sendDialog({ title: `Send receipt ${r.number}`, lang, later: 'Not now', closed: () => render(),
  intro: '<p class="muted">The customer gets the receipt on WhatsApp: amount, date, who collected it and the balance left.</p>',
  load: (l) => GET(`/api/payments/${r.id}/message?lang=${l}`) });
const payList = (kind) => async (el, m, q) => {
  const { rows } = await GET('/api/payments?kind=' + kind);
  el.innerHTML = head(kind === 'receipt' ? 'Receipts' : 'Payments', `<button class="btn primary" id="new">+ ${kind === 'receipt' ? 'Receive payment' : 'Pay supplier'}</button>`) +
    `<div class="panel flush">${table([{ h: 'Number', k: 'number' }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Party', k: 'party' }, { h: 'Account', k: 'account' },
      { h: 'Reference', k: 'reference', cls: 'hide-sm' }, { h: 'Amount', num: 1, f: (r) => inr(r.amount) },
      { h: '', f: (r) => r.void ? badge('cancelled') : `${kind === 'receipt' ? `<button class="btn sm got" data-rcpt="${r.id}">WhatsApp</button> ` : ''}${ME.can.finance && !limits().no_cancel ? `<button class="btn sm danger" data-void="${r.id}">Void</button>` : ''}` }], rows,
    { empty: emptyCta(kind === 'receipt' ? 'Money you get from customers shows here. Record it to clear their bills.' : 'Money you pay to suppliers shows here.',
      `<button class="btn primary" data-np>${kind === 'receipt' ? '+ Receive payment' : '+ Pay supplier'}</button>`) })}</div>`;
  $('#new').onclick = () => paymentForm(kind);
  if ($('[data-np]', el)) $('[data-np]', el).onclick = () => paymentForm(kind);
  $$('[data-rcpt]', el).forEach((b) => b.onclick = () => sendReceipt(rows.find((r) => r.id === +b.dataset.rcpt)));
  $$('[data-void]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Void this entry? Its accounting will be reversed and the invoices/bills re-opened.')) return;
    try { await POST(`/api/payments/${b.dataset.void}/void`); dirty('accounts', 'parties'); toast('Entry voided'); render(); } catch (e) { toast(e.message, 'err'); }
  });
  if (takeNew(q)) paymentForm(kind, { party_id: q.get('party_id') || '', amount: q.get('amount') || '' });
};
route(/^receipts$/, payList('receipt'));
route(/^payments$/, payList('payment'));

/* ======================================================================= parties */
function partyForm(p = {}, after) {
  return modal(p.id ? 'Edit ' + p.name : 'New customer / supplier', [
    { k: 'name', label: 'Name', value: p.name, required: true, placeholder: 'Shop or person name' },
    { k: 'phone', label: 'Mobile', value: p.phone, type: 'tel', placeholder: '10-digit mobile', help: 'Used to send bills and reminders on WhatsApp.' },
    { k: 'kind', label: 'This is a', type: 'select', options: [{ v: 'customer', t: 'Customer (buys from you)' }, { v: 'supplier', t: 'Supplier (you buy from)' }, { v: 'both', t: 'Both' }], value: p.kind || 'customer' },
    { k: 'state', label: 'State', value: p.state ?? ME.org.state, list: 'states', help: 'Decides CGST + SGST or IGST. A customer abroad (export): "Other Country".' },
    { k: 'gstin', label: 'GSTIN', value: p.gstin, placeholder: '15 characters, if registered', more: true },
    { k: 'email', label: 'Email', value: p.email, type: 'email', more: true },
    { k: 'city', label: 'City', value: p.city, more: true }, { k: 'pincode', label: 'PIN code', value: p.pincode, more: true, help: 'Needed for e-invoice / e-way bill.' },
    { k: 'country', label: 'Country (customers abroad)', value: p.country || '', more: true, placeholder: 'US, AE, GB…', help: 'The 2-letter code goes on the export e-invoice.' },
    { k: 'credit_days', label: 'Payment due in (days)', type: 'number', value: p.credit_days ?? 0, more: true, help: 'Sets the due date on their bills.' },
    { k: 'credit_limit', label: 'Credit limit (₹)', type: 'number', value: p.credit_limit ?? 0, more: true, help: '0 = no limit. You get a warning above it.' },
    { k: 'price_level', label: 'Price list', type: 'select', value: p.price_level || '', more: true, help: 'Their bills start from this price of each item.',
      options: [{ v: '', t: 'Retail (selling price)' }, { v: 'wholesale', t: 'Wholesale price' }] },
    { k: 'lang', label: 'Message language', type: 'select', value: p.lang || '', more: true, help: 'Bills, reminders and receipts go to them in this language.',
      options: [{ v: '', t: `Business default (${(LANGS.find((x) => x[0] === (ME.org.msg_lang || 'hl')) || LANGS[2])[1]})` }, ...LANGS.map(([v, t]) => ({ v, t }))] },
    { k: 'vip', label: 'VIP buyer: only gentle reminders, never the firm 30-day or final wording', type: 'checkbox', value: !!p.vip, more: true },
    { k: 'address', label: 'Address', type: 'textarea', value: p.address, wide: true, more: true }, ...cfModal('party', p.extra),
  ], async (v) => {
    v = splitCf(v);
    const r = p.id ? await api('PUT', '/api/parties/' + p.id, v) : await POST('/api/parties', v);
    dirty('parties'); toast(p.id ? 'Contact saved' : `${v.name} added`);
    if (after) after(r); else render();
  }, { submit: p.id ? 'Save' : 'Add' });
}
route(/^parties$/, async (el, m, q) => {
  const kind = q.get('kind') || '';
  const { rows } = await GET('/api/parties' + (kind ? '?kind=' + kind : ''));
  el.innerHTML = head('Customers & Suppliers', `${ME.can.masters ? '<a class="btn" href="#/import/parties">Import from Excel</a>' : ''}<button class="btn primary" id="new">+ New contact</button>`) + `
    <div class="tabs">${[['', 'All'], ['customer', 'Customers'], ['supplier', 'Suppliers']].map(([k, t]) => `<a href="#/parties${k ? '?kind=' + k : ''}" class="${kind === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    ${rows.length > 5 ? '<div class="panel"><input id="search" type="search" placeholder="Search name, mobile, GSTIN…" style="max-width:320px"></div>' : ''}<div class="panel flush cards" id="list"></div>
    <p class="muted">Dr = they owe you. Cr = you owe them.</p>`;
  const cols = [{ h: 'Name', k: 'name' }, { h: 'Type', k: 'kind' }, { h: 'Mobile', k: 'phone', cls: 'hide-sm' }, { h: 'GSTIN', k: 'gstin', cls: 'hide-sm' }, ...cfCols('party'),
    { h: 'Balance', num: 1, f: (r) => `<span class="${r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : ''}">${inr(Math.abs(r.balance))} ${r.balance > 0 ? 'Dr' : r.balance < 0 ? 'Cr' : ''}</span>${r.over_limit ? ' ' + badge('overdue') : ''}` }];
  const draw = (f) => { const r = rows.filter((x) => !f || [x.name, x.phone, x.gstin, x.city, ...Object.values(x.extra || {})].join(' ').toLowerCase().includes(f));
    $('#list').innerHTML = table(cols, r, { onRow: true, empty: f ? 'No match.' : 'Add your customers and suppliers.' }); bindRows($('#list'), r, (x) => go('party/' + x.id)); };
  draw('');
  if (rows.length <= 1 && !kind) $('#list').insertAdjacentHTML('afterend', `<div class="panel tip">${emptyCta('Add your regular customers and suppliers. Their bills, payments and balance stay in one place.', '<button class="btn primary" data-np>+ Add customer</button>')}</div>`);
  if ($('[data-np]', el)) $('[data-np]', el).onclick = () => partyForm();
  if (takeNew(q)) partyForm();
  if ($('#search')) $('#search').oninput = (e) => draw(e.target.value.toLowerCase());
  $('#new').onclick = () => partyForm();
});
route(/^party\/(\d+)$/, async (el, m, q) => {
  dirty('parties');
  const p = (await master('parties')).find((x) => x.id === +m[1]);
  if (!p) throw new Error('Contact not found.');
  const L = await GET(`/api/parties/${p.id}/ledger?from=${q.get('from') || ''}&to=${q.get('to') || ''}`);
  el.innerHTML = head(esc(p.name), `<button class="btn" id="edit">Edit</button><button class="btn" id="open">Opening balance</button><button class="btn danger" id="del">Delete</button>`) + `
    <div class="kpis"><div class="kpi"><div class="l">Balance</div><div class="v ${L.closing >= 0 ? 'pos' : 'neg'}">${inr(Math.abs(L.closing))} ${L.closing >= 0 ? 'Dr' : 'Cr'}</div><div class="s">${L.closing >= 0 ? 'They owe you' : 'You owe them'}</div></div>
      <div class="kpi"><div class="l">Contact</div><div class="s">${esc(p.phone)} ${esc(p.email)}<br>${esc(p.gstin)} ${esc(p.state)}</div></div><span id="ptskpi"></span></div>
    <div id="vaada-box" class="no-print"></div>
    <div class="panel"><form class="row" id="per"><input type="date" name="from" aria-label="From date" value="${L.from}" style="max-width:170px"><input type="date" name="to" aria-label="To date" value="${L.to}" style="max-width:170px"><button class="btn">Show</button><span class="spacer"></span><button type="button" class="btn" data-act="print">Print statement</button></form></div>
    <div class="panel flush">${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Voucher', f: (r) => r.ref_id && ['INV', 'BILL', 'SRET', 'PRET'].includes(r.ref_type) ? `<a href="#/doc/${r.ref_id}">${esc(r.number)}</a>` : esc(r.number || r.ref_type) },
      { h: 'Particulars', k: 'narration' }, { h: 'Debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }],
    [{ date: L.from, narration: 'Opening balance', debit: 0, credit: 0, balance: L.opening }, ...L.rows])}</div>`;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`party/${p.id}?${new URLSearchParams(new FormData(e.target))}`); };
  if (p.kind !== 'supplier' && (!ME.view || ME.view.khata !== false)) vaadaParty($('#vaada-box'), p.id, '');
  if (p.kind !== 'supplier' && (ME.org.loyalty || {}).on && seen('loyalty')) GET('/api/loyalty/' + p.id).then((x) => {
    if (x.earns && $('#ptskpi')) $('#ptskpi').outerHTML = `<a class="kpi" href="#/loyalty?p=${p.id}"><div class="l">&#11088; Loyalty points</div><div class="v">${x.balance}</div><div class="s">worth ${inr(x.value)}</div></a>`;
  }).catch(() => {});
  $('#edit').onclick = () => partyForm(p);
  $('#open').onclick = () => modal('Opening balance', [{ k: 'amount', label: 'Amount (₹): positive = they owe you, negative = you owe them', type: 'number', wide: true }, { k: 'date', label: 'As on', type: 'date', value: ME.today }],
    async (v) => { await POST(`/api/parties/${p.id}/opening`, v); dirty('parties', 'accounts'); render(); });
  $('#del').onclick = async () => { if (confirm('Delete ' + p.name + '?')) { try { await api('DELETE', '/api/parties/' + p.id); dirty('parties'); go('parties'); } catch (e) { toast(e.message, 'err'); } } };
});

/* ======================================================================= items & stock */
/* the price a person sees for an item: with GST for an MRP item, else before GST (as on the bill) */
const shownPrice = (i) => (i.price_incl ? i.sale_price_incl : i.sale_price);
/* MRP billing: does this shop type prices with GST in them? Remembered from the last new item, else yes when its items do */
function inclPref(set) {
  const k = 'st:incl:' + (ME && ME.org ? ME.org.id : '');
  try { if (set !== undefined) { localStorage.setItem(k, set ? '1' : '0'); return set; } const v = localStorage.getItem(k); if (v !== null) return v === '1'; } catch (e) { /* storage off */ }
  return !!(cache.items && cache.items.some && cache.items.some((x) => x.price_incl));
}
const itemDefs = () => ((ME.org.setup || {}).item_defaults || {});
/* wholesale price for every item of an order with this many pieces or more (Settings → Business type & menu); 0 = off */
const wholesaleMin = () => +(itemDefs().wholesale_order_min || 0);
const altQty = (r) => (r.alt_unit && r.alt_factor > 0 && Math.abs(r.qty_on_hand) >= r.alt_factor ? ` <span class="muted small">= ${qtyf(Math.floor(r.qty_on_hand / r.alt_factor))} ${esc(r.alt_unit)}${r.qty_on_hand % r.alt_factor ? ` + ${qtyf(Math.round(r.qty_on_hand % r.alt_factor * 1000) / 1000)}` : ''}</span>` : '');
function itemForm(i = {}) {
  modal(i.id ? 'Edit ' + i.name : 'New item', [
    { k: 'name', label: 'Item name', value: i.name, required: true, placeholder: 'e.g. Tata Salt 1kg', wide: true },
    { k: 'sale_price', label: 'Selling price (₹)', type: 'number', value: (i.id ? i.price_incl : inclPref()) ? i.sale_price_incl : i.sale_price, help: 'Tick the box below if this price has GST in it.' },
    { k: 'price_incl', label: 'Selling price includes GST (MRP)', type: 'checkbox', value: i.id ? !!i.price_incl : inclPref() },
    { k: 'wholesale_price', label: 'Wholesale price (₹)', type: 'number', value: ((i.id ? i.price_incl : inclPref()) ? i.wholesale_price_incl : i.wholesale_price) || '', more: true,
      help: 'For wholesale customers, and for bills of the quantity below or more. With or without GST, like the selling price.' },
    { k: 'wholesale_min', label: 'Wholesale from quantity', type: 'number', value: i.wholesale_min || '', more: true, help: 'Empty = only customers on the wholesale price list.' },
    { k: 'shop_show', label: 'Show in the online catalogue', type: 'checkbox', value: !i.shop_hide, more: true },
    ...(ME.costs === false ? [] : [{ k: 'purchase_price', label: 'Buying price (₹)', type: 'number', value: i.purchase_price, help: 'Used for profit.' }]),
    { k: 'gst_rate', label: 'GST rate', type: 'select', options: ME.gst_rates.map((g) => ({ v: g, t: g + '%' })), value: i.gst_rate ?? itemDefs().gst_rate ?? 18 },
    { k: 'unit', label: 'Unit', value: i.unit || itemDefs().unit || 'Pcs', list: 'units', help: 'Pcs, Kg, Box, Litre…' },
    { k: 'alt_unit', label: 'Second unit (optional)', value: i.alt_unit || '', list: 'units', placeholder: 'e.g. Box, Carton, Dozen', more: !i.alt_unit, help: 'Buy and sell in it too. Stock stays in the unit above.' },
    { k: 'alt_factor', label: 'How many of the unit above in 1 second unit', type: 'number', value: i.alt_factor || '', more: !i.alt_unit, help: 'e.g. 12 when 1 Box = 12 Pcs.' },
    ...(i.id ? [] : [{ k: 'opening_qty', label: 'Stock you have now', type: 'number', help: 'Leave empty if none.' }]),
    { k: 'hsn', label: 'HSN / SAC code', value: i.hsn, more: true, help: 'From your purchase bill. Needed on GST invoices.' },
    { k: 'sku', label: 'Item code (SKU)', value: i.sku, more: true }, { k: 'category', label: 'Category', value: i.category, more: true },
    { k: 'reorder_level', label: 'Low stock alert at', type: 'number', value: i.reorder_level ?? 0, more: true, help: 'Warn me when stock falls to this.' },
    { k: 'barcode', label: 'Barcode', value: i.barcode, placeholder: 'Scan, or leave empty', more: true },
    { k: 'location', label: 'Default bin (rack / shelf)', value: i.location, placeholder: 'e.g. A-03-2', more: true, help: 'New stock of this item goes into this bin. Make bins in Inventory → Bins & Racks.' },
    ...(i.is_service ? [] : [{ k: 'track_batch', label: 'Track batch & expiry (medicines, food, cosmetics)', type: 'checkbox', value: i.id ? !!i.track_batch : !!itemDefs().track_batch, more: true },
      { k: 'track_serial', label: 'Track serial / IMEI numbers (mobiles, electronics, appliances)', type: 'checkbox', value: i.id ? !!i.track_serial : !!itemDefs().track_serial, more: true },
      { k: 'warranty_months', label: 'Warranty (months)', type: 'number', value: i.warranty_months || '', more: true, help: 'Serial lookup shows if a sold piece is still under warranty.' }]),
    ...(i.id ? [] : [{ k: 'opening_rate', label: 'Cost of current stock (₹ per unit)', type: 'number', more: true, help: 'Empty = buying price.' },
      { k: 'opening_batch', label: 'Batch of current stock', more: true, help: 'Only for items that track batches.' },
      { k: 'opening_expiry', label: 'Expiry of current stock', type: 'month', more: true },
      { k: 'opening_serials', label: 'Serial / IMEI numbers of current stock', type: 'textarea', wide: true, more: true, help: 'One per line (scan them). Only for items that track serials.' },
      { k: 'is_service', label: 'This is a service (no stock)', type: 'checkbox', more: true }]),
    ...cfModal('item', i.extra),
  ], async (v) => {
    v = splitCf(v);
    if (!i.id) inclPref(!!v.price_incl);
    if (i.id) await api('PUT', '/api/items/' + i.id, v); else await POST('/api/items', v);
    dirty('items', 'accounts'); toast(i.id ? 'Item saved' : `${v.name} added`); render();
  }, { submit: i.id ? 'Save' : 'Add item' });
}
route(/^items$/, async (el, m, q) => {
  dirty('items');
  const rows = await master('items');
  const cols = [{ h: 'Item', k: 'name' }, { h: 'SKU', k: 'sku', cls: 'hide-sm' }, { h: 'Category', k: 'category', cls: 'hide-sm' }, { h: 'GST', k: 'gst_rate', f: (r) => r.gst_rate + '%', cls: 'hide-sm' },
    { h: 'Sale price', k: 'sale_price', num: 1, f: (r) => inr(shownPrice(r)) + (r.price_incl ? ' <span class="muted small">incl. GST</span>' : '') }, ...(ME.costs === false ? [] : [{ h: 'Avg cost', k: 'avg_cost', num: 1, f: (r) => inr(r.avg_cost), cls: 'hide-sm' }]),
    { h: 'In stock', k: 'qty_on_hand', num: 1, f: (r) => r.is_service ? '<span class="muted">service</span>' : `${qtyf(r.qty_on_hand)} ${esc(r.unit)}${altQty(r)}${r.reserved > 0 ? `<span class="sub-sm muted small">${qtyf(r.available)} free</span>` : ''}` },
    // promised to open sales orders, and what is still free to sell (shown once any order holds stock)
    ...(rows.some((r) => r.reserved > 0) ? [{ h: 'On orders', k: 'reserved', num: 1, f: (r) => (r.reserved ? qtyf(r.reserved) : '<span class="muted">—</span>'), cls: 'hide-sm' },
      { h: 'Free to sell', k: 'available', num: 1, f: (r) => (r.is_service ? '' : `<b class="${r.available < 0 ? 'neg' : ''}">${qtyf(r.available)}</b>`) , cls: 'hide-sm' }] : []), ...(ME.costs === false ? [] : [{ h: 'Value', k: 'stock_value', num: 1, f: (r) => inr(r.stock_value) }]), ...cfCols('item')];
  el.innerHTML = head('Items', `${ME.can.items ? '<a class="btn" href="#/import/items">Import from Excel</a><button class="btn" id="variants">+ Sizes &amp; colours</button>' : ''}<button class="btn" id="csv">Export CSV</button><button class="btn primary" id="new">+ New item</button>`) +
    `<div class="panel"><input id="search" placeholder="Search items…" style="max-width:320px"></div><div class="panel flush cards" id="list"></div>`;
  const draw = (f) => { const r = rows.filter((x) => !f || (x.name + ' ' + x.sku + ' ' + x.category + ' ' + Object.values(x.extra || {}).join(' ')).toLowerCase().includes(f));
    $('#list').innerHTML = table(cols, r, { onRow: true, empty: f ? 'No item matches your search.' : emptyCta('Add the products you sell. Then they come up in bills with price and GST filled in.', ME.can.items ? '<button class="btn primary" data-newitem>+ Add your first item</button> <a class="btn" href="#/import/items">Import from Excel</a>' : '') });
    bindRows($('#list'), r, (x) => go('item/' + x.id)); const b = $('[data-newitem]', el); if (b) b.onclick = () => itemForm(); };
  draw('');
  $('#search').oninput = (e) => draw(e.target.value.toLowerCase());
  $('#new').onclick = () => itemForm();
  if ($('#variants')) $('#variants').onclick = variantMaker;
  if (takeNew(q)) itemForm();
  else if (q.get('variants') && ME.can.items) variantMaker();
  $('#csv').onclick = () => download('items.csv', toCsv(cols.map((c) => ({ ...c })), rows));
});
/* ======================================================================= import items / contacts from Excel or CSV
   The file is read here (CSV, or the first sheet of an .xlsx), its columns matched by name (our template, or the usual headings
   of Vyapar, myBillBook, Tally and Khatabook exports), and the rows sent 100 at a time. Nothing is saved until Import is tapped. */
const IMPORT_COLS = {
  items: [['name', 'Item name', [/^(item|product)\s*name$/, /^name$|^(item|product)$|^particulars?$|^description of goods$/]],
    ['sale_price', 'Sale price', [/^sales?\s*(price|rate)|^selling\s*(price|rate)/, /mrp/, /^rate$|^price$/]], ['purchase_price', 'Purchase price', [/^purchase\s*(price|rate)/, /cost|buying/]],
    ['gst_rate', 'GST %', [/^(gst|tax|igst)(\s*rate)?$/, /tax\s*rate|gst\s*rate/]], ['hsn', 'HSN / SAC', [/hsn|sac/]], ['unit', 'Unit', [/^(primary\s*)?unit|uom/]],
    ['sku', 'Item code', [/^(item\s*)?code$|^sku$/]], ['barcode', 'Barcode', [/barcode|ean|upc/]], ['category', 'Category', [/category|group|brand/]],
    ['opening_qty', 'Opening stock', [/opening\s*(stock|qty|quantity)/, /^(stock|qty|quantity|closing stock|current stock)( quantity)?$/]],
    ['opening_rate', 'Opening stock rate', [/opening\s*(stock\s*)?(rate|price|value per)|stock rate|at price/]],
    ['reorder_level', 'Reorder level', [/reorder|min(imum)?\s*(stock|qty)|low stock/]], ['is_service', 'Service (yes/no)', [/service/]],
    ['price_incl', 'Price includes GST (yes/no)', [/inclusive|incl(\.|uding)?\s*(of\s*)?(gst|tax)|with tax/]],
    ['wholesale_price', 'Wholesale price', [/wholesale\s*(price|rate)|^wholesale$/]], ['wholesale_min', 'Wholesale from qty', [/wholesale\s*(from|min|qty|quantity)/]]],
  parties: [['name', 'Name', [/^(party|customer|supplier|ledger|business)\s*name$/, /^name$|^party$|^customer$|^supplier$|^name of ledger$/]],
    ['kind', 'Type (customer / supplier / both)', [/^(party\s*)?(type|kind)$/, /group|category/]],
    ['phone', 'Mobile', [/mobile|phone/, /contact|whatsapp/]], ['email', 'Email', [/e-?mail/]], ['gstin', 'GSTIN', [/gstin|gst\s*(no|number|in)/]],
    ['state', 'State', [/^state|place of supply/]], ['address', 'Address', [/address/]], ['city', 'City', [/^city|town/]], ['pincode', 'Pincode', [/pin\s*code|^pin$|zip/]],
    ['credit_limit', 'Credit limit', [/credit\s*limit/]], ['credit_days', 'Credit days', [/credit\s*(days|period)|payment terms/]],
    ['opening_balance', 'Opening balance (+ they owe you, - you owe them)', [/opening/, /balance|due|outstanding|receivable/]]],
};
const IMPORT_SAMPLE = {
  items: [['Basmati Rice 25kg', 2200, 1800, 5, '1006', 'Bag', 'RICE25', '', 'Grocery', 40, 1800, 10, 'no', 'no', 2100, 10], ['Mustard Oil 15L', 2450, 2100, 5, '1514', 'Tin', '', '8901234567890', 'Grocery', 12, '', 5, 'no', 'yes', '', ''],
    ['Home delivery', 50, '', 18, '9968', 'Nos', '', '', 'Services', '', '', '', 'yes', 'no', '', '']],
  parties: [['Mehta Stores', 'customer', '9123456780', '', '', 'Rajasthan', 'Station Road', 'Jaipur', '302001', 50000, 15, 12500], ['Gupta Wholesale', 'supplier', '9876543210', '', '08ABCDE1234F1Z5', 'Rajasthan', '', 'Jaipur', '', '', 30, -8000]],
};
/* CSV text -> rows (quotes, commas or tabs or semicolons inside fields, Windows line ends) */
function csvParse(text) {
  const t = text.replace(/^﻿/, ''), first = t.split(/\r?\n/, 1)[0] || '';
  const sep = [',', '\t', ';'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
/* the heading row is the first row that names at least two known columns; each known column takes the first heading it matches */
function importMap(kind, rows) {
  const defs = IMPORT_COLS[kind], norm = (h) => String(h || '').toLowerCase().replace(/[*_.:#()₹%]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const heads = rows[r].map(norm), map = {}, used = new Set();
    for (const [k, , res] of defs) {
      for (const re of res) { const i = heads.findIndex((h, j) => h && !used.has(j) && re.test(h)); if (i >= 0) { map[k] = i; used.add(i); break; } }
    }
    // a price column called MRP has the GST in it, unless the file says otherwise
    const mrp = kind === 'items' && map.sale_price !== undefined && map.price_incl === undefined && /mrp/.test(heads[map.sale_price]);
    if (map.name !== undefined && Object.keys(map).length >= 2) return { headRow: r, map, mrp, unused: rows[r].filter((h, j) => String(h).trim() && !used.has(j)) };
  }
  return null;
}
const money = (v) => String(v ?? '').replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
function importObjects(kind, rows, m) {
  const out = [];
  for (let r = m.headRow + 1; r < rows.length; r++) {
    const o = { _row: r + 1 };
    // a cell our own exports wrote as text ('=..., '-...) comes back without the apostrophe
    for (const [k, i] of Object.entries(m.map)) o[k] = String(rows[r][i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
    if (!o.name) continue;
    for (const k of ['sale_price', 'purchase_price', 'opening_rate', 'credit_limit', 'opening_balance', 'wholesale_price']) if (o[k] !== undefined) o[k] = money(o[k]);
    if (o.gst_rate !== undefined) o.gst_rate = o.gst_rate.replace(/%|gst@?/gi, '').trim();
    if (o.opening_balance !== undefined && /cr$/i.test(o.opening_balance)) o.opening_balance = '-' + o.opening_balance.replace(/\s*cr$/i, '');
    if (o.opening_balance !== undefined) o.opening_balance = o.opening_balance.replace(/\s*dr$/i, '');
    for (const k of ['is_service', 'price_incl']) if (o[k] !== undefined) o[k] = /^(y|yes|1|true|service|inclusive|incl|haan|हाँ)$/i.test(o[k]);
    if (m.mrp && o.sale_price !== undefined) o.price_incl = true;
    for (const k of Object.keys(o)) if (o[k] === '') delete o[k];
    out.push(o);
  }
  return out;
}
route(/^import\/(items|parties)$/, async (el, m) => {
  const kind = m[1], items = kind === 'items', defs = IMPORT_COLS[kind];
  if (!ME.can[items ? 'items' : 'masters']) throw new Error('Your role cannot add ' + (items ? 'items.' : 'contacts.'));
  const back = items ? '#/items' : '#/parties';
  el.innerHTML = head(items ? 'Import items from Excel' : 'Import customers & suppliers', `<a class="btn" href="${back}">Back</a>`) + `
    <div class="panel"><ol class="steps"><li><button class="btn sm" id="tpl">Download the template</button> (CSV, opens in Excel), or use the file you already have: an export from
      Vyapar, myBillBook, Tally, Khatabook or your own sheet works if it has a <b>${items ? 'Item name' : 'Name'}</b> column.</li>
      <li>Pick the file below. Nothing is saved until you tap <b>Import</b>.</li></ol>
      <label class="f wide">Excel or CSV file<input type="file" id="file" accept=".csv,.txt,.tsv,.xlsx,text/csv"></label>
      <p class="small"><b>Columns can be in any order.</b> Keep the headings in one row at the top: each column is found by its heading, not its place.
        Only <b>${esc(defs[0][1])}</b> is needed; every other column is optional.<br>
        <span lang="hi">कॉलम किसी भी क्रम में रखें। सबसे ऊपर एक लाइन में हेडिंग हो, हर कॉलम उसकी हेडिंग से पहचाना जाता है। सिर्फ़ <b>${esc(defs[0][1])}</b> ज़रूरी है, बाकी कॉलम न हों तो भी चलेगा।</span></p>
      <p class="muted small">Headings we read: <b>${esc(defs[0][1])}</b> (needed) · ${defs.slice(1).map(([, t]) => esc(t)).join(' · ')}.${items ? ' Prices in rupees; GST like 5 or 18.' : ' Opening balance: what they owe you (or write Cr / a minus sign when you owe them).'}</p></div>
    <div id="prev"></div>`;
  $('#tpl').onclick = () => download(items ? 'smarttrader-items-template.csv' : 'smarttrader-contacts-template.csv',
    [defs.map(([, t]) => t), ...IMPORT_SAMPLE[kind]].map((r) => r.map((x) => { const t = String(x); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n'));
  $('#file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const box = $('#prev');
    try {
      const buf = await file.arrayBuffer();
      if (/\.xls$/i.test(file.name) && new Uint8Array(buf.slice(0, 2)).join() !== '80,75') throw new Error('This is an old Excel (.xls) file. Open it in Excel and save as .xlsx or CSV, then pick that.');
      const rows = /\.xlsx$/i.test(file.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75' ? await xlsxRows(buf) : csvParse(new TextDecoder().decode(buf));
      const map = importMap(kind, rows);
      if (!map) throw new Error(`No "${items ? 'Item name' : 'Name'}" column found. Use the template, or name the column with the ${items ? 'item' : 'customer'} names "${items ? 'Item name' : 'Name'}".`);
      const list = importObjects(kind, rows, map);
      if (!list.length) throw new Error('The file has headings but no rows under them.');
      if (list.length > 5000) throw new Error('At most 5,000 rows at a time. Split the file and import it in parts.');
      const shown = defs.filter(([k]) => map.map[k] !== undefined), absent = defs.filter(([k]) => map.map[k] === undefined && !(k === 'price_incl' && map.mrp));
      box.innerHTML = `<div class="panel"><h3>${list.length} row(s) found</h3>
          <p class="muted small">Matched: ${shown.map(([, t]) => `<b>${esc(t)}</b>`).join(', ')}${map.unused.length ? ` · not used: ${map.unused.slice(0, 8).map(esc).join(', ')}` : ''}</p>
          ${absent.length ? `<p class="muted small">Not in your file: ${absent.map(([, t]) => esc(t)).join(', ')}. New ${items ? 'items' : 'contacts'} get these blank, ${items ? 'items' : 'contacts'} already here keep theirs.
            If one of them is in your file under another heading, rename that heading to the one shown and pick the file again.</p>` : ''}
          <label class="check"><input type="checkbox" id="upd"> ${items ? 'Items already here: update their price, GST, HSN and unit from the file' : 'Contacts already here: update their mobile, address and GSTIN from the file'}</label>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="go">Import ${list.length} ${items ? 'item' : 'contact'}${list.length === 1 ? '' : 's'}</button><span class="muted small" id="st"></span></div></div>
        <div class="panel flush">${table(shown.map(([k, t]) => ({ h: esc(t), f: (r) => esc(r[k] === true ? 'yes' : r[k] === false ? '' : r[k] ?? '') })), list.slice(0, 20))}</div>
        ${list.length > 20 ? `<p class="muted small">First 20 of ${list.length} rows shown.</p>` : ''}`;
      $('#go').onclick = async () => {
        const btn = $('#go'), st = $('#st'), update = $('#upd').checked, tot = { added: 0, updated: 0, opening: 0, skipped: [], errors: [] };
        btn.disabled = true;
        try {
          for (let i = 0; i < list.length; i += 100) {
            st.textContent = `Saving ${Math.min(i + 100, list.length)} of ${list.length}…`;
            const r = await POST(`/api/import/${kind}`, { rows: list.slice(i, i + 100), update });
            tot.added += r.added; tot.updated += r.updated; tot.opening += r.opening || 0; tot.skipped.push(...r.skipped); tot.errors.push(...r.errors);
          }
        } catch (err) { tot.errors.push({ row: '-', error: err.message }); }
        dirty('items', 'parties', 'accounts');
        const what = items ? 'item' : 'contact';
        box.innerHTML = `<div class="panel ${tot.errors.length ? 'warnbox' : ''}"><h3>${tot.added} ${what}${tot.added === 1 ? '' : 's'} added${tot.updated ? `, ${tot.updated} updated` : ''}</h3>
          ${tot.opening ? `<p>${items ? `Opening stock was put in for ${tot.opening} item(s).` : `Opening balance was entered for ${tot.opening} contact(s).`}</p>` : ''}
          ${tot.skipped.length ? `<p class="muted">${tot.skipped.length} skipped: ${tot.skipped.slice(0, 12).map((x) => `row ${x.row} ${esc(x.name)} (${esc(x.why)})`).join('; ')}${tot.skipped.length > 12 ? '…' : ''}</p>` : ''}
          ${tot.errors.length ? `<p><b>${tot.errors.length} row(s) not imported</b>, fix them in the file and import it again (rows already added are skipped):</p>
            <ul>${tot.errors.slice(0, 30).map((x) => `<li>Row ${esc(x.row)}: ${esc(x.error)}</li>`).join('')}</ul>` : ''}
          <div class="row"><a class="btn primary" href="${back}">Open ${items ? 'items' : 'contacts'}</a></div></div>`;
        toast(`${tot.added} ${what}(s) added`);
      };
    } catch (err) { box.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  };
});
route(/^item\/(\d+)$/, async (el, m) => {
  dirty('items');
  const it = (await master('items')).find((x) => x.id === +m[1]);
  if (!it) throw new Error('Item not found.');
  const [{ rows }, lots, bom] = await Promise.all([GET(`/api/items/${it.id}/moves`), it.is_service ? null : GET(`/api/items/${it.id}/lots`).catch(() => null),
    it.is_service ? null : GET(`/api/items/${it.id}/bom`).catch(() => null)]);
  el.innerHTML = head(esc(it.name), `${it.is_service ? '' : `<a class="btn" href="#/labels/${it.id}">Print barcode labels</a>`}<button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Delete</button>`) + `
    <div class="kpis"><div class="kpi"><div class="l">In stock</div><div class="v">${qtyf(it.qty_on_hand)} ${esc(it.unit)}</div></div>
      <div class="kpi"><div class="l">Average cost</div><div class="v">${inr(it.avg_cost)}</div></div><div class="kpi"><div class="l">Stock value</div><div class="v">${inr(it.stock_value)}</div></div>
      <div class="kpi"><div class="l">Sale price${it.price_incl ? ' (incl. GST)' : ''}</div><div class="v">${inr(shownPrice(it))}</div><div class="s">GST ${it.gst_rate}% &middot; HSN ${esc(it.hsn)}</div></div></div>
    ${lots && (lots.bins.length || lots.batches.length) ? `<div class="grid g2">
      ${lots.bins.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Bins</h3></div>${table([{ h: 'Bin', f: (r) => `<b>${esc(r.code)}</b>${r.code === it.location ? ' <span class="badge">default</span>' : ''}` }, { h: 'Godown', k: 'warehouse' }, { h: 'Qty', num: 1, f: (r) => qtyf(r.qty) }], lots.bins)}</div>` : ''}
      ${lots.batches.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Batches</h3></div>${table([{ h: 'Batch', k: 'batch_no' }, { h: 'Expiry', f: (r) => (r.expiry ? fdate(r.expiry) : '') },
        { h: 'Godown', k: 'warehouse', cls: 'hide-sm' }, { h: 'Qty', num: 1, f: (r) => qtyf(r.qty) }], lots.batches)}</div>` : ''}</div>` : ''}
    ${lots && (it.track_serial || lots.serials.length) ? `<div class="panel flush"><div style="padding:14px 16px 0" class="row"><h3 style="margin:0">Serial / IMEI in stock <span class="muted">(${lots.serials.length})</span></h3><span class="spacer"></span><a class="btn sm" href="#/serials">Look up a serial</a></div>
      ${table([{ h: 'Serial / IMEI', f: (r) => `<span class="mono">${esc(r.serial)}</span>` }, { h: 'Godown', k: 'warehouse' }, { h: 'Since', f: (r) => fdate(r.in_date) }], lots.serials, { empty: 'No serial numbers in stock. Type them on the purchase bill (one per line).' })}</div>` : ''}
    ${bom ? bomPanel(it, bom) : ''}
    <div class="panel flush"><div style="padding:14px 16px 0"><h3>Stock movements</h3></div>${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Voucher', f: (r) => r.number ? `<a href="#/${/^MFG/.test(r.ref_type) ? 'production' : 'doc/' + r.ref_id}">${esc(r.number)}</a>` : esc(r.ref_type) },
      { h: 'Godown', k: 'warehouse' }, { h: 'Note', k: 'note', cls: 'hide-sm' }, { h: 'In', num: 1, f: (r) => r.qty > 0 ? qtyf(r.qty) : '' }, { h: 'Out', num: 1, f: (r) => r.qty < 0 ? qtyf(-r.qty) : '' },
      { h: 'Unit cost', num: 1, f: (r) => inr(r.unit_cost), cls: 'hide-sm' }, { h: 'Balance', num: 1, f: (r) => qtyf(r.balance) }], rows.slice().reverse(), { empty: 'No movements yet.' })}</div>`;
  $('#edit').onclick = () => itemForm(it);
  if (bom) wireBom(it, bom);
  $('#del').onclick = async () => { if (confirm('Delete ' + it.name + '?')) { try { await api('DELETE', '/api/items/' + it.id); dirty('items'); go('items'); } catch (e) { toast(e.message, 'err'); } } };
});
route(/^stock$/, async (el) => {
  dirty('warehouses');
  const [s, whs, items] = await Promise.all([GET('/api/reports/stock'), master('warehouses'), master('items')]);
  const stocked = items.filter((i) => !i.is_service);
  el.innerHTML = head('Stock & Godowns', `<button class="btn" id="adj">Adjust stock</button><button class="btn" id="xfer">Transfer</button><button class="btn" id="wh">+ Godown</button>`) + `
    <div class="kpis"><div class="kpi"><div class="l">Stock value</div><div class="v">${inr0(s.total_value)}</div></div><div class="kpi"><div class="l">Items to reorder</div><div class="v">${s.reorder_count}</div></div>
      ${whs.map((w) => `<div class="kpi"><div class="l">${esc(w.name)}</div><div class="v">${inr0(w.value)}</div></div>`).join('')}</div>
    <div class="panel flush">${table([{ h: 'Item', f: (r) => `<a href="#/item/${r.id}">${esc(r.name)}</a>` }, { h: 'Godowns', cls: 'hide-sm', f: (r) => r.warehouses.map((w) => `${esc(w.warehouse)}: ${qtyf(w.qty)}`).join('<br>') },
      { h: 'Qty', num: 1, f: (r) => `${qtyf(r.qty)} ${esc(r.unit)}` }, { h: 'Avg cost', num: 1, cls: 'hide-sm', f: (r) => inr(r.avg_cost) }, { h: 'Value', num: 1, f: (r) => inr(r.value) },
      { h: 'Status', f: (r) => badge(r.status) + (r.suggested_order ? `<span class="sub-sm muted small">order ${qtyf(r.suggested_order)}</span>` : '') }, { h: 'Suggested order', num: 1, cls: 'hide-sm', f: (r) => r.suggested_order ? qtyf(r.suggested_order) : '' }], s.rows)}</div>
    ${s.rows.some((r) => r.suggested_order) ? '<div class="row"><a class="btn primary" href="#/new/PO?reorder=1">Raise a purchase order for low items</a></div>' : ''}`;
  const itemOpts = opts(stocked, (i) => `${i.name} (${qtyf(i.qty_on_hand)} ${i.unit})`), whOpts = opts(whs);
  $('#adj').onclick = () => modal('Adjust stock', [{ k: 'item_id', label: 'Item', type: 'select', options: itemOpts, wide: true }, { k: 'warehouse_id', label: 'Godown', type: 'select', options: whOpts },
    { k: 'qty', label: 'Quantity (+ add, − remove)', type: 'number' }, { k: 'reason', label: 'Reason', value: 'Physical count', wide: true }, { k: 'date', label: 'Date', type: 'date', value: ME.today },
    { k: 'batch_no', label: 'Batch no.', more: true, help: 'For items that track batches. Removing without a batch takes the first to expire.' }, { k: 'expiry', label: 'Expiry (when adding)', type: 'month', more: true },
    { k: 'bin', label: 'Bin (when adding)', placeholder: 'e.g. A-01-2', more: true, help: 'Empty = the item\'s default bin.' },
    { k: 'serials', label: 'Serial / IMEI numbers', type: 'textarea', wide: true, more: true, help: 'For items that track serials: one per line. Removing without serials takes the oldest.' }],
  async (v) => { await POST('/api/stock/adjust', { ...v, item_id: +v.item_id, warehouse_id: +v.warehouse_id }); dirty('items', 'accounts', 'warehouses'); toast('Stock adjusted'); render(); });
  $('#xfer').onclick = () => modal('Transfer between godowns', [{ k: 'item_id', label: 'Item', type: 'select', options: itemOpts, wide: true }, { k: 'from_warehouse_id', label: 'From', type: 'select', options: whOpts },
    { k: 'to_warehouse_id', label: 'To', type: 'select', options: whOpts, value: whs[1] && whs[1].id }, { k: 'qty', label: 'Quantity', type: 'number' }, { k: 'date', label: 'Date', type: 'date', value: ME.today },
    { k: 'batch_no', label: 'Batch no.', more: true, help: 'Empty = the first to expire. The batch goes along to the other godown.' },
    { k: 'serials', label: 'Serial / IMEI numbers', type: 'textarea', wide: true, more: true, help: 'Empty = the oldest in stock.' }],
  async (v) => { await POST('/api/stock/transfer', { ...v, item_id: +v.item_id, from_warehouse_id: +v.from_warehouse_id, to_warehouse_id: +v.to_warehouse_id }); dirty('warehouses'); toast('Transferred'); render(); });
  $('#wh').onclick = () => modal('New godown / warehouse', [{ k: 'name', label: 'Name', wide: true }], async (v) => { await POST('/api/warehouses', v); dirty('warehouses'); render(); });
});

/* ======================================================================= serial / IMEI lookup (warranty) */
route(/^serials$/, async (el, m, q) => {
  el.innerHTML = head('Serial / IMEI lookup') + `
    <form class="panel" id="snf"><div class="row"><input name="q" id="snq" placeholder="Scan or type IMEI / serial number (at least 3 characters)" value="${esc(q.get('q') || '')}" autocomplete="off" enterkeyhint="search" style="flex:1;min-width:0" aria-label="Serial or IMEI">
      <button class="btn primary">Find</button></div>
      <p class="muted" style="margin:8px 0 0">Customer came back with a phone or machine? Scan its IMEI: see who bought it, on which bill, and whether it is still under warranty.</p></form>
    <div id="snres"></div>`;
  const show = async (term) => {
    const box = $('#snres');
    if (term.trim().length < 3) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="panel muted">Searching…</div>';
    const r = await GET('/api/serials?q=' + encodeURIComponent(term.trim()));
    if (!r.rows.length) { box.innerHTML = `<div class="panel empty">No serial number like “${esc(term)}”. Serials are saved when you type them on a purchase bill, opening stock or production.</div>`; return; }
    box.innerHTML = r.rows.map((s) => {
      const where = s.status === 'in' ? `In stock at <b>${esc(s.warehouse || '')}</b> since ${fdate(s.in_date)}`
        : s.status === 'out' ? `Sold to <b>${esc(s.party || '—')}</b>${s.phone ? ` (${esc(s.phone)})` : ''} on ${fdate(s.out_date)}` : 'Not in stock (purchase cancelled or written off)';
      const w = s.status !== 'out' ? '' : !s.warranty_months ? '<div class="warranty"><b>No warranty period set</b> <span class="muted">for this item. Add it in the item (More details).</span></div>'
        : s.in_warranty ? `<div class="warranty yes"><h3>Under warranty ✓</h3>Valid till <b>${fdate(s.warranty_until)}</b> (${s.warranty_months} months from sale)</div>`
          : `<div class="warranty no"><h3>Warranty over</h3>Ended on <b>${fdate(s.warranty_until)}</b></div>`;
      const hist = s.history.map((h) => `<li>${fdate(h.date)} · ${h.dir > 0 ? 'In' : 'Out'}${h.number ? ` · <a href="#/doc/${h.doc_id}">${esc(h.number)}</a>` : ` · ${esc(h.ref_type)}`}${h.party ? ` · ${esc(h.party)}` : ''}${h.warehouse ? ` · ${esc(h.warehouse)}` : ''}</li>`).join('');
      return `<div class="panel"><div class="row"><h3 style="margin:0" class="mono">${esc(s.serial)}</h3>${badge(s.status === 'in' ? 'in stock' : s.status === 'out' ? 'sold' : 'void')}<span class="spacer"></span><a href="#/item/${s.item_id}">${esc(s.item)}</a></div>
        <p style="margin:8px 0 0">${where}</p>${w}${hist ? `<details style="margin-top:10px"><summary>History</summary><ul class="muted">${hist}</ul></details>` : ''}</div>`;
    }).join('');
  };
  $('#snf').onsubmit = (e) => { e.preventDefault(); const t = $('#snq').value; history.replaceState(null, '', '#/serials?q=' + encodeURIComponent(t)); show(t).catch((err) => toast(err.message, 'err')); };
  if (q.get('q')) show(q.get('q')); else if (matchMedia('(pointer: fine)').matches) $('#snq').focus();
});

/* ======================================================================= manufacturing: recipe (BOM) and production */
function bomPanel(it, bom) {
  if (!bom.lines.length) {
    return ME.can.items ? `<div class="panel"><div class="row"><div><h3 style="margin:0">Recipe (bill of materials)</h3><p class="muted" style="margin:4px 0 0">Do you make ${esc(it.name)} from other items? Add its recipe once; then one tap makes it, and the stock of every part updates by itself.</p></div>
      <span class="spacer"></span><button class="btn" id="bomedit">+ Add recipe</button></div></div>` : '';
  }
  return `<div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3 style="margin:0">Recipe <span class="muted">for ${qtyf(bom.out_qty)} ${esc(it.unit)}</span></h3><span class="spacer"></span>
      ${bom.can_make !== null ? `<span class="muted">Can make now: <b>${qtyf(bom.can_make)}</b></span>` : ''}
      ${ME.can.items ? '<button class="btn sm" id="bomedit">Edit</button>' : ''}${ME.can.stock ? '<button class="btn sm primary" id="make">Make now</button>' : ''}</div>
    ${table([{ h: 'Part', f: (r) => `<a href="#/item/${r.item_id}">${esc(r.name)}</a>` }, { h: 'Qty', num: 1, f: (r) => `${qtyf(r.qty)} ${esc(r.unit)}` },
      { h: 'In stock', num: 1, f: (r) => `<span class="${r.have + 0.0005 < r.qty ? 'neg' : ''}">${qtyf(r.have)}</span>` }, ...(ME.costs === false ? [] : [{ h: 'Cost', num: 1, f: (r) => inr(r.cost) }])], bom.lines)}
    ${bom.unit_cost !== undefined ? `<div class="muted" style="padding:8px 16px 12px">Cost of parts: <b>${inr(bom.unit_cost)}</b> per ${esc(it.unit)}${it.sale_price ? ` · sale price ${inr(it.sale_price)} · margin ${inr(it.sale_price - bom.unit_cost)}` : ''}</div>` : ''}</div>`;
}
async function bomEditor(it, bom, after) {
  const items = (await master('items')).filter((i) => !i.is_service && i.id !== it.id);
  const itemOpt = (sel) => `<option value="">Choose part…</option>` + items.map((i) => `<option value="${i.id}" ${+sel === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('');
  const row = (l) => `<tr><td><select name="b_item" aria-label="Part">${itemOpt(l.item_id)}</select></td><td><input name="b_qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(l.qty ?? '')}" aria-label="Quantity" style="width:90px"></td>
    <td><button type="button" class="btn sm danger" data-bdel aria-label="Remove">&times;</button></td></tr>`;
  const form = modal(`Recipe: ${it.name}`, [{ k: 'out_qty', label: `This recipe makes (${it.unit})`, type: 'number', value: bom.out_qty || 1 }, { k: 'notes', label: 'Notes', value: bom.notes || '', more: true }],
    async (v, f) => {
      const lines = $$('#bomlines tr', f).map((tr) => ({ item_id: +$('[name=b_item]', tr).value, qty: $('[name=b_qty]', tr).value })).filter((l) => l.item_id && +l.qty > 0);
      await api('PUT', `/api/items/${it.id}/bom`, { out_qty: v.out_qty, notes: v.notes, lines });
      toast(lines.length ? 'Recipe saved' : 'Recipe removed'); after();
    }, { submit: 'Save recipe', intro: `<p class="muted">Which parts, and how much of each, go into ${esc(it.name)}?</p>
      <table class="t"><thead><tr><th>Part</th><th>Qty</th><th></th></tr></thead><tbody id="bomlines">${(bom.lines.length ? bom.lines : [{}, {}]).map(row).join('')}</tbody></table>
      <button type="button" class="btn sm" id="bomadd" style="margin:8px 0">+ Add part</button>` });
  const tb = $('#bomlines', form);
  form.addEventListener('click', (e) => { if (e.target.closest('[data-bdel]') && $$('tr', tb).length > 1) e.target.closest('tr').remove(); });
  $('#bomadd', form).onclick = () => tb.insertAdjacentHTML('beforeend', row({}));
}
async function makeForm(it, after) {
  const whs = await master('warehouses');
  modal(`Make ${it.name}`, [{ k: 'qty', label: `How many (${it.unit})`, type: 'number', value: 1, required: true },
    ...(whs.length > 1 ? [{ k: 'warehouse_id', label: 'Godown (parts come from here)', type: 'select', options: opts(whs) }] : []),
    { k: 'date', label: 'Date', type: 'date', value: ME.today },
    ...(it.track_batch ? [{ k: 'batch_no', label: 'Batch no. of what you made' }, { k: 'expiry', label: 'Expiry', type: 'month' }] : []),
    ...(it.track_serial ? [{ k: 'serials', label: 'Serial numbers of what you made (one per line)', type: 'textarea', wide: true }] : []),
    { k: 'notes', label: 'Notes', more: true }],
  async (v) => {
    const r = await POST('/api/productions', { ...v, item_id: it.id, warehouse_id: +v.warehouse_id || 0 });
    dirty('items', 'warehouses');
    toast(`${r.number}: made ${qtyf(r.qty)} ${it.unit}${r.unit_cost !== undefined ? ` at ${inr(r.unit_cost)} each` : ''}`); after();
  }, { submit: 'Make', intro: '<p class="muted">The parts in the recipe go out of stock and the finished item comes in at their cost.</p>' });
}
function wireBom(it, bom) {
  if ($('#bomedit')) $('#bomedit').onclick = () => bomEditor(it, bom, () => render());
  if ($('#make')) $('#make').onclick = () => makeForm(it, () => render());
}
route(/^production$/, async (el) => {
  const [p, items] = await Promise.all([GET('/api/productions'), master('items')]);
  el.innerHTML = head('Production (manufacturing)', ME.can.stock && p.recipes.length ? '<button class="btn primary" id="new">+ Make</button>' : '') + `
    <div class="panel"><ol class="steps"><li>Open an item you make and add its <b>recipe</b> (parts and quantities)</li><li>Tap <b>Make</b>: parts go out, the finished item comes in at their cost</li><li>Sell it like any item</li></ol>
      ${p.recipes.length ? `<p class="muted" style="margin:10px 0 0">Recipes: ${p.recipes.map((r) => `<a href="#/item/${r.item_id}">${esc(r.name)}</a>`).join(', ')}</p>` : `<p style="margin:10px 0 0"><a class="btn sm" href="#/items">Choose an item to add a recipe</a></p>`}</div>
    <div class="panel flush">${table([{ h: 'Number', k: 'number' }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Item', k: 'item' }, { h: 'Qty', num: 1, f: (r) => `${qtyf(r.qty)} ${esc(r.unit)}` },
      { h: 'Godown', k: 'warehouse', cls: 'hide-sm' }, ...(ME.costs === false ? [] : [{ h: 'Cost', num: 1, f: (r) => inr(r.value) }]), { h: 'Status', f: (r) => badge(r.status) },
      { h: '', f: (r) => r.status === 'done' && ME.can.stock ? `<button class="btn sm danger" data-cancel="${r.id}">Cancel</button>` : '' }], p.rows, { empty: 'No production yet.' })}</div>`;
  if ($('#new')) $('#new').onclick = () => modal('What do you want to make?', [{ k: 'item_id', label: 'Item', type: 'select', options: p.recipes.map((r) => ({ v: r.item_id, t: r.name })) }],
    async (v) => { const it = items.find((i) => i.id === +v.item_id); setTimeout(() => makeForm(it, () => render()), 0); }, { submit: 'Next' });
  el.onclick = async (e) => {
    const b = e.target.closest('[data-cancel]'); if (!b) return;
    if (!confirm('Cancel this production? The parts go back into stock and the made goods come out.')) return;
    try { await POST(`/api/productions/${b.dataset.cancel}/cancel`); dirty('items'); toast('Cancelled'); render(); } catch (err) { toast(err.message, 'err'); }
  };
});

/* ======================================================================= online orders: Amazon, Flipkart, Meesho */
/* .xlsx in the browser: unzip (the browser's own inflate) and read the first sheet, so a seller can pick the Excel
   file the marketplace gives them without converting it first */
async function unzipFiles(buf) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open Excel or zip files. Save the report as CSV in Excel and pick that file.');
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like an Excel (.xlsx) file.');
  const files = new Map();
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    files.set(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)), { method, size, off });
    p += 46 + nl + xl + cl;
  }
  const read = async (name) => {
    const f = files.get(name); if (!f) return '';
    const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true), raw = u8.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(raw);
    const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(out);
  };
  return { names: [...files.keys()], read };
}
/* rows of the first sheet, or of the sheet whose name matches `named` (null when there is none) */
async function xlsxRows(buf, named) {
  const { names, read } = await unzipFiles(buf);
  const X = (t) => new DOMParser().parseFromString(t, 'application/xml');
  const ss = [...X(await read('xl/sharedStrings.xml')).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  let sheet = names.filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))[0];
  if (named) {
    const s = [...X(await read('xl/workbook.xml')).getElementsByTagName('sheet')].find((x) => named.test((x.getAttribute('name') || '').trim()));
    const id = s && (s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = id && [...X(await read('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === id);
    if (!rel) return null;
    const t = rel.getAttribute('Target');
    sheet = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  if (!sheet) throw new Error('No sheet found in this Excel file.');
  const col = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [...X(await read(sheet)).getElementsByTagName('row')].map((r) => {
    const out = [];
    for (const c of r.getElementsByTagName('c')) {
      const v = (c.getElementsByTagName('v')[0] || {}).textContent ?? '', t = c.getAttribute('t');
      out[col(c.getAttribute('r') || 'A1')] = t === 's' ? ss[+v] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : v;
    }
    return Array.from(out, (x) => x ?? '');
  });
}
const rowsToCsv = (rows) => rows.map((r) => r.map((x) => { const t = String(x ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\n');
const CHANNEL_HELP = {
  amazon: 'Best: Seller Central → Reports → Tax Document Library → Merchant Tax Report (MTR) B2C: it has the refunds too and Amazon\'s invoice numbers. Or Reports → Fulfilment → All Orders (.txt).',
  flipkart: 'Seller Hub → Orders → Download orders (Excel). Pick the .xlsx file here.',
  meesho: 'Supplier Panel → Orders → Download (CSV or Excel). Pick the file here.',
  other: 'Any CSV or Excel file with Order ID, SKU, Quantity and Price columns (Shopify, WooCommerce, your website…).',
};
route(/^channels$/, async (el) => {
  const whs = await master('warehouses');
  el.innerHTML = head('Online orders') + `
    <div class="panel"><h3 style="margin-top:0">Bill your Amazon, Flipkart and Meesho orders in one go</h3>
      <ol class="steps"><li>Download the order report from the seller panel</li><li>Pick it here</li><li>Check and tap <b>Make invoices</b></li></ol>
      <p class="muted">Each order becomes a GST invoice: stock goes out, the buyer's state decides IGST or CGST+SGST, items are matched by SKU. An order is never billed twice. Refunds, returns and cancellations in the same file become sales returns against their invoice (stock back, GST reversed).</p>
      <form id="chf"><div class="form">
        <label class="f">Marketplace<select name="channel">${[['amazon', 'Amazon'], ['flipkart', 'Flipkart'], ['meesho', 'Meesho'], ['other', 'My website / other']].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <label class="f" id="storef" hidden>Store name<input name="store" placeholder="e.g. Shopify"></label>
        ${whs.length > 1 ? `<label class="f">Ship from godown<select name="warehouse_id">${whs.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>` : ''}
        <label class="f wide">Order report (CSV, TXT or Excel)<input type="file" name="file" accept=".csv,.txt,.tsv,.xlsx,text/csv,text/plain"><small class="help" id="chhelp">${esc(CHANNEL_HELP.amazon)}</small></label>
      </div><div class="err" hidden></div><div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary">Check orders</button></div></form>
      <div id="chres"></div></div>
    ${ME.can.finance ? `<div class="panel" id="payouts"><h3 style="margin-top:0">Amazon payouts: fees, TCS and TDS matched to your invoices</h3>
      <ol class="steps"><li>Seller Central → Payments → <b>All Statements</b> → a settlement → <b>Download flat file (V2)</b></li><li>Pick it here and check</li><li>Tap <b>Post this payout</b></li></ol>
      <p class="muted">Each order's money is matched to its invoice and marks it paid. What Amazon kept is booked for you: fees and commission as an expense, GST TCS and income-tax TDS (194-O) as credits you claim (GSTR-3B / ITR). You see what you really earned per order, and which orders were never paid.</p>
      <form id="stf"><div class="form"><label class="f wide">Settlement report (.txt)<input type="file" name="file" accept=".txt,.tsv,.csv,text/plain"></label></div>
        <div class="err" hidden></div><div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary">Check payout</button></div></form>
      <div id="stres"></div><div id="stlist"></div></div>` : ''}
    <div class="panel"><h3 style="margin-top:0">Stock file for the marketplace</h3>
      <p class="muted">Keep your online stock the same as the shop: download SKU and quantity in hand, and upload it in the seller panel (inventory / stock update). Items need a SKU or barcode.</p>
      <div class="row">${whs.length > 1 ? `<select id="stwh" aria-label="Godown"><option value="0">All godowns</option>${whs.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>` : ''}<button class="btn" id="stdl">Download stock file (CSV)</button></div></div>
    ${ME.can.settings ? `<div class="panel" id="hooks"><div class="row"><h3 style="margin:0">Live orders from your own web store</h3><span class="spacer"></span><button class="btn" id="addhook">+ Connect a store</button></div>
      <p class="muted">Shopify, WooCommerce or your own website: every paid order becomes a GST invoice by itself, the moment it is placed.</p><div id="hooklist"><span class="muted">Loading…</span></div></div>` : ''}`;
  const HOOK_HELP = {
    shopify: (h) => `<ol><li>In Shopify admin open <b>Settings → Notifications → Webhooks</b> and tap <b>Create webhook</b>.</li><li>Event: <b>Order payment</b>, format <b>JSON</b>, URL:<br><code class="mono">${esc(h.url)}</code></li><li>Save. The orders paid from now on come here as invoices.</li></ol>`,
    woocommerce: (h) => `<ol><li>In WordPress open <b>WooCommerce → Settings → Advanced → Webhooks → Add webhook</b>.</li><li>Topic: <b>Order updated</b>, delivery URL:<br><code class="mono">${esc(h.url)}</code></li><li>Secret: <code class="mono">${esc(h.secret)}</code> (shown only now: copy it)</li><li>Status <b>Active</b>, save. Orders become invoices when they are Processing or Completed.</li></ol>`,
    custom: (h) => `<p>POST each paid order as JSON to <code class="mono">${esc(h.url)}</code>, signed: header <code>X-Signature</code> = base64 HMAC-SHA256 of the raw body with the secret <code class="mono">${esc(h.secret)}</code> (shown only now).</p>
      <pre class="mono small">{"order_id": "1001", "date": "2026-10-25", "state": "Maharashtra",\n "lines": [{"sku": "ABC-1", "name": "…", "qty": 2, "amount": 1180}]}</pre><p class="muted small">amount = the line's price including GST.</p>`,
  };
  const drawHooks = async () => {
    const box = $('#hooklist'); if (!box) return;
    const { rows } = await GET('/api/hooks');
    box.innerHTML = rows.length ? table([{ h: 'Store', f: (h) => `<b>${esc(h.name)}</b><div class="muted">${esc(h.kind)}</div>` },
      { h: 'Orders billed', num: 1, k: 'orders' }, { h: 'Last order', f: (h) => h.last_at ? new Date(h.last_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + (h.last_error ? `<div class="neg small">${esc(h.last_error)}</div>` : '') : '<span class="muted">none yet</span>' },
      { h: '', f: (h) => `<button class="btn sm" data-hcopy="${esc(h.url)}">Copy address</button> <button class="btn sm danger" data-hdel="${h.id}">Remove</button>` }], rows) : '<p class="muted">No store connected.</p>';
  };
  drawHooks().catch(() => {});
  if ($('#addhook')) $('#addhook').onclick = () => modal('Connect a web store', [
    { k: 'kind', label: 'Store', type: 'select', options: [{ v: 'shopify', t: 'Shopify' }, { v: 'woocommerce', t: 'WooCommerce (WordPress)' }, { v: 'custom', t: 'My own website' }] },
    { k: 'name', label: 'Name (bills go to "<name> (buyer\'s state)")', placeholder: 'e.g. My Shopify' },
    ...(whs.length > 1 ? [{ k: 'warehouse_id', label: 'Ship from godown', type: 'select', options: opts(whs) }] : []),
    { k: 'secret', label: 'Shopify only: the signing key shown on the Webhooks page', wide: true, placeholder: 'Your webhooks will be signed with …' }],
  async (v) => {
    const h = await POST('/api/hooks', { ...v, warehouse_id: +v.warehouse_id || 0 });
    setTimeout(() => modal(`${h.name}: last step in your store`, [], async () => { drawHooks(); }, { submit: 'Done', intro: HOOK_HELP[h.kind]({ ...h }) }), 0);
  }, { submit: 'Connect', intro: '<p class="muted">Items are matched by SKU, so give your items the same SKU as in the store.</p>' });
  el.onclick = async (e) => {
    const cp = e.target.closest('[data-hcopy]'), del = e.target.closest('[data-hdel]');
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.hcopy); toast('Address copied'); } catch (err) { prompt('Copy this address', cp.dataset.hcopy); } }
    if (del && confirm('Remove this store? Its orders will no longer come in.')) { try { await api('DELETE', '/api/hooks/' + del.dataset.hdel); drawHooks(); } catch (err) { toast(err.message, 'err'); } }
  };
  // Amazon payouts: check the file, then post it once
  const drawPayouts = async () => {
    const box = $('#stlist'); if (!box) return;
    const { rows } = await GET('/api/channels/settlements');
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    box.innerHTML = rows.length ? `<h3>Payouts posted</h3>${table([{ h: 'Settlement', k: 'sid', f: (r) => `${esc(r.settlement_id)}<div class="muted small">${fdate(r.start_date)} – ${fdate(r.end_date)}</div>` },
      { h: 'Deposit', k: 'dep', f: (r) => `${inr(r.total)}<div class="muted small">${fdate(r.deposit_date)}</div>` }, { h: 'Sales', k: 'sales', num: 1, cls: 'hide-sm', f: (r) => inr(r.sales) },
      { h: 'Fees', k: 'fees', num: 1, f: (r) => inr(-r.fees) }, { h: 'TCS', k: 'tcs', num: 1, f: (r) => inr(-r.tcs) }, { h: 'TDS', k: 'tds', num: 1, f: (r) => inr(-r.tds) }], rows,
      { foot: { sid: '<b>Total</b>', dep: `<b>${inr(sum('total'))}</b>`, sales: inr(sum('sales')), fees: inr(-sum('fees')), tcs: `<b>${inr(-sum('tcs'))}</b>`, tds: `<b>${inr(-sum('tds'))}</b>` } })}
      <p class="muted small">TCS is claimed in GSTR-3B (it shows in GSTR-2X); TDS in your income-tax return (it shows in Form 26AS). Their balances are in Accounts: GST TCS Receivable and TDS Receivable.</p>` : '';
  };
  if ($('#stf')) {
    drawPayouts().catch(() => {});
    let sbody = null;
    $('#stf').onsubmit = async (e) => {
      e.preventDefault();
      const sf = $('#stf'), err = $('.err', sf); err.hidden = true;
      const file = sf.elements.file.files[0];
      if (!file) { err.hidden = false; err.textContent = 'Choose the settlement report first.'; return; }
      try {
        sbody = { csv: new TextDecoder().decode(await file.arrayBuffer()) };
        const s = await POST('/api/channels/settlement', sbody), T = s.totals;
        const pct = (x) => (T.sale ? ` · ${Math.round(-x / T.sale * 1000) / 10}% of sales` : '');
        const unb = s.orders.filter((o) => !o.doc_id && Math.abs(o.sale) > 0.004), accts = await cashOpts();
        const bank = (await master('accounts')).find((a) => a.is_cash && a.sys === 'bank');
        $('#stres').innerHTML = `<div class="kpis" style="margin-top:14px">
            <div class="kpi"><div class="l">Deposited in bank</div><div class="v pos">${inr(T.deposit)}</div><div class="s">${fdate(s.deposit)} · settlement ${esc(s.settlement_id)}</div></div>
            <div class="kpi"><div class="l">Customers paid for goods</div><div class="v">${inr(T.sale)}</div><div class="s">${s.orders.length} orders</div></div>
            <div class="kpi"><div class="l">Amazon fees</div><div class="v neg">${inr(-T.fee)}</div><div class="s">${pct(T.fee).replace(' · ', '')}</div></div>
            <div class="kpi"><div class="l">GST TCS (claim)</div><div class="v">${inr(-T.tcs)}</div><div class="s">GSTR-3B</div></div>
            <div class="kpi"><div class="l">TDS 194-O (claim)</div><div class="v">${inr(-T.tds)}</div><div class="s">income-tax return</div></div>
            ${T.other ? `<div class="kpi"><div class="l">Other (ads, reserve…)</div><div class="v">${inr(T.other)}</div></div>` : ''}</div>
          ${s.posted ? `<div class="panel okbox">This payout was posted on ${new Date(s.posted).toLocaleDateString('en-IN')}.</div>` : ''}
          ${!s.adds_up ? `<div class="panel warnbox">The lines add up to ${inr(s.file_sum)}, not the deposit ${inr(s.total)}. Download the report again.</div>` : ''}
          ${unb.length ? `<div class="panel warnbox"><b>${unb.length} order(s) in this payout are not billed here</b> (sold before you used SmartTrader, or not imported yet): ${unb.slice(0, 15).map((o) => esc(o.order_id)).join(', ')}${unb.length > 15 ? '…' : ''}.
            Import their orders above first, or book them as other income.</div>` : ''}
          ${table([{ h: 'Order', f: (o) => `${esc(o.order_id)}${o.refund ? ' <span class="badge">refund</span>' : ''}` }, { h: 'Invoice', f: (o) => (o.doc_id ? `<a href="#/doc/${o.doc_id}">${esc(o.invoice)}</a>` : '<span class="neg small">not billed</span>') },
            { h: 'Sale', num: 1, f: (o) => inr(o.sale) }, { h: 'Fees', num: 1, f: (o) => inr(o.fee) }, { h: 'TCS', num: 1, cls: 'hide-sm', f: (o) => inr(o.tcs) }, { h: 'TDS', num: 1, cls: 'hide-sm', f: (o) => inr(o.tds) },
            { h: 'You got', num: 1, f: (o) => `<b>${inr(o.net)}</b>` }], s.orders.slice(0, 300))}
          ${s.orders.length > 300 ? `<p class="muted">…and ${s.orders.length - 300} more orders.</p>` : ''}
          ${s.posted || !s.adds_up ? '' : `<form id="stpost" class="row" style="margin-top:12px;flex-wrap:wrap;gap:10px"><label class="f inline-f">Money went into<select name="account_id">${accts.map((o) => `<option value="${o.v}" ${bank && +o.v === bank.id ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select></label>
            ${unb.length ? '<label class="check"><input type="checkbox" name="unbilled_ok"> Book unbilled orders as other income</label>' : ''}<span class="spacer"></span><button class="btn primary">Post this payout</button></form>`}`;
        if ($('#stpost')) $('#stpost').onsubmit = async (ev) => {
          ev.preventDefault();
          const pf = ev.target, btn = $('button', pf); btn.disabled = true;
          try {
            const r = await POST('/api/channels/settlement/post', { ...sbody, account_id: +pf.elements.account_id.value, unbilled_ok: !!(pf.elements.unbilled_ok && pf.elements.unbilled_ok.checked) });
            dirty('accounts', 'parties'); toast(`Payout posted: ${r.invoices} invoices marked paid, ${inr(r.deposit)} in the bank`);
            pf.outerHTML = '<div class="panel okbox">Posted. The invoices are paid; fees, TCS and TDS are booked.</div>'; drawPayouts();
          } catch (x) { btn.disabled = false; toast(x.message, 'err'); }
        };
      } catch (x) { err.hidden = false; err.textContent = x.message; }
    };
  }
  const f = $('#chf');
  f.elements.channel.onchange = () => { $('#chhelp').textContent = CHANNEL_HELP[f.elements.channel.value]; $('#storef').hidden = f.elements.channel.value !== 'other'; };
  $('#stdl').onclick = () => fileDownload('/api/channels/stock?warehouse_id=' + (($('#stwh') || {}).value || 0));
  let body = null;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.err', f); err.hidden = true;
    const file = f.elements.file.files[0];
    if (!file) { err.hidden = false; err.textContent = 'Choose the order report file first.'; return; }
    try {
      const buf = await file.arrayBuffer();
      const csv = /\.xlsx$/i.test(file.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75' ? rowsToCsv(await xlsxRows(buf)) : new TextDecoder().decode(buf);
      body = { channel: f.elements.channel.value, store: f.elements.store.value, warehouse_id: +((f.elements.warehouse_id || {}).value || 0), csv };
      showCheck(await POST('/api/channels/import', body));
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
  const showCheck = (r) => {
    const box = $('#chres'), todo = r.orders.filter((o) => !o.done && !o.problems.length), bad = r.orders.filter((o) => o.problems.length);
    const rets = r.returns || [], retTodo = rets.filter((x) => !x.done && !x.problems.length), retBad = rets.filter((x) => !x.done && x.problems.length);
    box.innerHTML = `<div class="kpis" style="margin-top:14px"><div class="kpi"><div class="l">Ready to bill</div><div class="v">${r.ready}</div><div class="s">${inr0(todo.reduce((s, o) => s + o.total, 0))}</div></div>
        <div class="kpi"><div class="l">Already billed</div><div class="v">${r.already}</div></div><div class="kpi"><div class="l">Need attention</div><div class="v ${bad.length ? 'neg' : ''}">${bad.length}</div></div>
        ${rets.length ? `<div class="kpi"><div class="l">Returns / refunds to book</div><div class="v">${retTodo.length}</div><div class="s">${rets.filter((x) => x.done).length} done before</div></div>` : ''}</div>
      ${retTodo.length ? `<div class="panel" id="retbox"><h3 style="margin-top:0">Returns and refunds</h3><p class="muted">Each becomes a sales return against its invoice: the goods come back into stock and the GST is reversed.</p>
        ${table([{ h: 'Order', k: 'order_id' }, { h: 'Invoice', k: 'invoice' }, { h: 'Date', f: (x) => fdate(x.date) }, { h: 'Items', f: (x) => x.lines.map((l) => `${esc(l.item)} × ${qtyf(l.qty)}`).join('<br>') },
          { h: 'Why', f: (x) => esc(x.why) }, { h: 'Amount', num: 1, f: (x) => inr(x.total) }], retTodo.slice(0, 200))}
        <div class="row" style="margin-top:10px"><span class="muted" id="retstat"></span><span class="spacer"></span><button class="btn primary" id="retgo">Make ${retTodo.length} sales return${retTodo.length > 1 ? 's' : ''}</button></div></div>` : ''}
      ${retBad.length ? `<div class="panel warnbox"><b>Refunds that cannot be booked here:</b><ul>${retBad.slice(0, 30).map((x) => `<li>${esc(x.order_id)}: ${esc(x.problems.join('; '))}</li>`).join('')}</ul></div>` : ''}
      ${bad.length ? `<div class="panel warnbox"><b>These orders will be skipped:</b><ul>${bad.slice(0, 50).map((o) => `<li>${esc(o.order_id)}: ${esc(o.problems.join('; '))}</li>`).join('')}</ul>
        <span class="muted">Fix: add the SKU to the item (Items → Edit → SKU), then check again.</span></div>` : ''}
      ${todo.length ? table([{ h: 'Order', k: 'order_id' }, { h: 'Date', f: (o) => fdate(o.date) }, { h: 'Bill to', k: 'party' }, { h: 'Items', f: (o) => o.lines.map((l) => `${esc(l.item)} × ${qtyf(l.qty)}`).join('<br>') },
        { h: 'Amount', num: 1, f: (o) => inr(o.total) }], todo.slice(0, 200)) + (todo.length > 200 ? `<p class="muted">…and ${todo.length - 200} more.</p>` : '')
        + `<div class="prog" hidden><i></i></div><div class="row" style="margin-top:10px"><span class="muted" id="chstat"></span><span class="spacer"></span><button class="btn primary" id="chgo">Make ${todo.length} invoice${todo.length > 1 ? 's' : ''}</button></div>` : '<p class="muted">Nothing new to bill in this file.</p>'}`;
    if ($('#retgo')) $('#retgo').onclick = async () => {
      const b = $('#retgo'); b.disabled = true;
      const ok = [], fail = [];
      for (let i = 0; i < retTodo.length; i += 2) {
        const part = retTodo.slice(i, i + 2).map((x) => x.key);
        try { for (const x of (await POST('/api/channels/import', { ...body, only_returns: part })).results) (x.number || x.skipped ? ok : fail).push(x); }
        catch (x) { for (const k of part) fail.push({ order_id: k, error: x.message }); }
        $('#retstat').textContent = `${Math.min(retTodo.length, i + 2)} of ${retTodo.length}…`;
      }
      dirty('items', 'parties', 'accounts');
      $('#retstat').innerHTML = `<b>${ok.filter((x) => x.number).length} sales returns made.</b>${fail.length ? ` ${fail.length} failed: ${fail.slice(0, 10).map((x) => `${esc(x.order_id)} (${esc(x.error)})`).join(', ')}` : ''} <a href="#/sales/SRET">See returns</a>`;
      b.hidden = true;
    };
    if (!todo.length) return;
    $('#chgo').onclick = async () => {
      const go1 = $('#chgo'); go1.disabled = true; $('.prog', box).hidden = false;
      const ok = [], fail = [];
      for (let i = 0; i < todo.length; i += 2) {
        const part = todo.slice(i, i + 2).map((o) => o.order_id);
        try {
          const res = await POST('/api/channels/import', { ...body, only: part });
          for (const x of res.results) (x.number || x.skipped ? ok : fail).push(x);
        } catch (x) { for (const id of part) fail.push({ order_id: id, error: x.message }); }
        $('.prog i', box).style.width = Math.round(Math.min(todo.length, i + 2) / todo.length * 100) + '%';
        $('#chstat').textContent = `${Math.min(todo.length, i + 2)} of ${todo.length}…`;
      }
      dirty('items', 'parties', 'accounts');
      $('#chstat').innerHTML = `<b>${ok.filter((x) => x.number).length} invoices made.</b>${fail.length ? ` ${fail.length} failed: ${fail.slice(0, 10).map((x) => `${esc(x.order_id)} (${esc(x.error)})`).join(', ')}` : ''} <a href="#/sales/INV">See invoices</a>`
        + (retBad.some((x) => !x.doc_id) ? ' <button type="button" class="btn sm primary" id="rechk">Check refunds now</button>' : '');
      go1.hidden = true;
      if ($('#rechk')) $('#rechk').onclick = () => f.requestSubmit();
    };
  };
});

/* ======================================================================= staff, attendance and salary */
const MARKS = [['P', 'Present'], ['A', 'Absent'], ['H', 'Half day'], ['L', 'Paid leave'], ['O', 'Week off / holiday']];
const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (m, k) => { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7); };
const payLabel = (s) => `${inr0(s.rate)} / ${s.pay_type === 'day' ? 'day' : 'month'}`;
function staffForm(s = {}, after) {
  modal(s.id ? `Edit ${s.name}` : 'Add staff', [
    { k: 'name', label: 'Name', value: s.name, required: true }, { k: 'phone', label: 'Mobile (for payslip on WhatsApp)', value: s.phone, type: 'tel' },
    { k: 'pay_type', label: 'Pay', type: 'select', value: s.pay_type || 'month', options: [{ v: 'month', t: 'Monthly salary' }, { v: 'day', t: 'Daily wage' }] },
    { k: 'rate', label: 'Salary / wage (₹)', type: 'number', value: s.rate ?? '', required: true },
    { k: 'title', label: 'Work (e.g. salesman, helper)', value: s.title, more: true }, { k: 'join_date', label: 'Joined on', type: 'date', value: s.join_date || ME.today, more: true },
    { k: 'ot_rate', label: 'Overtime ₹ per hour', type: 'number', value: s.ot_rate || '', more: true },
    ...(s.id ? [{ k: 'active', label: 'Still working here', type: 'checkbox', value: s.active !== 0, more: true }] : []),
    { k: 'notes', label: 'Notes', value: s.notes, more: true },
    { k: 'pf', label: 'PF applies (EPF)', type: 'checkbox', value: !!s.pf, more: true }, { k: 'uan', label: 'UAN (12 digits)', value: s.uan || '', more: true },
    { k: 'wage_pct', label: 'Wages for PF (% of salary: basic + DA, 50 or more)', type: 'number', value: s.wage_pct || 50, more: true },
    { k: 'eps', label: 'Pension (EPS) member (untick for staff not in EPS)', type: 'checkbox', value: s.eps !== 0, more: true },
    { k: 'esi', label: 'ESI applies (salary ₹21,000 or less)', type: 'checkbox', value: !!s.esi, more: true }, { k: 'esi_no', label: 'ESI IP number (10 digits)', value: s.esi_no || '', more: true },
    { k: 'pt_auto', label: `Professional tax by the ${ME.org.state || 'state'} slab`, type: 'checkbox', value: !!s.pt_auto, more: true },
    { k: 'gender', label: 'Gender (Maharashtra has a separate women slab)', type: 'select', value: s.gender || '', more: true, options: [{ v: '', t: '—' }, { v: 'f', t: 'Woman' }, { v: 'm', t: 'Man' }] },
    { k: 'pt', label: 'Or a fixed professional tax ₹ per month (wins over the slab)', type: 'number', value: s.pt || '', more: true },
    { k: 'pan', label: 'PAN (for income tax on salary)', value: s.pan || '', more: true },
    { k: 'tds_mode', label: 'Income tax (TDS) on salary', type: 'select', value: s.tds_mode || '', more: true,
      options: [{ v: '', t: 'Not cut' }, { v: 'auto', t: 'Work it out (new regime)' }, { v: 'fixed', t: 'A fixed amount each month' }] },
    { k: 'tds_fixed', label: 'Fixed TDS ₹ per month (old regime or as the person asked)', type: 'number', value: s.tds_fixed || '', more: true }],
  async (v) => { await (s.id ? api('PUT', '/api/staff/' + s.id, v) : POST('/api/staff', v)); toast(s.id ? 'Saved' : `${v.name} added`); after(); },
  { submit: s.id ? 'Save' : 'Add', intro: '<p class="muted">Monthly staff: a day you do not mark counts as present, so mark only absences, half days and leave. Daily-wage staff: mark the days they worked.</p>' });
}
route(/^staff$/, async (el, m, q) => {
  const month = q.get('month') === 'last' ? shiftMonth(ME.today.slice(0, 7), -1) : q.get('month') || ME.today.slice(0, 7), d = await GET('/api/staff?month=' + month);
  const live = d.rows.filter((s) => s.active), isNow = month === ME.today.slice(0, 7);
  const markBtns = (s) => `<div class="marks" role="group" aria-label="Attendance today for ${esc(s.name)}">${MARKS.map(([k, t]) => `<button type="button" class="mk mk-${k} ${s.today === k ? 'on' : ''}" data-mk="${k}" data-s="${s.id}" title="${t}" aria-pressed="${s.today === k}">${k === 'H' ? '½' : k}</button>`).join('')}</div>`;
  el.innerHTML = head('Staff & Salary', '<a class="btn" href="#/statutory">PF / ESI return</a><button class="btn primary" id="add">+ Add staff</button>') + `
    ${live.length ? `<div class="panel"><div class="row"><h3 style="margin:0">Aaj ki haazri <span class="muted">· ${fdate(d.today)}</span></h3><span class="spacer"></span><button class="btn sm" id="allp">Mark all present</button></div>
      <div class="att">${live.map((s) => `<div class="att-row"><span><b>${esc(s.name)}</b>${s.title ? ` <span class="muted">${esc(s.title)}</span>` : ''}</span>${markBtns(s)}</div>`).join('')}</div>
      <p class="muted small" style="margin:8px 0 0">P present · A absent · ½ half day · L paid leave · O week off. Tap again to change.</p></div>` : ''}
    <div class="row" style="margin:6px 0 10px"><a class="btn sm" href="#/staff?month=${shiftMonth(month, -1)}">&lsaquo; ${esc(monthName(shiftMonth(month, -1)))}</a><b style="margin:0 8px">${esc(monthName(month))}</b>
      ${isNow ? '' : `<a class="btn sm" href="#/staff?month=${shiftMonth(month, 1)}">${esc(monthName(shiftMonth(month, 1)))} &rsaquo;</a>`}</div>
    <div class="panel flush">${table([{ h: 'Name', f: (s) => `<a href="#/staff/${s.id}?month=${month}"><b>${esc(s.name)}</b></a>${s.active ? '' : ' <span class="badge">left</span>'}<div class="muted">${esc(payLabel(s))}</div>` },
      { h: 'Days', num: 1, f: (s) => `${qtyf(s.pay.payable)}<div class="muted">A ${s.pay.A} · ½ ${s.pay.H}</div>` },
      { h: isNow ? 'Earned so far' : 'Salary', num: 1, f: (s) => inr0(s.pay.earned) }, { h: 'Advance due', num: 1, f: (s) => s.advance_due ? `<span class="neg">${inr0(s.advance_due)}</span>` : '<span class="muted">—</span>' },
      { h: '', f: (s) => s.paid ? `<a href="#/payslip/${s.paid.id}">${badge('paid')} ${inr0(s.paid.amount)}</a>` : s.active && s.pay.from ? `<a class="btn sm" href="#/staff/${s.id}?month=${month}&pay=1">Pay</a>` : '' }],
    d.rows, { empty: emptyCta('Add your staff to mark attendance, give advances and pay salaries. Salary, advance and the books stay in step.', '<button class="btn primary" data-addfirst>+ Add staff</button>') })}</div>`;
  const reload = () => render();
  $('#add').onclick = () => staffForm({}, reload);
  const af = $('[data-addfirst]', el); if (af) af.onclick = () => staffForm({}, reload);
  el.onclick = async (e) => {
    const b = e.target.closest('[data-mk]'); if (!b) return;
    const was = b.classList.contains('on'), row = b.parentElement;
    $$('[data-mk]', row).forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
    if (!was) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
    try { await POST('/api/staff/attendance', { marks: [{ staff_id: +b.dataset.s, status: was ? '' : b.dataset.mk }] }); } catch (err) { toast(err.message, 'err'); reload(); }
  };
  if ($('#allp')) $('#allp').onclick = async () => {
    const marks = live.filter((s) => !s.today).map((s) => ({ staff_id: s.id, status: 'P' }));
    if (!marks.length) return toast('Everyone is already marked');
    try { await POST('/api/staff/attendance', { marks }); toast(`${marks.length} marked present`); reload(); } catch (err) { toast(err.message, 'err'); }
  };
});
route(/^staff\/(\d+)$/, async (el, m, q) => {
  const month = q.get('month') || ME.today.slice(0, 7), d = await GET(`/api/staff/${m[1]}?month=${month}`), s = d.staff, p = d.pay;
  const by = new Map(d.marks.map((x) => [x.date, x])), n = p.days, lead = (new Date(month + '-01T00:00:00Z').getUTCDay() + 6) % 7;   // Monday first
  const cells = [...Array(lead).fill('<span></span>'), ...Array.from({ length: n }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`, mk = by.get(day), future = day > ME.today, before = day < s.join_date;
    return `<button type="button" class="cal-d ${mk ? 'mk-' + mk.status : ''} ${future || before ? 'off' : ''}" data-day="${day}" ${future || before ? 'disabled' : ''} aria-label="${fdate(day)}: ${mk ? MARKS.find(([k]) => k === mk.status)[1] : 'not marked'}">
      <small>${i + 1}</small><b>${mk ? (mk.status === 'H' ? '½' : mk.status) : ''}</b>${mk && mk.ot_hours ? `<i>+${mk.ot_hours}h</i>` : ''}</button>`;
  })].join('');
  el.innerHTML = head(esc(s.name), `<button class="btn" id="edit">Edit</button><button class="btn" id="adv">Give advance</button>${s.tds_mode ? `<a class="btn" href="#/tds-salary/${s.id}">Income tax statement</a>` : ''}${d.paid ? `<a class="btn" href="#/payslip/${d.paid.id}">Payslip</a>` : p.from ? '<button class="btn primary" id="pay">Pay salary</button>' : ''}`) + `
    <div class="kpis"><div class="kpi"><div class="l">Pay</div><div class="v">${esc(payLabel(s))}</div><div class="s">${esc(s.title || '')}${s.phone ? ' · ' + esc(s.phone) : ''}</div></div>
      <div class="kpi"><div class="l">${esc(monthName(month))}</div><div class="v">${inr0(p.earned)}</div><div class="s">${qtyf(p.payable)} payable day${p.payable === 1 ? '' : 's'}${p.ot_hours ? ` · OT ${p.ot_hours} h` : ''}</div></div>
      <div class="kpi"><div class="l">Advance due</div><div class="v ${d.advance_due ? 'neg' : ''}">${inr0(d.advance_due)}</div></div></div>
    <div class="panel"><div class="row"><a class="btn sm" href="#/staff/${s.id}?month=${shiftMonth(month, -1)}">&lsaquo;</a><b style="margin:0 10px">${esc(monthName(month))}</b>
      ${month < ME.today.slice(0, 7) ? `<a class="btn sm" href="#/staff/${s.id}?month=${shiftMonth(month, 1)}">&rsaquo;</a>` : ''}<span class="spacer"></span>
      <span class="muted small">P ${p.P} · A ${p.A} · ½ ${p.H} · L ${p.L} · O ${p.O}${s.pay_type === 'month' ? ` · not marked ${p.unmarked} (counted present)` : ''}</span></div>
      <div class="cal"><span class="cal-h">Mon</span><span class="cal-h">Tue</span><span class="cal-h">Wed</span><span class="cal-h">Thu</span><span class="cal-h">Fri</span><span class="cal-h">Sat</span><span class="cal-h">Sun</span>${cells}</div>
      <p class="muted small" style="margin:8px 0 0">Tap a day to mark it: P → A → ½ → L → O → clear. Long-press (or right-click) to add overtime hours.</p></div>
    <div class="panel flush"><div style="padding:14px 16px 0"><h3>Payments</h3></div>${table([{ h: 'Date', f: (t) => fdate(t.date) },
      { h: 'What', f: (t) => t.kind === 'salary' ? `Salary ${esc(monthName(t.month))}` : 'Advance' }, { h: 'From', k: 'account', cls: 'hide-sm' },
      { h: 'Amount', num: 1, f: (t) => `${t.status === 'cancelled' ? '<s>' : ''}${inr0(t.amount)}${t.status === 'cancelled' ? '</s>' : ''}` },
      { h: '', f: (t) => (t.kind === 'salary' && t.status === 'done' ? `<a class="btn sm" href="#/payslip/${t.id}">Payslip</a> ` : '') + (t.status === 'done' ? `<button class="btn sm danger" data-cx="${t.id}">Cancel</button>` : badge('cancelled')) }],
    d.txns, { empty: 'No advance or salary yet.' })}</div>`;
  const reload = () => render();
  $('#edit').onclick = () => staffForm(s, reload);
  const cash = await cashOpts();
  $('#adv').onclick = () => modal(`Advance to ${s.name}`, [{ k: 'amount', label: 'Amount (₹)', type: 'number', required: true }, { k: 'paid_from', label: 'Paid from', type: 'select', options: cash },
    { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'notes', label: 'Note', more: true }],
  async (v) => { await POST(`/api/staff/${s.id}/advance`, v); dirty('accounts'); toast('Advance saved'); reload(); }, { intro: '<p class="muted">You can cut it from a salary later, in parts or all at once.</p>' });
  const payNow = () => modal(`Pay ${s.name}: ${monthName(month)}`, [
    { k: 'gross', label: `Salary earned (₹) · ${qtyf(p.payable)} days${p.ot_pay ? ` + OT ${inr0(p.ot_pay)}` : ''}`, type: 'number', value: p.earned },
    { k: 'advance_cut', label: `Cut from advance (₹) · due ${inr0(d.advance_due)}`, type: 'number', value: Math.max(0, Math.min(d.advance_due, p.earned - (d.cuts || 0))) || '' },
    { k: 'paid_from', label: 'Paid from', type: 'select', options: cash }, { k: 'date', label: 'Date', type: 'date', value: ME.today },
    { k: 'bonus', label: 'Bonus / incentive (₹)', type: 'number', more: true }, { k: 'other_cut', label: 'Other deduction (₹, e.g. damage)', type: 'number', more: true },
    { k: 'notes', label: 'Note', more: true }],
  async (v) => { const r = await POST(`/api/staff/${s.id}/salary`, { ...v, month }); dirty('accounts'); toast(`Paid ${inr0(r.net)}`); go('payslip/' + r.id); },
  { submit: 'Pay salary', intro: s.pf || s.esi || s.pt || s.pt_auto || s.tds_mode ? `<p class="muted">${[s.pf && 'PF', s.esi && 'ESI', (s.pt || s.pt_auto) && 'professional tax', s.tds_mode && 'income tax (TDS)'].filter(Boolean).join(', ')} will be cut as set for ${esc(s.name)}${d.cuts ? ` (about ${inr0(d.cuts)})` : ''}; the payslip shows each.</p>` : '' });
  if ($('#pay')) $('#pay').onclick = payNow;
  if (q.get('pay') && $('#pay')) payNow();
  const order = ['', 'P', 'A', 'H', 'L', 'O'];
  const save = async (btn, status, ot = 0) => {
    try { await POST('/api/staff/attendance', { marks: [{ staff_id: s.id, date: btn.dataset.day, status, ot_hours: ot }] }); reload(); } catch (err) { toast(err.message, 'err'); }
  };
  $$('.cal-d[data-day]', el).forEach((b) => {
    b.onclick = () => { const cur = (by.get(b.dataset.day) || {}).status || ''; save(b, order[(order.indexOf(cur) + 1) % order.length], (by.get(b.dataset.day) || {}).ot_hours || 0); };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      const cur = by.get(b.dataset.day) || {}, h = prompt(`Overtime hours on ${fdate(b.dataset.day)}`, cur.ot_hours || '');
      if (h !== null) save(b, cur.status || 'P', +h || 0);
    };
  });
  el.onclick = async (e) => {
    const c = e.target.closest('[data-cx]'); if (!c) return;
    if (!confirm('Cancel this payment? Its entry in the books is reversed.')) return;
    try { await POST(`/api/staff/txns/${c.dataset.cx}/cancel`); dirty('accounts'); toast('Cancelled'); reload(); } catch (err) { toast(err.message, 'err'); }
  };
});
route(/^payslip\/(\d+)$/, async (el, m) => {
  const p = await GET('/api/staff/payslip/' + m[1]), dt = p.detail, o = p.org, st = dt.stat;
  const line = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="num">${v}</td></tr>`;
  const text = `*${o.name}* - Salary slip ${monthName(p.month)}\n${p.name}\nDays paid: ${qtyf(dt.payable || 0)} of ${dt.days || ''}\nEarned: ${inr0(p.gross)}${p.bonus ? `\nBonus: ${inr0(p.bonus)}` : ''}${p.advance_cut ? `\nAdvance cut: -${inr0(p.advance_cut)}` : ''}${p.other_cut ? `\nOther deduction: -${inr0(p.other_cut)}` : ''}${st && st.pf ? `\nPF: -${inr0(st.pf)}` : ''}${st && st.esi ? `\nESI: -${inr0(st.esi)}` : ''}${st && st.pt ? `\nProfessional tax: -${inr0(st.pt)}` : ''}${st && st.tds ? `\nIncome tax (TDS): -${inr0(st.tds)}` : ''}\n*Paid: ${inr0(p.net)}* on ${fdate(p.date)}${dt.advance_left ? `\nAdvance still due: ${inr0(dt.advance_left)}` : ''}`;
  const phone = String(p.phone || '').replace(/\D/g, '').replace(/^0/, '');
  el.innerHTML = head(`Payslip ${esc(p.name)}`, `${p.status === 'cancelled' ? badge('cancelled') : ''}<a class="btn got" target="_blank" rel="noopener" href="https://wa.me/${phone ? (phone.length === 10 ? '91' + phone : phone) : ''}?text=${encodeURIComponent(text)}">WhatsApp</a><button class="btn primary" data-act="print">Print</button>`) + `
    <div class="panel slip"><div class="row"><div><h2 style="margin:0">${esc(o.name)}</h2><div class="muted">${esc(o.address || '')}${o.phone ? ' · ' + esc(o.phone) : ''}</div></div><span class="spacer"></span><div style="text-align:right"><b>Salary slip</b><div>${esc(monthName(p.month))}</div></div></div>
      <hr><div class="row"><div><b>${esc(p.name)}</b>${p.title ? `<div class="muted">${esc(p.title)}</div>` : ''}</div><span class="spacer"></span><div class="muted">Paid on ${fdate(p.date)}</div></div>
      <table class="t" style="margin-top:12px"><tbody>
        ${line('Pay', `${inr0(dt.rate)} / ${p.pay_type === 'day' ? 'day' : 'month'}`)}
        ${line('Days in month', dt.days || '')}${line('Present / leave / week off', `${dt.P || 0} / ${dt.L || 0} / ${dt.O || 0}${p.pay_type === 'month' && dt.unmarked ? ` (+${dt.unmarked} not marked)` : ''}`)}
        ${line('Absent / half days', `${dt.A || 0} / ${dt.H || 0}`)}${line('<b>Days paid</b>', `<b>${qtyf(dt.payable || 0)}</b>`)}
        ${line('Salary for the days', inr(dt.base))}${dt.ot_pay ? line(`Overtime (${dt.ot_hours} h)`, inr(dt.ot_pay)) : ''}
        ${p.gross !== dt.earned ? line('Salary (as paid)', inr(p.gross)) : ''}${p.bonus ? line('Bonus / incentive', inr(p.bonus)) : ''}
        ${p.advance_cut ? line('Advance cut', '−' + inr(p.advance_cut)) : ''}${p.other_cut ? line('Other deduction', '−' + inr(p.other_cut)) : ''}
        ${st && st.pf ? line(`PF (${dt.rates ? dt.rates.pf_rate : 12}% of ${inr0(st.epf_wages)})${st.uan ? ` · UAN ${esc(st.uan)}` : ''}`, '−' + inr(st.pf)) : ''}${st && st.esi ? line(`ESI (${dt.rates ? dt.rates.esi_emp : 0.75}% of ${inr0(st.esi_wages)})${st.esi_no ? ` · IP ${esc(st.esi_no)}` : ''}`, '−' + inr(st.esi)) : ''}
        ${st && st.pt ? line('Professional tax', '−' + inr(st.pt)) : ''}${st && st.tds ? line(`Income tax (TDS, new regime)${st.pan ? ` · PAN ${esc(st.pan)}` : ''}`, '−' + inr(st.tds)) : ''}
        ${line('<b>Net paid</b>', `<b>${inr(p.net)}</b>`, 'grand')}${dt.advance_left ? line('Advance still due', inr(dt.advance_left)) : ''}
      </tbody></table>
      ${st && st.employer ? `<p class="muted small">Employer also pays ${inr(st.employer)} (PF ${inr(st.eps + st.er_epf)}, EDLI + admin ${inr(st.edli + st.admin)}${st.er_esi ? `, ESI ${inr(st.er_esi)}` : ''}) to the government.</p>` : ''}
      <p class="muted small" style="margin-top:16px">${esc(words(p.net))}</p>
      <div class="row" style="margin-top:40px"><span class="muted">Employee's signature</span><span class="spacer"></span><span class="muted">For ${esc(o.name)}</span></div></div>`;
});

/* one person's salary TDS for a tax year: what Form 130 (the yearly certificate from the TDS portal) should show */
route(/^tds-salary\/(\d+)$/, async (el, m, q) => {
  const y = q.get('year') || '', d = await GET(`/api/payroll/tds-statement/${m[1]}${y ? '?year=' + y : ''}`), A = d.part_a, B = d.part_b, C = d.part_c;
  const start = +d.tax_year.slice(0, 4), line = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="num">${v}</td></tr>`;
  el.innerHTML = head(`Income tax on salary: ${esc(A.employee.name)}`, `<a class="btn sm" href="#/tds-salary/${m[1]}?year=${start - 1}">&lsaquo; ${start - 1}-${String(start % 100).padStart(2, '0')}</a>
      <a class="btn sm" href="#/tds-salary/${m[1]}?year=${start + 1}">${start + 1}-${String((start + 2) % 100).padStart(2, '0')} &rsaquo;</a><button class="btn primary" data-act="print">Print</button>`) + `
    ${d.warnings.map((w) => `<div class="panel warnbox no-print">${esc(w)}</div>`).join('')}
    <div class="panel slip"><div class="row"><div><h2 style="margin:0">${esc(A.employer.name)}</h2><div class="muted">${esc(A.employer.address)}${A.employer.tan ? ' · TAN ' + esc(A.employer.tan) : ''}</div></div>
      <span class="spacer"></span><div style="text-align:right"><b>Salary TDS statement</b><div>Tax year ${esc(d.tax_year)} · new regime</div></div></div><hr>
      <div class="row"><div><b>${esc(A.employee.name)}</b><div class="muted">${A.employee.pan ? 'PAN ' + esc(A.employee.pan) : 'PAN not given'}${A.employee.title ? ' · ' + esc(A.employee.title) : ''}</div></div>
        <span class="spacer"></span><div class="muted">${A.period ? `${esc(monthName(A.period.from))} – ${esc(monthName(A.period.to))}` : 'No salary this year'}</div></div>
      <h3 style="margin-top:16px">Part B · Tax cut each quarter</h3>
      <table class="t"><thead><tr><th>Quarter</th><th class="num">Salary paid</th><th class="num">TDS cut</th></tr></thead><tbody>
        ${B.quarters.map((x) => `<tr><td>${x.quarter}</td><td class="num">${inr0(x.paid)}</td><td class="num">${inr0(x.tds)}</td></tr>`).join('')}
        <tr class="grand"><td><b>Total</b></td><td class="num"><b>${inr0(C.gross_salary)}</b></td><td class="num"><b>${inr0(B.total_tds)}</b></td></tr></tbody></table>
      ${B.challans.length ? `<p class="muted small">Salary TDS challans paid in the year: ${B.challans.map((x) => `${fdate(x.date)} ${inr0(x.amount)}${x.challan_no ? ' (' + esc(x.challan_no) + ')' : ''}`).join(', ')}</p>`
        : '<p class="muted small">No salary TDS challan (section 392) recorded for this year yet: TDS → Pay challan.</p>'}
      <h3 style="margin-top:16px">Part C · Tax worked out (new regime)</h3>
      <table class="t"><tbody>${line('Gross salary', inr(C.gross_salary))}${line('Less standard deduction', '−' + inr(C.standard_deduction))}${line('<b>Taxable income</b>', `<b>${inr(C.taxable)}</b>`)}
        ${line('Tax on it (after the rebate up to ₹12 lakh)', inr(C.tax))}${C.surcharge ? line('Surcharge', inr(C.surcharge)) : ''}${line('Health & education cess 4%', inr(C.cess))}
        ${line('<b>Tax for the year</b>', `<b>${inr(C.tax_payable)}</b>`, 'grand')}${line('TDS cut from salary', inr(C.tds_cut))}
        ${line(C.balance >= 0 ? 'Still to cut / pay' : 'Cut more than the tax', inr(Math.abs(C.balance)))}
        ${C.pf_paid ? line('Employee PF (not deducted in the new regime)', inr(C.pf_paid)) : ''}${C.pt_paid ? line('Professional tax paid', inr(C.pt_paid)) : ''}</tbody></table>
      <p class="muted small" style="margin-top:12px">The official certificate is Form 130 (it replaced Form 16 from 1 April 2026): it is made on the TDS portal after the quarterly salary TDS returns (Form 138) are filed. Check it against this statement. Old-regime staff: type their monthly TDS by hand on the staff page.</p></div>`;
});

/* PF / ESI / professional tax for a month: who paid what, the EPFO ECR file, the ESI upload sheet, challans paid */
route(/^statutory$/, async (el, m, q) => {
  const month = q.get('month') || shiftMonth(ME.today.slice(0, 7), -1), d = await GET('/api/payroll/statutory?month=' + month), T = d.totals;
  const rs = d.rates;
  el.innerHTML = head('PF / ESI Return', `<a class="btn" href="#/staff">Staff</a>${ME.can.settings ? '<button class="btn" id="rates">Rates</button>' : ''}`) + `
    <div class="panel"><div class="row"><a class="btn sm" href="#/statutory?month=${shiftMonth(month, -1)}">&lsaquo;</a><b style="margin:0 10px">${esc(monthName(month))}</b>
      <a class="btn sm" href="#/statutory?month=${shiftMonth(month, 1)}">&rsaquo;</a><span class="spacer"></span><span class="muted small">Pay by ${fdate(d.due_by)} · PF ${rs.pf_rate}% on wages up to ${inr0(rs.pf_ceiling)} · ESI ${rs.esi_emp}% + ${rs.esi_er}% up to ${inr0(rs.esi_limit)}</span></div></div>
    <div class="kpis"><div class="kpi"><div class="l">PF to deposit (EPFO)</div><div class="v">${inr0(T.pf)}</div><div class="s">${T.pf_paid ? `paid ${inr0(T.pf_paid)}` : 'not paid yet'}</div></div>
      <div class="kpi"><div class="l">ESI to deposit</div><div class="v">${inr0(T.esi)}</div><div class="s">${T.esi_paid ? `paid ${inr0(T.esi_paid)}` : 'not paid yet'}</div></div>
      <div class="kpi"><div class="l">Professional tax</div><div class="v">${inr0(T.pt)}</div><div class="s">${T.pt_paid ? `paid ${inr0(T.pt_paid)}` : 'not paid yet'}</div></div>
      ${T.tds ? `<div class="kpi"><div class="l">Income tax cut (TDS, sec 392)</div><div class="v">${inr0(T.tds)}</div><div class="s"><a href="#/tds">Pay it as a TDS challan</a> by the 7th</div></div>` : ''}</div>
    ${d.missing_uan.length ? `<div class="panel warnbox">Add the UAN of ${d.missing_uan.map(esc).join(', ')} (Staff → Edit) to download the ECR.</div>` : ''}
    ${d.missing_esi.length ? `<div class="panel warnbox">Add the ESI IP number of ${d.missing_esi.map(esc).join(', ')}.</div>` : ''}
    <div class="panel"><div class="row" style="flex-wrap:wrap;gap:6px">
      <button class="btn" id="ecr" ${T.pf ? '' : 'disabled'}>Download ECR (EPFO)</button><button class="btn" id="esif" ${T.esi ? '' : 'disabled'}>Download ESI file</button>
      ${['pf', 'esi', 'pt'].map((k) => `<button class="btn ${T[k] > T[k + '_paid'] ? 'primary' : ''}" data-chl="${k}" ${T[k] ? '' : 'disabled'}>Pay ${k === 'pf' ? 'PF' : k === 'esi' ? 'ESI' : 'PT'} challan</button>`).join('')}</div>
      <p class="muted small" style="margin:8px 0 0">Upload the ECR on the EPFO employer portal (Payments → ECR upload) and the ESI file on the ESIC portal; then record the challan here so the books show it paid.</p></div>
    <div class="panel flush">${table([{ h: 'Staff', f: (r) => `<b>${esc(r.name)}</b><div class="muted small">${r.uan ? 'UAN ' + esc(r.uan) : ''}${r.esi_no ? ' · IP ' + esc(r.esi_no) : ''}</div>` },
      { h: 'Gross', num: 1, f: (r) => inr0(r.gross_wages) }, { h: 'PF wages', num: 1, f: (r) => inr0(r.epf_wages), cls: 'hide-sm' },
      { h: 'PF (emp + empr)', num: 1, f: (r) => `${inr0(r.pf)} + ${inr0(r.eps + r.er_epf)}` }, { h: 'ESI (emp + empr)', num: 1, f: (r) => (r.esi || r.er_esi ? `${inr0(r.esi)} + ${inr0(r.er_esi)}` : '—') },
      { h: 'PT', num: 1, f: (r) => (r.pt ? inr0(r.pt) : '—'), cls: 'hide-sm' }, { h: 'TDS', num: 1, f: (r) => (r.tds ? inr0(r.tds) : '—'), cls: 'hide-sm' }, { h: 'NCP days', num: 1, k: 'ncp', cls: 'hide-sm' }], d.rows,
      { empty: 'No salary with PF, ESI or professional tax paid for this month. Tick PF / ESI on a staff member (Staff → Edit → More details), then pay the salary.' })}</div>
    ${d.challans.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Challans paid</h3></div>${table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'For', f: (x) => esc(x.kind.toUpperCase()) },
      { h: 'Ref / CRN', f: (x) => esc(x.ref || '') }, { h: 'Amount', num: 1, f: (x) => (x.status === 'cancelled' ? `<s>${inr0(x.amount)}</s>` : inr0(x.amount)) },
      { h: '', f: (x) => (x.status === 'done' && !limits().no_cancel ? `<button class="btn sm danger" data-chx="${x.id}">Cancel</button>` : x.status === 'cancelled' ? badge('cancelled') : '') }], d.challans)}</div>` : ''}`;
  if ($('#ecr')) $('#ecr').onclick = () => fileDownload('/api/payroll/ecr?month=' + month);
  if ($('#esif')) $('#esif').onclick = () => fileDownload('/api/payroll/esi?month=' + month);
  const cash = await cashOpts();
  $$('[data-chl]', el).forEach((b) => b.onclick = () => {
    const k = b.dataset.chl, due = Math.max(0, T[k] - T[k + '_paid']);
    modal(`Pay ${k === 'pf' ? 'PF (EPFO)' : k === 'esi' ? 'ESI' : 'professional tax'}: ${monthName(month)}`, [{ k: 'amount', label: 'Amount (₹)', type: 'number', value: due || '', required: true },
      { k: 'paid_from', label: 'Paid from', type: 'select', options: cash }, { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'ref', label: 'Challan / CRN / TRRN number' }],
    async (v) => { await POST('/api/payroll/challan', { ...v, kind: k, month }); dirty('accounts'); toast('Challan saved'); render(); });
  });
  $$('[data-chx]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Cancel this challan? Its entry in the books is reversed.')) return;
    try { await POST(`/api/payroll/challan/${b.dataset.chx}/cancel`); dirty('accounts'); toast('Cancelled'); render(); } catch (e) { toast(e.message, 'err'); }
  });
  if ($('#rates')) $('#rates').onclick = () => modal('Payroll rates', [
    { k: 'pf_ceiling', label: 'PF wage ceiling (₹ a month)', type: 'number', value: rs.pf_ceiling }, { k: 'pf_rate', label: 'PF rate % (employee and employer each)', type: 'number', value: rs.pf_rate },
    { k: 'eps_ceiling', label: 'EPS (pension) wage ceiling (₹)', type: 'number', value: rs.eps_ceiling }, { k: 'eps_rate', label: 'EPS % out of the employer share', type: 'number', value: rs.eps_rate },
    { k: 'edli_rate', label: 'EDLI %', type: 'number', value: rs.edli_rate }, { k: 'admin_rate', label: 'PF admin charges %', type: 'number', value: rs.admin_rate },
    { k: 'esi_limit', label: 'ESI applies up to gross (₹ a month)', type: 'number', value: rs.esi_limit }, { k: 'esi_emp', label: 'ESI employee %', type: 'number', value: rs.esi_emp },
    { k: 'esi_er', label: 'ESI employer %', type: 'number', value: rs.esi_er }, { k: 'tan', label: 'Business TAN (for income tax cut from salaries)', value: rs.tan || '' }],
  async (v) => {
    // only what the owner changed is kept: an unchanged rate follows the law's default when that changes
    let saved = {};
    try { saved = (typeof ME.org.setup === 'string' ? JSON.parse(ME.org.setup || '{}') : ME.org.setup || {}).payroll || {}; } catch (e) { saved = {}; }
    const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => String(x ?? '') !== String(rs[k] ?? '')));
    const r = await api('PUT', '/api/settings/setup', { payroll: { ...saved, ...changed } }); ME.org.setup = r.setup; toast('Rates saved'); render();
  },
  { intro: '<p class="muted">Set as per the EPF Scheme, 2026 (PF ceiling ₹25,000 from 17 Sep 2026) and ESIC. Check any change with your CA. New salaries use these rates; paid ones keep theirs.</p>' });
});

/* ======================================================================= offline: what still works, and the outbox */
function offlinePage(page) {
  page.innerHTML = head('No internet right now') + `<div class="panel"><p>This screen needs the internet. These still work, and are sent by themselves when you are back online:</p>
    <div class="row" style="flex-wrap:wrap;gap:8px">${ME.can.sales ? '<a class="btn primary" href="#/new/INV">New invoice</a><a class="btn" href="#/pos">Quick bill (POS)</a>' : ''}
      ${ME.can.purchase ? '<a class="btn" href="#/new/BILL">Purchase bill</a>' : ''}${ME.can.finance || ME.can.sales ? '<button class="btn" data-off="receipt">Receive payment</button>' : ''}
      ${ME.can.finance ? '<button class="btn" data-off="expense">Expense</button>' : ''}<a class="btn" href="#/outbox">Outbox</a></div>
    <p class="muted small" style="margin-top:10px">Customers, items and prices are the copy saved the last time you were online.</p></div>`;
  page.onclick = (e) => {
    const b = e.target.closest('[data-off]'); if (!b) return;
    if (b.dataset.off === 'receipt') paymentForm('receipt'); else expenseForm();
  };
}
async function expenseForm({ amount = '', date = '', notes = '', paid_from = '', head = '' } = {}) {
  // heads the app books by itself (stock, transit loss, depreciation ...) are not typed in by hand
  const exp = (await master('accounts')).filter((a) => a.type === 'expense' && !['cogs', 'stock_adj', 'round_off', 'transit_loss', 'pur_adj', 'depreciation', 'asset_loss'].includes(a.sys));
  const pick = (head && exp.find((a) => a.name.toLowerCase().includes(head))) || (amount ? exp.find((a) => a.sys === 'misc_exp') : null), saveKey = newKey();
  modal('Add expense', [{ k: 'account_id', label: 'Expense head', type: 'select', options: opts(exp, (a) => a.name), value: pick ? pick.id : '' },
    { k: 'amount', label: 'Amount before GST (₹)', type: 'number', required: true, value: amount }, { k: 'gst_amount', label: 'GST paid (input credit, ₹)', type: 'number', value: 0 },
    { k: 'paid_from', label: 'Paid from', type: 'select', options: await cashOpts(), value: paid_from }, { k: 'date', label: 'Date', type: 'date', value: date || ME.today }, { k: 'notes', label: 'Notes', wide: true, value: notes }],
  async (v) => { const r = await POST('/api/expenses', { ...v, account_id: +v.account_id, paid_from: +v.paid_from }, { key: saveKey }); dirty('accounts'); toast(r.queued ? 'No internet: saved on this device, sent when online.' : 'Expense saved', r.queued ? 'info' : 'ok'); render(); });
}
route(/^outbox$/, async (el) => {
  const q = await queueAll();
  el.innerHTML = head('Outbox', q.length ? '<button class="btn primary" id="syncnow">Send now</button>' : '') + `
    <div class="panel muted">Made on this device without internet. They go to the cloud by themselves when you are online. A bill gets its number then, and the stock is checked then.</div>
    ${q.length ? `<div class="panel flush">${table([{ h: 'Entry', f: (x) => `<b>${esc(x.label)}</b>${x.body && x.body.lines ? `<div class="muted">${x.body.lines.length} line${x.body.lines.length > 1 ? 's' : ''}</div>` : ''}` },
      { h: 'Made', f: (x) => new Date(x.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
      { h: 'Status', f: (x) => x.error ? `<span class="neg">${esc(x.error)}</span>` : '<span class="muted">waiting</span>' },
      { h: '', f: (x) => `${x.status === 409 && x.data && x.data.credit_warning ? `<button class="btn sm" data-ok="${esc(x.key)}">Save anyway</button> ` : ''}<button class="btn sm danger" data-drop="${esc(x.key)}">Discard</button>` }], q)}</div>`
      : `<div class="panel">${emptyCta('Nothing waiting. Everything is saved in the cloud.')}</div>`}`;
  if ($('#syncnow')) $('#syncnow').onclick = async () => { await syncOutbox(); render(); };
  el.onclick = async (e) => {
    const d = e.target.closest('[data-drop]'), ok = e.target.closest('[data-ok]');
    if (d && confirm('Discard this entry? It was never sent, so nothing else changes.')) { await idbDo('queue', 'readwrite', (s) => s.delete(d.dataset.drop)); outboxBadge(); render(); }
    if (ok) {
      const it = q.find((x) => x.key === ok.dataset.ok);
      await idbDo('queue', 'readwrite', (s) => s.put({ ...it, body: { ...it.body, credit_ok: true }, error: '', status: 0 }));
      await syncOutbox(); render();
    }
  };
});

/* ======================================================================= purchase bill scan */
const isNoteType = (t) => ['SRET', 'PRET', 'CNOTE', 'DNOTE'].includes(t);
/* the bill is read on this phone (public/billocr.js: pdf.js for PDFs with text, Tesseract OCR for photos): free, and the
   picture never leaves the device */
async function scanBillFlow(file, type) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="status"><h2>Reading the bill on this phone…</h2>
    <p class="muted" id="scanmsg">The first time the reader downloads (about 7 MB), then it works offline too. A photo takes 10 to 40 seconds.</p><div class="prog"><i id="scanbar" class="spin"></i></div></div></div>`;
  const [parties, items] = await Promise.all([master('parties'), master('items')]);
  let r;
  try {
    const { readBill } = await import('/billocr.js');
    r = await readBill(file, { items, parties, orgGstin: ME.org.gstin, onProgress: (p) => { const b = $('#scanbar'); if (b) { b.classList.remove('spin'); b.style.width = Math.round(p * 100) + '%'; } } });
  } catch (e) { root.innerHTML = ''; return toast(e.message || 'The bill could not be read.', 'err'); }
  const sups = parties.filter((p) => p.kind !== 'customer');
  const itemOpts = (l) => `<option value="new" ${l.item_id ? '' : 'selected'}>+ New item: ${esc(l.name || '(no name)')}</option>`
    + items.filter((i) => !i.is_service).map((i) => `<option value="${i.id}" ${i.id === l.item_id ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const sum = r.lines.reduce((s, l) => s + l.qty * l.rate * (1 - l.discount_pct / 100) * (1 + l.gst_rate / 100), 0);
  const form = modal('Check what was read', [], async (v, f) => {
    const sel = f.elements.sup.value;
    let partyId = +sel || 0;
    if (sel === 'new') {
      const p = await POST('/api/parties', { name: f.elements.sup_name.value || r.supplier.name, kind: 'supplier', gstin: r.supplier.gstin, state: r.supplier.state, phone: r.supplier.phone, address: r.supplier.address });
      partyId = p.id;
    }
    const lines = [];
    for (const [i, l] of r.lines.entries()) {
      const choice = f.elements['it' + i].value;
      if (choice === 'skip') continue;
      let itemId = +choice || 0;
      if (choice === 'new') {
        const it = await POST('/api/items', { name: l.name, hsn: l.hsn, unit: l.unit || 'Pcs', gst_rate: l.gst_rate, purchase_price: l.rate, sale_price: 0, track_batch: !!l.batch_no });
        itemId = it.id;
      }
      lines.push({ item_id: itemId, qty: l.qty || 1, rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate, batch_no: l.batch_no, expiry: l.expiry ? l.expiry + '-01' : '' });
    }
    dirty('items', 'parties');
    const note = r.adds_up ? `Filled from the scanned bill${r.bill_no ? ` no. <b>${esc(r.bill_no)}</b>` : ''}. Check the lines, then save.`
      : `⚠ The lines add up to <b>${inr(sum)}</b> but the bill says <b>${inr(r.totals.total)}</b>. Check each line against the bill before saving.`;
    sessionStorage.setItem('st_scan', JSON.stringify({ type, party_id: partyId, date: r.bill_date || ME.today, party_ref: r.bill_no || '', notes: r.bill_date ? `Supplier bill dated ${fdate(r.bill_date)}` : '',
      lines: lines.length ? lines : [{}], scan_note: note + (r.notes ? `<div class="muted small">Note: ${esc(r.notes)}</div>` : ''), scan_ok: r.adds_up }));
    location.hash = `#/new/${type}?scan=${Date.now()}`;
  }, { submit: 'Fill the bill', intro: `
    <div class="form"><label class="f">Supplier<select name="sup">${r.supplier.party_id ? '' : `<option value="new" selected>+ New supplier: ${esc(r.supplier.name)}${r.supplier.gstin ? ` (${esc(r.supplier.gstin)})` : ''}</option>`}
      ${sups.map((p) => `<option value="${p.id}" ${p.id === r.supplier.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="f">New supplier's name<input name="sup_name" value="${esc(r.supplier.name)}"></label>
      <label class="f">Bill no. / date<input value="${esc([r.bill_no, r.bill_date && fdate(r.bill_date)].filter(Boolean).join(' · '))}" disabled></label></div>
    ${r.adds_up ? '' : `<div class="warnbox panel" style="margin:10px 0">The lines add up to <b>${inr(sum)}</b>, the bill total is <b>${inr(r.totals.total)}</b>. Some figure may be misread: check after filling.</div>`}
    <div class="tbl-wrap"><table class="t"><thead><tr><th>On the bill</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th>Your item</th></tr></thead><tbody>
      ${r.lines.map((l, i) => `<tr><td>${esc(l.name)}${l.hsn ? `<div class="muted">HSN ${esc(l.hsn)}</div>` : ''}${l.batch_no ? `<div class="muted">Batch ${esc(l.batch_no)}${l.expiry ? ' · ' + esc(l.expiry) : ''}</div>` : ''}</td>
        <td class="num">${qtyf(l.qty)} ${esc(l.unit)}</td><td class="num">${inr(l.rate)}</td><td class="num">${l.gst_rate}%</td>
        <td><select name="it${i}" aria-label="Item for ${esc(l.name)}">${itemOpts(l)}<option value="skip">Leave out</option></select>${l.match === 'guess' ? '<div class="muted small">best guess: check</div>' : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${r.notes ? `<p class="warnbox panel small">${esc(r.notes)}</p>` : ''}
    <p class="muted small">Read on this phone; a photo can be misread, so check each line. Nothing is saved until you save the bill.</p>` });
  const sn = form.elements.sup_name.closest('label');
  const syncSup = () => { sn.hidden = form.elements.sup.value !== 'new'; };
  form.elements.sup.onchange = syncSup; syncSup();
}

/* ======================================================================= guided put-away and wave picking */
route(/^putaway$/, async (el, m, q) => {
  const whs = await master('warehouses'), wid = +q.get('wh') || (whs[0] && whs[0].id);
  const P = await GET('/api/bins/putaway?warehouse_id=' + wid);
  const codeToId = new Map(P.bins.map((b) => [b.code.toUpperCase(), b.id]));
  el.innerHTML = head(`Put away · ${esc(P.warehouse.name)}`, `<a class="btn" href="#/bins?wh=${wid}">Bins</a>${P.rows.length ? '<button class="btn primary" id="putall">Put all as suggested</button>' : ''}`) + `
    <div class="panel muted">Walk the list: take the goods to the bin shown (its default bin, a bin that already has it, or an empty one), scan or type the bin's label, tap <b>Done</b>.</div>
    ${P.rows.length ? `<div class="panel flush">${table([{ h: 'Item', f: (r) => `<b>${esc(r.name)}</b>` },
      { h: 'Qty', f: (r) => `<input class="pa-q" data-q="${r.id}" type="number" step="any" min="0" inputmode="decimal" value="${r.free}" style="width:90px" aria-label="Quantity"> ${esc(r.unit)}` },
      { h: 'To bin', f: (r) => `<input class="pa-b mono" data-b="${r.id}" value="${esc(r.suggest ? r.suggest.code : '')}" placeholder="scan bin" style="width:110px" autocapitalize="characters" aria-label="Bin"><div class="muted small">${r.suggest ? esc(r.suggest.why) : 'no free bin: add bins'}</div>` },
      { h: '', f: (r) => `<button class="btn sm primary" data-pa="${r.id}">Done</button>` }], P.rows)}</div>` : `<div class="panel">${emptyCta('Everything in this godown is in a bin.')}</div>`}`;
  const put = async (id) => {
    const code = ($(`[data-b="${id}"]`).value || '').trim().toUpperCase(), qty = +$(`[data-q="${id}"]`).value || 0, bin = codeToId.get(code);
    if (!bin) throw new Error(`No bin called ${code || '(empty)'} in this godown.`);
    await POST('/api/bins/move', { item_id: id, warehouse_id: wid, from_bin_id: 0, to_bin_id: bin, qty });
    const tr = $(`[data-pa="${id}"]`).closest('tr'); tr.classList.add('done'); $(`[data-pa="${id}"]`).outerHTML = badge('ok');
  };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    try { await put(+b.dataset.pa); } catch (err) { toast(err.message, 'err'); }
  };
  // a scanner types the label and Enter: that confirms the row
  el.onkeydown = async (e) => { if (e.key === 'Enter' && e.target.matches('.pa-b')) { e.preventDefault(); try { await put(+e.target.dataset.b); } catch (err) { toast(err.message, 'err'); } } };
  if ($('#putall')) $('#putall').onclick = async () => {
    let n = 0;
    for (const r of P.rows) { if (!$(`[data-pa="${r.id}"]`)) continue; try { await put(r.id); n++; } catch (err) { toast(`${r.name}: ${err.message}`, 'err'); break; } }
    if (n) toast(`${n} item${n > 1 ? 's' : ''} put away`);
  };
});
route(/^wave$/, async (el, m, q) => {
  if (q.get('ids') && q.get('print') !== '1') return wavePick(el, q.get('ids'));
  if (q.get('ids')) {
    const w = await GET('/api/picklist?ids=' + q.get('ids'));
    el.innerHTML = head('Wave pick list', `<a class="btn" href="#/wave?ids=${esc(q.get('ids'))}">Pick by scan</a><a class="btn" href="#/wave">Change orders</a><button class="btn primary" data-act="print">Print</button>`) + `
      <div class="doc-paper"><div class="hdr"><div><div style="font-size:18px;font-weight:700">PICK LIST · ${w.docs.length} ORDERS</div><div>Godown: ${esc(w.warehouse)} · ${fdate(ME.today)}</div></div>
        <div style="text-align:right" class="small">${w.docs.map((d) => `${esc(d.number)} ${esc(d.party || '')}`).join('<br>')}</div></div>
        <div class="tbl-wrap"><table class="dl"><thead><tr><th>✓</th><th>Bin</th><th>Item</th><th>Batch (first to expire)</th><th class="num">Pick</th><th>For order</th></tr></thead>
        <tbody>${w.rows.map((r) => `<tr><td style="width:28px">☐</td><td>${r.from.length ? r.from.map((f) => `<b>${esc(f.code)}</b> <span class="muted">${qtyf(f.qty)}</span>`).join('<br>') : r.location ? `<b>${esc(r.location)}</b>` : '<span class="muted">not put away</span>'}${r.short_of_bins && r.from.length ? `<div class="muted small">+${qtyf(r.short_of_bins)} not in a bin</div>` : ''}</td>
          <td>${esc(r.name)}</td><td class="small">${r.batches.map((b) => `${esc(b.batch_no)}${b.expiry ? ` · ${mmyy(b.expiry)}` : ''}`).join('<br>')}</td><td class="num"><b>${qtyf(r.qty)}</b> ${esc(r.unit)}</td>
          <td class="small">${r.orders.map((o) => `${esc(o.number)} × ${qtyf(o.qty)}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>
        <div class="foot"><div>${w.rows.length} items to pick</div><div class="sign">Picked by ____________ Checked by ____________</div></div></div>`;
    return;
  }
  const [so, dn] = await Promise.all([GET('/api/docs?type=SO'), GET('/api/docs?type=DN')]);
  const open = [...so.rows.filter((d) => ['open', 'partial'].includes(d.status)), ...dn.rows.filter((d) => d.status === 'open')];
  el.innerHTML = head('Combined pick list') + `<div class="panel muted">Pick many orders in one walk through the godown: choose the orders, then scan each piece. The app says which order each piece goes to, and refuses a wrong design, colour or size or one too many.</div>
    ${open.length ? `<div class="panel flush">${table([{ h: '<input type="checkbox" id="wall" aria-label="All">', f: (d) => `<input type="checkbox" class="wsel" value="${d.id}" aria-label="${esc(d.number)}">` },
      { h: 'Order', k: 'number' }, { h: 'Customer', k: 'party' }, { h: 'Date', f: (d) => fdate(d.date) }, { h: 'Amount', num: 1, f: (d) => inr(d.total) }], open)}</div>
      <div class="row savebar"><span class="muted" id="wcount">0 chosen</span><span class="spacer"></span>${wfOf().pick_mode === 'scan' ? '<span id="wprint" hidden></span>' : '<button class="btn" id="wprint" disabled>Print list</button>'}<button class="btn primary" id="wgo" disabled>Pick by scan</button></div>`
      : `<div class="panel">${emptyCta('No open sales orders or delivery notes to pick.')}</div>`}`;
  const upd = () => { const n = $$('.wsel:checked', el).length; $('#wcount').textContent = `${n} chosen`; $('#wgo').disabled = !n; $('#wprint').disabled = !n; };
  if ($('#wall')) $('#wall').onchange = (e) => { $$('.wsel', el).forEach((x) => { x.checked = e.target.checked; }); upd(); };
  el.onchange = (e) => { if (e.target.matches('.wsel')) upd(); };
  if ($('#wgo')) $('#wgo').onclick = () => go('wave?ids=' + $$('.wsel:checked', el).map((x) => x.value).join(','));
  if ($('#wprint')) $('#wprint').onclick = () => go('wave?print=1&ids=' + $$('.wsel:checked', el).map((x) => x.value).join(','));
});
async function wavePick(el, ids) {
  let st = await GET('/api/pick?ids=' + encodeURIComponent(ids));
  const log = [];
  let lastTo = null;
  const paint = () => {
    $('#wtop').innerHTML = `<b>${qtyf(st.picked)}</b> of <b>${qtyf(st.need)}</b> pieces picked · ${st.orders.filter((o) => o.done).length} of ${st.orders.length} orders complete`;
    $('#wto').innerHTML = lastTo ? `<div class="put-to ${lastTo.ok ? 'pos' : 'neg'}">${lastTo.html}</div>` : '<div class="put-to muted">Scan a piece: the order it goes to shows here.</div>';
    $('#witems').innerHTML = st.items.map((r) => `<tr class="${r.picked >= r.want - 0.0005 ? 'pk-ok' : r.picked ? 'pk-part' : ''}"><td>${r.location ? `<b>${esc(r.location)}</b>` : '<span class="muted">—</span>'}</td>
      <td>${esc(r.name)}<div class="muted small">${esc(r.code)}</div></td><td class="num"><b>${qtyf(r.picked)}</b> / ${qtyf(r.want)}</td>
      <td class="small">${r.orders.map((o) => `${esc(o.number)} <span class="muted">${qtyf(o.picked)}/${qtyf(o.want)}</span>`).join('<br>')}</td></tr>`).join('');
    $('#worders').innerHTML = st.orders.map((o) => `<div class="wo ${o.done ? 'done' : ''}"><div><b>${esc(o.number)}</b> · ${esc(o.party)}${o.city ? ` <span class="muted">${esc(o.city)}</span>` : ''}
      <div class="muted small">${qtyf(o.picked)} of ${qtyf(o.need)} picked</div></div>${o.done ? `<a class="btn sm primary" href="#/pack/${o.id}">Pack ✓</a>` : '<span class="pchip none">picking</span>'}</div>`).join('');
    $('#wlog').innerHTML = log.slice(-5).reverse().map((x) => `<div class="${x.ok ? 'pos' : 'neg'}">${esc(x.t)}</div>`).join('');
  };
  const onCode = async (code) => {
    code = String(code || '').trim();
    if (!code) return false;
    try {
      const qn = Math.max(1, Math.round(+($('#wqty') || {}).value || 1));
      const r = await POST('/api/pick/scan', { ids: st.orders.map((o) => o.id), code, qty: qn });
      if ($('#wqty')) $('#wqty').value = 1;
      st = r.state;
      lastTo = { ok: true, html: `Put <b>${esc(r.item)}</b> in <b class="put-big">${esc(r.order.number)}</b> · ${esc(r.order.party)}${r.order.done ? ' <span class="pchip pre">order complete ✓</span>' : ''}` };
      log.push({ ok: true, t: `✓ ${r.item} → ${r.order.number} (${r.order.party})` }); beep(true); paint(); return true;
    } catch (e) { lastTo = { ok: false, html: esc(e.message) }; log.push({ ok: false, t: e.message }); beep(false); paint(); return false; }
  };
  el.innerHTML = head('Combined pick list', `<a class="btn" href="#/wave">Change orders</a>${wfOf().pick_mode === 'scan' ? '' : `<a class="btn" href="#/wave?print=1&ids=${esc(ids)}">Print</a>`}`) + `
    <div class="panel"><div id="wtop"></div>
      <div class="row" style="margin-top:8px"><label class="pqty">Qty<input id="wqty" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Pieces for the next scan"></label><input id="wscan" placeholder="Scan or type item code…" autocomplete="off" enterkeyhint="done" style="flex:1;min-width:0">${canCamera() ? '<button class="btn primary" id="wcam">📷 Scan</button>' : ''}</div>
      <div id="wto"></div><div id="wlog" class="pk-log" aria-live="polite"></div></div>
    <div class="panel"><h3 style="margin-top:0">Orders</h3><div id="worders" class="worders"></div></div>
    <div class="panel flush"><div class="tbl-wrap"><table class="t"><thead><tr><th>Bin</th><th>Item</th><th class="num">Picked / to pick</th><th>For order</th></tr></thead><tbody id="witems"></tbody></table></div></div>
    <div class="row sticky-act"><button class="btn sm" id="wreset">Start again</button><span class="spacer"></span><a class="btn" href="#/dispatch?tab=picked">Dispatch Desk</a></div>`;
  const inp = $('#wscan');
  inp.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value; inp.value = ''; await onCode(v); inp.focus(); } });
  if ($('#wcam')) $('#wcam').onclick = () => cameraScan(onCode);
  $('#wreset').onclick = async () => {
    if (!confirm('Start picking these orders again from nothing?')) return;
    try { st = await POST('/api/pick/reset', { ids: st.orders.map((o) => o.id) }); lastTo = null; log.length = 0; paint(); } catch (er) { toast(er.message, 'err'); }
  };
  paint(); inp.focus();
}

/* ======================================================================= khata */
route(/^khata$/, async (el, m, q) => {
  const k = await GET('/api/khata');
  const pend = k.rows.reduce((s, r) => s + (r.pending || 0), 0);
  el.innerHTML = head('Khata Book', `<button class="btn primary" id="new">+ Add entry</button>`) + `
    <div class="khata-sum"><div class="kpi"><div class="l">You will get</div><div class="v get">${inr(k.you_will_get)}</div></div>
      <div class="kpi"><div class="l">You will give</div><div class="v give">${inr(k.you_will_give)}</div></div></div>
${ME.org.upi_id ? '' : '<div class="panel warnbox">Add your <b>UPI ID</b> in <a href="#/settings">Business &amp; Users</a> so customers get a <b>Pay by UPI</b> button and QR in every message.</div>'}
    ${pend ? `<div class="panel warnbox">${pend} entr${pend === 1 ? 'y is' : 'ies are'} not sent yet. They do not count until you send them to the customer.</div>` : ''}
    <div class="panel"><input id="search" placeholder="Search name or mobile…"></div><div class="panel flush" id="list"></div>
    <p class="muted">Every entry is sent to the customer on WhatsApp or SMS before it counts, with a private link where they can see and confirm their khata. Sent entries cannot be deleted, only reversed, so both sides can trust the record.</p>`;
  const cols = [{ h: 'Name', f: (r) => `<b>${esc(r.name)}</b><div class="muted">${esc(r.phone || '')}</div>${r.pending ? ` <span class="badge b-partial">${r.pending} not sent</span>` : ''}${r.disputed ? ` <span class="badge b-unpaid">${r.disputed} disputed</span>` : ''}` },
    { h: 'Last entry', f: (r) => fdate(r.last_date), cls: 'hide-sm' },
    { h: 'Balance', num: 1, f: (r) => r.balance === 0 ? '<span class="muted">settled</span>' : `<span class="${r.balance > 0 ? 'pos' : 'neg'}">${inr(Math.abs(r.balance))}</span><div class="muted">${r.balance > 0 ? "you'll get" : "you'll give"}</div>` }];
  const draw = (f) => { const r = k.rows.filter((x) => !f || (x.name + ' ' + x.phone).toLowerCase().includes(f)); $('#list').innerHTML = table(cols, r, { onRow: true, empty: f ? 'No match.' : emptyCta('Write down udhaar here. Each entry goes to the customer on WhatsApp, so both sides agree.', '<button class="btn primary" data-nk>+ Add first entry</button>') });
    if ($('[data-nk]', el)) $('[data-nk]', el).onclick = () => $('#new').click(); bindRows($('#list'), r, (x) => go('khata/' + x.id)); };
  draw('');
  $('#search').oninput = (e) => draw(e.target.value.toLowerCase());
  $('#new').onclick = () => modal('New khata entry', [{ k: 'name', label: 'Name', required: true }, { k: 'phone', label: 'Mobile (to send the entry)', type: 'tel' },
    { k: 'kind', label: 'Entry', type: 'select', options: [{ v: 'gave', t: 'You gave (udhaar diya)' }, { v: 'got', t: 'You got (paise mile)' }] },
    { k: 'amount', label: 'Amount (₹)', type: 'number' }, { k: 'note', label: 'Note', wide: true }, { k: 'date', label: 'Date', type: 'date', value: ME.today }],
  async (v) => { const r = await POST('/api/khata', v); dirty('parties'); setTimeout(() => sendEntry(r, () => go('khata/' + r.party_id)), 0); }, { submit: 'Next: send to customer' });
  if (takeNew(q)) $('#new').click();
});

/* Shows the message for an entry and sends it. The entry counts only once it has been sent. */
/* WhatsApp-style preview: *bold*, _italic_, links */
/* ======================================================================= sending to the customer
   Every message (bill, reminder, khata entry, receipt, balance statement) goes from the shop's own WhatsApp with one
   tap, so nothing here needs a paid WhatsApp API. Before it goes, the shop picks the customer's language (English,
   हिंदी or Hinglish; remembered per customer), and a bill goes as a real PDF file through the phone's share sheet. */
const LANGS = [['en', 'English'], ['hi', 'हिंदी'], ['hl', 'Hinglish']];
const langChips = (cur) => `<div class="chips langs" role="radiogroup" aria-label="Message language">${LANGS.map(([k, t]) =>
  `<button type="button" class="chip${k === cur ? ' on' : ''}" role="radio" aria-checked="${k === cur}" data-lang="${k}">${t}</button>`).join('')}</div>`;
const canShareFiles = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['%PDF'], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; } };
function saveFile(file) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const waFormat = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
  .replace(/(https?:\/\/\S+)/g, '<span class="wa-link">$1</span>').replace(/\n/g, '<br>');

/* o: { title, intro, lang, load(lang) -> { text, sms_text, whatsapp_url, sms_url, file_name? }, pdf() -> Promise<File> (a bill),
   sent(via, msg, lang) after the tap, later (close button label), closed() } */
function sendDialog(o) {
  const root = $('#modal-root'), files = !!o.pdf && canShareFiles();
  // '' = not chosen here: the server uses the customer's saved language (or the business default) and says which
  let lang = o.lang || '', msg = null, file = null, seq = 0, shut = false;
  root.innerHTML = `<div class="modal-bg"><div class="modal send-modal" role="dialog" aria-modal="true"><h2>${esc(o.title)}</h2>${o.intro || ''}
    <div class="sd-lang"><span class="muted small">Customer's language</span>${langChips(lang || ME.org.msg_lang || 'hl')}</div>
    <div class="wa-prev"><div class="wa-bubble" id="sd-msg"><span class="muted">Loading…</span></div></div>
    <p class="muted small" id="sd-nophone" hidden>No mobile number saved for this contact. WhatsApp will ask you to pick the chat.</p>
    <details class="muted"><summary>SMS text</summary><pre class="msg" id="sd-smst"></pre></details>
    <div class="send-btns">${o.pdf ? '<button class="btn got big" id="sd-pdf" disabled>Preparing PDF…</button><button class="btn" id="sd-wa" disabled>Send link only</button>'
    : '<button class="btn got big" id="sd-wa" disabled>Send on WhatsApp</button>'}<button class="btn" id="sd-sms" disabled>SMS</button></div>
    ${o.pdf ? `<p class="muted small">${files ? 'Tap, choose <b>WhatsApp</b>, then the customer. The PDF goes with the message. The message is also copied: paste it if WhatsApp leaves it out.'
    : 'The PDF is saved on this device first, then WhatsApp opens with the message: attach the PDF there (📎 → Document).'}</p>` : ''}
    <div class="actions"><button class="btn" id="sd-close">${esc(o.later || 'Close')}</button></div></div></div>`;
  const close = () => { if (shut) return; shut = true; root.innerHTML = ''; document.removeEventListener('keydown', keys); if (o.closed) o.closed(); };
  const keys = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', keys);
  $('#sd-close').onclick = close;
  const ready = () => {
    if (shut) return;
    $('#sd-wa').disabled = !msg; $('#sd-sms').disabled = !(msg && msg.sms_url);
    if (o.pdf) { const b = $('#sd-pdf'); b.disabled = !(msg && file); if (file) b.textContent = '📄 Send PDF on WhatsApp'; }
  };
  const load = async () => {
    const my = ++seq; msg = null; ready();
    try {
      const m = await o.load(lang);
      if (my !== seq || shut) return;
      msg = m; $('#sd-msg').innerHTML = waFormat(m.text); $('#sd-smst').textContent = m.sms_text || m.text;
      if (m.lang && m.lang !== lang) { lang = m.lang; $$('[data-lang]', root).forEach((x) => { x.classList.toggle('on', x.dataset.lang === lang); x.setAttribute('aria-checked', String(x.dataset.lang === lang)); }); }
      $('#sd-nophone').hidden = /[?&]phone=/.test(m.whatsapp_url);
    } catch (e) { if (my === seq && !shut) $('#sd-msg').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    ready();
  };
  $$('[data-lang]', root).forEach((b) => b.onclick = () => {
    if (b.dataset.lang === (lang || ME.org.msg_lang || 'hl')) return;
    lang = b.dataset.lang;
    $$('[data-lang]', root).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    load();
  });
  const done = async (via) => {        // the dialog goes at once; what follows the send (saving the entry, logging the reminder) runs, then the page refreshes
    const m = msg; shut = true; root.innerHTML = ''; document.removeEventListener('keydown', keys);
    try { if (o.sent) await o.sent(via, m, lang); } catch (e) { toast(e.message, 'err'); }
    if (o.closed) o.closed();
  };
  $('#sd-wa').onclick = () => { window.open(msg.whatsapp_url, '_blank'); done('whatsapp'); };     // open first: browsers allow it only inside the tap
  $('#sd-sms').onclick = () => { location.href = msg.sms_url; done('sms'); };
  if (o.pdf) {
    o.pdf().then((f) => { file = f; ready(); }).catch(() => { if (!shut) $('#sd-pdf').textContent = 'PDF could not be made here'; });
    $('#sd-pdf').onclick = () => {
      const f = new File([file], msg.file_name || file.name, { type: 'application/pdf' });
      if (!files) { saveFile(f); window.open(msg.whatsapp_url, '_blank'); done('whatsapp'); return; }
      try { navigator.clipboard.writeText(msg.text).catch(() => {}); } catch (e) { /* no clipboard here */ }
      navigator.share({ files: [f], text: msg.text }).then(() => done('whatsapp'))
        .catch((e) => { if (!(e && e.name === 'AbortError')) { saveFile(f); toast('PDF saved. Attach it in WhatsApp.'); } });
    };
  }
  load();
}

/* A bill as a real A4 PDF, drawn from the same paper the screen shows. It is laid out in a hidden 794px-wide frame
   (so a phone gets the desktop layout, as in print), turned into an image by vendor/html-to-image.js, cut into A4
   pages between table rows, and wrapped in a small PDF (one JPEG per page). */
async function docPdf(d) {
  const fr = document.createElement('iframe');
  fr.setAttribute('aria-hidden', 'true'); fr.tabIndex = -1;
  fr.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
  document.body.appendChild(fr);
  try {
    const css = ($('link[rel=stylesheet][href*="app.css"]') || {}).href || '/app.css';
    const doc = fr.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${esc(css)}"><script src="/vendor/html-to-image.js"><\/script>
      <style>html,body{margin:0;background:#fff}#p{padding:0}.doc-paper{border:0;border-radius:0;box-shadow:none}.no-print{display:none!important}</style></head>
      <body><div id="p">${docPaper(d)}</div></body></html>`);
    doc.close();
    const w = fr.contentWindow, t0 = Date.now();
    while (!(w.htmlToImage && [...doc.styleSheets].some((s) => (s.href || '').includes('app.css')))) {
      if (Date.now() - t0 > 15000) throw new Error('PDF could not be made. Check the internet and try again.');
      await new Promise((ok) => setTimeout(ok, 50));
    }
    const o = d.org || ME.org, q = doc.getElementById('upiqr');
    if (q && d.type === 'INV' && o.upi_id && d.balance > 0 && (!o.print || o.print.show_upi !== false)) await upiQr(q, o, d.balance, d.number, 'Scan to pay with any UPI app');
    await Promise.all([...doc.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    const node = doc.getElementById('p'), top = node.getBoundingClientRect().top, W = node.offsetWidth, H = node.offsetHeight;
    // places where a page may end: under a table row or under a block of the paper
    const cuts = [...new Set([...node.querySelectorAll('tr, .doc-paper > *')].map((e) => Math.round(e.getBoundingClientRect().bottom - top)))]
      .filter((y) => y > 0 && y < H).sort((a, b) => a - b);
    const canvas = await w.htmlToImage.toCanvas(node, { pixelRatio: 1.75, backgroundColor: '#ffffff', skipFonts: true, width: W, height: H });
    const k = canvas.width / W, pageH = Math.floor((W * (PDF_H - 2 * PDF_M)) / (PDF_W - 2 * PDF_M)), pages = [];
    for (let y = 0; y < H - 2;) {
      let end = Math.min(H, y + pageH);
      if (end < H) { const c = cuts.filter((x) => x > y + pageH * 0.5 && x <= end).pop(); if (c) end = c; }
      const pc = document.createElement('canvas');
      pc.width = canvas.width; pc.height = Math.max(1, Math.round((end - y) * k));
      const g = pc.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, pc.width, pc.height);
      g.drawImage(canvas, 0, Math.round(y * k), pc.width, pc.height, 0, 0, pc.width, pc.height);
      const blob = await new Promise((ok) => pc.toBlob(ok, 'image/jpeg', 0.85));
      pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: pc.width, h: pc.height });
      y = end;
    }
    return new File([jpegPdf(pages)], `${String(d.number).replace(/[^\w.-]+/g, '-')}.pdf`, { type: 'application/pdf' });
  } finally { fr.remove(); }
}
/* pages: [{ bytes (JPEG), w, h }] -> PDF bytes, one A4 page each, the image across the width inside the margins */
const PDF_W = 595.28, PDF_H = 841.89, PDF_M = 24;
/* size: { w, h, m } in points for another page size (a 4 × 6 inch label is 288 × 432, no margin) */
function jpegPdf(pages, size = null) {
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const A4W = size ? size.w : PDF_W, A4H = size ? size.h : PDF_H, M = size ? size.m : PDF_M, n = pages.length;
  put('%PDF-1.4\n');
  const obj = (id, body, stream) => {
    offs[id] = len;
    put(`${id} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((p, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((p, i) => {
    const iw = A4W - 2 * M, ih = Math.min(A4H - 2 * M, (iw * p.h) / p.w);
    const id = 3 + i * 3, draw = enc.encode(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${M} ${(A4H - M - ih).toFixed(2)} cm /Im0 Do Q`);
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4W} ${A4H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    obj(id + 1, `<< /Length ${draw.length} >>`, draw);
    obj(id + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes);
  });
  const xref = len, count = 3 + n * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n${offs.slice(1, count).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0; for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

function sendEntry(r, after) {
  sendDialog({
    title: 'Send to customer to save this entry', lang: r.lang,
    intro: '<p class="muted">The entry is added to the khata only after it is sent, so the customer always knows. They get a link to see and confirm it.</p>',
    load: async (l) => (!l || l === r.lang ? r : GET(`/api/khata/entries/${r.entry_id}/message?lang=${l}`)),
    sent: async (via) => { await POST(`/api/khata/entries/${r.entry_id}/send`, { via }); toast('Entry sent and saved'); },
    later: 'Later (keep as not sent)', closed: () => { if (after) after(); else render(); },
  });
}

route(/^khata\/(\d+)$/, async (el, m, q) => {
  const k = await GET('/api/khata/' + m[1]);
  const reversed = new Set(k.rows.filter((r) => r.reverses).map((r) => r.reverses));
  const status = (r) => r.status === 'pending' ? '<span class="badge b-partial">not sent: does not count</span>'
    : `<span class="muted">✓ ${r.sent_via === 'sms' ? 'SMS' : r.sent_via === 'whatsapp' ? 'WhatsApp' : 'sent'}${r.sent_at ? ' ' + new Date(r.sent_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
       ${r.ack === 'confirmed' ? ' <span class="badge b-paid">customer confirmed</span>' : r.ack === 'disputed' ? ` <span class="badge b-unpaid">customer disputed</span>${r.ack_note ? `<div class="neg">“${esc(r.ack_note)}”</div>` : ''}` : ''}
       ${reversed.has(r.id) ? ' <span class="badge">reversed</span>' : ''}`;
  el.innerHTML = head(esc(k.party.name), `<a class="btn" href="#/khata">All contacts</a>`) + `
    <div class="kpis"><div class="kpi"><div class="l">${k.balance >= 0 ? 'You will get' : 'You will give'}</div><div class="v ${k.balance >= 0 ? 'pos' : 'neg'}">${inr(Math.abs(k.balance))}</div>
      <div class="s">${esc(k.party.phone || 'No mobile number saved')}</div></div></div>
    <div class="khata-btns"><button class="btn gave" data-k="gave">You gave ₹</button><button class="btn got" data-k="got">You got ₹</button></div>
    <div id="vaada-box"></div>
    <div class="row" style="margin:12px 0"><button class="btn" id="wa">WhatsApp reminder</button><button class="btn" id="sms">SMS reminder</button><button class="btn" id="share">Copy customer's khata link</button>${ME.can.khata ? '<button class="btn" id="unshare">Stop sharing link</button>' : ''}</div>
    <div class="panel flush kl">${k.rows.length ? k.rows.map((r) => `<div class="ke ${r.status}">
        <div class="kl-l"><b>${fdate(r.date)}</b>${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}<div class="ks">${status(r)}</div></div>
        <div class="kl-r"><div class="${r.kind === 'gave' ? 'neg' : 'pos'} ka">${r.kind === 'gave' ? 'You gave ' : 'You got '}${inr(r.amount)}</div>
          ${r.status === 'sent' ? `<div class="muted">Bal ${inr(r.balance)}</div>` : ''}
          <div class="kact">${r.status === 'pending' ? `<button class="btn sm primary" data-send="${r.id}">Send</button><button class="btn sm danger" data-del="${r.id}">Discard</button>`
            : (reversed.has(r.id) || r.reverses || limits().no_cancel ? '' : `<button class="btn sm" data-rev="${r.id}">Reverse</button>`)}</div></div></div>`).join('') : '<div class="empty">No entries yet.</div>'}</div>`;
  const entry = (kind, amount = '') => modal(kind === 'gave' ? 'You gave' : 'You got', [{ k: 'amount', label: 'Amount (₹)', type: 'number', required: true, value: amount },
    { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'note', label: 'Note (items, reason)', wide: true }],
  async (v) => { const r = await POST('/api/khata', { ...v, party_id: k.party.id, kind }); setTimeout(() => sendEntry(r), 0); }, { submit: 'Next: send to customer' });
  $$('[data-k]', el).forEach((b) => b.onclick = () => entry(b.dataset.k));
  vaadaParty($('#vaada-box'), k.party.id, 'khata');
  if (q && q.get('got')) { history.replaceState(null, '', '#/khata/' + k.party.id); entry('got', q.get('got')); }
  $$('[data-send]', el).forEach((b) => b.onclick = async () => sendEntry(await GET(`/api/khata/entries/${b.dataset.send}/message`)));
  $$('[data-del]', el).forEach((b) => b.onclick = async () => { if (confirm('Discard this unsent entry?')) { await api('DELETE', '/api/khata/entries/' + b.dataset.del); render(); } });
  $$('[data-rev]', el).forEach((b) => b.onclick = () => modal('Reverse this entry', [{ k: 'reason', label: 'Reason (sent to the customer)', wide: true }],
    async (v) => { const r = await POST(`/api/khata/entries/${b.dataset.rev}/reverse`, v); setTimeout(() => sendEntry(r), 0); },
    { submit: 'Next: send correction', intro: '<p class="muted">Sent entries stay on record. A correction entry with the opposite amount is added and sent to the customer.</p>' }));
  const rem = () => sendDialog({ title: `Reminder to ${k.party.name}`, lang: k.party.lang, load: (l) => GET(`/api/khata/${k.party.id}/reminder?lang=${l}`) });
  $('#wa').onclick = rem; $('#sms').onclick = rem;
  $('#share').onclick = async () => { try { await navigator.clipboard.writeText(k.statement_url); toast('Link copied'); } catch (e) { prompt('Copy this link:', k.statement_url); } };
  if ($('#unshare')) $('#unshare').onclick = async () => {
    if (!confirm('Stop sharing this khata? The link already sent to the customer will stop working. Copying the link again makes a new one.')) return;
    try { await POST(`/api/khata/${k.party.id}/revoke-link`); toast('Link turned off'); render(); } catch (e) { toast(e.message, 'err'); }
  };
});

/* ======================================================================= the customer's pages: their language
   The shop picks it when sending; the link carries it (?l=en / ?l=hi, no mark = Hinglish). */
const PT = {
  en: { pay: (a) => `Pay ${a} by UPI`, dl: 'Download PDF', making: 'Making PDF…', balDue: (a, by) => `Balance due <b>${a}</b>${by ? ` by ${by}` : ''}.`,
    sharedBy: (n) => `Shared by ${esc(n)} using SmartTrader ERP.`, badLink: 'Link not valid', offline: 'You are offline', offDoc: 'Connect to the internet to see this document.',
    howPay: 'How to pay', cashOrUpi: (n) => `Pay ${esc(n)} in cash or ask for their UPI ID.`, opens: 'Opens Google Pay, PhonePe, Paytm or any UPI app.', copy: 'Copy', copied: 'UPI ID copied',
    callShop: 'Call shop', waShop: 'WhatsApp shop', waShopText: (n, a) => `Hello, I want to pay ${a} to ${n}.`, scanOther: 'Paying from another phone? Scan this',
    khFrom: 'Khata statement from', khNone: 'Khata not found', offKh: 'Connect to the internet to see your khata.', youPay: 'you have to pay', yourAdv: 'your advance', khIs: 'your khata is',
    settled: 'Settled ✓', youOk: '✓ you confirmed', youNo: 'you said this is wrong', isOk: 'Is this correct?', yes: 'Yes', no: 'No', udhaar: 'Credit ', paidK: 'Paid ', bal: 'Bal',
    noEntries: 'No entries yet.', khFoot: 'Entries cannot be deleted by the shop. Any correction appears here as a new entry. Powered by SmartTrader.',
    whatWrong: 'What is wrong with this entry? (the shop will see this)', notSaved: 'Could not save',
    cfFrom: 'Balance confirmation from', cfDue: (p, d) => `${esc(p)}, your balance due as on ${d}`, cfCols: ['Bill', 'Date', 'Due by', 'Amount due'], cfAsk: 'Is this balance correct?',
    cfYes: '✓ Yes, correct', cfNo: '✗ Something is wrong', cfWhich: 'Which bill?', cfAll: 'All / not sure', cfWhat: 'What is wrong?', cfPh: 'e.g. 2 boxes short in the last bill',
    cfSend: (o) => `Send to ${esc(o)}`, back: 'Back', cfOk: (d) => `✓ You confirmed this balance on ${d}. Thank you!`,
    cfBad: (o, d, n) => `You told ${esc(o)} on ${d} that something is wrong: “${esc(n)}”. They will check and get back to you.`,
    cfNote: 'Your answer is saved with the date and time. Only the shop sees it.', cfWrite: 'Please write what is wrong.', cfGone: 'This link is not valid any more.',
    vAsk: 'When will you pay?', vAskP: 'Pick a date and the shop will know. No interest.', vPriv: (n) => `Only ${esc(n)} sees your promise.`, vDateB: '📅 I will pick a date', vPlanB: '🧾 I will pay in instalments',
    vYours: 'Your promise', vSum: (a, d, link) => `<b>${a}</b> · by ${d} · ${link ? 'from your link' : 'noted by the shop'}`, vPaid: 'Paid so far', vChange: 'Change the date (only once)',
    vCall: (t) => `Need to change the date? ${t ? `Call ${t}.` : 'Talk to the shop.'}`, kKept: '✓ Paid on time', kBroken: '✗ Missed', kDue: 'Last day today', kOpen: (d) => `Due · ${d}`,
    vWhen: 'By which date will you pay?', vDays: ['Today', 'Tomorrow', 'Day after'], vMore: 'Other date…', vHow: 'How much will you pay?', vFull: (a) => `All ${a}`, vPart: 'Part of it',
    vMin: (a) => `At least ${a}`, vName: 'Your name (optional)', vConsent: (n, b) => `When you tap '${b}', the date, amount and name are saved with ${esc(n)}.`, vGo: 'Confirm promise', vBack: 'Back',
    vPick: 'Pick a date.', vMinErr: (a) => `Promise at least ${a}.`, vHowMany: 'In how many instalments?', vPlanLine: (a, n, f, l) => `${a} × ${n} · first ${f}, last ${l}`,
    vLastK: (a) => `Last instalment ${a} (the remainder is added to it)`, vPlanGo: 'Confirm instalments', vTooMany: 'Too many tries today. Please try again tomorrow.', vFail: 'Not saved. Please try again.',
    vDone: '✅ <b>Promise confirmed!</b>', vByAmt: (d, a) => `<b>${a}</b> by ${d}`, vTell: 'Tell the shop on WhatsApp', vAuto: 'When you pay, this promise is marked done by itself.', vOk: 'OK',
    plans: { '2f': '2 instalments · every 15 days', '4w': '4 instalments · every week', '3m': '3 instalments · every month', '6w': '6 instalments · every week', '6m': '6 instalments · every month' } },
  hi: { pay: (a) => `${a} UPI से भुगतान करें`, dl: 'PDF डाउनलोड करें', making: 'PDF बन रही है…', balDue: (a, by) => `बकाया <b>${a}</b>${by ? `, ${by} तक` : ''}।`,
    sharedBy: (n) => `${esc(n)} ने SmartTrader ERP से भेजा।`, badLink: 'लिंक मान्य नहीं है', offline: 'आप ऑफ़लाइन हैं', offDoc: 'यह दस्तावेज़ देखने के लिए इंटरनेट चालू करें।',
    howPay: 'भुगतान कैसे करें', cashOrUpi: (n) => `${esc(n)} को नकद दें या उनका UPI ID माँगें।`, opens: 'Google Pay, PhonePe, Paytm या कोई भी UPI ऐप खुलेगा।', copy: 'कॉपी', copied: 'UPI ID कॉपी हो गया',
    callShop: 'दुकान को कॉल करें', waShop: 'दुकान को WhatsApp करें', waShopText: (n, a) => `नमस्ते, मुझे ${n} को ${a} का भुगतान करना है।`, scanOther: 'दूसरे फ़ोन से भुगतान? इसे स्कैन करें',
    khFrom: 'खाता विवरण', khNone: 'खाता नहीं मिला', offKh: 'अपना खाता देखने के लिए इंटरनेट चालू करें।', youPay: 'आपको देना है', yourAdv: 'आपका एडवांस', khIs: 'आपका खाता',
    settled: 'साफ़ ✓', youOk: '✓ आपने पुष्टि की', youNo: 'आपने इसे गलत बताया', isOk: 'क्या यह सही है?', yes: 'हाँ', no: 'नहीं', udhaar: 'उधार ', paidK: 'भुगतान ', bal: 'बकाया',
    noEntries: 'अभी कोई एंट्री नहीं।', khFoot: 'दुकानदार एंट्री मिटा नहीं सकता। हर सुधार यहाँ नई एंट्री के रूप में दिखेगा। SmartTrader द्वारा।',
    whatWrong: 'इस एंट्री में क्या गलत है? (दुकानदार इसे देखेगा)', notSaved: 'सेव नहीं हुआ',
    cfFrom: 'बकाया पुष्टि', cfDue: (p, d) => `${esc(p)}, ${d} तक आपका बकाया`, cfCols: ['बिल', 'तारीख', 'देय तिथि', 'बकाया राशि'], cfAsk: 'क्या यह बकाया सही है?',
    cfYes: '✓ हाँ, सही है', cfNo: '✗ कुछ गलत है', cfWhich: 'कौन सा बिल?', cfAll: 'सभी / पता नहीं', cfWhat: 'क्या गलत है?', cfPh: 'जैसे पिछले बिल में 2 डिब्बे कम आए',
    cfSend: (o) => `${esc(o)} को भेजें`, back: 'वापस', cfOk: (d) => `✓ आपने ${d} को इस बकाया की पुष्टि की। धन्यवाद!`,
    cfBad: (o, d, n) => `आपने ${d} को ${esc(o)} को बताया कि कुछ गलत है: “${esc(n)}”। वे जाँच कर आपसे संपर्क करेंगे।`,
    cfNote: 'आपका जवाब तारीख और समय के साथ सेव होता है। इसे सिर्फ़ दुकानदार देखता है।', cfWrite: 'कृपया लिखें कि क्या गलत है।', cfGone: 'यह लिंक अब मान्य नहीं है।',
    vAsk: 'कब तक देंगे?', vAskP: 'तारीख चुनें, दुकानदार को पता चल जाएगा। कोई ब्याज नहीं।', vPriv: (n) => `आपका वादा सिर्फ़ ${esc(n)} को दिखेगा।`, vDateB: '📅 मैं तारीख चुनता हूँ', vPlanB: '🧾 किस्तों में दूँगा',
    vYours: 'आपका वादा', vSum: (a, d, link) => `<b>${a}</b> · ${d} तक · ${link ? 'लिंक से' : 'दुकान ने लिखा'}`, vPaid: 'अब तक मिला', vChange: 'तारीख बदलें (सिर्फ़ एक बार)',
    vCall: (t) => `तारीख बदलनी है? ${t ? `${t} पर बात करें।` : 'दुकान से बात करें।'}`, kKept: '✓ समय पर मिला', kBroken: '✗ छूट गया', kDue: 'आज आखिरी दिन', kOpen: (d) => `बाकी · ${d}`,
    vWhen: 'किस तारीख तक देंगे?', vDays: ['आज', 'कल', 'परसों'], vMore: 'दूसरी तारीख…', vHow: 'कितना देंगे?', vFull: (a) => `पूरा ${a}`, vPart: 'कुछ हिस्सा',
    vMin: (a) => `कम से कम ${a}`, vName: 'आपका नाम (ज़रूरी नहीं)', vConsent: (n, b) => `'${b}' दबाने पर तारीख, रकम और नाम ${esc(n)} के पास सेव होंगे।`, vGo: 'वादा पक्का करें', vBack: 'वापस',
    vPick: 'तारीख चुनें।', vMinErr: (a) => `कम से कम ${a} का वादा करें।`, vHowMany: 'कितनी किस्तों में?', vPlanLine: (a, n, f, l) => `${a} × ${n} · पहली ${f}, आखिरी ${l}`,
    vLastK: (a) => `आखिरी किस्त ${a} (बची रकम उसमें जुड़ती है)`, vPlanGo: 'किस्तें पक्की करें', vTooMany: 'आज बहुत बार कोशिश हुई। कल फिर कोशिश करें।', vFail: 'सेव नहीं हुआ। फिर कोशिश करें।',
    vDone: '✅ <b>वादा पक्का!</b>', vByAmt: (d, a) => `${d} तक <b>${a}</b>`, vTell: 'दुकान को WhatsApp पर बताएँ', vAuto: 'भुगतान करते ही यह वादा अपने आप पूरा हो जाएगा।', vOk: 'ठीक है',
    plans: { '2f': '2 किस्त · हर 15 दिन', '4w': '4 किस्त · हर हफ़्ते', '3m': '3 किस्त · हर महीने', '6w': '6 किस्त · हर हफ़्ते', '6m': '6 किस्त · हर महीने' } },
  hl: { pay: (a) => `${a} UPI se pay karein`, dl: 'PDF download karein', making: 'PDF ban rahi hai…', balDue: (a, by) => `Baaki <b>${a}</b>${by ? `, ${by} tak` : ''}.`,
    sharedBy: (n) => `${esc(n)} ne SmartTrader ERP se bheja.`, badLink: 'Link valid nahi hai', offline: 'Aap offline hain', offDoc: 'Ye document dekhne ke liye internet chalu karein.',
    howPay: 'Pay kaise karein', cashOrUpi: (n) => `${esc(n)} ko cash dein ya unka UPI ID maangein.`, opens: 'Google Pay, PhonePe, Paytm ya koi bhi UPI app khulega.', copy: 'Copy', copied: 'UPI ID copy ho gaya',
    callShop: 'Shop ko call karein', waShop: 'Shop ko WhatsApp karein', waShopText: (n, a) => `Namaste, maine ${n} ka ${a} ka payment karna hai.`, scanOther: 'Doosre phone se pay? Ise scan karein',
    khFrom: 'Khata statement', khNone: 'Khata nahi mila', offKh: 'Khata dekhne ke liye internet chalu karein.', youPay: 'aapko dena hai', yourAdv: 'aapka advance', khIs: 'aapka khata',
    settled: 'Clear ✓', youOk: '✓ aapne confirm kiya', youNo: 'aapne galat bataya', isOk: 'Kya ye sahi hai?', yes: 'Haan', no: 'Nahi', udhaar: 'Udhaar ', paidK: 'Paid ', bal: 'Bal',
    noEntries: 'Abhi koi entry nahi.', khFoot: 'Shop entries delete nahi kar sakta. Har sudhaar yahan nayi entry ki tarah dikhega. Powered by SmartTrader.',
    whatWrong: 'Is entry mein kya galat hai? (shop ise dekhega)', notSaved: 'Save nahi hua',
    cfFrom: 'Balance confirmation', cfDue: (p, d) => `${esc(p)}, ${d} tak aapka baaki`, cfCols: ['Bill', 'Date', 'Due date', 'Baaki'], cfAsk: 'Kya ye baaki sahi hai?',
    cfYes: '✓ Haan, sahi hai', cfNo: '✗ Kuch galat hai', cfWhich: 'Kaunsa bill?', cfAll: 'Sabhi / pata nahi', cfWhat: 'Kya galat hai?', cfPh: 'jaise pichhle bill mein 2 box kam aaye',
    cfSend: (o) => `${esc(o)} ko bhejein`, back: 'Wapas', cfOk: (d) => `✓ Aapne ${d} ko ye baaki confirm kiya. Dhanyavaad!`,
    cfBad: (o, d, n) => `Aapne ${d} ko ${esc(o)} ko bataya ki kuch galat hai: “${esc(n)}”. Woh check karke aapse baat karenge.`,
    cfNote: 'Aapka jawaab date aur time ke saath save hota hai. Ise sirf shop dekhta hai.', cfWrite: 'Kripya likhein kya galat hai.', cfGone: 'Ye link ab valid nahi hai.',
    vAsk: 'Kab tak denge?', vAskP: 'Tareekh chunein, shop ko pata chal jayega. Koi byaaj nahi.', vPriv: (n) => `Aapka vaada sirf ${esc(n)} ko dikhega.`, vDateB: '📅 Main tareekh chunta hoon', vPlanB: '🧾 Kisht mein dunga',
    vYours: 'Aapka vaada', vSum: (a, d, link) => `<b>${a}</b> · ${d} tak · ${link ? 'link se' : 'shop ne likha'}`, vPaid: 'Ab tak mila', vChange: 'Tareekh badlein (sirf ek baar)',
    vCall: (t) => `Tareekh badalni hai? ${t ? `${t} par baat karein.` : 'Shop se baat karein.'}`, kKept: '✓ Samay par mila', kBroken: '✗ Chhoot gaya', kDue: 'Aaj aakhri din', kOpen: (d) => `Baaki · ${d}`,
    vWhen: 'Kis tareekh tak denge?', vDays: ['Aaj', 'Kal', 'Parson'], vMore: 'Aur tareekh…', vHow: 'Kitna denge?', vFull: (a) => `Poora ${a}`, vPart: 'Kuch hissa',
    vMin: (a) => `Kam se kam ${a}`, vName: 'Aapka naam (zaroori nahi)', vConsent: (n, b) => `'${b}' dabane par tareekh, rakam aur naam ${esc(n)} ke paas save honge.`, vGo: 'Vaada pakka karein', vBack: 'Wapas',
    vPick: 'Tareekh chunein.', vMinErr: (a) => `Kam se kam ${a} ka vaada karein.`, vHowMany: 'Kitni kisht mein?', vPlanLine: (a, n, f, l) => `${a} × ${n} · pehli ${f}, aakhri ${l}`,
    vLastK: (a) => `Aakhri kisht ${a} (bachi rakam usme judti hai)`, vPlanGo: 'Kisht pakki karein', vTooMany: 'Aaj bahut baar koshish hui. Kal dobara try karein.', vFail: 'Save nahi hua. Dobara try karein.',
    vDone: '✅ <b>Vaada pakka!</b>', vByAmt: (d, a) => `${d} tak <b>${a}</b>`, vTell: 'Shop ko WhatsApp par batayein', vAuto: 'Paisa dene par ye vaada apne aap poora ho jayega.', vOk: 'Theek hai',
    plans: null },
};
let PUBL = 'hl';
const PT_DOC_HI = { INV: 'बिल', SRET: 'बिक्री वापसी', CNOTE: 'क्रेडिट नोट', QUOTE: 'कोटेशन', SO: 'सेल्स ऑर्डर', DN: 'डिलीवरी चालान' };
const pubLang = () => { const l = new URLSearchParams(location.search).get('l'); PUBL = PT[l] ? l : 'hl'; document.documentElement.lang = PUBL === 'hi' ? 'hi' : 'en'; return PUBL; };
const pt = (k, ...a) => { const v = PT[PUBL][k] ?? PT.en[k]; return typeof v === 'function' ? v(...a) : v; };

/* The customer's view of an invoice / quotation (/i/<token>): print or save as PDF, pay by UPI. */
async function publicDoc(token) {
  const app = $('#app');
  pubLang();
  try {
    const res = await fetch('/api/public/doc/' + token);
    const d = await res.json();
    if (!res.ok) { app.innerHTML = `<div class="boot"><h2>${pt('badLink')}</h2><p class="muted">${esc(d.error || '')}</p></div>`; return; }
    const due = d.type === 'INV' && d.balance > 0;
    app.innerHTML = `<main class="page pub pubdoc"><div class="page-head no-print"><h1>${esc((PUBL === 'hi' && PT_DOC_HI[d.type]) || d.label)} ${esc(d.number)}</h1>${d.type === 'INV' ? badge(d.status) : ''}<span class="spacer"></span>
        ${due && d.org.upi_id ? `<a class="btn got" href="${esc(upiLink(d.org.upi_id, d.org.name, d.balance, d.number))}">${pt('pay', inr(d.balance))}</a>` : ''}
        <button class="btn primary" id="pdfdl">${pt('dl')}</button></div>
      ${due ? `<div class="panel no-print">${pt('balDue', inr(d.balance), d.due_date ? fdate(d.due_date) : '')}${payBox(d.org, d.balance, d.number)}</div>` : ''}
      ${vaadaPub(d.vaada, d.org)}
      ${docPaper(d)}<p class="muted no-print">${pt('sharedBy', d.org.name)}</p></main>`;
    fitPapers(app);
    // a real PDF file; if this browser cannot make one, its own print dialog ("Save as PDF") still works
    $('#pdfdl').onclick = async (e) => {
      const b = e.currentTarget, t = b.textContent; b.disabled = true; b.textContent = pt('making');
      try { saveFile(await docPdf(d)); } catch (err) { print(); } finally { b.disabled = false; b.textContent = t; }
    };
    if (due) { if (!d.org.print || d.org.print.show_upi !== false) upiQr($('#upiqr'), d.org, d.balance, d.number, 'Scan to pay with any UPI app'); wirePayBox(app, d.org, d.balance, d.number); }
    wireVaadaPub(app, d.vaada, d.org, { path: `/api/public/doc/${token}/vaada`, who: (d.party || {}).name || '', reload: () => publicDoc(token) });
  } catch (e) { app.innerHTML = `<div class="boot"><h2>${pt('offline')}</h2><p class="muted">${pt('offDoc')}</p></div>`; }
}

/* How the customer pays: a UPI button (opens GPay/PhonePe/Paytm on the phone), a QR for paying from another
   phone, and the UPI ID to copy. Without a UPI ID on the shop, call / WhatsApp the shop instead. */
function payBox(shop, amount, note) {
  const phone = String(shop.phone || '').replace(/\D/g, ''), wa = phone.length === 10 ? '91' + phone : phone;
  const contact = phone ? `<div class="row" style="margin-top:10px"><a class="btn" href="tel:${esc(phone)}">${pt('callShop')}</a>
      <a class="btn" href="https://api.whatsapp.com/send?phone=${esc(wa)}&text=${encodeURIComponent(pt('waShopText', shop.name, inr(amount)))}">${pt('waShop')}</a></div>` : '';
  if (!shop.upi_id) return `<div class="paybox"><b>${pt('howPay')}</b><p class="muted" style="margin:4px 0 0">${pt('cashOrUpi', shop.name)}</p>${contact}</div>`;
  return `<div class="paybox"><a class="btn got big" href="${esc(upiLink(shop.upi_id, shop.name, amount, note))}">${pt('pay', inr(amount))}</a>
    <div class="muted" style="margin:6px 0">${pt('opens')}</div>
    <div class="row"><span>UPI ID: <b>${esc(shop.upi_id)}</b></span><button class="btn sm" type="button" data-copyupi="${esc(shop.upi_id)}">${pt('copy')}</button></div>
    <div data-payqr style="margin-top:10px"></div>${contact}</div>`;
}
function wirePayBox(root, shop, amount, note) {
  $$('[data-copyupi]', root).forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyupi); toast(pt('copied')); } catch (e) { prompt('UPI ID:', b.dataset.copyupi); } });
  const q = $('[data-payqr]', root);
  if (q && shop.upi_id) upiQr(q, shop, amount, note, pt('scanOther'));
}

/* The customer's private statement page (#/k/<token>): no login, read-only, confirm or dispute entries. */
async function publicKhata(token) {
  const app = $('#app');
  pubLang();
  const load = async () => {
    const res = await fetch('/api/public/khata/' + token);
    const d = await res.json();
    if (!res.ok) { app.innerHTML = `<div class="boot"><h2>${pt('khNone')}</h2><p class="muted">${esc(d.error || '')}</p></div>`; return; }
    app.innerHTML = `<main class="page pub"><div class="panel"><div class="muted">${pt('khFrom')}</div><h1>${esc(d.shop.name)}</h1>
        <div class="muted">${[d.shop.address, d.shop.phone].filter(Boolean).map(esc).join(' &middot; ')}</div></div>
      <div class="kpi" style="margin-bottom:14px"><div class="l">${esc(d.customer)}, ${pt(d.balance > 0 ? 'youPay' : d.balance < 0 ? 'yourAdv' : 'khIs')}</div>
        <div class="v ${d.balance > 0 ? 'neg' : 'pos'}">${d.balance === 0 ? pt('settled') : inr(Math.abs(d.balance))}</div>
        ${d.balance > 0 ? payBox(d.shop, d.balance, 'Khata') : ''}</div>
      ${vaadaPub(d.vaada, d.shop)}
      <div class="panel flush kl">${d.rows.length ? d.rows.map((r) => `<div class="ke">
        <div class="kl-l"><b>${fdate(r.date)}</b>${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
          <div class="ks">${r.ack === 'confirmed' ? `<span class="badge b-paid">${pt('youOk')}</span>` : r.ack === 'disputed' ? `<span class="badge b-unpaid">${pt('youNo')}</span>`
            : `<span class="muted">${pt('isOk')}</span> <button class="btn sm got" data-ok="${r.id}">${pt('yes')}</button> <button class="btn sm danger" data-no="${r.id}">${pt('no')}</button>`}</div></div>
        <div class="kl-r"><div class="${r.kind === 'gave' ? 'neg' : 'pos'} ka">${pt(r.kind === 'gave' ? 'udhaar' : 'paidK')}${inr(r.amount)}</div><div class="muted">${pt('bal')} ${inr(r.balance)}</div></div></div>`).join('')
        : `<div class="empty">${pt('noEntries')}</div>`}</div>
      <p class="muted">${pt('khFoot')}</p></main>`;
    const ack = async (id, a, note = '') => {
      const r = await fetch(`/api/public/khata/${token}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' }, body: JSON.stringify({ entry_id: +id, ack: a, note }) });
      if (!r.ok) alert((await r.json().catch(() => ({}))).error || pt('notSaved')); else load();
    };
    if (d.balance > 0) wirePayBox(app, d.shop, d.balance, 'Khata');
    wireVaadaPub(app, d.vaada, d.shop, { path: `/api/public/khata/${token}/vaada`, who: d.customer, reload: load });
    $$('[data-ok]').forEach((b) => b.onclick = () => ack(b.dataset.ok, 'confirmed'));
    $$('[data-no]').forEach((b) => b.onclick = () => { const n = prompt(pt('whatWrong')); if (n !== null) ack(b.dataset.no, 'disputed', n); });
  };
  try { await load(); } catch (e) { app.innerHTML = `<div class="boot"><h2>${pt('offline')}</h2><p class="muted">${pt('offKh')}</p></div>`; }
}

/* The customer's monthly balance statement (/c/<token>): every open bill, and one answer: correct, or what is wrong.
   The answer is kept with its time as evidence for both sides. */
async function publicConfirm(token) {
  const app = $('#app');
  pubLang();
  const post = (body) => fetch(`/api/public/confirm/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' }, body: JSON.stringify(body) });
  const load = async () => {
    const res = await fetch('/api/public/confirm/' + token);
    const d = await res.json();
    if (!res.ok) { app.innerHTML = `<div class="boot"><h2>${pt('badLink')}</h2><p class="muted">${esc(d.error || pt('cfGone'))}</p></div>`; return; }
    const C = pt('cfCols'), when = fdate((d.answered_at || '').slice(0, 10));
    const answer = d.status === 'agreed' ? `<div class="panel cf-done ok">${pt('cfOk', when)}</div>`
      : d.status === 'disputed' ? `<div class="panel cf-done bad">${pt('cfBad', d.org.name, when, d.note)}</div>`
      : `<div class="panel cf-ask" id="cfask"><h3>${pt('cfAsk')}</h3><div class="khata-btns"><button class="btn got big" id="cfyes">${pt('cfYes')}</button><button class="btn big" id="cfno">${pt('cfNo')}</button></div>
          <form id="cfform" hidden><label class="f">${pt('cfWhich')}<select name="bill"><option value="">${pt('cfAll')}</option>${d.bills.map((b) => `<option>${esc(b.number)}</option>`).join('')}</select></label>
            <label class="f">${pt('cfWhat')}<textarea name="note" rows="3" maxlength="300" placeholder="${esc(pt('cfPh'))}"></textarea></label><p class="err" hidden></p>
            <div class="actions"><button type="button" class="btn" id="cfback">${pt('back')}</button><button class="btn primary">${pt('cfSend', d.org.name)}</button></div></form>
          <p class="muted small">${pt('cfNote')}</p></div>`;
    app.innerHTML = `<main class="page pub"><div class="panel"><div class="muted">${pt('cfFrom')}</div><h1>${esc(d.org.name)}</h1>${d.org.phone ? `<div class="muted">${esc(d.org.phone)}</div>` : ''}</div>
      <div class="kpi" style="margin-bottom:14px"><div class="l">${pt('cfDue', d.party, fdate(d.as_of))}</div><div class="v neg">${inr(d.balance)}</div></div>
      <div class="panel flush">${table([{ h: C[0], k: 'number' }, { h: C[1], f: (b) => fdate(b.date) }, { h: C[2], f: (b) => fdate(b.due_date || b.date) }, { h: C[3], num: 1, f: (b) => inr(b.bal) }], d.bills)}</div>
      ${answer}${d.balance > 0 ? `<div class="panel">${payBox(d.org, d.balance, 'Balance ' + d.as_of)}</div>` : ''}
      <p class="muted small">Powered by SmartTrader.</p></main>`;
    if (d.balance > 0) wirePayBox(app, d.org, d.balance, 'Balance ' + d.as_of);
    if (d.status !== 'sent') return;
    const send = async (body, btn) => {
      btn.disabled = true;
      try {
        const r = await post(body);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || pt('notSaved'));
        await load();
      } catch (e) { const b = $('#cfform .err'); if (b && !$('#cfform').hidden) { b.hidden = false; b.textContent = e.message; } else alert(e.message); btn.disabled = false; }
    };
    $('#cfyes').onclick = (e) => send({ answer: 'agree' }, e.currentTarget);
    $('#cfno').onclick = () => { $('#cfform').hidden = false; $('#cfyes').parentElement.hidden = true; $('#cfform textarea').focus(); };
    $('#cfback').onclick = () => { $('#cfform').hidden = true; $('#cfyes').parentElement.hidden = false; };
    $('#cfform').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target, note = f.note.value.trim();
      if (!note) { const b = $('.err', f); b.hidden = false; b.textContent = pt('cfWrite'); return; }
      send({ answer: 'dispute', bill: f.bill.value, note }, $('button.primary', f));
    };
  };
  try { await load(); } catch (e) { app.innerHTML = `<div class="boot"><h2>${pt('offline')}</h2><p class="muted">${pt('offDoc')}</p></div>`; }
}

/* ======================================================================= Vaada Pakka (payment promises) + Kal ka Cash
   The customer picks a pay date or instalments on their own link; the shop sees "Aaj ke Vaade", each promise is
   marked kept/broken from the receipts, and the billing screens warn before more udhaar. */
const HI_DAYS = ['Ravi', 'Som', 'Mangal', 'Budh', 'Guru', 'Shukra', 'Shani'];
const HI_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dis'];
const addD = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const dm = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}` : '');
const hiDay = (d) => { const x = new Date(d + 'T00:00:00Z'); return `${HI_DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${HI_MON[x.getUTCMonth()]}`; };
const KSTATE = { kept: ['b-paid', '✓ Samay par mila'], broken: ['b-unpaid', '✗ Chhoot gaya'], due: ['b-partial', 'Aaj aakhri din'] };
const kBadge = (k, pub) => (KSTATE[k.state] ? `<span class="badge ${KSTATE[k.state][0]}">${pub ? pt({ kept: 'kKept', broken: 'kBroken', due: 'kDue' }[k.state]) : KSTATE[k.state][1]}</span>`
  : `<span class="badge">${pub ? pt('kOpen', dmy(k.due)) : `Baaki · ${dmy(k.due)}`}</span>`);
/* a date chip's name on the customer's page: "Ravi 27 Okt" in Hinglish, the browser's own words in English / Hindi */
const pubDay = (d) => (PUBL === 'hl' ? hiDay(d) : new Date(d + 'T00:00:00Z').toLocaleDateString(PUBL === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }));

/* Bottom sheet on phones (the modal pattern), centred dialog on wide screens */
function sheet(html, onClose) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal vsheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const keys = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { if (!root.firstChild) return; root.innerHTML = ''; document.removeEventListener('keydown', keys); if (onClose) onClose(); };
  document.addEventListener('keydown', keys);
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  const S = { el: $('.modal', root), close };
  S.el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) setTimeout(close, 0); });   // after the tap, so a link still opens
  return S;
}
const sheetErr = (S, msg) => { const b = $('.err', S.el); b.hidden = false; b.textContent = msg; b.scrollIntoView({ block: 'nearest' }); };

/* the promise card: the customer's "Aapka vaada" (A5) and the shop's open promise (D) */
function vaadaOpenCard(o, { pub = false, shopPhone = '' } = {}) {
  const last = o.kisht[o.kisht.length - 1], tel = String(shopPhone || '').replace(/[^\d+]/g, '');
  return `<h3>${pub ? pt('vYours') : 'Khula vaada'}${pub ? '' : ` <span class="badge">${o.book === 'inv' ? 'Bill' : 'Khata'}</span>`}</h3>
    <div class="vsum">${pub ? pt('vSum', inr(o.amount), dmy(last.due), o.made_by === 'customer') : `<b>${inr(o.amount)}</b> · ${dmy(last.due)} tak · ${o.made_by === 'customer' ? 'link se' : 'shop ne likha'}`}</div>
    <div class="klist">${o.kisht.map((k) => `<div class="krow"><span>${o.kisht.length > 1 ? `${k.n}. ` : ''}${dmy(k.due)}</span><b class="num">${inr(k.amount)}</b>${kBadge(k, pub)}</div>`).join('')}</div>
    <div class="vpaid">${pub ? pt('vPaid') : 'Ab tak mila'}: <b>${inr(o.paid_since)}</b></div>
    ${!pub ? '' : o.can_change ? `<button class="linkbtn" type="button" data-vchange>${pt('vChange')}</button>`
    : `<p class="muted small">${pt('vCall', tel ? `<a href="tel:${esc(tel)}">${esc(shopPhone)}</a>` : '')}</p>`}`;
}
const vaadaAskBtns = (v) => `<div class="vstack"><button class="btn big" type="button" data-vdate>${pt('vDateB')}</button>
  ${v.options.plans.length ? `<button class="btn big" type="button" data-vplan>${pt('vPlanB')}</button>` : ''}</div>`;

/* Screen A: "Kab tak denge?" on the customer's khata / invoice link */
function vaadaPub(v, shop) {
  if (!v || !v.enabled || !(v.due > 0 || v.open)) return '';
  const inner = v.open ? vaadaOpenCard(v.open, { pub: true, shopPhone: shop.phone })
    : `<h3>${pt('vAsk')}</h3><p class="muted">${pt('vAskP')}</p>${vaadaAskBtns(v)}
       <p class="muted small">${pt('vPriv', shop.name)}</p>`;
  return `<div class="panel vpub no-print" id="vpub">${inner}</div>`;
}
function wireVaadaPub(root, v, shop, ctx) {
  const box = $('#vpub', root);
  if (!box) return;
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-vdate]')) vDateSheet(v, shop, ctx);
    else if (e.target.closest('[data-vplan]')) vPlanSheet(v, shop, ctx);
    else if (e.target.closest('[data-vchange]')) e.target.closest('[data-vchange]').outerHTML = v.due > 0 ? vaadaAskBtns(v) : '';
  });
}
const vConsent = (shop, btn) => `<p class="muted small vconsent">${pt('vConsent', shop.name, btn)}</p>`;
const vNameInput = () => `<label class="f">${pt('vName')}<input id="vname" maxlength="60" autocomplete="name" enterkeyhint="done"></label>`;
function vDateSheet(v, shop, ctx) {
  const t = v.today, max = v.options.max_date, o = v.options, chips = [];
  for (let i = 0; i <= 7; i++) { const d = addD(t, i); if (d > max) break; chips.push([d, pt('vDays')[i] || pubDay(d)]); }
  const partOk = o.part && o.min_amount < v.due;
  let picked = '', done = false;
  const S = sheet(`<h2>${pt('vWhen')}</h2>
    <div class="chips" id="vchips">${chips.map(([d, l]) => `<button type="button" class="chip" data-d="${d}">${l}</button>`).join('')}<button type="button" class="chip" data-more>${pt('vMore')}</button></div>
    <input type="date" id="vdate" min="${t}" max="${max}" hidden aria-label="${pt('vWhen')}">
    <div class="vq"><b>${pt('vHow')}</b>
      <label class="radio"><input type="radio" name="vamt" value="full" checked> ${pt('vFull', inr(v.due))}</label>
      ${partOk ? `<label class="radio"><input type="radio" name="vamt" value="part"> ${pt('vPart')}</label>
        <input type="number" id="vpart" inputmode="decimal" step="any" min="${o.min_amount}" max="${v.due}" placeholder="${pt('vMin', inr0(o.min_amount))}" hidden>` : ''}</div>
    ${vNameInput()}${vConsent(shop, pt('vGo'))}<div class="err" hidden></div>
    <div class="actions"><button type="button" class="btn" data-x>${pt('vBack')}</button><button type="button" class="btn primary" id="vgo">${pt('vGo')}</button></div>`, () => { if (done) ctx.reload(); });
  const el = S.el, di = $('#vdate', el);
  $('#vchips', el).onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    $$('.chip', el).forEach((x) => x.classList.toggle('on', x === b));
    if (b.dataset.more !== undefined) { di.hidden = false; picked = di.value; di.focus(); try { if (di.showPicker) di.showPicker(); } catch (er) { /* not allowed here */ } }
    else { di.hidden = true; picked = b.dataset.d; }
  };
  di.onchange = () => { picked = di.value; };
  $$('[name=vamt]', el).forEach((r) => r.onchange = () => { const p = $('#vpart', el); if (p) { p.hidden = $('[name=vamt]:checked', el).value !== 'part'; if (!p.hidden) p.focus(); } });
  $('#vgo', el).onclick = () => {
    if (!picked) return sheetErr(S, pt('vPick'));
    const body = { kind: 'date', date: picked, name: $('#vname', el).value };
    if (($('[name=vamt]:checked', el) || {}).value === 'part') {
      const a = +$('#vpart', el).value;
      if (!(a > 0)) return sheetErr(S, pt('vMinErr', inr0(o.min_amount)));
      body.amount = a;
    }
    vSubmit(S, body, ctx, () => { done = true; });
  };
}
function vPlanSheet(v, shop, ctx) {
  let done = false;
  const S = sheet(`<h2>${pt('vHowMany')}</h2>
    <div class="vplans">${v.options.plans.map((p, i) => { const n = p.amounts.length, last = p.amounts[n - 1]; return `<label class="vplan"><input type="radio" name="vplan" value="${esc(p.key)}" ${i ? '' : 'checked'}>
      <span><b>${esc((PT[PUBL].plans || {})[p.key] || p.label)}</b><br>${pt('vPlanLine', inr0(p.amounts[0]), n, dmy(p.first), dmy(p.last))}${last !== p.amounts[0] ? `<br><small class="muted">${pt('vLastK', inr(last))}</small>` : ''}</span></label>`; }).join('')}</div>
    ${vNameInput()}${vConsent(shop, pt('vPlanGo'))}<div class="err" hidden></div>
    <div class="actions"><button type="button" class="btn" data-x>${pt('vBack')}</button><button type="button" class="btn primary" id="vgo">${pt('vPlanGo')}</button></div>`, () => { if (done) ctx.reload(); });
  $('#vgo', S.el).onclick = () => vSubmit(S, { kind: 'plan', plan: $('[name=vplan]:checked', S.el).value, name: $('#vname', S.el).value }, ctx, () => { done = true; });
}
async function vSubmit(S, body, ctx, ok) {
  const btn = $('#vgo', S.el); $('.err', S.el).hidden = true; btn.disabled = true;
  try {
    const r = await fetch(ctx.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' }, body: JSON.stringify({ ...body, lang: PUBL }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 429 ? pt('vTooMany') : d.error || pt('vFail'));
    ok();
    const o = d.vaada, last = o.kisht[o.kisht.length - 1];
    S.el.innerHTML = `<div class="vok"><div class="vok-h">${pt('vDone')}</div>
      ${o.kisht.length > 1 ? `<div class="klist">${o.kisht.map((k) => `<div class="krow"><span>${k.n}. ${dmy(k.due)}</span><b class="num">${inr(k.amount)}</b></div>`).join('')}</div>`
    : `<p class="vok-a">${pt('vByAmt', dmy(last.due), inr(o.amount))}</p>`}
      ${d.shop_whatsapp_url ? `<a class="btn got big" href="${esc(d.shop_whatsapp_url)}" target="_blank" rel="noopener">${pt('vTell')}</a>` : ''}
      <p class="muted small">${pt('vAuto')}</p></div>
      <div class="actions"><button type="button" class="btn primary" data-x>${pt('vOk')}</button></div>`;
  } catch (e) { sheetErr(S, e.message); btn.disabled = false; }
}

/* Screen B: dashboard card */
function vaadaCard(vs) {
  if (!vs || vs.today_n + vs.broken_n <= 0) return '';
  return `<a class="panel vcard" href="#/vaade"><div class="vcard-h"><h3>Aaj ke Vaade</h3><span aria-hidden="true">›</span></div>
    <div class="vcard-k"><b>${vs.today_n}</b> aane hain · <b>${inr0(vs.today_amount)}</b></div>
    ${vs.broken_n > 0 ? `<div class="neg">${vs.broken_n} vaade toote, yaad dilayein</div>` : ''}
    ${vs.free_cap ? '<div class="muted small">10 se zyada vaade ke liye Starter plan lein</div>' : ''}</a>`;
}

/* WhatsApp reminder through the existing reminder routes (they now carry the promise) */
async function remindParty(pid, book) {
  const w = window.open('', '_blank');
  try {
    const r = await GET(book === 'khata' ? `/api/khata/${pid}/reminder` : `/api/parties/${pid}/reminder`);
    if (w) w.location = r.whatsapp_url; else location.href = r.whatsapp_url;
  } catch (e) { if (w) w.close(); toast(e.message, 'err'); }
}
async function cancelVaada(id, after) {
  const reason = prompt('Vaada kyun radd kar rahe hain?');
  if (reason === null) return;
  try { await POST(`/api/vaade/${id}/cancel`, { reason }); toast('Vaada radd hua'); after(); } catch (e) { toast(e.message, 'err'); }
}

/* Screen C: #/vaade */
const vRecord = (r) => (r.kept + r.broken
  ? `<span class="badge ${r.pct >= 80 ? 'b-paid' : r.pct >= 50 ? 'b-partial' : 'b-unpaid'}">Vaade nibhaye: ${r.kept}/${r.kept + r.broken}</span>` : '<span class="badge">Pehla vaada</span>');
function vRow(r, i) {
  const when = r.state === 'done' ? 'Poora hua' : r.due === ME.today ? 'Aaj' : `${dm(r.due)} tak`;
  const amt = r.due_amount > 0 ? r.due_amount : r.kamount;
  return `<div class="vrow" data-i="${i}">
    <div class="vr1"><a href="#/${r.book === 'khata' ? 'khata' : 'party'}/${r.party_id}"><b>${esc(r.name)}</b></a><b class="num">${inr0(amt)}</b></div>
    <div class="vr2 muted">${when} · ${r.of > 1 ? `kisht ${r.n}/${r.of}` : 'poora'} <span class="chip-s">${r.made_by === 'customer' ? 'Link se' : 'Phone par'}</span><span class="chip-s">${r.book === 'khata' ? 'Khata' : 'Bill'}</span>${r.state === 'broken' ? '<span class="badge b-unpaid">Toota</span>' : ''}</div>
    <div class="vr3">${vRecord(r)}</div>
    <div class="vr4">${r.status === 'done' && r.state !== 'broken' ? '' : '<button class="btn sm got" data-rem>Yaad dilayein</button>'}
      ${r.status === 'done' ? '' : '<button class="btn sm" data-paid>Paisa mila</button>'}
      ${r.status === 'open' && ME.can.khata ? '<details class="more-menu"><summary class="btn sm" aria-label="Aur">⋯</summary><div class="menu"><button class="btn danger" data-cancel>Vaada radd karein</button></div></details>' : ''}</div></div>`;
}
route(/^vaade$/, async (el, m, q) => {
  const view = ['today', 'upcoming', 'broken', 'all'].includes(q.get('v')) ? q.get('v') : 'today';
  const d = await GET('/api/vaade?view=' + view);
  const tabs = [['today', 'Aaj'], ['upcoming', 'Aane wale'], ['broken', 'Toote'], ['all', 'Sab']];
  el.innerHTML = head('Vaade <span class="muted h-sub">(Payment promises)</span>', '<a class="btn" href="#/reminders">Reminders</a>') + `
    <div class="seg s4 vtabs" role="tablist">${tabs.map(([k, t]) => `<button type="button" role="tab" aria-selected="${k === view}" data-v="${k}" class="${k === view ? 'on' : ''}">${t}${d.counts[k] ? ` <span class="cnt">${d.counts[k]}</span>` : ''}</button>`).join('')}</div>
    ${d.summary.free_cap ? '<div class="panel warnbox">10 se zyada khule vaade ke liye <a href="#/plan">Starter plan</a> lein. Tab tak grahak naya vaada nahi bana sakte.</div>' : ''}
    <div class="vlist">${d.rows.length ? d.rows.map(vRow).join('') : view === 'today'
    ? emptyCta('Aaj koi vaada nahi. Reminder bhejte hi grahak link par khud tareekh chun sakta hai.', '<a class="btn primary" href="#/reminders">Reminders kholein</a>')
    : '<div class="empty">Koi vaada nahi.</div>'}</div>
    <p class="muted small">Vaada record sirf aapki dukaan ko dikhta hai, kisi aur ko nahi.</p>`;
  $$('[data-v]', el).forEach((b) => b.onclick = () => go('vaade?v=' + b.dataset.v));
  $$('.vrow', el).forEach((row) => {
    const r = d.rows[+row.dataset.i], amt = r.due_amount > 0 ? r.due_amount : r.kamount;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-rem]')) remindParty(r.party_id, r.book);
      else if (e.target.closest('[data-paid]')) {
        if (r.book === 'khata') { if (!ME.can.khata) return toast('Khata entry ki permission nahi hai.', 'err'); go(`khata/${r.party_id}?got=${amt}`); }
        else { if (!ME.can.finance) return toast('Receipt banane ki permission nahi hai.', 'err'); go(`receipts?new=1&party_id=${r.party_id}&amount=${amt}`); }
      } else if (e.target.closest('[data-cancel]')) cancelVaada(r.id, render);
    });
  });
});

/* Screen D: vaada record, open promise and "Phone par vaada likhein" on the party and khata pages. book '' = both books */
async function vaadaParty(box, pid, book) {
  if (!box) return;
  let d;
  try { d = await GET('/api/vaade/party/' + pid); } catch (e) { box.innerHTML = ''; return; }
  if (!d.on) { box.innerHTML = ''; return; }
  const books = book ? [book] : ['inv', 'khata'];
  const opens = books.map((b) => d.open[b]).filter(Boolean), dueBooks = books.filter((b) => d.due[b] > 0);
  const s = d.stats, tot = s.kept + s.broken;
  if (!tot && !opens.length && !dueBooks.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="panel vparty">
    <div class="vstrip"><b>Vaada record:</b> ${tot ? `${s.kept} nibhaye · ${s.broken} toota (${s.pct}%) · pichhle 90 din mein ${s.broken90} toota` : 'abhi koi record nahi'}</div>
    ${opens.map((o) => `<div class="vopen" data-vid="${o.id}">${vaadaOpenCard(o)}${ME.can.khata ? '<button class="btn sm danger" type="button" data-vcancel>Radd karein</button>' : ''}</div>`).join('')}
    ${ME.can.khata && dueBooks.length ? '<button class="btn" type="button" data-vnew>✍ Phone par vaada likhein</button>' : ''}</div>`;
  const again = () => vaadaParty(box, pid, book);
  $$('[data-vcancel]', box).forEach((b) => b.onclick = () => cancelVaada(b.closest('[data-vid]').dataset.vid, again));
  const nb = $('[data-vnew]', box);
  if (nb) nb.onclick = () => shopVaadaSheet(d, dueBooks, again);
}
function shopVaadaSheet(d, books, after) {
  let book = books[0], saved = false;
  const def = addD(d.today, 7) <= d.max_date ? addD(d.today, 7) : d.max_date;
  const S = sheet(`<h2>Phone par vaada likhein</h2><p class="muted">${esc(d.party.name)}</p>
    ${books.length > 1 ? `<div class="seg" id="vbook">${books.map((b) => `<button type="button" data-b="${b}" class="${b === book ? 'on' : ''}">${b === 'inv' ? 'Bill' : 'Khata'} · ${inr0(d.due[b])}</button>`).join('')}</div>` : ''}
    <div class="form">
      <label class="f" data-date>Kab tak?<input type="date" id="vd" min="${d.today}" max="${d.max_date}" value="${def}"></label>
      <label class="f" data-date>Kitna? (₹)<input type="number" id="va" step="any" min="0" inputmode="decimal"></label>
      <div class="f wide" id="vkw"></div>
      <div class="vplans f wide" id="vplans" hidden></div>
      <label class="f wide">Note<input id="vn" maxlength="200" placeholder="Jaise: phone par baat hui"></label>
    </div><div class="err" hidden></div>
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" id="vgo">Vaada save karein</button></div>`, () => { if (saved) after(); });
  const el = S.el;
  const draw = () => {
    $('#va', el).value = d.due[book];
    const plans = d.plans[book] || [];
    $('#vkw', el).innerHTML = !d.can_plan ? '<span class="muted small">Kisht: Starter plan mein</span>'
      : plans.length ? '<label class="check"><input type="checkbox" id="vk"> <span>Kisht mein</span></label>' : '<span class="muted small">Is rakam par kisht nahi ban sakti.</span>';
    $('#vplans', el).innerHTML = plans.map((p, i) => `<label class="vplan"><input type="radio" name="vplan" value="${esc(p.key)}" ${i ? '' : 'checked'}>
      <span><b>${esc(p.label)}</b><br>${inr0(p.amounts[0])} × ${p.amounts.length} · aakhri ${dmy(p.last)}</span></label>`).join('');
    $('#vplans', el).hidden = true; $$('[data-date]', el).forEach((x) => { x.hidden = false; });
    const k = $('#vk', el);
    if (k) k.onchange = () => { $('#vplans', el).hidden = !k.checked; $$('[data-date]', el).forEach((x) => { x.hidden = k.checked; }); };
  };
  draw();
  const bk = $('#vbook', el);
  if (bk) bk.onclick = (e) => { const b = e.target.closest('[data-b]'); if (!b) return; book = b.dataset.b; $$('[data-b]', bk).forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  $('#vgo', el).onclick = async () => {
    const k = $('#vk', el), body = { party_id: d.party.id, book, note: $('#vn', el).value };
    if (k && k.checked) Object.assign(body, { kind: 'plan', plan: ($('[name=vplan]:checked', el) || {}).value });
    else Object.assign(body, { kind: 'date', date: $('#vd', el).value, amount: $('#va', el).value });
    const btn = $('#vgo', el); btn.disabled = true; $('.err', el).hidden = true;
    try {
      const r = await POST('/api/vaade', body);
      saved = true; toast('Vaada save hua');
      el.innerHTML = `<div class="vok"><div class="vok-h">✅ <b>Vaada save hua</b></div><p class="muted">Grahak ko WhatsApp par bhej dein, taaki unhe tareekh yaad rahe.</p>
        <div class="wa-prev"><div class="wa-bubble">${waFormat(r.text)}</div></div>
        <a class="btn got big" href="${esc(r.whatsapp_url)}" target="_blank" rel="noopener" data-x>Grahak ko bhejein</a></div>
        <div class="actions"><button type="button" class="btn" data-x>Baad mein</button></div>`;
    } catch (e) { sheetErr(S, e.message); btn.disabled = false; }
  };
}

/* Screen E: udhaar check while billing */
const creditOn = () => !!(ME.plan && ME.plan.features.includes('vaada') && ME.org.vaada && ME.org.vaada.credit_check !== 'off' && ME.can.sales);
async function creditCheck(pid) {
  if (!pid || !creditOn()) return null;
  try { return await GET('/api/vaade/check?party_id=' + pid); } catch (e) { return null; }
}
const creditText = (r) => `⚠ <b>${esc(r.name || '')}</b>: ${esc(r.reasons.join(', '))}. <b>Phir bhi udhaar?</b>`;
/* An item on a sale at ₹0 (its sale price was never saved): type the rate, or save it as a free item. */
function zeroSheet(list, { yes, fix }) {
  const S = sheet(`<h2>Rate is ₹0</h2><p>${list.length === 1 ? 'This item has' : 'These items have'} no rate on the bill${list.length === 1 ? '' : 's'}, so ${list.length === 1 ? 'it would be' : 'they would be'} billed at ₹0:</p>
    <ul class="vreasons">${list.map((z) => `<li>Line ${z.line}: ${esc(z.name)}</li>`).join('')}</ul>
    <p class="muted small">Tip: save a sale price on the item (Items → edit) and it is filled in by itself next time. Rate nahi bhara hai: rate likhein, ya free item ki tarah save karein.</p>
    <div class="actions"><button type="button" class="btn primary" id="zfix">Type the rate</button><button type="button" class="btn" id="zyes">Save as free item</button></div>`);
  $('#zfix', S.el).onclick = () => { S.close(); fix(list[0]); };
  $('#zyes', S.el).onclick = () => { S.close(); yes(); };
  if (matchMedia('(pointer: fine)').matches) $('#zfix', S.el).focus();
}
function creditSheet(cw, { yes, cash }) {
  const S = sheet(`<h2>Udhaar dena hai?</h2><ul class="vreasons">${(cw.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${cw.can_override ? '' : '<p class="err">Is grahak ka udhaar abhi band hai. Owner ya admin se approve karayein.</p>'}
    <div class="actions"><button type="button" class="btn" id="ccash">Cash / UPI lein</button>${cw.can_override ? '<button type="button" class="btn primary" id="cyes">Haan, udhaar dein</button>' : ''}</div>`);
  $('#ccash', S.el).onclick = () => { S.close(); cash(); };
  const y = $('#cyes', S.el);
  if (y) { y.onclick = () => { S.close(); yes(); }; if (matchMedia('(pointer: fine)').matches) y.focus(); }
}

/* Screen F: Settings → Vaade aur udhaar */
const VPLANS = [['2f', '2 kisht · har 15 din'], ['4w', '4 kisht · har hafte'], ['3m', '3 kisht · har mahine'], ['6w', '6 kisht · har hafte'], ['6m', '6 kisht · har mahine']];
function vaadaSettings() {
  const v = ME.org.vaada || {}, starter = ME.plan.features.includes('vaada'), num = (n, lo, hi, val) => `<input type="number" name="${n}" min="${lo}" max="${hi}" value="${esc(val)}" inputmode="numeric">`;
  return `<form class="panel" id="vset"><h2>Vaade aur udhaar</h2>
    <p class="muted">Grahak apne khata ya bill ke link par khud tareekh ya kisht chunta hai. Paisa aate hi vaada apne aap poora ho jata hai.</p><div class="err" hidden></div>
    <label class="check vline"><input type="checkbox" name="on" ${v.on ? 'checked' : ''}> <span>Link par "Kab tak denge?" dikhayein</span></label>
    <div class="form">
      <label class="f">Grahak kitne din aage tak ki tareekh chun sake${num('max_days', 1, 60, v.max_days)}</label>
      <label class="f">Kam se kam hissa %${num('min_part_pct', 10, 100, v.min_part_pct)}</label>
      <label class="check f wide"><input type="checkbox" name="part" ${v.part ? 'checked' : ''}> <span>Hissa (part) payment ka vaada</span></label>
      <fieldset class="f wide vfs" ${starter ? '' : 'disabled'}><legend>Kisht ke plan${starter ? '' : ' <span class="badge">Starter plan mein</span>'}</legend>
        ${VPLANS.map(([k, t]) => `<label class="check"><input type="checkbox" name="plans" value="${k}" ${(v.plans || []).includes(k) ? 'checked' : ''}> ${t}</label>`).join('')}</fieldset>
      <label class="f">Kam se kam kisht ₹${num('min_kisht', 1, 10000000, v.min_kisht)}</label>
      <label class="f">Chhoot (grace) ke din${num('grace', 0, 3, v.grace)}</label>
      <fieldset class="f wide vfs"><legend>Naya udhaar dete waqt check${starter ? '' : ' <span class="badge">Starter plan mein</span>'}</legend>
        ${[['off', 'Band'], ['warn', 'Sirf chetavni (koi bhi aage badh sake)'], ['stop', 'Rokein (sirf owner/admin de sake)']].map(([k, t]) => `<label class="check"><input type="radio" name="credit_check" value="${k}" ${v.credit_check === k ? 'checked' : ''}> ${t}</label>`).join('')}</fieldset>
      <label class="f">Kitne din purana baaki ho to chetavni${num('overdue_days', 7, 180, v.overdue_days)}</label>
      <label class="f">90 din mein kitne vaade toote to chetavni${num('broken_max', 1, 10, v.broken_max)}</label>
    </div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" ${ME.can.settings ? '' : 'disabled'}>Save karein</button></div></form>`;
}
function wireVaadaSettings(el) {
  const f = $('#vset', el);
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = $('.err', f), E = f.elements; b.hidden = true;
    const body = { on: E.on.checked, max_days: +E.max_days.value, part: E.part.checked, min_part_pct: +E.min_part_pct.value, min_kisht: +E.min_kisht.value,
      grace: +E.grace.value, credit_check: ($('[name=credit_check]:checked', f) || {}).value || 'warn', overdue_days: +E.overdue_days.value, broken_max: +E.broken_max.value };
    if (ME.plan.features.includes('vaada')) body.plans = $$('[name=plans]:checked', f).map((x) => x.value);
    try { const r = await api('PUT', '/api/settings/vaada', body); ME.org.vaada = r.vaada; toast('Vaada settings save hui'); } catch (err) { b.hidden = false; b.textContent = err.message; }
  };
}

/* Screen G: #/cash, Kal ka Cash */
route(/^cash$/, async (el, m, q) => {
  let d;
  try { d = await GET('/api/vaade/cash' + (q.get('fresh') ? '?fresh=1' : '')); } catch (e) {
    if (e.status !== 402) throw e;
    el.innerHTML = head('Agle 4 hafte ka cash') + `<div class="panel">${emptyCta('Kal ka Cash Growth plan mein hai: kis hafte paisa kam padega aur aaj kisko yaad dilana hai, ek nazar mein.', '<a class="btn primary" href="#/plan">Plan dekhein</a>')}</div>`;
    return;
  }
  if (q.get('fresh')) history.replaceState(null, '', '#/cash');
  const max = Math.max(1, ...d.weeks.map((w) => Math.abs(w.close_exp))), sw = d.short_week ? d.weeks[d.short_week - 1] : null;
  el.innerHTML = head('Agle 4 hafte ka cash', d.low_data ? '<span class="badge b-partial">Kam data: anumaan kachcha hai</span>' : '') + `
    <div class="panel ctop">Aaj haath mein: <b>${inr0(d.opening)}</b> <span class="muted">(Cash + Bank + UPI)</span></div>
    ${sw ? `<div class="panel cshort" role="alert">⚠ <b>${dm(sw.from)} – ${dm(sw.to)}</b> wale hafte mein ~${inr0(d.short_amount)} kam pad sakta hai.</div>` : ''}
    <div class="cweeks">${d.weeks.map((w) => `<div class="cweek${w.close_exp < 0 ? ' short' : ''}"><div class="cw-t">${dm(w.from)} – ${dm(w.to)}</div>
      <div>Aayega ~${inr0(w.in_exp)} <span class="muted">(zyada se zyada ${inr0(w.in_full)})</span></div><div>Jayega ${inr0(w.out)}</div>
      <div class="cw-c">Hafte ke ant mein ~<b class="${w.close_exp < 0 ? 'neg' : ''}">${inr0(w.close_exp)}</b></div>
      <div class="cbar"><i class="${w.close_exp < 0 ? 'r' : 'g'}" style="width:${Math.max(4, Math.round(Math.abs(w.close_exp) / max * 100))}%"></i></div></div>`).join('')}</div>
    ${d.remind.length ? `<div class="panel"><h3>Aaj in ${d.remind.length} logon ko yaad dilayein <span class="muted">(~${inr0(d.remind_total)} aa sakta hai)</span></h3>
      ${d.remind.map((r) => `<div class="crow"><span><a href="#/${r.book === 'khata' ? 'khata' : 'party'}/${r.party_id}"><b>${esc(r.name)}</b></a> <span class="muted">~${inr0(r.amount)}</span></span>
        <button class="btn sm got" data-rem="${r.party_id}" data-book="${r.book}">Yaad dilayein</button></div>`).join('')}</div>` : ''}
    ${d.bills_wait.length ? `<div class="panel"><h3>Ye bills thoda ruk sakte hain <span class="muted">(abhi terms ke andar)</span></h3>
      ${d.bills_wait.map((b) => `<div class="crow"><a href="#/doc/${b.id}">${esc(b.party || b.number)}</a><span class="muted">${inr0(b.amount)} · due ${dm(b.due)}</span></div>`).join('')}</div>` : ''}
    ${d.stuck > 0 ? `<p class="muted">Atka hua ${inr0(d.stuck)} (90 din se purana), gina nahi.</p>` : ''}
    <p class="muted small">Anumaan kaise: vaade × grahak ka vaada-record, baaki bills × 60% unki aam deri ke hisaab se, supplier bills due date par, GST 20 tareekh ko, kharche pichhle 3 mahine ke beech ke hisaab se. Aaj ${esc(d.at)} par bana. <button class="linkbtn" type="button" id="cfresh">Dobara banayein</button></p>`;
  $$('[data-rem]', el).forEach((b) => b.onclick = () => remindParty(b.dataset.rem, b.dataset.book));
  $('#cfresh').onclick = () => go('cash?fresh=1');
});

/* ======================================================================= finance */
route(/^expenses$/, async (el, m, q) => {
  dirty('accounts');
  const accts = await master('accounts');
  const exp = accts.filter((a) => a.type === 'expense' && !['cogs', 'stock_adj', 'round_off'].includes(a.sys));
  const dbk = await GET('/api/reports/daybook');
  const rows = dbk.entries.filter((e) => e.ref_type === 'EXP');
  el.innerHTML = head('Expenses', `<button class="btn primary" id="new">+ Add expense</button>`) +
    `<div class="kpis">${exp.filter((a) => a.balance).map((a) => `<div class="kpi"><div class="l">${esc(a.name)}</div><div class="v">${inr0(a.balance)}</div></div>`).join('')}</div>
    <div class="panel flush">${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Expense', k: 'narration' }, { h: 'Amount', num: 1, f: (r) => inr(r.lines.reduce((s, l) => s + l.credit, 0)) }], rows, { empty: emptyCta('No expenses this year. Add rent, salary, electricity and more to see your real profit.', '<button class="btn primary" data-ne>+ Add expense</button>') })}</div>`;
  const form = () => expenseForm();
  $('#new').onclick = form;
  if ($('[data-ne]', el)) $('[data-ne]', el).onclick = form;
  if (takeNew(q)) form();
});
/* ======================================================================= bank reconciliation (src/bankrec.js) */
let bankLast = null;          // the statement being matched stays while entries are added from it; the page matches again
route(/^bankrec$/, async (el) => {
  dirty('accounts');
  const accts = (await master('accounts')).filter((a) => a.is_cash && a.sys !== 'cash');
  const pick = bankLast ? bankLast.account_id : (accts.find((a) => a.sys === 'bank') || accts[0] || {}).id;
  el.innerHTML = head('Bank Reconciliation') + `
    <div class="panel"><p class="muted" style="margin-top:0">Match your bank statement with your books in seconds. Download it from net banking as Excel or CSV (SBI, HDFC, ICICI, Axis, Kotak and others) and pick it here: each line is matched to your entries by amount and date, a cheque or UTR number deciding a tie. Bank charges, interest and transfers your books do not have are added in one tap. बैंक स्टेटमेंट और खाते का मिलान।</p>
      <form id="bkf"><div class="form"><label class="f">Bank account<select name="account_id">${accts.map((a) => `<option value="${a.id}" ${a.id === pick ? 'selected' : ''}>${esc(a.name)} (${inr(a.balance)})</option>`).join('')}</select></label>
        <label class="f wide">Bank statement (Excel or CSV)<input type="file" name="file" accept=".csv,.xlsx,.txt,text/csv"></label></div>
        <div class="err" hidden></div><div class="row" style="margin-top:10px">${bankLast ? '<button type="button" class="btn" id="bkagain">Match the same statement again</button>' : ''}<span class="spacer"></span><button class="btn primary">Match</button></div></form></div>
    <div id="bkres"></div><div id="brsbox"></div>`;
  const f = $('#bkf'), err = $('.err', f);
  const brsShow = async (acct, on, closing) => {
    const B = await GET(`/api/bank/brs?account_id=${acct}&date=${on || ''}`);
    const lst = (rows) => rows.length ? `<ul class="small">${rows.slice(0, 30).map((x) => `<li>${fdate(x.date)} · ${esc(x.party || x.narration)}${x.ref ? ` · ${esc(x.ref)}` : ''} · <b>${inr(Math.abs(x.amount))}</b></li>`).join('')}${rows.length > 30 ? `<li>…and ${rows.length - 30} more</li>` : ''}</ul>` : '';
    const s = (rows) => rows.reduce((t, x) => t + Math.abs(x.amount), 0);
    $('#brsbox').innerHTML = `<div class="panel"><h3 style="margin-top:0">Bank Reconciliation Statement on ${fdate(B.date)}</h3>
      <table class="t brs"><tbody><tr><td>Balance as per your books</td><td class="num"><b>${inr(B.books)}</b></td></tr>
        <tr><td>Less: deposits not yet credited by the bank (${B.not_credited.length})${lst(B.not_credited)}</td><td class="num">−${inr(s(B.not_credited))}</td></tr>
        <tr><td>Add: cheques / payments not yet presented (${B.not_presented.length})${lst(B.not_presented)}</td><td class="num">+${inr(s(B.not_presented))}</td></tr>
        <tr><td><b>Balance the bank should show</b></td><td class="num"><b>${inr(B.bank)}</b></td></tr>
        ${closing !== null && closing !== undefined ? `<tr><td>Balance on the statement</td><td class="num">${inr(closing)}</td></tr>
        <tr><td><b>${Math.abs(closing - B.bank) < 0.005 ? '✓ Matches' : 'Difference to look into'}</b></td><td class="num ${Math.abs(closing - B.bank) < 0.005 ? 'pos' : 'neg'}"><b>${inr(closing - B.bank)}</b></td></tr>` : ''}</tbody></table></div>`;
  };
  const show = (r) => {
    const box = $('#bkres'), ready = r.lines.filter((l) => l.status === 'match'), none = r.lines.filter((l) => l.status === 'none');
    const st = { match: '<span class="badge b-paid">matched</span>', done: '<span class="badge">done</span>', none: '<span class="badge b-unpaid">not in books</span>' };
    box.innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Statement lines</div><div class="v">${r.counts.lines}</div><div class="s">${fdate(r.from)} – ${fdate(r.to)}</div></div>
        <div class="kpi"><div class="l">Matched, to confirm</div><div class="v pos">${r.counts.matched}</div></div><div class="kpi"><div class="l">Done before</div><div class="v">${r.counts.done}</div></div>
        <div class="kpi"><div class="l">Not in your books</div><div class="v ${none.length ? 'neg' : ''}">${none.length}</div><div class="s">add them below</div></div></div>
      ${ready.length ? `<div class="panel okbox row"><span>${ready.length} line${ready.length > 1 ? 's' : ''} matched to your entries. Check them below, then confirm.</span><span class="spacer"></span><button class="btn primary" id="bkok">Confirm ${ready.length} match${ready.length > 1 ? 'es' : ''}</button></div>` : ''}
      <div class="panel flush">${table([{ h: 'Date', f: (l) => fdate(l.date) }, { h: 'Bank says', f: (l) => `${esc(l.desc)}${l.ref ? `<div class="muted small">${esc(l.ref)}</div>` : ''}` },
        { h: 'Amount', num: 1, f: (l) => `<span class="${l.amount > 0 ? 'pos' : 'neg'}">${l.amount > 0 ? '+' : '−'}${inr(Math.abs(l.amount))}</span>` },
        { h: 'In your books', f: (l) => `${st[l.status]}${l.book ? `<div class="small">${fdate(l.book.date)} · ${esc(l.book.party || l.book.narration)}${l.book.ref ? ` · ${esc(l.book.ref)}` : ''}</div>` : ''}` },
        { h: '', f: (l) => l.status === 'none' ? (l.amount < 0 ? `<button class="btn sm" data-bexp="${l.i}">Add expense</button> <button class="btn sm" data-bpay="${l.i}">Pay supplier</button>`
          : `<button class="btn sm" data-brec="${l.i}">Receive payment</button> <button class="btn sm" data-binc="${l.i}">Other income</button>`) : l.status === 'done' ? `<button class="btn sm" data-bun="${l.line}">Undo</button>` : '' }], r.lines)}</div>
      ${r.book_open.length ? `<div class="panel"><h3 style="margin-top:0">In your books, not on this statement (${r.book_open.length})</h3><p class="muted">Cheques not yet presented, deposits not yet credited, or an entry made twice / with a wrong amount.</p>
        ${table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Entry', f: (x) => esc(x.party || x.narration) + (x.ref ? `<div class="muted small">${esc(x.ref)}</div>` : '') }, { h: 'Amount', num: 1, f: (x) => inr(x.amount) }], r.book_open)}</div>` : ''}`;
    const L = (i) => r.lines[+i];
    if ($('#bkok')) $('#bkok').onclick = async () => {
      try { const x = await POST('/api/bank/clear', { account_id: r.account.id, items: ready.map((l) => ({ line: l.line, date: l.date, key: l.key })) }); toast(`${x.cleared} entries reconciled`); run(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $$('[data-bexp]', box).forEach((b) => { b.onclick = () => { const l = L(b.dataset.bexp); expenseForm({ amount: Math.abs(l.amount), date: l.date, notes: l.desc, paid_from: r.account.id, head: /charge|fee|gst|commission/i.test(l.desc) ? 'bank' : '' }); }; });
    $$('[data-bpay]', box).forEach((b) => { b.onclick = () => { const l = L(b.dataset.bpay); paymentForm('payment', { amount: Math.abs(l.amount), date: l.date, reference: l.ref, account_id: r.account.id, after: () => render() }); }; });
    $$('[data-brec]', box).forEach((b) => { b.onclick = () => { const l = L(b.dataset.brec); paymentForm('receipt', { amount: l.amount, date: l.date, reference: l.ref, account_id: r.account.id, after: () => render() }); }; });
    $$('[data-bun]', box).forEach((b) => { b.onclick = async () => { await POST('/api/bank/unclear/' + b.dataset.bun); run(); }; });
    // interest, a refund, a cashback: money in that is not from a customer
    $$('[data-binc]', box).forEach((b) => { b.onclick = async () => {
      const l = L(b.dataset.binc), inc = (await master('accounts')).filter((a) => a.type === 'income' && !['sales', 'sales_adj'].includes(a.sys));
      modal('Other income', [{ k: 'account_id', label: 'Income head', type: 'select', options: opts(inc), value: (inc.find((a) => a.sys === 'other_income') || {}).id },
        { k: 'amount', label: 'Amount (₹)', type: 'number', value: l.amount, required: true }, { k: 'date', label: 'Date', type: 'date', value: l.date }, { k: 'notes', label: 'What it is', value: l.desc, wide: true }],
      async (v) => {
        await POST('/api/journals', { date: v.date, narration: v.notes || 'Other income', lines: [{ account_id: r.account.id, debit: +v.amount }, { account_id: +v.account_id, credit: +v.amount }] });
        dirty('accounts'); toast('Income saved'); render();
      }, { submit: 'Save', intro: '<p class="muted">Bank interest, a refund, a cashback: money that came into the bank but is not a customer\'s payment.</p>' });
    }; });
    brsShow(r.account.id, r.to, r.closing).catch(() => {});
  };
  const run = async () => { try { show(await POST('/api/bank/check', bankLast)); } catch (e) { err.hidden = false; err.textContent = e.message; } };
  f.onsubmit = async (e) => {
    e.preventDefault(); err.hidden = true;
    const file = f.elements.file.files[0];
    if (!file) { err.hidden = false; err.textContent = 'Choose the statement file first.'; return; }
    try {
      const buf = await file.arrayBuffer();
      if (/\.xls$/i.test(file.name) && new Uint8Array(buf.slice(0, 2)).join() !== '80,75') throw new Error('This is an old Excel (.xls) file. Open it in Excel and save as .xlsx or CSV, then pick that.');
      const csv = /\.xlsx$/i.test(file.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75' ? rowsToCsv(await xlsxRows(buf)) : new TextDecoder().decode(buf);
      bankLast = { account_id: +f.elements.account_id.value, csv };
      await run();
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
  if ($('#bkagain')) $('#bkagain').onclick = run;
  if (bankLast) run(); else if (pick) brsShow(pick, ME.today, null).catch(() => {});
});

/* ======================================================================= fixed assets & depreciation (src/assets.js) */
route(/^assets$/, async (el, m, q) => {
  const A = await GET('/api/assets');
  const live = A.rows.filter((a) => !a.sold_on), sum = (k) => live.reduce((s, a) => s + a[k], 0);
  const fys = [0, 1, 2, 3].map((k) => { const y = +A.fy_now.slice(0, 4) - k; return `${y}${A.fy_now.slice(4)}`; });
  const fy = q.get('fy') || (A.runs.some((r) => r.fy === fys[1]) ? fys[0] : fys[1]);
  el.innerHTML = head('Fixed Assets', '<button class="btn primary" id="new">+ Add asset</button>') + `
    <p class="muted">Machines, furniture, computers, vehicles, shop fit-out. Depreciation is worked out every year (income-tax WDV or Companies Act SLM) and booked in one tap, so your profit and balance sheet are right. मशीन, फ़र्नीचर, गाड़ी: हर साल घिसाई (depreciation) अपने आप।</p>
    ${A.rows.length ? `<div class="kpis"><div class="kpi"><div class="l">Cost of assets in use</div><div class="v">${inr0(sum('cost'))}</div><div class="s">${live.length} asset${live.length === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="l">Depreciation so far</div><div class="v">${inr0(sum('depreciation'))}</div></div><div class="kpi"><div class="l">Book value now</div><div class="v pos">${inr0(sum('book_value'))}</div></div></div>` : ''}
    <div class="panel flush">${table([{ h: 'Asset', f: (a) => `<b>${esc(a.name)}</b><div class="muted small">${esc((A.categories[a.category] || {}).name || '')}</div>` },
      { h: 'Bought', f: (a) => fdate(a.bought_on) }, { h: 'Cost', num: 1, f: (a) => inr(a.cost) },
      { h: 'Method', cls: 'hide-sm', f: (a) => (a.method === 'wdv' ? `WDV ${a.rate}%` : `SLM ${a.life_years} yrs`) },
      { h: 'Depreciation', num: 1, cls: 'hide-sm', f: (a) => inr(a.depreciation) }, { h: 'Book value', num: 1, f: (a) => `<b>${inr(a.book_value)}</b>` },
      { h: '', f: (a) => a.sold_on ? `<span class="muted small">${a.sold_for ? 'sold' : 'scrapped'} ${fdate(a.sold_on)}</span>` : `<button class="btn sm" data-sell="${a.id}">Sell / scrap</button>` }],
    A.rows, { empty: emptyCta('No fixed assets yet. Add the machines, furniture, computers and vehicles the business owns.', '<button class="btn primary" data-na>+ Add asset</button>') })}</div>
    <div class="panel" id="dep"><div class="row"><h3 style="margin:0">Depreciation</h3><span class="spacer"></span><label class="f inline-f">Year<select id="depfy">${fys.map((y) => `<option value="${y}" ${y === fy ? 'selected' : ''}>${y.slice(0, 4)}-${String(+y.slice(2, 4) + 1).padStart(2, '0')}</option>`).join('')}</select></label></div>
      <div id="depbox"><span class="muted">Working out…</span></div></div>`;
  const depShow = async (y) => {
    const box = $('#depbox');
    try {
      const p = await GET('/api/assets/depreciation?fy=' + y);
      box.innerHTML = (p.lines.length ? table([{ h: 'Asset', k: 'name' }, { h: 'Method', f: (l) => (l.method === 'wdv' ? `WDV ${l.rate}%` : `SLM ${l.life_years} yrs`) },
        { h: 'At start', num: 1, f: (l) => inr(l.opening) }, { h: `Depreciation ${p.label}`, k: 'amount', num: 1, f: (l) => `<b>${inr(l.amount)}</b>` }, { h: 'At end', num: 1, f: (l) => inr(l.closing) }], p.lines,
        { foot: { name: '<b>Total</b>', amount: `<b>${inr(p.total)}</b>` } }) : '<p class="muted">No assets in this year.</p>')
        + (p.booked ? `<div class="row" style="margin-top:10px"><span class="okc">✓ Booked for ${p.label}: ${inr(p.booked.total)}</span><span class="spacer"></span><button class="btn sm danger" id="depundo">Undo</button></div>`
          : p.can_book && p.total > 0 ? `<div class="row" style="margin-top:10px"><span class="muted small">Booked on ${fdate(p.to)}: Depreciation (expense) against Accumulated Depreciation.</span><span class="spacer"></span><button class="btn primary" id="depgo">Book depreciation for ${p.label}</button></div>`
          : `<p class="muted small" style="margin-top:10px">${p.total > 0 ? `${p.label} has not ended yet: book it at the year end.` : ''}</p>`);
      if ($('#depgo')) $('#depgo').onclick = async () => { try { const r = await POST('/api/assets/depreciation', { fy: y }); dirty('accounts'); toast(`Depreciation ${r.label}: ${inr(r.total)} booked`); render(); } catch (e) { toast(e.message, 'err'); } };
      if ($('#depundo')) $('#depundo').onclick = async () => { if (!confirm(`Take back the depreciation booked for ${p.label}?`)) return; try { await POST('/api/assets/depreciation/undo', { fy: y }); dirty('accounts'); toast('Taken back'); render(); } catch (e) { toast(e.message, 'err'); } };
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  $('#depfy').onchange = (e) => depShow(e.target.value);
  depShow(fy);
  const add = async () => {
    const [cash, parties] = await Promise.all([cashOpts(), master('parties')]);
    const f = modal('Add a fixed asset', [
      { k: 'name', label: 'Asset', required: true, placeholder: 'e.g. Delivery van MH12 AB 1234' },
      { k: 'category', label: 'Kind', type: 'select', value: 'plant', options: Object.entries(A.categories).map(([v, c]) => ({ v, t: c.name })) },
      { k: 'bought_on', label: 'Bought / first used on', type: 'date', value: ME.today, required: true },
      { k: 'cost', label: 'Cost before GST (₹)', type: 'number', required: true }, { k: 'gst', label: 'GST paid (input credit, ₹)', type: 'number', value: 0 },
      { k: 'paid', label: 'Paid how', type: 'select', value: 'cash', options: [{ v: 'cash', t: 'Paid from cash / bank' }, { v: 'supplier', t: 'Owed to a supplier' }, { v: 'opening', t: 'Already owned (before SmartTrader)' }] },
      { k: 'account_id', label: 'Paid from', type: 'select', options: cash },
      { k: 'party_id', label: 'Supplier', type: 'select', options: [{ v: '', t: 'Choose…' }, ...opts(parties.filter((p) => p.kind !== 'customer'))] },
      { k: 'opening_dep', label: 'Depreciation already charged before (₹)', type: 'number', value: 0 },
      { k: 'method', label: 'Depreciation', type: 'select', value: 'wdv', options: [{ v: 'wdv', t: 'WDV: income-tax rates' }, { v: 'slm', t: 'SLM: Companies Act, straight line' }] },
      { k: 'rate', label: 'Rate a year (%)', type: 'number', value: A.categories.plant.rate }, { k: 'life_years', label: 'Useful life (years)', type: 'number', value: A.categories.plant.life },
      { k: 'salvage', label: 'Residual value at the end (₹)', type: 'number', value: 0, more: true }, { k: 'notes', label: 'Notes', more: true, wide: true }],
    async (v) => { await POST('/api/assets', { ...v, account_id: +v.account_id, party_id: +v.party_id }); dirty('accounts'); toast('Asset added'); render(); },
    { submit: 'Add asset', intro: '<p class="muted">WDV takes the rate on what is left each year (half the rate if used less than 180 days in the first year). SLM spreads the cost evenly over its life. Ask your CA which one your books follow.</p>' });
    const show = (k, on) => { const l = f.elements[k].closest('label'); if (l) l.hidden = !on; };
    const sync = () => {
      const pd = f.elements.paid.value, mt = f.elements.method.value;
      show('account_id', pd === 'cash'); show('party_id', pd === 'supplier'); show('opening_dep', pd === 'opening'); show('rate', mt === 'wdv'); show('life_years', mt === 'slm');
    };
    f.elements.category.onchange = () => { const c = A.categories[f.elements.category.value]; f.elements.rate.value = c.rate; f.elements.life_years.value = c.life; };
    f.addEventListener('change', sync); sync();
  };
  $('#new').onclick = add;
  if ($('[data-na]', el)) $('[data-na]', el).onclick = add;
  $$('[data-sell]', el).forEach((b) => { b.onclick = async () => {
    const a = A.rows.find((x) => x.id === +b.dataset.sell);
    modal(`Sell or scrap ${a.name}`, [{ k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'amount', label: 'Sold for (₹, 0 if scrapped)', type: 'number', value: 0 },
      { k: 'account_id', label: 'Money went into', type: 'select', options: await cashOpts() }],
    async (v) => { const r = await POST(`/api/assets/${a.id}/dispose`, { ...v, account_id: +v.account_id }); dirty('accounts'); toast(r.gain > 0 ? `Gain on sale ${inr(r.gain)} booked` : r.gain < 0 ? `Loss on sale ${inr(-r.gain)} booked` : 'Done'); render(); },
    { submit: 'Save', intro: `<p class="muted">Book value now ${inr(a.book_value)}. Book this year's depreciation first if the year has ended.</p>` });
  }; });
});

/* ======================================================================= TDS (src/tds.js) */
route(/^tds$/, async (el, m, q) => {
  const T = await GET(`/api/tds?from=${q.get('from') || ''}&to=${q.get('to') || ''}`);
  const sum = (a) => a.reduce((s, x) => s + x.tds, 0);
  el.innerHTML = head('TDS', '<button class="btn primary" id="chal">Record TDS paid (challan)</button>') + `
    <p class="muted">To keep TDS back from a supplier: <b>Pay supplier → More details → TDS section</b>. The supplier gets the rest, and the TDS waits here until you pay it to the government (by the 7th of the next month). Customers who deducted TDS from what they paid you are listed too: claim it in your income-tax return.</p>
    <div class="kpis"><div class="kpi"><div class="l">TDS to pay the government</div><div class="v ${T.payable > 0 ? 'neg' : ''}">${inr(T.payable)}</div><div class="s">due by ${fdate(T.due)}</div></div>
      <div class="kpi"><div class="l">Deducted ${fdate(T.from)} – ${fdate(T.to)}</div><div class="v">${inr(sum(T.deducted))}</div><div class="s">${T.deducted.length} payments</div></div>
      <div class="kpi"><div class="l">Paid by challan</div><div class="v">${inr(T.challans.reduce((s, x) => s + x.amount, 0))}</div></div>
      <div class="kpi"><div class="l">Customers deducted (claim)</div><div class="v">${inr(sum(T.by_customers))}</div></div></div>
    ${T.by_section.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>By section (for the 26Q return)</h3></div>${table([{ h: 'Section', k: 'section' }, { h: 'Payments', num: 1, k: 'count' }, { h: 'Amount paid', num: 1, f: (s) => inr(s.gross) }, { h: 'TDS', num: 1, f: (s) => `<b>${inr(s.tds)}</b>` }], T.by_section)}</div>` : ''}
    <div class="panel flush"><div style="padding:14px 16px 0"><h3>TDS kept back from suppliers</h3></div>${table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Supplier', f: (x) => `${esc(x.party)}${x.pan ? `<div class="muted small">PAN ${esc(x.pan)}</div>` : ''}` },
      { h: 'Section', k: 'section' }, { h: 'Amount', num: 1, cls: 'hide-sm', f: (x) => inr(x.gross) }, { h: 'TDS', num: 1, f: (x) => inr(x.tds) }, { h: 'Payment', cls: 'hide-sm', k: 'number' }], T.deducted, { empty: 'No TDS kept back in this period.' })}</div>
    ${T.challans.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Challans paid</h3></div>${table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Challan no.', k: 'challan_no' }, { h: 'Section', k: 'section' }, { h: 'Amount', num: 1, f: (x) => inr(x.amount) }], T.challans)}</div>` : ''}
    ${T.by_customers.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>TDS customers deducted (claim in your ITR, see Form 26AS)</h3></div>${table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Customer', k: 'party' }, { h: 'Amount', num: 1, f: (x) => inr(x.gross) }, { h: 'TDS', num: 1, f: (x) => inr(x.tds) }], T.by_customers)}</div>` : ''}`;
  $('#chal').onclick = async () => modal('TDS paid to the government', [{ k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'amount', label: 'Amount (₹)', type: 'number', value: T.payable > 0 ? T.payable : '', required: true },
    { k: 'account_id', label: 'Paid from', type: 'select', options: await cashOpts() }, { k: 'challan_no', label: 'Challan / CIN number' }, { k: 'section', label: 'Section (optional)', placeholder: '194C' }],
  async (v) => { await POST('/api/tds/challan', { ...v, account_id: +v.account_id }); dirty('accounts'); toast('Challan saved'); render(); });
});

route(/^accounts$/, async (el) => {
  dirty('accounts');
  const rows = await master('accounts');
  el.innerHTML = head('Chart of Accounts', `<button class="btn primary" id="new">+ New account</button>`) +
    `<div class="panel flush">${table([{ h: 'Code', k: 'code' }, { h: 'Account', k: 'name' }, { h: 'Type', k: 'type' }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }], rows, { onRow: true })}</div>`;
  bindRows(el, rows, (r) => go('account/' + r.id));
  $('#new').onclick = () => modal('New account', [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true },
    { k: 'type', label: 'Type', type: 'select', options: ['asset', 'liability', 'equity', 'income', 'expense'].map((t) => ({ v: t, t })) }, { k: 'is_cash', label: 'Cash / bank account', type: 'checkbox' }],
  async (v) => { await POST('/api/accounts', v); dirty('accounts'); render(); });
});
route(/^account\/(\d+)$/, async (el, m, q) => {
  const L = await GET(`/api/accounts/${m[1]}/ledger?from=${q.get('from') || ''}&to=${q.get('to') || ''}`);
  el.innerHTML = head(`${esc(L.account.code)} ${esc(L.account.name)}`) + `
    <div class="panel"><form class="row" id="per"><input type="date" name="from" aria-label="From date" value="${L.from}" style="max-width:170px"><input type="date" name="to" aria-label="To date" value="${L.to}" style="max-width:170px"><button class="btn">Show</button></form></div>
    <div class="panel flush">${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Particulars', f: (r) => esc(r.narration) + (r.party ? ` <span class="muted">· ${esc(r.party)}</span>` : '') },
      { h: 'Debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }],
    [{ date: L.from, narration: 'Opening balance', debit: 0, credit: 0, balance: L.opening }, ...L.rows])}</div>`;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`account/${m[1]}?${new URLSearchParams(new FormData(e.target))}`); };
});
route(/^journal$/, async (el) => {
  dirty('accounts');
  const accts = await master('accounts'), parties = await master('parties');
  const aopt = `<option value="">Account…</option>` + accts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
  const popt = `<option value="">(no party)</option>` + parties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const row = () => `<tr><td><select name="account_id" aria-label="Account">${aopt}</select></td><td class="hide-sm"><select name="party_id" aria-label="Party">${popt}</select></td><td class="c-n"><input name="debit" aria-label="Debit" type="number" step="any" min="0"></td><td class="c-n"><input name="credit" aria-label="Credit" type="number" step="any" min="0"></td></tr>`;
  el.innerHTML = head('Journal Voucher') + `<form id="jv"><div class="err" hidden></div>
    <div class="panel"><div class="form"><label class="f">Date<input type="date" name="date" value="${ME.today}"></label><label class="f wide">Narration<input name="narration" placeholder="e.g. Capital introduced, bank charges, contra"></label></div></div>
    <div class="panel flush"><table class="t lines"><thead><tr><th>Account</th><th class="hide-sm">Party (for debtors/creditors)</th><th>Debit ₹</th><th>Credit ₹</th></tr></thead><tbody id="jl">${row() + row()}</tbody>
      <tfoot><tr><td colspan="2" class="hide-sm"></td><td class="num" id="dr"></td><td class="num" id="cr"></td></tr></tfoot></table>
      <div style="padding:10px"><button type="button" class="btn sm" id="add">+ Line</button></div></div>
    <div class="row"><span class="spacer"></span><button class="btn primary">Post journal</button></div></form>`;
  const sum = () => { let d = 0, c = 0; $$('#jl tr').forEach((tr) => { d += +$('[name=debit]', tr).value || 0; c += +$('[name=credit]', tr).value || 0; }); $('#dr').textContent = inr(d); $('#cr').textContent = inr(c); };
  $('#jv').oninput = sum; sum();
  $('#add').onclick = () => $('#jl').insertAdjacentHTML('beforeend', row());
  $('#jv').onsubmit = async (e) => {
    e.preventDefault();
    const lines = $$('#jl tr').map((tr) => ({ account_id: +$('[name=account_id]', tr).value, party_id: +$('[name=party_id]', tr).value || null, debit: $('[name=debit]', tr).value, credit: $('[name=credit]', tr).value }))
      .filter((l) => l.account_id && (+l.debit || +l.credit));
    try { await POST('/api/journals', { date: e.target.date.value, narration: e.target.narration.value, lines }); dirty('accounts', 'parties'); toast('Journal posted'); go('daybook'); }
    catch (err) { const b = $('.err', e.target); b.hidden = false; b.textContent = err.message; }
  };
});
route(/^daybook$/, async (el, m, q) => {
  const d = await GET(`/api/reports/daybook?from=${q.get('from') || ME.today}&to=${q.get('to') || ME.today}`);
  el.innerHTML = head('Day Book') + `<div class="panel"><form class="row" id="per"><input type="date" name="from" aria-label="From date" value="${d.from}" style="max-width:170px"><input type="date" name="to" aria-label="To date" value="${d.to}" style="max-width:170px"><button class="btn">Show</button></form></div>
    ${d.entries.length ? d.entries.map((e) => `<div class="panel flush"><div style="padding:10px 14px" class="row"><b>${fdate(e.date)}</b><span>${esc(e.narration)}</span><span class="spacer"></span><span class="badge">${esc(e.ref_type)}</span></div>
      ${table([{ h: 'Account', k: 'account' }, { h: 'Party', k: 'party', cls: 'hide-sm' }, { h: 'Debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }], e.lines)}</div>`).join('')
    : '<div class="panel empty">No entries for these dates.</div>'}`;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`daybook?${new URLSearchParams(new FormData(e.target))}`); };
});

/* ======================================================================= reports */
const periodBar = (d, extra = '') => `<div class="panel no-print"><form class="row" id="per">${d.from ? `<label class="f">From<input type="date" name="from" value="${d.from}"></label>` : ''}
  <label class="f">${d.from ? 'To' : 'As on'}<input type="date" name="to" aria-label="To date" value="${d.to || d.as_of || ME.today}"></label>${extra}<label class="f">&nbsp;<button class="btn">Show</button></label>
  <span class="spacer"></span><label class="f">&nbsp;<span class="row"><button type="button" class="btn" id="csv">CSV</button><button type="button" class="btn" data-act="print">Print</button></span></label></form></div>`;
/* ======================================================================= GST returns (src/gstr.js)
   GSTR-1: the file the GST portal takes (Returns → GSTR-1 → Prepare offline → Upload), and the GSTR-3B figures.
   GSTR-2B: the file the user downloads from the portal is read on this device and matched with the purchase bills.
   Nothing is filed from the app. */
const monthBefore = (t) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
const ymdOf = (s) => { const m = String(s || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const excelDay = (v) => { const s = String(v ?? '').trim(); return /^\d{5}(\.\d+)?$/.test(s) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5).toISOString().slice(0, 10) : ymdOf(s); };
/* GSTR-2B JSON: data.docdata.b2b[].inv[] and cdnr[].nt[], amounts per rate in items[] (older 2A-style files: itms[].itm_det) */
function twoBFromJson(j) {
  const d = (j && j.data) || j || {}, dd = d.docdata || {}, rows = [];
  const tot = (v, k, old) => (v.items ? v.items.reduce((t, x) => t + (+x[k] || 0), 0) : v.itms ? v.itms.reduce((t, x) => t + (+(x.itm_det || {})[old] || 0), 0) : +v[k] || 0);
  const take = (s, v, kind, num) => rows.push({ kind, gstin: s.ctin, name: s.trdnm || '', num: String(num || ''), date: ymdOf(v.dt || v.idt || v.nt_dt), val: +v.val || 0,
    txval: tot(v, 'txval', 'txval'), igst: tot(v, 'igst', 'iamt'), cgst: tot(v, 'cgst', 'camt'), sgst: tot(v, 'sgst', 'samt'), cess: tot(v, 'cess', 'csamt'),
    itc: v.itcavl !== 'N', rcm: v.rev === 'Y' || v.rchrg === 'Y', rsn: v.rsn || '' });
  for (const k of ['b2b', 'b2ba']) for (const s of dd[k] || []) for (const v of s.inv || []) take(s, v, 'inv', v.inum);
  for (const k of ['cdnr', 'cdnra']) for (const s of dd[k] || []) for (const v of s.nt || []) take(s, v, (v.typ || v.ntty) === 'D' ? 'dn' : 'cn', v.ntnum || v.nt_num);
  if (!rows.length && !d.docdata) throw new Error('This is not a GSTR-2B file. On the GST portal open GSTR-2B for the month and tap Download.');
  const rp = String(d.rtnprd || '');
  return { rows, month: /^\d{6}$/.test(rp) ? `${rp.slice(2)}-${rp.slice(0, 2)}` : '' };
}
/* GSTR-2B Excel: sheets B2B and B2B-CDNR; the headings take two rows (a group such as "Invoice details" over the column names) */
async function twoBFromExcel(buf) {
  const rows = [];
  for (const [named, cn] of [[/^b2b$/i, false], [/^b2b[\s-]*cdnr$/i, true]]) {
    const grid = await xlsxRows(buf, named);
    if (!grid) continue;
    const h = grid.findIndex((r) => r.some((c) => /gstin of supplier/i.test(c)));
    if (h < 0) continue;
    const top = grid[h], sub = grid[h + 1] || [], label = (i) => `${top[i] || ''} ${sub[i] || ''}`.toLowerCase(), col = {};
    const want = { gstin: /gstin of supplier/, name: /trade\/legal name/, num: /(invoice|note) number/, type: /note type/, date: /(invoice|note) date/, val: /(invoice|note) value/,
      txval: /taxable value/, igst: /integrated tax/, cgst: /central tax/, sgst: /state\/ut tax/, cess: /cess/, itc: /itc availability/, rcm: /reverse charge/, rsn: /reason/ };
    for (const [k, re] of Object.entries(want)) for (let i = 0; i < Math.max(top.length, sub.length); i++) if (col[k] === undefined && re.test(label(i))) col[k] = i;
    if (col.gstin === undefined || col.num === undefined) continue;
    const by = new Map(), cell = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim()), amt = (r, k) => +cell(r, k).replace(/[,₹\s]/g, '') || 0;
    for (const r of grid.slice(h + 2)) {
      const g = cell(r, 'gstin').toUpperCase();
      if (!/^\d{2}[A-Z0-9]{13}$/.test(g)) continue;
      const k = g + '|' + cell(r, 'num');
      if (!by.has(k)) by.set(k, { kind: cn ? (/debit/i.test(cell(r, 'type')) ? 'dn' : 'cn') : 'inv', gstin: g, name: cell(r, 'name'), num: cell(r, 'num'), date: excelDay(cell(r, 'date')),
        val: amt(r, 'val'), txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, itc: !/^n/i.test(cell(r, 'itc')), rcm: /^y/i.test(cell(r, 'rcm')), rsn: cell(r, 'rsn') });
      const x = by.get(k);
      for (const f of ['txval', 'igst', 'cgst', 'sgst', 'cess']) x[f] += amt(r, f);       // one row per rate: add them up
    }
    rows.push(...by.values());
  }
  if (!rows.length) throw new Error('No supplier bills found in this Excel file. Pick the GSTR-2B Excel from the GST portal (it has a sheet named B2B).');
  return { rows, month: '' };
}
async function read2b(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4b) {                    // a zip: the Excel workbook, or the JSON zipped by the portal
    const z = await unzipFiles(buf), name = z.names.find((n) => /\.json$/i.test(n));
    if (!name) return twoBFromExcel(buf);
    return twoBFromJson(JSON.parse((await z.read(name)).replace(/^﻿/, '')));
  }
  let j;
  try { j = JSON.parse(new TextDecoder().decode(buf).replace(/^﻿/, '')); } catch (e) { throw new Error('This is not a GSTR-2B file. Pick the JSON or Excel you downloaded from the GST portal.'); }
  return twoBFromJson(j);
}
let gstr2bLast = null;          // the 2B read last, so changing tabs or months does not ask for the file again
const IMS_LABEL = { accept: ['Accept', 'b-paid'], pending: ['Keep pending', 'b-pending'], check: ['Check first', 'b-partial'] };
const G2B_STATUS = { diff: ['Amount differs', 'b-overdue'], missing_books: ['Not in your bills', 'b-unpaid'], missing_2b: ['Not in 2B', 'b-pending'], number: ['Bill no. differs', 'b-partial'], ok: ['Matched', 'b-paid'] };
route(/^gstr$/, async (el, m, q) => {
  const tab = q.get('tab') === '2b' ? '2b' : '1', month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.get('month') || '') ? q.get('month') : monthBefore(ME.today);
  const quarterly = tab === '1' && q.get('quarterly') === '1', qs = `month=${month}${quarterly ? '&quarterly=1' : ''}`;
  el.innerHTML = head('GST Returns') + `<div class="tabs"><a href="#/gstr?tab=1&month=${month}" class="${tab === '1' ? 'on' : ''}">GSTR-1 (sales)</a>
      <a href="#/gstr?tab=2b&month=${month}" class="${tab === '2b' ? 'on' : ''}">GSTR-2B match (purchase credit)</a></div>
    <form class="panel row" id="gpf"><label class="f">Month<input type="month" name="month" value="${month}" max="${ME.today.slice(0, 7)}"></label>
      ${tab === '1' ? `<label class="check"><input type="checkbox" name="quarterly" ${quarterly ? 'checked' : ''}> Quarterly filer (QRMP): the 3 months ending here</label>` : ''}
      <button class="btn">Show</button></form><div id="gbox"></div>`;
  $('#gpf').onsubmit = (e) => { e.preventDefault(); const f = e.target; go(`gstr?tab=${tab}&month=${f.month.value}${f.quarterly && f.quarterly.checked ? '&quarterly=1' : ''}`); };
  const box = $('#gbox');
  if (tab === '1') {
    const g = await GET(`/api/gst/gstr1?${qs}`), T = g.tables, b = g.b3, stop = g.problems.some((x) => x.stop);
    const sumRow = (t, x) => ({ t, n: x.n, txval: x.txval, tax: x.tax });
    box.innerHTML = `${g.problems.length ? `<div class="panel warnbox"><h3 style="margin-top:0">Fix before filing</h3><ul>${g.problems.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel flush"><div style="padding:14px 16px 0"><h3 style="margin:0">GSTR-1 · ${quarterly ? 'quarter ending ' : ''}${monthName(month)}</h3><p class="muted small">${fdate(g.from)} – ${fdate(g.to)} · GSTIN ${esc(g.gstin || 'not set')}</p></div>
        ${table([{ h: 'Table', k: 't' }, { h: 'Count', num: 1, k: 'n' }, { h: 'Taxable value', num: 1, f: (r) => inr(r.txval) }, { h: 'Tax', num: 1, f: (r) => inr(r.tax) }], [
          sumRow('4A · B2B: customers with a GSTIN', T.b2b), sumRow('5 · B2C large: other state, above ₹1 lakh', T.b2cl), sumRow('7 · B2C others (one row per state and rate)', T.b2cs),
          sumRow('6A · Exports (with IGST and under LUT)', T.exp || { n: 0, txval: 0, tax: 0 }),
          sumRow('9B · Credit notes to registered customers', T.cdnr), sumRow('9B · Credit notes, unregistered (B2C large, exports)', T.cdnur)])}
        <p class="small" style="padding:0 16px">8 · Nil rated: <b>${inr(T.nil)}</b> &middot; 12 · HSN summary: <b>${T.hsn}</b> row(s) &middot; 13 · Documents: <b>${T.docs.issued}</b> issued, ${T.docs.cancelled} cancelled</p>
        <div class="row" style="padding:0 16px 14px"><button class="btn primary" id="g1json" ${stop ? 'disabled' : ''}>Download GSTR-1 file (.json)</button><button class="btn" id="g1xls">Excel for your CA</button></div></div>
      <div class="panel"><h3 style="margin-top:0">How to file</h3><ol class="steps small"><li>On <b>gst.gov.in</b>: Returns → Returns Dashboard → pick the month → GSTR-1 → <b>Prepare offline</b> → Upload → choose this file.</li>
        <li>After a few minutes the portal shows "Processed": check the summary there, then <b>File</b> with OTP or DSC.</li></ol>
        <p class="small" lang="hi">GST पोर्टल पर Returns → GSTR-1 → Prepare offline → Upload में यह फ़ाइल चुनें। कुछ मिनट बाद पोर्टल पर सारांश जाँचें और OTP से फ़ाइल करें।</p>
        <p class="muted small">Invoices with an e-invoice (IRN) are already filled in on the portal; uploading them again is fine.</p></div>
      <div class="panel flush"><div style="padding:14px 16px 0"><h3 style="margin:0">For GSTR-3B (same period)</h3><p class="muted small">Type these in GSTR-3B. Take only the input credit your GSTR-2B shows: <a href="#/gstr?tab=2b&month=${month}">match it</a>.</p></div>
        ${table([{ h: 'Table', k: 't' }, { h: 'Taxable value', num: 1, f: (r) => (r.v === '' ? '' : inr(r.v)) }, { h: 'IGST', num: 1, f: (r) => (r.i === '' ? '' : inr(r.i)) }, { h: 'CGST', num: 1, f: (r) => (r.c === '' ? '' : inr(r.c)) }, { h: 'SGST', num: 1, f: (r) => (r.s === '' ? '' : inr(r.s)) }], [
          { t: '3.1(a) Outward taxable supplies', v: b.outward.txval, i: b.outward.igst, c: b.outward.cgst, s: b.outward.sgst }, ...(b.zero_rated && b.zero_rated.txval ? [{ t: '3.1(b) Zero rated (exports)', v: b.zero_rated.txval, i: b.zero_rated.igst, c: '', s: '' }] : []), { t: '3.1(c) Nil rated', v: b.nil, i: '', c: '', s: '' },
          ...b.unregistered_inter.map((u) => ({ t: `3.2 To unregistered persons, state ${u.pos}`, v: u.txval, i: '', c: '', s: '' })),
          { t: '4(A)(5) Input tax credit, from your purchase bills', v: '', i: b.itc.igst, c: b.itc.cgst, s: b.itc.sgst }, { t: '4(B)(2) Credit reversed (goods lost)', v: '', i: b.reversed.igst, c: b.reversed.cgst, s: b.reversed.sgst }])}
        <p style="padding:0 16px 14px">${b.payable >= 0 ? `Tax to pay after credit: <b>${inr(b.payable)}</b>` : `No tax to pay: <b>${inr(-b.payable)}</b> credit is left over for next month`}</p></div>`;
    $('#g1json').onclick = () => download(`GSTR1_${g.gstin}_${g.fp}.json`, JSON.stringify(g.json), 'application/json');
    $('#g1xls').onclick = () => fileDownload(`/api/gst/gstr1/excel?${qs}`);
    return;
  }
  box.innerHTML = `<div class="panel"><ol class="steps small"><li>On <b>gst.gov.in</b>: Returns → Returns Dashboard → pick the month → <b>GSTR-2B</b> → View → Download (JSON or Excel).</li>
      <li>Pick that file here. It is read on this device and every supplier bill in it is matched with your purchase bills.</li></ol>
      <p class="small" lang="hi">GST पोर्टल से उस महीने की GSTR-2B (JSON या Excel) डाउनलोड करें और यहाँ चुनें। हर सप्लायर बिल आपकी खरीद से मिलाया जाएगा।</p>
      <label class="f wide">GSTR-2B file (JSON, zip or Excel)<input type="file" id="g2file" accept=".json,.zip,.xlsx,application/json"></label><div class="err" hidden></div></div><div id="g2res"></div>`;
  const err = $('.err', box), res = $('#g2res');
  const show = (r) => {
    const S = r.summary, counts = Object.fromEntries(Object.keys(G2B_STATUS).map((k) => [k, r.rows.filter((x) => x.status === k).length]));
    const nameOf = new Map(gstr2bLast.rows.map((x) => [String(x.gstin).toUpperCase(), x.name]));
    const side = (x) => (x ? `${esc(x.num || x.party_ref || x.number || '')} · ${fdate(x.date)}<div class="muted small">tax ${inr(x.tax)}${x.itc === false ? ' · <b>no credit</b>' : ''}${x.rcm ? ' · reverse charge' : ''}</div>` : '<span class="muted">—</span>');
    const wa = (x) => {
      if (x.status !== 'missing_2b' || !x.phone) return '';
      const ph = String(x.phone).replace(/\D/g, ''), b = x.book;
      const text = `Namaste ${x.supplier}, aapka bill ${b.party_ref || b.number} (${fdate(b.date)}, ${inr(b.total)}) hamare GSTR-2B (${monthName(r.month)}) me nahi aaya hai. Kripya ise apne GSTR-1 me daal dein, taaki hume input credit mil sake. - ${ME.org.name}`;
      return `<a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${ph.length === 10 ? '91' + ph : ph}?text=${encodeURIComponent(text)}">Remind on WhatsApp</a>`;
    };
    let only = 'all';
    const draw = () => {
      const rows = only === 'all' ? r.rows : r.rows.filter((x) => x.status === only);
      const badgeOf = (x) => `<span class="badge ${G2B_STATUS[x.status][1]}">${G2B_STATUS[x.status][0]}</span>`, bookOf = (x) => (x.book ? `<a href="#/doc/${x.book.id}">${side(x.book)}</a>` : side(null));
      // on a phone the 2B and your-bill columns fold into the last one, so nothing hides off to the side
      $('#g2list').innerHTML = table([
        { h: 'Supplier', f: (x) => `<b>${esc(x.supplier || nameOf.get(x.gstin) || x.gstin)}</b><div class="muted small mono">${esc(x.gstin)}</div><span class="show-sm" style="margin-top:4px">${badgeOf(x)}</span>` },
        { h: 'Status', cls: 'hide-sm', f: badgeOf }, { h: 'In GSTR-2B', cls: 'hide-sm', f: (x) => side(x.b2b) }, { h: 'Your bill', cls: 'hide-sm', f: bookOf },
        { h: 'IMS', f: (x) => (x.ims ? `<span class="badge ${IMS_LABEL[x.ims][1]}">${IMS_LABEL[x.ims][0]}</span>` : '<span class="muted">—</span>') },
        { h: 'What to do', f: (x) => `<div class="show-sm small" style="flex-direction:column;gap:4px;margin-bottom:6px"><div><b>2B:</b> ${side(x.b2b)}</div><div><b>Your bill:</b> ${bookOf(x)}</div></div>
          <div class="small">${esc(x.note)}</div>${wa(x) ? `<div style="margin-top:6px">${wa(x)}</div>` : ''}` }], rows, { empty: 'Nothing here.' });
    };
    res.innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Credit in GSTR-2B</div><div class="v">${inr0(S.in_2b.tax)}</div><div class="s">${S.in_2b.n} supplier document(s) · ${monthName(r.month)}</div></div>
        <div class="kpi"><div class="l">Credit in your bills</div><div class="v">${inr0(S.books.tax)}</div><div class="s">${S.books.n} bill(s) this month</div></div>
        <div class="kpi"><div class="l">Amounts agree</div><div class="v pos">${S.ok.n}</div><div class="s">${inr0(S.ok.tax)} credit</div></div>
        <div class="kpi"><div class="l">To look into</div><div class="v ${S.diff.n + S.missing_books.n + S.missing_2b.n ? 'neg' : ''}">${S.diff.n + S.missing_books.n + S.missing_2b.n}</div>
          <div class="s">credit at risk ${inr0(S.missing_2b.tax)}</div></div></div>
      ${S.no_itc.n ? `<div class="panel warnbox small">${S.no_itc.n} document(s) in the 2B carry no credit (ITC availability: No). Do not claim them.</div>` : ''}
      <div class="panel small"><b>On the GST portal's IMS dashboard</b> (Returns → Invoice Management System): accept <b>${S.ims.accept}</b>, keep <b>${S.ims.pending}</b> pending
        until the supplier corrects them, and check <b>${S.ims.check}</b> against your purchases before accepting or rejecting. Untouched ones count as accepted.</div>
      <div class="chips" id="g2chips"><button type="button" class="chip on" data-s="all">All ${r.rows.length}</button>${Object.keys(G2B_STATUS).filter((k) => counts[k])
        .map((k) => `<button type="button" class="chip" data-s="${k}">${G2B_STATUS[k][0]} ${counts[k]}</button>`).join('')}<button type="button" class="chip" id="g2csv">Download CSV</button></div>
      <div class="panel flush" id="g2list"></div>`;
    draw();
    $$('#g2chips [data-s]').forEach((b) => { b.onclick = () => { only = b.dataset.s; $$('#g2chips [data-s]').forEach((x) => x.classList.toggle('on', x === b)); draw(); }; });
    $('#g2csv').onclick = () => download(`gstr2b-match-${r.month}.csv`, rowsToCsv([['Status', 'Supplier', 'GSTIN', '2B number', '2B date', '2B taxable', '2B tax', 'Your bill', 'Supplier bill no.', 'Bill date', 'Bill taxable', 'Bill tax', 'Note'],
      ...r.rows.map((x) => [G2B_STATUS[x.status][0], x.supplier || nameOf.get(x.gstin) || '', x.gstin, x.b2b ? x.b2b.num : '', x.b2b ? x.b2b.date : '', x.b2b ? x.b2b.taxable : '', x.b2b ? x.b2b.tax : '',
        x.book ? x.book.number : '', x.book ? x.book.party_ref : '', x.book ? x.book.date : '', x.book ? x.book.taxable : '', x.book ? x.book.tax : '', x.note])]));
  };
  const run = async (read) => {
    err.hidden = true;
    res.innerHTML = '<div class="panel muted">Matching…</div>';
    try { show(await POST('/api/gst/2b-match', { month: read.month || month, rows: read.rows })); } catch (e) { res.innerHTML = ''; err.textContent = e.message; err.hidden = false; }
  };
  $('#g2file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      gstr2bLast = await read2b(file);
      if (gstr2bLast.month && gstr2bLast.month !== month) { toast(`This GSTR-2B is for ${monthName(gstr2bLast.month)}`); go(`gstr?tab=2b&month=${gstr2bLast.month}`); return; }
      gstr2bLast.month = gstr2bLast.month || month;
      run(gstr2bLast);
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  };
  if (gstr2bLast && gstr2bLast.month === month) run(gstr2bLast);
});
route(/^reports\/([a-z-]+)$/, async (el, m, q) => {
  const name = m[1], qs = q.toString();
  const d = await GET(`/api/reports/${name}?${qs}`);
  let html = '', csv = null;
  const amt = (r) => inr(r.amount);
  if (name === 'pnl') {
    html = `<div class="kpis"><div class="kpi"><div class="l">Sales</div><div class="v">${inr0(d.sales)}</div></div><div class="kpi"><div class="l">Gross profit</div><div class="v">${inr0(d.gross_profit)}</div><div class="s">${d.gross_margin}% margin</div></div>
      <div class="kpi"><div class="l">Net profit</div><div class="v ${d.net_profit >= 0 ? 'pos' : 'neg'}">${inr0(d.net_profit)}</div></div></div>
      <div class="grid g2"><div class="panel flush">${table([{ h: 'Income', k: 'name' }, { h: 'Amount', num: 1, f: amt }], d.income)}
      <div class="totals" style="padding:8px 14px"><div class="grand"><span>Total income</span><span>${inr(d.total_income)}</span></div></div></div>
      <div class="panel flush">${table([{ h: 'Expenses', k: 'name' }, { h: 'Amount', num: 1, f: amt }], d.expense)}
      <div class="totals" style="padding:8px 14px"><div class="grand"><span>Total expenses</span><span>${inr(d.total_expense)}</span></div></div></div></div>`;
    csv = [['Section', 'Account', 'Amount'], ...d.income.map((r) => ['Income', r.name, r.amount]), ...d.expense.map((r) => ['Expense', r.name, r.amount]), ['', 'Net profit', d.net_profit]];
  } else if (name === 'balance-sheet') {
    const sec = (t, rows, tot) => `<div class="panel flush">${table([{ h: t, k: 'name' }, { h: 'Amount', num: 1, f: amt }], rows)}<div class="totals" style="padding:8px 14px"><div class="grand"><span>Total ${t.toLowerCase()}</span><span>${inr(tot)}</span></div></div></div>`;
    html = `<div class="panel ${d.balanced ? '' : 'err'}">${d.balanced ? '✔ Assets = Liabilities + Equity' : 'The balance sheet does not balance. Contact support.'}</div>
      <div class="grid g2"><div>${sec('Assets', d.assets, d.total_assets)}</div><div>${sec('Liabilities', d.liabilities, d.total_liabilities)}${sec('Equity', d.equity, d.total_equity)}</div></div>`;
    csv = [['Section', 'Account', 'Amount'], ...d.assets.map((r) => ['Assets', r.name, r.amount]), ...d.liabilities.map((r) => ['Liabilities', r.name, r.amount]), ...d.equity.map((r) => ['Equity', r.name, r.amount])];
  } else if (name === 'trial-balance') {
    html = `<div class="panel flush">${table([{ h: 'Code', k: 'code' }, { h: 'Account', k: 'name' }, { h: 'Type', k: 'type', cls: 'hide-sm' }, { h: 'Debit', k: 'debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', k: 'credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }],
      d.rows, { foot: { name: d.balanced ? 'Total (balanced ✔)' : 'Total (NOT balanced)', debit: inr(d.total_debit), credit: inr(d.total_credit) } })}</div>`;
    csv = [['Code', 'Account', 'Debit', 'Credit'], ...d.rows.map((r) => [r.code, r.name, r.debit, r.credit])];
  } else if (name === 'gst') {
    const cols = [{ h: 'Rate', f: (r) => r.rate === '' ? '' : r.rate + '%' }, { h: 'Type', k: 'kind' }, { h: 'Taxable', num: 1, f: (r) => inr(r.taxable) }, { h: 'CGST', num: 1, f: (r) => inr(r.cgst) }, { h: 'SGST', num: 1, f: (r) => inr(r.sgst) }, { h: 'IGST', num: 1, f: (r) => inr(r.igst) }, { h: 'Total tax', num: 1, f: (r) => inr(r.tax) }];
    html = `<div class="kpis"><div class="kpi"><div class="l">Output tax (sales)</div><div class="v">${inr0(d.outward.total.tax)}</div></div><div class="kpi"><div class="l">Input credit (purchases)</div><div class="v">${inr0(d.inward.total.tax)}</div></div>
      <div class="kpi"><div class="l">Net GST payable</div><div class="v ${d.net_payable > 0 ? 'neg' : 'pos'}">${inr0(d.net_payable)}</div></div></div>
      <div class="panel flush"><div style="padding:14px 16px 0"><h3>Outward supplies (GSTR-1 / 3B)</h3></div>${table(cols, d.outward.rows.concat(d.outward.rows.length ? [{ ...d.outward.total, rate: '', kind: 'Total' }] : []), { empty: 'No sales in this period.' })}</div>
      <div class="panel flush"><div style="padding:14px 16px 0"><h3>Inward supplies (input tax credit)</h3></div>${table(cols, d.inward.rows.concat(d.inward.rows.length ? [{ ...d.inward.total, rate: '', kind: 'Total' }] : []), { empty: 'No purchases in this period.' })}</div>
      ${d.itc_reversed && d.itc_reversed.n ? `<div class="panel"><h3>Input credit reversed: goods lost or damaged on the way (GSTR-3B 4(B)(2))</h3>
        <p>${d.itc_reversed.n} write-off(s), goods worth ${inr(d.itc_reversed.value)}: CGST ${inr(d.itc_reversed.cgst)} · SGST ${inr(d.itc_reversed.sgst)} · IGST ${inr(d.itc_reversed.igst)} = <b>${inr(d.itc_reversed.tax)}</b> added to the GST payable.</p></div>` : ''}
      <p class="muted">Returns and credit notes are netted. <a href="#/gstr">GST Returns</a>: download the GSTR-1 file and match your GSTR-2B.</p>`;
    csv = [['Section', 'Rate', 'Type', 'Taxable', 'CGST', 'SGST', 'IGST'], ...d.outward.rows.map((r) => ['Outward', r.rate, r.kind, r.taxable, r.cgst, r.sgst, r.igst]), ...d.inward.rows.map((r) => ['Inward', r.rate, r.kind, r.taxable, r.cgst, r.sgst, r.igst]),
      ...(d.itc_reversed && d.itc_reversed.n ? [['ITC reversed (goods lost)', '', '', d.itc_reversed.value, d.itc_reversed.cgst, d.itc_reversed.sgst, d.itc_reversed.igst]] : [])];
  } else if (name === 'ageing') {
    const k = d.kind;
    html = `<div class="tabs">${['receivable', 'payable'].map((x) => `<a href="#/reports/ageing?kind=${x}" class="${k === x ? 'on' : ''}">${x === 'receivable' ? 'Receivables (customers)' : 'Payables (suppliers)'}</a>`).join('')}</div>
      <div class="panel flush">${table([{ h: 'Party', f: (r) => `<a href="#/party/${r.party_id}">${esc(r.party)}</a>` }, ...d.buckets.map((b) => ({ h: b === 'current' ? 'Not due' : b + ' days', k: b, num: 1, f: (r) => r[b] ? inr(r[b]) : '' })), { h: 'Total', k: 'total', num: 1, f: (r) => inr(r.total) }],
      d.rows, { foot: Object.fromEntries(['total', ...d.buckets].map((b) => [b, inr(d.totals[b])])), empty: 'Nothing outstanding.' })}</div>`;
    csv = [['Party', ...d.buckets, 'Total'], ...d.rows.map((r) => [r.party, ...d.buckets.map((b) => r[b]), r.total])];
  } else if (name === 'register') {
    const type = d.type;
    html = `<div class="tabs">${['INV', 'SRET', 'BILL', 'PRET', 'SO', 'PO', 'DN', 'GRN', 'QUOTE'].map((t) => `<a href="#/reports/register?type=${t}" class="${type === t ? 'on' : ''}">${esc(ME.doc_types[t].label)}</a>`).join('')}</div>
      <div class="panel flush">${table([{ h: 'Number', f: (r) => `<a href="#/doc/${r.id}">${esc(r.number)}</a>` }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Party', k: 'party' }, { h: 'GSTIN', k: 'gstin', cls: 'hide-sm' },
        { h: 'Taxable', num: 1, f: (r) => inr(r.taxable) }, { h: 'CGST', num: 1, cls: 'hide-sm', f: (r) => inr(r.cgst) }, { h: 'SGST', num: 1, cls: 'hide-sm', f: (r) => inr(r.sgst) }, { h: 'IGST', num: 1, cls: 'hide-sm', f: (r) => inr(r.igst) },
        { h: 'Total', num: 1, f: (r) => inr(r.total) }, { h: 'Status', f: (r) => badge(r.status) }], d.rows)}</div>`;
    csv = [['Number', 'Date', 'Party', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Status'], ...d.rows.map((r) => [r.number, r.date, r.party, r.gstin, r.taxable, r.cgst, r.sgst, r.igst, r.total, r.status])];
  } else throw new Error('Unknown report.');
  const titles = { pnl: 'Profit & Loss', 'balance-sheet': 'Balance Sheet', 'trial-balance': 'Trial Balance', gst: 'GST Summary', ageing: 'Outstanding (Ageing)', register: 'Registers' };
  const keep = ['kind', 'type'].filter((k) => q.get(k)).map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join('');
  el.innerHTML = head(titles[name] + ` <span class="muted" style="font-size:14px;font-weight:400">${esc(ME.org.name)}${d.from ? ` · ${fdate(d.from)} – ${fdate(d.to)}` : ` · as on ${fdate(d.to || d.as_of)}`}</span>`) + periodBar(d, keep) + html;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`reports/${name}?${new URLSearchParams(new FormData(e.target))}`); };
  $('#csv').onclick = () => download(`${name}.csv`, csv.map((r) => r.map(csvCell).join(',')).join('\n'));
});

/* ======================================================================= settings */
const SET_TABS = [['settings', 'Business & users'], ['settings/security', 'Security & privacy'], ['settings/print', 'Branding & print'], ['settings/numbering', 'Numbering'], ['settings/fields', 'Custom fields'], ['settings/business', 'Business type & menu'], ['settings/workflow', 'Orders & dispatch'], ['settings/roles', 'Roles']];
// a row of chips under the tabs of a long settings page: one tap goes to that section
function jumpBar(el) {
  const heads = [...el.querySelectorAll('.panel')].map((pn) => [pn, pn.querySelector('h2, h3')]).filter(([, h]) => h && h.textContent.trim());
  const tabs = el.querySelector('.tabs'); if (heads.length < 4 || !tabs) return;
  const bar = document.createElement('div'); bar.className = 'jumpbar'; bar.setAttribute('aria-label', 'Sections on this page');
  bar.innerHTML = '<span class="muted">Go to:</span>' + heads.map(([, h], i) => `<button type="button" class="chip" data-j="${i}">${esc(h.textContent.trim())}</button>`).join('');
  tabs.after(bar);
  bar.onclick = (e) => { const b = e.target.closest('[data-j]'); if (b) heads[+b.dataset.j][0].scrollIntoView({ behavior: 'smooth', block: 'start' }); };
}
const setTabs = (cur) => `<div class="tabs">${SET_TABS.filter(([h]) => h !== 'settings/roles' || ME.can.users).map(([h, t]) => `<a href="#/${h}" class="${h === cur ? 'on' : ''}">${t}</a>`).join('')}</div>`;

/* Shrink a photo on this device (canvas) so it fits the 64 KB limit; nothing is uploaded until it is small. */
async function shrinkImage(file, maxW, maxH) {
  if (!/^image\//.test(file.type)) throw new Error('Choose an image file (PNG or JPG).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Could not read this image.')); i.src = url; });
    for (const scale of [1, 0.75, 0.5, 0.35]) {
      const k = Math.min(1, maxW / img.width, maxH / img.height) * scale;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, cv.width, cv.height);
      let out = cv.toDataURL('image/png');
      if (out.length > 85000) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); out = cv.toDataURL('image/jpeg', 0.82); }
      if (out.length <= 85000) return out;
    }
    throw new Error('This image is too detailed. Try a simpler logo.');
  } finally { URL.revokeObjectURL(url); }
}

route(/^settings\/print$/, async (el) => {
  const cur = await GET('/api/settings/print');
  let P = cur.print, urls = { logo_url: cur.logo_url, sign_url: cur.sign_url };
  const canEdit = ME.can.settings;
  const sample = () => ({ type: 'INV', label: 'Sales Invoice', side: 'sales', number: 'INV-00042', date: ME.today, due_date: '', place_of_supply: ME.org.state || 'Rajasthan', inter_state: 0,
    party: { name: 'Mehta Stores', address: 'Shop 4, MI Road', phone: '9876543210' }, notes: '', balance: 1758, taxable: 1600, cgst: 79, sgst: 79, igst: 0, round_off: 0, total: 1758,
    lines: [{ item: 'Basmati Rice 5kg', hsn: '1006', qty: 2, unit: 'Bag', rate: 500, discount_pct: 0, gst_rate: 5, taxable: 1000, cgst: 25, sgst: 25, igst: 0, total: 1050 },
      { item: 'Steel Water Bottle', hsn: '7323', qty: 4, unit: 'Pcs', rate: 150, discount_pct: 0, gst_rate: 18, taxable: 600, cgst: 54, sgst: 54, igst: 0, total: 708 }],
    org: { ...ME.org, print: P }, ...urls });
  const v = (k) => esc(P[k] || '');
  el.innerHTML = head('Branding & print') + setTabs('settings/print') + `
    <div class="grid g2 brand-grid">
    <form class="panel" id="pf"><div class="err" hidden></div>
      <h2>Look</h2>
      <div class="seg seg-wrap" id="lay">${DESIGNS.map(([k, t]) => `<button type="button" data-l="${k}" class="${(P.layout || 'classic') === k ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>
      <p class="muted small">This is the default. Any single bill can use another design: pick it on the bill.</p>
      <div class="form" style="margin-top:12px">
        <label class="f">Brand colour<input type="color" name="color" value="${v('color')}"></label>
        <label class="f">Font<select name="font"><option value="sans" ${P.font !== 'serif' ? 'selected' : ''}>Clean (sans)</option><option value="serif" ${P.font === 'serif' ? 'selected' : ''}>Classic (serif)</option></select></label>
        <label class="f">Invoice title<input name="title" value="${v('title')}" placeholder="${ME.org.gstin ? 'TAX INVOICE' : 'INVOICE'}" maxlength="40"><small class="help">Leave empty for the normal title.</small></label>
      </div>
      <div class="imgs" id="imgs"></div>
      <p class="muted">Images are made small on your phone before upload (max 64 KB).</p>
      <h2>On the bill</h2>
      <div class="form">
        <label class="f">Signatory name<input name="signatory" value="${v('signatory')}" placeholder="e.g. Ravi Sharma" maxlength="60"></label>
        <label class="f check"><input type="checkbox" name="show_upi" ${P.show_upi !== false ? 'checked' : ''}> Show UPI QR on bill</label>
        <label class="f">Bank name<input name="bank_name" value="${v('bank_name')}" placeholder="State Bank of India"></label>
        <label class="f">Account number<input name="bank_account" value="${v('bank_account')}" inputmode="numeric" maxlength="20"></label>
        <label class="f">IFSC<input name="bank_ifsc" value="${v('bank_ifsc')}" maxlength="11" placeholder="SBIN0001234" style="text-transform:uppercase"></label>
        <label class="f">Branch<input name="bank_branch" value="${v('bank_branch')}" maxlength="60"></label>
        <label class="f wide">Terms &amp; conditions<textarea name="terms" rows="3" maxlength="600" placeholder="1. Goods once sold will not be taken back.">${v('terms')}</textarea></label>
        <label class="f wide">Footer note<input name="footer" value="${v('footer')}" maxlength="160" placeholder="Thank you for your business!"></label>
      </div>
      <h2>Shipping label (courier parcel)</h2>
      <div class="form">
        <label class="f">Label size<select name="ship_size">${[['4x6', '4 × 6 inch (courier thermal)'], ['100x50', '100 × 50 mm (small sticker)'], ['a4-4', 'A4 sheet, 4 labels']].map(([k, t]) => `<option value="${k}" ${(P.ship_size || '4x6') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="f">Note on label<input name="ship_note" value="${v('ship_note')}" maxlength="80" placeholder="e.g. Handle with care"></label>
        <label class="f wide">From (return address)<textarea name="ship_from" rows="2" maxlength="200" placeholder="Leave empty to use the business name and address">${v('ship_from')}</textarea></label>
        <label class="f check"><input type="checkbox" name="ship_phone" ${P.ship_phone !== false ? 'checked' : ''}> Show customer phone</label>
        <label class="f check"><input type="checkbox" name="ship_cod" ${P.ship_cod !== false ? 'checked' : ''}> Show COD amount when unpaid</label>
        <label class="f check"><input type="checkbox" name="ship_items" ${P.ship_items ? 'checked' : ''}> List the items on the label</label>
        <label class="f check wide"><input type="checkbox" name="ship_plain" ${P.ship_plain ? 'checked' : ''}> <span><b>Address only</b>: customer name, phone and address and your name, phone and address. No order number, pieces, amount (COD / prepaid) or items.</span></label>
      </div>
      <div class="row sticky-act"><span class="spacer"></span><button class="btn primary" ${canEdit ? '' : 'disabled'}>Save</button></div>
    </form>
    <div><h2 class="no-print">Preview</h2><div id="pv"></div></div></div>`;
  const form = $('#pf');
  const read = () => {
    const f = form.elements;
    return { ...P, layout: $('#lay .on').dataset.l, font: f.font.value, color: f.color.value, title: f.title.value, signatory: f.signatory.value, show_upi: f.show_upi.checked,
      bank_name: f.bank_name.value, bank_account: f.bank_account.value, bank_ifsc: f.bank_ifsc.value.toUpperCase(), bank_branch: f.bank_branch.value, terms: f.terms.value, footer: f.footer.value,
      ship_size: f.ship_size.value, ship_note: f.ship_note.value, ship_from: f.ship_from.value, ship_phone: f.ship_phone.checked, ship_cod: f.ship_cod.checked, ship_items: f.ship_items.checked, ship_plain: f.ship_plain.checked };
  };
  const preview = () => { P = read(); $('#pv').innerHTML = docPaper(sample()); fitPapers($('#pv')); };
  const box = (kind, title, url) => `<div class="imgbox"><b>${title}</b><div class="pv">${url ? `<img src="${esc(url)}" alt="">` : `<span class="muted">No ${title.toLowerCase()}</span>`}</div>
      <label class="btn sm">${url ? 'Change' : 'Upload'}<input type="file" accept="image/*" data-file="${kind}" hidden></label>${url ? `<button type="button" class="btn sm" data-rm="${kind}">Remove</button>` : ''}</div>`;
  const took = (r, msg) => { urls = { logo_url: r.logo_url, sign_url: r.sign_url }; ME.org.print = { ...ME.org.print, logo: r.print.logo, signature: r.print.signature };
    P = { ...read(), logo: r.print.logo, signature: r.print.signature }; paintImgs(); preview(); toast(msg); };
  const paintImgs = () => {
    $('#imgs').innerHTML = box('logo', 'Logo', urls.logo_url) + box('signature', 'Signature', urls.sign_url);
    $$('[data-file]', el).forEach((inp) => inp.onchange = async () => {
      const kind = inp.dataset.file, file = inp.files[0];
      if (!file) return;
      try {
        const data = await shrinkImage(file, kind === 'logo' ? 360 : 480, kind === 'logo' ? 360 : 180);
        took(await api('PUT', '/api/org/files/' + kind, { data }), kind === 'logo' ? 'Logo saved' : 'Signature saved');
      } catch (err) { toast(err.message, 'err'); }
    });
    $$('[data-rm]', el).forEach((b) => b.onclick = async () => {
      if (confirm('Remove this image?')) took(await api('DELETE', '/api/org/files/' + b.dataset.rm), 'Removed');
    });
  };
  paintImgs();
  $$('#lay button').forEach((b) => b.onclick = () => { $$('#lay button').forEach((x) => x.classList.toggle('on', x === b)); preview(); });
  form.addEventListener('input', preview);
  preview();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const box = $('.err', form); box.hidden = true;
    try { const r = await api('PUT', '/api/settings/print', read()); P = r.print; ME.org.print = P; toast('Print settings saved'); }
    catch (err) { box.hidden = false; box.textContent = err.message; }
  };
});

route(/^settings\/numbering$/, async (el) => {
  const { rows, fy } = await GET('/api/settings/series');
  const canEdit = ME.can.settings;
  const shown = rows.filter((r) => docFlowOk(r.type));
  const [fy1] = fy.split('-');
  const expand = (p) => p.replace(/\{FY\}/g, fy).replace(/\{YYYY\}/g, '20' + fy1).replace(/\{YY\}/g, fy1);
  const pv = (f) => expand(f.prefix.value) + String(Math.max(1, +f.next.value || 1)).padStart(Math.min(8, Math.max(1, +f.pad.value || 1)), '0');
  el.innerHTML = head('Numbering') + setTabs('settings/numbering') + `
    <p class="muted">Set how bill numbers look. Use <b>{FY}</b> for the year (${esc(fy)}), <b>{YY}</b> or <b>{YYYY}</b>. GST allows up to 16 characters.</p>
    <div class="series">${shown.map((r) => `<form class="panel" data-t="${r.type}"><div class="row"><b>${esc(r.label)}</b><span class="spacer"></span>${r.custom ? '<span class="badge b-ok">custom</span>' : ''}</div>
      <div class="err" hidden></div>
      <div class="form">
        <label class="f">Prefix<input name="prefix" value="${esc(r.prefix)}" maxlength="20" autocapitalize="characters"></label>
        <label class="f">Digits<input name="pad" type="number" min="1" max="8" value="${r.pad}" inputmode="numeric"></label>
        <label class="f">Next number<input name="next" type="number" min="1" value="${r.next}" inputmode="numeric"></label>
        <label class="f check"><input type="checkbox" name="fy_reset" ${r.fy_reset ? 'checked' : ''}> Start from 1 every year</label>
      </div>
      <div class="row" style="margin-top:10px"><span>Next: <b class="pvw">${esc(r.preview)}</b></span><span class="spacer"></span>
        ${r.custom && canEdit ? '<button type="button" class="btn sm" data-reset>Use default</button>' : ''}<button class="btn sm primary" ${canEdit ? '' : 'disabled'}>Save</button></div></form>`).join('')}</div>`;
  $$('.series form', el).forEach((f) => {
    f.addEventListener('input', () => { $('.pvw', f).textContent = pv(f.elements); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const box = $('.err', f); box.hidden = true;
      const v = f.elements;
      try { await api('PUT', '/api/settings/series/' + f.dataset.t, { prefix: v.prefix.value.trim(), pad: +v.pad.value, next: +v.next.value, fy_reset: v.fy_reset.checked }); toast('Numbering saved'); render(); }
      catch (err) { box.hidden = false; box.textContent = err.message; }
    };
    const rs = $('[data-reset]', f);
    if (rs) rs.onclick = async () => { await api('DELETE', '/api/settings/series/' + f.dataset.t); toast('Back to default'); render(); };
  });
});

const CF_ENT = [['item', 'Items'], ['party', 'Customers & suppliers'], ['doc', 'Bills & documents']];
const CF_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown']];
route(/^settings\/fields$/, async (el) => {
  const { rows } = await GET('/api/settings/fields');
  const canEdit = ME.can.settings;
  const refresh = async (r) => { ME.org.fields = r.rows; dirty('items', 'parties'); render(); };
  const form = (entity, f = {}) => modal(f.id ? 'Edit field' : 'New field', [
    { k: 'label', label: 'Field name', value: f.label, placeholder: entity === 'doc' ? 'e.g. Vehicle no' : entity === 'item' ? 'e.g. Size' : 'e.g. Drug licence no' },
    { k: 'type', label: 'Type', type: 'select', options: CF_TYPES.map(([v, t]) => ({ v, t })), value: f.type || 'text' },
    { k: 'options', label: 'Dropdown options (comma separated)', value: (f.options || []).join(', '), placeholder: 'S, M, L', wide: true },
    ...(entity === 'doc' ? [{ k: 'side', label: 'Use on', type: 'select', options: [{ v: '', t: 'All documents' }, { v: 'sales', t: 'Sales only' }, { v: 'purchase', t: 'Purchase only' }], value: f.side || '' }] : []),
    { k: 'required', label: 'Must fill', type: 'checkbox', value: f.required }, { k: 'on_print', label: 'Show on printed bill', type: 'checkbox', value: f.on_print },
  ], async (v) => refresh(f.id ? await api('PUT', '/api/settings/fields/' + f.id, v) : await POST('/api/settings/fields', { ...v, entity })).then(() => toast('Field saved')));
  el.innerHTML = head('Custom fields') + setTabs('settings/fields') + `
    <p class="muted">Add your own fields, like Size, Batch, Vehicle no or Drug licence. They show in forms and lists, and can print on bills.</p>
    ${CF_ENT.map(([e, t]) => { const list = rows.filter((f) => f.entity === e); return `<div class="panel flush"><div class="row" style="padding:12px 16px"><h2 style="margin:0">${t}</h2><span class="spacer"></span>
      ${canEdit ? `<button class="btn sm" data-add="${e}">+ Add field</button>` : ''}</div>
      ${table([{ h: 'Field', k: 'label' }, { h: 'Type', f: (f) => esc((CF_TYPES.find(([k]) => k === f.type) || [])[1] || f.type) + (f.type === 'select' ? `<div class="muted">${esc(f.options.join(', '))}</div>` : '') },
        { h: 'Rules', f: (f) => [f.required ? 'must fill' : '', f.on_print ? 'on bill' : '', f.side ? f.side + ' only' : ''].filter(Boolean).join(' · ') },
        { h: '', f: (f) => canEdit ? `<button class="btn sm" data-ed="${f.id}">Edit</button> <button class="btn sm danger" data-rm="${f.id}">Delete</button>` : '' }], list,
      { empty: 'No fields yet.' })}</div>`; }).join('')}`;
  $$('[data-add]', el).forEach((b) => b.onclick = () => form(b.dataset.add));
  $$('[data-ed]', el).forEach((b) => b.onclick = () => { const f = rows.find((x) => x.id === +b.dataset.ed); form(f.entity, f); });
  $$('[data-rm]', el).forEach((b) => b.onclick = async () => {
    const f = rows.find((x) => x.id === +b.dataset.rm);
    if (confirm(`Delete the field ${f.label}? Values already saved stay in old records but are hidden.`)) { await refresh(await api('DELETE', '/api/settings/fields/' + f.id)); toast('Field deleted'); }
  });
});

const AREA_LABEL = { sales: 'Sales & POS', purchase: 'Purchase', items: 'Items & stock', masters: 'Customers & suppliers', finance: 'Money (receipts, payments, expenses)',
  khata: 'Khata book', reports: 'Reports, profit & costs', settings: 'Settings', gate: 'Gate register (vehicles in / out)' };
/* Settings → Roles: every role made to measure. What it may see and change, limits it works under, and the menu its
   users get (a user's own menu, set in Settings → Users, still wins). The server enforces the rights and limits. */
const LIMIT_TEXT = [['no_cancel', 'Cannot cancel bills, payments or entries'], ['no_credit', 'No udhaar: every sale is paid in full'],
  ['hide_costs', 'Cannot see purchase rates, cost or profit'],
  ['no_dispatch', 'Cannot save Delivery Notes (godown staff without the selling right)'],
  ['must_scan', 'Must scan every item before dispatch (Pack & check)']];
const limitSummary = (r) => [r.no_cancel && 'no cancelling', r.no_credit && 'no udhaar', r.hide_costs && 'no costs', r.no_dispatch && 'no dispatch', r.must_scan && 'scan to dispatch',
  r.max_discount !== null && r.max_discount !== undefined && `max ${r.max_discount}% off`,
  r.backdate_days === 0 ? 'today\'s date only' : r.backdate_days ? `${r.backdate_days} days back at most` : ''].filter(Boolean).join(' · ') || '—';
const uiSummary = (ui) => (ui.screens ? `${ui.screens.length} screens` : ui.job ? JOBS[ui.job].t.split(':')[0] : '—') + (ui.home ? ` → opens on ${(NAV.flatMap(([, x]) => x).find(([h]) => h === ui.home) || ['', ui.home])[1]}` : '');
/* ready-made starting points for a new role */
const ROLE_STARTS = {
  guard: { t: 'Gate guard', perms: { view: ['gate'], edit: ['gate'] }, rules: { no_cancel: true, hide_costs: true }, ui: { job: 'gate' } },
  counter: { t: 'Billing counter', perms: { view: ['sales', 'items', 'masters', 'khata'], edit: ['sales', 'masters', 'khata'] },
    rules: { no_cancel: true, hide_costs: true, max_discount: 5, backdate_days: 0 }, ui: { job: 'counter' } },
  godown: { t: 'Godown / receiving', perms: { view: ['purchase', 'items', 'masters', 'gate'], edit: ['purchase', 'items', 'gate'] }, rules: { no_cancel: true }, ui: { job: 'store' } },
  packer: { t: 'Packing & dispatch (godown)', perms: { view: ['sales', 'items', 'masters'], edit: ['items'] }, rules: { no_cancel: true, hide_costs: true, must_scan: true }, ui: { job: 'packer' } },
  field: { t: 'Field salesman', perms: { view: ['sales', 'items', 'masters', 'khata'], edit: ['sales', 'masters', 'khata'] },
    rules: { no_cancel: true, hide_costs: true, max_discount: 10, backdate_days: 1 }, ui: { job: 'sales' } },
};
route(/^settings\/roles$/, async (el) => {
  const { rows, builtin, areas } = await GET('/api/roles');
  const allScreens = NAV.flatMap(([, x]) => x);
  const same = (a, b) => [...a].sort().join() === [...b].sort().join();
  const editor = (r, kind) => {
    const isNew = kind === 'custom' && !r.id;
    const fields = kind === 'custom' ? [{ k: 'name', label: 'Role name', value: r.name, placeholder: 'e.g. Counter staff', wide: true }] : [];
    if (isNew) fields.push({ k: 'start', label: 'Start from', type: 'select', options: [{ v: '', t: 'Blank' }, ...Object.entries(ROLE_STARTS).map(([k, s]) => ({ v: k, t: s.t })),
      ...builtin.map((b) => ({ v: 'b:' + b.key, t: `A copy of ${b.name}` }))] });
    const f = modal(kind === 'builtin' ? `Role: ${r.name}` : isNew ? 'New role' : `Role: ${r.name}`, fields, async (v, fm) => {
      const perms = { view: $$('[data-v]', fm).filter((x) => x.checked).map((x) => x.dataset.v), edit: $$('[data-e]', fm).filter((x) => x.checked).map((x) => x.dataset.e) };
      const num = (k) => (fm.elements[k].value === '' ? null : +fm.elements[k].value);
      const rules = { ...Object.fromEntries(LIMIT_TEXT.map(([k]) => [k, fm.elements[k].checked])), max_discount: num('max_discount'), backdate_days: num('backdate_days') };
      const pick = fm.elements.rjob.value === 'pick', screens = $$('[data-scr]', fm).filter((x) => x.checked).map((x) => x.dataset.scr);
      if (pick && !screens.length) throw new Error('Tick at least one screen, or choose a job.');
      const ui = pick ? { screens, home: fm.elements.rhome.value } : { job: fm.elements.rjob.value, home: fm.elements.rhome.value };
      if (kind === 'builtin') await api('PUT', '/api/roles/builtin/' + r.key, { perms: same(perms.edit, r.standard.edit) && same(perms.view, r.standard.view) ? null : perms, rules, ui });
      else if (r.id) await api('PUT', '/api/roles/' + r.id, { name: v.name, perms, rules, ui });
      else await POST('/api/roles', { name: v.name, perms, rules, ui });
      toast('Role saved. Its users see the change the next time they open the app.'); render();
    }, { intro: kind === 'builtin' ? `<p class="muted">${r.users} user${r.users === 1 ? '' : 's'} have this role. Tick what it needs; <b>Back to standard</b> undoes everything.</p>` : '' });
    const ru = r.rules || {}, ui = r.ui || {};
    $('.form', f).insertAdjacentHTML('afterend', `
      <h3 class="rh">What they can see and change</h3>
      <div class="tbl-wrap"><table class="t perm"><thead><tr><th>Area</th><th>See</th><th>Add &amp; edit</th></tr></thead><tbody>${areas.map((a) => `<tr><td>${esc(AREA_LABEL[a] || a)}</td>
        <td><input type="checkbox" data-v="${a}" aria-label="See ${esc(a)}"></td><td><input type="checkbox" data-e="${a}" aria-label="Edit ${esc(a)}"></td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">“Add &amp; edit” also lets them see it.</p>
      <h3 class="rh">Limits</h3>
      <div class="limits">${LIMIT_TEXT.map(([k, t]) => `<label class="check"><input type="checkbox" name="${k}"> ${esc(t)}</label>`).join('')}
        <label class="f">Biggest discount they may give (%)<input type="number" name="max_discount" min="0" max="100" step="any" placeholder="no limit" inputmode="decimal"><small class="help">Rate cuts and discounts together, below the item's sale price.</small></label>
        <label class="f">Bills and payments may be dated back (days)<input type="number" name="backdate_days" min="0" max="3650" step="1" placeholder="any date" inputmode="numeric"><small class="help">0 = today only.</small></label></div>
      <h3 class="rh">Menu for this role</h3>
      <div class="form"><label class="f">What do they do?<select name="rjob"><option value="">As usual for the role</option>${Object.entries(JOBS).map(([k, j]) => `<option value="${k}">${esc(j.t)}</option>`).join('')}<option value="pick">Let me tick the screens</option></select></label>
        <label class="f">App opens on<select name="rhome"><option value="">The job's usual screen</option>${allScreens.map(([h, t]) => `<option value="${h}">${esc(t)}</option>`).join('')}</select></label></div>
      <div class="scr-grid">${NAV.filter(([g]) => g).map(([g, x]) => `<fieldset><legend>${esc(g)}</legend>${x.map(([h, t]) => `<label class="check"><input type="checkbox" data-scr="${h}"> ${esc(t)}</label>`).join('')}</fieldset>`).join('')}</div>
      ${kind === 'builtin' && (r.changed || r.ui.job || r.ui.screens || r.ui.home || limitSummary(r.rules) !== '—') ? '<div class="row" style="margin-top:12px"><button type="button" class="btn danger" id="rstd">Back to standard</button></div>' : ''}`);
    const fill = (perms, rules, u) => {
      $$('[data-v]', f).forEach((x) => { x.checked = perms.view.includes(x.dataset.v); });
      $$('[data-e]', f).forEach((x) => { x.checked = perms.edit.includes(x.dataset.e); });
      for (const [k] of LIMIT_TEXT) f.elements[k].checked = !!rules[k];
      f.elements.max_discount.value = rules.max_discount ?? ''; f.elements.backdate_days.value = rules.backdate_days ?? '';
      f.elements.rjob.value = u.screens ? 'pick' : u.job || ''; f.elements.rhome.value = u.home || '';
      $$('[data-scr]', f).forEach((x) => { delete x.dataset.touched; x.checked = !!(u.screens && u.screens.includes(x.dataset.scr)); });
      syncScreens();
    };
    const syncScreens = () => {
      const j = f.elements.rjob.value, pick = j === 'pick', job = JOBS[j] || JOBS[kind === 'builtin' ? ROLE_JOB[r.key] || 'all' : 'all'];
      $$('[data-scr]', f).forEach((x) => { x.disabled = !pick; if (!pick) x.checked = job.screens ? job.screens.includes(x.dataset.scr) : !simple() || !ADVANCED.has(x.dataset.scr); });
    };
    $$('[data-e]', f).forEach((x) => x.addEventListener('change', () => { if (x.checked) $(`[data-v="${x.dataset.e}"]`, f).checked = true; }));
    f.elements.rjob.onchange = syncScreens;
    if (f.elements.start) f.elements.start.onchange = (e) => {
      const s = e.target.value, b = s.startsWith('b:') && builtin.find((x) => x.key === s.slice(2)), t = ROLE_STARTS[s];
      if (b) fill(b.perms, b.rules, b.ui); else if (t) fill(t.perms, t.rules, t.ui); else fill({ view: [], edit: [] }, {}, {});
      if (t && !f.elements.name.value) f.elements.name.value = t.t;
    };
    fill(r.perms || { view: [], edit: [] }, ru, ui);
    if ($('#rstd', f)) $('#rstd', f).onclick = async () => {
      if (!confirm(`Put ${r.name} back to its standard rights, with no limits and the usual menu?`)) return;
      try { await api('DELETE', '/api/roles/builtin/' + r.key); $('#modal-root').innerHTML = ''; toast('Back to standard'); render(); } catch (e) { toast(e.message, 'err'); }
    };
  };
  el.innerHTML = head('Roles', `<button class="btn primary" id="newrole">+ New role</button>`) + setTabs('settings/roles') + `
    <p class="muted">Every role can be made to fit your shop: what it can see and change, limits (no cancelling, no udhaar, a discount cap, no old dates) and the menu its people get. Give a role to a user in <a href="#/settings">Business &amp; users</a>.</p>
    <div class="panel flush"><h2 class="ph">Built-in roles</h2>${table([{ h: 'Role', f: (r) => `<b>${esc(r.name)}</b>${r.changed ? ' <span class="badge b-partial">changed</span>' : ''}` },
      { h: 'Can change', cls: 'hide-sm', f: (r) => esc(r.perms.edit.map((a) => AREA_LABEL[a] || a).join(', ') || '—') },
      { h: 'Limits', f: (r) => esc(limitSummary(r.rules)) }, { h: 'Menu', cls: 'hide-sm', f: (r) => esc(uiSummary(r.ui)) }, { h: 'Users', k: 'users', num: 1 },
      { h: '', f: (r) => (r.locked ? '<span class="muted small">owner only</span>' : `<button class="btn sm" data-bed="${r.key}">Change</button>`) }], builtin)}</div>
    <div class="panel flush"><h2 class="ph">Your own roles</h2>${table([{ h: 'Role', f: (r) => `<b>${esc(r.name)}</b>` }, { h: 'Can change', cls: 'hide-sm', f: (r) => esc(r.perms.edit.map((a) => AREA_LABEL[a] || a).join(', ') || '—') },
      { h: 'Limits', f: (r) => esc(limitSummary(r.rules)) }, { h: 'Menu', cls: 'hide-sm', f: (r) => esc(uiSummary(r.ui)) }, { h: 'Users', k: 'users', num: 1 },
      { h: '', f: (r) => `<button class="btn sm" data-ed="${r.id}">Edit</button> <button class="btn sm danger" data-rm="${r.id}">Delete</button>` }], rows,
    { empty: 'None yet. + New role starts from a gate guard, billing counter, godown or salesman, or a copy of a built-in role.' })}</div>`;
  $('#newrole').onclick = () => editor({}, 'custom');
  $$('[data-bed]', el).forEach((b) => b.onclick = () => editor(builtin.find((r) => r.key === b.dataset.bed), 'builtin'));
  $$('[data-ed]', el).forEach((b) => b.onclick = () => editor(rows.find((r) => r.id === +b.dataset.ed), 'custom'));
  $$('[data-rm]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this role?')) return;
    try { await api('DELETE', '/api/roles/' + b.dataset.rm); toast('Role deleted'); render(); } catch (e) { toast(e.message, 'err'); }
  });
});

/* ======================================================================= security & privacy (src/security.js) */
/* Locked backup: the backup is locked on this device (PBKDF2 → AES-GCM, gzip first) before it is saved; only the password opens it */
const LOCKED = 'smarttrader-locked-backup';
const b64s = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64s = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const gzip = async (u8, pack) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(pack ? new CompressionStream('gzip') : new DecompressionStream('gzip'))).arrayBuffer());
async function lockKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function lockBackup(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iterations = 310000;
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await lockKey(pass, salt, iterations), await gzip(new TextEncoder().encode(text), true));
  return JSON.stringify({ format: LOCKED, v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64s(salt) }, cipher: 'AES-GCM', iv: b64s(iv), data: b64s(new Uint8Array(ct)) });
}
async function unlockBackup(o, pass) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64s(o.iv) }, await lockKey(pass, unb64s(o.kdf.salt), +o.kdf.iterations || 310000), unb64s(o.data));
    return JSON.parse(new TextDecoder().decode(await gzip(new Uint8Array(pt), false)));
  } catch (e) { throw new Error('Wrong password, or the file is damaged.'); }
}

/* Two-step sign-in set-up: scan the QR in an authenticator app, type its code, keep the backup codes */
async function twoStepSetup(box, done) {
  box.innerHTML = '<p class="muted">Getting a key…</p>';
  let s;
  try { s = await POST('/api/me/2fa/start'); } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<ol class="steps"><li>On your phone, open an authenticator app: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> or any other (free on the Play Store / App Store).</li>
      <li>Tap <b>+</b> and <b>Scan a QR code</b>, and scan this:<div class="qrbox" id="tsqr" style="margin:8px 0"></div>
        <span class="muted small">Cannot scan? Choose "Enter a setup key" and type: <b class="mono">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</b></span></li>
      <li>Type the 6-digit code the app now shows for SmartTrader:</li></ol>
    <form id="tsf" class="row"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required style="max-width:160px">
      <button class="btn primary">Turn on</button></form><div class="err" hidden></div>
    <p class="muted small" lang="hi">फ़ोन के authenticator ऐप से QR स्कैन करें और ऐप में दिखा 6 अंकों का कोड यहाँ लिखें।</p>`;
  qrInto($('#tsqr', box), s.uri);
  $('#tsf', box).onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.err', box); err.hidden = true;
    try { const r = await POST('/api/me/2fa/enable', { code: e.target.code.value }); showBackupCodes(box, r.backup_codes, done); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  };
}
function showBackupCodes(box, codes, done) {
  const text = `SmartTrader backup codes for ${ME.user.email}\nEach code works once, if your phone is lost.\n\n${codes.join('\n')}\n`;
  box.innerHTML = `<div class="panel okbox">✓ Two-step sign-in is on. From now on SmartTrader asks for the code from your phone after the password.</div>
    <h3>Your backup codes</h3><p>If your phone is lost or reset, each of these works once instead of the code. Write them down or print them and keep them away from the phone.</p>
    <div class="codes mono">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row" style="margin-top:10px"><button type="button" class="btn" id="cdl">Download</button><button type="button" class="btn" id="cpr">Print</button><button type="button" class="btn primary" id="cok">I have kept them safe</button></div>`;
  $('#cdl', box).onclick = () => download('smarttrader-backup-codes.txt', text, 'text/plain');
  $('#cpr', box).onclick = () => { const w = window.open('', '_blank'); if (w) { w.document.write(`<pre style="font:16px monospace">${esc(text)}</pre>`); w.document.close(); w.print(); } };
  $('#cok', box).onclick = () => done();
}
/* A business that asks everyone for two-step sign-in: this user sets it up before anything else opens */
function twoStepGate() {
  $('#app').innerHTML = `<div class="auth"><div class="box"><div class="brandline"><i>&#x2197;</i>SmartTrader ERP</div>
    <h1>Turn on two-step sign-in</h1><p>${esc(ME.org.name)} asks everyone to sign in with the password <b>and</b> a code from their phone, so a stolen password alone cannot open the business.</p>
    <div id="tsbox"></div><p class="muted"><a href="#" id="tsout">Sign out</a></p></div></div>`;
  twoStepSetup($('#tsbox'), async () => { await boot(); });
  $('#tsout').onclick = async (e) => { e.preventDefault(); await POST('/api/auth/logout'); ME = null; remember(false); location.hash = ''; renderAuth(); };
}

route(/^settings\/security$/, async (el) => {
  const d = await GET('/api/security'), owner = ME.user.role_key === 'owner', when = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = head('Settings') + setTabs('settings/security') + `
    <div class="panel"><h2>Two-step sign-in ${d.two_step ? badge('ok') : ''}</h2>
      <p class="muted">After the password, SmartTrader asks for a 6-digit code from an app on your phone. Someone who learns your password still cannot get in.
        <span lang="hi">पासवर्ड के बाद फ़ोन के ऐप का कोड भी लगेगा, तो पासवर्ड चोरी होने पर भी कोई अंदर नहीं आ सकता।</span></p>
      <div id="tsbox">${d.two_step ? `<div class="row"><button class="btn" id="tsnew">New backup codes</button><button class="btn" id="tsoff" ${d.require_2fa ? 'disabled title="Your business needs it on"' : ''}>Turn off</button></div>`
        : '<button class="btn primary" id="tson">Turn on two-step sign-in</button>'}</div></div>
    ${owner ? `<div class="panel"><h2>For everyone in the business</h2>
      <label class="mode-opt"><input type="checkbox" id="req2" ${d.require_2fa ? 'checked' : ''} ${d.two_step ? '' : 'disabled'}> <span><b>Ask everyone for two-step sign-in</b><br>
        <span class="muted">Staff without it are asked to set it up when they next open SmartTrader, before anything else.${d.two_step ? '' : ' Turn it on for yourself first.'}</span></span></label>
      ${table([{ h: 'User', f: (u) => `<b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div>` }, { h: 'Two-step', f: (u) => (u.totp_on ? badge('ok') : '<span class="muted">off</span>') },
        { h: '', f: (u) => (u.totp_on && u.role !== 'owner' ? `<button class="btn sm" data-reset2="${u.id}" data-n="${esc(u.name)}">Reset (lost phone)</button>` : '') }], d.users.filter((u) => u.active))}</div>` : ''}
    <div class="panel flush"><div style="padding:14px 16px 0"><h2 style="margin:0">Sign-in history</h2><p class="muted small">${d.all ? 'Everyone in the business' : 'Your sign-ins'}, the last 100, kept 180 days. A sign-in you do not recognise? Change your password and tap "Sign out everywhere".</p></div>
      ${table([{ h: 'When', f: (r) => when(r.at) }, ...(d.all ? [{ h: 'Who', f: (r) => esc(r.name || r.email) }] : []), { h: 'Device', k: 'device' }, { h: 'IP', cls: 'hide-sm', f: (r) => `<span class="mono small">${esc(r.ip)}</span>` },
        { h: 'Result', f: (r) => (r.ok ? `<span class="badge b-paid">signed in</span><div class="muted small">${esc(r.how)}</div>` : `<span class="badge b-overdue">${esc(r.how || 'refused')}</span>`) }], d.rows, { empty: 'No sign-ins recorded yet.' })}</div>
    <div class="panel"><h2>Your data, your control</h2><ul class="small">
      <li><b>Each business is walled off.</b> Every record carries your business, and every request is checked against it. Staff see only what their role allows.</li>
      <li><b>No ads, no selling.</b> Your bills, customers and stock are used only to run your account. They are never sold or shown to anyone else.</li>
      <li><b>Passwords</b> are stored only as a salted hash; the authenticator key is kept encrypted.</li>
      <li><b>Take it all, any time:</b> a full backup (also locked with your own password), an Excel copy, or Tally XML. Settings → Backup.</li>
      <li><b>Customer links</b> (bills, khata) can be turned off one by one or all at once. WhatsApp chats are kept 6 months, the sign-in history 180 days.</li>
      <li><b>Close the business</b> and every record is deleted after 7 days (the payment records of your SmartTrader plan stay, as tax law needs).</li></ul></div>
    ${owner ? `<div class="panel" id="closebox"><h2>Close this business</h2>${d.close_after
      ? `<p class="neg"><b>This business will be deleted on ${fdate(d.close_after.slice(0, 10))}.</b> Until then only you can sign in. Download a backup if you want to keep a copy.</p><button class="btn primary" id="closecancel">Keep the business (cancel closing)</button>`
      : `<p class="muted">Deletes every bill, customer, item, payment, khata entry and login of <b>${esc(ME.org.name)}</b>. You get 7 days to change your mind; staff cannot sign in during that time. Download a backup first.</p>
        <button class="btn danger" id="closego">Close and delete this business…</button>`}</div>` : ''}`;
  const passCode = (title, submit, fn, extra = []) => modal(title, [...extra, { k: 'password', label: 'Your password', type: 'password' }, ...(d.two_step ? [{ k: 'code', label: 'Code from your authenticator app (or a backup code)' }] : [])], fn, { submit });
  if ($('#tson')) $('#tson').onclick = () => twoStepSetup($('#tsbox'), () => { ME.user.two_step = true; render(); });
  if ($('#tsnew')) $('#tsnew').onclick = () => passCode('New backup codes', 'Make new codes', async (v) => {
    const r = await POST('/api/me/2fa/backup-codes', v); setTimeout(() => showBackupCodes($('#tsbox'), r.backup_codes, () => render()), 0);
  });
  if ($('#tsoff')) $('#tsoff').onclick = () => passCode('Turn off two-step sign-in', 'Turn off', async (v) => { await POST('/api/me/2fa/disable', v); toast('Two-step sign-in is off'); render(); });
  if ($('#req2')) $('#req2').onchange = async (e) => {
    try { await api('PUT', '/api/settings/require-2fa', { on: e.target.checked }); toast(e.target.checked ? 'Everyone needs two-step sign-in now' : 'Two-step sign-in is up to each user'); }
    catch (x) { e.target.checked = !e.target.checked; toast(x.message, 'err'); }
  };
  $$('[data-reset2]', el).forEach((b) => { b.onclick = async () => {
    if (!confirm(`Turn off two-step sign-in for ${b.dataset.n}? They sign in with the password alone until they set it up again on the new phone.`)) return;
    try { await POST(`/api/users/${b.dataset.reset2}/2fa-reset`); toast('Reset'); render(); } catch (x) { toast(x.message, 'err'); }
  }; });
  if ($('#closego')) $('#closego').onclick = () => passCode('Close and delete this business', 'Close the business', async (v) => {
    const r = await POST('/api/org/close', v); ME = await GET('/api/me'); shell(); toast(`The business will be deleted on ${fdate(r.close_after.slice(0, 10))}`); render();
  }, [{ k: 'name', label: `Type the business name: ${ME.org.name}` }]);
  if ($('#closecancel')) $('#closecancel').onclick = async () => { await POST('/api/org/close/cancel'); ME = await GET('/api/me'); shell(); toast('Closing cancelled. The business stays.'); render(); };
});
route(/^settings$/, async (el, m, q) => {
  const o = ME.org, canUsers = ME.can.users;
  const users = canUsers ? await GET('/api/users') : { rows: [], roles: [], custom_roles: [] };
  const roleOpts = [...users.roles.filter((r) => r !== 'owner').map((r) => ({ v: r, t: r })), ...(users.custom_roles || []).map((r) => ({ v: 'c:' + r.id, t: r.name }))];
  const audit = canUsers ? (await GET('/api/audit')).rows : [];
  el.innerHTML = head('Settings') + setTabs('settings') + `
    <div class="panel"><h2>Features</h2><div class="row">
      <label class="mode-opt"><input type="radio" name="mode" value="simple" ${simple() ? 'checked' : ''}> <span><b>Simple</b><br><span class="muted">Billing, purchase bills, returns, credit notes, stock, khata, POS, accounts. Best for most shops.</span></span></label>
      <label class="mode-opt"><input type="radio" name="mode" value="advanced" ${simple() ? '' : 'checked'}> <span><b>Advanced</b><br><span class="muted">Adds quotations, sales/purchase orders, delivery notes, GRN, gate entry & gate pass, stock count, pick lists, e-invoice & e-way bill.</span></span></label>
    </div><p class="muted">Switching only shows or hides menus. No data is deleted.</p></div>
    <form class="panel" id="org"><h2>Business profile</h2><div class="err" hidden></div><div class="form">
      <label class="f">Business name<input name="name" value="${esc(o.name)}"></label><label class="f">GSTIN<input name="gstin" value="${esc(o.gstin)}" maxlength="15" placeholder="Leave empty if not registered"></label>
      <label class="f">State<input name="state" list="states" autocomplete="off" value="${esc(o.state)}"></label>
      <label class="f">City<input name="city" value="${esc(o.city || '')}"></label><label class="f">PIN code<input name="pincode" value="${esc(o.pincode || '')}" maxlength="6" inputmode="numeric"></label>
      <label class="f">Business email<input name="email" type="email" value="${esc(o.email || '')}"></label><label class="f">Phone<input name="phone" value="${esc(o.phone)}"></label>
      <label class="f">UPI ID<input name="upi_id" value="${esc(o.upi_id)}" placeholder="shop@okhdfcbank"><small class="help">Customers pay you here. Shown as a QR on bills.</small></label>
      <label class="f">Financial year starts (MM-DD)<input name="fy_start" value="${esc(o.fy_start)}"></label>
      <label class="f">Customer message language<select name="msg_lang">${LANGS.map(([v, t]) => `<option value="${v}" ${(o.msg_lang || 'hl') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <small class="help">The default for bills, reminders and receipts. Set it per customer too, or change it before each send.</small></label>
      <label class="f">Udyam registration no.<input name="udyam" value="${esc(o.udyam || '')}" maxlength="19" placeholder="UDYAM-RJ-17-0012345"><small class="help">For interest on late payments under the MSMED Act (Vasooli → Recovery file).</small></label>
      <label class="f">LUT ARN (exports without IGST)<input name="lut" value="${esc(o.lut || '')}" maxlength="60" placeholder="AD080424012345X (2026-27)"><small class="help">Printed on export invoices made under LUT / bond.</small></label>
      <label class="f wide">Address (printed on invoices)<textarea name="address" rows="2">${esc(o.address)}</textarea></label></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" ${ME.can.settings ? '' : 'disabled'}>Save profile</button></div></form>
    ${vaadaSettings()}
    ${ME.can.settings ? `<form class="panel" id="apprf"><h2>Approvals</h2><div class="form"><label class="f">Purchase orders above (₹) need approval<input name="po_above" type="number" min="0" step="1" inputmode="numeric" value="${(o.approvals || {}).po_above || ''}" placeholder="0 = no approval">
        <small class="help">A purchase order above this amount made by staff waits until the owner or an admin approves it. Yours go through straight away.</small></label></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary">Save</button></div></form>` : ''}
    ${ME.can.settings && ME.wa_auto ? `<div class="panel" id="autowa"><h2>Automatic WhatsApp reminders</h2>
      <p class="muted">Every morning, customers who are due a reminder on the Vasooli schedule get a WhatsApp message by themselves, from SmartTrader's WhatsApp Business number: their name, your business, the amount due and a link to the bills with your UPI. Nobody gets two in a day; VIP and promised customers follow the same rules as on the Vasooli screen.</p>
      ${(ME.plan.features || []).includes('autowa') ? `<label class="mode-opt"><input type="checkbox" id="awon" ${o.auto_wa ? 'checked' : ''}> <span><b>Send reminders automatically</b><br><span class="muted">10 am to 1 pm, every day.</span></span></label>
        ${o.auto_wa_note ? `<p class="muted small">Last run: ${esc(o.auto_wa_note.replace(/^more /, ''))}</p>` : ''}
        <div class="row" style="margin-top:8px"><span class="spacer"></span><button type="button" class="btn" id="awrun" ${o.auto_wa ? '' : 'disabled'}>Send today's now</button></div>`
        : '<p>Included in the <b>Growth</b> and <b>Business</b> plans. <a href="#/plan">See plans</a></p>'}</div>` : ''}
    ${ME.can.settings && ME.wa_bot ? `<div class="panel" id="wabot"><h2>WhatsApp bot</h2>
      <p class="muted">Customers write to SmartTrader's WhatsApp number and get an answer at once: <b>hisab</b> (what is due, every bill with its UPI link), <b>bill</b>, <b>pay</b>, a pay date, or a message to you. Answers are free on WhatsApp's official API (the customer wrote first), and a reminder to a customer who wrote in the last 24 hours goes free too. What they write comes to your <a href="#/wa-inbox">WhatsApp Inbox</a>.</p>
      <label class="mode-opt"><input type="checkbox" id="wabon" ${o.wa_bot ? 'checked' : ''}> <span><b>Answer my customers on WhatsApp</b><br><span class="muted">Customers with their mobile number on your list are found by it; others scan your QR.</span></span></label>
      ${o.wa_bot && ME.wa_bot_link ? `<div class="row qrbox" style="margin-top:12px"><div id="wabqr"></div><div><b>Your WhatsApp link</b><br><a href="${esc(ME.wa_bot_link)}" target="_blank" rel="noopener" class="small">${esc(ME.wa_bot_link)}</a>
        <p class="muted small">Print the QR at the counter (“Scan, get your hisab on WhatsApp”), or send the link with bills.</p>
        <div class="row"><button type="button" class="btn sm" id="wabcopy">Copy link</button><a class="btn sm" href="#/wa-poster">Print QR poster</a></div></div></div>` : ''}</div>` : ''}
    ${canUsers ? `<div class="panel flush"><div class="row" style="padding:14px 16px"><h2 style="margin:0">Users</h2><span class="spacer"></span><button class="btn" id="adduser">+ Add user</button></div>
      ${table([{ h: 'Name', k: 'name' }, { h: 'Email', k: 'email', cls: 'hide-sm' }, { h: 'Role', f: (u) => u.role_key === 'owner' ? 'owner' : `<select data-role="${u.id}" aria-label="Role">${roleOpts.map((o) => `<option value="${esc(o.v)}" ${o.v === u.role_key ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>` },
        { h: 'Menu', f: (u) => u.role_key === 'owner' && u.id !== ME.user.id ? '' : `<button class="btn sm" data-menu="${u.id}">${esc(menuLabel(u))}</button>` },
        { h: 'Status', f: (u) => u.paused ? `${badge('partial')}<div class="muted">over plan limit</div>` : u.active ? badge('ok') : badge('cancelled') },
        { h: '', f: (u) => u.role === 'owner' ? '' : `<button class="btn sm" data-pw="${u.id}" data-email="${esc(u.email)}">Set password</button> <button class="btn sm" data-u="${u.id}" data-a="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` }], users.rows)}
      <div class="muted" style="padding:10px 16px">Need your own role? <a href="#/settings/roles">Make one in Roles</a>. Built-in: <b>admin</b> everything · <b>accountant</b> money, bills, reports · <b>store</b> stock, items, purchase · <b>sales</b> quotes, orders, invoices, khata, customer receipts.</div></div>` : ''}
    <form class="panel" id="pw"><h2>Change your password</h2><div class="err" hidden></div><div class="form"><label class="f">Current password<input type="password" name="current" autocomplete="current-password"></label>
      <label class="f">New password<input type="password" name="password" autocomplete="new-password" minlength="8"></label></div><div class="row" style="margin-top:12px"><button type="button" class="btn" id="logoutall">Sign out everywhere</button><span class="spacer"></span><button class="btn">Change password</button></div>
      <p class="muted">Changing your password signs you out on every other device. "Sign out everywhere" does that without changing it.</p></form>
    ${ME.can.settings ? `<div class="panel"><h2>Customer links</h2><p class="muted">Invoice and khata links you sent on WhatsApp or SMS work for anyone who has them. If a link went to the wrong person, turn it off on that invoice or khata page. To turn off every link of this business at once:</p>
      <div class="row"><button type="button" class="btn danger" id="revokeall">Turn off all customer links</button></div></div>` : ''}
    ${ME.user.role === 'owner' ? `<div class="panel" id="backup-panel"><h2>Backup</h2><p class="muted">Download every record of your business (invoices, parties, items, stock, khata, payments, accounts) in one file. Keep it safe on your phone, PC or Google Drive. Your data is yours: you can take it with you anytime.<br>अपने पूरे कारोबार का डेटा एक फ़ाइल में डाउनलोड करें।</p>
      <div class="row"><button type="button" class="btn" id="backup">Download full backup (.json)</button><button type="button" class="btn primary" id="backuplock">Download locked backup</button><button type="button" class="btn" id="backupx">Download as Excel</button></div>
      <p class="muted small"><b>Locked backup:</b> the file is locked on this device with a password you choose. Anyone who finds it (a lost pen drive, a shared folder) sees only scrambled data. Keep the password safe: without it nobody, not even SmartTrader, can open the file.</p>
      <p class="muted small">The .json file can be restored into SmartTrader. The Excel file is for reading: one sheet each for bills, items, customers, payments, khata and accounts, amounts in rupees.</p>
      <h3 style="margin-top:16px">Google Drive auto-backup</h3><div id="gdrive"><span class="muted">Checking…</span></div>
      <h3 style="margin-top:16px">Backup to a folder on this computer</h3><div id="fbox"><span class="muted">Checking…</span></div>
      <h3 style="margin-top:16px">Restore from a backup</h3><div id="restorebox"><span class="muted">Checking…</span></div></div>` : ''}
    <p class="muted">Selling SmartTrader to other businesses? <a href="#/admin">Open the admin panel</a> (needs the ADMIN_KEY secret).</p>
    ${canUsers ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Audit trail</h3></div>${table([{ h: 'When', f: (a) => new Date(a.at).toLocaleString('en-IN') }, { h: 'User', k: 'user' }, { h: 'Action', k: 'action' }, { h: 'Detail', k: 'detail', cls: 'hide-sm' }], audit.slice(0, 100))}</div>` : ''}`;
  jumpBar(el);
  if ($('#wabon')) $('#wabon').onchange = async (e) => {
    try { await api('PUT', '/api/settings/wa-bot', { on: e.target.checked }); ME = await GET('/api/me'); shell(); wireInstall(); toast(e.target.checked ? 'WhatsApp bot on' : 'WhatsApp bot off'); render(); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); }
  };
  if ($('#wabqr') && ME.wa_bot_link) qrInto($('#wabqr'), ME.wa_bot_link);
  if ($('#wabcopy')) $('#wabcopy').onclick = async () => { try { await navigator.clipboard.writeText(ME.wa_bot_link); toast('Link copied'); } catch (e) { toast(ME.wa_bot_link); } };
  if ($('#awon')) $('#awon').onchange = async (e) => {
    try { await api('PUT', '/api/settings/auto-wa', { on: e.target.checked }); ME = await GET('/api/me'); toast(e.target.checked ? 'Automatic reminders on' : 'Automatic reminders off'); render(); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); }
  };
  if ($('#awrun')) $('#awrun').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await POST('/api/settings/auto-wa/run'); ME = await GET('/api/me'); toast(`${r.sent} sent${r.free ? ` (${r.free} free)` : ''}${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped (no mobile or sent STOP)` : ''}`); render(); }
    catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  };
  if ($('#apprf')) $('#apprf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings/approvals', { po_above: e.target.elements.po_above.value || 0 }); ME = await GET('/api/me'); toast('Saved'); } catch (err) { toast(err.message, 'err'); }
  };
  $$('[name=mode]', el).forEach((r) => r.onchange = async () => {
    try { await api('PUT', '/api/org/mode', { mode: r.value }); ME = await GET('/api/me'); shell(); wireInstall(); toast(r.value === 'simple' ? 'Simple mode on' : 'Advanced features on'); render(); }
    catch (e) { toast(e.message, 'err'); render(); }
  });
  const sub = (id, fn) => { $(id).onsubmit = async (e) => { e.preventDefault(); const b = $('.err', e.target); b.hidden = true; try { await fn(Object.fromEntries(new FormData(e.target))); } catch (err) { b.hidden = false; b.textContent = err.message; } }; };
  sub('#org', async (v) => { await api('PUT', '/api/org', v); ME = await GET('/api/me'); shell(); wireInstall(); toast('Profile saved'); render(); });
  sub('#pw', async (v) => { await POST('/api/me/password', v); toast('Password changed'); $('#pw').reset(); });
  if ($('#logoutall')) $('#logoutall').onclick = async () => {
    if (!confirm('Sign out of SmartTrader on every device, including this one?')) return;
    await POST('/api/me/logout-all'); ME = null; remember(false); location.hash = ''; renderAuth();
  };
  if ($('#backup')) $('#backup').onclick = () => fileDownload('/api/export/backup');
  if ($('#backuplock')) $('#backuplock').onclick = () => modal('Download locked backup', [{ k: 'p1', label: 'Password for the file (8+ characters)', type: 'password' }, { k: 'p2', label: 'Type it again', type: 'password' }],
    async (v) => {
      if (String(v.p1).length < 8) throw new Error('Use at least 8 characters.');
      if (v.p1 !== v.p2) throw new Error('The two passwords are not the same.');
      const f = await fetchFile('/api/export/backup');
      download(f.name.replace(/\.json$/, '') + '.stbackup', await lockBackup(await f.blob.text(), v.p1), 'application/octet-stream');
      toast('Locked backup downloaded');
    }, { submit: 'Lock and download', intro: '<p class="muted">The backup is locked here, on this device, before it is saved. Nothing about the password is sent anywhere.</p>' });
  if ($('#backupx')) $('#backupx').onclick = () => fileDownload('/api/export/excel');
  folderUi(); folderShow();
  // after render() has put the page at the top
  if (q && q.get('backup')) setTimeout(() => { const bp = $('#backup-panel'); if (bp) bp.scrollIntoView({ block: 'start' }); }, 0);
  /* Restore: like restoring WhatsApp on a new phone, into an empty business only */
  const restoreUi = async () => {
    const box = $('#restorebox'); if (!box) return;
    const chk = await GET('/api/restore/check').catch(() => null);
    if (!chk) { box.innerHTML = '<p class="muted">Could not check right now.</p>'; return; }
    if (!chk.empty) {
      box.innerHTML = '<p class="muted">Restore brings a backup into a <b>new, empty</b> business, like restoring WhatsApp on a new phone. This business already has records, so to restore, make a new SmartTrader account and open Settings → Backup there.</p>';
      return;
    }
    const day = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    box.innerHTML = `<p class="muted">This business is empty, so you can bring back a backup: bills, parties, items, stock, payments, khata, accounts and settings. Staff logins are not in a backup; add them again under Users. Recurring bills come back paused. बैकअप से पूरा डेटा वापस लाएँ।</p>
      <div class="row"><label class="btn primary">Choose backup file (.json or locked)<input type="file" id="rfile" accept=".json,.stbackup,application/json" hidden></label>
      <button type="button" class="btn" id="rdrive">Restore from Google Drive</button></div><div id="rlist"></div>`;
    const run = async (fn, label) => {
      if (!confirm(`Restore ${label}? It fills this empty business with the backup's records.`)) return;
      box.insertAdjacentHTML('beforeend', '<p class="muted" id="rbusy">Restoring… this can take a minute. <span class="spin"></span></p>');
      try {
        const r = await fn();
        dirty('items', 'accounts', 'parties'); ME = await GET('/api/me'); shell();
        toast(`Restored ${r.records} records${r.staff_not_restored ? `. Add your ${r.staff_not_restored} staff login(s) again under Users.` : ''}`);
        go('dashboard');
      } catch (e) { const b = $('#rbusy'); if (b) b.remove(); toast(e.message, 'err'); }
    };
    $('#rfile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 30e6) { toast('This file is too big to restore here.', 'err'); return; }
      let data = null; try { data = JSON.parse(await f.text()); } catch (err) { data = null; }
      if (data && data.format === LOCKED) {
        const raw = data;
        data = await new Promise((done) => modal('Open the locked backup', [{ k: 'p', label: 'Password of the file', type: 'password' }],
          async (v) => { done(await unlockBackup(raw, v.p)); }, { submit: 'Open' }));
      }
      if (!data || data.format !== 'smarttrader-backup') { toast('That is not a SmartTrader backup file.', 'err'); return; }
      run(() => POST('/api/restore', data), `the backup of ${(data.org && data.org.name) || 'your business'} from ${day(data.exported_at) || 'an earlier date'}`);
    };
    $('#rdrive').onclick = async () => {
      const l = $('#rlist'); l.innerHTML = '<p class="muted">Looking in your Google Drive…</p>';
      try {
        const { files } = await GET('/api/gdrive/backups');
        l.innerHTML = files.length ? `<p class="muted">Pick the backup to bring back (newest first):</p><div class="row">${files.slice(0, 15).map((f) =>
          `<button type="button" class="btn sm" data-rf="${esc(f.id)}" data-rn="${esc(day(f.created))}">${esc(day(f.created) || f.name)} · ${Math.max(1, Math.round(f.size / 1024))} KB</button>`).join('')}</div>`
          : '<p class="muted">No SmartTrader backups were found in this Google Drive.</p>';
        $$('[data-rf]', l).forEach((b) => { b.onclick = () => run(() => POST('/api/restore/drive', { file_id: b.dataset.rf }), `the Google Drive backup of ${b.dataset.rn}`); });
      } catch (e) { l.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
  };
  restoreUi();
  /* Google Drive auto-backup, like WhatsApp's chat backup. What happened on Google's page stays on screen (not a
     passing toast) until the owner does something, with what to do next. */
  const dq = q && q.get('drive');
  const DRIVE_SAID = {
    ok: ['ok', 'Google Drive connected. First backup saved.'],
    okempty: ['ok', 'Google Drive connected. Backups start once you have records; to bring back an old backup, use Restore below.'],
    fail: ['err', 'Google Drive is connected, but the first backup failed. Tap <b>Back up now</b>; if it fails again, the reason shows below.'],
    denied: ['err', 'Google says permission was not given. If you pressed <b>Cancel</b>, tap <b>Connect Google Drive</b> again and press <b>Continue</b>. If Google showed <b>“Access blocked”</b>, send us a screenshot on WhatsApp so we can fix it.'],
    cancel: ['err', 'Google Drive was not connected. Tap <b>Connect Google Drive</b> and finish the steps on Google’s page.'],
    noscope: ['err', 'Google did not give access to Drive files. Tap <b>Connect Google Drive</b> again; if Google shows a box for Google Drive, tick it before pressing Continue.'],
    norefresh: ['err', 'Google did not give lasting access. Open <b>myaccount.google.com → Security → Third-party apps</b>, remove SmartTrader (docbrisk.com), then connect again.'],
    bad: ['err', 'That Google page was open too long or came from another login. Tap <b>Connect Google Drive</b> again.'],
    signin: ['err', 'You were signed out while Google was open. Tap <b>Connect Google Drive</b> again. On an iPhone home-screen app, open <b>erp.docbrisk.com</b> in Safari to connect.'],
  };
  let driveNote = dq && DRIVE_SAID[dq] ? DRIVE_SAID[dq] : null;
  const drive = async () => {
    const box = $('#gdrive'); if (!box) return;
    const g = await GET('/api/gdrive').catch(() => null);
    const note = () => driveNote ? `<div class="panel ${driveNote[0] === 'ok' ? 'okbox' : 'warnbox'}" style="margin:0 0 10px" role="status">${driveNote[1]}</div>` : '';
    if (!g) { box.innerHTML = '<p class="muted">Could not check Google Drive right now.</p>'; return; }
    const when = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    if (!g.configured) { box.innerHTML = '<p class="muted">Google Drive backup is being switched on for SmartTrader. Until then, use “Download full backup” and keep the file in your Drive.</p>'; return; }
    if (!g.connected) {
      box.innerHTML = `${note()}<p class="muted">Connect your Google Drive once. SmartTrader then saves a full backup there every day by itself, like WhatsApp does. It can see only its own backup files, nothing else in your Drive. On Google’s page, choose your Google account and press <b>Continue</b>. रोज़ अपने आप Google Drive में बैकअप।</p>
        <div class="row"><button type="button" class="btn primary" id="gconnect">Connect Google Drive</button></div>`;
      $('#gconnect').onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = 'Opening Google…';
        try { location.href = (await POST('/api/gdrive/connect')).url; }
        catch (err) { e.target.disabled = false; e.target.textContent = 'Connect Google Drive'; toast(err.message, 'err'); }
      };
      return;
    }
    if (driveNote && driveNote[0] !== 'ok' && dq !== 'fail') driveNote = null;    // connected now: an older complaint no longer applies
    // links open in the owner's own Google Drive (on a phone, in the Drive app), where only they can see the files
    const gid = (s) => encodeURIComponent(String(s || ''));
    box.innerHTML = `${note()}<p>Backing up to <b>${esc(g.email || 'your Google Drive')}</b>, folder “SmartTrader Backup”.</p>
      <p class="muted">${g.last_backup_at ? `Last backup: <b>${when(g.last_backup_at)}</b>${g.last_size ? ` · ${Math.max(1, Math.round(g.last_size / 1024))} KB` : ''}${g.last_checked ? ' · <span class="okc" title="Google’s checksum of the stored file matches ours">&#10003; checked</span>' : ''}.` : 'No backup yet.'}
        The newest 30 are kept${g.excel ? ', each with an Excel copy you can open without SmartTrader' : ''}.</p>
      ${g.last_error ? `<div class="panel err" style="margin:8px 0">${esc(g.last_error)}</div>` : ''}
      ${g.folder_id ? `<div class="row" style="margin:0 0 8px"><a class="btn sm" href="https://drive.google.com/drive/folders/${gid(g.folder_id)}" target="_blank" rel="noopener">Open the folder in Google Drive</a>
        ${g.excel && g.last_excel_id ? `<a class="btn sm" href="https://drive.google.com/file/d/${gid(g.last_excel_id)}/view" target="_blank" rel="noopener">Open the latest Excel</a>` : ''}</div>` : ''}
      <label class="check"><input type="checkbox" id="gexcel" ${g.excel ? 'checked' : ''}> Also save an Excel copy (to read on a phone or PC; the .json is the one that restores)</label>
      <div class="row"><label class="f inline-f">Back up<select id="gevery"><option value="day" ${g.every !== 'week' ? 'selected' : ''}>Every day</option><option value="week" ${g.every === 'week' ? 'selected' : ''}>Every week</option></select></label>
        <button type="button" class="btn" id="gnow">Back up now</button><span class="spacer"></span><button type="button" class="btn danger" id="goff">Disconnect</button></div>
      <p class="muted small">To keep these files on your computer too, install <b>Google Drive for desktop</b> and mark this folder “Available offline”. On a phone, open a file in the Drive app → ⋮ → <b>Make available offline</b>.</p>`;
    $('#gevery').onchange = async (e) => { try { await api('PUT', '/api/gdrive', { every: e.target.value }); toast('Saved'); } catch (err) { toast(err.message, 'err'); } };
    $('#gexcel').onchange = async (e) => {
      try { await api('PUT', '/api/gdrive', { excel: e.target.checked }); toast(e.target.checked ? 'An Excel copy goes with every backup' : 'Only the .json backup will be saved'); drive(); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); }
    };
    $('#gnow').onclick = async (e) => {
      driveNote = null;
      e.target.disabled = true; e.target.textContent = 'Backing up…';
      try { const r = await POST('/api/gdrive/backup'); toast(`Backed up ${r.records} records to Google Drive${r.excel ? ', with an Excel copy' : ''}`); } catch (err) { toast(err.message, 'err'); }
      drive();
    };
    $('#goff').onclick = async () => {
      if (!confirm('Stop backing up to Google Drive? Backups already in your Drive stay there.')) return;
      try { await api('DELETE', '/api/gdrive'); toast('Disconnected'); drive(); } catch (err) { toast(err.message, 'err'); }
    };
  };
  drive();
  if (driveNote) {
    toast(driveNote[0] === 'ok' ? driveNote[1].replace(/<[^>]+>/g, '') : 'Google Drive: see the note in the Google Drive box.', driveNote[0]);
    history.replaceState(null, '', location.pathname + '#/settings');      // a reload does not repeat the message
    setTimeout(() => { const gd = $('#gdrive'); if (gd) gd.scrollIntoView({ block: 'center' }); }, 0);
  }
  // back from Google in another tab or app window: show the new state when this one is looked at again
  driveRefresh = drive;
  if ($('#revokeall')) $('#revokeall').onclick = async () => {
    if (!confirm('Turn off ALL invoice and khata links you have shared? Customers who open an old link will see that it is not valid. Sharing again makes a new link.')) return;
    try { const r = await POST('/api/org/revoke-links'); toast(`${r.invoices + r.khata} link(s) turned off`); } catch (e) { toast(e.message, 'err'); }
  };
  wireVaadaSettings(el);
  if ($('#adduser')) $('#adduser').onclick = () => modal('Add user', [{ k: 'name', label: 'Name' }, { k: 'email', label: 'Email', type: 'email' },
    { k: 'role', label: 'Role', type: 'select', options: roleOpts }, { k: 'password', label: 'Temporary password (8+ chars)', type: 'password' }],
  async (v) => { await POST('/api/users', v); toast('User added. Share the email and password with them.'); render(); });
  $$('[data-pw]', el).forEach((b) => b.onclick = () => modal('Set a new password', [{ k: 'password', label: 'New password (8+ chars)', type: 'password' }],
    async (v) => { await api('PUT', '/api/users/' + b.dataset.pw, { password: v.password }); toast('Password changed. Share it with ' + b.dataset.email + '.'); },
    { submit: 'Set password', intro: 'For ' + esc(b.dataset.email) + ', who forgot their password. They will be signed out on other devices.' }));
  $$('[data-u]', el).forEach((b) => b.onclick = async () => { await api('PUT', '/api/users/' + b.dataset.u, { active: b.dataset.a !== '1' }); render(); });
  $$('[data-role]', el).forEach((s) => s.onchange = async () => { try { await api('PUT', '/api/users/' + s.dataset.role, { role: s.value }); toast('Role changed'); } catch (e) { toast(e.message, 'err'); render(); } });
  $$('[data-menu]', el).forEach((b) => b.onclick = () => menuEditor(users.rows.find((u) => u.id === +b.dataset.menu)));
});

/* Settings → Users → Menu: which screens a user sees and where the app opens for them */
const roleJob = (u) => ROLE_JOB[u.role_key] || 'all';
const menuLabel = (u) => (u.ui.screens ? `${u.ui.screens.length} screens` : u.ui.job ? JOBS[u.ui.job].t.split(':')[0] : `By role: ${JOBS[roleJob(u)].t.split(':')[0]}`);
function menuEditor(u) {
  const ui = u.ui, all = NAV.flatMap(([, x]) => x);
  const f = modal(`Menu for ${u.name}`, [
    { k: 'job', label: 'What does this person do?', type: 'select', value: ui.screens ? 'pick' : ui.job,
      options: [{ v: '', t: `As the role gives (${JOBS[roleJob(u)].t})` }, ...Object.entries(JOBS).map(([k, j]) => ({ v: k, t: j.t })), { v: 'pick', t: 'Let me tick the screens' }] },
    { k: 'home', label: 'App opens on', type: 'select', value: ui.home, options: [{ v: '', t: 'The job\'s usual screen' }, ...all.map(([h, t]) => ({ v: h, t }))] }],
  async (v) => {
    const screens = $$('[data-scr]', f).filter((x) => x.checked).map((x) => x.dataset.scr);
    if (v.job === 'pick' && !screens.length) throw new Error('Tick at least one screen.');
    await api('PUT', `/api/users/${u.id}/ui`, v.job === 'pick' ? { screens, home: v.home } : { job: v.job, home: v.home });
    if (u.id === ME.user.id) { ME = await GET('/api/me'); shell(); }
    toast('Menu saved. It shows the next time they open the app.'); render();
  }, { intro: '<p class="muted">Only what they see changes. What they may do still comes from their role.</p>' });
  $('.form', f).insertAdjacentHTML('afterend', `<div class="scr-grid">${NAV.filter(([g]) => g).map(([g, x]) => `<fieldset><legend>${esc(g)}</legend>${x.map(([h, t]) =>
    `<label class="check"><input type="checkbox" data-scr="${h}"> ${esc(t)}</label>`).join('')}</fieldset>`).join('')}</div>`);
  const sync = () => {
    const j = f.elements.job.value, pick = j === 'pick', job = JOBS[j || roleJob(u)] || JOBS.all;
    $$('[data-scr]', f).forEach((x) => {
      x.disabled = !pick;
      if (!pick) x.checked = job.screens ? job.screens.includes(x.dataset.scr) : !simple() || !ADVANCED.has(x.dataset.scr);
      else if (ui.screens && !x.dataset.touched) x.checked = ui.screens.includes(x.dataset.scr);
    });
  };
  $$('[data-scr]', f).forEach((x) => x.addEventListener('change', () => { x.dataset.touched = '1'; }));
  f.elements.job.onchange = sync;
  sync();
}

/* ======================================================================= gate entry (inward) / gate pass (outward) */
route(/^gate\/(in|out)$/, async (el, m, q) => {
  const kind = m[1], inward = kind === 'in';
  const status = q.get('status') || (inward ? 'open' : '');
  const { rows } = await GET(`/api/gate?kind=${kind}&status=${status}`);
  el.innerHTML = head(inward ? 'Gate Entry (inward)' : 'Gate Pass (outward)', `<button class="btn primary" id="new">+ ${inward ? 'New gate entry' : 'New gate pass'}</button>`) + `
    <div class="tabs">${(inward ? [['open', 'At gate / not received'], ['grn_done', 'Received (GRN done)'], ['rejected', 'Rejected'], ['', 'All']] : [['', 'All'], ['open', 'Inside (not exited)'], ['closed', 'Exited']])
      .map(([k, t]) => `<a href="#/gate/${kind}${k ? '?status=' + k : (inward ? '?status=' : '')}" class="${status === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <p class="muted">${inward ? 'Log every vehicle at the gate before unloading: scan the QR on the supplier\'s e-invoice and the supplier, bill number and value fill in by themselves. The godown then receives the goods against it (Receive Goods), so nothing comes in without a gate record.'
      : 'Every dispatch leaves with a gate pass linked to its delivery note or invoice, with vehicle and exit time.'}</p>
    <div class="panel flush">${table([
      { h: 'No.', f: (r) => `<b>${esc(r.number)}</b><div class="muted">${fdate(r.date)} ${esc(r.time_in || '')}${r.time_out ? ' → ' + esc(r.time_out) : ''}</div>` },
      { h: inward ? 'Supplier' : 'Party', f: (r) => esc(r.party || '-') + (r.ref_number ? `<div class="muted">${esc(r.ref_type)} <a href="#/doc/${r.ref_doc_id}">${esc(r.ref_number)}</a></div>` : '')
        + (r.bill_number ? `<div class="muted">Bill <a href="#/doc/${r.bill_id}">${esc(r.bill_number)}</a></div>` : '') + (r.value ? `<div class="muted">Invoice ${inr(r.value)}</div>` : '') },
      { h: 'Vehicle', f: (r) => `${esc(r.vehicle_no)}<div class="muted">${esc(r.driver_name || '')} ${esc(r.driver_phone || '')}</div>` },
      { h: inward ? 'Challan / Invoice' : 'LR / Transporter', cls: 'hide-sm', f: (r) => inward ? `${esc(r.challan_no || '')}${r.packages ? `<div class="muted">${r.packages} pkgs${r.weight_kg ? ', ' + r.weight_kg + ' kg' : ''}</div>` : ''}` : `${esc(r.lr_no || '')}<div class="muted">${esc(r.transporter || '')}</div>` },
      { h: 'Status', f: (r) => r.status === 'grn_done' ? `${badge('closed')} <a href="#/doc/${r.grn_id}">${esc(r.grn_number || 'GRN')}</a>` : badge(r.status === 'open' ? (inward ? 'open' : 'partial') : r.status) },
      { h: '', f: (r) => r.status !== 'open' ? (r.time_out || !inward ? '' : `<button class="btn sm" data-exit="${r.id}">Vehicle out</button>`)
        : inward ? `${ME.can.purchase ? `<a class="btn sm primary" href="#/receive?ge=${r.id}">Receive</a> ` : ''}<button class="btn sm danger" data-rej="${r.id}">Reject</button>`
          : `<button class="btn sm primary" data-exit="${r.id}">Vehicle out</button>` }],
    rows, { empty: inward ? 'No vehicles waiting at the gate.' : 'No gate passes yet.' })}</div>`;
  $$('[data-exit]', el).forEach((b) => b.onclick = async () => { await POST(`/api/gate/${b.dataset.exit}/exit`, {}); toast('Exit time saved'); render(); });
  $$('[data-rej]', el).forEach((b) => b.onclick = () => modal('Reject at gate', [{ k: 'reason', label: 'Reason (wrong item, damaged, no PO…)', wide: true }],
    async (v) => { await POST(`/api/gate/${b.dataset.rej}/reject`, v); toast('Rejected'); render(); }));
  $('#new').onclick = async () => {
    const parties = (await master('parties')).filter((p) => inward ? p.kind !== 'customer' : true);
    const refs = [];      // a guard who may not see orders or bills just logs the vehicle
    for (const t of inward ? ['PO'] : ['DN', 'INV']) refs.push(...(await GET(`/api/docs?type=${t}&limit=100`).catch(() => ({ rows: [] }))).rows.filter((d) => d.status !== 'cancelled' && (!inward || d.status !== 'closed')));
    const f = modal(inward ? 'New gate entry' : 'New gate pass', [
      { k: 'party_id', label: inward ? 'Supplier' : 'Party', type: 'select', options: [{ v: '', t: '—' }, ...opts(parties)] },
      { k: 'ref_doc_id', label: inward ? 'Against purchase order (optional)' : 'Against delivery note / invoice', type: 'select', options: [{ v: '', t: '—' }, ...refs.map((d) => ({ v: d.id, t: `${d.number} · ${d.party || ''}` }))] },
      { k: 'vehicle_no', label: 'Vehicle number', placeholder: 'RJ14GA1234' }, { k: 'driver_name', label: 'Driver name' }, { k: 'driver_phone', label: 'Driver mobile', type: 'tel' },
      ...(inward ? [{ k: 'challan_no', label: 'Supplier challan / invoice no.' }, { k: 'challan_date', label: 'Challan date', type: 'date' }, { k: 'value', label: 'Invoice value (₹)', type: 'number' },
        { k: 'party_gstin', label: 'Supplier GSTIN (if not in the list)', more: true }, { k: 'irn', label: 'e-invoice IRN', more: true }] : []),
      { k: 'transporter', label: 'Transporter' }, { k: 'lr_no', label: 'LR / docket no.' },
      { k: 'packages', label: 'Packages / boxes', type: 'number', value: 0 }, { k: 'weight_kg', label: 'Weight (kg)', type: 'number', value: 0 },
      { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'by_hand', label: 'By hand / courier (no vehicle)', type: 'checkbox' },
      ...(!inward ? [{ k: 'exited', label: 'Vehicle has already left', type: 'checkbox' }] : []),
      { k: 'remarks', label: 'Remarks', wide: true }],
    async (v) => {
      const refSel = refs.find((d) => d.id === +v.ref_doc_id);
      if (refSel && !v.party_id) { const p = parties.find((x) => x.name === refSel.party); if (p) v.party_id = p.id; }
      const g = await POST('/api/gate', { ...v, kind, party_id: +v.party_id || null, ref_doc_id: +v.ref_doc_id || null });
      toast(`${g.number} saved${g.bill_id ? ': matched to the purchase bill' : ''}`); render();
    }, { submit: 'Save', intro: inward ? `<div class="row qrrow"><button type="button" class="btn" id="geqr">&#128247; Scan e-invoice QR</button>
      <input id="geqrtxt" placeholder="or scan with a 2D scanner here" aria-label="e-invoice QR text" autocomplete="off"></div><p class="muted small" id="geqrnote"></p>` : '' });
    if (!inward) return;
    // the signed QR on a GST e-invoice carries the supplier's GSTIN, bill number, date, value and IRN
    const fill = (text) => {
      const e = einvoiceQr(text), note = $('#geqrnote', f);
      if (!e) { note.textContent = 'This is not a GST e-invoice QR. Type the details instead.'; return false; }
      const p = parties.find((x) => (x.gstin || '').toUpperCase() === e.gstin);
      if (p) f.elements.party_id.value = p.id; else f.elements.party_gstin.value = e.gstin;
      f.elements.challan_no.value = e.no; f.elements.challan_date.value = e.date; f.elements.value.value = e.value; f.elements.irn.value = e.irn;
      note.innerHTML = `Read: <b>${esc(p ? p.name : e.gstin)}</b>, bill ${esc(e.no)}, ${fdate(e.date)}, ${inr(e.value)}${e.buyer && ME.org.gstin && e.buyer !== ME.org.gstin.toUpperCase() ? ' · <b class="neg">this bill is made out to another GSTIN</b>' : ''}`;
      return true;
    };
    $('#geqr', f).onclick = () => cameraScan((code) => fill(code), { once: true });
    $('#geqrtxt', f).addEventListener('change', (e) => { if (fill(e.target.value)) e.target.value = ''; });
    $('#geqrtxt', f).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (fill(e.target.value)) e.target.value = ''; } });
  };
  if (takeNew(q)) $('#new').click();
});

/* A GST e-invoice's QR code is a signed token (JWT); its payload's data holds SellerGstin, BuyerGstin, DocNo, DocDt
   (dd/mm/yyyy), TotInvVal and Irn. Read here for the gate and Receive screens (the signature is NIC's; not checked). */
function einvoiceQr(text) {
  const parts = String(text || '').trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const raw = new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), (ch) => ch.charCodeAt(0)));
    const j = JSON.parse(raw), d = typeof j.data === 'string' ? JSON.parse(j.data) : j.data || j;
    if (!d || !/^\d{2}[A-Z0-9]{13}$/.test(String(d.SellerGstin || '').toUpperCase())) return null;
    const [dd, mm, yy] = String(d.DocDt || '').split('/');
    return { gstin: String(d.SellerGstin).toUpperCase(), buyer: String(d.BuyerGstin || '').toUpperCase(), no: String(d.DocNo || ''), date: yy && mm && dd ? `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : '',
      value: +d.TotInvVal || 0, irn: /^[0-9a-f]{64}$/i.test(d.Irn || '') ? d.Irn.toLowerCase() : '', items: +d.ItemCnt || 0 };
  } catch (e) { return null; }
}

/* ======================================================================= receive goods (scan, like the POS)
   Choose what came (a bill booked before its goods, an open purchase order, a truck at the gate, or goods without papers),
   scan every piece with a USB scanner or the camera, and save one goods receipt (GRN) with each item in its bin.
   A code never seen before is taught once: which item it is and how many pieces the pack holds. */
const normRef = (x) => String(x || '').toUpperCase().replace(/\s+/g, '');
route(/^receive$/, async (el, m, q) => {
  const src = q.get('bill') ? ['bill', +q.get('bill')] : q.get('po') ? ['po', +q.get('po')] : q.get('ge') ? ['ge', +q.get('ge')] : q.get('free') ? ['free', 0] : null;
  return src ? receiveScreen(el, src) : receiveLanding(el);
});

async function receiveLanding(el) {
  const [r, parties] = await Promise.all([GET('/api/receive'), master('parties')]);
  const btn = (h) => `<a class="btn sm primary" href="#/receive?${h}">Receive</a>`;
  el.innerHTML = head('Receive Goods', `<button class="btn" id="rqr">&#128247; Scan bill QR</button><a class="btn primary" href="#/receive?free=1">Goods without bill / order</a>`) + `
    <p class="muted">Maal aaya? Choose what came, then scan every piece. Stock goes up as you save, and each item goes to its bin.</p>
    <div class="panel row qrrow"><input id="rqrtxt" placeholder="Or scan the e-invoice QR with a 2D scanner here" aria-label="e-invoice QR text" autocomplete="off"></div>
    ${r.gates.length ? `<div class="panel flush"><h2 class="ph">At the gate</h2>${table([
      { h: 'Gate entry', f: (g) => `<b>${esc(g.number)}</b><div class="muted">${fdate(g.date)} ${esc(g.time_in || '')}</div>` },
      { h: 'Supplier', f: (g) => esc(g.party || '-') + (g.challan_no ? `<div class="muted">Bill / challan ${esc(g.challan_no)}</div>` : '') },
      { h: 'Vehicle', cls: 'hide-sm', f: (g) => esc(g.vehicle_no) + (g.packages ? `<div class="muted">${g.packages} pkgs</div>` : '') },
      { h: 'Against', f: (g) => g.bill_number ? `Bill ${esc(g.bill_number)}` : g.ref_number ? `Order ${esc(g.ref_number)}` : '<span class="muted">nothing yet</span>' },
      { h: '', f: (g) => btn('ge=' + g.id) }], r.gates)}</div>` : ''}
    <div class="panel flush"><h2 class="ph">Bills waiting for their goods</h2>${table([
      { h: 'Bill', f: (b) => `<a href="#/doc/${b.id}"><b>${esc(b.number)}</b></a><div class="muted">${fdate(b.date)}</div>` },
      { h: 'Supplier', f: (b) => esc(b.party) + (b.party_ref ? `<div class="muted">Their bill ${esc(b.party_ref)}</div>` : '') },
      { h: 'Still to come', num: 1, f: (b) => `${qtyf(b.qty)}<div class="muted">${b.lines} item${b.lines === 1 ? '' : 's'}</div>` },
      { h: '', f: (b) => btn('bill=' + b.id) }], r.bills, { empty: 'No bill is waiting. When a bill comes before its goods, tick “Goods not received yet” on it and it shows here.' })}</div>
    ${r.orders.length ? `<div class="panel flush"><h2 class="ph">Open purchase orders</h2>${table([
      { h: 'Order', f: (o) => `<a href="#/doc/${o.id}"><b>${esc(o.number)}</b></a><div class="muted">${fdate(o.date)}</div>` },
      { h: 'Supplier', k: 'party' }, { h: 'Still to come', num: 1, f: (o) => qtyf(o.qty) }, { h: '', f: (o) => btn('po=' + o.id) }], r.orders)}</div>` : ''}`;
  // the bill's QR: straight to its bill (or order); else offer to make the bill from it
  const open = (text) => {
    const e = einvoiceQr(text);
    if (!e) { toast('This is not a GST e-invoice QR.', 'err'); return false; }
    const p = parties.find((x) => (x.gstin || '').toUpperCase() === e.gstin);
    if (!p) { toast(`No supplier with GSTIN ${e.gstin} yet. Add them in Customers & suppliers first.`, 'err'); return true; }
    const b = r.bills.find((x) => x.party_id === p.id && normRef(x.party_ref) === normRef(e.no));
    if (b) { go('receive?bill=' + b.id); return true; }
    const o = r.orders.filter((x) => x.party_id === p.id);
    if (o.length === 1) { go('receive?po=' + o[0].id); return true; }
    if (ME.can.purchase && confirm(`Bill ${e.no} of ${p.name} (${inr(e.value)}) is not entered yet. Make the purchase bill now? It waits for the goods, then you scan them in.`)) {
      sessionStorage.setItem('st_scan', JSON.stringify({ type: 'BILL', party_id: p.id, date: e.date || ME.today, party_ref: e.no, lines: [{}],
        scan_note: `From the e-invoice QR: bill <b>${esc(e.no)}</b> of ${fdate(e.date)}, total <b>${inr(e.value)}</b>${e.items ? `, ${e.items} item(s)` : ''}. Add the lines, tick “Goods not received yet” if they have not come, and save.`, scan_ok: true }));
      go('new/BILL?scan=' + Date.now());
    }
    return true;
  };
  $('#rqr').onclick = () => cameraScan((code) => open(code), { once: true });
  $('#rqrtxt').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (open(e.target.value)) e.target.value = ''; } });
}

async function receiveScreen(el, [kind, id]) {
  const [items, whs, parties] = await Promise.all([master('items'), master('warehouses'), master('parties')]);
  let ge = null, draft = null;
  if (kind === 'ge') {
    ge = await GET('/api/gate/' + id);
    if (ge.status !== 'open') throw new Error(`Gate entry ${ge.number} is already ${ge.status === 'grn_done' ? 'received' : ge.status}.`);
    [kind, id] = ge.bill_id ? ['bill', ge.bill_id] : ge.ref_doc_id ? ['po', ge.ref_doc_id] : ['free', 0];
  }
  if (kind !== 'free') draft = await GET(`/api/docs/${id}/convert?to=GRN`);
  const free = kind === 'free', sups = parties.filter((p) => p.kind !== 'customer');
  const what = free ? 'goods without a bill or order' : `${kind === 'bill' ? 'bill' : 'order'} ${draft.ref_number}${draft.party_ref ? ` (their bill ${draft.party_ref})` : ''}`;
  const itemOf = (iid) => items.find((i) => i.id === iid) || {};
  // bad: pieces of a bill-first bill that arrived broken (written off, or claimed from the supplier, after the receipt)
  const lineOf = (it) => ({ item_id: it.id, name: it.name, unit: it.unit, expected: null, got: 0, bad: 0, rate: it.purchase_price || it.avg_cost || 0, discount_pct: 0, gst_rate: it.gst_rate,
    batch_no: '', expiry: '', serials: [], track_batch: !!it.track_batch, track_serial: !!it.track_serial, bin: '' });
  const L = free ? [] : draft.lines.map((l) => ({ ...lineOf({ ...itemOf(l.item_id), id: l.item_id, name: l.item || l.description, unit: l.unit, gst_rate: l.gst_rate, track_batch: l.track_batch, track_serial: l.track_serial }),
    expected: l.qty, rate: l.rate, discount_pct: l.discount_pct, src_line_id: l.src_line_id, batch_no: l.batch_no || '', expiry: l.expiry || '', src_serials: l.src_serials || '' }));
  let wid = (draft && draft.warehouse_id) || (whs[0] && whs[0].id), active = -1, useBins = false, binCodes = [];
  const learnt = new Map();      // codes taught on this screen: code -> { id, pack }
  el.innerHTML = head(`Receive goods <span class="muted">${esc(what)}</span>`, `<a class="btn" href="#/receive">Back</a>`) + `
    ${ge ? `<div class="panel warnbox">Gate entry <b>${esc(ge.number)}</b>: vehicle ${esc(ge.vehicle_no)}${ge.challan_no ? `, bill / challan ${esc(ge.challan_no)}` : ''}${ge.packages ? `, ${ge.packages} packages` : ''}.</div>` : ''}
    <div class="panel"><div class="form">
      <label class="f">Supplier${free ? `<select id="rparty"><option value="">Choose…</option>${sups.map((p) => `<option value="${p.id}" ${ge && p.id === ge.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
        : `<input value="${esc((parties.find((p) => p.id === draft.party_id) || {}).name || '')}" disabled>`}</label>
      ${whs.length > 1 ? `<label class="f">Godown<select id="rwh">${whs.map((w) => `<option value="${w.id}" ${w.id === wid ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}
      <label class="f">Date<input type="date" id="rdate" value="${ME.today}"></label>
      <label class="f">Supplier bill / challan no.<input id="rref" maxlength="40" value="${esc((draft && draft.party_ref) || (ge && ge.challan_no) || '')}" ${kind === 'bill' ? 'disabled' : ''}></label>
    </div></div>
    <div class="panel rscanbar"><div class="row"><label class="pqty">Qty<input id="rqty" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Pieces for the next scan"></label><input id="rscan" placeholder="Scan barcode / IMEI, or type a code and press Enter" autocomplete="off" enterkeyhint="go" aria-label="Scan">
      <button type="button" class="btn" id="rcam" aria-label="Scan with camera">&#128247;</button>${free ? '<select id="radd" aria-label="Add an item"><option value="">+ Add item…</option>' + items.filter((i) => !i.is_service).map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('') + '</select>' : ''}</div>
      <div class="rmsg" id="rmsg" role="status" aria-live="polite"></div><div class="rprog" id="rprog"></div></div>
    <div class="rlines" id="rlines"></div><datalist id="binlist"></datalist>
    <div class="row savebar"><label class="check"><input type="checkbox" id="rbins"> Put into bins <span class="muted small">(new bins are made when needed)</span></label>
      ${kind === 'bill' ? `<label class="f inline-f" id="rbadw" hidden>Damaged pieces<select id="rbadmode"><option value="loss">Our loss (write off)</option><option value="claim">Transporter / insurance pays</option>
        <option value="supplier">Supplier credits them (debit note)</option></select></label>` : ''}<span class="spacer"></span>
      <button class="btn primary" id="rsave">Save receipt</button></div>`;
  const fine = matchMedia('(pointer: fine)').matches, scan = $('#rscan');
  const msg = (t, kind2 = '') => { const b = $('#rmsg'); b.className = 'rmsg ' + kind2; b.innerHTML = t; };
  const bins = async (ids) => {
    if (!ids.length || !wid) return;
    try {
      const p = await POST('/api/bins/auto', { warehouse_id: wid, item_ids: ids, skip: L.filter((l) => !ids.includes(l.item_id)).map((l) => l.bin).filter(Boolean) });
      for (const r of p.rows) for (const l of L) if (l.item_id === r.item_id && !l.bin && r.bin) l.bin = r.bin;
      if (p.rows.some((r) => r.bin)) useBins = true;
      binCodes = [...new Set([...binCodes, ...p.rows.map((r) => r.bin).filter(Boolean)])];
      $('#binlist').innerHTML = binCodes.map((c) => `<option value="${esc(c)}">`).join('');
      $('#rbins').checked = useBins; draw();
    } catch (e) { /* bins are optional */ }
  };
  const draw = () => {
    const got = L.reduce((s, l) => s + l.got, 0), exp = L.reduce((s, l) => s + (l.expected || 0), 0);
    $('#rprog').innerHTML = L.length ? `<b>${qtyf(got)}</b>${free ? '' : ` of ${qtyf(exp)}`} received${free ? '' : `<span class="bar"><i style="width:${Math.min(100, exp ? got / exp * 100 : 0)}%"></i></span>`}` : '';
    if ($('#rbadw')) $('#rbadw').hidden = !L.some((l) => l.bad > 0);
    $('#rlines').innerHTML = L.map((l, i) => {
      const over = l.expected !== null && l.got + l.bad > l.expected + 0.0005, done = l.expected !== null && Math.abs(l.got + l.bad - l.expected) < 0.0005;
      return `<div class="rline ${over ? 'over' : done ? 'done' : ''} ${i === active ? 'act' : ''}" data-i="${i}">
        <div class="rl-head"><b>${esc(l.name)}</b>${l.expected !== null ? `<span class="muted">${qtyf(l.expected)} ${esc(l.unit || '')} expected</span>` : ''}</div>
        <div class="rl-qty"><button type="button" class="btn" data-minus aria-label="One less">&minus;</button><input type="number" step="any" min="0" inputmode="decimal" data-got value="${l.got}" aria-label="Received: ${esc(l.name)}">
          <button type="button" class="btn" data-plus aria-label="One more">+</button>${done ? '<span class="pos">&#10003; all</span>' : over ? '<span class="neg">more than billed</span>' : ''}</div>
        ${kind === 'bill' ? `<label class="rl-bad">Damaged / missing <input type="number" step="any" min="0" inputmode="decimal" data-bad value="${l.bad || ''}" placeholder="0" aria-label="Damaged or missing: ${esc(l.name)}"></label>` : ''}
        <div class="rl-more">${useBins ? `<input data-bin list="binlist" placeholder="Bin" value="${esc(l.bin)}" aria-label="Bin" maxlength="30">` : ''}
          ${l.track_batch ? `<input data-batch placeholder="Batch no." value="${esc(l.batch_no)}" maxlength="40" aria-label="Batch"><input data-exp type="month" value="${esc((l.expiry || '').slice(0, 7))}" aria-label="Expiry">` : ''}</div>
        ${l.track_serial ? `<div class="rl-sn">${l.serials.map((x) => `<span class="snchip on">${esc(x)}</span>`).join('') || `<span class="muted">${i === active ? 'Scan each piece\'s serial / IMEI now' : 'Tap here, then scan serial / IMEI numbers'}</span>`}</div>` : ''}
      </div>`;
    }).join('') || `<div class="empty">${free ? 'Scan the first item, or add it from the list.' : 'Nothing left to receive.'}</div>`;
  };
  const hit = (it, pack, code) => {
    let i = L.findIndex((l) => l.item_id === it.id && (l.expected === null || l.got + l.bad < l.expected - 0.0005));
    if (i < 0) i = L.findIndex((l) => l.item_id === it.id);
    if (i < 0) {
      if (!free) { beep(false); msg(`<b>${esc(it.name)}</b> is not on ${esc(what)}. Keep it aside.`, 'err'); return; }
      L.push(lineOf(it)); i = L.length - 1; bins([it.id]);
    }
    const l = L[i];
    if (l.track_serial) { active = i; beep(true); msg(`<b>${esc(l.name)}</b>: now scan each piece's serial / IMEI number.`); draw(); return; }
    // the quantity typed before the scan (10 pieces of one code: one scan), then back to 1
    const qBox = $('#rqty'), times = Math.max(1, Math.round(+(qBox || {}).value || 1));
    if (qBox) qBox.value = 1;
    pack = pack * times;
    l.got = r2(l.got + pack);
    const over = l.expected !== null && l.got + l.bad > l.expected + 0.0005;
    beep(!over);
    msg(over ? `<b>${esc(l.name)}</b>: ${qtyf(l.got)} is more than the ${qtyf(l.expected)} billed.` : `<b>${esc(l.name)}</b> +${qtyf(pack)}${times === 1 && pack > 1 ? ' (one pack)' : ''}${l.expected !== null ? ` &rarr; ${qtyf(l.got)} of ${qtyf(l.expected)}` : ''}`, over ? 'err' : 'ok');
    draw();
  };
  const teach = (code) => {
    beep(false);
    const choices = [...L.map((l) => itemOf(l.item_id)).filter((x) => x.id), ...items.filter((x) => !x.is_service && !L.some((l) => l.item_id === x.id))];
    modal(`New code ${code}`, [
      { k: 'item_id', label: 'Which item is this?', type: 'select', options: [{ v: '', t: 'Choose…' }, ...choices.map((x) => ({ v: x.id, t: x.name }))] },
      { k: 'pack', label: 'Pieces in this pack', type: 'number', value: 1 }],
    async (v) => {
      if (!+v.item_id) throw new Error('Choose the item.');
      const r = await POST(`/api/items/${v.item_id}/codes`, { code, pack_qty: +v.pack || 1 });
      learnt.set(code, { id: r.item_id, pack: r.pack_qty }); dirty('items');
      hit(itemOf(r.item_id), r.pack_qty, code);
    }, { submit: 'Remember this code', intro: '<p class="muted">Tell SmartTrader once; from now on this code is known everywhere (here, POS, search). A carton code can count 12 or 24 pieces in one scan.</p>' });
  };
  const onCode = async (raw) => {
    const code = String(raw || '').trim(), lc = code.toLowerCase();
    if (!code) return;
    if (einvoiceQr(code)) { msg('That is the bill\'s QR. Now scan the barcodes on the goods.'); return; }
    if (learnt.has(code)) { const k = learnt.get(code); return hit(itemOf(k.id), k.pack, code); }
    let it = items.find((i) => (i.barcode && i.barcode === code) || (i.sku && i.sku.toLowerCase() === lc) || ('st' + i.id) === lc), pack = 1;
    const sl = L[active];
    if (!it && sl && sl.track_serial && (sl.expected === null || sl.serials.length < sl.expected - 0.0005)) {      // a serial / IMEI of the item scanned last
      if (sl.serials.includes(code)) { beep(false); msg(`${esc(code)} is already scanned.`, 'err'); return; }
      if (sl.src_serials && !sl.src_serials.split(/,\s*/).includes(code)) { beep(false); msg(`${esc(code)} is not on ${esc(what)}.`, 'err'); return; }
      sl.serials.push(code); sl.got = sl.serials.length; beep(true);
      if (sl.expected !== null && sl.got >= sl.expected - 0.0005) active = -1;     // all its serials are in
      msg(`<b>${esc(sl.name)}</b> serial ${esc(code)}${sl.expected !== null ? ` &rarr; ${sl.got} of ${qtyf(sl.expected)}` : ''}`, 'ok'); draw(); return;
    }
    if (!it) {
      try { const r = await GET('/api/items/lookup?code=' + encodeURIComponent(code)); it = { ...itemOf(r.id), ...r }; pack = r.pack_qty || 1; learnt.set(code, { id: r.id, pack }); } catch (e) {
        if (e.status === 404) return teach(code);
        beep(false); msg(esc(e.message), 'err'); return;
      }
    }
    hit(it, pack, code);
  };
  scan.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = scan.value; scan.value = ''; await onCode(v); if (fine) scan.focus(); } });
  $('#rcam').onclick = () => cameraScan(onCode);
  if ($('#radd')) $('#radd').onchange = (e) => { const it = itemOf(+e.target.value); e.target.value = ''; if (it.id) hit(it, 1, ''); };
  if ($('#rwh')) $('#rwh').onchange = (e) => { wid = +e.target.value; L.forEach((l) => { l.bin = ''; }); bins(L.map((l) => l.item_id)); };
  $('#rbins').onchange = (e) => { useBins = e.target.checked; draw(); };
  const lineAt = (t) => { const r = t.closest('.rline'); return r ? L[+r.dataset.i] : null; };
  $('#rlines').addEventListener('click', (e) => {
    const r = e.target.closest('.rline'); if (!r) return;
    const l = L[+r.dataset.i];
    if (e.target.closest('[data-plus]')) { if (l.track_serial) { active = +r.dataset.i; msg(`Scan the serial / IMEI of <b>${esc(l.name)}</b>.`); draw(); } else hit(itemOf(l.item_id).id ? itemOf(l.item_id) : { id: l.item_id, name: l.name }, 1, ''); }
    else if (e.target.closest('[data-minus]')) { if (l.track_serial) { l.serials.pop(); l.got = l.serials.length; } else l.got = Math.max(0, r2(l.got - 1)); draw(); }
    else if (l.track_serial && e.target.closest('.rl-sn')) { active = +r.dataset.i; draw(); if (fine) scan.focus(); }
  });
  $('#rlines').addEventListener('change', (e) => {
    const l = lineAt(e.target); if (!l) return;
    if (e.target.matches('[data-got]') && !l.track_serial) { l.got = Math.max(0, +e.target.value || 0); draw(); }
    if (e.target.matches('[data-bad]')) { l.bad = Math.max(0, r2(+e.target.value || 0)); draw(); }
    if (e.target.matches('[data-bin]')) l.bin = e.target.value.trim().toUpperCase();
    if (e.target.matches('[data-batch]')) l.batch_no = e.target.value.trim();
    if (e.target.matches('[data-exp]')) l.expiry = e.target.value ? e.target.value + '-01' : '';
  });
  $('#rsave').onclick = async () => {
    const lines = L.filter((l) => l.got > 0), bad = L.filter((l) => l.bad > 0), btn = $('#rsave');
    const partyId = free ? +$('#rparty').value : draft.party_id;
    if (!partyId) return msg('Choose the supplier.', 'err');
    if (!lines.length && !bad.length) return msg('Scan or count at least one piece.', 'err');
    const over = L.find((l) => l.expected !== null && l.got + l.bad > l.expected + 0.0005);
    if (over) return msg(`<b>${esc(over.name)}</b>: ${qtyf(over.got + over.bad)} counted but only ${qtyf(over.expected)} billed. Keep the extra aside, or ask the supplier for a bill.`, 'err');
    const nb = lines.find((l) => l.track_batch && !l.batch_no);
    if (nb && !confirm(`${nb.name} has no batch number. Save without it?`)) return;
    btn.disabled = true;
    try {
      if (useBins) {           // items without a bin get one now (a new bin when every bin is taken)
        const missing = lines.filter((l) => !l.bin);
        if (missing.length) {
          try {
            const p = await POST('/api/bins/auto', { warehouse_id: wid, item_ids: missing.map((l) => l.item_id), create: true, skip: lines.map((l) => l.bin).filter(Boolean) });
            for (const r of p.rows) for (const l of missing) if (l.item_id === r.item_id && !l.bin) l.bin = r.bin;
            if (p.created.length) toast(`New bin${p.created.length > 1 ? 's' : ''} made: ${p.created.join(', ')}`);
          } catch (e) { if (e.status !== 0) throw e; }       // offline: those go to their default bin, or wait for put-away
        }
      }
      const body = { type: 'GRN', party_id: partyId, date: $('#rdate').value, warehouse_id: wid, ref_id: draft ? draft.ref_id : undefined, party_ref: $('#rref').value.trim(),
        notes: free ? 'Received without a bill or order' : '',
        lines: lines.map((l) => ({ item_id: l.item_id, qty: l.got, rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate, src_line_id: l.src_line_id, batch_no: l.batch_no, expiry: l.expiry,
          serials: l.serials.join('\n'), bin: useBins ? l.bin : '' })) };
      if (ge) body.gate_entry_id = ge.id;
      const d = lines.length ? await POST('/api/docs', body) : null;
      if (d && d.queued) { toast('No internet: saved on this device. It is sent by itself when you are back online.', 'info'); go('outbox'); return; }
      if (d) dirty('items');
      // pieces that came broken: written off (our loss / a claim), or claimed from the supplier by a shortage note
      let damaged = null;
      if (bad.length) {
        const how = $('#rbadmode').value, note = `Damaged on arrival${ge ? `, gate entry ${ge.number}` : ''}`;
        try {
          damaged = how === 'supplier'
            ? { how, doc: await POST('/api/docs', { type: 'DNOTE', short: true, party_id: partyId, ref_id: draft.ref_id, date: $('#rdate').value, notes: note,
              lines: bad.map((l) => ({ item_id: l.item_id, qty: l.bad, src_line_id: l.src_line_id })) }) }
            : { how, wo: await POST(`/api/docs/${draft.ref_id}/write-off`, { mode: how, date: $('#rdate').value, reason: note, lines: bad.map((l) => ({ line_id: l.src_line_id, qty: l.bad })) }) };
        } catch (err) { damaged = { how, error: err.message }; }
      }
      receiveDone(el, d, { kind, draft, lines, left: L.filter((l) => l.expected !== null && l.got + l.bad < l.expected - 0.0005), useBins, bad, damaged });
    } catch (e) { msg(esc(e.message), 'err'); beep(false); } finally { btn.disabled = false; }
  };
  draw();
  bins(L.map((l) => l.item_id));
  msg(free ? 'Scan the goods one by one. Unknown codes are taught once.' : `Scan the goods of ${esc(what)} one by one.`);
  if (fine) scan.focus();
}

function receiveDone(el, d, { kind, draft, lines, left, useBins, bad = [], damaged = null }) {
  const pcs = lines.reduce((s, l) => s + l.got, 0), broke = bad.reduce((s, l) => s + l.bad, 0);
  const dmg = !damaged ? '' : damaged.error ? `<div class="panel err">The ${qtyf(broke)} damaged piece(s) were not recorded: ${esc(damaged.error)} Do it from <a href="#/doc/${draft.ref_id}">${esc(draft.ref_number)}</a> → More.</div>`
    : damaged.doc ? `<div class="panel warnbox"><b>${qtyf(broke)}</b> damaged piece(s) claimed from the supplier: debit note <a href="#/doc/${damaged.doc.id}">${esc(damaged.doc.number)}</a> (${inr(damaged.doc.total)}).</div>`
      : `<div class="panel warnbox"><b>${qtyf(broke)}</b> damaged piece(s) written off as ${damaged.how === 'claim' ? 'a claim on the transporter / insurer' : 'our loss'}: ${esc(damaged.wo.number)}, ${inr(damaged.wo.value)} + GST ${inr(damaged.wo.gst)} reversed.</div>`;
  el.innerHTML = head(d ? `Received &#10003; <span class="muted">${esc(d.number)}</span>` : 'Damaged goods recorded', `${d ? `<a class="btn" href="#/doc/${d.id}">Open ${esc(d.number)}</a>` : ''}<a class="btn primary" href="#/receive">Receive more</a>`) + `
    ${d ? `<div class="panel okbox"><b>${qtyf(pcs)}</b> piece${pcs === 1 ? '' : 's'} of ${lines.length} item${lines.length === 1 ? '' : 's'} are in stock now${useBins ? ', each in its bin' : ''}.${d.gate_entry_id ? ' The gate entry is closed.' : ''}</div>` : ''}${dmg}
    ${left.length ? `<div class="panel warnbox">Still to come on ${esc(draft.ref_number)}: ${left.map((l) => `${esc(l.name)} ${qtyf(r2(l.expected - l.got - l.bad))}`).join(', ')}.
      ${kind === 'bill' ? `Receive them when they come. If they will not come: <a href="#/new/DNOTE?from=${draft.ref_id}&short=1">close them short</a> (the supplier credits them), or write them off from <a href="#/doc/${draft.ref_id}">${esc(draft.ref_number)}</a> → More.` : 'Receive them when they come.'}</div>` : ''}
    ${d ? `<div class="panel flush">${table([{ h: 'Item', f: (l) => `<b>${esc(l.name)}</b>${l.batch_no ? `<div class="muted">Batch ${esc(l.batch_no)}</div>` : ''}${l.serials.length ? `<div class="muted">S/N ${esc(l.serials.join(', '))}</div>` : ''}` },
      { h: 'Qty', num: 1, f: (l) => `${qtyf(l.got)} ${esc(l.unit || '')}` }, ...(useBins ? [{ h: 'Put in bin', f: (l) => `<b>${esc(l.bin || '-')}</b>` }] : []),
      { h: '', f: (l) => `<a class="btn sm" href="#/labels/${l.item_id}?n=${Math.min(200, Math.ceil(l.got))}">Labels</a>` }], lines)}</div>` : ''}
    ${d && kind !== 'bill' && ME.can.purchase ? `<div class="row"><span class="muted">When the supplier's bill comes:</span><a class="btn" href="#/new/BILL?from=${d.id}">Make purchase bill from ${esc(d.number)}</a></div>` : ''}`;
  beep(true);
}

/* ======================================================================= transit claims
   Goods damaged or lost on the way that the transporter or insurer is to pay (write-offs made "Transporter / insurance
   will pay"), followed up to the end: whom, their reference, the next follow-up, money received, the rest closed as a loss. */
const CLAIM_TONE = { open: 'open', partial: 'partial', settled: 'paid', rejected: 'cancelled' };
const claimBadge = (c) => `<span class="badge b-${CLAIM_TONE[c.state]}">${esc(c.state_text)}</span>`;
route(/^claims$/, async (el, m, q) => {
  const status = q.get('status') || 'open';
  const { rows, totals } = await GET('/api/claims?status=' + status);
  el.innerHTML = head('Transit Claims') + `
    <p class="muted">Goods broken or lost on the way that the transporter or insurance company is to pay. Write one off as “Transporter / insurance will pay” on the bill (More → Write off) or on the Receive screen; follow it up here until the money comes.</p>
    <div class="kpis"><div class="kpi"><div class="l">Claims open</div><div class="v">${totals.open}</div></div>
      <div class="kpi"><div class="l">Still to get</div><div class="v ${totals.due > 0 ? 'neg' : ''}">${inr0(totals.due)}</div></div>
      <div class="kpi"><div class="l">Received so far</div><div class="v pos">${inr0(totals.received)}</div></div>
      <div class="kpi"><div class="l">Closed as loss</div><div class="v">${inr0(totals.closed)}</div></div></div>
    <div class="tabs">${[['open', `Open${totals.open ? ` (${totals.open})` : ''}`], ['closed', 'Settled / closed'], ['all', 'All']].map(([k, t]) => `<a href="#/claims?status=${k}" class="${status === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="panel flush">${table([
      { h: 'Claim', f: (c) => `<a href="#/claim/${c.id}"><b>${esc(c.number)}</b></a><div class="muted">${fdate(c.date)} · ${c.age} day${c.age === 1 ? '' : 's'}</div>` },
      { h: 'Against', f: (c) => `${esc(c.against || '—')}${c.claim_ref ? `<div class="muted">${esc(c.claim_ref)}</div>` : ''}` },
      { h: 'Bill', cls: 'hide-sm', f: (c) => `<a href="#/doc/${c.bill_id}">${esc(c.bill_number)}</a><div class="muted">${esc(c.supplier || '')}</div>` },
      { h: 'Claimed', num: 1, cls: 'hide-sm', f: (c) => inr(c.total) },
      { h: 'Still due', num: 1, f: (c) => (c.due > 0 ? `<b>${inr(c.due)}</b>` : '—') + (c.received ? `<div class="muted">got ${inr(c.received)}</div>` : '') },
      { h: 'Follow up', f: (c) => (c.due > 0 ? (c.follow_up ? `<span class="${c.late ? 'neg' : ''}">${fdate(c.follow_up)}${c.late ? ' · due' : ''}</span>` : '<span class="muted">not set</span>') : '') },
      { h: '', f: (c) => claimBadge(c) }], rows,
    { empty: status === 'open' ? 'No claim is waiting. Sab theek hai ✓' : 'No claims here.', onRow: true })}</div>`;
  bindRows(el, rows, (x) => go('claim/' + x.id));
});

route(/^claim\/(\d+)$/, async (el, m) => {
  const c = await GET('/api/claims/' + m[1]);
  const fin = ME.can.finance, edit = fin || ME.can.purchase;
  el.innerHTML = head(`${esc(c.number)} ${claimBadge(c)}`, `<a class="btn" href="#/claims">All claims</a>`) + `
    <div class="kpis"><div class="kpi"><div class="l">Claimed (goods + GST)</div><div class="v">${inr(c.total)}</div></div>
      <div class="kpi"><div class="l">Received</div><div class="v pos">${inr(c.received)}</div></div>
      <div class="kpi"><div class="l">Closed as loss</div><div class="v">${inr(c.closed)}</div></div>
      <div class="kpi"><div class="l">Still due</div><div class="v ${c.due > 0 ? 'neg' : ''}">${inr(c.due)}</div></div></div>
    ${c.cancelled ? '<div class="panel err">This write-off was cancelled.</div>' : ''}
    ${c.due > 0 && !c.cancelled && fin ? `<div class="row" style="margin-bottom:12px"><button class="btn primary" id="cgot">Money received</button>
      <button class="btn danger" id="cclose">Close the rest as loss</button></div>` : ''}
    <div class="grid g2">
      <form class="panel" id="cform"><h2>Claim details</h2><div class="form">
        <label class="f">Against (transporter / insurer)<input name="against" maxlength="80" value="${esc(c.against)}" ${edit ? '' : 'disabled'}></label>
        <label class="f">LR / claim no.<input name="claim_ref" maxlength="40" value="${esc(c.claim_ref)}" ${edit ? '' : 'disabled'}></label>
        <label class="f">Next follow-up<input name="follow_up" type="date" value="${esc(c.follow_up)}" ${edit ? '' : 'disabled'}></label>
        <label class="f wide">Note (whom you spoke to, what they said)<textarea name="claim_note" rows="2" maxlength="300" ${edit ? '' : 'disabled'}>${esc(c.claim_note)}</textarea></label></div>
        ${edit ? '<div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn">Save details</button></div>' : ''}</form>
      <div class="panel"><h2>What was lost</h2>
        <p>On bill <a href="#/doc/${c.bill_id}">${esc(c.bill_number)}</a> of ${esc(c.supplier || '')}, ${fdate(c.date)}${c.reason ? `: ${esc(c.reason)}` : ''}.</p>
        ${table([{ h: 'Item', f: (l) => esc(l.item || '') }, { h: 'Qty', num: 1, f: (l) => `${qtyf(l.qty)} ${esc(l.unit || '')}` }, { h: 'Value + GST', num: 1, f: (l) => `${inr(l.value)} + ${inr(l.gst)}` }], c.lines)}</div>
    </div>
    <div class="panel flush"><h2 class="ph">History</h2>${table([
      { h: 'Date', f: (e) => fdate(e.date) },
      { h: 'What', f: (e) => (e.kind === 'receipt' ? `Money received${e.account ? ` into ${esc(e.account)}` : ''}` : 'Closed as loss') + (e.note ? `<div class="muted">${esc(e.note)}</div>` : '') },
      { h: 'Amount', num: 1, f: (e) => inr(e.amount) },
      { h: '', f: (e) => (e.status === 'cancelled' ? badge('cancelled') : fin && !limits().no_cancel ? `<button class="btn sm danger" data-cx="${e.id}">Cancel</button>` : '') }], c.entries,
    { empty: 'Nothing received yet.' })}</div>`;
  const back = (d) => { toast('Saved'); render(); return d; };
  $('#cform').onsubmit = async (e) => {
    e.preventDefault();
    try { back(await api('PUT', '/api/claims/' + c.id, Object.fromEntries(new FormData(e.target)))); } catch (err) { toast(err.message, 'err'); }
  };
  if ($('#cgot')) $('#cgot').onclick = async () => modal(`Money received on ${c.number}`, [
    { k: 'amount', label: 'Amount (₹)', type: 'number', value: c.due }, { k: 'date', label: 'Date', type: 'date', value: ME.today },
    { k: 'account_id', label: 'Money went into', type: 'select', options: await cashOpts() }, { k: 'note', label: 'Cheque / UTR / note', wide: true }],
  async (v) => back(await POST(`/api/claims/${c.id}/receive`, v)), { submit: 'Save', intro: `<p class="muted">${inr(c.due)} is still due${c.against ? ` from ${esc(c.against)}` : ''}. If they pay less and will not pay the rest, save what came, then <b>Close the rest as loss</b>.</p>` });
  if ($('#cclose')) $('#cclose').onclick = () => modal(`Close ${c.number}`, [{ k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'note', label: 'Why (claim rejected, settled for less…)', wide: true }],
    async (v) => back(await POST(`/api/claims/${c.id}/close`, v)), { submit: `Close ${inr(c.due)} as loss`, intro: `<p class="muted">${inr(c.due)} will not be paid. It moves from Claims to Transit Loss &amp; Damage. You can undo this from the history.</p>` });
  $$('[data-cx]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Cancel this entry? Its money and books are taken back, and the amount is due again.')) return;
    try { back(await POST(`/api/claim-entries/${b.dataset.cx}/cancel`, {})); } catch (e) { toast(e.message, 'err'); }
  });
});

/* ======================================================================= WhatsApp inbox (src/wabot.js) */
const waPhone = (p) => (/^91\d{10}$/.test(p) ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : '+' + p);
const waWhen = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
// WhatsApp's *bold* and the links in what the bot sent, on escaped text
const waBody = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
const WA_KIND = { bot: 'Bot', reply: 'Shop', reminder: 'Reminder', bill: 'New bill' };
route(/^wa-inbox$/, async (el, m, q) => {
  const tab = q.get('tab') || 'waiting';
  const { rows, waiting } = await GET('/api/wa/inbox');
  const list = tab === 'waiting' ? rows.filter((r) => r.waiting) : rows;
  el.innerHTML = head('WhatsApp Inbox', '<button class="btn" id="warf">Refresh</button>') + `
    <p class="muted">Customers who write to your shop on WhatsApp. The bot answers on its own: what is due, bills, the UPI link, a pay date, and stopping reminders. What it cannot answer waits here for you. Replies are free within 24 hours of the customer's message.</p>
    <div class="tabs">${[['waiting', `Waiting for you${waiting ? ` (${waiting})` : ''}`], ['all', 'All chats']].map(([k, t]) => `<a href="#/wa-inbox?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="panel flush">${table([
      { h: 'Customer', f: (r) => `<b>${esc(r.name || waPhone(r.phone))}</b>${r.name ? `<div class="muted">${waPhone(r.phone)}</div>` : ''}` },
      { h: 'Last message', f: (r) => r.last ? `<span class="muted">${r.last.dir === 'in' ? '' : (WA_KIND[r.last.kind] || 'Shop') + ': '}</span>${esc(r.last.body.replace(/^\*[^*\n]+\*\n/, '').replace(/\*/g, '').slice(0, 90))}` : '' },
      { h: 'When', cls: 'hide-sm', f: (r) => (r.last ? waWhen(r.last.at) : '') },
      { h: '', f: (r) => (r.waiting ? `<span class="badge b-unpaid">waiting</span>` : '') + (r.window_open ? ' <span class="badge b-paid" title="The customer wrote in the last 24 hours: your reply is free">can reply</span>' : '') }], list,
    { empty: tab === 'waiting' ? (rows.length ? 'Nobody is waiting. Sab theek hai ✓' : `No message yet. Share your shop's WhatsApp link or QR (Settings → WhatsApp bot) on bills, the counter and your status.`) : 'No chats yet.', onRow: true })}</div>`;
  $('#warf').onclick = () => render();
  bindRows(el, list, (r) => go('wa-inbox/' + r.phone));
});

/* the counter poster: the shop's QR that opens WhatsApp with its code */
/* ======================================================================= online catalogue (owner screen, QR poster, the public page) */
route(/^shop$/, async (el) => {
  const [s, items] = await Promise.all([GET('/api/settings/shop'), master('items')]), canSet = ME.can.settings, canItems = ME.can.items;
  const shareText = `${ME.org.name}: hamari rate list dekhiye aur WhatsApp par order kijiye: ${s.link}`;
  el.innerHTML = head('Online Catalogue') + `
    <div class="panel"><p>Your rate list on a link of its own. Customers see your items and prices (with GST), pick what they want, and the order comes to your WhatsApp as a message. No commission, nothing for them to install.</p>
      <p class="muted small" lang="hi">ग्राहक लिंक खोलकर आपके रेट देखते हैं, सामान चुनते हैं और ऑर्डर आपके WhatsApp पर आता है।</p>
      <form id="shf"><label class="mode-opt"><input type="checkbox" name="on" ${s.on ? 'checked' : ''} ${canSet ? '' : 'disabled'}> <span><b>Catalogue on</b><br>
        <span class="muted">${s.items} item(s) with a selling price are on it. Leave any out below.</span></span></label>
        <div class="form"><label class="f">WhatsApp number for orders<input name="wa" value="${esc(s.wa)}" inputmode="numeric" maxlength="12" placeholder="${esc(ME.org.phone || '10-digit mobile')}"><small class="help">Empty = your business phone.</small></label>
          <label class="f wide">Note on the page<input name="note" value="${esc(s.note)}" maxlength="200" placeholder="Free home delivery above ₹500 · Open 9 am to 9 pm"></label></div>
        <label class="check"><input type="checkbox" name="stock" ${s.stock ? 'checked' : ''}> Show "out of stock" on items you have none of (never how many you have)</label>
        <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary" ${canSet ? '' : 'disabled'}>Save</button></div></form></div>
    ${s.on && s.link ? `<div class="panel"><div class="row qrbox"><div id="shqr"></div><div><b>Your catalogue link</b><br><a href="${esc(s.link)}" target="_blank" rel="noopener" class="small">${esc(s.link)}</a>
        <div class="row" style="margin-top:8px"><button type="button" class="btn sm" id="shcopy">Copy link</button>
          <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText)}">Share on WhatsApp</a><a class="btn sm" href="#/shop-poster">Print QR poster</a>
          ${canSet ? '<button type="button" class="btn sm danger" id="shnew">New link (the old one stops)</button>' : ''}</div></div></div></div>` : ''}
    <div class="panel flush"><div style="padding:14px 16px 0"><h3 style="margin:0">Items in the catalogue</h3><p class="muted small">Price shown to customers is the selling price with GST. Wholesale prices, costs and stock counts are never shown.</p></div>
      ${table([{ h: 'Item', f: (i) => `<b>${esc(i.name)}</b>${i.category ? `<div class="muted small">${esc(i.category)}</div>` : ''}` }, { h: 'Price', num: 1, f: (i) => inr(i.sale_price_incl) },
        { h: 'In catalogue', f: (i) => (i.sale_price > 0 ? `<label class="check"><input type="checkbox" data-shop="${i.id}" ${i.shop_hide ? '' : 'checked'} ${canItems ? '' : 'disabled'}> shown</label>` : '<span class="muted small">no price</span>') }],
      items, { empty: 'Add items with a selling price first.' })}</div>`;
  if ($('#shqr')) qrInto($('#shqr'), s.link);
  $('#shf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('PUT', '/api/settings/shop', { on: f.on.checked, stock: f.stock.checked, wa: f.wa.value, note: f.note.value }); toast(f.on.checked ? 'Catalogue is on' : 'Catalogue is off'); render(); }
    catch (x) { toast(x.message, 'err'); }
  };
  if ($('#shcopy')) $('#shcopy').onclick = async () => { try { await navigator.clipboard.writeText(s.link); toast('Link copied'); } catch (x) { toast(s.link); } };
  if ($('#shnew')) $('#shnew').onclick = async () => {
    if (!confirm('Make a new link? The old link and its QR stop working at once.')) return;
    try { await POST('/api/settings/shop/new-link'); toast('New link made'); render(); } catch (x) { toast(x.message, 'err'); }
  };
  $$('[data-shop]', el).forEach((b) => { b.onchange = async () => {
    try { await api('PUT', `/api/items/${b.dataset.shop}/shop`, { show: b.checked }); dirty('items'); } catch (x) { b.checked = !b.checked; toast(x.message, 'err'); }
  }; });
});
/* ======================================================================= loyalty points */
const waNum = (ph) => { const d = String(ph || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
const PTS_KIND = { earn: 'Earned', redeem: 'Used', unredeem: 'Use undone', return: 'Goods returned', cancel: 'Bill cancelled', adjust: 'Changed' };
async function pointsHistory(pid) {
  const x = await GET('/api/loyalty/' + pid);
  modal(`${x.party.name}: ${x.balance} points`, [], async () => {}, { submit: 'Close', intro: `<p class="muted">Worth ${inr(x.value)} now.</p>` + table([{ h: 'Date', f: (r) => fdate(r.date) },
    { h: 'What', f: (r) => `${esc(PTS_KIND[r.kind] || r.kind)}${r.number ? ` <a href="#/doc/${r.doc_id}">${esc(r.number)}</a>` : ''}${r.note ? ` <span class="muted small">${esc(r.note)}</span>` : ''}` },
    { h: 'Points', num: 1, f: (r) => `<b class="${r.points < 0 ? 'neg' : 'pos'}">${r.points > 0 ? '+' : ''}${r.points}</b>` }], x.rows, { empty: 'No points yet.' }) });
}
route(/^loyalty$/, async (el, m, q) => {
  const x = await GET('/api/loyalty'), s = x.settings, canSet = ME.can.settings;
  const eg = Math.floor(1000 / s.earn_per), egv = r2(eg * s.point_value);
  el.innerHTML = head('Loyalty Points') + `
    <div class="panel"><p>Customers earn points on every bill and pay part of a later bill with them, so they come back to you. It works in Quick Bill and on invoices; the points show on the printed bill. The walk-in customer does not earn (choose the customer by name).</p>
      <p class="muted small" lang="hi">हर बिल पर ग्राहक को पॉइंट मिलते हैं; अगली बार वो पॉइंट से बिल का कुछ हिस्सा चुका सकते हैं। ग्राहक लौटकर आता है।</p>
      <form id="lyf"><label class="mode-opt"><input type="checkbox" name="on" ${s.on ? 'checked' : ''} ${canSet ? '' : 'disabled'}> <span><b>Loyalty points on</b><br>
        <span class="muted">Example: a ${inr(1000)} bill earns ${eg} point${eg === 1 ? '' : 's'}, worth ${inr(egv)} on the next bill (${r2(egv / 10)}% back).</span></span></label>
        <div class="form"><label class="f">Rupees spent for 1 point<input name="earn_per" type="number" min="1" step="any" value="${s.earn_per}" ${canSet ? '' : 'disabled'}></label>
          <label class="f">Value of 1 point (₹)<input name="point_value" type="number" min="0.01" step="0.01" value="${s.point_value}" ${canSet ? '' : 'disabled'}></label>
          <label class="f">Most of a bill paid with points (%)<input name="max_pct" type="number" min="1" max="100" step="1" value="${s.max_pct}" ${canSet ? '' : 'disabled'}></label>
          <label class="f">Usable from (points)<input name="min_points" type="number" min="0" step="1" value="${s.min_points}" ${canSet ? '' : 'disabled'}><small class="help">0 = any number of points.</small></label></div>
        <p class="muted small">Points used are booked like a payment into "Loyalty Points Redeemed" (an expense), so the bill shows paid and your books balance. GST stays on the full bill. Cancelling a bill undoes its points; a sales return takes back its share.</p>
        <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary" ${canSet ? '' : 'disabled'}>Save</button></div></form></div>
    <div class="kpis"><div class="kpi"><div class="l">Members</div><div class="v">${x.members.length}</div><div class="s">customers with points</div></div>
      <div class="kpi"><div class="l">Points out</div><div class="v">${x.points_out}</div><div class="s">worth ${inr(x.value_out)} on future bills</div></div>
      <div class="kpi"><div class="l">Earned / used</div><div class="v">${x.earned} / ${x.used}</div><div class="s">all time</div></div></div>
    <div class="panel flush"><div class="row" style="padding:12px 16px 0"><h3 style="margin:0">Customers</h3><span class="spacer"></span>${canSet ? '<button class="btn sm" id="lyadd">+ Give / take points</button>' : ''}</div>
      ${table([{ h: 'Customer', f: (r) => `<a href="#/party/${r.id}"><b>${esc(r.name)}</b></a>${r.phone ? `<div class="muted small">${esc(r.phone)}</div>` : ''}` },
        { h: 'Points', num: 1, f: (r) => `<b>${r.balance}</b><div class="muted small">${inr(r2(Math.max(0, r.balance) * s.point_value))}</div>` },
        { h: 'Earned', num: 1, cls: 'hide-sm', k: 'earned' }, { h: 'Used', num: 1, cls: 'hide-sm', k: 'used' }, { h: 'Last bill', cls: 'hide-sm', f: (r) => fdate(r.last) },
        { h: '', f: (r) => `<button class="btn sm" data-hist="${r.id}">History</button>${r.phone && r.balance > 0 ? ` <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${esc(waNum(r.phone))}?text=${encodeURIComponent(`Namaste ${r.name} ji, ${ME.org.name} mein aapke ${r.balance} loyalty points hain (${inr(r2(r.balance * s.point_value))}). Agli khareed par inka fayda uthaiye!`)}">WhatsApp</a>` : ''}` }],
      x.members, { empty: s.on ? 'No points yet: they start with the next bill to a named customer.' : 'Turn loyalty points on above.' })}</div>`;
  $('#lyf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      await api('PUT', '/api/settings/loyalty', { on: f.on.checked, earn_per: +f.earn_per.value, point_value: +f.point_value.value, max_pct: +f.max_pct.value, min_points: +f.min_points.value });
      const me = await GET('/api/me'); ME.org = me.org; toast(f.on.checked ? 'Loyalty points are on' : 'Loyalty points are off'); render();
    } catch (er) { toast(er.message, 'err'); }
  };
  $$('[data-hist]', el).forEach((b) => { b.onclick = () => pointsHistory(+b.dataset.hist); });
  if ($('#lyadd')) $('#lyadd').onclick = async () => {
    const cs = (await master('parties')).filter((p) => p.kind !== 'supplier' && p.name !== 'Walk-in Customer');
    modal('Give or take points', [{ k: 'party_id', label: 'Customer', type: 'select', options: cs.map((p) => ({ v: p.id, t: p.name })), value: q.get('p') || '' },
      { k: 'points', label: 'Points (a minus takes them off)', type: 'number' }, { k: 'note', label: 'Why (e.g. opening balance, birthday gift)', wide: true }],
    async (v) => { await POST('/api/loyalty/adjust', { party_id: +v.party_id, points: +v.points, note: v.note }); toast('Points changed'); render(); }, { submit: 'Save' });
  };
  if (q.get('p')) pointsHistory(+q.get('p')).catch((er) => toast(er.message, 'err'));
});
route(/^shop-poster$/, async (el) => {
  const s = await GET('/api/settings/shop');
  if (!s.on || !s.link) { el.innerHTML = head('Catalogue QR poster') + `<div class="panel">${emptyCta('Turn on the online catalogue first.', '<a class="btn primary" href="#/shop">Online Catalogue</a>')}</div>`; return; }
  el.innerHTML = head('Catalogue QR poster', '<a class="btn" href="#/shop">Back</a><button class="btn primary" data-act="print">Print</button>') + `
    <div class="panel wa-poster"><h1>${esc(ME.org.name)}</h1><p class="big">Scan karein, rate dekhein, WhatsApp par order karein</p>
      <div id="shpq"></div><p>${esc(s.note || 'Ghar baithe order · Rate list hamesha taaza')}</p>
      <p class="muted">स्कैन करें, रेट देखें, WhatsApp पर ऑर्डर करें · Scan to see prices and order on WhatsApp</p></div>`;
  qrInto($('#shpq'), s.link);
});
/* The public rate list: /s/<token>. The cart stays on the customer's phone; the order is a WhatsApp message to the shop. */
const SHOP_T = {
  hl: { search: 'Saaman khojein…', all: 'Sab', add: 'Add', out: 'Stock khatam', items: (n) => `${n} saaman`, order: 'WhatsApp par order', name: 'Aapka naam', addr: 'Pata / note (delivery ke liye)',
    send: 'WhatsApp par bhejein', back: 'Wapas', total: 'Kul', none: 'Yeh rate list abhi band hai.', hint: 'Rate GST sahit. Final bill dukaan dega.', empty: 'Koi saaman nahi mila.',
    msg: (shop) => `Namaste ${shop}, mujhe ye chahiye:`, nameL: 'Naam', addrL: 'Pata / note', foot: '(SmartTrader rate list se)' },
  en: { search: 'Search items…', all: 'All', add: 'Add', out: 'Out of stock', items: (n) => `${n} item(s)`, order: 'Order on WhatsApp', name: 'Your name', addr: 'Address / note (for delivery)',
    send: 'Send on WhatsApp', back: 'Back', total: 'Total', none: 'This rate list is not available now.', hint: 'Prices include GST. The shop gives the final bill.', empty: 'No items found.',
    msg: (shop) => `Hello ${shop}, I would like to order:`, nameL: 'Name', addrL: 'Address / note', foot: '(from the SmartTrader rate list)' },
  hi: { search: 'सामान खोजें…', all: 'सब', add: 'जोड़ें', out: 'स्टॉक खत्म', items: (n) => `${n} सामान`, order: 'WhatsApp पर ऑर्डर', name: 'आपका नाम', addr: 'पता / नोट (डिलीवरी के लिए)',
    send: 'WhatsApp पर भेजें', back: 'वापस', total: 'कुल', none: 'यह रेट लिस्ट अभी बंद है।', hint: 'रेट GST सहित। आखिरी बिल दुकान देगी।', empty: 'कोई सामान नहीं मिला।',
    msg: (shop) => `नमस्ते ${shop}, मुझे यह चाहिए:`, nameL: 'नाम', addrL: 'पता / नोट', foot: '(SmartTrader रेट लिस्ट से)' },
};
async function publicShop(token) {
  const app = $('#app'), l = new URLSearchParams(location.search).get('l'), L = SHOP_T[l] || (LANG === 'hi' ? SHOP_T.hi : SHOP_T.hl);
  document.documentElement.lang = L === SHOP_T.hi ? 'hi' : 'en';
  const res = await fetch('/api/public/shop/' + token).catch(() => null), d = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) { app.innerHTML = `<div class="boot"><h2>${L.none}</h2><p class="muted">${esc(d.error || '')}</p></div>`; return; }
  const key = 'st:cart:' + token, items = d.items, byId = new Map(items.map((i) => [i.id, i]));
  let cart = {}; try { cart = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { cart = {}; }
  for (const k of Object.keys(cart)) if (!byId.has(+k) || !(cart[k] > 0)) delete cart[k];
  const save = () => { try { localStorage.setItem(key, JSON.stringify(cart)); } catch (e) { /* storage off */ } };
  const cats = [...new Set(items.map((i) => i.category).filter(Boolean))];
  let q = '', cat = '';
  app.innerHTML = `<div class="shop"><header class="shop-head"><h1>${esc(d.shop.name)}</h1>${d.shop.city ? `<p class="muted">${esc(d.shop.city)}</p>` : ''}
      ${d.shop.note ? `<p class="shop-note">${esc(d.shop.note)}</p>` : ''}<input id="sq" type="search" placeholder="${L.search}" autocomplete="off" aria-label="${L.search}"></header>
    ${cats.length > 1 ? `<div class="chips" id="scats"><button type="button" class="chip on" data-c="">${L.all}</button>${cats.map((c) => `<button type="button" class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <div id="slist" class="shop-list"></div><p class="muted small shop-hint">${L.hint}</p>
    <div class="shop-bar" id="sbar" hidden><span id="scount"></span><button type="button" class="btn primary" id="sorder">${L.order}</button></div><div id="ssheet"></div></div>`;
  const totalOf = () => Object.entries(cart).reduce((t, [id, n]) => t + byId.get(+id).price * n, 0);
  const bar = () => { const n = Object.values(cart).reduce((a, b) => a + b, 0); $('#sbar').hidden = !n; $('#scount').textContent = `${L.items(n)} · ${inr(totalOf())}`; };
  const draw = () => {
    const rows = items.filter((i) => (!cat || i.category === cat) && (!q || i.name.toLowerCase().includes(q)));
    $('#slist').innerHTML = rows.length ? rows.map((i) => `<div class="shop-item${i.in_stock === false ? ' out' : ''}"><div><b>${esc(i.name)}</b><div class="muted small">${esc(i.unit)}${i.in_stock === false ? ` · ${L.out}` : ''}</div></div>
        <div class="shop-price">${inr(i.price)}</div><div class="shop-qty">${cart[i.id] ? `<button type="button" class="btn sm" data-dec="${i.id}" aria-label="-">−</button><b>${cart[i.id]}</b><button type="button" class="btn sm" data-inc="${i.id}" aria-label="+">+</button>`
          : `<button type="button" class="btn sm primary" data-inc="${i.id}" ${i.in_stock === false ? 'disabled' : ''}>${L.add}</button>`}</div></div>`).join('') : `<p class="muted">${L.empty}</p>`;
    bar();
  };
  $('#slist').onclick = (e) => {
    const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
    if (inc) cart[inc.dataset.inc] = (cart[inc.dataset.inc] || 0) + 1;
    else if (dec) { cart[dec.dataset.dec] -= 1; if (cart[dec.dataset.dec] <= 0) delete cart[dec.dataset.dec]; } else return;
    save(); draw();
  };
  $('#sq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  if ($('#scats')) $('#scats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; cat = b.dataset.c; $$('#scats .chip').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  $('#sorder').onclick = () => {
    const lines = Object.entries(cart).map(([id, n], k) => { const i = byId.get(+id); return `${k + 1}. ${i.name} (${i.unit}) × ${n} = ${inr(i.price * n)}`; });
    $('#ssheet').innerHTML = `<div class="shop-sheet panel"><h3 style="margin-top:0">${L.order}</h3><pre class="shop-pre">${esc(lines.join('\n'))}\n${L.total}: ${inr(totalOf())}</pre>
      <label class="f">${L.name}<input id="sname" maxlength="60" autocomplete="name"></label><label class="f">${L.addr}<textarea id="saddr" rows="2" maxlength="300"></textarea></label>
      <div class="row"><button type="button" class="btn" id="sback">${L.back}</button><span class="spacer"></span><button type="button" class="btn primary" id="ssend">${L.send}</button></div></div>`;
    $('#sback').onclick = () => { $('#ssheet').innerHTML = ''; };
    $('#ssend').onclick = () => {
      const nm = $('#sname').value.trim(), ad = $('#saddr').value.trim();
      const text = [L.msg(d.shop.name), ...lines, `${L.total}: ${inr(totalOf())}`, nm ? `${L.nameL}: ${nm}` : '', ad ? `${L.addrL}: ${ad}` : '', L.foot].filter(Boolean).join('\n');
      window.open(`https://wa.me/${d.shop.wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    };
    $('#ssheet').scrollIntoView({ behavior: 'smooth' });
  };
  draw();
}
route(/^wa-poster$/, async (el) => {
  if (!ME.wa_bot_link) { el.innerHTML = head('WhatsApp QR poster') + `<div class="panel">${emptyCta('Turn on the WhatsApp bot in Settings first.', '<a class="btn primary" href="#/settings">Settings</a>')}</div>`; return; }
  el.innerHTML = head('WhatsApp QR poster', '<a class="btn" href="#/settings">Back</a><button class="btn primary" data-act="print">Print</button>') + `
    <div class="panel wa-poster"><h1>${esc(ME.org.name)}</h1><p class="big">Scan karein, WhatsApp par apna hisab paayein</p>
      <div id="wapq"></div><p>Bills · Kitna baaki hai · UPI payment link · Payment ki date</p>
      <p class="muted">स्कैन करें, WhatsApp पर अपना हिसाब पाएं · Scan to get your account on WhatsApp</p></div>`;
  qrInto($('#wapq'), ME.wa_bot_link);
});

route(/^wa-inbox\/(\d+)$/, async (el, m) => {
  const t = await GET('/api/wa/inbox/' + m[1]);
  const p = t.party, waiting = t.messages.some((x) => x.dir === 'in' && x.kind === 'ask' && !x.handled);
  el.innerHTML = head(esc(p ? p.name : waPhone(t.phone)), `<a class="btn" href="#/wa-inbox">All chats</a>${p ? ` <a class="btn" href="#/khata/${p.id}">Khata</a>` : ''}`) + `
    <p class="muted">${waPhone(t.phone)}${p && p.wa_optout ? ' · <span class="neg">sent STOP: gets no automatic reminders</span>' : ''}${p ? '' : ' · not on your customer list'}</p>
    <div class="panel wa-chat" id="wachat">${t.messages.map((x) => `<div class="wa-msg ${x.dir === 'in' ? 'in' : 'out'}${x.dir === 'in' && x.kind === 'ask' && !x.handled ? ' ask' : ''}">
      <div>${waBody(x.body)}</div><div class="wa-meta">${x.dir === 'in' ? '' : (WA_KIND[x.kind] || 'Shop') + ' · '}${waWhen(x.at)}</div></div>`).join('')}</div>
    ${t.window_open ? `<form class="panel wa-reply" id="waform"><textarea name="text" rows="2" maxlength="1500" placeholder="Type your reply…" required></textarea>
      <div class="row"><span class="muted small">Free: the customer wrote in the last 24 hours. It goes with your shop's name on top.</span><span class="spacer"></span>
      ${waiting ? '<button type="button" class="btn" id="wadone">Mark answered</button>' : ''}<button class="btn primary">Send</button></div></form>`
    : `<div class="panel"><p class="muted">More than 24 hours since the customer wrote, so WhatsApp allows only an approved template now.
      ${p && p.phone ? `Call them on <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>, or send a reminder from <a href="#/khata/${p.id}">their khata</a>.` : 'Call them, or ask them to write again.'}</p>
      ${waiting ? '<button class="btn" id="wadone">Mark answered</button>' : ''}</div>`}`;
  const box = $('#wachat');
  box.scrollTop = box.scrollHeight;
  if ($('#waform')) $('#waform').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button.primary');
    b.disabled = true;
    try { await POST(`/api/wa/inbox/${t.phone}/reply`, { text: e.target.text.value }); toast('Sent'); render(); } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  };
  if ($('#wadone')) $('#wadone').onclick = async () => {
    try { await POST(`/api/wa/inbox/${t.phone}/done`, {}); toast('Marked answered'); render(); } catch (err) { toast(err.message, 'err'); }
  };
});

/* ======================================================================= stock count (cycle count) */
route(/^stockcount$/, async (el, m, q) => {
  dirty('warehouses');
  const [whs, s] = await Promise.all([master('warehouses'), GET('/api/reports/stock')]);
  const wid = +q.get('wh') || (whs[0] && whs[0].id);
  const w = whs.find((x) => x.id === wid) || {};
  const rows = s.rows.map((r) => ({ ...r, here: ((r.warehouses || []).find((x) => x.warehouse === w.name) || { qty: 0 }).qty }));
  el.innerHTML = head('Stock Count', `<select id="wh" aria-label="Godown" style="width:auto">${whs.map((x) => `<option value="${x.id}" ${x.id === wid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`) + `
    <p class="muted">Count the shelves and type what you find. Leave an item blank to skip it. On save, the differences are adjusted in stock and in the books (Stock Adjustments) in one go.</p>
    <div class="panel"><input id="search" placeholder="Filter items…" style="max-width:320px"></div>
    <form id="cf"><div class="err" hidden></div><div class="panel flush"><div class="tbl-wrap"><table class="t lines"><thead><tr><th>Item</th><th class="hide-sm">Bin</th><th class="num">System qty</th><th>Counted</th><th class="num">Difference</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-name="${esc(r.name.toLowerCase())}"><td><b>${esc(r.name)}</b><div class="muted">${esc(r.sku || '')}</div></td><td class="hide-sm">${esc((r.location || ''))}</td>
        <td class="num">${qtyf(r.here)} ${esc(r.unit)}</td><td class="c-n"><input type="number" step="any" min="0" name="c${r.id}" aria-label="Counted quantity: ${esc(r.name)}" data-sys="${r.here}" data-id="${r.id}" inputmode="decimal"></td><td class="num" data-diff></td></tr>`).join('')}</tbody></table></div></div>
      <div class="row"><input type="date" name="date" value="${ME.today}" style="max-width:170px"><span class="spacer"></span><button class="btn primary">Save count & adjust stock</button></div></form>`;
  $('#wh').onchange = (e) => go('stockcount?wh=' + e.target.value);
  $('#search').oninput = (e) => { const f = e.target.value.toLowerCase(); $$('#cf tbody tr').forEach((tr) => { tr.hidden = f && !tr.dataset.name.includes(f); }); };
  $('#cf').oninput = (e) => {
    const i = e.target; if (!i.dataset.id) return;
    const d = i.value === '' ? '' : r2(+i.value - +i.dataset.sys);
    const cell = $('[data-diff]', i.closest('tr'));
    cell.innerHTML = d === '' || d === 0 ? (d === 0 ? '<span class="muted">matches</span>' : '') : `<b class="${d > 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${qtyf(d)}</b>`;
  };
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const lines = $$('#cf input[data-id]').filter((i) => i.value !== '').map((i) => ({ item_id: +i.dataset.id, counted: i.value }));
    if (!lines.length) return toast('Type at least one counted quantity.');
    if (!confirm(`Post the count for ${lines.length} item(s)? Differences will be adjusted.`)) return;
    try {
      const r = await POST('/api/stock/count', { warehouse_id: wid, date: e.target.date.value, lines });
      dirty('items', 'accounts');
      el.innerHTML = head('Stock Count saved') + `<div class="panel">${r.adjusted} item(s) adjusted · gain ${inr(r.gain || 0)} · loss ${inr(r.loss || 0)}</div>
        <div class="panel flush">${table([{ h: 'Item', k: 'item' }, { h: 'System', num: 1, f: (x) => qtyf(x.system) }, { h: 'Counted', num: 1, f: (x) => qtyf(x.counted) },
          { h: 'Difference', num: 1, f: (x) => `<b class="${x.diff > 0 ? 'pos' : 'neg'}">${x.diff > 0 ? '+' : ''}${qtyf(x.diff)}</b>` }], r.diffs, { empty: 'Everything matched. Nothing to adjust.' })}</div>
        <div class="row"><a class="btn" href="#/stock">Stock</a><a class="btn primary" href="#/stockcount?wh=${wid}">Count again</a></div>`;
    } catch (err) { const b = $('.err', e.target); b.hidden = false; b.textContent = err.message; window.scrollTo(0, 0); }
  };
});

/* ======================================================================= pending work */
route(/^pending$/, async (el) => {
  const p = await GET('/api/reports/pending');
  const sec = (title, cols, rows, empty) => `<div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>${title}</h3><span class="badge">${rows.length}</span></div>${table(cols, rows, { empty })}</div>`;
  const docLink = (r) => `<a href="#/doc/${r.id}">${esc(r.number)}</a>`;
  const lineCols = [{ h: 'Order', f: docLink }, { h: 'Party', k: 'party' }, { h: 'Item', f: (r) => esc(r.item || '') }, { h: 'Ordered', num: 1, f: (r) => qtyf(r.qty) },
    { h: 'Pending', num: 1, f: (r) => `<b>${qtyf(r.pending)}</b> ${esc(r.unit || '')}` }, { h: 'Due', cls: 'hide-sm', f: (r) => fdate(r.due_date) }];
  const docCols = (act, to) => [{ h: 'Number', f: docLink }, { h: 'Party', k: 'party' }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Value', num: 1, f: (r) => inr(r.total) },
    { h: '', f: (r) => `<a class="btn sm" href="#/new/${to}?from=${r.id}">${act}</a>` }];
  el.innerHTML = head('Pending Orders & Receipts') + `<div class="kpis">
      <div class="kpi"><div class="l">At the gate</div><div class="v">${p.at_gate.length}</div><div class="s">vehicles not received</div></div>
      <div class="kpi"><div class="l">To receive</div><div class="v">${new Set(p.to_receive.map((r) => r.id)).size}</div><div class="s">open purchase orders</div></div>
      <div class="kpi"><div class="l">To deliver</div><div class="v">${new Set(p.to_deliver.map((r) => r.id)).size}</div><div class="s">open sales orders</div></div>
      <div class="kpi"><div class="l">To bill / invoice</div><div class="v">${p.to_bill.length + p.to_invoice.length}</div><div class="s">GRNs + delivery notes</div></div></div>
    ${sec('Vehicles at the gate (no GRN yet)', [{ h: 'Gate entry', f: (r) => `<b>${esc(r.number)}</b>` }, { h: 'Supplier', k: 'party' }, { h: 'Vehicle', k: 'vehicle_no' }, { h: 'In', f: (r) => fdate(r.date) + ' ' + esc(r.time_in || '') },
      { h: '', f: (r) => `<a class="btn sm primary" href="#/new/GRN?ge=${r.id}">Make GRN</a>` }], p.at_gate, 'Nothing waiting at the gate.')}
    ${sec('Purchase orders not fully received', lineCols, p.to_receive, 'All purchase orders are received.')}
    ${sec('Goods received, supplier bill not entered', docCols('Enter bill', 'BILL'), p.to_bill, 'Every GRN has a bill.')}
    ${sec('Sales orders not fully delivered', lineCols, p.to_deliver, 'All sales orders are delivered.')}
    ${sec('Delivered, not invoiced', docCols('Make invoice', 'INV'), p.to_invoice, 'Every delivery is invoiced.')}
    ${sec('Open quotations', docCols('Make order', 'SO'), p.open_quotes, 'No open quotations.')}`;
});

/* ======================================================================= recurring invoices and bills */
/* Rent, AMC, tuition, maintenance, monthly supply. A schedule keeps its own customer and lines (src/recurring.js):
   change them, skip a month, raise the price every year, copy it to a whole class or building. Each new bill says
   which period it is for and goes to the customer: by itself on WhatsApp, or from "To send" in one tap. */
const EVERY_T = { week: 'Every week', month: 'Every month', quarter: 'Every 3 months', year: 'Every year' };
const SEND_T = { auto: 'Send by itself on WhatsApp', ask: 'Remind me to send (one tap)', off: 'Do not send' };
const perMonth = (r) => r.amount * ({ week: 52 / 12, month: 1, quarter: 1 / 3, year: 1 / 12 }[r.every] || 1);
route(/^recurring$/, async (el) => {
  const { rows } = await GET('/api/recurring');
  const live = rows.filter((r) => r.active), sales = live.filter((r) => r.type === 'INV');
  // up to the same day next month: what the next round of bills brings in
  const [ty, tm, td] = ME.today.split('-').map(Number), till = new Date(Date.UTC(ty, tm, Math.min(td, new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
  const soon = live.flatMap((r) => r.upcoming.filter((d) => d <= till).map(() => r));
  const toSend = rows.filter((r) => r.type === 'INV' && !r.sent && r.last_doc_id);
  const btns = (r) => `<div class="rbtns"><button class="btn sm" data-redit="${r.id}">Edit</button>${r.active ? `<button class="btn sm" data-rskip="${r.id}" title="Skip the bill of ${fdate(r.next_on)}">Skip next</button>` : ''}
        ${r.type === 'INV' ? `<button class="btn sm" data-rcopy="${r.id}" title="The same bill for more customers">+ Customers</button>` : ''}
        ${r.active ? `<button class="btn sm danger" data-stop="${r.id}">Stop</button>` : `<button class="btn sm" data-resume="${r.id}">Resume</button>`}</div>`;
  const gets = (r) => (r.type === 'BILL' ? '' : { auto: 'WhatsApp, by itself', ask: 'You send (one tap)', off: 'Not sent' }[r.send] || '');
  const card = (r) => `<div class="rcard panel"><div class="row"><b>${esc(r.party || '')}</b><span class="spacer"></span><b>${inr(r.amount)}</b></div>
    <div class="muted small">${esc(EVERY_T[r.every] || r.every)}${r.ends_on ? ` till ${fdate(r.ends_on)}` : ''}${r.raise_pct ? ` · +${r.raise_pct}% a year` : ''} · ${r.active ? `next ${fdate(r.next_on)}` : 'stopped'}${gets(r) ? ` · ${esc(gets(r))}` : ''}</div>
    <div class="muted small">from <a href="#/doc/${r.src_doc_id}">${esc(r.number)}</a>${r.last_doc_id ? ` · last <a href="#/doc/${r.last_doc_id}">${esc(r.last_number)}</a>` : ''}</div>
    ${r.last_error ? `<div class="neg small">${esc(r.last_error)}</div>` : ''}${btns(r)}</div>`;
  const nextLine = (r) => r.upcoming.length ? `${fdate(r.upcoming[0])}${r.upcoming[1] ? `<div class="muted small">then ${r.upcoming.slice(1).map((d) => fdate(d).replace(/ \d{4}$/, '')).join(', ')}</div>` : ''}` : '';
  el.innerHTML = head('Recurring Bills', `<a class="btn primary" href="#/new/INV?repeat=month">+ New recurring bill</a>${ME.user.role === 'owner' ? '<button class="btn" id="rundue">Make due ones now</button>' : ''}`) + `
    <p class="muted">Rent, AMC, tuition, society maintenance, monthly supply: make the bill once and choose <b>Repeat</b>. A new one is made by itself on its date, says which month it is for, and reaches the customer on WhatsApp with a UPI link. हर महीने अपने आप बिल, ग्राहक को WhatsApp पर।</p>
    ${rows.length ? `<div class="kpis">
      <div class="kpi"><div class="l">Monthly income from repeat bills</div><div class="v pos">${inr0(sales.reduce((s, r) => s + perMonth(r), 0))}</div><div class="s">${sales.length} active for customers</div></div>
      <div class="kpi"><div class="l">Till ${fdate(till)}</div><div class="v">${soon.length} bill${soon.length === 1 ? '' : 's'}</div><div class="s">about ${inr0(soon.reduce((s, r) => s + (r.type === 'INV' ? r.amount : 0), 0))} to collect</div></div>
      ${toSend.length ? `<div class="kpi"><div class="l">Made, not sent yet</div><div class="v neg">${toSend.length}</div><div class="s"><a href="#rsend">Send them now</a></div></div>` : ''}
    </div>` : ''}
    ${toSend.length ? `<div class="panel" id="rsend"><div class="row"><h3 style="margin:0">To send to customers</h3><span class="spacer"></span><button class="btn sm" id="rs-all">Mark all as sent</button></div>
      <div class="rs-list">${toSend.map((r) => `<div class="rs-row"><span><b>${esc(r.party || '')}</b> · <a href="#/doc/${r.last_doc_id}">${esc(r.last_number)}</a> · ${inr(r.last_total)}</span>
        <span class="spacer"></span><button class="btn sm got" data-rsend="${r.id}">Send on WhatsApp</button><button class="btn sm" data-rsent="${r.id}">Sent</button></div>`).join('')}</div></div>` : ''}
    ${rows.length > 6 ? '<input id="rfind" type="search" placeholder="Find a customer or bill…" aria-label="Find" style="margin:0 0 10px;max-width:360px">' : ''}
    ${rows.length ? `<div class="rcards">${rows.map(card).join('')}</div>` : ''}
    <div class="panel flush${rows.length ? ' rtable' : ''}">${table([
      { h: 'Customer', f: (r) => `<b>${esc(r.party || '')}</b><div class="muted small">from <a href="#/doc/${r.src_doc_id}">${esc(r.number)}</a>${r.items ? ` · ${r.items} item${r.items > 1 ? 's' : ''}` : ''}${r.type === 'BILL' ? ' · purchase bill' : ''}</div>` },
      { h: 'Repeats', f: (r) => esc(EVERY_T[r.every] || r.every) + (r.ends_on ? `<div class="muted small">till ${fdate(r.ends_on)}</div>` : '')
        + (r.raise_pct ? `<div class="muted small">+${r.raise_pct}% a year from ${fdate(r.raise_on)}</div>` : '') },
      { h: 'Next', f: (r) => r.active ? nextLine(r) : '<span class="badge">stopped</span>' },
      { h: 'Amount', num: 1, f: (r) => inr(r.amount) },
      { h: 'Customer gets it', cls: 'hide-sm', f: (r) => (r.type === 'BILL' ? '<span class="muted">—</span>' : esc(gets(r))) },
      { h: 'Last made', cls: 'hide-sm', f: (r) => (r.last_doc_id ? `<a href="#/doc/${r.last_doc_id}">${esc(r.last_number)}</a>` : '—') + (r.last_error ? `<div class="neg small">${esc(r.last_error)}</div>` : '') },
      { h: '', f: btns }],
    rows, { empty: emptyCta('No recurring bills yet. Make a bill once and choose <b>Repeat: every month</b>. It is then made by itself and sent to the customer.', '<a class="btn primary" href="#/new/INV?repeat=month">+ New recurring bill</a>') })}</div>`;
  const byId = (id) => rows.find((r) => r.id === +id);
  const act = (sel, fn) => $$(sel, el).forEach((b) => { b.onclick = async () => { try { await fn(b); } catch (e) { toast(e.message, 'err'); } }; });
  act('[data-stop]', async (b) => { if (!confirm('Stop this schedule? Bills already made stay as they are.')) return; await POST(`/api/recurring/${b.dataset.stop}/stop`); toast('Stopped'); render(); });
  act('[data-resume]', async (b) => { await POST(`/api/recurring/${b.dataset.resume}/resume`); toast('Started again'); render(); });
  act('[data-rskip]', async (b) => {
    const r = byId(b.dataset.rskip);
    if (!confirm(`Skip the bill of ${fdate(r.next_on)} for ${r.party}? The one after it is made as usual.`)) return;
    const x = await POST(`/api/recurring/${r.id}/skip`); toast(x.next_on ? `Skipped. Next bill on ${fdate(x.next_on)}.` : 'Skipped. That was the last one.'); render();
  });
  act('[data-redit]', (b) => recurringEdit(+b.dataset.redit));
  act('[data-rcopy]', (b) => recurringCopy(byId(b.dataset.rcopy)));
  act('[data-rsent]', async (b) => { await POST('/api/recurring/sent', { ids: [+b.dataset.rsent] }); render(); });
  act('[data-rsend]', (b) => {
    const r = byId(b.dataset.rsend);
    sendDialog({ title: `Send ${r.last_number} to ${r.party}`, lang: r.lang, load: (l) => GET(`/api/docs/${r.last_doc_id}/share?lang=${l}`),
      sent: () => POST('/api/recurring/sent', { ids: [r.id] }), closed: () => render() });
  });
  if ($('#rs-all')) $('#rs-all').onclick = async () => { await POST('/api/recurring/sent', { ids: toSend.map((r) => r.id) }); render(); };
  if ($('#rfind')) $('#rfind').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    $$('table tbody tr, .rcard', el).forEach((x) => { x.hidden = !!t && !x.textContent.toLowerCase().includes(t); });
  };
  if ($('#rundue')) $('#rundue').onclick = async () => {
    try { const r = await POST('/api/recurring/run'); dirty('items', 'accounts', 'parties'); toast(r.made ? `${r.made} made` : 'Nothing is due today'); render(); } catch (e) { toast(e.message, 'err'); }
  };
});
/* change a schedule: customer, how often, dates, how it is sent, the yearly rise and the lines on the bill */
async function recurringEdit(id) {
  const [r, parties, items] = await Promise.all([GET('/api/recurring/' + id), master('parties'), master('items')]);
  const side = r.type === 'INV' ? 'customer' : 'supplier';
  const plist = parties.filter((p) => p.kind === side || p.kind === 'both');
  const itemOpt = (sel) => `<option value="">Type below…</option>` + items.map((i) => `<option value="${i.id}" ${+sel === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const gstOpt = (sel) => ME.gst_rates.map((g) => `<option value="${g}" ${+sel === g ? 'selected' : ''}>${g}%</option>`).join('');
  const row = (l) => `<tr><td><select data-k="item_id" aria-label="Item">${itemOpt(l.item_id)}</select><input data-k="description" placeholder="or what it is for (e.g. Rent)" value="${esc(l.item_id ? '' : l.description || '')}"></td>
    <td data-l="Qty"><input data-k="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(l.qty ?? 1)}" aria-label="Quantity"></td>
    <td data-l="Rate ₹"><input data-k="rate" type="number" step="any" min="0" inputmode="decimal" value="${esc(l.rate ?? '')}" aria-label="Rate"></td>
    <td data-l="GST"><select data-k="gst_rate" aria-label="GST">${gstOpt(l.gst_rate ?? 0)}</select><input type="hidden" data-k="discount_pct" value="${esc(l.discount_pct || 0)}"></td>
    <td><button type="button" class="btn sm danger" data-rl-del aria-label="Remove">&times;</button></td></tr>`;
  const f = modal(`Recurring bill from ${r.number}`, [
    { k: 'party_id', label: side === 'customer' ? 'Customer' : 'Supplier', type: 'select', value: r.party_id, options: plist.map((p) => ({ v: p.id, t: p.name })) },
    { k: 'every', label: 'Repeat', type: 'select', value: r.every, options: Object.entries(EVERY_T).map(([v, t]) => ({ v, t })) },
    { k: 'next_on', label: 'Next bill on', type: 'date', value: r.next_on, required: true },
    { k: 'ends_on', label: 'Stop after (optional)', type: 'date', value: r.ends_on || '' },
    ...(r.type === 'INV' ? [{ k: 'send', label: 'The customer gets each new bill', type: 'select', value: r.send, options: Object.entries(SEND_T).map(([v, t]) => ({ v, t })),
      help: r.send === 'auto' || ME.org.auto_wa ? 'By itself needs Automatic WhatsApp (Settings). Otherwise it waits under “To send”.' : 'Turn on Automatic WhatsApp in Settings to send by itself.' }] : []),
    { k: 'raise_pct', label: 'Raise the price every year by (%)', type: 'number', value: r.raise_pct || '', placeholder: 'e.g. 5 for rent', more: !r.raise_pct },
    { k: 'raise_on', label: 'First rise on', type: 'date', value: r.raise_on || '', more: !r.raise_pct, help: 'Empty: one year after the next bill.' },
    { k: 'notes', label: 'Note on every bill', value: r.notes || '', more: true, help: 'The period (e.g. “For November 2026”) is added by itself.' },
  ], async (v) => {
    const lines = $$('#rl-body tr', f).map((tr) => Object.fromEntries($$('[data-k]', tr).map((x) => [x.dataset.k, x.value]))).filter((l) => (l.item_id || l.description) && +l.qty > 0);
    await api('PUT', '/api/recurring/' + id, { ...v, raise_pct: v.raise_pct || 0, party_id: +v.party_id, lines });
    toast('Saved. The next bill uses these.'); render();
  }, { submit: 'Save', intro: '<p class="muted">Changes apply to the next bills only. Bills already made stay as they are.</p>' });
  $('.form', f).insertAdjacentHTML('afterend', `<div class="rl"><h3>On each bill</h3><div class="tbl-wrap"><table class="t rl-t"><thead><tr><th>Item</th><th>Qty</th><th>Rate ₹</th><th>GST</th><th></th></tr></thead>
    <tbody id="rl-body">${r.lines.map(row).join('')}</tbody></table></div><div class="row" style="margin-top:6px"><button type="button" class="btn sm" id="rl-add">+ Add line</button><span class="spacer"></span><b id="rl-sum"></b></div></div>`);
  const sum = () => {
    const t = $$('#rl-body tr', f).reduce((s, tr) => { const g = (k) => +($(`[data-k=${k}]`, tr).value || 0); return s + g('qty') * g('rate') * (1 - g('discount_pct') / 100) * (1 + g('gst_rate') / 100); }, 0);
    $('#rl-sum', f).textContent = `About ${inr(t)} with GST`;
  };
  const wire = (tr) => {
    $('[data-rl-del]', tr).onclick = () => { if ($$('#rl-body tr', f).length > 1) { tr.remove(); sum(); } };
    $('[data-k=item_id]', tr).onchange = (e) => {
      const it = items.find((i) => i.id === +e.target.value);
      if (it) { $('[data-k=rate]', tr).value = it.sale_price ?? ''; $('[data-k=gst_rate]', tr).value = it.gst_rate; $('[data-k=description]', tr).value = ''; }
      sum();
    };
  };
  $$('#rl-body tr', f).forEach(wire);
  $('#rl-add', f).onclick = () => { $('#rl-body', f).insertAdjacentHTML('beforeend', row({ qty: 1 })); wire($('#rl-body', f).lastElementChild); sum(); };
  f.addEventListener('input', sum); sum();
}
/* the same bill for more customers: a class, a building, every AMC client */
async function recurringCopy(r) {
  const parties = (await master('parties')).filter((p) => (p.kind === 'customer' || p.kind === 'both') && p.id !== r.party_id);
  const f = modal(`Same bill for more customers`, [], async () => {
    const ids = $$('[data-pc]:checked', f).map((x) => +x.dataset.pc);
    if (!ids.length) throw new Error('Tick at least one customer.');
    const x = await POST(`/api/recurring/${r.id}/copy`, { party_ids: ids });
    toast(`${x.count} more customer${x.count > 1 ? 's' : ''} will get this bill ${(EVERY_T[r.every] || '').toLowerCase()}, from ${fdate(r.next_on < ME.today ? ME.today : r.next_on)}.`); render();
  }, { submit: 'Start for these', intro: `<p class="muted">Each customer gets their own bill of ${inr(r.amount)} ${(EVERY_T[r.every] || '').toLowerCase()}, with the same items. Change one later with Edit. Good for tuition, rent in a building, society maintenance, AMC.</p>` });
  $('.form', f).insertAdjacentHTML('afterend', `<input type="search" id="pc-find" placeholder="Find…" aria-label="Find customer" style="margin:6px 0">
    <div class="row" style="margin:0 0 6px"><button type="button" class="btn sm" id="pc-all">Tick all shown</button><span class="spacer"></span><span class="muted" id="pc-n">0 ticked</span></div>
    <div class="pc-list">${parties.map((p) => `<label class="check" data-pn="${esc(p.name.toLowerCase())}"><input type="checkbox" data-pc="${p.id}"> ${esc(p.name)}${p.phone ? ` <span class="muted small">${esc(p.phone)}</span>` : ''}</label>`).join('') || '<p class="muted">No other customers yet.</p>'}</div>`);
  const count = () => { $('#pc-n', f).textContent = `${$$('[data-pc]:checked', f).length} ticked`; };
  f.addEventListener('change', count);
  $('#pc-find', f).oninput = (e) => { const t = e.target.value.trim().toLowerCase(); $$('[data-pn]', f).forEach((l) => { l.hidden = !!t && !l.dataset.pn.includes(t); }); };
  $('#pc-all', f).onclick = () => { $$('[data-pn]:not([hidden]) [data-pc]', f).forEach((x) => { x.checked = true; }); count(); };
}

/* ======================================================================= vasooli (collections): src/vasooli.js
   One screen for getting paid: who to remind today (on a schedule: 3 days before the due date, on it, then 7 / 15 / 30 /
   45 days late), the monthly balance statements customers confirm with one tap, who collected what, and the week. */
const STEP_NAME = { '-3': 'before due date', 0: 'due today', 7: '7 days late', 15: '15 days late', 30: '30 days late', 45: '45+ days: final' };
const lateText = (r) => (r.days_late < 0 ? `due in ${-r.days_late} day${r.days_late === -1 ? '' : 's'}` : r.days_late === 0 ? 'due today' : `${r.days_late} days late`);
route(/^reminders$/, async (el) => {
  const [v, kh] = await Promise.all([GET('/api/vasooli'), GET('/api/khata')]);
  const s = v.summary, conf = new Map(v.confirmations.map((f) => [f.party_id, f]));
  const due = v.queue.filter((r) => r.status === 'due'), rest = v.queue.filter((r) => r.status !== 'due');
  const khRows = kh.rows.filter((r) => r.balance > 0), money = ME.can.finance;
  const who = (r) => `<a href="#/party/${r.party_id}">${esc(r.name)}</a>${r.vip ? ' <span class="badge">VIP</span>' : ''}<div class="muted">${esc(r.phone || 'no mobile')}</div>`;
  const toneBadge = (r) => r.tone === 'final' ? '<span class="badge b-unpaid">final reminder</span>' : r.tone === 'late30' ? '<span class="badge b-partial">30+ days</span>' : '';
  const cfCell = (r) => {
    const f = conf.get(r.party_id);
    if (!f) return '<span class="muted">never sent</span>';
    const when = fdate(f.status === 'sent' ? f.created_at.slice(0, 10) : (f.answered_at || '').slice(0, 10));
    return f.status === 'agreed' ? `<span class="badge b-paid">✓ confirmed ${inr(f.balance)}</span><div class="muted">${when}</div>`
      : f.status === 'disputed' ? `<span class="badge b-unpaid">disputed</span><div class="neg">“${esc(f.note)}”${f.disputed_bill ? ` (${esc(f.disputed_bill)})` : ''}</div><div class="muted">${when}</div>`
      : `<span class="muted">sent ${when}, no answer yet</span>`;
  };
  el.innerHTML = head('Vasooli <span class="muted h-sub">(collections)</span>', `${s ? '<button class="btn" id="week">Share week report</button>' : ''}<a class="btn" href="#/vaade">Vaade (promises)</a>`)
    + `${ME.org.upi_id ? '' : '<div class="panel warnbox">Add your <b>UPI ID</b> in <a href="#/settings">Business &amp; Users</a> so customers get a Pay by UPI button and QR in every message.</div>'}
    ${s ? `<div class="kpis">
      <div class="kpi"><div class="l">Received, last 7 days</div><div class="v pos">${inr(s.received)}</div><div class="s">from ${s.payers} customer${s.payers === 1 ? '' : 's'}${s.top_payer ? ` · top: ${esc(s.top_payer.name)}` : ''}</div></div>
      <div class="kpi"><div class="l">Promised this week</div><div class="v">${inr(s.promised)}</div><div class="s">${s.promised_n} promise${s.promised_n === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="l">45+ days late</div><div class="v ${s.late45 > 0 ? 'neg' : ''}">${inr(s.late45)}</div><div class="s">${s.late45_n} customer${s.late45_n === 1 ? '' : 's'} · total due ${inr(s.outstanding)}</div></div>
      <div class="kpi"><div class="l">Days to get paid</div><div class="v">${s.avg_days === null ? '–' : s.avg_days}</div><div class="s">${s.avg_days_before !== null && s.avg_days !== null ? `was ${s.avg_days_before} in the 90 days before` : 'bills cleared in the last 90 days'}</div></div>
    </div>` : ''}
    <div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Send today</h3><span class="badge">${due.length}</span></div>
      <p class="muted" style="padding:0 16px">Reminders go on a schedule: 3 days before the due date, on it, then 7, 15, 30 and 45 days late. A customer's own promise date pauses them; VIP customers only get gentle ones.${v.msme ? '' : ' Add your Udyam number in Settings to mention MSMED interest in 30+ day reminders.'}</p>
      ${table([{ h: 'Customer', f: who }, { h: 'Late', f: (r) => `${lateText(r)} ${toneBadge(r)}`, cls: 'hide-sm' }, { h: 'Due', num: 1, f: (r) => `<b>${inr(r.due)}</b><div class="muted">${r.bills} bill${r.bills === 1 ? '' : 's'}</div>` },
        { h: '', f: (r) => `<button class="btn sm got" data-rem="${r.party_id}">Send reminder</button>${r.days_late >= 30 && money ? ` <a class="btn sm" href="#/recovery/${r.party_id}">Recovery file</a>` : ''}` }],
      due, { empty: 'Nothing to send today. 🎉' })}
      ${rest.length ? `<details class="vq-later"><summary>Scheduled and paused (${rest.length})</summary>${table([{ h: 'Customer', f: who },
        { h: 'Status', f: (r) => r.status === 'promised' ? `<span class="badge b-paid">promised ${inr(r.promise.amount)} by ${fdate(r.promise.on)}</span>`
          : r.status === 'sent' ? `sent ${fdate(r.last_sent.at.slice(0, 10))} (${esc(STEP_NAME[r.last_sent.step] || '')})${r.next_on ? `<div class="muted">next on ${fdate(r.next_on)}</div>` : ''}`
          : `<span class="muted">first reminder on ${fdate(r.next_on)}</span>` },
        { h: 'Due', num: 1, f: (r) => inr(r.due) }, { h: '', f: (r) => `<button class="btn sm" data-rem="${r.party_id}">Send now</button>` }], rest)}</details>` : ''}</div>
    <div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Balance confirmation</h3></div>
      <p class="muted" style="padding:0 16px">Once a month, send each customer their balance. They tap <b>Correct</b> or <b>Something is wrong</b> on their phone. A wrong bill comes up now, not months later, and every answer is kept with its date as proof.</p>
      ${table([{ h: 'Customer', f: who }, { h: 'Due now', num: 1, cls: 'hide-sm', f: (r) => inr(r.due) }, { h: 'Last statement', f: (r) => cfCell(r) },
        { h: '', f: (r) => `<button class="btn sm" data-cf="${r.party_id}">Send statement</button>` }], v.queue, { empty: 'No customer owes you on bills.' })}</div>
    ${s && s.staff.length ? `<div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Who collected what</h3></div>
      <p class="muted" style="padding:0 16px">Every receipt can go to the customer on WhatsApp with the collector's name, so cash taken by staff cannot quietly go missing.</p>
      ${table([{ h: 'Collected by', k: 'name' }, { h: 'Last 7 days', num: 1, f: (r) => `${inr(r.week)}<div class="muted">${r.n_week} receipt${r.n_week === 1 ? '' : 's'}</div>` },
        { h: 'Cash, 7 days', num: 1, cls: 'hide-sm', f: (r) => inr(r.cash_week) }, { h: 'This month', num: 1, f: (r) => inr(r.month) }], s.staff)}</div>` : ''}
    <div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Khata dues</h3><span class="badge">${khRows.length}</span></div>${table([
      { h: 'Contact', f: (r) => `<a href="#/khata/${r.id}">${esc(r.name)}</a><div class="muted">${esc(r.phone || 'no mobile')}</div>` }, { h: 'Baaki', num: 1, f: (r) => `<b>${inr(r.balance)}</b>` },
      { h: '', f: (r) => `<button class="btn sm got" data-kh="${r.id}">Send reminder</button>` }], khRows, { empty: 'No khata dues.' })}</div>`;
  const row = (id) => v.queue.find((r) => r.party_id === +id);
  $$('[data-rem]', el).forEach((b) => b.onclick = () => { const r = row(b.dataset.rem); sendDialog({ title: `Reminder to ${r.name}`, lang: r.lang,
    intro: `<p class="muted">${esc(lateText(r))}${r.vip ? ' · VIP: gentle wording' : ''}. The message gets firmer as bills get older.</p>`,
    load: (l) => GET(`/api/parties/${r.party_id}/reminder?lang=${l}`),
    sent: (via, m, l) => POST(`/api/vasooli/${r.party_id}/sent`, { step: r.step ?? -3, via, lang: l }).then(() => toast('Reminder saved')), closed: () => render() }); });
  $$('[data-cf]', el).forEach((b) => b.onclick = () => { const r = row(b.dataset.cf); sendDialog({ title: `Balance statement to ${r.name}`, lang: r.lang,
    intro: '<p class="muted">They get a private link with every open bill and two buttons: Correct, or Something is wrong.</p>',
    load: (l) => POST(`/api/parties/${r.party_id}/confirm?lang=${l}`, {}),
    sent: (via, m) => POST(`/api/vasooli/confirm/${m.id}/sent`, { via }), closed: () => render() }); });
  $$('[data-kh]', el).forEach((b) => b.onclick = () => { const r = khRows.find((x) => x.id === +b.dataset.kh);
    sendDialog({ title: `Reminder to ${r.name}`, lang: r.lang, load: (l) => GET(`/api/khata/${r.id}/reminder?lang=${l}`) }); });
  if ($('#week')) $('#week').onclick = () => sendDialog({ title: 'Your week in collections', lang: ME.org.msg_lang,
    intro: '<p class="muted">Send it to yourself or a partner. It opens WhatsApp with your own number when it is saved in Settings.</p>',
    load: (l) => GET(`/api/vasooli/report?lang=${l}`) });
});

/* ======================================================================= recovery file (one customer)
   MSMED Act interest (3 × RBI bank rate, monthly compounding, from the 46th day or the earlier agreed due date), the
   evidence the shop already has (balance confirmations, promises, reminders, receipts) and a demand-notice draft. */
route(/^recovery\/(\d+)$/, async (el, m) => {
  let rate = lsGet('st_bank_rate') || '';
  const draw = async () => {
    const f = await GET(`/api/parties/${m[1]}/recovery${rate ? '?rate=' + encodeURIComponent(rate) : ''}`);
    const P = f.party, O = f.org, withInt = f.msme && f.bank_rate, claim = f.totals.bal + (withInt ? f.totals.interest : 0);
    const addr = (x) => [x.address, x.city, x.state, x.pincode].filter(Boolean).map(esc).join(', ');
    const agreed = f.confirmations.filter((c) => c.status === 'agreed'), broken = f.promises.filter((k) => k.outcome === 'broken');
    const kind = (s) => ({ '-3': 'before due', 0: 'due day', 7: '7 days late', 15: '15 days late', 30: '30 days late', 45: '45+ days' })[s] || '';
    el.innerHTML = head(`Recovery file: ${esc(P.name)}`, `<a class="btn" href="#/reminders">Vasooli</a><button class="btn primary" data-act="print">Print / PDF</button>`) + `
      <div class="panel no-print"><div class="row">
        <label class="f inline-f">RBI Bank Rate (%)<input id="rate" type="number" step="0.01" min="0" max="30" value="${esc(rate)}" style="width:100px"></label>
        <button class="btn" id="apply">Work out interest</button><span class="muted small">Check today's Bank Rate on <a href="https://www.rbi.org.in" target="_blank" rel="noopener">rbi.org.in</a>. MSMED interest is 3 × that, compounded monthly.</span></div>
        ${f.msme ? '' : '<p class="warnbox" style="margin-top:10px">MSMED Act interest is for micro and small enterprises with Udyam registration. Add your Udyam number in <a href="#/settings">Settings → Business profile</a> to claim it. This file still has the statement, the evidence and a plain demand notice.</p>'}</div>
      <div class="doc-paper recovery">
        <div class="hdr"><div><div class="oname"><b>${esc(O.name)}</b></div><div>${addr(O)}</div>${O.gstin ? `<div>GSTIN: ${esc(O.gstin)}</div>` : ''}${f.udyam ? `<div>Udyam: ${esc(f.udyam)}</div>` : ''}</div>
          <div class="meta"><div class="title">STATEMENT OF DUES</div><div>As on ${fdate(f.today)}</div></div></div>
        <p><b>To:</b> ${esc(P.name)}${P.gstin ? ` (GSTIN ${esc(P.gstin)})` : ''}<br>${addr(P)}${P.phone ? `<br>Phone: ${esc(P.phone)}` : ''}</p>
        <div class="tbl-wrap"><table class="dl"><thead><tr><th>Bill</th><th>Date</th><th>Due by</th>${f.msme ? '<th>Interest from</th>' : ''}<th class="num">Bill amount</th><th class="num">Paid</th><th class="num">Balance</th><th class="num">Days late</th>${withInt ? '<th class="num">Interest</th>' : ''}</tr></thead>
          <tbody>${f.bills.map((b) => `<tr><td>${esc(b.number)}</td><td>${fdate(b.date)}</td><td>${fdate(b.due_date || b.date)}</td>${f.msme ? `<td>${fdate(b.appointed)}</td>` : ''}<td class="num">${inr(b.total)}</td><td class="num">${inr(b.paid)}</td>
            <td class="num"><b>${inr(b.bal)}</b></td><td class="num">${b.days_late}</td>${withInt ? `<td class="num">${inr(b.interest)}</td>` : ''}</tr>`).join('') || `<tr><td colspan="9">No unpaid bills.</td></tr>`}</tbody>
          <tfoot><tr><th colspan="${f.msme ? 6 : 5}">Total</th><th class="num">${inr(f.totals.bal)}</th><th></th>${withInt ? `<th class="num">${inr(f.totals.interest)}</th>` : ''}</tr></tfoot></table></div>
        <p class="claim">Amount claimed: <b>${inr(f.totals.bal)}</b>${withInt ? ` + interest <b>${inr(f.totals.interest)}</b> (MSMED Act, Section 16, at ${3 * f.bank_rate}% a year, monthly rests) = <b>${inr(claim)}</b>` : ''}</p>
        <h3>Evidence</h3>
        <h4>Balance confirmations</h4>${f.confirmations.length ? `<table><tr><th>Sent</th><th class="num">Balance</th><th>Answer</th></tr>${f.confirmations.map((c) => `<tr><td>${fdate(c.as_of)}</td><td class="num">${inr(c.balance)}</td>
          <td>${c.status === 'agreed' ? `Confirmed on ${fdate((c.answered_at || '').slice(0, 10))}` : c.status === 'disputed' ? `Disputed on ${fdate((c.answered_at || '').slice(0, 10))}: “${esc(c.note)}”` : 'No answer'}</td></tr>`).join('')}</table>` : '<p class="muted">None sent yet. Send one from Vasooli.</p>'}
        <h4>Payment promises</h4>${f.promises.length ? `<table><tr><th>Made on</th><th>By</th><th>Due</th><th class="num">Amount</th><th>Result</th></tr>${f.promises.map((k) => `<tr><td>${fdate(k.made_on)}</td><td>${k.made_by === 'customer' ? 'customer (on their link)' : 'noted by shop'}</td>
          <td>${fdate(k.due)}</td><td class="num">${inr(k.kamount)}</td><td>${k.outcome === 'kept' ? 'Paid' : k.outcome === 'broken' ? '<b>Not paid</b>' : 'Open'}</td></tr>`).join('')}</table>` : '<p class="muted">No promises.</p>'}
        <h4>Reminders sent</h4>${f.reminders.length ? `<table><tr><th>When</th><th>How</th><th>Stage</th><th>By</th></tr>${f.reminders.map((r) => `<tr><td>${new Date(r.sent_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
          <td>${r.via === 'sms' ? 'SMS' : 'WhatsApp'}</td><td>${kind(r.step)}</td><td>${esc(r.by_name || '')}</td></tr>`).join('')}</table>` : '<p class="muted">None logged yet.</p>'}
        <h4>Payments received</h4>${f.payments.length ? `<table><tr><th>Receipt</th><th>Date</th><th>Into</th><th class="num">Amount</th></tr>${f.payments.map((y) => `<tr><td>${esc(y.number)}</td><td>${fdate(y.date)}</td><td>${esc(y.account || '')}</td><td class="num">${inr(y.amount)}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}
        <h3 class="pb">Demand notice (draft)</h3>
        <div class="notice">
          <p>To,<br><b>${esc(P.name)}</b><br>${addr(P) || '[address]'}${P.gstin ? `<br>GSTIN: ${esc(P.gstin)}` : ''}</p>
          <p>Date: ${fdate(f.today)}</p>
          <p><b>Subject: Demand for payment of ${inr(withInt ? claim : f.totals.bal)} outstanding${f.msme ? ', under Sections 15 and 16 of the MSMED Act, 2006' : ''}</b></p>
          <p>Dear Sir / Madam,</p>
          <p>We, ${esc(O.name)}${f.msme ? `, a micro / small enterprise registered under Udyam No. ${esc(f.udyam)},` : ''} supplied goods / services to you against the bills listed in the attached statement. As on ${fdate(f.today)}, <b>${inr(f.totals.bal)}</b> remains unpaid.</p>
          ${agreed.length ? `<p>You confirmed the balance due to us on ${agreed.map((c) => fdate((c.answered_at || '').slice(0, 10))).join(', ')}.</p>` : ''}
          ${broken.length ? `<p>You promised to pay on ${broken.map((k) => fdate(k.due)).join(', ')} and did not.</p>` : ''}
          ${f.msme ? `<p>Under Section 15 of the MSMED Act, 2006, payment was due within the agreed period, not exceeding 45 days from acceptance. Under Section 16, you are liable to pay compound interest with monthly rests at three times the bank rate notified by the Reserve Bank of India${withInt ? `. As on ${fdate(f.today)}, interest of <b>${inr(f.totals.interest)}</b> has accrued, and it continues to accrue until payment` : ''}.</p>` : ''}
          <p>We request you to pay <b>${inr(withInt ? claim : f.totals.bal)}</b> within 15 days of receiving this notice${ME.org.upi_id ? `, by UPI to ${esc(ME.org.upi_id)} or` : ''} by bank transfer to our account. If it is not paid, we will be constrained to ${f.msme ? 'file a reference before the Micro and Small Enterprises Facilitation Council (MSME Samadhaan) and ' : ''}take legal action for recovery, at your cost and risk.</p>
          <p>Yours faithfully,<br>For <b>${esc(O.name)}</b><br><br><br>Authorised Signatory${O.phone ? `<br>${esc(O.phone)}` : ''}${O.email ? ` · ${esc(O.email)}` : ''}</p>
        </div>
        ${f.msme ? `<h3>MSME Samadhaan: what you will need</h3><ul>
          <li>Your Udyam number: <b>${esc(f.udyam)}</b></li><li>Buyer: <b>${esc(P.name)}</b>${P.gstin ? `, GSTIN ${esc(P.gstin)}` : ''}${addr(P) ? `, ${addr(P)}` : ''}</li>
          <li>Bills: ${f.bills.map((b) => `${esc(b.number)} (${fdate(b.date)}, ${inr(b.bal)})`).join('; ') || 'none'}</li>
          <li>Principal due: <b>${inr(f.totals.bal)}</b>${withInt ? `; interest to date: <b>${inr(f.totals.interest)}</b>` : ''}</li>
          <li>This statement, the confirmations and the reminders above as proof. File at <a href="https://samadhaan.msme.gov.in" target="_blank" rel="noopener">samadhaan.msme.gov.in</a>.</li></ul>` : ''}
        <p class="muted small">Prepared by SmartTrader from your own records. The notice is a draft: have an advocate review and sign it before you send it. Interest is an estimate and depends on the dates of acceptance and the Bank Rate in force.</p>
      </div>`;
    $('#apply').onclick = () => { rate = $('#rate').value.trim(); lsSet('st_bank_rate', rate); draw(); };
  };
  await draw();
});

/* ======================================================================= pick list (by bin location) */
route(/^picklist\/(\d+)$/, async (el, m) => {
  const d = await GET('/api/docs/' + m[1]);
  const lines = d.lines.filter((l) => l.item_id && !l.is_service).map((l) => ({ ...l, pick: d.type === 'SO' ? l.remaining : l.qty }))
    .filter((l) => l.pick > 0.0005).sort((a, b) => (a.location || '~').localeCompare(b.location || '~', 'en', { numeric: true }) || a.item.localeCompare(b.item));
  // where to pick from in this godown, in the order stock is taken: not put away first, then the default bin
  const lotsOf = new Map(await Promise.all([...new Set(lines.map((l) => l.item_id))].map(async (id) => [id, await GET(`/api/items/${id}/lots?warehouse_id=${d.warehouse_id}`).catch(() => null)])));
  const where = (l) => {
    const L = lotsOf.get(l.item_id);
    const bins = L ? L.bins.slice().sort((a, b) => (b.code === l.location) - (a.code === l.location) || a.code.localeCompare(b.code, 'en', { numeric: true })) : [];
    return bins.length ? bins.map((b) => `<b>${esc(b.code)}</b> <span class="muted">(${qtyf(b.qty)})</span>`).join('<br>') : l.location ? `<b>${esc(l.location)}</b>` : '<span class="muted">not put away</span>';
  };
  const batchOf = (l) => (l.batch_no ? esc(l.batch_no) + (l.expiry ? `<div class="muted">exp ${mmyy(l.expiry)}</div>` : '')
    : ((lotsOf.get(l.item_id) || { batches: [] }).batches.slice(0, 2).map((b) => `${esc(b.batch_no)}${b.expiry ? ` <span class="muted">exp ${mmyy(b.expiry)}</span>` : ''}`).join('<br>')));
  el.innerHTML = head(`Pick list · ${esc(d.number)}`, `<a class="btn" href="#/doc/${d.id}">Back</a><button class="btn primary" data-act="print">Print</button>`) + `
    <div class="doc-paper"><div class="hdr"><div><div style="font-size:18px;font-weight:700">PICK LIST</div><div>${esc(d.label)} ${esc(d.number)} · ${fdate(d.date)}</div></div>
      <div style="text-align:right"><b>${esc((d.party || {}).name || '')}</b><div>Godown: ${esc(d.warehouse || '')}</div></div></div>
      <div class="tbl-wrap"><table class="dl"><thead><tr><th>✓</th><th>Bin / rack</th><th>Item</th><th>Batch</th><th class="num">Qty to pick</th><th>Picked by</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td style="width:28px">☐</td><td>${where(l)}</td><td>${esc(l.item)}</td><td>${batchOf(l)}</td><td class="num"><b>${qtyf(l.pick)}</b> ${esc(l.unit || '')}</td><td style="width:120px"></td></tr>`).join('')}</tbody></table></div>
      <div class="foot"><div>Total lines: ${lines.length}</div><div class="sign">Checked by ____________</div></div></div>`;
});

/* Pack & check: the packer scans every piece (item QR label, barcode or SKU) against the Sales Order. A wrong design,
   colour or size is refused at once; when the counts match, the Delivery Note is saved from here (stock goes out then). */
route(/^pack\/(\d+)$/, async (el, m) => {
  const so = await GET('/api/docs/' + m[1]);
  let draft, st;
  try { [draft, st] = await Promise.all([GET(`/api/docs/${so.id}/convert?to=DN`), GET('/api/pick?ids=' + so.id)]); }
  catch (e) { throw new Error(so.status === 'closed' || so.status === 'converted' ? `${so.number} is already packed and sent.` : e.message); }
  const order = st.orders[0] || { lines: [] }, log = [];
  const lineOf = (id) => order.lines.find((l) => l.line_id === id);
  const paint = () => {
    const goods = order.lines, done = goods.length && goods.every((l) => l.picked >= l.want - 0.0005), any = goods.some((l) => l.picked > 0);
    $('#plines').innerHTML = goods.map((l) => `<tr class="${l.picked >= l.want - 0.0005 ? 'pk-ok' : l.picked ? 'pk-part' : ''}"><td>${esc(l.name)}<div class="muted small">${esc(l.code)}</div></td>
      <td class="num"><input class="pk-set" type="number" min="0" max="${l.want}" step="1" inputmode="numeric" data-set="${l.line_id}" value="${l.picked}" aria-label="Picked: ${esc(l.name)}"> / ${qtyf(l.want)} ${esc(l.unit || '')}</td><td>${l.picked >= l.want - 0.0005 ? '✅' : l.picked ? '…' : ''}</td>
      <td>${l.picked < l.want - 0.0005 ? `<button class="btn sm" data-all="${l.line_id}" title="Picked all the rest of this line">✓ All ${qtyf(l.want - l.picked)}</button> ` : ''}${l.picked ? `<button class="btn sm" data-minus="${l.line_id}" title="Put one back">−1</button>` : ''}</td></tr>`).join('');
    $('#plog').innerHTML = log.slice(-6).reverse().map((x) => `<div class="${x.ok ? 'pos' : 'neg'}">${esc(x.t)}</div>`).join('');
    $('#pstate').innerHTML = done ? '<span class="pchip pre">Picking complete ✓ ready to pack</span>' : `<span class="pchip none">Picked ${qtyf(order.picked)} of ${qtyf(order.need)}</span>`;
    $('#psave').disabled = !any;
    $('#psave').textContent = done ? 'Packed ✓ — save Delivery Note' : any ? 'Pack what is picked (rest stays on the order)' : 'Scan items to start';
  };
  const take = (s2) => { st = s2; Object.assign(order, s2.orders.find((o) => o.id === so.id) || { lines: [], picked: 0, need: 0 }); };
  const onCode = async (code) => {
    code = String(code || '').trim();
    if (!code) return false;
    try {
      const qn = Math.max(1, Math.round(+($('#pqty') || {}).value || 1));
      const r = await POST('/api/pick/scan', { ids: [so.id], code, qty: qn });
      if ($('#pqty')) $('#pqty').value = 1;
      take(r.state); log.push({ ok: true, t: `✓ ${r.item}${r.qty > 1 ? ` ×${r.qty}` : ''} — ${qtyf(r.line.picked)} of ${qtyf(r.line.want)}` }); beep(true); paint(); return true;
    } catch (e) { log.push({ ok: false, t: e.message }); beep(false); paint(); return false; }
  };
  el.innerHTML = head(`Pick &amp; pack · ${esc(so.number)}`, `<a class="btn" href="#/doc/${so.id}">Back</a><a class="btn" href="#/shiplabel/${so.id}">Shipping label</a>`) + `
    <div class="panel"><p><b>${esc((so.party || {}).name || '')}</b>${(so.party || {}).city ? ' · ' + esc(so.party.city) : ''} · ${fdate(so.date)} · ${payChip(so)} <span id="pstate"></span></p>
      <p class="muted">Scan each piece's QR label as you pick it, or type the picked count on a line. Wrong design, colour or size, or more than ordered, is refused. What you scan is saved at once (the owner sees it too); stock goes out only when the Delivery Note is saved.</p>
      <div class="row"><label class="pqty">Qty<input id="pqty" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Pieces for the next scan"></label><input id="pscan" placeholder="Scan or type item code…" autocomplete="off" enterkeyhint="done" style="flex:1;min-width:0">${canCamera() ? '<button class="btn primary" id="pcam">📷 Scan</button>' : ''}</div>
      <p class="muted small" style="margin:6px 0 0">Many pieces of one design / colour / size: type the quantity, then scan once.</p>
      <div id="plog" class="pk-log" aria-live="polite"></div></div>
    <div class="panel flush"><div class="tbl-wrap"><table class="t"><thead><tr><th>Item</th><th class="num">Picked / ordered</th><th></th><th></th></tr></thead><tbody id="plines"></tbody></table></div></div>
    <div class="row sticky-act"><button class="btn sm" id="preset">Start again</button><span class="spacer"></span><button class="btn primary" id="psave" disabled>Scan items to start</button></div>`;
  const inp = $('#pscan');
  inp.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value; inp.value = ''; await onCode(v); inp.focus(); } });
  if ($('#pcam')) $('#pcam').onclick = () => cameraScan(onCode);
  $('#plines').onclick = async (e) => {
    const all = e.target.closest('[data-all]');
    if (all) {
      const l = lineOf(+all.dataset.all); if (!l) return;
      // the rest of this line counted as picked; the item code still goes through the same checks
      try { const r = await POST('/api/pick/scan', { ids: [so.id], code: l.code, qty: Math.round(l.want - l.picked) }); take(r.state); log.push({ ok: true, t: `✓ ${l.name} — all ${qtyf(l.want)} picked` }); beep(true); paint(); }
      catch (er) { log.push({ ok: false, t: er.message }); beep(false); paint(); }
      return;
    }
    const b = e.target.closest('[data-minus]'); if (!b) return;
    try { take(await POST('/api/pick/undo', { line_id: +b.dataset.minus, ids: [so.id] })); paint(); } catch (er) { toast(er.message, 'err'); }
  };
  // the picked count typed in (counted by hand): saved when the box is left or Enter is pressed
  $('#plines').addEventListener('change', async (e) => {
    const box = e.target.closest('[data-set]'); if (!box) return;
    const l = lineOf(+box.dataset.set), v = Math.max(0, Math.round(+box.value || 0));
    if (!l || v === l.picked) return;
    try { take(await POST('/api/pick/set', { line_id: l.line_id, qty: v, ids: [so.id] })); log.push({ ok: true, t: `✓ ${l.name} — ${qtyf(v)} of ${qtyf(l.want)} (typed)` }); beep(true); }
    catch (er) { log.push({ ok: false, t: er.message }); beep(false); }
    paint();
  });
  $('#plines').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-set]')) { e.preventDefault(); e.target.blur(); } });
  $('#preset').onclick = async () => {
    if (!confirm('Start picking this order again from nothing?')) return;
    try { take(await POST('/api/pick/reset', { ids: [so.id] })); log.length = 0; paint(); } catch (er) { toast(er.message, 'err'); }
  };
  $('#psave').onclick = async () => {
    const short = order.lines.filter((l) => l.picked < l.want - 0.0005);
    if (short.length && !confirm(`${short.length} item${short.length === 1 ? ' is' : 's are'} not fully picked. Pack and send only what is picked?`)) return;
    // the delivery note: each goods line at what was picked; service lines go only with a complete order
    const keep = draft.lines.map((l) => {
      if (!l.item_id || l.is_service) return short.length ? null : l;
      const p = lineOf(+l.src_line_id);
      return p && p.picked > 0.0005 ? { ...l, qty: p.picked, serials: p.picked < p.want - 0.0005 ? '' : l.serials } : null;
    }).filter(Boolean);
    try {
      const d = await POST('/api/docs', { ...draft, lines: keep, packed_check: true });
      toast(`Delivery Note ${d.number} saved — stock reduced`); go(`shiplabel/${d.id}?packed=1`);
    } catch (e) { toast(e.message, 'err'); }
  };
  paint(); inp.focus();
});

/* Shipping label for a courier parcel: the customer's name, address and phone, the sender, the order number and COD.
   Size and what it shows are set by the owner in Settings → Branding & print. */
route(/^shiplabel\/(\d+)$/, async (el, m, q) => {
  const d = await GET('/api/docs/' + m[1]);
  const o = d.org || ME.org, P = o.print || {}, p = d.party || {}, size = P.ship_size || '4x6';
  const to = [p.ship_address || p.address, [p.city, p.state, p.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  const from = P.ship_from || [o.name, o.address, o.phone].filter(Boolean).join('\n');
  const mode = payModeOf(d), due = d.type === 'INV' ? d.balance : d.total;
  const pay = mode === 'prepaid' || due <= 0.5 ? '<div class="ship-cod prepaid">PREPAID</div>' : P.ship_cod !== false ? `<div class="ship-cod">COD ${inr(due)}</div>` : '';
  const pcs = d.lines.filter((l) => l.item_id && !l.is_service).reduce((s, l) => s + (+l.qty || 0), 0);
  const toBox = `<div class="ship-to"><div class="muted small">SHIP TO</div><b class="ship-name">${esc(p.name || '')}</b><div class="ship-addr">${esc(to).replace(/\n/g, '<br>')}</div>
      ${P.ship_plain || P.ship_phone !== false ? (p.phone ? `<div class="ship-ph">📞 ${esc(p.phone)}</div>` : '') : ''}</div>`;
  // address only (Settings → Branding & print): nothing about what is inside or what it costs
  const one = P.ship_plain ? `<div class="ship ship-${size} ship-plain">${toBox}
    <div class="ship-from"><div class="muted small">FROM</div>${esc(from).replace(/\n/g, '<br>')}</div></div>` : `<div class="ship ship-${size}">
    ${toBox}
    <div class="ship-mid"><div><b>${esc(d.number)}</b><div class="muted small">${fdate(d.date)} · ${qtyf(pcs)} pcs${d.awb ? ` · ${esc(d.courier)} ${esc(d.awb)}` : ''}</div></div>${pay}</div>
    ${P.ship_items ? `<div class="ship-items">${d.lines.filter((l) => l.item_id).map((l) => `${esc(l.item)} × ${qtyf(l.qty)}`).join('<br>')}</div>` : ''}
    ${P.ship_note ? `<div class="ship-note">${esc(P.ship_note)}</div>` : ''}
    <div class="ship-from"><div class="muted small">FROM</div>${esc(from).replace(/\n/g, '<br>')}</div></div>`;
  const desk = onMenu('dispatch') && seen('dispatch');
  let srf = {}; try { srf = JSON.parse(d.ship_ref || '{}') || {}; } catch (e) { srf = {}; }
  el.innerHTML = head(`Shipping label · ${esc(d.number)}`, `<a class="btn" href="#/${desk && q.get('packed') ? 'dispatch?tab=packed' : 'doc/' + d.id}">Back</a>${ME.can.settings ? '<a class="btn" href="#/settings/print">Label settings</a>' : ''}${srf.label_url ? `<a class="btn" target="_blank" rel="noopener" href="${esc(srf.label_url)}">Courier's label (PDF)</a>` : ''}<button class="btn primary" data-act="print">Print</button>`) +
    `${q.get('packed') ? `<div class="panel okbox no-print"><b>Packed ✓ ${esc(d.number)} saved, stock reduced.</b> Print this label and stick it on the parcel.
      <div class="row" style="margin-top:8px">${desk ? '<a class="btn sm primary" href="#/dispatch?tab=packed">Next: hand to courier</a><a class="btn sm" href="#/dispatch">Pack the next order</a>' : ''}<a class="btn sm" href="#/doc/${d.id}">Open delivery note</a></div></div>` : ''}
    ${to ? '' : `<div class="panel no-print"><p class="neg">This customer has no address yet. ${p.id ? `<a href="#/party/${p.id}">Add it on the customer’s page</a>` : 'Add it on the customer’s page'} so it prints here.</p></div>`}
    <div class="doc-paper ship-sheet">${one}</div>${size === '4x6' ? '<style>@media print{@page{size:4in 6in;margin:0}}</style>' : size === '100x50' ? '<style>@media print{@page{size:100mm 50mm;margin:0}}</style>' : ''}`;
  const head2 = $('.page-head', el);
  if (head2) head2.insertAdjacentHTML('beforeend', '<button class="btn" id="lblpdf">Label PDF</button>');
  $('#lblpdf').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await loadScript('/vendor/html-to-image.js');
      const node = $('.ship', el), pt = { '4x6': [288, 432], '100x50': [283.46, 141.73] }[size] || [288, 432];
      const canvas = await window.htmlToImage.toCanvas(node, { pixelRatio: 3, backgroundColor: '#ffffff', skipFonts: true });
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
      const pdf = jpegPdf([{ bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height }], { w: pt[0], h: pt[1], m: 0 });
      const file = new File([pdf], `label-${String(d.number).replace(/[^\w.-]+/g, '-')}.pdf`, { type: 'application/pdf' });
      // a phone opens its share sheet (the label printer's app, WhatsApp, Files); a computer saves the file
      if (canShareFiles()) await navigator.share({ files: [file], title: `Label ${d.number}` }).catch(() => {});
      else saveFile(file);
    } catch (er) { toast('The label PDF could not be made: ' + er.message, 'err'); }
    e.target.disabled = false;
  };
});

/* Book a packed parcel with a courier through Shiprocket: weight and size, the couriers that reach the pincode with
   rate and days, then Book: AWB, pickup and the courier's label come back (src/courier.js) */
function bookCourier(r, W) {
  const f = modal(`Book courier: ${r.number}`, [
    { k: 'weight', label: 'Weight (kg)', type: 'number', value: lsGet('st_parcel_w') || '0.5', required: true },
    { k: 'length', label: 'Length (cm)', type: 'number', value: lsGet('st_parcel_l') || 10, more: true }, { k: 'breadth', label: 'Breadth (cm)', type: 'number', value: lsGet('st_parcel_b') || 10, more: true },
    { k: 'height', label: 'Height (cm)', type: 'number', value: lsGet('st_parcel_h') || 5, more: true }],
  async (v) => {
    const sel = f.querySelector('[name=cid]:checked');
    const x = await POST('/api/courier/book', { dn_id: r.id, ...v, courier_id: sel ? +sel.value : 0 });
    lsSet('st_parcel_w', v.weight); lsSet('st_parcel_l', v.length); lsSet('st_parcel_b', v.breadth); lsSet('st_parcel_h', v.height);
    render();
    // links the person taps (a window opened after the booking's wait would be blocked as a pop-up)
    setTimeout(() => modal(`Booked: ${x.courier} ${x.awb}`, [], async () => {}, { submit: 'Done', intro: `<p>The courier is booked${x.pickup ? ` and the pickup is asked for (${esc(x.pickup)})` : ''}.</p>
      <div class="row" style="flex-wrap:wrap;gap:6px">${x.label_url ? `<a class="btn primary" target="_blank" rel="noopener" href="${esc(x.label_url)}">Open courier label</a>` : '<span class="muted">The label is not ready yet: open it from Shiprocket.</span>'}
      ${r.phone ? `<a class="btn got" target="_blank" rel="noopener" href="${esc(waTo(r.phone, fillMsg(W.msg_ship, { ...r, courier: x.courier, awb: x.awb })))}">Send tracking on WhatsApp</a>` : ''}</div>` }), 50);
  }, { submit: 'Book', intro: `<p class="muted">To <b>${esc(r.party)}</b>${r.address ? ', ' + esc(r.address) : ''} · ${r.pay_mode === 'prepaid' ? 'Prepaid' : 'COD ' + inr(r.total)}. Shiprocket picks the best courier unless you choose one.</p>` });
  f.querySelector('.form').insertAdjacentHTML('afterend', '<div class="row" style="margin:8px 0"><button type="button" class="btn sm" id="getrates">See courier rates</button></div><div id="rates" class="rates"></div>');
  f.querySelector('#getrates').onclick = async (e) => {
    const box = f.querySelector('#rates'), w = f.elements.weight.value;
    e.target.disabled = true; box.innerHTML = '<p class="muted">Asking Shiprocket…</p>';
    try {
      const x = await GET(`/api/courier/rates/${r.id}?weight=${encodeURIComponent(w)}`);
      box.innerHTML = x.couriers.length ? x.couriers.map((c, i) => `<label class="check rate-row"><input type="radio" name="cid" value="${c.id}" ${i === 0 ? 'checked' : ''}> <span><b>${esc(c.name)}</b> · ${inr(c.rate)}${c.days ? ` · ${esc(String(c.days))} days` : ''}${c.cod_charges ? ` <span class="muted small">(COD charge ${inr(c.cod_charges)})</span>` : ''}</span></label>`).join('')
        : '<p class="neg">No courier reaches this pincode for this weight.</p>';
    } catch (er) { box.innerHTML = `<p class="neg">${esc(er.message)}</p>`; }
    e.target.disabled = false;
  };
}
/* Settings → Orders & dispatch → Courier booking: connect a Shiprocket API user, pick the pickup address */
async function courierPanel(el) {
  const box = $('#crp', el); if (!box) return;
  // the owner's call brings the pickup list too (one call); anyone else, or Shiprocket not answering, gets the plain status
  let C = ME.can.settings ? await GET('/api/courier/pickups').catch(() => null) : null;
  if (!C) C = await GET('/api/courier').catch(() => ({ connected: false }));
  box.innerHTML = `<h2>Courier booking (Shiprocket)</h2>
    <p class="muted">One Shiprocket account books Delhivery, Blue Dart, DTDC, Ekart, Xpressbees, Shadowfax and more, straight from the Dispatch Desk: rates, AWB, pickup and the courier's label, then tracking.</p>
    ${C.connected ? `<p>Connected${C.email ? ` as <b>${esc(C.email)}</b>` : ''}. Parcels leave from <b>${esc(C.pickup || 'not chosen')}</b>${C.pickup_pin ? ` (${esc(C.pickup_pin)})` : ''}.</p>
      ${ME.can.settings ? `<div class="row" style="flex-wrap:wrap;gap:6px">${(C.pickups || []).length ? `<select id="crpick" aria-label="Pickup address">${C.pickups.map((p) => `<option value="${esc(p.name)}" ${p.name === C.pickup ? 'selected' : ''}>${esc(p.name)} · ${esc(p.city)} ${esc(p.pin)}</option>`).join('')}</select><button class="btn sm" id="crpsave">Use this pickup address</button>` : ''}
        <button class="btn sm danger" id="crdis">Disconnect</button></div>` : ''}`
    : ME.can.settings ? `<ol class="small"><li>In Shiprocket: Settings → API → Configure → <b>Create an API user</b> (an email of its own).</li><li>Type that email and its password here and tap Connect.</li></ol>
      <form class="form" id="crform"><label class="f">API user email<input name="email" type="email" required autocomplete="off"></label><label class="f">Password<input name="password" type="password" required autocomplete="new-password"></label>
      <label class="f">&nbsp;<button class="btn primary">Connect</button></label></form><p class="muted small">The password is kept locked (encrypted) on the server and never shown again.</p>`
    : '<p class="muted">The owner or an admin connects it.</p>'}`;
  const form = $('#crform', box);
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector('button'); b.disabled = true;
    try { await POST('/api/courier/connect', { email: form.email.value.trim(), password: form.password.value }); toast('Shiprocket connected'); courierPanel(el); }
    catch (er) { toast(er.message, 'err'); b.disabled = false; }
  };
  if ($('#crpsave', box)) $('#crpsave', box).onclick = async () => { try { await api('PUT', '/api/courier', { pickup: $('#crpick', box).value }); toast('Pickup address saved'); courierPanel(el); } catch (er) { toast(er.message, 'err'); } };
  if ($('#crdis', box)) $('#crdis', box).onclick = async () => {
    if (!confirm('Disconnect Shiprocket? Booked parcels keep their tracking numbers.')) return;
    try { await api('DELETE', '/api/courier'); toast('Disconnected'); courierPanel(el); } catch (er) { toast(er.message, 'err'); }
  };
}

/* ======================================================================= business type & menu (src/setup.js)
   One page for the owner: what kind of business (a pack sets the tools, menu, dashboard and new-item settings), then each
   tool on or off for everyone, then what a new item starts with. Roles and users can still get smaller menus of their own. */
const modDefault = (k) => (k === 'jobs' ? false : MODULES.find((x) => x[0] === k)[3].some((h) => !simple() || !ADVANCED.has(h) || (ordersOn() && DISP.has(h))));
route(/^settings\/business$/, async (el, m, q) => {
  const S = ME.org.setup || { modules: {}, item_defaults: {} }, can2 = ME.can.settings;
  let pick = q.get('pack') || S.biz || '';
  const on = (k) => (Object.hasOwn(S.modules || {}, k) ? !!S.modules[k] : modDefault(k));
  const D = S.item_defaults || {}, P0 = PACKS.find((p) => p.k === S.biz);
  el.innerHTML = head('Settings') + setTabs('settings/business') + `
    ${q.get('applied') && P0 ? `<div class="panel okbox"><b>${P0.ico} Your app is set up for ${esc(P0.t)}.</b> The tools below are on. Switch anything on or off and tap Save; nothing is deleted.
      ${q.get('next') === 'workflow' ? '<div class="row" style="margin-top:8px"><a class="btn sm primary" href="#/settings/workflow?preset=online">Next: orders &amp; dispatch set-up</a></div>' : ''}</div>` : ''}
    <div class="panel"><h2>1. What kind of business?</h2><p class="muted">Pick the closest one. Its tools, menu, dashboard and new-item settings follow; fine-tune below.</p>
      <div class="packs">${PACKS.map((p) => `<button type="button" class="pack ${p.k === pick ? 'on' : ''}" data-pack="${p.k}" ${can2 ? '' : 'disabled'}><span class="pi" aria-hidden="true">${p.ico}</span>
        <span class="pt"><b>${esc(p.t)}</b><span class="muted small">${esc(p.hi)}</span><span class="small">${esc(p.about)}</span></span></button>`).join('')}</div></div>
    <form class="panel" id="bf"><div class="err" hidden></div>
      <h2>2. Tools on your menu</h2><p class="muted">On = in the menu for everyone (a role or user can still get a smaller menu: Settings → Roles / Users). Off = hidden; its data stays.</p>
      <div class="mods">${MODULES.map(([k, t, h]) => `<label class="mod"><input type="checkbox" name="m_${k}" ${on(k) ? 'checked' : ''} ${can2 ? '' : 'disabled'}><span><b>${esc(t)}</b><br><span class="muted small">${esc(h)}</span></span></label>`).join('')}</div>
      <h2 style="margin-top:18px">3. A new item starts with</h2>
      <div class="form">
        <label class="f">Unit<input name="d_unit" value="${esc(D.unit || '')}" list="units" placeholder="Pcs" maxlength="12" ${can2 ? '' : 'disabled'}></label>
        <label class="f">GST rate<select name="d_gst" ${can2 ? '' : 'disabled'}><option value="">Choose on each item</option>${ME.gst_rates.map((g) => `<option value="${g}" ${D.gst_rate === g ? 'selected' : ''}>${g}%</option>`).join('')}</select></label>
        <label class="f check"><input type="checkbox" name="d_batch" ${D.track_batch ? 'checked' : ''} ${can2 ? '' : 'disabled'}> Track batch &amp; expiry</label>
        <label class="f check"><input type="checkbox" name="d_serial" ${D.track_serial ? 'checked' : ''} ${can2 ? '' : 'disabled'}> Track serial / IMEI</label>
        <label class="f">Wholesale price for the whole order from<span class="row"><input type="number" name="d_wsmin" min="0" step="1" inputmode="numeric" value="${D.wholesale_order_min || ''}" placeholder="e.g. 15" style="max-width:110px" ${can2 ? '' : 'disabled'}> <span class="muted">pieces</span></span>
          <small class="help">Every item of an order with this many pieces or more (mixed designs, colours, sizes) gets its wholesale price. Empty = off.</small></label>
      </div>
      <label class="check" id="dashrow" hidden><input type="checkbox" name="dash" checked> Also set my dashboard for this kind of business</label>
      <div class="row sticky-act"><span class="muted small" id="bfsum"></span><span class="spacer"></span><button class="btn primary" ${can2 ? '' : 'disabled'}>Save</button></div>
    </form>
    <div class="panel"><h2>Always on</h2><p class="muted">Sales &amp; purchase bills, returns, items &amp; stock, customers &amp; suppliers, receipts &amp; payments, expenses, GST returns, reports, backup.</p>
      <p>Staff menus and rights: <a href="#/settings/roles">Roles</a> · <a href="#/settings">Users</a>. Orders flow: <a href="#/settings/workflow">Orders &amp; dispatch</a>.</p></div>`;
  const f = $('#bf');
  const sum = () => { const n = MODULES.filter(([k]) => f.elements['m_' + k].checked).length; $('#bfsum').textContent = `${n} of ${MODULES.length} tools on`; };
  f.addEventListener('change', sum); sum();
  $$('[data-pack]', el).forEach((b) => b.onclick = () => {
    const p = PACKS.find((x) => x.k === b.dataset.pack); pick = p.k;
    $$('[data-pack]', el).forEach((x) => x.classList.toggle('on', x === b));
    for (const [k] of MODULES) f.elements['m_' + k].checked = p.on.includes(k);
    const d = p.defs || {};
    f.elements.d_unit.value = d.unit || ''; f.elements.d_gst.value = d.gst_rate ?? ''; f.elements.d_batch.checked = !!d.track_batch; f.elements.d_serial.checked = !!d.track_serial;
    $('#dashrow').hidden = p.k === S.biz; sum();
    toast(`${p.t}: recommended tools ticked. Tap Save.`, 'info');
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const box = $('.err', f); box.hidden = true;
    const E = f.elements, p = PACKS.find((x) => x.k === pick), changed = !!p && pick !== S.biz;
    try {
      await api('PUT', '/api/settings/setup', { biz: pick, modules: Object.fromEntries(MODULES.map(([k]) => [k, E['m_' + k].checked])),
        item_defaults: { unit: E.d_unit.value.trim(), gst_rate: E.d_gst.value === '' ? null : +E.d_gst.value, track_batch: E.d_batch.checked, track_serial: E.d_serial.checked,
          wholesale_order_min: E.d_wsmin.value === '' ? 0 : +E.d_wsmin.value } });
      if (changed && p.workflow) await api('PUT', '/api/settings/workflow', p.workflow);
      if (changed && E.dash.checked && DASH_TEMPLATES[p.dash]) { try { await POST('/api/dashboards', { name: p.t.split(' / ')[0].split(' (')[0], layout: { range: '30d', widgets: DASH_TEMPLATES[p.dash][1] }, is_default: true }); } catch (er) { /* a nicety */ } }
      ME = await GET('/api/me'); shell(); wireInstall();
      toast('Saved. Everyone sees the new menu the next time they open the app.'); go('settings/business' + (changed ? '?applied=1' : ''));
    } catch (err) { box.hidden = false; box.textContent = err.message; }
  };
});

/* ======================================================================= repair & service job cards (src/jobs.js) */
const JOB_T = { received: 'Received', checking: 'Checking', waiting: 'Waiting for parts', ready: 'Ready', delivered: 'Delivered', cancelled: 'Cancelled' };
const JOB_NEXT = { received: ['checking', 'ready'], checking: ['waiting', 'ready'], waiting: ['ready'], ready: ['delivered'] };
const JOB_MSG = {
  received: 'Hi {name}, we have received your {device} at {shop}. Job no. {job}. Problem: {problem}.{estimate}{promised}',
  checking: 'Hi {name}, we are checking your {device} (job {job}).{estimate}',
  waiting: 'Hi {name}, your {device} (job {job}) is waiting for a part. We will tell you as soon as it arrives.',
  ready: 'Hi {name}, your {device} (job {job}) is ready at {shop}.{bill} Please collect it.',
  delivered: 'Thank you {name} for choosing {shop}. Your {device} (job {job}) is delivered.',
  cancelled: 'Hi {name}, job {job} for your {device} is closed. Please collect it from {shop}.',
};
const jobMsg = (j) => (JOB_MSG[j.status] || JOB_MSG.received).replace(/\{(\w+)\}/g, (m0, k) => ({ name: j.party, device: j.device, shop: ME.org.name, job: j.number, problem: j.problem,
  estimate: j.estimate ? ` Estimate: ${inr(j.estimate)}${j.advance ? `, advance paid ${inr(j.advance)}` : ''}.` : '', promised: j.promised ? ` Expected by ${fdate(j.promised)}.` : '',
  bill: j.inv_total ? ` Bill: ${inr(j.inv_total)}${j.advance ? `, advance ${inr(j.advance)} already paid` : ''}.` : j.estimate ? ` Amount: ${inr(j.estimate)}${j.advance ? ` (advance ${inr(j.advance)} paid)` : ''}.` : '' }[k] ?? m0));
const jobChip = (s) => `<span class="jchip j-${s}">${JOB_T[s] || s}</span>`;
async function jobForm(j = null) {
  const parties = (await master('parties')).filter((p) => p.kind !== 'supplier');
  const f = modal(j ? `Edit job ${j.number}` : 'New job card', [
    ...(j ? [] : [{ k: 'party_id', label: 'Customer', type: 'select', options: [{ v: '', t: 'New customer (type below)' }, ...parties.map((p) => ({ v: p.id, t: p.name + (p.phone ? ' · ' + p.phone : '') }))], wide: true },
      { k: 'name', label: 'New customer name', placeholder: 'e.g. Amit Singh' }, { k: 'phone', label: 'Mobile', type: 'tel', placeholder: '98xxxxxxxx' }]),
    { k: 'device', label: 'Device / vehicle', value: j ? j.device : '', required: true, placeholder: 'e.g. Redmi Note 12, Split AC, Activa', wide: true },
    { k: 'serial', label: 'IMEI / serial / vehicle no.', value: j ? j.serial : '' },
    { k: 'promised', label: 'Promised date', type: 'date', value: j ? j.promised : '' },
    { k: 'problem', label: 'Problem (as the customer said)', type: 'textarea', value: j ? j.problem : '', required: true, wide: true },
    { k: 'estimate', label: 'Estimate (₹)', type: 'number', value: j ? j.estimate || '' : '' },
    ...(j ? [] : [{ k: 'advance', label: 'Advance taken (₹)', type: 'number' }, { k: 'account_id', label: 'Advance paid by', type: 'select', options: await cashOpts() }]),
    { k: 'accessories', label: 'Received with it', value: j ? j.accessories : '', placeholder: 'charger, cover, SIM, battery…', more: !j, wide: true },
    { k: 'condition', label: 'Condition when received', value: j ? j.condition : '', placeholder: 'screen cracked, scratches…', more: !j, wide: true },
    { k: 'tech', label: 'Technician', value: j ? j.tech : '', more: !j }, { k: 'notes', label: 'Notes (inside only)', type: 'textarea', value: j ? j.notes : '', more: !j, wide: true }],
  async (v) => {
    if (j) { await api('PUT', '/api/jobs/' + j.id, { action: 'edit', ...v }); toast('Job saved'); render(); return; }
    if (!v.party_id && !v.name) throw new Error('Choose the customer, or type a new customer’s name and mobile.');
    const r = await POST('/api/jobs', { ...v, party_id: +v.party_id || undefined, advance: +v.advance || 0, account_id: +v.account_id || undefined });
    dirty('parties', 'accounts'); toast(`Job ${r.number} opened`); go('job/' + r.id);
  }, { submit: j ? 'Save' : 'Open job card' });
  const pe = f.elements.party_id;
  if (pe) { const sync = () => { const nw = !pe.value; f.elements.name.closest('label').hidden = !nw; f.elements.phone.closest('label').hidden = !nw; }; pe.onchange = sync; sync(); }
}
route(/^jobs$/, async (el, m, q) => {
  const st = q.get('status') || 'open', J = await GET(`/api/jobs?status=${encodeURIComponent(st)}&q=${encodeURIComponent(q.get('q') || '')}`);
  const tabs = [['open', 'Open'], ['ready', 'Ready'], ['waiting', 'Waiting for parts'], ['delivered', 'Delivered'], ['all', 'All']];
  const n = (k) => (k === 'open' ? J.counts.received + J.counts.checking + J.counts.waiting + J.counts.ready : k === 'all' ? '' : J.counts[k]);
  el.innerHTML = head('Repair / Job Cards', ME.can.sales ? '<button class="btn primary" id="newjob">+ New job</button>' : '') + `
    <div class="seg seg-wrap dk-tabs">${tabs.map(([k, t]) => `<button type="button" data-st="${k}" class="${k === st ? 'on' : ''}">${t}${n(k) !== '' ? ` <span class="badge">${n(k)}</span>` : ''}</button>`).join('')}</div>
    <form class="panel" id="jq"><input name="q" value="${esc(q.get('q') || '')}" placeholder="Find by job no., name, mobile, IMEI, vehicle no.…" autocomplete="off"></form>
    ${J.late ? `<div class="panel warnbox">${J.late} job${J.late > 1 ? 's are' : ' is'} past the promised date.</div>` : ''}
    <div class="dk-list">${J.rows.length ? J.rows.map((j) => `<a class="dk-card jcard" href="#/job/${j.id}"><div class="dk-top"><div><b>${esc(j.device)}</b>${j.serial ? ` <span class="muted small">· ${esc(j.serial)}</span>` : ''}
        <div class="muted small">${esc(j.number)} · ${esc(j.party || '')}${j.phone ? ' · ' + esc(j.phone) : ''}</div></div>${jobChip(j.status)}</div>
      <div class="dk-items">${esc(j.problem.slice(0, 140))}</div>
      <div class="muted small">${fdate(j.date)}${j.promised ? ` · promised ${fdate(j.promised)}` : ''}${j.late ? ' · <span class="neg">late</span>' : ''}${j.estimate ? ` · estimate ${inr(j.estimate)}` : ''}${j.advance ? ` · advance ${inr(j.advance)}` : ''}${j.invoice ? ` · billed ${esc(j.invoice)}` : ''}</div></a>`).join('')
      : `<div class="panel">${emptyCta('Open a job card when a customer hands over a phone, AC, bike or anything to repair. Track it, update them on WhatsApp, and bill it with the parts used.', ME.can.sales ? '<button class="btn primary" data-newjob>+ New job card</button>' : '')}</div>`}</div>`;
  $$('[data-st]', el).forEach((b) => b.onclick = () => go('jobs?status=' + b.dataset.st));
  $('#jq').onsubmit = (e) => { e.preventDefault(); go(`jobs?status=${st}&q=${encodeURIComponent(e.target.q.value.trim())}`); };
  if ($('#newjob')) $('#newjob').onclick = () => jobForm();
  if ($('[data-newjob]', el)) $('[data-newjob]', el).onclick = () => jobForm();
  if (takeNew(q) && ME.can.sales) jobForm();
});
route(/^job\/(\d+)$/, async (el, m) => {
  const j = await GET('/api/jobs/' + m[1]), o = ME.org, open = !['delivered', 'cancelled'].includes(j.status);
  const due = j.inv_total ? null : j.estimate ? j.estimate - j.advance : null;
  el.innerHTML = head(`Job ${esc(j.number)} ${jobChip(j.status)}`, `<a class="btn" href="#/jobs">Back</a>${j.phone ? `<a class="btn got" target="_blank" rel="noopener" href="${waTo(j.phone, jobMsg(j))}">WhatsApp update</a>` : ''}<button class="btn primary" data-act="print">Print job slip</button>`) + `
    <div class="panel no-print"><div class="row">
      ${open && ME.can.sales ? (JOB_NEXT[j.status] || []).map((s) => `<button class="btn ${s === 'ready' || s === 'delivered' ? 'primary' : ''}" data-js="${s}">Mark ${JOB_T[s].toLowerCase()}</button>`).join('') : ''}
      ${ME.can.sales && !j.inv_id && j.status !== 'cancelled' ? `<a class="btn" href="#/new/INV?job=${j.id}">Make bill (parts + labour)</a>` : ''}
      ${j.inv_id ? `<a class="btn" href="#/doc/${j.inv_id}">Bill ${esc(j.invoice || '')}</a>` : ''}
      ${open && ME.can.sales ? '<button class="btn" id="jedit">Edit</button><button class="btn danger" data-js="cancelled">Cancel job</button>' : ''}
    </div><p class="muted small" style="margin:8px 0 0">Each step: tap <b>WhatsApp update</b> to send the customer a message for the current status.</p></div>
    <div class="doc-paper jobslip"><div class="hdr"><div><div style="font-size:18px;font-weight:700">${esc(o.name)}</div><div class="small">${esc(o.address || '')}${o.phone ? ' · ' + esc(o.phone) : ''}</div></div>
      <div style="text-align:right"><div style="font-size:16px;font-weight:700">JOB CARD</div><div><b>${esc(j.number)}</b> · ${fdate(j.date)}</div></div></div>
      <table class="dl jt"><tbody>
        <tr><th>Customer</th><td>${esc(j.party || '')}${j.phone ? ' · ' + esc(j.phone) : ''}</td></tr>
        <tr><th>Device / vehicle</th><td><b>${esc(j.device)}</b>${j.serial ? ' · ' + esc(j.serial) : ''}</td></tr>
        <tr><th>Problem</th><td>${esc(j.problem).replace(/\n/g, '<br>')}</td></tr>
        ${j.accessories ? `<tr><th>Received with it</th><td>${esc(j.accessories)}</td></tr>` : ''}
        ${j.condition ? `<tr><th>Condition</th><td>${esc(j.condition)}</td></tr>` : ''}
        <tr><th>Estimate</th><td>${j.estimate ? inr(j.estimate) : '—'}${j.advance ? ` · advance paid <b>${inr(j.advance)}</b>` : ''}${due !== null && due > 0 ? ` · balance ${inr(due)}` : ''}</td></tr>
        ${j.promised ? `<tr><th>Ready by</th><td>${fdate(j.promised)}</td></tr>` : ''}
        ${j.tech ? `<tr><th>Technician</th><td>${esc(j.tech)}</td></tr>` : ''}
        <tr><th>Status</th><td>${JOB_T[j.status]}${j.invoice ? ` · bill ${esc(j.invoice)}` : ''}</td></tr>
      </tbody></table>
      <p class="small">Please bring this slip to collect. We are not responsible for data on the device, or for items not collected within 30 days of being ready.</p>
      <div class="foot"><div class="sign">Customer ____________</div><div class="sign">For ${esc(o.name)} ____________</div></div></div>
    ${j.notes ? `<div class="panel no-print"><b>Notes (inside only):</b> ${esc(j.notes)}</div>` : ''}`;
  $$('[data-js]', el).forEach((b) => b.onclick = async () => {
    const s = b.dataset.js;
    if (s === 'cancelled' && !confirm('Cancel this job? The customer takes the device back without repair.')) return;
    try {
      const x = await api('PUT', '/api/jobs/' + j.id, { action: 'status', status: s });
      toast(`Marked ${JOB_T[s].toLowerCase()}`);
      if (x.phone && ['ready', 'delivered', 'waiting'].includes(s) && confirm(`Send ${x.party} a WhatsApp update now?`)) window.open(waTo(x.phone, jobMsg(x)), '_blank', 'noopener');
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
  if ($('#jedit')) $('#jedit').onclick = () => jobForm(j);
});

/* ======================================================================= orders & dispatch (src/dispatch.js)
   The Dispatch Desk: every order on its way out, one tap per step. Confirm a COD order with the customer on WhatsApp,
   pack it (Pack & check makes the Delivery Note), hand it to the courier with the tracking number (the customer gets it
   on WhatsApp), then delivered or returned (RTO: the stock comes back). Set up in Settings → Orders & dispatch. */
const PAY_OPTS = [['', 'Not said'], ['cod', 'COD (cash on delivery)'], ['prepaid', 'Prepaid']];
const payModeOf = (d) => d.pay_mode || (d.type === 'INV' ? (d.balance > 0.5 ? 'cod' : 'prepaid') : d.paid > 0 && d.paid >= d.total - 0.5 ? 'prepaid' : '');
const payChip = (d) => { const m = payModeOf(d); return m === 'prepaid' ? '<span class="pchip pre">PREPAID</span>' : m === 'cod' ? `<span class="pchip cod">COD ${inr(d.type === 'INV' ? d.balance : d.total)}</span>` : '<span class="pchip none">Payment not said</span>'; };
const shipText = (d) => (d.ship === 'shipped' ? `🚚 Shipped${d.courier ? ' via ' + esc(d.courier) : ''}${d.awb ? ' · ' + esc(d.awb) : ''}` : d.ship === 'delivered' ? '✅ Delivered' : d.ship === 'rto' ? '↩️ Returned by courier (RTO)' : '📦 Packed, not shipped');
const wfOf = () => (ME.org.workflow || {});
const trackLink = (r) => { const c = (wfOf().couriers || []).find((x) => x.name === r.courier); return c && c.url && r.awb ? c.url.replace(/\{awb\}/g, encodeURIComponent(r.awb)) : ''; };
const fillMsg = (tpl, r) => String(tpl || '').replace(/\{(\w+)\}/g, (m0, k) => {
  const v = { name: r.party, order: r.order_no || r.number, shop: ME.org.name, items: (r.items || []).map((x) => `• ${x.item} × ${qtyf(x.qty)}`).join('\n'), amount: inr(r.total),
    pay: r.pay_mode === 'prepaid' ? 'prepaid' : r.pay_mode === 'cod' ? 'cash on delivery' : 'payment to confirm', address: r.address, courier: r.courier, awb: r.awb, link: trackLink(r) }[k];
  return v === undefined ? m0 : v || '';
}).replace(/\n{3,}/g, '\n\n').trim();
const waTo = (phone, text) => `https://wa.me/${phone ? waNum(phone) : ''}?text=${encodeURIComponent(text)}`;
const DESK_TABS = [['confirm', 'To confirm'], ['pack', 'To pick'], ['picked', 'Picked'], ['packed', 'Packed'], ['shipped', 'On the way'], ['done', 'Done (30 days)']];
route(/^dispatch$/, async (el, m, q) => {
  clearTimeout(window.__dkT);
  const [B, CR] = await Promise.all([GET('/api/dispatch'), GET('/api/courier').catch(() => ({ connected: false }))]), W = B.workflow;
  ME.org.workflow = W;
  // "paid, not dispatched": only the prepaid orders, in every tab
  const paidOnly = q.get('paid') === '1';
  if (paidOnly) for (const [k] of DESK_TABS) if (Array.isArray(B[k])) { B[k] = B[k].filter((r) => r.pay_mode === 'prepaid'); B.counts[k] = B[k].length; }
  const pq = paidOnly ? '&paid=1' : '';
  const tabs = DESK_TABS.filter(([k]) => k !== 'confirm' || W.confirm_cod || B.counts.confirm);
  let tab = q.get('tab') && tabs.some(([k]) => k === q.get('tab')) ? q.get('tab') : (tabs.find(([k]) => B.counts[k] && k !== 'done') || tabs.find(([k]) => k === 'pack'))[0];
  const canPack = ME.can.sales || (ME.can.stock && !limits().no_dispatch);
  const courierOpts = (cur) => `<option value="">Courier…</option>${W.couriers.map((c) => `<option ${c.name === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  const card = (r) => {
    const head2 = `<div class="dk-top"><div><b>${esc(r.party || 'Customer')}</b>${r.city ? ` <span class="muted">· ${esc(r.city)}</span>` : ''}
        <div class="muted small">${tab === 'pack' || tab === 'picked' || tab === 'confirm' ? `<a href="#/doc/${r.id}">${esc(r.number)}</a>` : `<a href="#/doc/${r.id}">${esc(r.number)}</a>${r.order_no ? ' · order ' + esc(r.order_no) : ''}`} · ${r.age ? r.age + ' day' + (r.age > 1 ? 's' : '') + ' old' : 'today'}${r.phone ? ' · ' + esc(r.phone) : ''}</div></div>
      <div class="dk-pay">${tab === 'done' ? (r.ship === 'rto' ? '<span class="pchip none">RTO</span>' : '<span class="pchip pre">Delivered</span>') : `<select data-pm="${r.id}" aria-label="Payment" class="pm-${r.pay_mode || 'none'}">${PAY_OPTS.map(([v, t]) => `<option value="${v}" ${r.pay_mode === v ? 'selected' : ''}>${v === 'cod' ? 'COD ' + inr(r.total) : v === 'prepaid' ? 'Prepaid' : 'Payment?'}</option>`).join('')}</select>`}</div></div>
      <div class="dk-items">${r.items.slice(0, 4).map((x) => `${esc(x.item)} <b>× ${qtyf(x.qty)}</b>`).join(' · ')}${r.items.length > 4 ? ` · +${r.items.length - 4} more` : ''} <span class="muted">(${qtyf(r.pcs)} pcs)</span></div>
      ${r.address ? `<div class="muted small">📍 ${esc(r.address)}</div>` : '<div class="neg small">No address yet: add it on the customer page before shipping.</div>'}`;
    const acts = {
      confirm: `<a class="btn sm got" target="_blank" rel="noopener" href="${waTo(r.phone, fillMsg(W.msg_confirm, r))}">WhatsApp to confirm</a><button class="btn sm primary" data-ok="${r.id}">Customer confirmed ✓</button>`,
      pack: `${canPack ? `<a class="btn sm primary" href="#/pack/${r.id}">Pick &amp; pack (scan)</a>` : ''}${W.pick_mode === 'scan' ? '' : `<a class="btn sm" href="#/picklist/${r.id}">${W.pick_mode === 'paper' ? 'Print pick list' : 'Pick list'}</a>`}<a class="btn sm" href="#/shiplabel/${r.id}">Label</a>${r.picked ? `<span class="pchip none">picked ${qtyf(r.picked)}/${qtyf(r.pcs)}</span>` : ''}`,
      picked: `${canPack ? `<a class="btn sm primary" href="#/pack/${r.id}">Pack ✓ (save Delivery Note)</a>` : ''}<span class="pchip pre">all ${qtyf(r.pcs)} picked</span><a class="btn sm" href="#/shiplabel/${r.id}">Label</a>`,
      packed: `${r.packed_by || r.packed_at ? `<div class="muted small" style="flex-basis:100%">Packed${r.packed_by ? ' by ' + esc(r.packed_by) : ''}${r.packed_at ? ' · ' + fdate(r.packed_at.slice(0, 10)) + ' ' + esc(new Date(r.packed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })) : ''}</div>` : ''}${CR.connected ? `<button class="btn sm primary" data-book="${r.id}">Book courier (Shiprocket)</button><span class="muted small">or hand it yourself:</span>` : ''}<div class="dk-ship"><select data-cr="${r.id}" aria-label="Courier">${courierOpts(r.courier)}</select><input data-awb="${r.id}" placeholder="Tracking / AWB no." value="${esc(r.awb)}" autocomplete="off">
        <button class="btn sm primary" data-ship="${r.id}">Shipped</button></div><a class="btn sm" href="#/shiplabel/${r.id}">Label</a>${r.invoice ? `<span class="muted small">Invoiced ${esc(r.invoice)}</span>` : ''}`,
      shipped: `${r.sr && r.sr.track_url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(r.sr.track_url)}">Track</a>` : trackLink(r) ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(trackLink(r))}">Track</a>` : ''}
        ${r.sr && r.sr.label_url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(r.sr.label_url)}">Courier label</a>` : ''}${r.sr && CR.connected ? `<button class="btn sm" data-trk="${r.id}">Refresh tracking</button>` : ''}<a class="btn sm got" target="_blank" rel="noopener" href="${waTo(r.phone, fillMsg(W.msg_ship, r))}">Send tracking on WhatsApp</a>
        <button class="btn sm primary" data-dl="${r.id}">Delivered</button><button class="btn sm danger" data-rto="${r.id}">Returned (RTO)</button><div class="muted small" style="flex-basis:100%">${shipText(r)}${r.sr && r.sr.status ? ` · courier says: <b>${esc(r.sr.status)}</b>` : ''}</div>`,
      done: `<span class="muted small">${shipText(r)} · ${fdate((r.ship_at || '').slice(0, 10))}</span>${r.sr && r.sr.ret ? `<span class="muted small">· return pickup ${r.sr.ret.awb ? esc(r.sr.ret.courier + ' ' + r.sr.ret.awb) : 'made on Shiprocket'}</span>`
        : r.ship === 'delivered' && r.sr && CR.connected ? `<button class="btn sm" data-ret="${r.id}">Return pickup</button>` : ''}`,
    }[tab];
    return `<div class="dk-card" data-find="${esc([r.party, r.phone, r.number, r.order_no, r.awb, r.city].join(' ').toLowerCase())}">${head2}<div class="dk-acts">${acts}</div></div>`;
  };
  const list = B[tab];
  const empty = { confirm: 'No order is waiting for the customer’s confirmation.', pack: 'Nothing to pick. New orders show up here by themselves.', picked: 'No order is fully picked yet. Pick by scan: an order shows here when its last piece is scanned.', packed: 'No packed parcel is waiting for the courier.',
    shipped: 'No parcel is on the way.', done: 'Nothing delivered or returned in the last 30 days.' }[tab];
  el.innerHTML = head('Dispatch Desk', `${ME.can.sales ? '<a class="btn primary" href="#/new/SO">+ New order</a>' : ''}${tab === 'pack' && list.length > 1 && canPack ? `<a class="btn" href="#/wave?ids=${list.map((r) => r.id).join(',')}">Pick all together (scan)</a>` : ''}${CR.connected && B.shipped.some((r) => r.sr) ? '<button class="btn" id="dksync">Refresh tracking</button>' : ''}${CR.connected && tab === 'shipped' ? '<button class="btn" id="dkndr">Failed deliveries</button>' : ''}${ME.can.settings ? '<a class="btn" href="#/settings/workflow">Set up</a>' : ''}`) + `
    ${paidOnly ? `<div class="panel okbox">Showing only orders paid in advance (prepaid) that are not with the courier yet. <a href="#/dispatch?tab=${tab}">Show all orders</a></div>`
      : B.counts.paid_waiting ? `<div class="panel dk-paid"><a href="#/dispatch?paid=1&tab=${tab}">💰 <b>${B.counts.paid_waiting}</b> paid order${B.counts.paid_waiting === 1 ? '' : 's'} not dispatched yet</a></div>` : ''}
    <div class="seg seg-wrap dk-tabs">${tabs.map(([k, t]) => `<button type="button" data-tab="${k}" class="${k === tab ? 'on' : ''}">${t}${k !== 'done' ? ` <span class="badge">${B.counts[k]}</span>` : ''}</button>`).join('')}</div>
    ${list.length > 5 ? '<div class="panel"><input id="dkq" placeholder="Find by name, phone, order or tracking no…" autocomplete="off"></div>' : ''}
    ${!ordersOn() && ME.can.settings ? '<div class="panel warnbox">Orders &amp; dispatch is not switched on, so Sales Orders stay hidden from the menu in Simple mode. <a href="#/settings/workflow">Set it up (1 minute)</a></div>' : ''}
    <div class="dk-list">${list.length ? list.map(card).join('') : `<div class="panel muted">${empty}</div>`}</div>`;
  $$('[data-tab]', el).forEach((b) => b.onclick = () => go('dispatch?tab=' + b.dataset.tab + pq));
  // new orders show up by themselves: the desk reads itself again every 45 seconds while it is open and nobody is typing
  const again = () => {
    window.__dkT = setTimeout(() => {
      if (!location.hash.startsWith('#/dispatch')) return;
      const busy = document.hidden || $('.modal-bg') || (document.activeElement && document.activeElement.matches('input, select, textarea'));
      if (busy) again(); else render();
    }, 45000);
  };
  again();
  if ($('#dkq')) $('#dkq').oninput = (e) => { const f = e.target.value.toLowerCase().trim(); $$('.dk-card', el).forEach((x) => { x.hidden = f && !x.dataset.find.includes(f); }); };
  const step = async (id, body, msg) => { try { await api('PUT', '/api/dispatch/' + id, body); if (msg) toast(msg); render(); } catch (e) { toast(e.message, 'err'); } };
  const row = (id) => list.find((r) => r.id === +id);
  $$('[data-pm]', el).forEach((s) => s.onchange = () => step(s.dataset.pm, { action: 'pay_mode', pay_mode: s.value }, s.value ? `Marked ${s.value === 'cod' ? 'COD' : 'prepaid'}` : ''));
  $$('[data-ok]', el).forEach((b) => b.onclick = () => step(b.dataset.ok, { action: 'confirm' }, 'Confirmed: moved to To pack'));
  $$('[data-dl]', el).forEach((b) => b.onclick = () => step(b.dataset.dl, { action: 'delivered' }, 'Marked delivered'));
  $$('[data-ship]', el).forEach((b) => b.onclick = async () => {
    const id = b.dataset.ship, r = row(id), courier = $(`[data-cr="${id}"]`, el).value, awb = $(`[data-awb="${id}"]`, el).value.trim();
    try {
      await api('PUT', '/api/dispatch/' + id, { action: 'ship', courier, awb });
      const msg = fillMsg(W.msg_ship, { ...r, courier, awb });
      if (r.phone && confirm(`Shipped. Send the tracking number to ${r.party} on WhatsApp now?`)) window.open(waTo(r.phone, msg), '_blank', 'noopener');
      toast('Marked shipped'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-book]', el).forEach((b) => b.onclick = () => bookCourier(row(b.dataset.book), W));
  // a delivered parcel the customer sends back: Shiprocket picks it up from them (the Sales Return is entered when it arrives)
  $$('[data-ret]', el).forEach((b) => b.onclick = () => {
    const r = row(b.dataset.ret);
    modal(`Return pickup: ${r.number}`, [{ k: 'reason', label: 'Why it comes back', placeholder: 'e.g. size does not fit', wide: true },
      { k: 'weight', label: 'Weight (kg)', type: 'number', value: lsGet('st_parcel_w') || '0.5', required: true }],
    async (v) => { const x = await POST('/api/courier/return', { dn_id: r.id, ...v }); toast(x.awb ? `Return pickup booked: ${x.courier} ${x.awb}` : x.note, x.awb ? 'ok' : 'info'); render(); },
    { submit: 'Book return pickup', intro: `<p class="muted">The courier collects ${r.items.map((x) => `${esc(x.item)} × ${qtyf(x.qty)}`).join(', ')} from <b>${esc(r.party)}</b> and brings it to your pickup address. When it arrives, make a Sales Return from the invoice so stock and money are right.</p>` });
  });
  // parcels the courier could not deliver: try again (new phone / address / date) or send back
  if ($('#dkndr')) $('#dkndr').onclick = async (e) => {
    e.target.disabled = true;
    let x;
    try { x = await GET('/api/courier/ndr'); } catch (er) { toast(er.message, 'err'); e.target.disabled = false; return; }
    e.target.disabled = false;
    if (!x.rows.length) return toast('No failed delivery is waiting for an answer');
    const f = modal('Failed deliveries (NDR)', [], async () => {}, { submit: 'Close', intro: `<p class="muted">The courier tried and could not deliver. Answer within a day or two, or the parcel comes back by itself.</p>
      ${x.rows.map((n) => `<div class="panel ndr-row" data-ndrrow="${n.dn_id}"><b>${esc(n.party || '')}</b> · ${esc(n.number)} · ${esc(n.courier)} ${esc(n.awb)}<div class="muted small">${esc(n.reason || 'No reason given')} · attempt ${n.attempts || 1}${n.raised_at ? ' · ' + esc(n.raised_at.slice(0, 10)) : ''}</div>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px"><input data-ndr-phone="${n.dn_id}" placeholder="New mobile (optional)" inputmode="tel" style="max-width:160px"><input data-ndr-addr="${n.dn_id}" placeholder="Address line (optional)" style="max-width:220px">
        <input type="date" data-ndr-date="${n.dn_id}" min="${ME.today}" aria-label="Deliver on"><button type="button" class="btn sm primary" data-ndr="${n.dn_id}" data-act2="reattempt">Try again</button>
        <button type="button" class="btn sm danger" data-ndr="${n.dn_id}" data-act2="return">Send back</button></div></div>`).join('')}` });
    f.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-ndr]'); if (!b) return;
      const id = b.dataset.ndr, val = (k) => (f.querySelector(`[data-ndr-${k}="${id}"]`) || {}).value || '';
      if (b.dataset.act2 === 'return' && !confirm('Send this parcel back to you?')) return;
      b.disabled = true;
      try {
        await POST('/api/courier/ndr/' + id, { action: b.dataset.act2, phone: val('phone'), address: val('addr'), date: val('date') });
        toast(b.dataset.act2 === 'return' ? 'Asked to send it back' : 'Asked to deliver again');
        const done = f.querySelector(`[data-ndrrow="${id}"]`); if (done) done.hidden = true;
      } catch (er) { toast(er.message, 'err'); b.disabled = false; }
    });
  };
  $$('[data-trk]', el).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { const x = await POST('/api/courier/track/' + b.dataset.trk); toast(x.delivered ? 'Delivered' : `Courier says: ${x.status}${x.rto ? ' (coming back: mark Returned once it reaches you)' : ''}`); render(); }
    catch (e) { toast(e.message, 'err'); b.disabled = false; }
  });
  if ($('#dksync')) $('#dksync').onclick = async (e) => {
    e.target.disabled = true;
    try { const x = await POST('/api/courier/sync'); toast(`${x.checked} checked: ${x.delivered} delivered${x.rto ? `, ${x.rto} coming back` : ''}${x.failed ? `, ${x.failed} could not be read` : ''}`); render(); }
    catch (er) { toast(er.message, 'err'); e.target.disabled = false; }
  };
  $$('[data-rto]', el).forEach((b) => b.onclick = () => {
    const r = row(b.dataset.rto);
    modal(`Returned by courier: ${r.number}`, [{ k: 'note', label: 'Reason (optional)', placeholder: 'e.g. customer refused, address not found', wide: true },
      { k: 'keep', label: 'The order', type: 'select', options: [{ v: '', t: 'Close it (customer does not want it)' }, { v: '1', t: 'Keep it open to send again' }] }],
    async (v) => { const x = await api('PUT', '/api/dispatch/' + r.id, { action: 'rto', note: v.note, keep_order: v.keep === '1' }); toast(`Stock is back in the godown${x.order_closed ? '; order closed' : ''}`); render(); },
    { submit: 'Mark returned', intro: `<p class="muted">The goods come back into stock: ${r.items.map((x) => `${esc(x.item)} × ${qtyf(x.qty)}`).join(', ')}.</p>` });
  });
});

/* Settings → Orders & dispatch: the whole set-up on one page, in plain words. Each answer maps to the switches the app
   already has (the flow, the Store role's limits and menu, courier list, WhatsApp messages); Settings → Roles is still
   there for anything finer. */
const WF_PRESET = { dispatch: true, confirm_cod: true, default_pay: 'cod', pick_mode: 'scan', st_scan: true, st_costs: true, st_cancel: true, st_dispatch: true, st_menu: true };
route(/^settings\/workflow$/, async (el, m, q) => {
  const W = { ...wfOf() }, can2 = ME.can.settings, canU = ME.can.users;
  const roles = canU ? await GET('/api/roles').catch(() => null) : null;
  const store = roles && roles.builtin.find((r) => r.key === 'store');
  const packers = roles ? roles.rows.filter((r) => r.ui && r.ui.job === 'packer') : [];
  const items = await master('items').catch(() => []);
  const sr = (store && store.rules) || {};
  const v = q.get('preset') === 'online' ? { ...W, ...WF_PRESET } : { ...W, st_scan: !!sr.must_scan, st_costs: !!sr.hide_costs, st_cancel: !!sr.no_cancel, st_dispatch: !sr.no_dispatch, st_menu: !!(store && store.ui && store.ui.job === 'packer') };
  const chk = (k, t, help = '') => `<label class="check wf-q"><input type="checkbox" name="${k}" ${v[k] ? 'checked' : ''} ${can2 ? '' : 'disabled'}> <span><b>${t}</b>${help ? `<br><span class="muted small">${help}</span>` : ''}</span></label>`;
  const sample = { party: 'Riya Devi', number: 'SO-00012', total: 1050, pay_mode: 'cod', address: 'House 12, Paltan Bazar, Imphal, Manipur, 795001', courier: 'India Post', awb: 'EK123456789IN',
    items: [{ item: 'Kurti 101 - Red - M', qty: 1 }, { item: 'Kurti 205 - Blue - L', qty: 1 }] };
  const steps = [
    [W.dispatch, 'Orders & dispatch switched on', 'settings/workflow'],
    [store ? store.users > 0 || packers.some((r) => r.users) : null, 'A login for the godown / packing staff', ''],
    [items.length > 0, 'Items added (each size & colour)', 'items?variants=1'],
    [null, 'QR / barcode labels stuck on each piece', 'items'],
  ];
  el.innerHTML = head('Settings') + setTabs('settings/workflow') + `
    ${q.get('preset') === 'online' ? '<div class="panel okbox">Recommended answers for an online seller with a godown are filled in below. Check them and tap <b>Save</b>.</div>' : ''}
    <form class="panel" id="wf"><div class="err" hidden></div>
      <div class="row"><h2 style="margin:0">Orders &amp; dispatch</h2><span class="spacer"></span>${can2 ? '<button type="button" class="btn sm" id="wfpre">Fill recommended for online seller</button>' : ''}</div>
      <p class="muted">For orders that come by Instagram, WhatsApp, phone or the shop and are packed in a godown. Answer in plain words; change anything any time.</p>
      <h3 class="rh">1. How you work</h3>
      ${chk('dispatch', 'We take orders first and dispatch them later', 'Sales Order → pack → courier. Shows Sales Orders, Delivery Notes and the Dispatch Desk, even in Simple mode.')}
      ${chk('confirm_cod', 'Confirm COD orders with the customer on WhatsApp before packing', 'Fewer parcels come back (RTO): a COD order waits in “To confirm” until the customer says yes.')}
      <label class="f">Most orders are<select name="default_pay" ${can2 ? '' : 'disabled'}>${[['cod', 'COD (cash on delivery)'], ['prepaid', 'Prepaid (UPI / bank first)'], ['', 'Ask on each order']].map(([k, t]) => `<option value="${k}" ${(v.default_pay || '') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f wide">How orders are picked<select name="pick_mode" ${can2 ? '' : 'disabled'}>${[['scan', 'Scan on the phone: open the order, scan each piece as it is picked (no printed pick list)'], ['paper', 'Printed pick list (ticked by hand, “picked by / checked by”)'], ['both', 'Either, as the staff like']].map(([k, t]) => `<option value="${k}" ${(v.pick_mode || 'both') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <small class="help">Scan: the app checks design, colour and size against the order, counts each piece, shows the order complete, and the delivery note is saved from that screen. No paper, no second check.</small></label>
      <label class="f wide">An order asking for more than is free to sell<select name="stock_check" ${can2 ? '' : 'disabled'}>${[['warn', 'Warn, but let it be saved'], ['block', 'Do not allow it'], ['off', 'Say nothing']].map(([k, t]) => `<option value="${k}" ${(v.stock_check || 'warn') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <small class="help">Free to sell = in stock − pieces already on open sales orders. Stock itself goes out only with the delivery note.</small></label>
      <h3 class="rh">2. Godown / packing staff</h3>
      ${store ? `<p class="muted small">For users with the <b>Store / godown</b> role (${store.users} now). Other roles: Settings → Roles.</p>
      ${chk('st_dispatch', 'They can pack and dispatch orders', 'Save the Delivery Note from a Sales Order the office entered. They still cannot make orders or invoices.')}
      ${chk('st_scan', 'They must scan every piece before dispatch', 'Wrong design, colour or size is refused. No Delivery Note without Pack & check.')}
      ${chk('st_costs', 'Hide purchase price, cost and profit from them')}
      ${chk('st_cancel', 'They cannot cancel bills or entries')}
      ${chk('st_menu', 'Their app opens on the Dispatch Desk, with only godown screens')}
      <div class="row"><button type="button" class="btn sm" id="wfuser">+ Add a godown staff login</button><a class="btn sm" href="#/settings/roles">More control: Roles</a></div>` : '<p class="muted">Only the owner or an admin sets what staff may do.</p>'}
      <h3 class="rh">3. Courier &amp; WhatsApp messages</h3>
      <label class="f wide">Couriers you use<textarea name="couriers" rows="4" ${can2 ? '' : 'disabled'} placeholder="India Post&#10;Delhivery | https://tracking-page/{awb}">${esc(W.couriers.map((c) => c.name + (c.url ? ' | ' + c.url : '')).join('\n'))}</textarea>
        <small class="help">One per line. To give customers a tracking link, add “ | ” and the courier’s tracking address with {awb} where the number goes.</small></label>
      <div class="grid g2">
        <label class="f">Message to confirm an order<textarea name="msg_confirm" rows="6" ${can2 ? '' : 'disabled'}>${esc(W.msg_confirm)}</textarea></label>
        <div><div class="muted small">Customer sees:</div><div class="wa-prev" id="pv1"></div></div>
        <label class="f">Message when shipped<textarea name="msg_ship" rows="6" ${can2 ? '' : 'disabled'}>${esc(W.msg_ship)}</textarea></label>
        <div><div class="muted small">Customer sees:</div><div class="wa-prev" id="pv2"></div></div></div>
      <p class="muted small">Words in {curly brackets} are filled in: {name} {order} {shop} {items} {amount} {pay} {address} {courier} {awb} {link}</p>
      <h3 class="rh">4. Labels</h3>
      <p>Courier label: <b>${esc({ '4x6': '4 × 6 inch', '100x50': '100 × 50 mm', 'a4-4': 'A4 quarter' }[(ME.org.print || {}).ship_size] || '4 × 6 inch')}</b>${(ME.org.print || {}).ship_cod === false ? ', COD amount hidden' : ', COD amount shown'}. <a href="#/settings/print">Change</a></p>
      <p>Item labels with QR or barcode: open an item → <b>Labels</b>, or a purchase bill → More → <b>Print item labels</b>.</p>
      <div class="row sticky-act"><span class="spacer"></span><button class="btn primary" ${can2 ? '' : 'disabled'}>Save</button></div>
    </form>
    <div class="panel" id="crp"></div>
    <div class="panel"><h2>Ready for orders?</h2><ol class="gs">${steps.map(([ok, t, h], i) => `<li class="${ok ? 'done' : ''}"><span class="tick">${ok ? '&#10003;' : i + 1}</span><div><b>${t}</b></div>${h && !ok ? `<a class="btn sm" href="#/${h}">Open</a>` : ''}</li>`).join('')}</ol>
      <div class="row">${ME.can.sales ? '<a class="btn primary" href="#/new/SO">Enter the first order</a>' : ''}<a class="btn" href="#/dispatch">Open Dispatch Desk</a></div></div>`;
  courierPanel(el);
  const f = $('#wf');
  const preview = () => { $('#pv1').textContent = fillMsg(f.elements.msg_confirm.value, sample); $('#pv2').textContent = fillMsg(f.elements.msg_ship.value, { ...sample, link: '' }); };
  f.addEventListener('input', preview); preview();
  if ($('#wfpre')) $('#wfpre').onclick = () => { for (const [k, x] of Object.entries(WF_PRESET)) { const e = f.elements[k]; if (!e) continue; if (e.type === 'checkbox') e.checked = x; else e.value = x; } toast('Recommended answers filled in. Tap Save.', 'info'); };
  if ($('#wfuser')) $('#wfuser').onclick = () => modal('Add a godown staff login', [{ k: 'name', label: 'Name', required: true }, { k: 'email', label: 'Email (their login)', type: 'email', required: true },
    { k: 'password', label: 'Temporary password (8+ chars)', type: 'password', required: true }],
  async (x) => { await POST('/api/users', { ...x, role: 'store' }); toast('Login made. Share the email and password with them.'); render(); },
  { submit: 'Add login', intro: '<p class="muted">Role: Store / godown. They see what you set above.</p>' });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const box = $('.err', f); box.hidden = true;
    const E = f.elements;
    try {
      const couriers = E.couriers.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, url = ''] = l.split('|').map((x) => x.trim()); return { name, url }; });
      const r = await api('PUT', '/api/settings/workflow', { dispatch: E.dispatch.checked, confirm_cod: E.confirm_cod.checked, default_pay: E.default_pay.value, pick_mode: E.pick_mode.value, stock_check: E.stock_check.value, couriers, msg_confirm: E.msg_confirm.value, msg_ship: E.msg_ship.value });
      if (store && !store.locked) {
        const ui = E.st_menu.checked ? { job: 'packer', home: 'dispatch' } : store.ui.job === 'packer' ? {} : store.ui;
        await api('PUT', '/api/roles/builtin/store', { perms: store.changed ? store.perms : null, ui,
          rules: { ...sr, must_scan: E.st_scan.checked, hide_costs: E.st_costs.checked, no_cancel: E.st_cancel.checked, no_dispatch: !E.st_dispatch.checked } });
      }
      ME = await GET('/api/me'); ME.org.workflow = r.workflow; shell(); wireInstall();
      toast('Saved. Staff see the change the next time they open the app.'); go('settings/workflow');
    } catch (err) { box.hidden = false; box.textContent = err.message; }
  };
});

/* Sizes & colours in one go (clothing, footwear): Design × Colour × Size items, each with its own code, so a scan tells
   one variant from another. Made through the Excel import (one request, the same checks), then their labels print. */
function variantMaker() {
  const f = modal('Add sizes & colours', [
    { k: 'design', label: 'Design / style name', placeholder: 'e.g. Kurti 101', required: true, wide: true },
    { k: 'colours', label: 'Colours (comma between)', placeholder: 'Red, Blue, Black', wide: true },
    { k: 'sizes', label: 'Sizes (comma between)', placeholder: 'S, M, L, XL', wide: true },
    { k: 'sale_price', label: 'Sale price / MRP (₹)', type: 'number', required: true }, { k: 'price_incl', label: 'Price includes GST (MRP)', type: 'checkbox', value: true },
    { k: 'wholesale_price', label: 'Wholesale price (₹)', type: 'number', help: wholesaleMin() ? `For orders of ${wholesaleMin()} pieces or more, and wholesale customers.` : 'For wholesale customers, or set "wholesale from N pieces in one order" in Settings → Business type & menu.' },
    { k: 'purchase_price', label: 'Purchase / cost price (₹)', type: 'number' },
    { k: 'gst_rate', label: 'GST %', type: 'select', value: '5', options: [0, 5, 12, 18].map((x) => ({ v: String(x), t: x + '%' })) }, { k: 'hsn', label: 'HSN', placeholder: 'e.g. 6204' },
    { k: 'opening_qty', label: 'Opening stock of each (pcs)', type: 'number', value: 0 }, { k: 'code', label: 'Code prefix', placeholder: 'from the design: K101', more: true }],
  async (v) => {
    const list = (x) => String(x || '').split(',').map((y) => y.trim()).filter(Boolean);
    const cols = list(v.colours), sizes = list(v.sizes), base = v.design.trim();
    if (!cols.length && !sizes.length) throw new Error('Type at least one colour or one size.');
    // code prefix: typed, else the design's initials and numbers ("Kurti 101" → K101, "Anarkali Suit" → AS)
    const pre = (v.code ? v.code : base.split(/\s+/).map((w) => (/\d/.test(w) ? w : w[0] || '')).join('')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'ITEM';
    const short = (x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const rows = [];
    for (const c of cols.length ? cols : ['']) for (const z of sizes.length ? sizes : ['']) {
      rows.push({ name: [base, c, z].filter(Boolean).join(' - '), sku: [pre, short(c), short(z)].filter(Boolean).join('-'), category: base, unit: 'Pcs', sale_price: v.sale_price, price_incl: !!v.price_incl,
        purchase_price: v.purchase_price || '', wholesale_price: v.wholesale_price || '', gst_rate: v.gst_rate, hsn: v.hsn, opening_qty: +v.opening_qty || 0 });
    }
    if (rows.length > 200) throw new Error(`That makes ${rows.length} items; 200 at a time at most.`);
    const r = await POST('/api/import/items', { rows });
    dirty('items');
    const made = (await master('items')).filter((i) => rows.some((x) => x.name === i.name));
    toast(`${r.added} item${r.added === 1 ? '' : 's'} made${r.skipped.length ? `, ${r.skipped.length} already there` : ''}${r.errors.length ? `, ${r.errors.length} with errors` : ''}`);
    if (r.errors.length) throw new Error(r.errors.map((e) => e.error).join(' '));
    go(`labels-many?ids=${made.map((i) => i.id).join(',')}&n=${Math.max(1, +v.opening_qty || 1)}`);
  }, { submit: 'Make items', intro: '<p class="muted">One item for every colour × size, e.g. “Kurti 101 - Red - M”, each with its own code (K101-RED-M) for the QR label. Leave colours or sizes empty if there are none.</p>' });
  const count = () => { const n = (k) => Math.max(1, String(f.elements[k].value || '').split(',').filter((x) => x.trim()).length); const t = n('colours') * n('sizes'); f.querySelector('.actions .primary').textContent = `Make ${t} item${t === 1 ? '' : 's'}`; };
  f.addEventListener('input', count);
}

/* Item labels: QR code or barcode, name (design - colour - size), code and price. One item, several items, or one label
   per piece of a purchase bill / GRN / order. Both kinds scan in Pack & check, POS and Receive Goods. */
const labelKind = () => { try { return localStorage.getItem('st_label_kind') || 'qr'; } catch (e) { return 'qr'; } };
async function drawLabels(el, title, list, backHref) {
  const kind = labelKind();
  el.innerHTML = head(esc(title), `<a class="btn" href="#/${backHref}">Back</a><div class="seg" id="lk"><button type="button" data-k="qr" class="${kind === 'qr' ? 'on' : ''}">QR</button><button type="button" data-k="bar" class="${kind === 'bar' ? 'on' : ''}">Barcode</button></div><button class="btn primary" data-act="print">Print ${list.length} label${list.length === 1 ? '' : 's'}</button>`) +
    `<p class="muted no-print">Each label carries the item's own code, so a scan tells design, colour and size apart. Use A4 label sheets or a label printer.</p>
    <div class="labels">${list.map((it) => `<div class="label ${kind === 'qr' ? 'lq' : ''}">${kind === 'qr' ? `<div class="lqr" data-code="${esc(labelCode(it))}"></div>` : '<svg class="bc"></svg>'}<div class="lt"><div class="ln">${esc(it.name)}</div><div class="lc">${esc(labelCode(it))}</div><div class="lp">MRP ${inr(it.sale_price_incl ?? it.sale_price)}</div></div></div>`).join('')}</div>`;
  $$('#lk [data-k]', el).forEach((b) => b.onclick = () => { try { localStorage.setItem('st_label_kind', b.dataset.k); } catch (e) { /* private mode */ } render(); });
  if (kind === 'qr') {
    const { default: qrcode } = await import('/vendor/qrcode.mjs');
    const cache = {};
    $$('.lqr', el).forEach((x) => { const c = x.dataset.code; if (!cache[c]) { const qr = qrcode(0, 'M'); qr.addData(c); qr.make(); cache[c] = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true }); } x.innerHTML = cache[c]; });
  } else {
    await loadScript('/vendor/JsBarcode.all.min.js');
    $$('.labels .bc', el).forEach((svg, i) => window.JsBarcode(svg, labelCode(list[i]), { format: 'CODE128', width: 1.3, height: 34, fontSize: 0, displayValue: false, margin: 0 }));
  }
}
route(/^labels-many$/, async (el, m, q) => {
  dirty('items');
  const all = await master('items'), ids = String(q.get('ids') || '').split(',').map(Number), n = Math.min(50, Math.max(1, +q.get('n') || 1));
  const its = ids.map((id) => all.find((x) => x.id === id)).filter(Boolean);
  if (!its.length) throw new Error('No items to print.');
  await drawLabels(el, `Labels: ${its.length} item${its.length === 1 ? '' : 's'}`, its.flatMap((it) => Array(n).fill(it)).slice(0, 600), 'items');
});
route(/^labels-doc\/(\d+)$/, async (el, m) => {
  dirty('items');
  const [d, all] = await Promise.all([GET('/api/docs/' + m[1]), master('items')]);
  const list = d.lines.filter((l) => l.item_id && !l.is_service).flatMap((l) => { const it = all.find((x) => x.id === l.item_id); return it ? Array(Math.max(0, Math.min(500, Math.ceil(l.qty)))).fill(it) : []; }).slice(0, 600);
  if (!list.length) throw new Error('This document has no stock items.');
  await drawLabels(el, `Labels for ${d.number} · one per piece`, list, 'doc/' + d.id);
});

/* ======================================================================= bins & racks (src/lots.js)
   A godown's racks and shelves: how much of each item sits in each bin, what is not put away yet, put-away and moves
   between bins, and printable bin labels. Bills and receipts move the bins by themselves (default bin in, FIFO out). */
route(/^bins$/, async (el, m, q) => {
  const whs = await master('warehouses'), wid = +q.get('wh') || (whs[0] && whs[0].id);
  const b = await GET(`/api/bins?warehouse_id=${wid}`), items = await master('items');
  const binOpts = (empty) => [{ v: 0, t: empty }, ...b.bins.map((x) => ({ v: x.id, t: x.code }))];
  el.innerHTML = head('Bins & Racks', `${b.bins.length ? `<a class="btn" href="#/bin-labels?wh=${wid}">Print bin labels</a>` : ''}${ME.can.stock ? '<button class="btn" id="move">Move stock</button><button class="btn primary" id="addb">+ Add bins</button>' : ''}`) + `
    ${whs.length > 1 ? `<div class="panel"><label class="f inline-f">Godown<select id="wh">${whs.map((w) => `<option value="${w.id}" ${w.id === wid ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label></div>` : ''}
    <div class="kpis"><div class="kpi"><div class="l">Bins</div><div class="v">${b.bins.length}</div><div class="s">${b.bins.filter((x) => x.items).length} in use</div></div>
      <div class="kpi"><div class="l">Not put away</div><div class="v ${b.not_put_away.length ? 'neg' : ''}">${b.not_put_away.length}</div><div class="s">item${b.not_put_away.length === 1 ? '' : 's'} waiting for a bin</div></div></div>
    ${b.bins.length ? '' : `<div class="panel">${emptyCta('Make your racks and shelves once, like A-01-1 (rack A, shelf 1, level 1). Give each item a default bin: new stock goes there, and the pick list shows where to pick from.',
      ME.can.stock ? '<button class="btn primary" data-addb>+ Add bins</button>' : '')}</div>`}
    ${b.not_put_away.length ? `<div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Not put away</h3><span class="spacer"></span>${ME.can.stock && b.bins.length ? `<a class="btn sm primary" href="#/putaway?wh=${wid}">Guided put-away</a>` : ''}</div>
      <p class="muted" style="padding:0 16px">In this godown but in no bin yet. Put them away so the pick list knows where they are.</p>
      ${table([{ h: 'Item', f: (r) => `<a href="#/item/${r.id}">${esc(r.name)}</a>${r.location ? `<div class="muted">default bin ${esc(r.location)}</div>` : ''}` },
        { h: 'Qty', num: 1, f: (r) => `${qtyf(r.free)} ${esc(r.unit)}` }, { h: '', f: (r) => ME.can.stock && b.bins.length ? `<button class="btn sm" data-put="${r.id}">Put away</button>` : '' }], b.not_put_away)}</div>` : ''}
    ${b.bins.length ? `<div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Bins</h3><span class="spacer"></span><input id="bq" placeholder="Find a bin…" style="max-width:180px"></div>
      <div class="bins" id="binlist">${b.bins.map((x) => `<button type="button" class="bin${x.items ? ' used' : ''}" data-bin="${x.id}" data-code="${esc(x.code)}"><b>${esc(x.code)}</b>
        <span>${x.items ? `${x.items} item${x.items === 1 ? '' : 's'} · ${qtyf(x.qty)}` : 'empty'}</span></button>`).join('')}</div></div>` : ''}`;
  if ($('#wh')) $('#wh').onchange = (e) => go('bins?wh=' + e.target.value);
  const add = () => modal('Add bins', [
    { k: 'racks', label: 'Racks', placeholder: 'A-D, or A B C', required: true, help: 'Letters, or a range like A-D.' },
    { k: 'shelves', label: 'Shelves per rack', type: 'number', value: 4 }, { k: 'levels', label: 'Levels per shelf', type: 'number', value: 0, help: '0 = no levels: A-01, A-02…' },
    { k: 'zone', label: 'Zone (optional)', placeholder: 'e.g. Cold room', more: true }],
  async (v) => { const r = await POST('/api/bins', { ...v, warehouse_id: wid }); toast(`${r.added} bins ready`); render(); },
  { submit: 'Make bins', intro: '<p class="muted">Bin codes look like A-01-1: rack A, shelf 01, level 1. Bins that already exist are skipped.</p>' });
  if ($('#addb')) $('#addb').onclick = add;
  if ($('[data-addb]')) $('[data-addb]').onclick = add;
  const stocked = items.filter((i) => !i.is_service);
  const moveForm = (it, fromBin = 0, qty = '') => modal('Move stock between bins', [
    { k: 'item_id', label: 'Item', type: 'select', options: opts(stocked), value: it || '', wide: true },
    { k: 'from_bin_id', label: 'From', type: 'select', options: binOpts('Not put away'), value: fromBin },
    { k: 'to_bin_id', label: 'To', type: 'select', options: binOpts('Out of bins'), value: '' }, { k: 'qty', label: 'Quantity', type: 'number', value: qty }],
  async (v) => { await POST('/api/bins/move', { ...v, item_id: +v.item_id, from_bin_id: +v.from_bin_id, to_bin_id: +v.to_bin_id, warehouse_id: wid }); toast('Moved'); render(); });
  if ($('#move')) $('#move').onclick = () => moveForm();
  $$('[data-put]', el).forEach((x) => x.onclick = () => { const r = b.not_put_away.find((y) => y.id === +x.dataset.put); moveForm(r.id, 0, r.free); });
  if ($('#bq')) $('#bq').oninput = (e) => { const f = e.target.value.toUpperCase(); $$('[data-bin]', el).forEach((x) => { x.hidden = f && !x.dataset.code.includes(f); }); };
  $$('[data-bin]', el).forEach((x) => x.onclick = async () => {
    const c = await GET('/api/bins/' + x.dataset.bin);
    const S = sheet(`<h2>Bin ${esc(c.bin.code)}</h2><p class="muted">${esc(c.bin.warehouse)}${c.bin.zone ? ' · ' + esc(c.bin.zone) : ''}</p>
      ${c.items.length ? table([{ h: 'Item', f: (r) => `<a href="#/item/${r.id}" data-x>${esc(r.name)}</a>` }, { h: 'Qty', num: 1, f: (r) => `${qtyf(r.qty)} ${esc(r.unit)}` },
        { h: '', f: (r) => ME.can.stock ? `<button class="btn sm" data-mv="${r.id}">Move</button>` : '' }], c.items) : '<p class="muted">Empty.</p>'}
      <div class="actions">${!c.items.length && ME.can.stock ? '<button type="button" class="btn danger" id="delbin">Delete bin</button>' : ''}<button type="button" class="btn" data-x>Close</button></div>`);
    $$('[data-mv]', S.el).forEach((y) => y.onclick = () => { const r = c.items.find((z) => z.id === +y.dataset.mv); S.close(); moveForm(r.id, c.bin.id, r.qty); });
    if ($('#delbin', S.el)) $('#delbin', S.el).onclick = async () => { try { await api('DELETE', '/api/bins/' + c.bin.id); S.close(); toast('Bin deleted'); render(); } catch (e) { toast(e.message, 'err'); } };
  });
});
route(/^bin-labels$/, async (el, m, q) => {
  const b = await GET(`/api/bins?warehouse_id=${+q.get('wh') || ''}`);
  el.innerHTML = head(`Bin labels · ${esc(b.warehouse.name)}`, `<a class="btn" href="#/bins?wh=${b.warehouse.id}">Back</a><button class="btn primary" data-act="print">Print labels</button>`) + `
    <p class="muted no-print">One label per bin. Stick it on the shelf: scanning it in the POS search finds the bin.</p>
    <div class="labels">${b.bins.map((x) => `<div class="label"><div class="ln" style="font-size:20px;font-weight:800">${esc(x.code)}</div><svg class="bc" data-code="${esc(x.code)}"></svg><div class="lp">${esc(b.warehouse.name)}${x.zone ? ' · ' + esc(x.zone) : ''}</div></div>`).join('')}</div>`;
  await loadScript('/vendor/JsBarcode.all.min.js');
  $$('.labels .bc', el).forEach((s) => window.JsBarcode(s, s.dataset.code, { format: 'CODE128', width: 1.6, height: 40, fontSize: 12, margin: 0, textMargin: 1 }));
});

/* ======================================================================= batch & expiry: what expires soon, and what has */
route(/^expiry$/, async (el, m, q) => {
  const days = +q.get('days') || 90, r = await GET(`/api/reports/expiry?days=${days}`);
  const tracked = (await master('items')).filter((i) => i.track_batch).length;
  el.innerHTML = head('Batch & Expiry', `<select id="days" aria-label="Show" style="width:auto">${[30, 60, 90, 180, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Next ${d} days</option>`).join('')}</select><button class="btn" id="csv">Export CSV</button>`) + `
    ${tracked ? '' : `<div class="panel warnbox">No item tracks batches yet. Open an item → Edit → More details → <b>Track batch & expiry</b>. Then type the batch and expiry on purchase bills; sales take the batch that expires first.</div>`}
    <div class="kpis"><div class="kpi"><div class="l">Expired, still in stock</div><div class="v neg">${r.expired_value === undefined ? r.rows.filter((x) => x.days_left < 0).length : inr(r.expired_value)}</div><div class="s">return to the supplier or write off</div></div>
      <div class="kpi"><div class="l">Expiring in ${days} days</div><div class="v">${r.soon_value === undefined ? r.rows.filter((x) => x.days_left >= 0).length : inr(r.soon_value)}</div><div class="s">sell these first</div></div></div>
    <div class="panel flush">${table([{ h: 'Item', f: (x) => `<a href="#/item/${x.item_id}">${esc(x.name)}</a>` }, { h: 'Batch', k: 'batch_no' }, { h: 'Godown', k: 'warehouse', cls: 'hide-sm' },
      { h: 'Expiry', f: (x) => `${fdate(x.expiry)}<div class="${x.days_left < 0 ? 'neg' : x.days_left <= 30 ? 'warn' : 'muted'}">${x.days_left < 0 ? `expired ${-x.days_left} days ago` : `${x.days_left} days left`}</div>` },
      { h: 'Qty', num: 1, f: (x) => `${qtyf(x.qty)} ${esc(x.unit)}` }, ...(r.rows[0] && r.rows[0].value !== undefined ? [{ h: 'Value', num: 1, f: (x) => inr(x.value) }] : [])], r.rows,
    { empty: 'Nothing expires in this period.' })}</div>`;
  $('#days').onchange = (e) => go('expiry?days=' + e.target.value);
  $('#csv').onclick = () => download('expiry.csv', toCsv([{ h: 'Item', k: 'name' }, { h: 'Batch', k: 'batch_no' }, { h: 'Godown', k: 'warehouse' }, { h: 'Expiry', k: 'expiry' }, { h: 'Days left', k: 'days_left' }, { h: 'Qty', k: 'qty' }, { h: 'Value', k: 'value' }], r.rows));
});

/* ======================================================================= stock ageing: how old the stock on hand is */
route(/^stock-ageing$/, async (el, m, q) => {
  const whs = await master('warehouses'), wid = +q.get('wh') || 0, show = q.get('show') || '';
  const r = await GET(`/api/reports/stock-ageing${wid ? '?warehouse_id=' + wid : ''}`), costs = r.totals !== undefined;
  const rows = r.rows.filter((x) => !show || x.move === show || x.abc === show);
  const MOVE = { dead: ['b-unpaid', 'dead'], slow: ['b-partial', 'slow'], moving: ['b-paid', 'moving'], new: ['', 'new'] };
  el.innerHTML = head('Stock Ageing', `<button class="btn" id="csv">Export CSV</button>`) + `
    <div class="panel"><div class="row">${whs.length > 1 ? `<label class="f inline-f">Godown<select id="wh"><option value="">All godowns</option>${whs.map((w) => `<option value="${w.id}" ${w.id === wid ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}
      <label class="f inline-f">Show<select id="show"><option value="">All items</option><option value="dead" ${show === 'dead' ? 'selected' : ''}>Dead stock (no sale in 6 months)</option><option value="slow" ${show === 'slow' ? 'selected' : ''}>Slow (no sale in 3 months)</option>
        <option value="A" ${show === 'A' ? 'selected' : ''}>A class (top 70% of sales)</option><option value="B" ${show === 'B' ? 'selected' : ''}>B class</option><option value="C" ${show === 'C' ? 'selected' : ''}>C class</option></select></label></div>
      <p class="muted" style="margin:8px 0 0">First in, first out: what is left of an item is its latest purchases, so each part is as old as the day it came in. ABC is from the last 12 months of sales.</p></div>
    ${costs ? `<div class="age-bar">${r.buckets.map((b, k) => `<div class="kpi"><div class="l">${esc(b)}</div><div class="v ${k >= 4 ? 'neg' : ''}">${inr0(r.totals[k])}</div></div>`).join('')}</div>` : ''}
    <div class="kpis"><div class="kpi"><div class="l">Dead stock</div><div class="v neg">${r.dead} item${r.dead === 1 ? '' : 's'}</div><div class="s">${costs ? inr0(r.dead_value) + ' stuck' : 'no sale in 6 months'}</div></div>
      <div class="kpi"><div class="l">Slow moving</div><div class="v">${r.slow} item${r.slow === 1 ? '' : 's'}</div><div class="s">no sale in 3 months</div></div></div>
    <div class="panel flush">${table([{ h: 'Item', f: (x) => `<a href="#/item/${x.id}">${esc(x.name)}</a><div class="muted">${esc(x.category || '')}</div>` },
      { h: 'Qty', num: 1, f: (x) => `${qtyf(x.qty)} ${esc(x.unit)}` }, ...(costs ? [{ h: 'Value', num: 1, f: (x) => inr(x.value) }] : []),
      ...r.buckets.map((b, k) => ({ h: b.replace(' days', 'd'), num: 1, cls: 'hide-sm', f: (x) => (x.qtys[k] ? qtyf(x.qtys[k]) : '') })),
      { h: 'Oldest', num: 1, f: (x) => `${x.oldest_days}d` }, { h: 'Last sale', f: (x) => (x.last_sale ? `${fdate(x.last_sale)}<div class="muted">${x.days_since_sale}d ago</div>` : '<span class="muted">never</span>'), cls: 'hide-sm' },
      { h: 'Moving', f: (x) => `<span class="badge ${MOVE[x.move][0]}">${MOVE[x.move][1]}</span>` }, { h: 'ABC', f: (x) => `<b>${x.abc}</b>` }], rows, { empty: 'No stock on hand.' })}</div>`;
  const nav = () => go(`stock-ageing?${new URLSearchParams({ ...(($('#wh') || {}).value ? { wh: $('#wh').value } : {}), ...($('#show').value ? { show: $('#show').value } : {}) })}`);
  if ($('#wh')) $('#wh').onchange = nav;
  $('#show').onchange = nav;
  $('#csv').onclick = () => download('stock-ageing.csv', toCsv([{ h: 'Item', k: 'name' }, { h: 'Qty', k: 'qty' }, ...(costs ? [{ h: 'Value', k: 'value' }] : []),
    ...r.buckets.map((b, k) => ({ h: b, f: (x) => x.qtys[k] })), { h: 'Oldest (days)', k: 'oldest_days' }, { h: 'Last sale', k: 'last_sale' }, { h: 'Moving', k: 'move' }, { h: 'ABC', k: 'abc' }], rows));
});

/* ======================================================================= shared: downloads, UPI QR, scripts */
async function fetchFile(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* not json */ }
    throw new ApiError(msg, res.status);
  }
  return { name: ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'download', blob: await res.blob() };
}
async function fileDownload(url) {
  let f;
  try { f = await fetchFile(url); } catch (e) {
    if (e.status === 402 && confirm(e.message + '\n\nOpen Plan & Billing now?')) go('plan'); else if (e.status !== 402) alert(e.message);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f.blob); a.download = f.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Downloaded ' + f.name);
}

/* Backup to a folder on this computer (Chrome / Edge on a computer: the File System Access API). The owner picks a
   folder once; it is remembered on this device, and while SmartTrader is open a backup (.json, plus an Excel copy
   unless turned off) is written there once a day or week, the newest 30 of each kept. A folder inside Google Drive
   for desktop, OneDrive or a pen drive carries the copies on from there. After the browser restarts, Chrome asks
   again before the folder is written (unless "Allow on every visit" was chosen): a note offers that one tap. */
const FOLDER_OK = typeof window.showDirectoryPicker === 'function';
const FOLDER_KEEP = 30;
const folderDb = (() => {
  let p = null;
  return () => p || (p = new Promise((ok, no) => {
    const r = indexedDB.open('smarttrader-folder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('dirs');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
})();
let folderSt = null, folderOf = '', folderLater = false;     // this owner's folder on this device: { dir, name, excel, every, last_at, last_size, error, err_at, ask }
const folderLoad = async () => { folderOf = offOwner(); return (folderSt = FOLDER_OK && ME ? (await idbDo('dirs', 'readonly', (s) => s.get(folderOf), folderDb)) || null : null); };
const folderSave = (st) => { folderSt = st; folderOf = offOwner(); return idbDo('dirs', 'readwrite', (s) => (st ? s.put(st, folderOf) : s.delete(folderOf)), folderDb); };
const folderDue = (st) => !st.last_at || (st.every === 'week' ? Date.now() - st.last_at > 6.5 * 86400e3 : new Date(st.last_at).toDateString() !== new Date().toDateString());
async function folderPerm(dir, ask) {
  const o = { mode: 'readwrite' };
  if (await dir.queryPermission(o) === 'granted') return true;
  return ask ? (await dir.requestPermission(o)) === 'granted' : false;
}
async function folderWrite(dir, name, blob) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(blob); await w.close();
}
/* only files with SmartTrader's own backup names are ever removed */
async function folderPrune(dir) {
  const names = [];
  for await (const [n, h] of dir.entries()) if (h.kind === 'file') names.push(n);
  const old = [/^smarttrader-backup-\d{4}-\d\d-\d\d_\d\d-\d\d\.json$/, /^smarttrader-excel-\d{4}-\d\d-\d\d_\d\d-\d\d\.xlsx$/]
    .flatMap((re) => names.filter((n) => re.test(n)).sort().reverse().slice(FOLDER_KEEP));
  for (const n of old) await dir.removeEntry(n).catch(() => {});
}
/* by 'tap' (a button: may ask Chrome for the folder, always saves, says what happened) or 'auto' (quiet, only when due) */
async function folderBackup(by = 'auto') {
  if (!FOLDER_OK || !ME || ME.user.role !== 'owner' || ME._offline || !navigator.onLine) return;
  const run = async () => {
    const st = await folderLoad();
    if (!st || (by === 'auto' && (!folderDue(st) || (st.err_at && Date.now() - st.err_at < 3600e3)))) return;
    if (!(await folderPerm(st.dir, by === 'tap').catch(() => false))) { await folderSave({ ...st, ask: true }); folderShow(); return; }
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
    try {
      const j = await fetchFile('/api/export/backup?to=folder');
      await folderWrite(st.dir, `smarttrader-backup-${stamp}.json`, j.blob);
      if (st.excel !== false) await folderWrite(st.dir, `smarttrader-excel-${stamp}.xlsx`, (await fetchFile('/api/export/excel?to=folder')).blob);
      await folderPrune(st.dir);
      await folderSave({ ...st, last_at: Date.now(), last_size: j.blob.size, error: '', err_at: 0, ask: false });
      if (by === 'tap') toast(`Backup saved in the folder “${st.name}”`);
    } catch (e) {
      const msg = e.name === 'NotFoundError' ? `The folder “${st.name}” was moved or deleted. Choose a folder again.`
        : e.name === 'NotAllowedError' || e.name === 'NoModificationAllowedError' ? `SmartTrader may not write in “${st.name}”. Choose another folder.`
        : e.name === 'QuotaExceededError' ? 'The disk is full. Free some space, then tap Save now.' : e.message || 'The backup could not be saved.';
      await folderSave({ ...st, error: msg, err_at: Date.now() });
      if (by === 'tap') toast(msg, 'err');
    }
    folderShow();
  };
  // two open tabs: one of them writes
  return navigator.locks ? navigator.locks.request('smarttrader-folder-backup', { ifAvailable: true }, (lock) => (lock ? run() : null)) : run();
}
/* the Settings box (if open) and the one-tap note when Chrome wants the OK again */
function folderShow() {
  if ($('#fbox')) folderUi();
  const want = ME && ME.user.role === 'owner' && folderOf === offOwner() && folderSt && folderSt.ask && folderDue(folderSt) && !folderLater && !$('#fbox');
  const n = $('#fbnote');
  if (!want) { if (n) n.remove(); return; }
  if (!n) $('#app').insertAdjacentHTML('beforeend', `<div id="fbnote" class="fbnote no-print" role="status"><span>Save today’s backup in your folder <b>${esc(folderSt.name)}</b>?</span>
    <button type="button" class="btn sm primary" data-fb="save">Save backup</button><button type="button" class="btn sm" data-fb="later">Not now</button></div>`);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-fb]');
  if (!b) return;
  if (b.dataset.fb === 'later') folderLater = true; else folderBackup('tap');
  const n = $('#fbnote'); if (n) n.remove();
});
setInterval(() => folderBackup(), 10 * 60e3);
async function folderUi() {
  const box = $('#fbox'); if (!box) return;
  if (!FOLDER_OK) {
    box.innerHTML = '<p class="muted">This works in <b>Chrome or Edge on a computer</b>. On a phone, turn on Google Drive backup above (the Drive app can keep the files offline), or tap Download.</p>';
    return;
  }
  const st = await folderLoad();
  const when = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = !st ? `<p class="muted">Choose a folder on this computer once. While SmartTrader is open here, it saves a backup in that folder by itself every day: the .json file and an Excel copy, the newest 30 kept. Tip: choose a folder inside <b>Google Drive for desktop</b>, OneDrive or a pen drive, and the backup is copied on from there. इस कंप्यूटर के फ़ोल्डर में रोज़ अपने आप बैकअप।</p>
      <div class="row"><button type="button" class="btn primary" id="fbpick">Choose a folder</button></div>`
    : `<p>Saving in the folder <b>${esc(st.name)}</b> on this computer.</p>
      <p class="muted">${st.last_at ? `Last saved: <b>${when(st.last_at)}</b>${st.last_size ? ` · ${Math.max(1, Math.round(st.last_size / 1024))} KB` : ''}.` : 'Nothing saved yet.'} It runs while SmartTrader is open on this computer; the newest 30 are kept.</p>
      ${st.ask ? '<div class="panel warnbox" style="margin:8px 0">The browser wants your OK to use this folder again. Tap <b>Save now</b>; if it offers <b>Allow on every visit</b>, choose that so it does not ask again.</div>' : ''}
      ${st.error ? `<div class="panel err" style="margin:8px 0">${esc(st.error)}</div>` : ''}
      <label class="check"><input type="checkbox" id="fbexcel" ${st.excel !== false ? 'checked' : ''}> Also save an Excel copy</label>
      <div class="row"><label class="f inline-f">Save<select id="fbevery"><option value="day" ${st.every !== 'week' ? 'selected' : ''}>Every day</option><option value="week" ${st.every === 'week' ? 'selected' : ''}>Every week</option></select></label>
        <button type="button" class="btn" id="fbnow">Save now</button><button type="button" class="btn" id="fbpick">Change folder</button><span class="spacer"></span><button type="button" class="btn danger" id="fboff">Stop</button></div>`;
  $('#fbpick').onclick = async () => {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'smarttrader-backup', mode: 'readwrite', startIn: 'documents' }); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); return; }
    await folderSave({ dir, name: dir.name, excel: st ? st.excel !== false : true, every: st ? st.every || 'day' : 'day', last_at: 0, last_size: 0, error: '', err_at: 0, ask: false });
    folderUi(); folderBackup('tap');
  };
  if (!st) return;
  $('#fbnow').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Saving…'; await folderBackup('tap'); folderUi(); };
  $('#fbexcel').onchange = async (e) => { await folderSave({ ...st, excel: e.target.checked }); toast(e.target.checked ? 'An Excel copy goes with every backup' : 'Only the .json backup will be saved'); };
  $('#fbevery').onchange = async (e) => { await folderSave({ ...st, every: e.target.value }); toast('Saved'); };
  $('#fboff').onclick = async () => {
    if (!confirm(`Stop saving backups in “${st.name}”? The files already there stay.`)) return;
    await folderSave(null); folderUi(); folderShow();
  };
}
// '@' stays literal: UPI apps show "name%40bank" for an encoded one and will not let the payer continue.
const upiLink = (vpa, name, amount, note) => `upi://pay?pa=${encodeURIComponent(vpa).replace(/%40/g, '@')}&pn=${encodeURIComponent(name)}${amount ? `&am=${(+amount).toFixed(2)}` : ''}&cu=INR${note ? `&tn=${encodeURIComponent(note)}` : ''}`;
/* any text as a QR code (the WhatsApp bot link) */
async function qrInto(el, text) {
  try {
    const { default: qrcode } = await import('/vendor/qrcode.mjs');
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    el.innerHTML = `<div class="qr">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}</div>`;
  } catch (e) { el.innerHTML = ''; }
}
async function upiQr(el, org, amount, note, caption = '') {
  if (!el || !org.upi_id) return;
  try {
    const { default: qrcode } = await import('/vendor/qrcode.mjs');
    const qr = qrcode(0, 'M'); qr.addData(upiLink(org.upi_id, org.name, amount, note)); qr.make();
    el.innerHTML = `<div class="qr">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<div>${esc(caption)}<br><b>${amount ? inr(amount) : ''}</b> &middot; ${esc(org.upi_id)}</div></div>`;
  } catch (e) { el.innerHTML = ''; }
}
const scripts = {};
const loadScript = (src) => scripts[src] || (scripts[src] = new Promise((ok, fail) => {
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load ' + src)); document.head.appendChild(s);
}));
const labelCode = (it) => it.barcode || it.sku || 'ST' + it.id;

/* ======================================================================= POS / quick bill with barcode scanning */
/* ======================================================================= restaurant: tables and KOT */
/* Tables: each free or running (amount, time, items). A table's order: tap menu items (or speak them), "Send KOT" prints the
   kitchen ticket (no prices) and keeps them on the order; "Bill" makes one invoice and frees the table. Items not yet sent
   stay on this phone until they are (a draft per table). */
const kotDraftKey = (tid) => `st:kot:${ME.org.id}:${tid}`;
const kotDraft = (tid, set) => {
  if (set !== undefined) { storeSet(kotDraftKey(tid), JSON.stringify(set)); return set; }
  try { return JSON.parse(storeGet(kotDraftKey(tid)) || '[]') || []; } catch (e) { return []; }
};
const since = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
function printKot(k) {
  let r = $('#receipt');
  if (!r) { r = document.createElement('div'); r.id = 'receipt'; r.className = 'receipt'; document.body.appendChild(r); }
  const t = new Date(k.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  r.innerHTML = `<div class="c">${esc(ME.org.name)}</div><div class="c kot-h">${k.kind === 'cancel' ? '*** CANCEL ***<br>' : ''}KOT ${k.number}<br>Table ${esc(k.table)}</div>
    <div class="c">${fdate(k.at.slice(0, 10))} ${t}${k.user ? ` &middot; ${esc(k.user)}` : ''}</div>
    <table>${k.lines.map((l) => `<tr><td class="kq">${qtyf(l.qty)}</td><td><b>${esc(l.name)}</b>${l.note ? `<div class="kn">${esc(l.note)}</div>` : ''}</td></tr>`).join('')}</table>`;
  document.body.classList.add('print-receipt');
  setTimeout(() => { print(); document.body.classList.remove('print-receipt'); }, 50);
}
route(/^tables$/, async (el) => {
  const b = await GET('/api/dine'), canSet = ME.can.settings;
  if (!b.tables.length) {
    el.innerHTML = head('Tables (Restaurant)') + `<div class="panel"><p>For a restaurant, dhaba, cafe or sweet shop with seating: each table keeps its order open while people eat. Send the items to the kitchen as a KOT (kitchen ticket, no prices), add more any time, and make one bill at the end.</p>
      <p class="muted small" lang="hi">हर टेबल का ऑर्डर खुला रहता है; रसोई को KOT भेजें, बाद में और जोड़ें, आख़िर में एक बिल।</p>
      ${canSet ? `<form id="tadd" class="form"><label class="f">How many tables<input name="count" type="number" min="1" max="200" value="10"></label><label class="f">Name starts with<input name="prefix" value="T" maxlength="10"></label>
        <label class="f">Area (optional)<input name="area" placeholder="Hall, AC, Terrace" maxlength="30"></label><label class="f">&nbsp;<button class="btn primary">Add tables</button></label></form>` : '<p class="muted">Ask the owner to add the tables.</p>'}</div>`;
    if ($('#tadd')) $('#tadd').onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await POST('/api/dine/tables', { count: +f.count.value, prefix: f.prefix.value, area: f.area.value }); render(); } catch (x) { toast(x.message, 'err'); } };
    return;
  }
  const areas = [...new Set(b.tables.map((t) => t.area || ''))];
  const running = b.tables.filter((t) => t.order);
  el.innerHTML = head('Tables (Restaurant)', `<a class="btn" href="#/kots">KOT log</a>${canSet ? '<button class="btn" id="tmore">+ Tables</button>' : ''}`) + `
    <div class="kpis"><div class="kpi"><div class="l">Running</div><div class="v">${running.length} / ${b.tables.length}</div><div class="s">tables with an open order</div></div>
      <div class="kpi"><div class="l">On the tables now</div><div class="v">${inr(running.reduce((x, t) => x + t.order.amount, 0))}</div><div class="s">not billed yet</div></div></div>
    ${areas.map((a) => `${a ? `<h3 class="tarea">${esc(a)}</h3>` : ''}<div class="tgrid">${b.tables.filter((t) => (t.area || '') === a).map((t) => `<a class="ttile ${t.order ? 'busy' : ''}" href="#/table/${t.id}">
      <b>${esc(t.name)}</b>${t.order ? `<span class="tamt">${inr(t.order.amount)}</span><span class="muted small">${since(t.order.opened_at)} &middot; ${t.order.items} item${t.order.items === 1 ? '' : 's'}</span>`
        : `<span class="muted small">Free${t.seats ? ` &middot; ${t.seats} seats` : ''}</span>`}${kotDraft(t.id).length ? '<span class="tnew">not sent</span>' : ''}</a>`).join('')}</div>`).join('')}`;
  if ($('#tmore')) $('#tmore').onclick = () => modal('Add tables', [{ k: 'names', label: 'Names (comma or one per line), or leave empty and give a number', type: 'textarea', wide: true },
    { k: 'count', label: 'Or how many', type: 'number' }, { k: 'prefix', label: 'Name starts with', value: 'T' }, { k: 'area', label: 'Area (optional)' }, { k: 'seats', label: 'Seats', type: 'number', value: 4 }],
  async (v) => { await POST('/api/dine/tables', { ...v, count: +v.count || 0, seats: +v.seats || 0 }); render(); });
  const tick = setInterval(() => { if (location.hash === '#/tables') render(); else clearInterval(tick); }, 30000);
});
route(/^table\/(\d+)$/, async (el, m) => {
  const tid = +m[1];
  const [items, x, parties, accts] = await Promise.all([master('items'), GET('/api/dine/tables/' + tid), master('parties'), master('accounts')]);
  const menu = items.filter((i) => i.sale_price > 0);
  const cats = [...new Set(menu.map((i) => i.category || '').filter(Boolean))].sort();
  let draft = kotDraft(tid), cat = '', q = '';
  const price = (it) => it.sale_price_incl || it.sale_price;      // what the guest pays, with GST
  const save = () => kotDraft(tid, draft);
  const addItem = (id, qty = 1) => { const ex = draft.find((d) => d.item_id === id && !d.note); if (ex) ex.qty = r2(ex.qty + qty); else draft.push({ item_id: id, qty, note: '' }); save(); drawOrder(); };
  el.innerHTML = head(`Table ${esc(x.table.name)}`, `<a class="btn" href="#/tables">All tables</a>`) + `
    <div class="posgrid">
      <div><div class="panel"><div class="row"><input id="mq" class="grow" placeholder="Search the menu" autocomplete="off"><button class="btn" id="tvoice" title="Speak the order">&#127908; Bolkar</button></div>
        ${cats.length ? `<div class="chips" id="mcats"><button type="button" class="chip on" data-c="">All</button>${cats.map((c) => `<button type="button" class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}</div>
        <div class="mgrid" id="mgrid"></div></div>
      <div class="panel pos-pay" id="order"></div>
    </div>`;
  const drawMenu = () => {
    const list = menu.filter((i) => (!cat || i.category === cat) && (!q || i.name.toLowerCase().includes(q)));
    $('#mgrid').innerHTML = list.length ? list.slice(0, 300).map((i) => `<button type="button" class="mitem" data-add="${i.id}"><b>${esc(i.name)}</b><span>${inr(price(i))}</span></button>`).join('')
      : `<div class="empty">${menu.length ? 'Nothing matches.' : 'Add your menu as items with a selling price (Inventory → Items).'}</div>`;
  };
  const drawOrder = () => {
    const sent = x.lines.filter((l) => l.status === 'ok'), cut = x.lines.filter((l) => l.status === 'void');
    const newAmt = draft.reduce((s, d) => { const it = items.find((i) => i.id === d.item_id); return s + (it ? d.qty * price(it) : 0); }, 0);
    const total = (x.order ? x.order.amount : 0) + newAmt;
    $('#order').innerHTML = `<div class="row"><b>Table ${esc(x.table.name)}</b><span class="spacer"></span>${x.order ? `<span class="muted small">open ${since(x.order.opened_at)}</span>` : '<span class="muted small">free</span>'}</div>
      ${draft.length ? `<h4 class="kh">New <span class="muted small">(not sent to the kitchen)</span></h4><div class="klines">${draft.map((d, i) => { const it = items.find((z) => z.id === d.item_id) || { name: '?' }; return `<div class="kline new">
          <div class="kname"><b>${esc(it.name)}</b><input data-note="${i}" value="${esc(d.note)}" placeholder="note: less spicy, no onion" maxlength="80"></div>
          <div class="kqty"><button type="button" class="btn sm" data-minus="${i}" aria-label="One less">&minus;</button><span>${qtyf(d.qty)}</span><button type="button" class="btn sm" data-plus="${i}" aria-label="One more">+</button></div></div>`; }).join('')}</div>
        <button class="btn primary big" id="sendkot">Send KOT (${draft.length} item${draft.length === 1 ? '' : 's'})</button>` : ''}
      ${sent.length ? `<h4 class="kh">With the kitchen</h4><div class="klines">${sent.map((l) => `<div class="kline"><div class="kname">${qtyf(l.qty)} &times; ${esc(l.name)}${l.note ? `<div class="muted small">${esc(l.note)}</div>` : ''}<div class="muted small">KOT ${l.kot_no}</div></div>
          <div class="kqty"><span>${inr(l.amount)}</span><button type="button" class="btn sm danger" data-cut="${l.id}" aria-label="Cancel ${esc(l.name)}">&times;</button></div></div>`).join('')}</div>` : ''}
      ${cut.length ? `<details class="small"><summary class="muted">${cut.length} cancelled</summary>${cut.map((l) => `<div class="muted">${qtyf(l.qty)} &times; ${esc(l.name)}${l.void_reason ? ` (${esc(l.void_reason)})` : ''}</div>`).join('')}</details>` : ''}
      ${!draft.length && !sent.length ? '<div class="empty">Tap items on the menu to start the order.</div>' : ''}
      <div class="totals" style="width:100%"><div class="grand"><span>Total</span><span>${inr(total)}</span></div>${newAmt ? `<div class="muted small"><span>of which not sent</span><span>${inr(newAmt)}</span></div>` : ''}</div>
      ${x.order ? `<button class="btn big" id="tbill" ${draft.length ? 'disabled title="Send the new items first"' : ''}>Bill ${inr(x.order.amount)}</button>
        <div class="row"><button type="button" class="btn sm" id="tmove">Move table</button><span class="spacer"></span><button type="button" class="btn sm danger" id="tvoid">Cancel order</button></div>` : ''}`;
  };
  drawMenu(); drawOrder();
  $('#mq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); drawMenu(); };
  if ($('#mcats')) $('#mcats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; cat = b.dataset.c; $$('#mcats .chip').forEach((c) => c.classList.toggle('on', c === b)); drawMenu(); };
  $('#mgrid').onclick = (e) => { const b = e.target.closest('[data-add]'); if (b) { addItem(+b.dataset.add); beep(true); } };
  $('#tvoice').onclick = () => voiceOrder(menu, (got) => { got.forEach((g) => addItem(g.item_id, g.qty)); });
  $('#order').addEventListener('input', (e) => { const i = e.target.dataset.note; if (i !== undefined) { draft[+i].note = e.target.value; save(); } });
  $('#order').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.plus !== undefined) { draft[+t.dataset.plus].qty += 1; save(); drawOrder(); }
    if (t.dataset.minus !== undefined) { const d = draft[+t.dataset.minus]; d.qty -= 1; if (d.qty <= 0) draft.splice(+t.dataset.minus, 1); save(); drawOrder(); }
    if (t.id === 'sendkot') {
      t.disabled = true;
      try { const r = await POST(`/api/dine/tables/${tid}/kot`, { lines: draft }); draft = []; save(); Object.assign(x, r); printKot(r.kot); toast(`KOT ${r.kot.number} sent`); drawOrder(); }
      catch (er) { toast(er.message, 'err'); t.disabled = false; }
    }
    if (t.dataset.cut) {
      const l = x.lines.find((z) => z.id === +t.dataset.cut);
      const reason = prompt(`Cancel ${l.name}? The kitchen gets a CANCEL ticket. Why (optional):`, '');
      if (reason === null) return;
      try { const r = await POST(`/api/dine/lines/${l.id}/void`, { reason }); Object.assign(x, r); printKot(r.kot); drawOrder(); } catch (er) { toast(er.message, 'err'); }
    }
    if (t.id === 'tmove') {
      const free = (await GET('/api/dine')).tables.filter((z) => !z.order && z.id !== tid);
      if (!free.length) return toast('No free table to move to.');
      modal(`Move table ${x.table.name}`, [{ k: 'to', label: 'To table', type: 'select', options: free.map((z) => ({ v: z.id, t: z.name + (z.area ? ` (${z.area})` : '') })) }],
        async (v) => { await POST(`/api/dine/tables/${tid}/move`, { to: +v.to }); const old = kotDraft(tid); if (old.length) { kotDraft(+v.to, old); kotDraft(tid, []); } go('table/' + v.to); }, { submit: 'Move' });
    }
    if (t.id === 'tvoid') {
      const reason = prompt(`Cancel the whole order of ${x.table.name}? Nothing is billed. Why:`, '');
      if (reason === null) return;
      try { await POST(`/api/dine/tables/${tid}/void`, { reason }); kotDraft(tid, []); go('tables'); } catch (er) { toast(er.message, 'err'); }
    }
    if (t.id === 'tbill') {
      const customers = parties.filter((p) => p.kind !== 'supplier');
      const walk = customers.find((p) => p.name === 'Walk-in Customer') || customers[0] || {};
      const acc = (sys) => (accts.find((a) => a.sys === sys) || accts.find((a) => a.is_cash) || {}).id;
      modal(`Bill table ${x.table.name}: ${inr(x.order.amount)}`, [
        { k: 'method', label: 'Paid by', type: 'select', value: 'cash', options: [{ v: 'cash', t: 'Cash' }, { v: 'upi', t: 'UPI' }, { v: 'bank', t: 'Card / Bank' }, ...(limits().no_credit ? [] : [{ v: 'credit', t: 'Credit (udhaar)' }])] },
        { k: 'party_id', label: 'Customer', type: 'select', value: walk.id, options: customers.map((p) => ({ v: p.id, t: p.name })) },
        { k: 'discount_pct', label: 'Discount %', type: 'number', value: 0 }],
      async (v) => {
        const body = { party_id: +v.party_id, discount_pct: +v.discount_pct || 0, credit_ok: false };
        if (v.method !== 'credit') body.payment = { full: true, account_id: acc(v.method === 'upi' ? 'upi' : v.method === 'bank' ? 'bank' : 'cash') };
        const d = await POST(`/api/dine/tables/${tid}/bill`, body);
        dirty('items', 'accounts', 'parties');
        printReceipt(d, v.method, 0); toast(`${d.number} saved, table ${x.table.name} is free`); go('tables');
      }, { submit: 'Bill and print' });
    }
  });
});
route(/^kots$/, async (el, m, q) => {
  const x = await GET('/api/dine/kots?day=' + (q.get('day') || ''));
  el.innerHTML = head('KOT log', '<a class="btn" href="#/tables">Tables</a>') + `
    <div class="panel"><form class="row" id="kday"><input type="date" name="day" value="${x.day}" style="max-width:170px" aria-label="Day"><button class="btn">Show</button></form>
      <p class="muted small">Every kitchen ticket of the day. Items cancelled after the kitchen had them are marked: ${x.cancels ? `<b>${x.cancels} today</b>` : 'none today'}.</p></div>
    <div class="panel flush">${table([{ h: 'Time', f: (r) => new Date(r.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) },
      { h: 'KOT', f: (r) => `<b>${r.number}</b>${r.kind === 'cancel' ? ' ' + badge('cancelled') : ''}` }, { h: 'Table', k: 'table_name' }, { h: 'Items', f: (r) => esc(r.items || '') },
      { h: 'By', cls: 'hide-sm', f: (r) => esc(r.user || '') }], x.rows, { empty: 'No KOT on this day.' })}</div>`;
  $('#kday').onsubmit = (e) => { e.preventDefault(); go('kots?day=' + e.target.day.value); };
});
/* ======================================================================= bolkar bill (voice) */
/* The order spoken in Hindi, Hinglish or English (public/voice.js reads it): what was heard, the item found for each part and
   its quantity, all of which the user can fix before the lines go on the bill. Without speech in the browser the order is typed. */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
async function voiceOrder(items, onAdd) {
  const { parseOrder, heardText } = await import('/voice.js');
  let root = $('#voice-root');
  if (!root) { root = document.createElement('div'); root.id = 'voice-root'; document.body.appendChild(root); }
  const lang = storeGet('st:voice') || (LANG === 'hi' ? 'hi-IN' : 'hi-IN');
  root.innerHTML = `<div class="modal-bg"><div class="modal voice" role="dialog" aria-label="Speak the order"><h2>&#127908; Bolkar bill</h2>
    <p class="muted small">Say the items one after another: <b>"do kilo cheeni, ek litre tel, paanch sabun"</b>. Rupees work too: <b>"50 rupaye ki mirchi"</b>.</p>
    <p class="muted small" lang="hi">बोलिए: "दो किलो चीनी, एक लीटर तेल, पांच साबुन"। थोड़ा रुककर अगला सामान बोलें।</p>
    ${SpeechRec ? `<div class="row vmicrow"><button type="button" class="btn primary big" id="vmic">&#127908; Tap and speak</button>
      <select id="vlang" aria-label="Language you speak in"><option value="hi-IN" ${lang === 'hi-IN' ? 'selected' : ''}>हिंदी / Hinglish</option><option value="en-IN" ${lang === 'en-IN' ? 'selected' : ''}>English (India)</option></select></div>`
      : '<p class="panel warnbox small">Speaking needs Chrome or Edge. Type the order below instead.</p>'}
    <label class="f wide">Heard <span class="muted">(fix or type here)</span><textarea id="vtext" rows="3" placeholder="do kilo cheeni, ek litre tel, paanch sabun"></textarea></label>
    <div class="row"><button type="button" class="btn" id="vread">Find items</button></div>
    <div id="vlist"></div>
    ${SpeechRec ? '<p class="muted small">Your browser turns the voice into text (Chrome does it through Google). SmartTrader keeps no recording.</p>' : ''}
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" id="vadd" disabled>Add to bill</button></div></div></div>`;
  let rec = null, on = false, lines = [];
  const close = () => { if (rec) { try { rec.abort(); } catch (e) { /* stopped */ } } root.innerHTML = ''; document.removeEventListener('keydown', escKey); };
  const escKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escKey);
  $('[data-x]', root).onclick = close;
  const allOpts = items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
  const draw = () => {
    $('#vlist').innerHTML = lines.length ? `<div class="tbl-wrap"><table class="t vlines"><thead><tr><th>Item</th><th>Qty</th><th></th></tr></thead><tbody>${lines.map((l, i) => `<tr class="${l.item_id ? '' : 'vmiss'}">
        <td><div class="muted small">&ldquo;${esc(l.heard)}&rdquo;${l.note ? ` &middot; ${esc(l.note)} worth` : ''}</div><select data-vi="${i}" aria-label="Item"><option value="">${l.item_id ? '' : 'Not found: choose…'}</option>${l.options.length ? `<optgroup label="Close matches">${l.options.map((o) => `<option value="${o.id}" ${o.id === l.item_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>` : ''}<optgroup label="All items">${allOpts}</optgroup></select></td>
        <td><input type="number" step="any" min="0" inputmode="decimal" data-vq="${i}" value="${l.qty}" style="width:80px" aria-label="Quantity"></td>
        <td><button type="button" class="btn sm danger" data-vx="${i}" aria-label="Remove">&times;</button></td></tr>`).join('')}</tbody></table></div>`
      : '';
    $('#vadd').disabled = !lines.some((l) => l.item_id && l.qty > 0);
    $('#vadd').textContent = `Add ${lines.filter((l) => l.item_id && l.qty > 0).length || ''} to bill`.replace('  ', ' ');
  };
  const read = () => { lines = parseOrder($('#vtext').value, items); draw(); };
  $('#vread').onclick = read;
  $('#vlist').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.vi !== undefined) { const l = lines[+t.dataset.vi]; l.item_id = +t.value || null; l.name = (items.find((x) => x.id === l.item_id) || {}).name || ''; }
    if (t.dataset.vq !== undefined) lines[+t.dataset.vq].qty = +t.value || 0;
    draw();
  });
  $('#vlist').addEventListener('click', (e) => { const x = e.target.closest('[data-vx]'); if (x) { lines.splice(+x.dataset.vx, 1); draw(); } });
  $('#vadd').onclick = () => { const ok = lines.filter((l) => l.item_id && l.qty > 0); close(); onAdd(ok.map((l) => ({ item_id: l.item_id, qty: l.qty }))); };
  const mic = $('#vmic');
  if (!mic) { $('#vtext').focus(); return; }
  $('#vlang').onchange = () => storeSet('st:voice', $('#vlang').value);
  const label = () => { mic.innerHTML = on ? '&#9209; Stop' : '&#127908; Tap and speak'; mic.classList.toggle('listening', on); };
  mic.onclick = () => {
    if (on) { try { rec.stop(); } catch (e) { /* stopped */ } return; }
    rec = new SpeechRec(); rec.lang = $('#vlang').value; rec.interimResults = true; rec.continuous = true;
    const before = $('#vtext').value.trim();
    rec.onresult = (e) => {
      // each final piece once, even where Android repeats the earlier ones in every result
      // what was already in the box counts as said: a new tap that hears it again does not add it twice
      const { done, now } = heardText([...(before ? [{ transcript: before, isFinal: true }] : []), ...[...e.results].map((r) => ({ transcript: r[0].transcript, isFinal: r.isFinal }))]);
      $('#vtext').value = done + (done && now ? ', ' : '') + now;
      if (done) { lines = parseOrder(done, items); draw(); }
    };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Allow the microphone for this site to speak the order.' : 'Could not hear: ' + e.error, 'err'); };
    rec.onend = () => { on = false; if (root.innerHTML) { label(); read(); } };
    try { rec.start(); on = true; label(); } catch (e) { toast('The microphone could not start: ' + e.message, 'err'); }
  };
}
route(/^pos$/, async (el) => {
  dirty('items', 'accounts');
  const [items, parties, whs, accts] = await Promise.all([master('items'), master('parties'), master('warehouses'), master('accounts')]);
  const customers = parties.filter((p) => p.kind !== 'supplier');
  const walkin = customers.find((p) => p.name === 'Walk-in Customer') || customers[0];
  const acc = (sys) => (accts.find((a) => a.sys === sys) || accts.find((a) => a.is_cash) || {}).id;
  const cart = [];
  let method = 'cash';
  el.innerHTML = head('Quick Bill', `<a class="btn" href="#/sales/INV">All invoices</a>`) + `
    <div class="posgrid">
      <div>
        <div class="panel"><div class="row">
          <label class="f grow">Customer<select id="cust">${customers.map((p) => `<option value="${p.id}" ${p.id === (walkin && walkin.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="f">Godown<select id="wh">${whs.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label></div>
          <div class="row" style="margin-top:10px"><input id="scan" class="grow scan" list="pos-items" placeholder="Scan barcode or type item name, then Enter" autocomplete="off" autofocus>
            ${canCamera() ? '<button class="btn" id="cam" title="Scan with camera">📷 Camera</button>' : ''}<button class="btn" id="voice" title="Speak the order">&#127908; Bolkar</button></div>
          <datalist id="pos-items">${items.map((i) => `<option value="${esc(i.name)}">${esc(labelCode(i))} · ${inr(shownPrice(i))}</option>`).join('')}</datalist></div>
        <div class="panel flush" id="cart"></div>
      </div>
      <div class="panel pos-pay">
        <div class="totals" id="ptot" style="width:100%"></div>
        <div class="seg" id="method">${[['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Card / Bank'], ...(limits().no_credit ? [] : [['credit', 'Credit (udhaar)']])].map(([k, t]) => `<button type="button" data-m="${k}" class="${k === method ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div class="pts" id="pospts" hidden></div>
        <label class="f" id="recvw">Amount received (₹)<input id="recv" type="number" step="any" min="0"></label>
        <div id="change" class="muted"></div><div id="posqr"></div>${cfDefs('doc', 'sales').length ? `<div class="form">${cfInputs('doc', {}, 'sales')}</div>` : ''}
        <div class="warnbox cwarn" id="cwarn" role="status" hidden></div>
        <button class="btn primary big" id="done">Complete sale <span class="hide-sm">(F9)</span></button>
        <div class="err" id="perr" hidden></div>
      </div>
    </div>
`;
  const totals = () => {
    let taxable = 0, tax = 0;
    // an MRP item's rate has its GST in it: the line costs qty x rate, and the tax is taken out of that
    for (const l of cart) { const g = r2(l.qty * l.rate), t = l.incl ? r2(g * 100 / (100 + l.gst_rate)) : g; taxable += t; tax += l.incl ? r2(g - t) : r2(t * l.gst_rate / 100); }
    return { taxable, tax, total: Math.round(taxable + tax) };
  };
  // loyalty points: a named customer's balance; one tick uses as many as this bill allows
  const LOY = ME.org.loyalty || {};
  let pts = null, usePts = false;
  const ptsMost = (total) => (usePts && pts && pts.can_use ? Math.max(0, Math.min(pts.balance, Math.floor(total * LOY.max_pct / 100 / LOY.point_value + 1e-9))) : 0);
  const loadPts = async () => {
    pts = null; usePts = false;
    const pid = +$('#cust').value || 0;
    if (LOY.on && pid) { try { pts = await GET('/api/loyalty/' + pid); } catch (e) { pts = null; } }
    if (pid === (+$('#cust').value || 0)) draw();
  };
  const draw = () => {
    $('#cart').innerHTML = cart.length ? `<table class="t lines"><thead><tr><th>Item</th><th>Qty</th><th class="num">Rate</th><th class="num">Amount</th><th></th></tr></thead><tbody>${cart.map((l, i) => `<tr>
        <td><b>${esc(l.name)}</b><div class="muted">${esc(l.code)} · GST ${l.gst_rate}% · stock ${qtyf(l.stock)}</div></td>
        <td class="c-n"><input type="number" step="any" min="0" value="${l.qty}" data-q="${i}"></td>
        <td class="num"><input type="number" step="any" min="0" value="${l.rate}" data-r="${i}" style="width:90px"></td>
        <td class="num">${inr(r2(l.qty * l.rate * (1 + l.gst_rate / 100)))}</td><td><button class="btn sm danger" data-x="${i}">&times;</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Scan an item to start the bill.</div>';
    const t = totals(), used = ptsMost(t.total), pv = r2(used * (LOY.point_value || 0)), toPay = r2(t.total - pv);
    $('#ptot').innerHTML = `<div><span>Items</span><span>${cart.reduce((s, l) => s + l.qty, 0)}</span></div><div><span>Taxable</span><span>${inr(t.taxable)}</span></div>
      <div><span>GST</span><span>${inr(t.tax)}</span></div><div class="grand"><span>Total</span><span>${inr(t.total)}</span></div>
      ${pv > 0 ? `<div><span>&#11088; ${used} points</span><span>&minus;${inr(pv)}</span></div><div class="grand"><span>To pay</span><span>${inr(toPay)}</span></div>` : ''}`;
    const pbox = $('#pospts');
    pbox.hidden = !(pts && pts.on && pts.earns);
    if (!pbox.hidden) pbox.innerHTML = pts.can_use
      ? `<label class="check"><input type="checkbox" id="useps" ${usePts ? 'checked' : ''}> <span>&#11088; Use points: <b>${pts.balance}</b> (worth ${inr(pts.value)})<small class="help">Up to ${LOY.max_pct}% of a bill.</small></span></label>`
      : `<p class="muted small">&#11088; ${pts.balance} loyalty point${pts.balance === 1 ? '' : 's'}${pts.balance > 0 && LOY.min_points ? ` (usable from ${LOY.min_points})` : ''}</p>`;
    const recv = $('#recv');
    if (document.activeElement !== recv) recv.value = method === 'credit' ? '' : toPay || '';
    $('#recvw').hidden = method === 'credit';
    const ch = (+recv.value || 0) - toPay;
    $('#change').textContent = method === 'cash' && ch > 0 ? `Return change: ${inr(ch)}` : method === 'credit' ? 'The full amount goes to the customer’s account.' : '';
    if (method === 'upi' && toPay) upiQr($('#posqr'), ME.org, toPay, 'Bill', 'Customer scans to pay'); else $('#posqr').innerHTML = method === 'upi' ? '<p class="muted">Add your UPI ID in Settings to show a QR here.</p>' : '';
    if (method === 'upi' && !ME.org.upi_id) $('#posqr').innerHTML = '<p class="muted">Add your UPI ID in Settings to show a QR here.</p>';
  };
  const add = async (code) => {
    code = code.trim();
    if (!code) return;
    const lc = code.toLowerCase();
    let it = items.find((i) => i.name.toLowerCase() === lc || (i.barcode && i.barcode === code) || (i.sku && i.sku.toLowerCase() === lc) || ('st' + i.id) === lc);
    if (!it) { try { it = await GET('/api/items/lookup?code=' + encodeURIComponent(code)); } catch (e) { toast(e.message); beep(false); return; } }
    const line = cart.find((l) => l.item_id === it.id), n = it.pack_qty || 1;     // a carton code counts its pieces
    if (line) line.qty = r2(line.qty + n);
    else cart.push({ item_id: it.id, name: it.name, code: labelCode(it), qty: n, rate: it.price_incl ? it.sale_price_incl : it.sale_price, incl: !!it.price_incl, gst_rate: it.gst_rate, stock: it.qty_on_hand, unit: it.unit });
    beep(true); draw();
  };
  const scan = $('#scan');
  scan.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = scan.value; scan.value = ''; await add(v); scan.focus(); } });
  scan.addEventListener('change', async () => { if (items.some((i) => i.name === scan.value)) { const v = scan.value; scan.value = ''; await add(v); } });
  $('#cart').addEventListener('input', (e) => {
    const q = e.target.dataset.q, r = e.target.dataset.r;
    if (q !== undefined) cart[+q].qty = +e.target.value || 0;
    if (r !== undefined) cart[+r].rate = +e.target.value || 0;
    const t = totals(); $('#ptot .grand span:last-child').textContent = inr(t.total);
  });
  $('#cart').addEventListener('change', draw);
  $('#cart').addEventListener('click', (e) => { if (e.target.dataset.x !== undefined) { cart.splice(+e.target.dataset.x, 1); draw(); } });
  const setMethod = (m) => { method = m; $$('#method button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); draw(); posRisk(); };
  $('#method').onclick = (e) => { const m = e.target.dataset.m; if (m) setMethod(m); };
  $('#recv').oninput = draw;
  // udhaar check (Vaada Pakka): banner when a risky customer buys on credit
  let risk = null, riskFor = 0;
  const posRisk = async () => {
    const pid = +$('#cust').value || 0, box = $('#cwarn');
    if (method !== 'credit') { box.hidden = true; return; }
    if (pid !== riskFor) { riskFor = pid; risk = await creditCheck(pid); }
    box.hidden = !(risk && risk.risky && method === 'credit' && riskFor === +$('#cust').value);
    if (!box.hidden) box.innerHTML = creditText(risk);
  };
  $('#cust').addEventListener('change', posRisk);
  $('#cust').addEventListener('change', loadPts);
  $('#pospts').addEventListener('change', (e) => { if (e.target.id === 'useps') { usePts = e.target.checked; draw(); } });
  if ($('#cam')) $('#cam').onclick = () => cameraScan(add);
  // bolkar bill: each line found goes on the cart with the quantity said
  $('#voice').onclick = () => voiceOrder(items, (got) => {
    for (const g of got) {
      const it = items.find((i) => i.id === g.item_id); if (!it) continue;
      const line = cart.find((l) => l.item_id === it.id);
      if (line) line.qty = Math.round((line.qty + g.qty) * 1000) / 1000;   // 3 decimals, as the bill keeps them (250 g + 125 g = 0.375 kg)
      else cart.push({ item_id: it.id, name: it.name, code: labelCode(it), qty: g.qty, rate: it.price_incl ? it.sale_price_incl : it.sale_price, incl: !!it.price_incl, gst_rate: it.gst_rate, stock: it.qty_on_hand, unit: it.unit });
    }
    if (got.length) { beep(true); toast(`${got.length} item${got.length === 1 ? '' : 's'} added`); }
    draw(); scan.focus();
  });
  // one Idempotency-Key per bill: a double tap on Done, or a save sent again after a lost answer, makes one bill
  let billKey = newKey();
  const complete = async () => {
    const lines = cart.filter((l) => l.qty > 0);
    if (!lines.length) return toast('The bill is empty.');
    const t = totals(), btn = $('#done'); btn.disabled = true; $('#perr').hidden = true;
    const body = { type: 'INV', party_id: +$('#cust').value, warehouse_id: +$('#wh').value, date: ME.today, notes: 'POS sale', extra: cfRead($('.pos-pay')),
      lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate, incl: l.incl || undefined })) };
    const used = ptsMost(t.total), toPay = r2(t.total - used * (LOY.point_value || 0));
    if (used) body.redeem_points = used;
    if (method !== 'credit' && toPay > 0) body.payment = { amount: Math.min(+$('#recv').value || toPay, toPay), account_id: acc(method === 'upi' ? 'upi' : method === 'bank' ? 'bank' : 'cash') };
    body.credit_ok = false; body.zero_ok = false;
    const save = async () => {
      try {
        const d = await POST('/api/docs', body, { key: billKey });
        billKey = newKey();                         // the next bill is a new one
        if (d.queued) { cart.length = 0; draw(); scan.focus(); toast('No internet: bill saved on this device, sent when online (Outbox).', 'info'); return; }
        dirty('items', 'accounts', 'parties');
        printReceipt(d, method, +$('#recv').value || 0);
        cart.length = 0; draw(); scan.focus(); toast(`${d.number} saved${d.points && d.points.earned ? ` · ${d.points.earned} points earned` : ''}`);
        if (pts) loadPts();
      } catch (err) {
        if (err.status === 409 && err.data.credit_warning) return creditSheet(err.data.credit_warning, { yes: () => { body.credit_ok = true; save(); }, cash: () => setMethod('cash') });
        if (err.status === 409 && err.data.zero_rate) return zeroSheet(err.data.zero_rate, { yes: () => { body.zero_ok = true; save(); }, fix: () => scan.focus() });
        $('#perr').hidden = false; $('#perr').textContent = err.message;
      }
    };
    try { await save(); } finally { btn.disabled = false; }
  };
  $('#done').onclick = complete;
  const keys = (e) => { if (e.key === 'F9') { e.preventDefault(); complete(); } };
  document.addEventListener('keydown', keys);
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', keys), { once: true });
  draw(); scan.focus(); loadPts();
});
function beep(ok) {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator();
    o.frequency.value = ok ? 1400 : 300; o.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.07 : 0.25));
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 40, 80]);
  } catch (e) { /* no audio */ }
}
/* a scanned label the app does not know yet (the shop's own QR with the product written in it, a supplier barcode):
   choose the item once; the label is remembered and works from then on in orders, picking and receiving */
function teachCode(code, candidates, all) {
  return new Promise((done) => {
    const close = $('#cam-root'); if (close) close.innerHTML = '';
    const list = all.filter((i) => !i.is_service);
    const f = modal('Which item is this label?', [{ k: 'item_id', label: 'Item', type: 'select', value: candidates.length ? candidates[0].id : '',
      options: [{ v: '', t: 'Choose…' }, ...candidates.map((c) => ({ v: c.id, t: '★ ' + c.name })), ...list.filter((i) => !candidates.some((c) => c.id === i.id)).map((i) => ({ v: i.id, t: i.name }))] }],
    async (v) => {
      if (!+v.item_id) throw new Error('Choose the item.');
      try { await POST(`/api/items/${+v.item_id}/codes`, { code, pack_qty: 1 }); } catch (e) { if (e.status !== 400) throw e; }
      const it = await GET('/api/items/lookup?code=' + encodeURIComponent(code)).catch(() => list.find((i) => i.id === +v.item_id));
      done(it);
    }, { submit: 'Use this item', intro: `<p class="muted">The label says: <b>${esc(code.slice(0, 200))}</b>. ${candidates.length ? 'The items marked ★ match its words best.' : 'No item name matches its words.'} Choose it once; this label is then known everywhere.</p>` });
    const cancel = f.closest('.modal-bg'), btn = cancel && cancel.querySelector('.actions .btn:not(.primary)');
    if (btn) btn.addEventListener('click', () => done(null));
  });
}
/* a camera to scan with: any phone or computer browser that can open the camera (iPhone Safari included) */
const canCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
/* reads one frame: the browser's own BarcodeDetector where it has one (Android Chrome: QR and barcodes), else jsQR
   (iPhone and iPad Safari, Firefox: QR codes; the app prints QR labels). Loaded only when the camera is opened. */
async function codeReader() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) { const det = new window.BarcodeDetector(); return async (v) => { const c = await det.detect(v); return c.length ? c[0].rawValue : ''; }; }
    } catch (e) { /* fall back to jsQR */ }
  }
  await loadScript('/vendor/jsqr/jsQR.js');
  const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
  return async (v) => {
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return '';
    const k = Math.min(1, 800 / Math.max(w, h));
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    g.drawImage(v, 0, 0, cv.width, cv.height);
    const r = window.jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : '';
  };
}
async function cameraScan(onCode, { once = false } = {}) {
  // its own layer, so it can open over a form without replacing it
  let root = $('#cam-root');
  if (!root) { root = document.createElement('div'); root.id = 'cam-root'; document.body.appendChild(root); }
  root.innerHTML = `<div class="modal-bg"><div class="modal cam-modal"><h2>Point the camera at the QR label</h2><div class="cam-box"><video id="cv" playsinline muted autoplay></video><div class="cam-aim"></div></div>
    <p class="cam-msg" id="cmsg" aria-live="polite">Hold the label inside the square. Each piece adds one; scan the same label again for more.</p>
    <div class="actions"><button class="btn primary" id="cx">Done</button></div></div></div>`;
  let stream, stop = false, last = '', lastAt = 0;
  const close = () => { stop = true; if (stream) stream.getTracks().forEach((t) => t.stop()); root.innerHTML = ''; };
  $('#cx').onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const v = $('#cv'); v.srcObject = stream; await v.play();
    const read = await codeReader();
    const tick = async () => {
      if (stop) return;
      try {
        const code = await read(v);
        // the same label held still is read once; scanning it again needs a moment's gap
        if (code && (code !== last || Date.now() - lastAt > 1500)) {
          last = code; lastAt = Date.now();
          const ok = await onCode(code), m = $('#cmsg');
          if (m) { m.className = 'cam-msg ' + (ok ? 'pos' : 'neg'); m.textContent = ok ? `✓ ${code}` : `✗ ${code}: see the message on the screen`; }
          if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
          if (ok && once) return close();
        }
      } catch (e) { /* frame not ready */ }
      setTimeout(tick, 200);
    };
    tick();
  } catch (e) { close(); alert('Camera not available: ' + e.message + '. Allow the camera for this site in the browser settings, or type / scan the code with a barcode scanner.'); }
}
function printReceipt(d, method, received) {
  const o = d.org;
  let r = $('#receipt');
  if (!r) { r = document.createElement('div'); r.id = 'receipt'; r.className = 'receipt'; document.body.appendChild(r); }
  const P = o.print || {};
  const pv = d.points && d.points.used ? r2(d.points.used * ((o.loyalty || {}).point_value || 0)) : 0, toPay = r2(d.total - pv);
  r.innerHTML = `<div class="c">${d.logo_url ? `<img src="${esc(d.logo_url)}" alt="" style="max-height:40px;filter:grayscale(1)"><br>` : ''}<b>${esc(o.name)}</b><br>${esc(o.address || '')}${o.gstin ? `<br>GSTIN ${esc(o.gstin)}` : ''}${o.phone ? `<br>${esc(o.phone)}` : ''}</div>
    <div class="c">${esc(P.title || (o.gstin ? 'TAX INVOICE' : 'BILL'))}<br>${esc(d.number)} &middot; ${fdate(d.date)}</div>
    <table>${d.lines.map((l) => `<tr><td colspan="3">${esc(l.item || l.description)}</td></tr><tr><td>${qtyf(l.qty)} x ${inr(l.rate)}</td><td>${l.gst_rate}%</td><td class="r">${inr(l.total)}</td></tr>`).join('')}</table>
    <table><tr><td>Taxable</td><td class="r">${inr(d.taxable)}</td></tr>${d.igst ? `<tr><td>IGST</td><td class="r">${inr(d.igst)}</td></tr>` : `<tr><td>CGST</td><td class="r">${inr(d.cgst)}</td></tr><tr><td>SGST</td><td class="r">${inr(d.sgst)}</td></tr>`}
    ${d.round_off ? `<tr><td>Round off</td><td class="r">${inr(d.round_off)}</td></tr>` : ''}<tr class="g"><td>TOTAL</td><td class="r">${inr(d.total)}</td></tr>
    ${pv ? `<tr><td>Points used (${d.points.used})</td><td class="r">${inr(pv)}</td></tr>` : ''}
    <tr><td>Paid (${esc(method)})</td><td class="r">${inr(r2(d.paid - pv))}</td></tr>${method === 'cash' && received > toPay ? `<tr><td>Change</td><td class="r">${inr(received - toPay)}</td></tr>` : ''}
    ${d.balance > 0 ? `<tr><td>Balance due</td><td class="r">${inr(d.balance)}</td></tr>` : ''}</table>${pointsLine(d, 'div')}
    ${P.show_upi !== false && o.upi_id && d.balance > 0 ? `<div class="c">UPI: ${esc(o.upi_id)}</div>` : ''}<div class="c">${esc(P.footer || 'Thank you! Visit again.')}</div>`;
  document.body.classList.add('print-receipt');
  setTimeout(() => { print(); document.body.classList.remove('print-receipt'); }, 50);
}

/* ======================================================================= barcode labels */
route(/^labels\/(\d+)$/, async (el, m, q) => {
  dirty('items');
  const it = (await master('items')).find((x) => x.id === +m[1]);
  if (!it) throw new Error('Item not found.');
  const n = Math.min(200, Math.max(1, +q.get('n') || 24));
  await drawLabels(el, `Labels: ${it.name}`, Array(n).fill(it), 'item/' + it.id);
  $('.page-head', el).insertAdjacentHTML('beforeend', `<form class="row no-print" id="lf"><input name="n" type="number" min="1" max="200" value="${n}" aria-label="Number of labels" style="width:80px"><button class="btn">Update</button></form>`);
  $('#lf').onsubmit = (e) => { e.preventDefault(); go(`labels/${it.id}?n=${e.target.n.value}`); };
});

/* ======================================================================= Tally export */
route(/^tally$/, async (el) => {
  const fy = ME.today.slice(5) >= (ME.org.fy_start || '04-01') ? ME.today.slice(0, 4) : String(+ME.today.slice(0, 4) - 1);
  el.innerHTML = head('Export to Tally') + `<div class="panel"><p>Download every voucher (sales, purchases, returns, receipts, payments, expenses, journals) with the ledgers they use, as a Tally XML file.</p>
    <form class="row" id="tf"><label class="f">From<input type="date" name="from" value="${fy}-${ME.org.fy_start || '04-01'}"></label><label class="f">To<input type="date" name="to" value="${ME.today}"></label>
    <label class="f">&nbsp;<button class="btn primary">Download Tally XML</button></label></form></div>
    <div class="panel"><h2>Import in Tally Prime</h2><ol><li>Open your company in Tally.</li><li><b>Gateway of Tally → Import → Masters</b>: choose the file (creates the ledgers).</li>
    <li><b>Import → Transactions</b>: choose the same file (creates the vouchers).</li><li>Check the Trial Balance: it matches the one here.</li></ol>
    <p class="muted">Vouchers come in as accounting vouchers (no item-wise stock), so Tally's figures match this ERP exactly. Included in Starter plan and above.</p></div>`;
  $('#tf').onsubmit = (e) => { e.preventDefault(); fileDownload('/api/export/tally?' + new URLSearchParams(new FormData(e.target))); };
});

/* ======================================================================= plan & billing */
route(/^plan$/, async (el, m, q) => {
  const P = await GET('/api/plan'), cur = P.plan, u = P.usage;
  const lim = (n) => n === null ? 'Unlimited' : n;
  const daysLeft = cur.until ? Math.max(0, Math.round((new Date(cur.until + 'T00:00:00') - new Date(ME.today + 'T00:00:00')) / 864e5)) : null;
  const bar = (used, max) => max === null ? '' : `<div class="meter"><i style="width:${Math.min(100, Math.round(used / Math.max(1, max) * 100))}%"></i></div>`;
  const wa = P.support_whatsapp ? `https://api.whatsapp.com/send?phone=${encodeURIComponent(P.support_whatsapp.replace(/\D/g, ''))}&text=${encodeURIComponent(`Hi, I want to upgrade SmartTrader ERP. Business: ${ME.org.name}, login: ${ME.user.email}`)}` : '';
  const online = P.billing !== 'off', upiOn = P.billing === 'upi', cardOn = !!P.razorpay && P.razorpay !== 'off';
  el.innerHTML = head('Plan & Billing') + `
    <div class="panel planbar"><div><div class="muted">Your plan</div><div class="big">${esc(cur.label)}</div>
      <div class="muted">${cur.until ? `Valid till <b>${fdate(cur.until)}</b>${daysLeft !== null && daysLeft <= 15 ? ` · <span class="neg">${daysLeft} days left</span>` : ''}` : 'Free forever'}</div></div>
      <div class="usage"><div><span>Invoices this month</span><b>${u.invoices_this_month} / ${lim(cur.invoices_per_month)}</b>${bar(u.invoices_this_month, cur.invoices_per_month)}</div>
      <div><span>Users</span><b>${u.users} / ${lim(cur.users)}</b>${bar(u.users, cur.users)}</div>
      <div><span>Godowns</span><b>${u.warehouses} / ${lim(cur.warehouses)}</b>${bar(u.warehouses, cur.warehouses)}</div></div></div>
    <div id="paystate"></div>
    <div class="plans">${P.plans.map((p) => `<div class="plan ${p.key === cur.key ? 'cur' : ''} ${p.key === 'growth' ? 'pop' : ''}">
      ${p.key === 'growth' ? '<div class="badge b-open">Most popular</div>' : ''}<h2>${esc(p.label)}</h2>
      <div class="price">${p.price ? '₹' + p.price.toLocaleString('en-IN') + '<span>/year + GST</span>' : '₹0<span>forever</span>'}</div>
      ${p.price ? `<div class="muted small">≈ ₹${Math.round(p.price / 12)} a month · pay ₹${p.pay.toLocaleString('en-IN')} incl. GST</div>` : ''}
      <ul class="ticks"><li>${lim(p.invoices_per_month)} invoices / month</li><li>${lim(p.users)} user${p.users === 1 ? '' : 's'}</li><li>${lim(p.warehouses)} godown${p.warehouses === 1 ? '' : 's'}</li>
      <li>Billing, stock, khata, POS, accounts</li>${p.features.includes('tally') ? '<li>Tally export</li>' : ''}${p.features.includes('einvoice') ? '<li>E-invoice & e-way bill</li>' : ''}${p.features.includes('priority') ? '<li>Priority support</li>' : ''}
      <li>Grahak khud tareekh chune (vaada)${p.features.includes('vaada') ? '' : ': 10 khule vaade tak'}</li>${p.features.includes('vaada') ? '<li>Kisht + udhaar check</li>' : ''}${p.features.includes('cash') ? '<li>Kal ka Cash (4 hafte ka cash)</li>' : ''}</ul>
      ${!p.price ? (p.key === cur.key ? '<div class="muted">Your plan</div>' : '') : !ME.can.settings ? '<div class="muted">Ask the owner to upgrade</div>'
        : online ? `<button class="btn primary big" data-buy="${p.key}">${p.key === cur.key ? (P.history.some((h) => h.status === 'paid') ? 'Renew 1 year' : 'Buy 1 year') : 'Upgrade'} · Pay ₹${p.pay.toLocaleString('en-IN')}${upiOn ? ' by UPI' : ''}</button>`
          : wa ? `<a class="btn primary" target="_blank" rel="noopener" href="${wa}">Upgrade on WhatsApp</a>` : '<div class="muted">Online payment coming soon</div>'}</div>`).join('')}</div>
    <p class="muted">${upiOn ? `Pay by UPI: GPay, PhonePe, Paytm or any UPI app. The plan starts by itself after payment.${cardOn ? ' Card and netbanking also work.' : ''}`
      : 'Pay by UPI, card, netbanking or wallet. The plan starts the moment payment succeeds.'} Renewing the same plan adds a year to your current end date.</p>
    ${P.history.length ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Payments</h3></div>${table([{ h: 'Date', f: (r) => fdate((r.paid_at || r.created_at).slice(0, 10)) },
      { h: 'Plan', f: (r) => esc(r.plan) }, { h: 'Amount', num: 1, f: (r) => inr(r.amount) }, { h: 'Status', f: (r) => badge(r.status === 'paid' ? 'paid' : 'unpaid') + (r.status === 'amount_mismatch' ? ' <span class="muted">amount mismatch</span>' : '') },
      { h: 'Payment ID', k: 'payment_id', cls: 'hide-sm' }], P.history)}</div>` : ''}`;
  const state = (html) => { $('#paystate').innerHTML = html; $('#paystate').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const done = async (s) => {
    ME = await GET('/api/me');
    state(`<div class="panel okbox"><b>✓ ${esc(ME.plan.label)} plan is active</b>${s.plan_until ? ` till ${fdate(s.plan_until)}` : ''}. Thank you!${s.payment_id ? ` <span class="muted">Payment ${esc(s.payment_id)}</span>` : ''}</div>`);
    setTimeout(render, 2500);
  };
  const waitFor = async (ref) => {
    state('<div class="panel">Confirming your payment… <span class="spin"></span></div>');
    for (let i = 0; i < 45; i++) {
      const s = await GET('/api/billing/status?ref=' + ref).catch(() => null);
      if (s && s.status === 'paid') return done(s);
      if (s && s.status === 'amount_mismatch') return state(`<div class="panel err">The amount paid did not match the plan. Please contact us with payment ID ${esc(s.payment_id || '')}.</div>`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    state('<div class="panel warnbox">Payment is taking longer to confirm. If money was deducted, the plan switches on by itself within a few minutes; refresh this page later.</div>');
  };
  /* Card / netbanking (Razorpay, optional) */
  const payCard = async (o) => {
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    const rzp = new window.Razorpay({
      key: o.key_id, amount: o.amount, currency: o.currency, name: 'SmartTrader ERP', description: o.description,
      ...(o.order_id ? { order_id: o.order_id } : {}), notes: o.notes, prefill: { name: o.name || '', email: o.email || '' },
      theme: { color: '#0f766e' },
      handler: async (resp) => {
        if (o.mode === 'order') {
          try { done(await POST('/api/billing/verify', { ref: o.ref, ...resp })); } catch (e) { state(`<div class="panel err">${esc(e.message)}</div>`); }
        } else waitFor(o.ref);
      },
      modal: { ondismiss: () => toast('Payment not completed') },
    });
    rzp.on('payment.failed', (r) => state(`<div class="panel err">Payment failed: ${esc((r.error && r.error.description) || 'please try again')}.</div>`));
    rzp.open();
  };
  let stopUpi = null;   // closes the open UPI panel (stops its timers)
  const startPay = async (plan, method) => {
    if (stopUpi) stopUpi(true);
    const o = await POST('/api/billing/start', method ? { plan, method } : { plan });
    return o.method === 'upi' ? upiPanel(o) : payCard(o);
  };
  /* DocBrisk Pay: the exact amount, app buttons on a phone, a QR made on this device, and live status */
  const upiPanel = (o) => {
    const u = o.upi, ua = navigator.userAgent || '', L = u.app_links || {};
    const phone = matchMedia('(pointer: coarse)').matches, ios = /iPhone|iPad|iPod/i.test(ua), android = /Android/i.test(ua);
    const apps = ios ? [['gpay', 'GPay'], ['phonepe', 'PhonePe'], ['paytm', 'Paytm']].map(([k, t]) => [L.ios && L.ios[k], t])
      : android ? [['gpay', 'GPay'], ['phonepe', 'PhonePe'], ['paytm', 'Paytm'], ['bhim', 'BHIM']].map(([k, t]) => [L.android && L.android[k], t]) : [];
    const anyLink = L.any || u.upi_link, amt = inr(u.amount_paise / 100);
    // NPCI blocks link/app-button payments unless the payee is an online merchant; a scanned QR (or one shared to GPay) works.
    const shareOk = phone && !ios && (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'qr.png', { type: 'image/png' })] })); } catch (e) { return false; } })();
    // On a phone the buyer's own UPI app comes first, the saved QR second. For a personal UPI ID NPCI refuses link-started
    // payments, so there it is the other way round. If the buyer comes back from an app unpaid, the QR opens by itself.
    const appsFirst = u.vpa_kind === 'online';
    const appBtns = (appsFirst ? `<a class="btn primary" href="${esc(anyLink)}">Pay ${amt} with UPI</a>` : '')
      + apps.filter((x) => x[0]).map(([h, t]) => `<a class="btn" href="${esc(h)}">${t}</a>`).join('')
      + (appsFirst ? '' : `<a class="btn" href="${esc(anyLink)}">Other UPI app</a>`);
    const qrBlock = `<ol class="upisteps small"><li>Tap <b>Save QR</b> · QR सेव करें</li><li>Open GPay, PhonePe or Paytm → <b>Scan</b> → <b>gallery</b> icon</li><li>Pick the saved QR and pay <b>${amt}</b></li></ol>
        <div class="upiqr" id="upiqr"></div><button class="btn primary" id="upisave">Save QR · QR सेव करें</button>
        ${shareOk ? '<button class="btn" id="upishare">Share QR to Google Pay</button>' : ''}
        ${u.amount_paise > 200000 ? '<p class="muted small">Above ₹2,000 some UPI apps do not accept a QR from the gallery. Then scan this QR from another phone, or open this page on a computer and scan it.</p>' : ''}`;
    // Always works: every UPI app can pay to a typed UPI ID.
    const idBlock = u.vpa ? `<details class="upimore"><summary>Scan not working? Pay to a UPI ID</summary>
        <p class="small muted">Open any UPI app, choose <b>Pay to UPI ID</b>, paste the ID and pay exactly <b>${amt}</b>.</p>
        <div class="upito small"><code>${esc(u.vpa)}</code> <button class="btn sm" id="upivpacopy">Copy UPI ID</button></div></details>` : '';
    state(`<div class="panel upipay" id="upibox">
      <div class="upihead"><div><div class="muted small">Pay exactly</div><div class="upiamt">${amt}</div></div>
        <button class="btn sm" id="upiamtcopy">Copy amount</button></div>
      <p class="small">Pay this exact amount. The paise tell us it is your payment, so do not change it.</p>
      ${phone ? (appsFirst ? `<div class="upiapps">${appBtns}</div>
          <p class="muted small upimid">Tap your UPI app. It opens with ${amt} filled in. Pay, then come back here.</p>
          <div class="upimsg hidden" id="upifail">If the app showed an error or "bank limit", pay with the QR below instead. If you already paid, just wait: this page updates by itself.</div>
          <details class="upimore" id="upiqrmore"><summary>App not opening? Pay with the QR instead</summary>${qrBlock}</details>`
        : `${qrBlock}<details class="upimore"><summary>Or open a UPI app directly</summary>${appBtns ? `<div class="upiapps">${appBtns}</div>` : ''}</details>`)
        : `<div class="upiqr" id="upiqr"></div><p class="muted small upimid">Scan with any UPI app</p>`}
      ${idBlock}
      <div class="upito small">To <b>${esc(u.payee || '')}</b></div>
      <div class="muted small">Code ${esc(u.note || '')} · expires in <b id="upicd">--:--</b></div>
      <div class="upimsg" id="upimsg"></div>
      <div class="upibtns"><button class="btn primary" id="upipaid">I have paid</button>${o.razorpay ? '<button class="btn" id="upicard">Card / netbanking</button>' : ''}<button class="btn" id="upiclose">Cancel</button></div>
      <details class="upimore" id="upiref"><summary>Paid but plan not active?</summary>
        <p class="small muted">Enter the 12-digit UPI Ref No. from your UPI app. GPay: "UPI transaction ID". PhonePe: "UTR". Paytm: "UPI Ref No".</p>
        <div class="upirefrow"><input id="upirrn" inputmode="numeric" autocomplete="off" maxlength="16" placeholder="12-digit UPI Ref No."><button class="btn primary" id="upirefgo">Check</button></div>
        <div class="small" id="upirefmsg"></div></details>
    </div>`);
    const box = $('#upibox'), t0 = Date.now(), off = (+u.server_time || Date.now()) - Date.now();
    let alive = true, timer = 0, busy = false, fast = false, hubState = '', shown = '';
    const left = () => (+u.expires_at || 0) - (Date.now() + off);
    const openRef = () => { const d = $('#upiref'); if (d && !d.open) d.open = true; };
    const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(what + ' copied'); } catch (e) { prompt(what + ':', text); } };
    $('#upiamtcopy').onclick = () => copy(String(u.amount), 'Amount');
    if ($('#upivpacopy')) $('#upivpacopy').onclick = () => copy(String(u.vpa || ''), 'UPI ID');
    let png = '';
    import('/vendor/qrcode.mjs').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M'); qr.addData(u.qr_text); qr.make();
      const q = $('#upiqr'); if (q) q.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      // A PNG with the amount under it, so it can be saved and picked from the gallery in a UPI app.
      try {
        const n = qr.getModuleCount(), S = 14, Q = 4, W = (n + Q * 2) * S, c = document.createElement('canvas'), x = c.getContext('2d');
        c.width = W; c.height = W + 70; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
        for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) x.fillRect((k + Q) * S, (r + Q) * S, S, S);
        x.font = 'bold 34px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText('Pay ' + amt + ' · ' + (u.payee || 'DocBrisk'), W / 2, W + 40);
        png = c.toDataURL('image/png');
        if (q && phone) q.innerHTML = `<img alt="UPI QR" src="${png}" style="width:240px;max-width:100%;border-radius:8px">`;
      } catch (e) { /* the SVG stays */ }
    }).catch(() => { const q = $('#upiqr'); if (q) q.innerHTML = '<p class="muted small">QR could not load. Please reload the page.</p>'; });
    const saveQr = (btn, share) => async () => {
      fast = true;
      if (!png) return toast('Press and hold the QR to save it');
      const name = 'erp-pay-' + String(u.amount) + '.png';
      let f = null;
      try {
        const bin = atob(png.split(',')[1]), arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        f = new File([arr], name, { type: 'image/png' });
      } catch (e) { f = null; }
      // Share: GPay on Android takes the image in; iPhone's share sheet has "Save Image". No await before share().
      if (f && (share || ios) && navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f] }); if (!share) btn.textContent = 'Saved ✓ Now open your UPI app → Scan → Gallery'; return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const a = document.createElement('a'); a.href = png; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      btn.textContent = 'Saved ✓ Now open your UPI app → Scan → Gallery';
    };
    let tapAt = 0, failShown = false;
    box.addEventListener('click', (e) => { if (e.target.closest('.upiapps a')) { fast = true; tapAt = Date.now(); } });
    const onBack = () => {
      if (!alive || !tapAt || failShown || document.hidden || Date.now() - tapAt < 2500 || hubState) return;
      failShown = true;
      const f = $('#upifail'), d = $('#upiqrmore');
      if (f) f.classList.remove('hidden');
      if (d) d.open = true;
    };
    document.addEventListener('visibilitychange', onBack); window.addEventListener('focus', onBack); window.addEventListener('pageshow', onBack);
    const sv = $('#upisave'), sh = $('#upishare');
    if (sv) sv.onclick = saveQr(sv, false);
    if (sh) sh.onclick = saveQr(sh, true);
    const say = () => {
      const age = Date.now() - t0, gone = left() <= 0;
      const k = hubState === 'review' ? 'review' : hubState === 'activating' ? 'act' : age > 3600000 ? 'late' : gone ? 'gone' : age < 120000 ? 'wait' : 'slow';
      if (k === shown) return;
      shown = k;
      const m = $('#upimsg'); if (!m) return;
      m.innerHTML = {
        review: 'Payment found. We are checking it. Your plan starts soon.',
        act: '<span class="spin"></span> Payment received. Starting your plan…',
        wait: '<span class="spin"></span> Waiting for your payment… This page updates by itself.',
        slow: '<span class="spin"></span> Banks sometimes take a few minutes. You can close this page. Your plan starts by itself.',
        gone: 'This payment code has expired. Already paid? Enter the UPI Ref below. <button class="btn sm primary" id="upinew">Get a new code</button>',
        late: 'Still waiting. If you paid, the plan starts by itself when the bank confirms. Check this page later.',
      }[k];
      if (k === 'gone' || k === 'late') openRef();
      const nb = $('#upinew'); if (nb) nb.onclick = () => startPay(o.plan).catch((e) => toast(e.message, 'err'));
    };
    const tick = () => {
      if (!box.isConnected) return stop(false);
      const ms = Math.max(0, left()), cd = $('#upicd');
      if (cd) cd.textContent = ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : 'expired';
      if (Date.now() - t0 > 15 * 60000) openRef();
      say();
    };
    const gap = () => { const a = Date.now() - t0; return fast || a < 180000 ? 3000 : a < 900000 ? 6000 : 30000; };
    const poll = async () => {
      if (!alive || busy) return;
      clearTimeout(timer);
      if (!box.isConnected) return stop(false);
      if (Date.now() - t0 > 3600000) return say();       // after an hour: stop asking; the plan still starts by itself
      if (document.hidden) return;                          // paused; visibilitychange polls again
      busy = true;
      let s = null;
      try { s = await GET('/api/billing/status?ref=' + o.ref); } catch (e) { s = null; } finally { busy = false; }
      if (!alive) return;
      if (s && s.status === 'paid') { stop(false); return done(s); }
      if (s && s.status === 'amount_mismatch') { stop(false); return state(`<div class="panel err">The amount paid did not match the plan. Please contact us with payment ID ${esc(s.payment_id || '')}.</div>`); }
      if (s && s.hub && s.hub.status) hubState = s.hub.status === 'paid' ? 'activating' : s.hub.status;
      say();
      timer = setTimeout(poll, gap());
    };
    const onVis = () => { if (!document.hidden) poll(); };
    const cdTimer = setInterval(tick, 1000);
    const stop = (cancel) => {
      if (!alive) return;
      alive = false; clearTimeout(timer); clearInterval(cdTimer); document.removeEventListener('visibilitychange', onVis); document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); window.removeEventListener('pageshow', onBack);
      if (stopUpi === stop) stopUpi = null;
      if (cancel) POST('/api/billing/upi-cancel', { ref: o.ref }).catch(() => {});
    };
    stopUpi = stop;
    document.addEventListener('visibilitychange', onVis);
    $('#upipaid').onclick = () => { fast = true; openRef(); toast('Thanks! Checking your payment…'); poll(); };
    $('#upiclose').onclick = () => { stop(true); $('#paystate').innerHTML = ''; toast('Payment closed'); };
    if ($('#upicard')) $('#upicard').onclick = () => startPay(o.plan, 'razorpay').catch((e) => toast(e.message, 'err'));
    $('#upirefgo').onclick = async (ev) => {
      const rrn = $('#upirrn').value.replace(/\D/g, ''), out = $('#upirefmsg'), btn = ev.currentTarget;
      if (rrn.length !== 12) { out.innerHTML = '<span class="neg">Enter the 12-digit number.</span>'; return; }
      btn.disabled = true;
      try {
        const r = await POST('/api/billing/upi-claim', { ref: o.ref, rrn });
        out.innerHTML = r.status === 'underpaid'
          ? `<span class="neg">You paid ${inr(r.paid)}, but the price is ${inr(r.price)}.</span> ${wa ? `<a target="_blank" rel="noopener" href="${wa}">Message us on WhatsApp</a> for the rest or a refund.` : 'Please contact us for the rest or a refund.'}`
          : esc({ paid: 'Payment found. Starting your plan…', review: 'Payment found. We are checking it. Your plan starts soon.',
            waiting: 'Saved. Your plan starts by itself when your bank confirms. You can close this page.',
            not_found: 'This UPI Ref does not match this payment. Please check the number.', invalid: 'Enter the 12-digit UPI Ref No. from your UPI app.' }[r.status] || 'Saved.');
        if (r.status === 'paid' || r.status === 'review') { hubState = r.status === 'paid' ? 'activating' : 'review'; fast = true; say(); poll(); }
      } catch (e) { out.innerHTML = `<span class="neg">${esc(e.message)}</span>`; } finally { btn.disabled = false; }
    };
    tick();
    timer = setTimeout(poll, 3000);
  };
  $$('[data-buy]', el).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await startPay(b.dataset.buy); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
  });
});

/* ======================================================================= admin (owner of this deployment) */
async function adminPage(el) {
  const again = () => adminPage(el);
  let key = '';
  try { key = sessionStorage.getItem('st-admin') || ''; } catch (e) { /* storage blocked */ }
  const call = async (method, path, body) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'X-Admin-Key': key }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'Failed', res.status);
    return data;
  };
  const ask = () => modal('Admin key', [{ k: 'key', label: 'ADMIN_KEY (from the worker secrets)', type: 'password', wide: true }], async (v) => {
    key = v.key; try { sessionStorage.setItem('st-admin', key); } catch (e) { /* ignore */ }
    again();
  });
  if (!key) { el.innerHTML = head('Admin') + '<div class="panel">Enter your admin key to manage businesses and plans.</div>'; ask(); return; }
  let data;
  try { data = await call('GET', '/api/admin/orgs'); } catch (e) {
    try { sessionStorage.removeItem('st-admin'); } catch (x) { /* ignore */ }
    el.innerHTML = head('Admin') + `<div class="err">${esc(e.message)}</div>`; if (e.status === 401) ask(); return;
  }
  const pays = await call('GET', '/api/admin/payments').catch(() => ({ rows: [], mode: '?' }));
  const cfg = await call('GET', '/api/admin/config').catch(() => null);
  const keyNote = !cfg ? '' : !cfg.session_secret
    ? `<div class="panel warnbox"><b>SESSION_SECRET is not set.</b> Sign-ins and the sealed two-step and Google Drive secrets use a key kept in the database, so anyone who could read the database could sign in as any user. Add a secret <b>SESSION_SECRET</b> (any long random text) in the worker's Settings → Variables and Secrets. Everyone signs in once more; two-step sign-in and Google Drive backups keep working.</div>`
    : `<div class="panel">Session secret: <b>set</b>.${cfg.database_key ? ' An older key is still kept in the database: two-step and Google Drive secrets sealed with it are sealed again with the new one the first time they are used.' : ''}</div>`;
  el.innerHTML = head('Admin: businesses', `<button class="btn" id="lock">Lock</button>`) + keyNote + `
    <div class="panel ${pays.mode === 'off' ? 'warnbox' : ''}">Online payments: <b>${pays.mode === 'upi' ? 'on (DocBrisk Pay, automatic UPI)' : pays.mode === 'order' ? 'on (Razorpay order + signature)' : pays.mode === 'webhook' ? 'on (Razorpay webhook)' : 'OFF: set PAYHUB_URL and the PAYHUB_SECRET secret (DocBrisk Pay) on the worker'}</b>.
      ${pays.mode === 'upi' ? `Card (Razorpay): <b>${pays.razorpay && pays.razorpay !== 'off' ? 'on' : 'off'}</b>.` : ''}
      Paid: ${inr(pays.rows.filter((r) => r.status === 'paid').reduce((t, r) => t + r.amount, 0))} from ${pays.rows.filter((r) => r.status === 'paid').length} payment(s).</div>
    <div class="kpis"><div class="kpi"><div class="l">Businesses</div><div class="v">${data.rows.length}</div></div>
      ${['free', 'starter', 'growth', 'business'].map((k) => `<div class="kpi"><div class="l">${k}</div><div class="v">${data.rows.filter((o) => o.effective === k).length}</div></div>`).join('')}</div>
    <div class="panel flush">${table([{ h: 'Business', f: (o) => `<b>${esc(o.name)}</b><div class="muted">${esc(o.owner || '')} ${esc(o.phone || '')}</div>` },
      { h: 'Plan', f: (o) => `${badge(o.effective)}${o.plan_until ? `<div class="muted">till ${fdate(o.plan_until)}</div>` : ''}` }, { h: 'Users', k: 'users', num: 1 }, { h: 'Invoices', k: 'invoices', num: 1 },
      { h: 'Joined', f: (o) => fdate(o.created_at.slice(0, 10)), cls: 'hide-sm' }, { h: 'Last active', f: (o) => o.last_active ? fdate(o.last_active.slice(0, 10)) : '', cls: 'hide-sm' },
      { h: '', f: (o) => `<button class="btn sm" data-o="${o.id}">Set plan</button>` }], data.rows, { empty: 'No businesses yet.' })}</div>`;
  const planOpts = data.plans.map((p) => ({ v: p, t: p }));
  $$('[data-o]', el).forEach((b) => b.onclick = () => modal('Set plan', [{ k: 'plan', label: 'Plan', type: 'select', options: planOpts, value: 'growth' },
    { k: 'months', label: 'Months (1200 = lifetime)', type: 'number', value: 12 }], async (v) => { await call('POST', `/api/admin/orgs/${b.dataset.o}/plan`, v); toast('Plan updated'); again(); }));
  $('#lock').onclick = () => { try { sessionStorage.removeItem('st-admin'); } catch (e) { /* ignore */ } if (ME) go('dashboard'); else location.href = '/'; };
  // data checks: every count should be 0 (they read whole tables, so they run only on request)
  el.insertAdjacentHTML('beforeend', `<div class="panel" id="integ"><h3>Data checks</h3><p class="muted small">Looks for lines whose document is gone, links to another business's records and journals that do not balance. Every count should be 0.</p><button class="btn" id="integRun">Run data checks</button><div id="integOut"></div></div>`);
  $('#integRun').onclick = async () => {
    const out = $('#integOut'); out.innerHTML = '<p class="muted small">Checking…</p>';
    try {
      const r = await call('GET', '/api/admin/integrity');
      out.innerHTML = `<p>${r.ok ? '<b>All clear.</b> Nothing out of place.' : '<b class="err">Some records are out of place.</b> Send this to support.'}</p>` +
        table([{ h: 'Check', k: 'label' }, { h: 'Count', num: 1, f: (x) => x.count ? `<b class="err">${x.count}</b>` : '0' }], r.checks);
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  el.insertAdjacentHTML('beforeend', `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Payments</h3></div>${table([
    { h: 'When', f: (r) => fdate((r.paid_at || r.created_at).slice(0, 10)) }, { h: 'Business', f: (r) => `${esc(r.business)}<div class="muted">${esc(r.email || '')}</div>` },
    { h: 'Plan', k: 'plan' }, { h: 'Amount', num: 1, f: (r) => inr(r.amount) }, { h: 'Status', f: (r) => badge(r.status === 'paid' ? 'paid' : 'unpaid') }, { h: 'Payment ID', k: 'payment_id', cls: 'hide-sm' }],
    pays.rows, { empty: 'No payments yet.' })}</div>`);
}
route(/^admin$/, adminPage);

/* ======================================================================= PWA: service worker + install button */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; const b = $('#install'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; lsSet('st_installed', '1'); const b = $('#install'); if (b) b.hidden = true; toast('SmartTrader installed'); });
function wireInstall() {
  const b = $('#install');
  if (!b) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  b.hidden = standalone || !(installEvt || ios);
  b.onclick = async () => {
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; b.hidden = true; }
    else alert('On iPhone/iPad: tap the Share button in Safari, then "Add to Home Screen".');
  };
}
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
window.addEventListener('offline', () => toast('You are offline. New bills, receipts and expenses are saved on this device and sent later.', 'info'));
window.addEventListener('online', () => { toast('Back online'); syncOutbox(); });
setInterval(() => { if (navigator.onLine) syncOutbox(); }, 60000);

/* ======================================================================= boot */
async function boot() {
  await startHindi();
  // customer links, no login: /k/<token> khata statement, /i/<token> invoice (old #/k/ links still work)
  const pk = location.pathname.match(/^\/k\/([0-9a-f]{24})\/?$/) || location.hash.match(/^#\/k\/([0-9a-f]{24})$/);
  if (pk) return publicKhata(pk[1]);
  const pi = location.pathname.match(/^\/i\/([0-9a-f]{24})\/?$/);
  if (pi) return publicDoc(pi[1]);
  const pc = location.pathname.match(/^\/c\/([0-9a-f]{24})\/?$/);
  if (pc) return publicConfirm(pc[1]);
  const ps = location.pathname.match(/^\/s\/([0-9a-f]{24})\/?$/);       // the online catalogue
  if (ps) return publicShop(ps[1]);
  const rt = location.hash.match(/^#\/reset\/([0-9a-f]{64})$/);   // link from the forgot-password e-mail
  if (rt) return renderReset(rt[1]);
  const vt = location.hash.match(/^#\/verify\/([0-9a-f]{64})$/);  // link from the sign-up e-mail
  if (vt) return renderVerify(vt[1]);
  try { ME = await GET('/api/me'); } catch (e) {
    if (e.status === 401 && /^#\/admin/.test(location.hash)) {   // admin works with the ADMIN_KEY alone
      $('#app').innerHTML = '<main class="page" id="page"></main>';
      return adminPage($('#page'));
    }
    if (e.status === 401) return;
    const off = !navigator.onLine || e instanceof TypeError;
    $('#app').innerHTML = `<div class="boot"><h2>${off ? 'You are offline' : 'Could not load SmartTrader'}</h2>
      <p class="muted">${off ? 'Your business data lives safely in the cloud. Connect to the internet to continue.' : esc(e.message)}</p>
      <button class="btn primary" data-act="reload">Try again</button></div>`;
    if (off) window.addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  if (ME._offline) ME.today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (ME.must_2fa) return twoStepGate();
  // open on the user's own start screen (a link to a particular page still opens that page)
  if (/^(#\/?(dashboard)?)?$/.test(location.hash) && myHome() !== 'dashboard') history.replaceState(null, '', '/#/' + myHome());
  shell();
  wireInstall();
  outboxBadge(); syncOutbox();
  setTimeout(() => folderBackup(), 15000);
  await render();
}
window.addEventListener('hashchange', () => {
  // not signed in: the home page's Sign in / Start free links open the forms, and Back returns to the home page
  if (!ME && !/^#\/(admin|reset|verify|k\/)/.test(location.hash)) {
    if (/^#\/?(login|signup)/.test(location.hash)) return renderAuth();
    if (bareHome() && LANDING) { $('#app').innerHTML = LANDING; return; }
  }
  $('#modal-root').innerHTML = '';
  if ($('#cam-root #cx')) $('#cam-root #cx').click();      // a camera left open stops
  ['#gres', '#newmenu'].forEach((x) => { const e = $(x); if (e) e.hidden = true; });
  render();
});
boot();
