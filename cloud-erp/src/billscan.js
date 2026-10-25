/* Purchase bill scan: a photo or PDF of a supplier's bill is read by Claude into the supplier, bill number, date and
   lines, which are then matched to this business's suppliers (GSTIN, then name) and items (SKU / barcode / HSN and
   name), so the purchase bill opens filled in for the user to check and save. Nothing is saved here.
   Needs the ANTHROPIC_API_KEY secret (the operator's key; ANTHROPIC_BASE_URL only for tests). Each business may scan a
   limited number of bills a day. */
import Anthropic from '@anthropic-ai/sdk';
import { HttpError, bad, str } from './lib.js';
import { requireCan, rateLimit } from './auth.js';
import { planOf } from './saas.js';

export const scanConfigured = (env) => !!env.ANTHROPIC_API_KEY;
const DAILY = { free: 5, starter: 40, growth: 150, business: 400 };
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

const text = { type: 'string' }, number = { type: 'number' };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_bill', 'supplier', 'bill_no', 'bill_date', 'lines', 'totals', 'notes'],
  properties: {
    is_bill: { type: 'boolean' },
    supplier: { type: 'object', additionalProperties: false, required: ['name', 'gstin', 'phone', 'state', 'address'],
      properties: { name: text, gstin: text, phone: text, state: text, address: text } },
    bill_no: text,
    bill_date: text,
    lines: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'hsn', 'qty', 'unit', 'rate', 'discount_pct', 'gst_rate', 'amount', 'batch_no', 'expiry'],
      properties: { name: text, hsn: text, qty: number, unit: text, rate: number, discount_pct: number, gst_rate: number, amount: number, batch_no: text, expiry: text } } },
    totals: { type: 'object', additionalProperties: false, required: ['taxable', 'cgst', 'sgst', 'igst', 'round_off', 'total'],
      properties: { taxable: number, cgst: number, sgst: number, igst: number, round_off: number, total: number } },
    notes: text,
  },
};

const SYSTEM = `You read Indian purchase bills (GST tax invoices) that a shop received from its suppliers, from a photo or PDF, and return what is printed on them.
- supplier: the business that issued the bill (the seller), not the buyer. GSTIN is 15 characters; copy it exactly, else "".
- bill_no and bill_date (YYYY-MM-DD) as printed. Dates on Indian bills are day first (05/03/2026 is 5 March 2026).
- One entry in lines per item row. qty is the billed quantity; rate is the price per unit before GST (if the bill only shows a rate including GST, divide it out); discount_pct is the line discount in percent (0 if none); gst_rate is the total GST percent of the line (CGST + SGST, or IGST); amount is the line's taxable value. batch_no and expiry (YYYY-MM) only if printed (medicines, food), else "".
- totals as printed; 0 for anything not on the bill.
- Never guess a number you cannot read: use 0 (or "" for text) and say what was unclear in notes.
- is_bill is false if the picture is not a bill.`;

/* the bill as Claude reads it */
async function readBill(env, mime, data) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}), maxRetries: 1, timeout: 120000 });
  const file = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data } };
  let res;
  try {
    res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: [file, { type: 'text', text: 'Read this purchase bill.' }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Bill reading is busy right now. Try again in a minute.');
    if (e instanceof Anthropic.BadRequestError) throw bad('This file could not be read. Take a clearer photo of the whole bill, or use the PDF.');
    if (e instanceof Anthropic.APIError) { console.error('bill scan', e.status, e.message); throw new HttpError(502, 'Bill reading is not available right now. Try again later.'); }
    throw e;
  }
  if (res.stop_reason === 'refusal') throw bad('This file could not be read as a bill.');
  if (res.stop_reason === 'max_tokens') throw bad('This bill is too long to read in one go. Scan it a page at a time.');
  const out = res.content.find((b) => b.type === 'text');
  try { return JSON.parse(out ? out.text : ''); } catch (e) { throw new HttpError(502, 'The bill could not be read. Try again.'); }
}

