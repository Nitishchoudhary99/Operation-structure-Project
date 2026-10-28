/* Per-business customisation: print branding (logo, colour, layout, terms, bank, signature).
   Settings live as small JSON on the orgs row, which every request already loads, so reading them costs no extra query.
   Images (logo, signature) live in org_files and are fetched only by <img> tags, with an immutable cache. */
import { HttpError, bad, str, own } from './lib.js';

/* Invoice designs. compact / compact58 are thermal-roll receipts (80 / 58 mm); gst adds the HSN-wise tax summary. */
export const LAYOUTS = ['classic', 'modern', 'elegant', 'bold', 'minimal', 'gst', 'compact', 'compact58'];
export const FONTS = ['sans', 'serif'];
export const FILE_KINDS = ['logo', 'signature'];
export const MAX_FILE = 64 * 1024;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];

const parse = (s, def) => { try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : def; } catch (e) { return def; } };

/* print settings with defaults filled in */
export function printOf(org) {
  const p = parse(org && org.print, {});
  return {
    layout: LAYOUTS.includes(p.layout) ? p.layout : 'classic', color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#0f766e',
    font: FONTS.includes(p.font) ? p.font : 'sans',
    title: p.title || '', terms: p.terms || '', footer: p.footer || '', signatory: p.signatory || '', show_upi: p.show_upi !== false,
    bank_name: p.bank_name || '', bank_account: p.bank_account || '', bank_ifsc: p.bank_ifsc || '', bank_branch: p.bank_branch || '',
    logo: /^[0-9a-f]{16}$/.test(p.logo || '') ? p.logo : '', signature: /^[0-9a-f]{16}$/.test(p.signature || '') ? p.signature : '',
  };
}

/* validate a PUT body; the image hashes are kept from the current settings (they change only through file upload) */
export function cleanPrint(b, cur) {
  const layout = b.layout || 'classic';
  if (!LAYOUTS.includes(layout)) throw bad(`Layout must be one of: ${LAYOUTS.join(', ')}.`);
  const color = str(b.color, 7) || '#0f766e';
  const font = b.font || 'sans';
  if (!FONTS.includes(font)) throw bad(`Font must be one of: ${FONTS.join(', ')}.`);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw bad('Colour must look like #0f766e.');
  const ifsc = str(b.bank_ifsc, 11).toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad('IFSC code looks wrong. It has 11 characters, like SBIN0001234.');
  const account = str(b.bank_account, 20).replace(/\s+/g, '');
  if (account && !/^[0-9A-Za-z]{6,20}$/.test(account)) throw bad('Bank account number looks wrong.');
  return {
    layout, font, color: color.toLowerCase(), title: str(b.title, 40), terms: String(b.terms ?? '').replace(/\r/g, '').slice(0, 600).trim(),
    footer: str(b.footer, 160), signatory: str(b.signatory, 60), show_upi: b.show_upi !== false && b.show_upi !== 'false' && b.show_upi !== 0,
    bank_name: str(b.bank_name, 60), bank_account: account, bank_ifsc: ifsc, bank_branch: str(b.bank_branch, 60),
    logo: cur.logo, signature: cur.signature,
  };
}

