/* Shared helpers: HTTP, validation, money and GST maths, numbering. */

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'You do not have permission for this.') => new HttpError(403, msg);

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers),
  });
}

export async function readJson(request, max = 200000) {
  if (+(request.headers.get('Content-Length') || 0) > max) throw new HttpError(413, 'Request too large.');
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, 'Request too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw bad('Could not read the request (invalid JSON).'); }
}

/* ---------- validation ---------- */
export const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export function reqStr(v, name, max = 200) {
  const s = str(v, max);
  if (!s) throw bad(`${name} is required.`);
  return s;
}
export function num(v, name, { min = -1e12, max = 1e12, def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number.`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return n;
}
export const int = (v, name, opts) => Math.trunc(num(v, name, opts));
export function date(v, name = 'Date') {
  const s = str(v, 10) || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) throw bad(`${name} must be a date (YYYY-MM-DD).`);
  return s;
}
export const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // India time
export const nowIso = () => new Date().toISOString();
export function addDays(d, n) {
  const t = new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3);
  return t.toISOString().slice(0, 10);
}
export const oneOf = (v, list, name) => { if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`); return v; };

/* ---------- money ----------
   Amounts travel as rupees in the API (numbers with up to 2 decimals) and are stored as integer paise. */
export function round2(x) {               // Excel-style ROUND(x, 2): exact halves away from zero
  const y = x * 100, t = Math.trunc(y), f = Math.abs(y - t);
  const tol = 1e-9 * Math.max(1, Math.abs(y));
  return (Math.abs(f - 0.5) <= tol ? t + Math.sign(y) : Math.round(y)) / 100;
}
export const toPaise = (rupees) => Math.round(round2(Number(rupees) || 0) * 100);
export const toRupees = (p) => Math.round(p) / 100;
export const roundQty = (q) => Math.round(q * 1000) / 1000;

/* GST on one line. rate in paise per unit, discount and gst in percent.
   CGST + SGST always add up exactly to the line tax (no paisa lost to rounding). */
export function lineCalc({ qty, rate, discount_pct = 0, gst_rate = 0 }, interState) {
  const taxable = Math.round(qty * rate * (1 - discount_pct / 100));
  const tax = Math.round(taxable * gst_rate / 100);
  const igst = interState ? tax : 0;
  const cgst = interState ? 0 : Math.round(tax / 2);
  const sgst = interState ? 0 : tax - cgst;
  return { taxable, cgst, sgst, igst, total: taxable + tax };
}

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

/* ---------- numbering: PO-00001, INV-00001 ... per business ---------- */
export function counterStatements(db, orgId, key) {
  return db.prepare(`INSERT INTO counters (org_id, key, next) VALUES (?, ?, 2)
                     ON CONFLICT(org_id, key) DO UPDATE SET next = next + 1`).bind(orgId, key);
}
/* SQL that reads the number just reserved by counterStatements, inside the same batch */
export const counterValueSql = `(SELECT printf('%s-%05d', ?, next - 1) FROM counters WHERE org_id = ? AND key = ?)`;

export const uid = () => crypto.randomUUID();

/* ---------- tiny router ---------- */
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  match(method, path) {
    let allowed = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}
