/* SmartTrader Cloud ERP - web app (no build step, no framework).
   Hash routes (#/sales/INV, #/doc/12 ...) render pages from the JSON API in src/worker.js. */

/* ======================================================================= helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n < 0 ? '−' : '') + '₹' + Math.abs(Number(n || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = (n) => (n < 0 ? '−' : '') + '₹' + Math.abs(Number(n || 0)).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const qtyf = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fdate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
const r2 = (x) => Math.round(x * 100) / 100;

const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Other Territory'];
document.body.insertAdjacentHTML('beforeend', `<datalist id="states">${STATES.map((x) => `<option value="${x}">`).join('')}</datalist>`);

let ME = null;                  // { user, org, can, doc_types, gst_rates, today }
const cache = {};               // masters used by forms; cleared after writes

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && !path.startsWith('/api/auth')) { ME = null; renderAuth(); throw new ApiError('Please sign in.', 401); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);
async function master(name) {
  if (!cache[name]) cache[name] = (await GET('/api/' + name)).rows;
  return cache[name];
}
const dirty = (...names) => names.forEach((n) => delete cache[n]);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function table(cols, rows, { onRow, foot, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const th = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.h}</th>`).join('');
  const tr = rows.map((r, i) => `<tr ${onRow ? `class="click" data-i="${i}"` : ''}>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('');
  const tf = foot ? `<tfoot><tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${foot[c.k] ?? ''}</td>`).join('')}</tr></tfoot>` : '';
  return `<div class="tbl-wrap"><table class="t"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${tf}</table></div>`;
}
function bindRows(el, rows, fn) {
  $$('tr.click', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) fn(rows[+tr.dataset.i]); }));
}
function toCsv(cols, rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.map((c) => cell(c.h)).join(','), ...rows.map((r) => cols.map((c) => cell(c.csv ? c.csv(r) : r[c.k])).join(','))].join('\n');
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
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
  root.innerHTML = `<div class="modal-bg"><form class="modal" novalidate>
      <h2>${esc(title)}</h2>${intro}<div class="err" hidden></div>
      <div class="form">${fields.map((f) => `<label class="f ${f.wide ? 'wide' : ''}">${esc(f.label)}${input(f)}</label>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(submit)}</button></div>
    </form></div>`;
  const form = $('form', root), close = () => { root.innerHTML = ''; };
  $('[data-x]', root).onclick = close;
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  const first = $('input,select,textarea', form); if (first) first.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.k];
      vals[f.k] = f.type === 'checkbox' ? el.checked : el.value;
    }
    const btn = $('button.primary', form); btn.disabled = true;
    try { await onSubmit(vals, form); close(); } catch (err) {
      const box = $('.err', form); box.hidden = false; box.textContent = err.message;
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
      <h1>${mode === 'login' ? 'Sign in' : 'Create your business account'}</h1>
      <div class="err" hidden></div>
      ${mode === 'signup' ? `
        <label class="f">Business name<input name="business" required></label>
        <label class="f">Your name<input name="name" required></label>
        <div class="row"><label class="f grow">State<input name="state" list="states" autocomplete="off" placeholder="e.g. Rajasthan" required></label>
        <label class="f grow">GSTIN (optional)<input name="gstin" maxlength="15"></label></div>` : ''}
      <label class="f">Email<input name="email" type="email" autocomplete="email" required></label>
      <label class="f">Password<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8"></label>
      <button class="btn primary">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <p class="muted">${mode === 'login' ? `New here? <a href="#" data-m="signup">Create a free account</a>` : `Already have an account? <a href="#" data-m="login">Sign in</a>`}</p>
    </form></div></div>`;
  $('[data-m]').onclick = (e) => { e.preventDefault(); renderAuth(e.target.dataset.m); };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = $('button', e.target); btn.disabled = true;
    try {
      await POST('/api/auth/' + mode, body);
      if (/^#\/?(signup|login)/.test(location.hash)) history.replaceState(null, '', '/#/dashboard');
      await boot();
    } catch (err) { const b = $('.err', e.target); b.hidden = false; b.textContent = err.message; } finally { btn.disabled = false; }
  };
}

/* ======================================================================= shell & router */
/* Modules most small shops do not need. Simple mode (the default) hides them; Settings → Advanced shows them.
   Nothing is deleted: the screens and data stay, only the menu and buttons change. */
const ADVANCED = new Set(['sales/SO', 'sales/DN', 'sales/QUOTE', 'purchase/PO', 'gate/in', 'purchase/GRN', 'gate/out', 'stockcount', 'pending']);
const ADV_DOCS = ['QUOTE', 'SO', 'DN', 'PO', 'GRN'];
const simple = () => !ME || (ME.org.mode || 'simple') !== 'advanced';
const NAV = [
  ['', [['dashboard', 'Dashboard']]],
  ['Sales', [['pos', 'Quick Bill (POS)'], ['sales/INV', 'Invoices'], ['sales/SO', 'Sales Orders'], ['sales/DN', 'Delivery Notes'], ['sales/QUOTE', 'Quotations'], ['sales/SRET', 'Sales Returns'], ['sales/CNOTE', 'Credit Notes (rate diff)'], ['receipts', 'Receipts']]],
  ['Purchase', [['purchase/PO', 'Purchase Orders'], ['gate/in', 'Gate Entry (inward)'], ['purchase/GRN', 'Goods Receipts (GRN)'], ['purchase/BILL', 'Purchase Bills'], ['purchase/PRET', 'Purchase Returns'], ['purchase/DNOTE', 'Debit Notes (rate diff)'], ['payments', 'Payments']]],
  ['Inventory', [['items', 'Items'], ['stock', 'Stock & Godowns'], ['stockcount', 'Stock Count'], ['gate/out', 'Gate Pass (outward)'], ['pending', 'Pending Orders']]],
  ['Contacts', [['parties', 'Customers & Suppliers'], ['khata', 'Khata Book'], ['reminders', 'Payment Reminders']]],
  ['Accounts', [['expenses', 'Expenses'], ['accounts', 'Chart of Accounts'], ['journal', 'Journal Voucher'], ['daybook', 'Day Book']]],
  ['Reports', [['reports/pnl', 'Profit & Loss'], ['reports/balance-sheet', 'Balance Sheet'], ['reports/trial-balance', 'Trial Balance'], ['reports/gst', 'GST Summary'], ['reports/ageing', 'Outstanding (Ageing)'], ['reports/register', 'Registers'], ['tally', 'Tally Export']]],
  ['Settings', [['settings', 'Settings'], ['plan', 'Plan & Billing']]],
];

function shell() {
  $('#app').innerHTML = `<div class="shell">
    <nav class="side" id="side">
      <div class="brand"><i>&#x2197;</i>SmartTrader</div>
      ${NAV.map(([g, all]) => { const items = all.filter(([h]) => !simple() || !ADVANCED.has(h)); return items.length ? `${g ? `<div class="nav-group">${g}</div>` : ''}${items.map(([h, t]) => `<a href="#/${h}" data-h="${h}">${t}</a>`).join('')}` : ''; }).join('')}
    </nav>
    <div class="main">
      <header class="top">
        <button class="btn sm burger" id="burger" aria-label="Menu">&#9776;</button>
        <strong>${esc(ME.org.name)}</strong><span class="spacer" style="flex:1"></span>
        <span class="who hide-sm">${esc(ME.user.name)} &middot; ${esc(ME.user.role)}</span>
        <button class="btn sm" id="install" hidden>Install app</button>
        <button class="btn sm" id="logout">Sign out</button>
      </header>
      <main class="page" id="page"></main>
    </div></div>`;
  $('#burger').onclick = () => $('#side').classList.toggle('open');
  $('#logout').onclick = async () => { await POST('/api/auth/logout'); ME = null; location.hash = ''; renderAuth(); };
}

const ROUTES = [];
const route = (re, fn) => ROUTES.push([re, fn]);

