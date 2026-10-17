/* Per-business customisation: print branding (logo, colour, layout, terms, bank, signature).
   Settings live as small JSON on the orgs row, which every request already loads, so reading them costs no extra query.
   Images (logo, signature) live in org_files and are fetched only by <img> tags, with an immutable cache. */
import { HttpError, bad, str } from './lib.js';

export const LAYOUTS = ['classic', 'modern', 'compact'];
export const FILE_KINDS = ['logo', 'signature'];
export const MAX_FILE = 64 * 1024;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];

const parse = (s, def) => { try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : def; } catch (e) { return def; } };

/* print settings with defaults filled in */
export function printOf(org) {
  const p = parse(org && org.print, {});
  return {
    layout: LAYOUTS.includes(p.layout) ? p.layout : 'classic', color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#0f766e',
    title: p.title || '', terms: p.terms || '', footer: p.footer || '', signatory: p.signatory || '', show_upi: p.show_upi !== false,
    bank_name: p.bank_name || '', bank_account: p.bank_account || '', bank_ifsc: p.bank_ifsc || '', bank_branch: p.bank_branch || '',
    logo: p.logo || '', signature: p.signature || '',
  };
}

/* validate a PUT body; the image hashes are kept from the current settings (they change only through file upload) */
export function cleanPrint(b, cur) {
  const layout = b.layout || 'classic';
  if (!LAYOUTS.includes(layout)) throw bad(`Layout must be one of: ${LAYOUTS.join(', ')}.`);
  const color = str(b.color, 7) || '#0f766e';
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw bad('Colour must look like #0f766e.');
  const ifsc = str(b.bank_ifsc, 11).toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad('IFSC code looks wrong. It has 11 characters, like SBIN0001234.');
  const account = str(b.bank_account, 20).replace(/\s+/g, '');
  if (account && !/^[0-9A-Za-z]{6,20}$/.test(account)) throw bad('Bank account number looks wrong.');
  return {
    layout, color: color.toLowerCase(), title: str(b.title, 40), terms: String(b.terms ?? '').replace(/\r/g, '').slice(0, 600).trim(),
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
  const S = seriesOf(org)[key];
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