/* data:image/png;base64,... -> { mime, b64, size } with the size limit */
export function imageFromDataUrl(s) {
  const m = String(s || '').match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !MIMES.includes(m[1])) throw bad('Upload a PNG, JPG or WebP image.');
  const size = Math.floor(m[2].length * 3 / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (size > MAX_FILE) throw new HttpError(413, 'Image is too big. Keep it under 64 KB.');
  return { mime: m[1], b64: m[2], size };
}
export async function shortHash(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function imageResponse(row) {
  const bin = atob(row.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
}

/* ---------- document numbering: prefix with {FY} {YY} {YYYY}, padding, optional yearly reset ----------
   series JSON on orgs: { INV: { prefix: 'SHT/{FY}/', pad: 4, fy_reset: 1 }, receipt: {...} }.
   No entry = the old default (INV-00001), counted under the same counter key as before. */
export const seriesOf = (org) => parse(org && org.series, {});

export function fyParts(org, d) {
  const [mm, dd] = String((org && org.fy_start) || '04-01').split('-');
  let y = +d.slice(0, 4);
  if (d < `${y}-${mm}-${dd}`) y--;
  const yy = (n) => String(n % 100).padStart(2, '0');
  return { fy: `${yy(y)}-${yy(y + 1)}`, yy: yy(y), yyyy: String(y) };
}
export const expandPrefix = (tpl, org, d) => {
  const f = fyParts(org, d);
  return tpl.replace(/\{FY\}/g, f.fy).replace(/\{YYYY\}/g, f.yyyy).replace(/\{YY\}/g, f.yy);
};
/* counter key and printf format for the next number of `key` (a doc type, or receipt / payment) on date d */
export function numberSpec(org, key, defPrefix, d) {
  const S = own(seriesOf(org), key);
  if (!S || typeof S.prefix !== 'string') return { key, fmt: `${defPrefix}-%05d` };
  return { key: S.fy_reset ? `${key}|${fyParts(org, d).fy}` : key, fmt: `${expandPrefix(S.prefix, org, d)}%0${S.pad || 5}d` };
}
export const formatNumber = (spec, n) => spec.fmt.replace(/%0(\d)d$/, (_, w) => String(n).padStart(+w, '0'));

/* validate one series; `next` (optional) is the number the next document should get */
export function cleanSeries(b, org, d) {
  const prefix = str(b.prefix, 20);
  if (!/^[A-Za-z0-9/-]*$/.test(prefix.replace(/\{(FY|YY|YYYY)\}/g, ''))) throw bad('Prefix can use only letters, numbers, / and -, plus {FY}, {YY} or {YYYY}.');
  const pad = Math.trunc(Number(b.pad ?? 5));
  if (!(pad >= 1 && pad <= 8)) throw bad('Digits must be between 1 and 8.');
  const fy_reset = b.fy_reset === true || b.fy_reset === 1 || b.fy_reset === '1' || b.fy_reset === 'true' ? 1 : 0;
  if (fy_reset && !/\{(FY|YY|YYYY)\}/.test(prefix)) throw bad('A series that restarts every year needs {FY}, {YY} or {YYYY} in the prefix, so numbers stay unique.');
  let next = null;
  if (b.next !== undefined && b.next !== null && b.next !== '') {
    next = Math.trunc(Number(b.next));
    if (!(next >= 1 && next <= 99999999)) throw bad('Next number must be between 1 and 99999999.');
  }
  const longest = expandPrefix(prefix, org, d).length + Math.max(pad, String(next || 1).length);
  if (longest > 16) throw bad(`The number would be ${longest} characters. GST allows at most 16. Use a shorter prefix or fewer digits.`);
  if (!prefix && pad < 3) throw bad('Without a prefix, use at least 3 digits.');
  return { prefix, pad, fy_reset, next };
}

/* ---------- custom fields on items, parties and documents ----------
   Definitions: JSON array on orgs.fields: { id, entity, key, label, type, options[], required, on_print, side }.
   Values: JSON object in the row's `extra` column, keyed by field key. */
export const ENTITIES = ['item', 'party', 'doc'];
export const FIELD_TYPES = ['text', 'number', 'date', 'select'];
export const MAX_FIELDS = 15;
/* A key is made from the label (cleanField), so it is always lower-case letters, digits and _. A definition that is not
   (a restored backup file is written by hand as easily as by the app) is dropped here, before anything uses it. */
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const fieldOk = (f) => f && typeof f === 'object' && typeof f.key === 'string' && FIELD_KEY.test(f.key) && ENTITIES.includes(f.entity)
  && FIELD_TYPES.includes(f.type) && typeof f.label === 'string' && (f.type !== 'select' || Array.isArray(f.options));
export const fieldsOf = (org) => {
  const a = parse(org && org.fields, []);
  return Array.isArray(a) ? a.filter(fieldOk).map((f) => ({ ...f, label: f.label.slice(0, 40),
    options: Array.isArray(f.options) ? f.options.map((o) => String(o).slice(0, 40)).slice(0, 30) : [] })) : [];
};
export const extraOf = (s) => parse(s, {});

export function cleanField(b, defs, cur) {
  const entity = cur ? cur.entity : b.entity;
  if (!ENTITIES.includes(entity)) throw bad('Choose where the field is used: item, party or document.');
  const label = str(b.label, 40);
  if (!label) throw bad('Field name is required.');
  const type = b.type || 'text';
  if (!FIELD_TYPES.includes(type)) throw bad(`Type must be one of: ${FIELD_TYPES.join(', ')}.`);
  const options = type === 'select'
    ? [...new Set((Array.isArray(b.options) ? b.options : String(b.options || '').split(',')).map((o) => str(o, 40)).filter(Boolean))].slice(0, 30) : [];
  if (type === 'select' && options.length < 2) throw bad('A dropdown needs at least 2 options, separated by commas.');
  const same = defs.filter((f) => f.entity === entity && (!cur || f.id !== cur.id));
  if (same.some((f) => f.label.toLowerCase() === label.toLowerCase())) throw bad(`There is already a field called ${label}.`);
  if (!cur && same.length >= MAX_FIELDS) throw bad(`At most ${MAX_FIELDS} custom fields per type.`);
  let key = cur ? cur.key : (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field').slice(0, 20);
  if (!cur) {
    if (!/^[a-z]/.test(key)) key = 'f_' + key;
    const base = key; let n = 2;
    while (defs.some((f) => f.entity === entity && f.key === key)) key = `${base}_${n++}`;
  }
  const side = entity === 'doc' && ['sales', 'purchase'].includes(b.side) ? b.side : '';
  const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
  return { id: cur ? cur.id : Math.max(0, ...defs.map((f) => f.id || 0)) + 1, entity, key, label, type, options, required: flag(b.required), on_print: flag(b.on_print), side };
}

/* the custom values a write may store: unknown keys dropped, types converted, required and dropdown checked */
export function cleanExtra(defs, entity, input, side = '') {
  const src = input && typeof input === 'object' ? input : {}, out = {};
  for (const f of defs) {
    if (f.entity !== entity || (side && f.side && f.side !== side)) continue;
    let v = own(src, f.key);
    if (v === undefined || v === null || String(v).trim() === '') { if (f.required) throw bad(`${f.label} is required.`); continue; }
    if (f.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw bad(`${f.label} must be a number.`); }
    else if (f.type === 'date') { v = str(v, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${f.label} must be a date.`); }
    else if (f.type === 'select') { v = str(v, 40); if (!f.options.includes(v)) throw bad(`${f.label}: choose one of ${f.options.join(', ')}.`); }
    else v = str(v, 200);
    out[f.key] = v;
  }
  const s = JSON.stringify(out);
  if (s.length > 4096) throw bad('Custom fields are too long.');
  return s;
}

/* SQL conditions for ?cf.<key>=value filters. The JSON path is a bound value too, never part of the SQL text. */
export function extraFilter(defs, entity, params, col) {
  const where = [], args = [];
  for (const [k, raw] of params) {
    const f = k.startsWith('cf.') && raw !== '' && defs.find((x) => x.entity === entity && x.key === k.slice(3));
    if (!f || !FIELD_KEY.test(f.key)) continue;
    const path = `json_extract(${col}, ?)`;
    if (f.type === 'text') { where.push(`${path} LIKE ?`); args.push('$.' + f.key, `%${str(raw, 100)}%`); }
    else { where.push(`${path} = ?`); args.push('$.' + f.key, f.type === 'number' ? Number(raw) : str(raw, 40)); }
  }
  return { sql: where.map((w) => ' AND ' + w).join(''), args };
}

/* fields marked "show on print", as label/value pairs */
export const printExtra = (defs, entity, extra, side = '') => {
  const x = typeof extra === 'string' ? extraOf(extra) : extra || {};
  return defs.filter((f) => f.entity === entity && f.on_print && (!side || !f.side || f.side === side) && own(x, f.key) !== undefined && own(x, f.key) !== '')
    .map((f) => ({ label: f.label, value: f.type === 'date' ? String(own(x, f.key)).split('-').reverse().join('-') : String(own(x, f.key)) }));
};