async function render() {
  if (!ME) return;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = hash.split('?');
  const q = new URLSearchParams(qs || '');
  $$('.side a').forEach((a) => a.classList.toggle('on', path === a.dataset.h || (path.startsWith(a.dataset.h + '/') && a.dataset.h !== '')));
  $('#side').classList.remove('open');
  const page = $('#page');
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    page.innerHTML = '<div class="muted">Loading&hellip;</div>';
    try { await fn(page, m, q); const tab = $('.tabs a.on', page); if (tab && tab.parentNode.scrollWidth > tab.parentNode.clientWidth) tab.parentNode.scrollLeft = tab.offsetLeft - 16; } catch (e) {
      if (e.status !== 401) page.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  page.innerHTML = '<div class="empty">Page not found.</div>';
}
const go = (h) => { location.hash = '#/' + h; };
const head = (title, actions = '') => `<div class="page-head"><h1>${title}</h1><span class="spacer"></span>${actions}</div>`;

/* ======================================================================= dashboard */
route(/^dashboard$/, async (el) => {
  const d = await GET('/api/reports/dashboard');
  const max = Math.max(1, ...d.monthly.map((m) => Math.max(m.sales, m.purchases)));
  const W = 720, H = 190, bw = W / d.monthly.length;
  const bars = d.monthly.map((m, i) => {
    const hs = m.sales / max * (H - 30), hp = m.purchases / max * (H - 30), x = i * bw;
    return `<rect x="${x + bw * 0.15}" y="${H - 20 - hs}" width="${bw * 0.33}" height="${hs}" fill="var(--brand)" rx="2"><title>Sales ${m.month}: ${inr0(m.sales)}</title></rect>
      <rect x="${x + bw * 0.5}" y="${H - 20 - hp}" width="${bw * 0.33}" height="${hp}" fill="#94a3b8" rx="2"><title>Purchases ${m.month}: ${inr0(m.purchases)}</title></rect>
      <text x="${x + bw / 2}" y="${H - 5}" font-size="10" text-anchor="middle" fill="var(--muted)">${new Date(m.month + '-01').toLocaleString('en-IN', { month: 'short' })}</text>`;
  }).join('');
  el.innerHTML = head('Dashboard', `<a class="btn" href="#/new/BILL">+ Purchase bill</a><a class="btn primary" href="#/new/INV">+ New invoice</a>`) + `
    <div class="kpis">
      <div class="kpi"><div class="l">Sales this month</div><div class="v">${inr0(d.sales_month)}</div><div class="s">FY: ${inr0(d.sales_fy)} &middot; ${d.invoices_fy} invoices</div></div>
      <div class="kpi"><div class="l">Gross profit (FY)</div><div class="v">${inr0(d.gross_profit_fy)}</div><div class="s">Margin ${d.gross_margin}% &middot; Net ${inr0(d.net_profit_fy)}</div></div>
      <div class="kpi"><div class="l">To receive</div><div class="v pos">${inr0(d.receivable)}</div><div class="s"><a href="#/reports/ageing">${d.overdue.length} overdue</a></div></div>
      <div class="kpi"><div class="l">To pay</div><div class="v neg">${inr0(d.payable)}</div><div class="s"><a href="#/reports/ageing?kind=payable">Payables</a></div></div>
      <div class="kpi"><div class="l">Stock value</div><div class="v">${inr0(d.stock_value)}</div><div class="s"><a href="#/stock">${d.reorder_count} items to reorder</a></div></div>
      <div class="kpi"><div class="l">GST payable (net)</div><div class="v">${inr0(d.gst_payable)}</div><div class="s"><a href="#/reports/gst">GST summary</a></div></div>
    </div>
    <div class="grid g2">
      <div class="panel"><h3>Sales vs purchases, last 12 months</h3>
        <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
        <div class="legend"><span><i style="background:var(--brand)"></i>Sales</span><span><i style="background:#94a3b8"></i>Purchases</span></div></div>
      <div class="panel"><h3>Cash &amp; bank</h3>${table([{ h: 'Account', k: 'name' }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }], d.cash)}
        <div class="row" style="margin-top:12px"><a class="btn sm" href="#/receipts?new=1">Receive money</a><a class="btn sm" href="#/payments?new=1">Pay supplier</a><a class="btn sm" href="#/expenses?new=1">Add expense</a></div></div>
      <div class="panel flush"><div style="padding:14px 16px 0"><h3>Overdue invoices</h3></div>${table([
        { h: 'Invoice', f: (r) => `<a href="#/doc/${r.id}">${esc(r.number)}</a>` }, { h: 'Customer', k: 'party' }, { h: 'Due', f: (r) => fdate(r.due_date) }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }],
        d.overdue, { empty: 'No overdue invoices.' })}</div>
      <div class="panel flush"><div style="padding:14px 16px 0"><h3>Low stock</h3></div>${table([
        { h: 'Item', k: 'name' }, { h: 'In stock', num: 1, f: (r) => qtyf(r.qty) + ' ' + esc(r.unit) }, { h: 'Reorder at', num: 1, f: (r) => qtyf(r.reorder_level) }, { h: '', f: (r) => badge(r.status) }],
        d.low_stock, { empty: 'All items are above their reorder level.' })}</div>
    </div>
    <div class="panel flush"><div style="padding:14px 16px 0"><h3>Recent documents</h3></div>${table([
      { h: 'Number', f: (r) => `<a href="#/doc/${r.id}">${esc(r.number)}</a>` }, { h: 'Type', f: (r) => esc(ME.doc_types[r.type].label) }, { h: 'Party', k: 'party' },
      { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Total', num: 1, f: (r) => inr(r.total) }, { h: 'Status', f: (r) => badge(r.status) }], d.recent, { empty: 'Create your first invoice or purchase to get started.' })}</div>`;
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
    <div class="panel"><form class="row" id="flt">
      <input name="q" placeholder="Search number or party" value="${esc(q.get('q') || '')}" style="max-width:260px">
      <select name="status" style="max-width:160px"><option value="">All statuses</option>${['open', 'partial', 'closed', 'unpaid', 'paid', 'converted', 'cancelled'].map((s) => `<option ${q.get('status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <input type="date" name="from" value="${esc(q.get('from') || '')}" style="max-width:160px"><input type="date" name="to" value="${esc(q.get('to') || '')}" style="max-width:160px">
      ${cfF.map((f) => f.type === 'select' ? `<select name="cf.${f.key}" style="max-width:160px"><option value="">${esc(f.label)}: all</option>${f.options.map((o) => `<option ${q.get('cf.' + f.key) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input name="cf.${f.key}" placeholder="${esc(f.label)}" value="${esc(q.get('cf.' + f.key) || '')}" style="max-width:160px">`).join('')}
      <button class="btn">Filter</button></form>
      ${!make ? `<p class="muted" style="margin:10px 0 0">To make a ${esc(T.label.toLowerCase())}, open the original ${type === 'SRET' ? 'invoice' : 'bill'} and choose <b>Return goods</b>.</p>` : ''}
      ${ME.doc_types[type].note ? `<p class="muted" style="margin:10px 0 0">Tip: open the ${T.side === 'sales' ? 'invoice' : 'bill'} and choose <b>${T.side === 'sales' ? 'Credit note' : 'Debit note'}</b> to adjust it line by line; it is then settled against that ${T.side === 'sales' ? 'invoice' : 'bill'}.</p>` : ''}</div>
    <div class="panel flush">${table(cols, rows, { onRow: true, empty: `No ${esc(T.label.toLowerCase())}s yet.` })}</div>`;
  bindRows(el, rows, (r) => go('doc/' + r.id));
  $('#flt').onsubmit = (e) => { e.preventDefault(); const f = new URLSearchParams(new FormData(e.target)); go(`${m[1]}/${type}?${f}`); };
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
  if (q.get('from')) draft = { ...draft, ...(await GET(`/api/docs/${q.get('from')}/convert?to=${type}`)) };
  // purchase order for everything at or below its reorder level
  if (q.get('reorder') && type === 'PO') {
    const low = (await GET('/api/reports/stock')).rows.filter((r) => r.suggested_order > 0);
    if (low.length) draft.lines = low.map((r) => { const it = items.find((i) => i.id === r.id) || {}; return { item_id: r.id, qty: r.suggested_order, rate: it.purchase_price || r.avg_cost, gst_rate: it.gst_rate }; });
  }
  const fromDoc = !!draft.ref_id;
  const isNote = !!T.note;
  const isSale = T.side === 'sales', money = ['INV', 'BILL'].includes(type);
  const itemOpt = (sel) => `<option value="">— free text / service —</option>` + items.map((i) => `<option value="${i.id}" ${+sel === i.id ? 'selected' : ''}>${esc(i.name)}${i.is_service ? '' : ` (${qtyf(i.qty_on_hand)} ${esc(i.unit)})`}</option>`).join('');
  const gstOpt = (sel) => ME.gst_rates.map((g) => `<option value="${g}" ${+sel === g ? 'selected' : ''}>${g}%</option>`).join('');
  const lineRow = (l) => `<tr>
      <td class="c-item">${fromDoc ? `<b>${esc(l.item || l.description)}</b>${isNote && l.orig_rate !== undefined ? `<div class="muted">billed at ${inr(l.orig_rate)}</div>` : ''}<input type="hidden" name="item_id" value="${esc(l.item_id || '')}"><input type="hidden" name="src_line_id" value="${esc(l.src_line_id || '')}"><input type="hidden" name="description" value="${esc(l.description || '')}">`
        : `<select name="item_id">${itemOpt(l.item_id)}</select><input name="description" placeholder="Description" value="${esc(l.description || '')}" style="margin-top:4px">`}</td>
      <td class="c-n"><input name="qty" type="number" step="any" min="0" value="${esc(l.qty ?? 1)}"></td>
      <td class="c-n"><input name="rate" type="number" step="any" min="0" value="${esc(l.rate ?? '')}"></td>
      <td class="c-n"><input name="discount_pct" type="number" step="any" min="0" max="100" value="${esc(l.discount_pct ?? 0)}"></td>
      <td class="c-n"><select name="gst_rate">${gstOpt(l.gst_rate ?? 0)}</select></td>
      <td class="num" data-amt></td>
      <td>${fromDoc && !isNote && ['SRET', 'PRET'].includes(type) ? '' : '<button type="button" class="btn sm danger" data-del>&times;</button>'}</td></tr>`;
  el.innerHTML = head(`New ${esc(T.label)}${fromDoc ? ` <span class="muted">from ${esc(draft.ref_number)}</span>` : ''}`) + `
    <form id="docf"><div class="err" hidden></div>
    ${ge ? `<div class="panel warnbox">Receiving against gate entry <b>${esc(ge.number)}</b>: vehicle ${esc(ge.vehicle_no)}${ge.challan_no ? `, challan ${esc(ge.challan_no)}` : ''}${ge.packages ? `, ${ge.packages} packages` : ''}.</div>` : ''}
    ${isNote ? `<div class="panel muted">${isSale ? 'A credit note lowers what the customer owes' : 'A debit note lowers what you owe the supplier'} without any goods moving: rate difference, discount, short supply or damage claim. Enter the difference per unit on each line that changes.</div>` : ''}
    <div class="panel"><div class="form">
      <label class="f">${isSale ? 'Customer' : 'Supplier'}
        ${fromDoc ? `<input value="${esc((parties.find((p) => p.id === draft.party_id) || {}).name || '')}" disabled><input type="hidden" name="party_id" value="${draft.party_id}">`
          : `<select name="party_id" required><option value="">Choose…</option>${plist.map((p) => `<option value="${p.id}" ${p.id === +draft.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}</label>
      ${fromDoc ? '' : `<label class="f">&nbsp;<button type="button" class="btn" id="newparty">+ New ${side}</button></label>`}
      <label class="f">Date<input type="date" name="date" value="${esc(draft.date)}"></label>
      ${money || type === 'PO' || type === 'SO' || type === 'QUOTE' ? `<label class="f">${money ? 'Due date' : type === 'QUOTE' ? 'Valid until' : 'Expected by'}<input type="date" name="due_date" placeholder="auto"></label>` : ''}
      <label class="f">Godown<select name="warehouse_id">${whs.map((w) => `<option value="${w.id}" ${w.id === +draft.warehouse_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>
      ${cfInputs('doc', draft.extra || {}, T.side)}
    </div></div>
    <div class="panel flush"><div class="tbl-wrap"><table class="t lines"><thead><tr><th>Item</th><th>Qty</th><th>${isNote ? 'Rate diff (₹/unit)' : 'Rate (₹)'}</th><th>Disc %</th><th>GST</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody id="lines">${draft.lines.map(lineRow).join('')}</tbody></table></div>
      ${fromDoc ? '' : '<div style="padding:10px"><button type="button" class="btn sm" id="addline">+ Add line</button></div>'}</div>
    <div class="grid g2">
      <div class="panel"><label class="f">Notes / terms<textarea name="notes" rows="3"></textarea></label>
        ${money ? `<div class="form" style="margin-top:12px"><label class="f">${isSale ? 'Received now' : 'Paid now'} (₹)<input type="number" step="any" min="0" name="pay_amount" placeholder="0"></label>
          <label class="f">Into / from<select name="pay_account">${cashAccts.map((o) => `<option value="${o.v}">${esc(o.t)}</option>`).join('')}</select></label></div>` : ''}</div>
      <div class="panel"><div class="totals" id="totals"></div></div>
    </div>
    <div class="row"><span class="spacer"></span><a class="btn" href="javascript:history.back()">Cancel</a><button class="btn primary" id="save">Save ${esc(T.label)}</button></div></form>`;

  const form = $('#docf'), tbody = $('#lines');
  const partyOf = () => parties.find((p) => p.id === +form.elements.party_id.value);
  const recalc = () => {
    const p = partyOf(), inter = !!(p && p.state && ME.org.state && p.state.toLowerCase() !== ME.org.state.toLowerCase());
    let taxable = 0, tax = 0;
    $$('tr', tbody).forEach((tr) => {
      const g = (n) => +($(`[name=${n}]`, tr).value || 0);
      const t = r2(g('qty') * g('rate') * (1 - g('discount_pct') / 100)), x = r2(t * g('gst_rate') / 100);
      taxable += t; tax += x; $('[data-amt]', tr).textContent = inr(t + x);
    });
    const exact = r2(taxable + tax), total = money || isNote || ['SRET', 'PRET'].includes(type) ? Math.round(exact) : exact;
    $('#totals').innerHTML = `<div><span>Taxable value</span><span>${inr(taxable)}</span></div>
      ${inter ? `<div><span>IGST</span><span>${inr(tax)}</span></div>` : `<div><span>CGST</span><span>${inr(tax / 2)}</span></div><div><span>SGST</span><span>${inr(tax / 2)}</span></div>`}
      ${total !== exact ? `<div><span>Round off</span><span>${inr(total - exact)}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${inr(total)}</span></div>`;
  };
  const wireRow = (tr) => {
    const sel = $('select[name=item_id]', tr);
    if (sel) sel.onchange = () => {
      const it = items.find((i) => i.id === +sel.value);
      if (it) {
        if (!isNote) $('[name=rate]', tr).value = isSale ? it.sale_price : (it.purchase_price || it.avg_cost);
        $('[name=gst_rate]', tr).value = it.gst_rate;
        $('[name=description]', tr).value = '';
      }
      recalc();
    };
    const del = $('[data-del]', tr);
    if (del) del.onclick = () => { if ($$('tr', tbody).length > 1) { tr.remove(); recalc(); } };
  };
  $$('tr', tbody).forEach(wireRow);
  form.addEventListener('input', recalc);
  form.addEventListener('change', recalc);
  if ($('#addline')) $('#addline').onclick = () => { tbody.insertAdjacentHTML('beforeend', lineRow({})); wireRow(tbody.lastElementChild); recalc(); };
  if ($('#newparty')) $('#newparty').onclick = () => partyForm({ kind: side }, async (p) => {
    parties.push(p); const s = form.elements.party_id;
    s.insertAdjacentHTML('beforeend', `<option value="${p.id}">${esc(p.name)}</option>`); s.value = p.id; recalc();
  });
  recalc();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const lines = $$('tr', tbody).map((tr) => {
      const g = (n) => { const x = $(`[name=${n}]`, tr); return x ? x.value : ''; };
      return { item_id: +g('item_id') || null, description: g('description'), qty: g('qty'), rate: g('rate'), discount_pct: g('discount_pct'), gst_rate: g('gst_rate'), src_line_id: +g('src_line_id') || undefined };
    }).filter((l) => +l.qty > 0 && (!isNote || +l.rate > 0));
    const body = { type, party_id: +f.party_id.value, date: f.date.value, warehouse_id: +f.warehouse_id.value, notes: f.notes.value, lines, ref_id: draft.ref_id, extra: cfRead(form) };
    if (ge) body.gate_entry_id = ge.id;
    if (f.due_date && f.due_date.value) body.due_date = f.due_date.value;
    if (f.pay_amount && +f.pay_amount.value > 0) body.payment = { amount: +f.pay_amount.value, account_id: +f.pay_account.value };
    const btn = $('#save'); btn.disabled = true;
    try {
      const d = await POST('/api/docs', body);
      dirty('items', 'parties', 'accounts');
      toast(`${d.number} saved`); go('doc/' + d.id);
    } catch (err) { const b = $('.err', form); b.hidden = false; b.textContent = err.message; window.scrollTo(0, 0); } finally { btn.disabled = false; }
  };
});

/* ======================================================================= document view / print */
/* The printable document (invoice, bill, order...). Used in the app and on the customer's public link. */
function docPaper(d) {
  const o = d.org, p = d.party || {}, P = o.print || {};
  const isTax = ['INV', 'BILL', 'SRET', 'PRET', 'CNOTE', 'DNOTE'].includes(d.type);
  const title = d.type === 'INV' ? (P.title || (o.gstin ? 'TAX INVOICE' : 'INVOICE')) : String(d.label || '').toUpperCase();
  const inter = !!d.inter_state, compact = P.layout === 'compact', ours = d.side === 'sales' || d.type === 'PO';
  const color = /^#[0-9a-f]{6}$/i.test(P.color || '') ? P.color : '#0f766e';
  const bank = ours && P.bank_account ? `<p class="bank"><b>Bank details</b><br>${[P.bank_name, 'A/c ' + P.bank_account, P.bank_ifsc && 'IFSC ' + P.bank_ifsc, P.bank_branch].filter(Boolean).map(esc).join(' &middot; ')}</p>` : '';
  const upi = d.type === 'INV' && o.upi_id && d.balance > 0 && P.show_upi !== false;
  const lineCells = (l, i) => compact
    ? `<td>${esc(l.item || l.description)}${l.print_extra ? `<div class="muted">${esc(l.print_extra)}</div>` : ''}<div class="muted">${qtyf(l.qty)} ${esc(l.unit || '')} &times; ${inr(l.rate)}${l.discount_pct ? ` &minus;${l.discount_pct}%` : ''}${l.gst_rate ? ` &middot; GST ${l.gst_rate}%` : ''}</div></td><td class="num">${inr(l.total)}</td>`
    : `<td>${i + 1}</td><td>${esc(l.item || l.description)}${l.item && l.description && l.description !== l.item ? `<div class="muted">${esc(l.description)}</div>` : ''}${l.print_extra ? `<div class="muted">${esc(l.print_extra)}</div>` : ''}</td><td>${esc(l.hsn || '')}</td>
        <td class="num">${qtyf(l.qty)} ${esc(l.unit || '')}</td><td class="num">${inr(l.rate)}</td><td class="num">${l.discount_pct ? l.discount_pct + '%' : ''}</td><td class="num">${inr(l.taxable)}</td><td class="num">${l.gst_rate}%</td>
        ${inter ? `<td class="num">${inr(l.igst)}</td>` : `<td class="num">${inr(l.cgst)}</td><td class="num">${inr(l.sgst)}</td>`}<td class="num">${inr(l.total)}</td>`;
  const heads = compact ? '<th>Item</th><th class="num">Amount</th>'
    : `<th>#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc</th><th class="num">Taxable</th><th class="num">GST</th>${inter ? '<th class="num">IGST</th>' : '<th class="num">CGST</th><th class="num">SGST</th>'}<th class="num">Amount</th>`;
  return `<div class="doc-paper L-${esc(P.layout || 'classic')}" style="--ac:${color}">
      <div class="hdr"><div class="org">${d.logo_url ? `<img class="logo" src="${esc(d.logo_url)}" alt="">` : ''}<div><div class="oname">${esc(o.name)}</div><div>${esc(o.address)}</div>
        <div>${[o.gstin ? 'GSTIN: ' + esc(o.gstin) : '', o.state ? 'State: ' + esc(o.state) : ''].filter(Boolean).join(' &middot; ')}</div><div>${esc(o.phone)}</div></div></div>
        <div class="meta"><div class="title">${esc(title)}</div><div>No: <b>${esc(d.number)}</b></div><div>Date: ${fdate(d.date)}</div>
        ${d.due_date ? `<div>${d.type === 'QUOTE' ? 'Valid till' : 'Due'}: ${fdate(d.due_date)}</div>` : ''}${d.parent ? `<div>Ref: ${esc(d.parent.number)}</div>` : ''}</div></div>
      <div class="parties"><div><b>${d.side === 'sales' ? 'Bill to' : 'Supplier'}</b><br>${esc(p.name)}<br>${esc(p.address || '')}<br>${p.gstin ? 'GSTIN: ' + esc(p.gstin) + '<br>' : ''}${esc(p.phone || '')}</div>
        <div><b>Place of supply</b><br>${esc(d.place_of_supply || '-')}<br>${isTax ? (inter ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)') : ''}${d.warehouse ? '<br>Godown: ' + esc(d.warehouse) : ''}</div></div>
      ${(d.print_fields || []).length ? `<div class="cfp">${d.print_fields.map((f) => `<span><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join('')}</div>` : ''}
      <div class="tbl-wrap"><table class="dl"><thead><tr>${heads}</tr></thead>
      <tbody>${d.lines.map((l, i) => `<tr>${lineCells(l, i)}</tr>`).join('')}</tbody></table></div>
      <div class="foot"><div class="words"><b>Amount in words:</b> ${esc(words(d.total))}${d.notes ? `<p><b>Notes:</b> ${esc(d.notes)}</p>` : ''}
        ${upi ? `<p>Pay by UPI: <b>${esc(o.upi_id)}</b></p>` : ''}${bank}</div>
        <div class="totals"><div><span>Taxable</span><span>${inr(d.taxable)}</span></div>
          ${inter ? `<div><span>IGST</span><span>${inr(d.igst)}</span></div>` : `<div><span>CGST</span><span>${inr(d.cgst)}</span></div><div><span>SGST</span><span>${inr(d.sgst)}</span></div>`}
          ${d.round_off ? `<div><span>Round off</span><span>${inr(d.round_off)}</span></div>` : ''}<div class="grand"><span>Total</span><span>${inr(d.total)}</span></div></div></div>
      ${d.irn || d.ewb_no ? `<div style="margin-top:12px;font-size:12px">${d.irn ? `IRN: <b>${esc(d.irn)}</b>${d.ack_no ? ` &middot; Ack No: ${esc(d.ack_no)}` : ''}${d.ack_date ? ` &middot; Ack Date: ${esc(d.ack_date)}` : ''}<br>` : ''}${d.ewb_no ? `E-way bill: <b>${esc(d.ewb_no)}</b>${d.ewb_date ? ` &middot; ${esc(d.ewb_date)}` : ''}` : ''}</div>` : ''}
      ${ours && P.terms ? `<div class="terms"><b>Terms &amp; conditions</b><div>${esc(P.terms).replace(/\n/g, '<br>')}</div></div>` : ''}
      <div class="foot"><div id="upiqr"></div><div class="sign">For ${esc(o.name)}<br>${d.sign_url ? `<img class="sig" src="${esc(d.sign_url)}" alt="">` : '<br><br>'}<br>${P.signatory ? esc(P.signatory) + '<br>' : ''}Authorised signatory</div></div>
      ${P.footer ? `<div class="pfoot">${esc(P.footer)}</div>` : ''}
    </div>`;
}

route(/^doc\/(\d+)$/, async (el, m) => {
  const d = await GET('/api/docs/' + m[1]);
  const T = ME.doc_types[d.type], o = d.org, p = d.party || {};
  const next = Object.entries(ME.doc_types).filter(([k, v]) => v.from.includes(d.type) && !(simple() && ADV_DOCS.includes(k)));
  const hasOpen = d.lines.some((l) => l.remaining > 0.0005);
  const actions = [];
  if (d.status !== 'cancelled') {
    for (const [k, v] of next) if (hasOpen || v.note) actions.push(`<a class="btn" href="#/new/${k}?from=${d.id}">${['SRET', 'PRET'].includes(k) ? 'Return goods' : v.note ? (k === 'CNOTE' ? 'Credit note' : 'Debit note') : 'Make ' + esc(v.label)}</a>`);
    if (!simple() && ['SO', 'DN'].includes(d.type)) actions.push(`<a class="btn" href="#/picklist/${d.id}">Pick list</a>`);
    if (['INV', 'BILL'].includes(d.type) && d.balance > 0) actions.push(`<button class="btn" id="pay">${d.type === 'INV' ? 'Receive payment' : 'Record payment'}</button>`);
    if (['INV', 'SRET', 'CNOTE', 'QUOTE', 'SO'].includes(d.type)) actions.push(`<button class="btn got" id="wa">WhatsApp</button>`, ...(p.phone ? ['<button class="btn" id="sms">SMS</button>'] : []), `<button class="btn" id="link">Copy link</button>`);
    if (!simple() && ['INV', 'SRET', 'CNOTE'].includes(d.type)) actions.push(`<a class="btn" href="/api/docs/${d.id}/einvoice" id="einv">E-invoice JSON</a>`);
    if (!simple() && ['INV', 'DN'].includes(d.type)) actions.push(`<button class="btn" id="ewb">E-way bill</button>`);
    if (!simple() && ['INV', 'SRET', 'DN'].includes(d.type)) actions.push(`<button class="btn" id="refs">${d.irn || d.ewb_no ? 'Edit' : 'Add'} IRN / EWB no.</button>`);
    actions.push(`<button class="btn danger" id="cancel">Cancel</button>`);
  }
  actions.push(`<button class="btn primary" onclick="print()">Print / PDF</button>`);
  el.innerHTML = head(`${esc(d.number)} ${badge(d.status)}`, actions.join('')) + `
    <div class="panel no-print"><div class="row">
      ${d.parent ? `<span>From <a href="#/doc/${d.parent.id}">${esc(d.parent.number)}</a></span>` : ''}
      ${d.children.length ? `<span>Follow-ups: ${d.children.map((c) => `<a href="#/doc/${c.id}">${esc(c.number)}</a> ${badge(c.status)}`).join(' ')}</span>` : ''}
      ${['INV', 'BILL'].includes(d.type) ? `<span class="spacer"></span><span>Paid <b>${inr(d.paid)}</b> &middot; Balance <b>${inr(d.balance)}</b></span>` : ''}
    </div>${d.settlements.length ? `<div class="muted" style="margin-top:8px">Settled by: ${d.settlements.map((s) => `${esc(s.number)} (${inr(s.amount)})`).join(', ')}</div>` : ''}</div>
    ${docPaper(d)}`;
  if (d.type === 'INV' && o.upi_id && d.balance > 0 && o.print.show_upi !== false) upiQr($('#upiqr'), o, d.balance, d.number, 'Scan to pay with any UPI app');
  if ($('#einv')) $('#einv').onclick = (e) => { e.preventDefault(); fileDownload(`/api/docs/${d.id}/einvoice`); };
  if ($('#ewb')) $('#ewb').onclick = () => modal('E-way bill (bulk upload JSON)', [
    { k: 'distance', label: 'Distance (km)', type: 'number', required: true }, { k: 'vehicle_no', label: 'Vehicle number', placeholder: 'RJ14AB1234' },
    { k: 'mode', label: 'Mode', type: 'select', options: [{ v: '1', t: 'Road' }, { v: '2', t: 'Rail' }, { v: '3', t: 'Air' }, { v: '4', t: 'Ship' }] },
    { k: 'transporter_id', label: 'Transporter ID (GSTIN/TRANSIN)' }, { k: 'transporter_name', label: 'Transporter name' },
    { k: 'trans_doc_no', label: 'LR / RR number' }, { k: 'trans_doc_date', label: 'LR date', type: 'date' }],
  async (v) => fileDownload(`/api/docs/${d.id}/ewaybill?${new URLSearchParams(v)}`), { submit: 'Download JSON',
    intro: '<p class="muted">Upload the file at ewaybillgst.gov.in → e-Waybill → Generate Bulk. Then save the e-way bill number here with “Add IRN / EWB no.”</p>' });
  if ($('#refs')) $('#refs').onclick = () => modal('GST portal numbers', [
    { k: 'irn', label: 'IRN (e-invoice)', value: d.irn, wide: true }, { k: 'ack_no', label: 'Ack No', value: d.ack_no }, { k: 'ack_date', label: 'Ack date', value: d.ack_date },
    { k: 'ewb_no', label: 'E-way bill no.', value: d.ewb_no }, { k: 'ewb_date', label: 'E-way bill date', value: d.ewb_date }],
  async (v) => { await api('PUT', `/api/docs/${d.id}/gst-refs`, v); toast('Saved'); render(); },
  { intro: '<p class="muted">Upload the e-invoice JSON on einvoice1.gst.gov.in (or through your GSP), then paste the IRN and Ack details here. They print on the invoice.</p>' });
  const c = $('#cancel');
  if (c) c.onclick = async () => {
    if (!confirm(`Cancel ${d.number}? Its stock and accounting entries will be reversed.`)) return;
    try { await POST(`/api/docs/${d.id}/cancel`); dirty('items', 'accounts', 'parties'); toast('Cancelled'); render(); } catch (e) { alert(e.message); }
  };
  if ($('#pay')) $('#pay').onclick = () => paymentForm(d.type === 'INV' ? 'receipt' : 'payment', { party_id: d.party_id, amount: d.balance, doc: d });
  if ($('#wa')) $('#wa').onclick = async () => {
    const w = window.open('', '_blank');                 // open now, inside the tap; filled in once the link is ready
    try { const r = await GET(`/api/docs/${d.id}/share`); if (w) w.location = r.whatsapp_url; else location.href = r.whatsapp_url; }
    catch (e) { if (w) w.close(); alert(e.message); }
  };
  if ($('#sms')) $('#sms').onclick = async () => { const r = await GET(`/api/docs/${d.id}/share`); location.href = r.sms_url; };
  if ($('#link')) $('#link').onclick = async () => {
    const r = await GET(`/api/docs/${d.id}/share`);
    try { await navigator.clipboard.writeText(r.url); toast('Customer link copied'); } catch (e) { prompt('Copy this link:', r.url); }
  };
});

/* ======================================================================= payments & receipts */
async function paymentForm(kind, { party_id = '', amount = '', doc } = {}) {
  const parties = (await master('parties')).filter((p) => kind === 'receipt' ? p.kind !== 'supplier' : p.kind !== 'customer');
  const accts = await cashOpts();
  modal(kind === 'receipt' ? 'Receive payment' : 'Pay supplier', [
    { k: 'party_id', label: kind === 'receipt' ? 'From customer' : 'To supplier', type: 'select', options: [{ v: '', t: 'Choose…' }, ...opts(parties, (p) => `${p.name} (bal ${inr(p.balance)})`)], value: party_id },
    { k: 'amount', label: 'Amount (₹)', type: 'number', value: amount, required: true },
    { k: 'account_id', label: kind === 'receipt' ? 'Received in' : 'Paid from', type: 'select', options: accts },
    { k: 'date', label: 'Date', type: 'date', value: ME.today },
    { k: 'reference', label: 'Reference (UTR / cheque no.)' },
    { k: 'notes', label: 'Notes' },
  ], async (v) => {
    const body = { ...v, kind, party_id: +v.party_id, account_id: +v.account_id };
    if (doc) body.allocations = [{ doc_id: doc.id, amount: Math.min(+v.amount, doc.balance) }];
    const r = await POST('/api/payments', body);
    dirty('accounts', 'parties'); toast(`${r.number} saved`); render();
  }, { intro: `<p class="muted">${doc ? `Against ${esc(doc.number)}.` : 'Applied to the oldest open ' + (kind === 'receipt' ? 'invoices' : 'bills') + ' first; any extra is kept as an advance.'}</p>` });
}
const payList = (kind) => async (el, m, q) => {
  const { rows } = await GET('/api/payments?kind=' + kind);
  el.innerHTML = head(kind === 'receipt' ? 'Receipts' : 'Payments', `<button class="btn primary" id="new">+ ${kind === 'receipt' ? 'Receive payment' : 'Pay supplier'}</button>`) +
    `<div class="panel flush">${table([{ h: 'Number', k: 'number' }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Party', k: 'party' }, { h: 'Account', k: 'account' },
      { h: 'Reference', k: 'reference', cls: 'hide-sm' }, { h: 'Amount', num: 1, f: (r) => inr(r.amount) },
      { h: '', f: (r) => r.void ? badge('cancelled') : `<button class="btn sm danger" data-void="${r.id}">Void</button>` }], rows)}</div>`;
  $('#new').onclick = () => paymentForm(kind);
  $$('[data-void]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Void this entry? Its accounting will be reversed and the invoices/bills re-opened.')) return;
    try { await POST(`/api/payments/${b.dataset.void}/void`); dirty('accounts', 'parties'); render(); } catch (e) { alert(e.message); }
  });
  if (q.get('new')) paymentForm(kind);
};
route(/^receipts$/, payList('receipt'));
route(/^payments$/, payList('payment'));

/* ======================================================================= parties */
function partyForm(p = {}, after) {
  return modal(p.id ? 'Edit ' + p.name : 'New contact', [
    { k: 'name', label: 'Name', value: p.name, required: true },
    { k: 'kind', label: 'Type', type: 'select', options: [{ v: 'customer', t: 'Customer' }, { v: 'supplier', t: 'Supplier' }, { v: 'both', t: 'Both' }], value: p.kind || 'customer' },
    { k: 'phone', label: 'Mobile', value: p.phone, type: 'tel' }, { k: 'email', label: 'Email', value: p.email, type: 'email' },
    { k: 'gstin', label: 'GSTIN', value: p.gstin }, { k: 'state', label: 'State', value: p.state ?? ME.org.state, list: 'states' },
    { k: 'city', label: 'City', value: p.city }, { k: 'pincode', label: 'PIN code', value: p.pincode, placeholder: 'needed for e-invoice / e-way bill' },
    { k: 'credit_days', label: 'Credit days', type: 'number', value: p.credit_days ?? 0 }, { k: 'credit_limit', label: 'Credit limit (₹)', type: 'number', value: p.credit_limit ?? 0 },
    { k: 'address', label: 'Address', type: 'textarea', value: p.address, wide: true }, ...cfModal('party', p.extra),
  ], async (v) => {
    v = splitCf(v);
    const r = p.id ? await api('PUT', '/api/parties/' + p.id, v) : await POST('/api/parties', v);
    dirty('parties'); toast('Saved');
    if (after) after(r); else render();
  });
}
route(/^parties$/, async (el, m, q) => {
  const kind = q.get('kind') || '';
  const { rows } = await GET('/api/parties' + (kind ? '?kind=' + kind : ''));
  el.innerHTML = head('Customers & Suppliers', `<button class="btn primary" id="new">+ New contact</button>`) + `
    <div class="tabs">${[['', 'All'], ['customer', 'Customers'], ['supplier', 'Suppliers']].map(([k, t]) => `<a href="#/parties${k ? '?kind=' + k : ''}" class="${kind === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    ${rows.length > 5 ? '<div class="panel"><input id="search" type="search" placeholder="Search name, mobile, GSTIN…" style="max-width:320px"></div>' : ''}<div class="panel flush" id="list"></div>
    <p class="muted">Dr = they owe you. Cr = you owe them.</p>`;
  const cols = [{ h: 'Name', k: 'name' }, { h: 'Type', k: 'kind' }, { h: 'Mobile', k: 'phone', cls: 'hide-sm' }, { h: 'GSTIN', k: 'gstin', cls: 'hide-sm' }, ...cfCols('party'),
    { h: 'Balance', num: 1, f: (r) => `<span class="${r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : ''}">${inr(Math.abs(r.balance))} ${r.balance > 0 ? 'Dr' : r.balance < 0 ? 'Cr' : ''}</span>${r.over_limit ? ' ' + badge('overdue') : ''}` }];
  const draw = (f) => { const r = rows.filter((x) => !f || [x.name, x.phone, x.gstin, x.city, ...Object.values(x.extra || {})].join(' ').toLowerCase().includes(f));
    $('#list').innerHTML = table(cols, r, { onRow: true, empty: f ? 'No match.' : 'Add your customers and suppliers.' }); bindRows($('#list'), r, (x) => go('party/' + x.id)); };
  draw('');
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
      <div class="kpi"><div class="l">Contact</div><div class="s">${esc(p.phone)} ${esc(p.email)}<br>${esc(p.gstin)} ${esc(p.state)}</div></div></div>
    <div class="panel"><form class="row" id="per"><input type="date" name="from" value="${L.from}" style="max-width:170px"><input type="date" name="to" value="${L.to}" style="max-width:170px"><button class="btn">Show</button><span class="spacer"></span><button type="button" class="btn" onclick="print()">Print statement</button></form></div>
    <div class="panel flush">${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Voucher', f: (r) => r.ref_id && ['INV', 'BILL', 'SRET', 'PRET'].includes(r.ref_type) ? `<a href="#/doc/${r.ref_id}">${esc(r.number)}</a>` : esc(r.number || r.ref_type) },
      { h: 'Particulars', k: 'narration' }, { h: 'Debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }, { h: 'Balance', num: 1, f: (r) => inr(r.balance) }],
    [{ date: L.from, narration: 'Opening balance', debit: 0, credit: 0, balance: L.opening }, ...L.rows])}</div>`;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`party/${p.id}?${new URLSearchParams(new FormData(e.target))}`); };
  $('#edit').onclick = () => partyForm(p);
  $('#open').onclick = () => modal('Opening balance', [{ k: 'amount', label: 'Amount (₹): positive = they owe you, negative = you owe them', type: 'number', wide: true }, { k: 'date', label: 'As on', type: 'date', value: ME.today }],
    async (v) => { await POST(`/api/parties/${p.id}/opening`, v); dirty('parties', 'accounts'); render(); });
  $('#del').onclick = async () => { if (confirm('Delete ' + p.name + '?')) { try { await api('DELETE', '/api/parties/' + p.id); dirty('parties'); go('parties'); } catch (e) { alert(e.message); } } };
});

/* ======================================================================= items & stock */
function itemForm(i = {}) {
  modal(i.id ? 'Edit ' + i.name : 'New item', [
    { k: 'name', label: 'Item name', value: i.name, required: true }, { k: 'sku', label: 'SKU / code', value: i.sku },
    { k: 'category', label: 'Category', value: i.category }, { k: 'unit', label: 'Unit', value: i.unit || 'Pcs' },
    { k: 'hsn', label: 'HSN / SAC', value: i.hsn }, { k: 'gst_rate', label: 'GST rate', type: 'select', options: ME.gst_rates.map((g) => ({ v: g, t: g + '%' })), value: i.gst_rate ?? 18 },
    { k: 'purchase_price', label: 'Purchase price (₹)', type: 'number', value: i.purchase_price }, { k: 'sale_price', label: 'Sale price (₹)', type: 'number', value: i.sale_price },
    { k: 'reorder_level', label: 'Reorder level', type: 'number', value: i.reorder_level ?? 0 },
    { k: 'barcode', label: 'Barcode (scan or leave blank)', value: i.barcode, placeholder: 'blank = auto label code' },
    { k: 'location', label: 'Bin / rack location', value: i.location, placeholder: 'e.g. A-03-2' },
    ...(i.id ? [] : [{ k: 'is_service', label: 'Service (no stock)', type: 'checkbox' }, { k: 'opening_qty', label: 'Opening stock qty', type: 'number' }, { k: 'opening_rate', label: 'Opening rate (₹)', type: 'number' }]),
    ...cfModal('item', i.extra),
  ], async (v) => {
    v = splitCf(v);
    if (i.id) await api('PUT', '/api/items/' + i.id, v); else await POST('/api/items', v);
    dirty('items', 'accounts'); toast('Saved'); render();
  });
}
route(/^items$/, async (el, m, q) => {
  dirty('items');
  const rows = await master('items');
  const cols = [{ h: 'Item', k: 'name' }, { h: 'SKU', k: 'sku', cls: 'hide-sm' }, { h: 'Category', k: 'category', cls: 'hide-sm' }, { h: 'GST', k: 'gst_rate', f: (r) => r.gst_rate + '%', cls: 'hide-sm' },
    { h: 'Sale price', k: 'sale_price', num: 1, f: (r) => inr(r.sale_price) }, { h: 'Avg cost', k: 'avg_cost', num: 1, f: (r) => inr(r.avg_cost), cls: 'hide-sm' },
    { h: 'In stock', k: 'qty_on_hand', num: 1, f: (r) => r.is_service ? '<span class="muted">service</span>' : `${qtyf(r.qty_on_hand)} ${esc(r.unit)}` }, { h: 'Value', k: 'stock_value', num: 1, f: (r) => inr(r.stock_value) }, ...cfCols('item')];
  el.innerHTML = head('Items', `<button class="btn" id="csv">Export CSV</button><button class="btn primary" id="new">+ New item</button>`) +
    `<div class="panel"><input id="search" placeholder="Search items…" style="max-width:320px"></div><div class="panel flush" id="list"></div>`;
  const draw = (f) => { const r = rows.filter((x) => !f || (x.name + ' ' + x.sku + ' ' + x.category + ' ' + Object.values(x.extra || {}).join(' ')).toLowerCase().includes(f)); $('#list').innerHTML = table(cols, r, { onRow: true, empty: 'Add the products you buy and sell.' }); bindRows($('#list'), r, (x) => go('item/' + x.id)); };
  draw('');
  $('#search').oninput = (e) => draw(e.target.value.toLowerCase());
  $('#new').onclick = () => itemForm();
  $('#csv').onclick = () => download('items.csv', toCsv(cols.map((c) => ({ ...c })), rows));
});
route(/^item\/(\d+)$/, async (el, m) => {
  dirty('items');
  const it = (await master('items')).find((x) => x.id === +m[1]);
  if (!it) throw new Error('Item not found.');
  const { rows } = await GET(`/api/items/${it.id}/moves`);
  el.innerHTML = head(esc(it.name), `${it.is_service ? '' : `<a class="btn" href="#/labels/${it.id}">Print barcode labels</a>`}<button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Delete</button>`) + `
    <div class="kpis"><div class="kpi"><div class="l">In stock</div><div class="v">${qtyf(it.qty_on_hand)} ${esc(it.unit)}</div></div>
      <div class="kpi"><div class="l">Average cost</div><div class="v">${inr(it.avg_cost)}</div></div><div class="kpi"><div class="l">Stock value</div><div class="v">${inr(it.stock_value)}</div></div>
      <div class="kpi"><div class="l">Sale price</div><div class="v">${inr(it.sale_price)}</div><div class="s">GST ${it.gst_rate}% &middot; HSN ${esc(it.hsn)}</div></div></div>
    <div class="panel flush"><div style="padding:14px 16px 0"><h3>Stock movements</h3></div>${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Voucher', f: (r) => r.number ? `<a href="#/doc/${r.ref_id}">${esc(r.number)}</a>` : esc(r.ref_type) },
      { h: 'Godown', k: 'warehouse' }, { h: 'Note', k: 'note', cls: 'hide-sm' }, { h: 'In', num: 1, f: (r) => r.qty > 0 ? qtyf(r.qty) : '' }, { h: 'Out', num: 1, f: (r) => r.qty < 0 ? qtyf(-r.qty) : '' },
      { h: 'Unit cost', num: 1, f: (r) => inr(r.unit_cost), cls: 'hide-sm' }, { h: 'Balance', num: 1, f: (r) => qtyf(r.balance) }], rows.slice().reverse(), { empty: 'No movements yet.' })}</div>`;
  $('#edit').onclick = () => itemForm(it);
  $('#del').onclick = async () => { if (confirm('Delete ' + it.name + '?')) { try { await api('DELETE', '/api/items/' + it.id); dirty('items'); go('items'); } catch (e) { alert(e.message); } } };
});
route(/^stock$/, async (el) => {
  dirty('warehouses');
  const [s, whs, items] = await Promise.all([GET('/api/reports/stock'), master('warehouses'), master('items')]);
  const stocked = items.filter((i) => !i.is_service);
  el.innerHTML = head('Stock & Godowns', `<button class="btn" id="adj">Adjust stock</button><button class="btn" id="xfer">Transfer</button><button class="btn" id="wh">+ Godown</button>`) + `
    <div class="kpis"><div class="kpi"><div class="l">Stock value</div><div class="v">${inr0(s.total_value)}</div></div><div class="kpi"><div class="l">Items to reorder</div><div class="v">${s.reorder_count}</div></div>
      ${whs.map((w) => `<div class="kpi"><div class="l">${esc(w.name)}</div><div class="v">${inr0(w.value)}</div></div>`).join('')}</div>
    <div class="panel flush">${table([{ h: 'Item', f: (r) => `<a href="#/item/${r.id}">${esc(r.name)}</a>` }, { h: 'Godowns', cls: 'hide-sm', f: (r) => r.warehouses.map((w) => `${esc(w.warehouse)}: ${qtyf(w.qty)}`).join('<br>') },
      { h: 'Qty', num: 1, f: (r) => `${qtyf(r.qty)} ${esc(r.unit)}` }, { h: 'Avg cost', num: 1, f: (r) => inr(r.avg_cost) }, { h: 'Value', num: 1, f: (r) => inr(r.value) },
      { h: 'Status', f: (r) => badge(r.status) }, { h: 'Suggested order', num: 1, f: (r) => r.suggested_order ? qtyf(r.suggested_order) : '' }], s.rows)}</div>
    ${s.rows.some((r) => r.suggested_order) ? '<div class="row"><a class="btn primary" href="#/new/PO?reorder=1">Raise a purchase order for low items</a></div>' : ''}`;
  const itemOpts = opts(stocked, (i) => `${i.name} (${qtyf(i.qty_on_hand)} ${i.unit})`), whOpts = opts(whs);
  $('#adj').onclick = () => modal('Adjust stock', [{ k: 'item_id', label: 'Item', type: 'select', options: itemOpts, wide: true }, { k: 'warehouse_id', label: 'Godown', type: 'select', options: whOpts },
    { k: 'qty', label: 'Quantity (+ add, − remove)', type: 'number' }, { k: 'reason', label: 'Reason', value: 'Physical count', wide: true }, { k: 'date', label: 'Date', type: 'date', value: ME.today }],
  async (v) => { await POST('/api/stock/adjust', { ...v, item_id: +v.item_id, warehouse_id: +v.warehouse_id }); dirty('items', 'accounts', 'warehouses'); toast('Stock adjusted'); render(); });
  $('#xfer').onclick = () => modal('Transfer between godowns', [{ k: 'item_id', label: 'Item', type: 'select', options: itemOpts, wide: true }, { k: 'from_warehouse_id', label: 'From', type: 'select', options: whOpts },
    { k: 'to_warehouse_id', label: 'To', type: 'select', options: whOpts, value: whs[1] && whs[1].id }, { k: 'qty', label: 'Quantity', type: 'number' }, { k: 'date', label: 'Date', type: 'date', value: ME.today }],
  async (v) => { await POST('/api/stock/transfer', { ...v, item_id: +v.item_id, from_warehouse_id: +v.from_warehouse_id, to_warehouse_id: +v.to_warehouse_id }); dirty('warehouses'); toast('Transferred'); render(); });
  $('#wh').onclick = () => modal('New godown / warehouse', [{ k: 'name', label: 'Name', wide: true }], async (v) => { await POST('/api/warehouses', v); dirty('warehouses'); render(); });
});

/* ======================================================================= khata */
route(/^khata$/, async (el) => {
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
  const draw = (f) => { const r = k.rows.filter((x) => !f || (x.name + ' ' + x.phone).toLowerCase().includes(f)); $('#list').innerHTML = table(cols, r, { onRow: true, empty: 'No khata entries yet. Tap “Add entry”.' }); bindRows($('#list'), r, (x) => go('khata/' + x.id)); };
  draw('');
  $('#search').oninput = (e) => draw(e.target.value.toLowerCase());
  $('#new').onclick = () => modal('New khata entry', [{ k: 'name', label: 'Name', required: true }, { k: 'phone', label: 'Mobile (to send the entry)', type: 'tel' },
    { k: 'kind', label: 'Entry', type: 'select', options: [{ v: 'gave', t: 'You gave (udhaar diya)' }, { v: 'got', t: 'You got (paise mile)' }] },
    { k: 'amount', label: 'Amount (₹)', type: 'number' }, { k: 'note', label: 'Note', wide: true }, { k: 'date', label: 'Date', type: 'date', value: ME.today }],
  async (v) => { const r = await POST('/api/khata', v); dirty('parties'); setTimeout(() => sendEntry(r, () => go('khata/' + r.party_id)), 0); }, { submit: 'Next: send to customer' });
});

/* Shows the message for an entry and sends it. The entry counts only once it has been sent. */
/* WhatsApp-style preview: *bold*, _italic_, links */
const waFormat = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
  .replace(/(https?:\/\/\S+)/g, '<span class="wa-link">$1</span>').replace(/\n/g, '<br>');
function sendEntry(r, after) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal"><h2>Send to customer to save this entry</h2>
    <p class="muted">The entry is added to the khata only after it is sent, so the customer always knows. They get a link to see and confirm it.</p>
    <div class="wa-prev"><div class="wa-bubble">${waFormat(r.text)}</div></div>
    <details class="muted"><summary>SMS text</summary><pre class="msg">${esc(r.sms_text || r.text)}</pre></details>
    ${r.phone ? '' : '<p class="err">No mobile number saved for this contact. WhatsApp will ask you to pick the chat; SMS needs a number.</p>'}
    <div class="khata-btns"><button class="btn got" data-via="whatsapp">Send on WhatsApp</button><button class="btn" data-via="sms" ${r.sms_url ? '' : 'disabled'}>Send SMS</button></div>
    <div class="actions"><button class="btn" id="later">Later (keep as not sent)</button></div></div></div>`;
  const close = () => { root.innerHTML = ''; if (after) after(); else render(); };
  $('#later').onclick = close;
  $$('[data-via]', root).forEach((b) => b.onclick = async () => {
    const via = b.dataset.via;
    window.open(via === 'whatsapp' ? r.whatsapp_url : r.sms_url, '_blank');     // open first: browsers allow it only inside the tap
    try { await POST(`/api/khata/entries/${r.entry_id}/send`, { via }); toast('Entry sent and saved'); } catch (e) { alert(e.message); }
    close();
  });
}

route(/^khata\/(\d+)$/, async (el, m) => {
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
    <div class="row" style="margin:12px 0"><button class="btn" id="wa">WhatsApp reminder</button><button class="btn" id="sms">SMS reminder</button><button class="btn" id="share">Copy customer's khata link</button></div>
    <div class="panel flush kl">${k.rows.length ? k.rows.map((r) => `<div class="ke ${r.status}">
        <div class="kl-l"><b>${fdate(r.date)}</b>${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}<div class="ks">${status(r)}</div></div>
        <div class="kl-r"><div class="${r.kind === 'gave' ? 'neg' : 'pos'} ka">${r.kind === 'gave' ? 'You gave ' : 'You got '}${inr(r.amount)}</div>
          ${r.status === 'sent' ? `<div class="muted">Bal ${inr(r.balance)}</div>` : ''}
          <div class="kact">${r.status === 'pending' ? `<button class="btn sm primary" data-send="${r.id}">Send</button><button class="btn sm danger" data-del="${r.id}">Discard</button>`
            : (reversed.has(r.id) || r.reverses ? '' : `<button class="btn sm" data-rev="${r.id}">Reverse</button>`)}</div></div></div>`).join('') : '<div class="empty">No entries yet.</div>'}</div>`;
  $$('[data-k]', el).forEach((b) => b.onclick = () => modal(b.dataset.k === 'gave' ? 'You gave' : 'You got', [{ k: 'amount', label: 'Amount (₹)', type: 'number', required: true },
    { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'note', label: 'Note (items, reason)', wide: true }],
  async (v) => { const r = await POST('/api/khata', { ...v, party_id: k.party.id, kind: b.dataset.k }); setTimeout(() => sendEntry(r), 0); }, { submit: 'Next: send to customer' }));
  $$('[data-send]', el).forEach((b) => b.onclick = async () => sendEntry(await GET(`/api/khata/entries/${b.dataset.send}/message`)));
  $$('[data-del]', el).forEach((b) => b.onclick = async () => { if (confirm('Discard this unsent entry?')) { await api('DELETE', '/api/khata/entries/' + b.dataset.del); render(); } });
  $$('[data-rev]', el).forEach((b) => b.onclick = () => modal('Reverse this entry', [{ k: 'reason', label: 'Reason (sent to the customer)', wide: true }],
    async (v) => { const r = await POST(`/api/khata/entries/${b.dataset.rev}/reverse`, v); setTimeout(() => sendEntry(r), 0); },
    { submit: 'Next: send correction', intro: '<p class="muted">Sent entries stay on record. A correction entry with the opposite amount is added and sent to the customer.</p>' }));
  const rem = async (which) => { const r = await GET(`/api/khata/${k.party.id}/reminder`); if (which === 'sms' && !r.sms_url) return alert('Save a mobile number for this contact first.'); open(which === 'sms' ? r.sms_url : r.whatsapp_url, '_blank'); };
  $('#wa').onclick = () => rem('wa'); $('#sms').onclick = () => rem('sms');
  $('#share').onclick = async () => { try { await navigator.clipboard.writeText(k.statement_url); toast('Link copied'); } catch (e) { prompt('Copy this link:', k.statement_url); } };
});

/* The customer's view of an invoice / quotation (/i/<token>): print or save as PDF, pay by UPI. */
async function publicDoc(token) {
  const app = $('#app');
  try {
    const res = await fetch('/api/public/doc/' + token);
    const d = await res.json();
    if (!res.ok) { app.innerHTML = `<div class="boot"><h2>Link not valid</h2><p class="muted">${esc(d.error || '')}</p></div>`; return; }
    const due = d.type === 'INV' && d.balance > 0;
    app.innerHTML = `<main class="page pub pubdoc"><div class="page-head no-print"><h1>${esc(d.label)} ${esc(d.number)}</h1>${d.type === 'INV' ? badge(d.status) : ''}<span class="spacer"></span>
        ${due && d.org.upi_id ? `<a class="btn got" href="${esc(upiLink(d.org.upi_id, d.org.name, d.balance, d.number))}">Pay ${inr(d.balance)} by UPI</a>` : ''}
        <button class="btn primary" onclick="print()">Download PDF</button></div>
      ${due ? `<div class="panel no-print">Balance due <b>${inr(d.balance)}</b>${d.due_date ? ` by ${fdate(d.due_date)}` : ''}.${payBox(d.org, d.balance, d.number)}</div>` : ''}
      ${docPaper(d)}<p class="muted no-print">Shared by ${esc(d.org.name)} using SmartTrader ERP. Tap “Download PDF” and choose “Save as PDF”.</p></main>`;
    if (due) { if (!d.org.print || d.org.print.show_upi !== false) upiQr($('#upiqr'), d.org, d.balance, d.number, 'Scan to pay with any UPI app'); wirePayBox(app, d.org, d.balance, d.number); }
  } catch (e) { app.innerHTML = '<div class="boot"><h2>You are offline</h2><p class="muted">Connect to the internet to see this document.</p></div>'; }
}

/* How the customer pays: a UPI button (opens GPay/PhonePe/Paytm on the phone), a QR for paying from another
   phone, and the UPI ID to copy. Without a UPI ID on the shop, call / WhatsApp the shop instead. */
function payBox(shop, amount, note) {
  const phone = String(shop.phone || '').replace(/\D/g, ''), wa = phone.length === 10 ? '91' + phone : phone;
  const contact = phone ? `<div class="row" style="margin-top:10px"><a class="btn" href="tel:${esc(phone)}">Call shop</a>
      <a class="btn" href="https://api.whatsapp.com/send?phone=${esc(wa)}&text=${encodeURIComponent(`Namaste, maine ${shop.name} ka ${inr(amount)} ka payment karna hai.`)}">WhatsApp shop</a></div>` : '';
  if (!shop.upi_id) return `<div class="paybox"><b>How to pay</b><p class="muted" style="margin:4px 0 0">Pay ${esc(shop.name)} in cash or ask for their UPI ID.</p>${contact}</div>`;
  return `<div class="paybox"><a class="btn got big" href="${esc(upiLink(shop.upi_id, shop.name, amount, note))}">Pay ${inr(amount)} by UPI</a>
    <div class="muted" style="margin:6px 0">Opens Google Pay, PhonePe, Paytm or any UPI app.</div>
    <div class="row"><span>UPI ID: <b>${esc(shop.upi_id)}</b></span><button class="btn sm" type="button" data-copyupi="${esc(shop.upi_id)}">Copy</button></div>
    <div data-payqr style="margin-top:10px"></div>${contact}</div>`;
}
function wirePayBox(root, shop, amount, note) {
  $$('[data-copyupi]', root).forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyupi); toast('UPI ID copied'); } catch (e) { prompt('UPI ID:', b.dataset.copyupi); } });
  const q = $('[data-payqr]', root);
  if (q && shop.upi_id) upiQr(q, shop, amount, note, 'Paying from another phone? Scan this');
}

/* The customer's private statement page (#/k/<token>): no login, read-only, confirm or dispute entries. */
async function publicKhata(token) {
  const app = $('#app');
  const load = async () => {
    const res = await fetch('/api/public/khata/' + token);
    const d = await res.json();
    if (!res.ok) { app.innerHTML = `<div class="boot"><h2>Khata not found</h2><p class="muted">${esc(d.error || '')}</p></div>`; return; }
    app.innerHTML = `<main class="page pub"><div class="panel"><div class="muted">Khata statement from</div><h1>${esc(d.shop.name)}</h1>
        <div class="muted">${[d.shop.address, d.shop.phone].filter(Boolean).map(esc).join(' &middot; ')}</div></div>
      <div class="kpi" style="margin-bottom:14px"><div class="l">${esc(d.customer)}, ${d.balance > 0 ? 'you have to pay' : d.balance < 0 ? 'your advance' : 'your khata is'}</div>
        <div class="v ${d.balance > 0 ? 'neg' : 'pos'}">${d.balance === 0 ? 'Settled ✓' : inr(Math.abs(d.balance))}</div>
        ${d.balance > 0 ? payBox(d.shop, d.balance, 'Khata') : ''}</div>
      <div class="panel flush kl">${d.rows.length ? d.rows.map((r) => `<div class="ke">
        <div class="kl-l"><b>${fdate(r.date)}</b>${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
          <div class="ks">${r.ack === 'confirmed' ? '<span class="badge b-paid">✓ you confirmed</span>' : r.ack === 'disputed' ? '<span class="badge b-unpaid">you said this is wrong</span>'
            : `<span class="muted">Is this correct?</span> <button class="btn sm got" data-ok="${r.id}">Yes</button> <button class="btn sm danger" data-no="${r.id}">No</button>`}</div></div>
        <div class="kl-r"><div class="${r.kind === 'gave' ? 'neg' : 'pos'} ka">${r.kind === 'gave' ? 'Udhaar ' : 'Paid '}${inr(r.amount)}</div><div class="muted">Bal ${inr(r.balance)}</div></div></div>`).join('')
        : '<div class="empty">No entries yet.</div>'}</div>
      <p class="muted">Entries cannot be deleted by the shop. Any correction appears here as a new entry. Powered by SmartTrader.</p></main>`;
    const ack = async (id, a, note = '') => {
      const r = await fetch(`/api/public/khata/${token}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' }, body: JSON.stringify({ entry_id: +id, ack: a, note }) });
      if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'Could not save'); else load();
    };
    if (d.balance > 0) wirePayBox(app, d.shop, d.balance, 'Khata');
    $$('[data-ok]').forEach((b) => b.onclick = () => ack(b.dataset.ok, 'confirmed'));
    $$('[data-no]').forEach((b) => b.onclick = () => { const n = prompt('What is wrong with this entry? (the shop will see this)'); if (n !== null) ack(b.dataset.no, 'disputed', n); });
  };
  try { await load(); } catch (e) { app.innerHTML = `<div class="boot"><h2>You are offline</h2><p class="muted">Connect to the internet to see your khata.</p></div>`; }
}

/* ======================================================================= finance */
route(/^expenses$/, async (el, m, q) => {
  dirty('accounts');
  const accts = await master('accounts');
  const exp = accts.filter((a) => a.type === 'expense' && !['cogs', 'stock_adj', 'round_off'].includes(a.sys));
  const dbk = await GET('/api/reports/daybook');
  const rows = dbk.entries.filter((e) => e.ref_type === 'EXP');
  el.innerHTML = head('Expenses', `<button class="btn primary" id="new">+ Add expense</button>`) +
    `<div class="kpis">${exp.filter((a) => a.balance).map((a) => `<div class="kpi"><div class="l">${esc(a.name)}</div><div class="v">${inr0(a.balance)}</div></div>`).join('')}</div>
    <div class="panel flush">${table([{ h: 'Date', f: (r) => fdate(r.date) }, { h: 'Expense', k: 'narration' }, { h: 'Amount', num: 1, f: (r) => inr(r.lines.reduce((s, l) => s + l.credit, 0)) }], rows, { empty: 'No expenses this year.' })}</div>`;
  const form = async () => modal('Add expense', [{ k: 'account_id', label: 'Expense head', type: 'select', options: opts(exp, (a) => a.name) },
    { k: 'amount', label: 'Amount before GST (₹)', type: 'number', required: true }, { k: 'gst_amount', label: 'GST paid (input credit, ₹)', type: 'number', value: 0 },
    { k: 'paid_from', label: 'Paid from', type: 'select', options: await cashOpts() }, { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'notes', label: 'Notes', wide: true }],
  async (v) => { await POST('/api/expenses', { ...v, account_id: +v.account_id, paid_from: +v.paid_from }); dirty('accounts'); toast('Expense saved'); render(); });
  $('#new').onclick = form;
  if (q.get('new')) form();
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
    <div class="panel"><form class="row" id="per"><input type="date" name="from" value="${L.from}" style="max-width:170px"><input type="date" name="to" value="${L.to}" style="max-width:170px"><button class="btn">Show</button></form></div>
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
  const row = () => `<tr><td><select name="account_id">${aopt}</select></td><td class="hide-sm"><select name="party_id">${popt}</select></td><td class="c-n"><input name="debit" type="number" step="any" min="0"></td><td class="c-n"><input name="credit" type="number" step="any" min="0"></td></tr>`;
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
  el.innerHTML = head('Day Book') + `<div class="panel"><form class="row" id="per"><input type="date" name="from" value="${d.from}" style="max-width:170px"><input type="date" name="to" value="${d.to}" style="max-width:170px"><button class="btn">Show</button></form></div>
    ${d.entries.length ? d.entries.map((e) => `<div class="panel flush"><div style="padding:10px 14px" class="row"><b>${fdate(e.date)}</b><span>${esc(e.narration)}</span><span class="spacer"></span><span class="badge">${esc(e.ref_type)}</span></div>
      ${table([{ h: 'Account', k: 'account' }, { h: 'Party', k: 'party', cls: 'hide-sm' }, { h: 'Debit', num: 1, f: (r) => r.debit ? inr(r.debit) : '' }, { h: 'Credit', num: 1, f: (r) => r.credit ? inr(r.credit) : '' }], e.lines)}</div>`).join('')
    : '<div class="panel empty">No entries for these dates.</div>'}`;
  $('#per').onsubmit = (e) => { e.preventDefault(); go(`daybook?${new URLSearchParams(new FormData(e.target))}`); };
});

/* ======================================================================= reports */
const periodBar = (d, extra = '') => `<div class="panel no-print"><form class="row" id="per">${d.from ? `<label class="f">From<input type="date" name="from" value="${d.from}"></label>` : ''}
  <label class="f">${d.from ? 'To' : 'As on'}<input type="date" name="to" value="${d.to || d.as_of || ME.today}"></label>${extra}<label class="f">&nbsp;<button class="btn">Show</button></label>
  <span class="spacer"></span><label class="f">&nbsp;<span class="row"><button type="button" class="btn" id="csv">CSV</button><button type="button" class="btn" onclick="print()">Print</button></span></label></form></div>`;
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
      <p class="muted">Returns and credit notes are netted. Tally these with your GSTR-2B before filing.</p>`;
    csv = [['Section', 'Rate', 'Type', 'Taxable', 'CGST', 'SGST', 'IGST'], ...d.outward.rows.map((r) => ['Outward', r.rate, r.kind, r.taxable, r.cgst, r.sgst, r.igst]), ...d.inward.rows.map((r) => ['Inward', r.rate, r.kind, r.taxable, r.cgst, r.sgst, r.igst])];
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
  $('#csv').onclick = () => download(`${name}.csv`, csv.map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n'));
});

/* ======================================================================= settings */
const SET_TABS = [['settings', 'Business & users'], ['settings/print', 'Branding & print'], ['settings/numbering', 'Numbering'], ['settings/fields', 'Custom fields']];
const setTabs = (cur) => `<div class="tabs">${SET_TABS.map(([h, t]) => `<a href="#/${h}" class="${h === cur ? 'on' : ''}">${t}</a>`).join('')}</div>`;

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
    party: { name: 'Mehta Stores', address: 'Shop 4, MI Road', phone: '9876543210' }, notes: '', balance: 1050, taxable: 1000, cgst: 25, sgst: 25, igst: 0, round_off: 0, total: 1050,
    lines: [{ item: 'Basmati Rice 5kg', hsn: '1006', qty: 2, unit: 'Bag', rate: 500, discount_pct: 0, gst_rate: 5, taxable: 1000, cgst: 25, sgst: 25, igst: 0, total: 1050 }],
    org: { ...ME.org, print: P }, ...urls });
  const v = (k) => esc(P[k] || '');
  el.innerHTML = head('Branding & print') + setTabs('settings/print') + `
    <div class="grid g2 brand-grid">
    <form class="panel" id="pf"><div class="err" hidden></div>
      <h2>Look</h2>
      <div class="seg" id="lay">${[['classic', 'Classic'], ['modern', 'Modern'], ['compact', 'Compact (80 mm)']].map(([k, t]) => `<button type="button" data-l="${k}" class="${P.layout === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="form" style="margin-top:12px">
        <label class="f">Brand colour<input type="color" name="color" value="${v('color')}"></label>
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
      <div class="row sticky-act"><span class="spacer"></span><button class="btn primary" ${canEdit ? '' : 'disabled'}>Save</button></div>
    </form>
    <div><h2 class="no-print">Preview</h2><div id="pv"></div></div></div>`;
  const form = $('#pf');
  const read = () => {
    const f = form.elements;
    return { ...P, layout: $('#lay .on').dataset.l, color: f.color.value, title: f.title.value, signatory: f.signatory.value, show_upi: f.show_upi.checked,
      bank_name: f.bank_name.value, bank_account: f.bank_account.value, bank_ifsc: f.bank_ifsc.value.toUpperCase(), bank_branch: f.bank_branch.value, terms: f.terms.value, footer: f.footer.value };
  };
  const preview = () => { P = read(); $('#pv').innerHTML = docPaper(sample()); };
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
      } catch (err) { alert(err.message); }
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
  const shown = rows.filter((r) => !(simple() && ADV_DOCS.includes(r.type)));
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

route(/^settings$/, async (el) => {
  const o = ME.org, canUsers = ME.can.users;
  const users = canUsers ? await GET('/api/users') : { rows: [], roles: [] };
  const audit = canUsers ? (await GET('/api/audit')).rows : [];
  el.innerHTML = head('Settings') + setTabs('settings') + `
    <div class="panel"><h2>Features</h2><div class="row">
      <label class="row" style="gap:8px"><input type="radio" name="mode" value="simple" ${simple() ? 'checked' : ''}> <span><b>Simple</b><br><span class="muted">Billing, purchase bills, returns, credit notes, stock, khata, POS, accounts. Best for most shops.</span></span></label>
      <label class="row" style="gap:8px"><input type="radio" name="mode" value="advanced" ${simple() ? '' : 'checked'}> <span><b>Advanced</b><br><span class="muted">Adds quotations, sales/purchase orders, delivery notes, GRN, gate entry & gate pass, stock count, pick lists, e-invoice & e-way bill.</span></span></label>
    </div><p class="muted">Switching only shows or hides menus. No data is deleted.</p></div>
    <form class="panel" id="org"><h2>Business profile</h2><div class="err" hidden></div><div class="form">
      <label class="f">Business name<input name="name" value="${esc(o.name)}"></label><label class="f">GSTIN<input name="gstin" value="${esc(o.gstin)}" maxlength="15"></label>
      <label class="f">State<input name="state" list="states" autocomplete="off" value="${esc(o.state)}"></label>
      <label class="f">City<input name="city" value="${esc(o.city || '')}"></label><label class="f">PIN code<input name="pincode" value="${esc(o.pincode || '')}" maxlength="6" inputmode="numeric"></label>
      <label class="f">Business email<input name="email" type="email" value="${esc(o.email || '')}"></label><label class="f">Phone<input name="phone" value="${esc(o.phone)}"></label>
      <label class="f">UPI ID (for payment links)<input name="upi_id" value="${esc(o.upi_id)}" placeholder="shop@okhdfcbank"></label>
      <label class="f">Financial year starts (MM-DD)<input name="fy_start" value="${esc(o.fy_start)}"></label>
      <label class="f wide">Address (printed on invoices)<textarea name="address" rows="2">${esc(o.address)}</textarea></label></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" ${ME.can.settings ? '' : 'disabled'}>Save profile</button></div></form>
    ${canUsers ? `<div class="panel flush"><div class="row" style="padding:14px 16px"><h2 style="margin:0">Users</h2><span class="spacer"></span><button class="btn" id="adduser">+ Add user</button></div>
      ${table([{ h: 'Name', k: 'name' }, { h: 'Email', k: 'email' }, { h: 'Role', k: 'role' }, { h: 'Status', f: (u) => u.active ? badge('ok') : badge('cancelled') },
        { h: '', f: (u) => u.role === 'owner' ? '' : `<button class="btn sm" data-u="${u.id}" data-a="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` }], users.rows)}
      <div class="muted" style="padding:10px 16px">Roles: <b>admin</b> everything · <b>accountant</b> money, bills, reports · <b>store</b> stock, items, purchase · <b>sales</b> quotes, orders, invoices, khata.</div></div>` : ''}
    <form class="panel" id="pw"><h2>Change your password</h2><div class="err" hidden></div><div class="form"><label class="f">Current password<input type="password" name="current" autocomplete="current-password"></label>
      <label class="f">New password<input type="password" name="password" autocomplete="new-password" minlength="8"></label></div><div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn">Change password</button></div></form>
    <p class="muted">Selling SmartTrader to other businesses? <a href="#/admin">Open the admin panel</a> (needs the ADMIN_KEY secret).</p>
    ${canUsers ? `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Audit trail</h3></div>${table([{ h: 'When', f: (a) => new Date(a.at).toLocaleString('en-IN') }, { h: 'User', k: 'user' }, { h: 'Action', k: 'action' }, { h: 'Detail', k: 'detail', cls: 'hide-sm' }], audit.slice(0, 100))}</div>` : ''}`;
  $$('[name=mode]', el).forEach((r) => r.onchange = async () => {
    try { await api('PUT', '/api/org/mode', { mode: r.value }); ME = await GET('/api/me'); shell(); wireInstall(); toast(r.value === 'simple' ? 'Simple mode on' : 'Advanced features on'); render(); }
    catch (e) { alert(e.message); render(); }
  });
  const sub = (id, fn) => { $(id).onsubmit = async (e) => { e.preventDefault(); const b = $('.err', e.target); b.hidden = true; try { await fn(Object.fromEntries(new FormData(e.target))); } catch (err) { b.hidden = false; b.textContent = err.message; } }; };
  sub('#org', async (v) => { await api('PUT', '/api/org', v); ME = await GET('/api/me'); shell(); wireInstall(); toast('Profile saved'); render(); });
  sub('#pw', async (v) => { await POST('/api/me/password', v); toast('Password changed'); $('#pw').reset(); });
  if ($('#adduser')) $('#adduser').onclick = () => modal('Add user', [{ k: 'name', label: 'Name' }, { k: 'email', label: 'Email', type: 'email' },
    { k: 'role', label: 'Role', type: 'select', options: users.roles.filter((r) => r !== 'owner').map((r) => ({ v: r, t: r })) }, { k: 'password', label: 'Temporary password (8+ chars)', type: 'password' }],
  async (v) => { await POST('/api/users', v); toast('User added. Share the email and password with them.'); render(); });
  $$('[data-u]', el).forEach((b) => b.onclick = async () => { await api('PUT', '/api/users/' + b.dataset.u, { active: b.dataset.a !== '1' }); render(); });
});

/* ======================================================================= gate entry (inward) / gate pass (outward) */
route(/^gate\/(in|out)$/, async (el, m, q) => {
  const kind = m[1], inward = kind === 'in';
  const status = q.get('status') || (inward ? 'open' : '');
  const { rows } = await GET(`/api/gate?kind=${kind}&status=${status}`);
  el.innerHTML = head(inward ? 'Gate Entry (inward)' : 'Gate Pass (outward)', `<button class="btn primary" id="new">+ ${inward ? 'New gate entry' : 'New gate pass'}</button>`) + `
    <div class="tabs">${(inward ? [['open', 'At gate / not received'], ['grn_done', 'Received (GRN done)'], ['rejected', 'Rejected'], ['', 'All']] : [['', 'All'], ['open', 'Inside (not exited)'], ['closed', 'Exited']])
      .map(([k, t]) => `<a href="#/gate/${kind}${k ? '?status=' + k : (inward ? '?status=' : '')}" class="${status === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <p class="muted">${inward ? 'Log every vehicle at the gate before unloading. Then make the Goods Receipt (GRN) from the gate entry, so nothing is received without a gate record.'
      : 'Every dispatch leaves with a gate pass linked to its delivery note or invoice, with vehicle and exit time.'}</p>
    <div class="panel flush">${table([
      { h: 'No.', f: (r) => `<b>${esc(r.number)}</b><div class="muted">${fdate(r.date)} ${esc(r.time_in || '')}${r.time_out ? ' → ' + esc(r.time_out) : ''}</div>` },
      { h: inward ? 'Supplier' : 'Party', f: (r) => esc(r.party || '-') + (r.ref_number ? `<div class="muted">${esc(r.ref_type)} <a href="#/doc/${r.ref_doc_id}">${esc(r.ref_number)}</a></div>` : '') },
      { h: 'Vehicle', f: (r) => `${esc(r.vehicle_no)}<div class="muted">${esc(r.driver_name || '')} ${esc(r.driver_phone || '')}</div>` },
      { h: inward ? 'Challan / Invoice' : 'LR / Transporter', cls: 'hide-sm', f: (r) => inward ? `${esc(r.challan_no || '')}${r.packages ? `<div class="muted">${r.packages} pkgs${r.weight_kg ? ', ' + r.weight_kg + ' kg' : ''}</div>` : ''}` : `${esc(r.lr_no || '')}<div class="muted">${esc(r.transporter || '')}</div>` },
      { h: 'Status', f: (r) => r.status === 'grn_done' ? `${badge('closed')} <a href="#/doc/${r.grn_id}">${esc(r.grn_number || 'GRN')}</a>` : badge(r.status === 'open' ? (inward ? 'open' : 'partial') : r.status) },
      { h: '', f: (r) => r.status !== 'open' ? (r.time_out || !inward ? '' : `<button class="btn sm" data-exit="${r.id}">Vehicle out</button>`)
        : inward ? `<a class="btn sm primary" href="#/new/GRN?ge=${r.id}">Make GRN</a> <button class="btn sm danger" data-rej="${r.id}">Reject</button>`
          : `<button class="btn sm primary" data-exit="${r.id}">Vehicle out</button>` }],
    rows, { empty: inward ? 'No vehicles waiting at the gate.' : 'No gate passes yet.' })}</div>`;
  $$('[data-exit]', el).forEach((b) => b.onclick = async () => { await POST(`/api/gate/${b.dataset.exit}/exit`, {}); toast('Exit time saved'); render(); });
  $$('[data-rej]', el).forEach((b) => b.onclick = () => modal('Reject at gate', [{ k: 'reason', label: 'Reason (wrong item, damaged, no PO…)', wide: true }],
    async (v) => { await POST(`/api/gate/${b.dataset.rej}/reject`, v); toast('Rejected'); render(); }));
  $('#new').onclick = async () => {
    const parties = (await master('parties')).filter((p) => inward ? p.kind !== 'customer' : true);
    const refs = [];
    for (const t of inward ? ['PO'] : ['DN', 'INV']) refs.push(...(await GET(`/api/docs?type=${t}&limit=100`)).rows.filter((d) => d.status !== 'cancelled' && (!inward || d.status !== 'closed')));
    modal(inward ? 'New gate entry' : 'New gate pass', [
      { k: 'party_id', label: inward ? 'Supplier' : 'Party', type: 'select', options: [{ v: '', t: '—' }, ...opts(parties)] },
      { k: 'ref_doc_id', label: inward ? 'Against purchase order (optional)' : 'Against delivery note / invoice', type: 'select', options: [{ v: '', t: '—' }, ...refs.map((d) => ({ v: d.id, t: `${d.number} · ${d.party || ''}` }))] },
      { k: 'vehicle_no', label: 'Vehicle number', placeholder: 'RJ14GA1234' }, { k: 'driver_name', label: 'Driver name' }, { k: 'driver_phone', label: 'Driver mobile', type: 'tel' },
      ...(inward ? [{ k: 'challan_no', label: 'Supplier challan / invoice no.' }, { k: 'challan_date', label: 'Challan date', type: 'date' }] : []),
      { k: 'transporter', label: 'Transporter' }, { k: 'lr_no', label: 'LR / docket no.' },
      { k: 'packages', label: 'Packages / boxes', type: 'number', value: 0 }, { k: 'weight_kg', label: 'Weight (kg)', type: 'number', value: 0 },
      { k: 'date', label: 'Date', type: 'date', value: ME.today }, { k: 'by_hand', label: 'By hand / courier (no vehicle)', type: 'checkbox' },
      ...(!inward ? [{ k: 'exited', label: 'Vehicle has already left', type: 'checkbox' }] : []),
      { k: 'remarks', label: 'Remarks', wide: true }],
    async (v) => {
      const refSel = refs.find((d) => d.id === +v.ref_doc_id);
      if (refSel && !v.party_id) { const p = parties.find((x) => x.name === refSel.party); if (p) v.party_id = p.id; }
      const g = await POST('/api/gate', { ...v, kind, party_id: +v.party_id || null, ref_doc_id: +v.ref_doc_id || null });
      toast(`${g.number} saved`); render();
    }, { submit: 'Save' });
  };
});

/* ======================================================================= stock count (cycle count) */
route(/^stockcount$/, async (el, m, q) => {
  dirty('warehouses');
  const [whs, s] = await Promise.all([master('warehouses'), GET('/api/reports/stock')]);
  const wid = +q.get('wh') || (whs[0] && whs[0].id);
  const w = whs.find((x) => x.id === wid) || {};
  const rows = s.rows.map((r) => ({ ...r, here: ((r.warehouses || []).find((x) => x.warehouse === w.name) || { qty: 0 }).qty }));
  el.innerHTML = head('Stock Count', `<select id="wh" style="width:auto">${whs.map((x) => `<option value="${x.id}" ${x.id === wid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`) + `
    <p class="muted">Count the shelves and type what you find. Leave an item blank to skip it. On save, the differences are adjusted in stock and in the books (Stock Adjustments) in one go.</p>
    <div class="panel"><input id="search" placeholder="Filter items…" style="max-width:320px"></div>
    <form id="cf"><div class="err" hidden></div><div class="panel flush"><div class="tbl-wrap"><table class="t lines"><thead><tr><th>Item</th><th class="hide-sm">Bin</th><th class="num">System qty</th><th>Counted</th><th class="num">Difference</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-name="${esc(r.name.toLowerCase())}"><td><b>${esc(r.name)}</b><div class="muted">${esc(r.sku || '')}</div></td><td class="hide-sm">${esc((r.location || ''))}</td>
        <td class="num">${qtyf(r.here)} ${esc(r.unit)}</td><td class="c-n"><input type="number" step="any" min="0" name="c${r.id}" data-sys="${r.here}" data-id="${r.id}" inputmode="decimal"></td><td class="num" data-diff></td></tr>`).join('')}</tbody></table></div></div>
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

/* ======================================================================= payment reminders (bulk) */
route(/^reminders$/, async (el) => {
  const [ag, kh] = await Promise.all([GET('/api/reports/ageing?kind=receivable'), GET('/api/khata')]);
  let sent = {};
  try { sent = JSON.parse(sessionStorage.getItem('st-sent') || '{}'); } catch (e) { /* storage blocked */ }
  const mark = (k) => { sent[k] = 1; try { sessionStorage.setItem('st-sent', JSON.stringify(sent)); } catch (e) { /* ignore */ } };
  const khRows = kh.rows.filter((r) => r.balance > 0);
  const btns = (k) => `${sent[k] ? '<span class="badge b-paid">sent</span> ' : ''}<button class="btn sm got" data-wa="${k}">WhatsApp</button> <button class="btn sm" data-sms="${k}">SMS</button>`;
  el.innerHTML = head('Payment Reminders') + `${ME.org.upi_id ? '' : '<div class="panel warnbox">Add your <b>UPI ID</b> in <a href="#/settings">Business &amp; Users</a> so customers get a <b>Pay by UPI</b> button and QR in every message.</div>'}<p class="muted">Everyone who owes you money, oldest dues first. Tap WhatsApp to send a ready reminder with the bills, total and your UPI. Sent ones are marked for today.</p>
    <div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Invoice dues</h3><span class="badge">${ag.rows.length}</span></div>${table([
      { h: 'Customer', f: (r) => `<a href="#/party/${r.party_id}">${esc(r.party)}</a><div class="muted">${esc(r.phone || 'no mobile')}</div>` },
      { h: 'Overdue', num: 1, cls: 'hide-sm', f: (r) => inr(r.total - r.current) }, { h: 'Total due', num: 1, f: (r) => `<b>${inr(r.total)}</b>` }, { h: '', f: (r) => btns('p' + r.party_id) }],
    ag.rows.slice().sort((a, b) => (b.total - b.current) - (a.total - a.current)), { empty: 'No unpaid invoices.' })}</div>
    <div class="panel flush"><div class="row" style="padding:14px 16px 0"><h3>Khata dues</h3><span class="badge">${khRows.length}</span></div>${table([
      { h: 'Contact', f: (r) => `<a href="#/khata/${r.id}">${esc(r.name)}</a><div class="muted">${esc(r.phone || 'no mobile')}</div>` }, { h: 'Baaki', num: 1, f: (r) => `<b>${inr(r.balance)}</b>` },
      { h: '', f: (r) => btns('k' + r.id) }], khRows, { empty: 'No khata dues.' })}</div>`;
  const go2 = async (k, via, b) => {
    const w = via === 'wa' ? window.open('', '_blank') : null;
    try {
      const r = await GET(k[0] === 'p' ? `/api/parties/${k.slice(1)}/reminder` : `/api/khata/${k.slice(1)}/reminder`);
      const url = via === 'wa' ? r.whatsapp_url : r.sms_url;
      if (!url) { if (w) w.close(); return alert('Save a mobile number for this contact first.'); }
      if (w) w.location = url; else location.href = url;
      mark(k); b.closest('td').insertAdjacentHTML('afterbegin', '<span class="badge b-paid">sent</span> ');
    } catch (e) { if (w) w.close(); alert(e.message); }
  };
  $$('[data-wa]', el).forEach((b) => b.onclick = () => go2(b.dataset.wa, 'wa', b));
  $$('[data-sms]', el).forEach((b) => b.onclick = () => go2(b.dataset.sms, 'sms', b));
});

/* ======================================================================= pick list (by bin location) */
route(/^picklist\/(\d+)$/, async (el, m) => {
  const d = await GET('/api/docs/' + m[1]);
  const lines = d.lines.filter((l) => l.item_id && !l.is_service).map((l) => ({ ...l, pick: d.type === 'SO' ? l.remaining : l.qty }))
    .filter((l) => l.pick > 0.0005).sort((a, b) => (a.location || '~').localeCompare(b.location || '~', 'en', { numeric: true }) || a.item.localeCompare(b.item));
  el.innerHTML = head(`Pick list · ${esc(d.number)}`, `<a class="btn" href="#/doc/${d.id}">Back</a><button class="btn primary" onclick="print()">Print</button>`) + `
    <div class="doc-paper"><div class="hdr"><div><div style="font-size:18px;font-weight:700">PICK LIST</div><div>${esc(d.label)} ${esc(d.number)} · ${fdate(d.date)}</div></div>
      <div style="text-align:right"><b>${esc((d.party || {}).name || '')}</b><div>Godown: ${esc(d.warehouse || '')}</div></div></div>
      <div class="tbl-wrap"><table class="dl"><thead><tr><th>✓</th><th>Bin / rack</th><th>Item</th><th class="num">Qty to pick</th><th>Picked by</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td style="width:28px">☐</td><td><b>${esc(l.location || '—')}</b></td><td>${esc(l.item)}</td><td class="num"><b>${qtyf(l.pick)}</b> ${esc(l.unit || '')}</td><td style="width:120px"></td></tr>`).join('')}</tbody></table></div>
      <div class="foot"><div>Total lines: ${lines.length}</div><div class="sign">Checked by ____________</div></div></div>`;
});

/* ======================================================================= shared: downloads, UPI QR, scripts */
async function fileDownload(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* not json */ }
    if (res.status === 402 && confirm(msg + '\n\nOpen Plan & Billing now?')) go('plan'); else if (res.status !== 402) alert(msg);
    return;
  }
  const name = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'download';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Downloaded ' + name);
}
const upiLink = (vpa, name, amount, note) => `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(name)}${amount ? `&am=${(+amount).toFixed(2)}` : ''}&cu=INR${note ? `&tn=${encodeURIComponent(note)}` : ''}`;
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
            ${'BarcodeDetector' in window ? '<button class="btn" id="cam" title="Scan with camera">📷 Camera</button>' : ''}</div>
          <datalist id="pos-items">${items.map((i) => `<option value="${esc(i.name)}">${esc(labelCode(i))} · ${inr(i.sale_price)}</option>`).join('')}</datalist></div>
        <div class="panel flush" id="cart"></div>
      </div>
      <div class="panel pos-pay">
        <div class="totals" id="ptot" style="width:100%"></div>
        <div class="seg" id="method">${[['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Card / Bank'], ['credit', 'Credit (udhaar)']].map(([k, t]) => `<button type="button" data-m="${k}" class="${k === method ? 'on' : ''}">${t}</button>`).join('')}</div>
        <label class="f" id="recvw">Amount received (₹)<input id="recv" type="number" step="any" min="0"></label>
        <div id="change" class="muted"></div><div id="posqr"></div>${cfDefs('doc', 'sales').length ? `<div class="form">${cfInputs('doc', {}, 'sales')}</div>` : ''}
        <button class="btn primary big" id="done">Complete sale <span class="hide-sm">(F9)</span></button>
        <div class="err" id="perr" hidden></div>
      </div>
    </div>
`;
  const totals = () => {
    let taxable = 0, tax = 0;
    for (const l of cart) { const t = r2(l.qty * l.rate); taxable += t; tax += r2(t * l.gst_rate / 100); }
    return { taxable, tax, total: Math.round(taxable + tax) };
  };
  const draw = () => {
    $('#cart').innerHTML = cart.length ? `<table class="t lines"><thead><tr><th>Item</th><th>Qty</th><th class="num">Rate</th><th class="num">Amount</th><th></th></tr></thead><tbody>${cart.map((l, i) => `<tr>
        <td><b>${esc(l.name)}</b><div class="muted">${esc(l.code)} · GST ${l.gst_rate}% · stock ${qtyf(l.stock)}</div></td>
        <td class="c-n"><input type="number" step="any" min="0" value="${l.qty}" data-q="${i}"></td>
        <td class="num"><input type="number" step="any" min="0" value="${l.rate}" data-r="${i}" style="width:90px"></td>
        <td class="num">${inr(r2(l.qty * l.rate * (1 + l.gst_rate / 100)))}</td><td><button class="btn sm danger" data-x="${i}">&times;</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Scan an item to start the bill.</div>';
    const t = totals();
    $('#ptot').innerHTML = `<div><span>Items</span><span>${cart.reduce((s, l) => s + l.qty, 0)}</span></div><div><span>Taxable</span><span>${inr(t.taxable)}</span></div>
      <div><span>GST</span><span>${inr(t.tax)}</span></div><div class="grand"><span>Total</span><span>${inr(t.total)}</span></div>`;
    const recv = $('#recv');
    if (document.activeElement !== recv) recv.value = method === 'credit' ? '' : t.total || '';
    $('#recvw').hidden = method === 'credit';
    const ch = (+recv.value || 0) - t.total;
    $('#change').textContent = method === 'cash' && ch > 0 ? `Return change: ${inr(ch)}` : method === 'credit' ? 'The full amount goes to the customer’s account.' : '';
    if (method === 'upi' && t.total) upiQr($('#posqr'), ME.org, t.total, 'Bill', 'Customer scans to pay'); else $('#posqr').innerHTML = method === 'upi' ? '<p class="muted">Add your UPI ID in Settings to show a QR here.</p>' : '';
    if (method === 'upi' && !ME.org.upi_id) $('#posqr').innerHTML = '<p class="muted">Add your UPI ID in Settings to show a QR here.</p>';
  };
  const add = async (code) => {
    code = code.trim();
    if (!code) return;
    const lc = code.toLowerCase();
    let it = items.find((i) => i.name.toLowerCase() === lc || (i.barcode && i.barcode === code) || (i.sku && i.sku.toLowerCase() === lc) || ('st' + i.id) === lc);
    if (!it) { try { it = await GET('/api/items/lookup?code=' + encodeURIComponent(code)); } catch (e) { toast(e.message); beep(false); return; } }
    const line = cart.find((l) => l.item_id === it.id);
    if (line) line.qty = r2(line.qty + 1);
    else cart.push({ item_id: it.id, name: it.name, code: labelCode(it), qty: 1, rate: it.sale_price, gst_rate: it.gst_rate, stock: it.qty_on_hand, unit: it.unit });
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
  $('#method').onclick = (e) => { const m = e.target.dataset.m; if (!m) return; method = m; $$('#method button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); draw(); };
  $('#recv').oninput = draw;
  if ($('#cam')) $('#cam').onclick = () => cameraScan(add);
  const complete = async () => {
    const lines = cart.filter((l) => l.qty > 0);
    if (!lines.length) return toast('The bill is empty.');
    const t = totals(), btn = $('#done'); btn.disabled = true; $('#perr').hidden = true;
    const body = { type: 'INV', party_id: +$('#cust').value, warehouse_id: +$('#wh').value, date: ME.today, notes: 'POS sale', extra: cfRead($('.pos-pay')),
      lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate })) };
    if (method !== 'credit') body.payment = { amount: Math.min(+$('#recv').value || t.total, t.total), account_id: acc(method === 'upi' ? 'upi' : method === 'bank' ? 'bank' : 'cash') };
    try {
      const d = await POST('/api/docs', body);
      dirty('items', 'accounts', 'parties');
      printReceipt(d, method, +$('#recv').value || 0);
      cart.length = 0; draw(); scan.focus(); toast(`${d.number} saved`);
    } catch (err) { $('#perr').hidden = false; $('#perr').textContent = err.message; } finally { btn.disabled = false; }
  };
  $('#done').onclick = complete;
  const keys = (e) => { if (e.key === 'F9') { e.preventDefault(); complete(); } };
  document.addEventListener('keydown', keys);
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', keys), { once: true });
  draw(); scan.focus();
});
function beep(ok) {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator();
    o.frequency.value = ok ? 1400 : 300; o.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.07 : 0.25));
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 40, 80]);
  } catch (e) { /* no audio */ }
}
async function cameraScan(onCode) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal"><h2>Point the camera at a barcode</h2><video id="cv" playsinline muted style="width:100%;border-radius:8px;background:#000"></video>
    <div class="actions"><button class="btn" id="cx">Done</button></div></div></div>`;
  let stream, stop = false, last = '', lastAt = 0;
  const close = () => { stop = true; if (stream) stream.getTracks().forEach((t) => t.stop()); root.innerHTML = ''; };
  $('#cx').onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#cv'); v.srcObject = stream; await v.play();
    const det = new window.BarcodeDetector();
    const tick = async () => {
      if (stop) return;
      try {
        const codes = await det.detect(v);
        if (codes.length && (codes[0].rawValue !== last || Date.now() - lastAt > 1500)) { last = codes[0].rawValue; lastAt = Date.now(); await onCode(last); }
      } catch (e) { /* frame not ready */ }
      setTimeout(tick, 250);
    };
    tick();
  } catch (e) { close(); alert('Camera not available: ' + e.message); }
}
function printReceipt(d, method, received) {
  const o = d.org;
  let r = $('#receipt');
  if (!r) { r = document.createElement('div'); r.id = 'receipt'; r.className = 'receipt'; document.body.appendChild(r); }
  const P = o.print || {};
  r.innerHTML = `<div class="c">${d.logo_url ? `<img src="${esc(d.logo_url)}" alt="" style="max-height:40px;filter:grayscale(1)"><br>` : ''}<b>${esc(o.name)}</b><br>${esc(o.address || '')}${o.gstin ? `<br>GSTIN ${esc(o.gstin)}` : ''}${o.phone ? `<br>${esc(o.phone)}` : ''}</div>
    <div class="c">${esc(P.title || (o.gstin ? 'TAX INVOICE' : 'BILL'))}<br>${esc(d.number)} &middot; ${fdate(d.date)}</div>
    <table>${d.lines.map((l) => `<tr><td colspan="3">${esc(l.item || l.description)}</td></tr><tr><td>${qtyf(l.qty)} x ${inr(l.rate)}</td><td>${l.gst_rate}%</td><td class="r">${inr(l.total)}</td></tr>`).join('')}</table>
    <table><tr><td>Taxable</td><td class="r">${inr(d.taxable)}</td></tr>${d.igst ? `<tr><td>IGST</td><td class="r">${inr(d.igst)}</td></tr>` : `<tr><td>CGST</td><td class="r">${inr(d.cgst)}</td></tr><tr><td>SGST</td><td class="r">${inr(d.sgst)}</td></tr>`}
    ${d.round_off ? `<tr><td>Round off</td><td class="r">${inr(d.round_off)}</td></tr>` : ''}<tr class="g"><td>TOTAL</td><td class="r">${inr(d.total)}</td></tr>
    <tr><td>Paid (${esc(method)})</td><td class="r">${inr(d.paid)}</td></tr>${method === 'cash' && received > d.total ? `<tr><td>Change</td><td class="r">${inr(received - d.total)}</td></tr>` : ''}
    ${d.balance > 0 ? `<tr><td>Balance due</td><td class="r">${inr(d.balance)}</td></tr>` : ''}</table>
    ${P.show_upi !== false && o.upi_id && d.balance > 0 ? `<div class="c">UPI: ${esc(o.upi_id)}</div>` : ''}<div class="c">${esc(P.footer || 'Thank you! Visit again.')}</div>`;
  document.body.classList.add('print-receipt');
  setTimeout(() => { print(); document.body.classList.remove('print-receipt'); }, 50);
}

/* ======================================================================= barcode labels */
route(/^labels\/(\d+)$/, async (el, m, q) => {
  dirty('items');
  const it = (await master('items')).find((x) => x.id === +m[1]);
  if (!it) throw new Error('Item not found.');
  const n = Math.min(200, Math.max(1, +q.get('n') || 24)), code = labelCode(it);
  el.innerHTML = head(`Labels: ${esc(it.name)}`, `<form class="row" id="lf"><input name="n" type="number" min="1" max="200" value="${n}" style="width:90px"><button class="btn">Update</button></form><button class="btn primary" onclick="print()">Print labels</button>`) +
    `<p class="muted no-print">Code <b>${esc(code)}</b>. ${it.barcode || it.sku ? '' : 'This item has no barcode, so the label uses its built-in code; the POS screen recognises it.'} Use A4 label sheets or a label printer.</p>
    <div class="labels">${Array.from({ length: n }, () => `<div class="label"><div class="ln">${esc(it.name)}</div><svg class="bc"></svg><div class="lp">MRP ${inr(it.sale_price)}</div></div>`).join('')}</div>`;
  $('#lf').onsubmit = (e) => { e.preventDefault(); go(`labels/${it.id}?n=${e.target.n.value}`); };
  await loadScript('/vendor/JsBarcode.all.min.js');
  window.JsBarcode('.labels .bc', code, { format: 'CODE128', width: 1.3, height: 34, fontSize: 11, margin: 0, textMargin: 1 });
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
  const online = P.billing !== 'off';
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
      <li>Billing, stock, khata, POS, accounts</li>${p.features.includes('tally') ? '<li>Tally export</li>' : ''}${p.features.includes('einvoice') ? '<li>E-invoice & e-way bill</li>' : ''}${p.features.includes('priority') ? '<li>Priority support</li>' : ''}</ul>
      ${!p.price ? (p.key === cur.key ? '<div class="muted">Your plan</div>' : '') : !ME.can.settings ? '<div class="muted">Ask the owner to upgrade</div>'
        : online ? `<button class="btn primary big" data-buy="${p.key}">${p.key === cur.key ? (P.history.some((h) => h.status === 'paid') ? 'Renew 1 year' : 'Buy 1 year') : 'Upgrade'} · Pay ₹${p.pay.toLocaleString('en-IN')}</button>`
          : wa ? `<a class="btn primary" target="_blank" rel="noopener" href="${wa}">Upgrade on WhatsApp</a>` : '<div class="muted">Online payment coming soon</div>'}</div>`).join('')}</div>
    <p class="muted">Pay with UPI, card, netbanking or wallet through Razorpay. The plan starts the moment payment succeeds. Renewing the same plan adds a year to your current end date.</p>
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
    state('<div class="panel">Confirming your payment with Razorpay… <span class="spin"></span></div>');
    for (let i = 0; i < 45; i++) {
      const s = await GET('/api/billing/status?ref=' + ref).catch(() => null);
      if (s && s.status === 'paid') return done(s);
      if (s && s.status === 'amount_mismatch') return state(`<div class="panel err">The amount paid did not match the plan. Please contact us with payment ID ${esc(s.payment_id || '')}.</div>`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    state('<div class="panel warnbox">Payment is taking longer to confirm. If money was deducted, the plan switches on by itself within a few minutes; refresh this page later.</div>');
  };
  $$('[data-buy]', el).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const o = await POST('/api/billing/start', { plan: b.dataset.buy });
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
    } catch (e) { alert(e.message); } finally { b.disabled = false; }
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
  el.innerHTML = head('Admin: businesses', `<button class="btn" id="lock">Lock</button>`) + `
    <div class="panel ${pays.mode === 'off' ? 'warnbox' : ''}">Online payments: <b>${pays.mode === 'order' ? 'on (Razorpay order + signature)' : pays.mode === 'webhook' ? 'on (Razorpay webhook)' : 'OFF: add RAZORPAY_WEBHOOK_SECRET (or RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET) to the worker'}</b>.
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
  el.insertAdjacentHTML('beforeend', `<div class="panel flush"><div style="padding:14px 16px 0"><h3>Payments</h3></div>${table([
    { h: 'When', f: (r) => fdate((r.paid_at || r.created_at).slice(0, 10)) }, { h: 'Business', f: (r) => `${esc(r.business)}<div class="muted">${esc(r.email || '')}</div>` },
    { h: 'Plan', k: 'plan' }, { h: 'Amount', num: 1, f: (r) => inr(r.amount) }, { h: 'Status', f: (r) => badge(r.status === 'paid' ? 'paid' : 'unpaid') }, { h: 'Payment ID', k: 'payment_id', cls: 'hide-sm' }],
    pays.rows, { empty: 'No payments yet.' })}</div>`);
}
route(/^admin$/, adminPage);

/* ======================================================================= PWA: service worker + install button */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; const b = $('#install'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; const b = $('#install'); if (b) b.hidden = true; toast('SmartTrader installed'); });
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
window.addEventListener('offline', () => toast('You are offline. Saved screens still open; changes need internet.'));
window.addEventListener('online', () => toast('Back online'));

/* ======================================================================= boot */
async function boot() {
  // customer links, no login: /k/<token> khata statement, /i/<token> invoice (old #/k/ links still work)
  const pk = location.pathname.match(/^\/k\/([0-9a-f]{24})\/?$/) || location.hash.match(/^#\/k\/([0-9a-f]{24})$/);
  if (pk) return publicKhata(pk[1]);
  const pi = location.pathname.match(/^\/i\/([0-9a-f]{24})\/?$/);
  if (pi) return publicDoc(pi[1]);
  try { ME = await GET('/api/me'); } catch (e) {
    if (e.status === 401 && /^#\/admin/.test(location.hash)) {   // admin works with the ADMIN_KEY alone
      $('#app').innerHTML = '<main class="page" id="page"></main>';
      return adminPage($('#page'));
    }
    if (e.status === 401) return;
    const off = !navigator.onLine || e instanceof TypeError;
    $('#app').innerHTML = `<div class="boot"><h2>${off ? 'You are offline' : 'Could not load SmartTrader'}</h2>
      <p class="muted">${off ? 'Your business data lives safely in the cloud. Connect to the internet to continue.' : esc(e.message)}</p>
      <button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    if (off) window.addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  shell();
  wireInstall();
  await render();
}
window.addEventListener('hashchange', render);
boot();