/* how alike two item names are: shared words, ignoring sizes written differently */
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1);
function likeness(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

export async function scanBill(c, body) {
  requireCan(c.user, 'purchase');
  if (!scanConfigured(c.env)) throw new HttpError(501, 'Bill scanning is not set up on this server yet.');
  const m = String(body.file || '').match(/^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.includes(m[1])) throw bad('Choose a photo (JPG, PNG) or a PDF of the bill.');
  if (m[2].length > 7e6) throw bad('The file is too large. Use a photo under 5 MB.');
  await rateLimit(c.env, 'billscan:' + c.org.id, DAILY[planOf(c.org).key] || DAILY.free, 86400);
  const r = await readBill(c.env, m[1], m[2]);
  if (!r.is_bill) throw bad('This does not look like a bill. Take a photo of the whole bill, flat and in good light.');

  // supplier: same GSTIN, else the same or a similar name
  const gstin = str(r.supplier.gstin, 15).toUpperCase().replace(/\s/g, '');
  const { results: parties } = await c.db.prepare(`SELECT id, name, gstin, kind FROM parties WHERE org_id = ? AND kind != 'customer'`).bind(c.org.id).all();
  let party = gstin.length === 15 ? parties.find((p) => p.gstin && p.gstin.toUpperCase() === gstin) : null;
  if (!party) {
    const best = parties.map((p) => [p, likeness(p.name, r.supplier.name)]).sort((x, y) => y[1] - x[1])[0];
    if (best && best[1] >= 0.6) party = best[0];
  }
  // items: SKU or barcode printed as the name, else the closest name (HSN breaks ties)
  const { results: items } = await c.db.prepare(`SELECT id, name, sku, barcode, hsn, unit, gst_rate, purchase_price, track_batch FROM items WHERE org_id = ? AND is_service = 0`).bind(c.org.id).all();
  const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 200).map((l) => {
    const name = str(l.name, 120), hsn = str(l.hsn, 10).replace(/\D/g, '');
    let it = items.find((i) => (i.sku && i.sku.toLowerCase() === name.toLowerCase()) || (i.barcode && i.barcode === name) || i.name.toLowerCase() === name.toLowerCase());
    let match = it ? 'exact' : 'none';
    if (!it) {
      const best = items.map((i) => [i, likeness(i.name, name) + (hsn && i.hsn && i.hsn.replace(/\D/g, '').startsWith(hsn.slice(0, 4)) ? 0.15 : 0)]).sort((x, y) => y[1] - x[1])[0];
      if (best && best[1] >= 0.5) { it = best[0]; match = 'guess'; }
    }
    const qty = Math.max(0, +l.qty || 0), rate = Math.max(0, +l.rate || 0);
    return { name, hsn, qty, unit: str(l.unit, 12), rate: Math.round(rate * 100) / 100, discount_pct: Math.min(100, Math.max(0, +l.discount_pct || 0)),
      gst_rate: Math.max(0, +l.gst_rate || 0), amount: Math.round((+l.amount || 0) * 100) / 100, batch_no: str(l.batch_no, 40), expiry: /^\d{4}-\d{2}/.test(l.expiry || '') ? l.expiry.slice(0, 7) : '',
      item_id: it ? it.id : null, item: it ? it.name : '', match };
  });
  const t = r.totals || {};
  // the lines worked out again, to warn when what was read does not add up to the bill's total
  const calc = lines.reduce((s, l) => s + l.qty * l.rate * (1 - l.discount_pct / 100) * (1 + l.gst_rate / 100), 0);
  const total = Math.round((+t.total || 0) * 100) / 100;
  return {
    supplier: { name: str(r.supplier.name, 120), gstin, phone: str(r.supplier.phone, 20), state: str(r.supplier.state, 60), address: str(r.supplier.address, 300),
      party_id: party ? party.id : null, party: party ? party.name : '' },
    bill_no: str(r.bill_no, 40), bill_date: /^\d{4}-\d{2}-\d{2}$/.test(r.bill_date || '') ? r.bill_date : '',
    lines, totals: { taxable: +t.taxable || 0, cgst: +t.cgst || 0, sgst: +t.sgst || 0, igst: +t.igst || 0, round_off: +t.round_off || 0, total },
    calc_total: Math.round(calc * 100) / 100, adds_up: !total || Math.abs(calc - total) <= Math.max(2, total * 0.01), notes: str(r.notes, 500),
  };
}
