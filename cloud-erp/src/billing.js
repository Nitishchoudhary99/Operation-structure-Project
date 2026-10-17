/* Buying a plan online with Razorpay: the plan switches on by itself, no codes, no screenshots.
   Same setup as docbrisk.com's Pro keys, so one Razorpay account serves both sites.

   ORDER WAY (best): Worker secrets RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
     POST /api/billing/start  -> Razorpay order created here, the page opens Razorpay Checkout
     POST /api/billing/verify -> the payment signature is checked, the plan is switched on
   WEBHOOK WAY (no Key Secret needed): Worker secret RAZORPAY_WEBHOOK_SECRET, and in the Razorpay
     dashboard: Settings -> Webhooks -> Add -> https://erp.docbrisk.com/api/billing/webhook,
     event payment.captured, secret = the same text. The page pays with the public key id.
     POST /api/billing/start   -> a payment reference is saved
     POST /api/billing/webhook -> Razorpay confirms the payment, the plan is switched on
     GET  /api/billing/status  -> the page waits for that
   With both set, the webhook is a safety net for a browser that closed before /verify.
   Every payment carries notes.product = 'smarttrader-erp'; payments for other products are ignored. */
import { HttpError, bad, notFound, nowIso } from './lib.js';
import { PLANS, extendPlan } from './saas.js';

export const PRODUCT = 'smarttrader-erp';
const PUBLIC_KEY_ID = 'rzp_live_Tbn7nsYH0g4Q8e';   // docbrisk.com's public Razorpay key id (public by design)
const GST = 0.18;

export function billingMode(env) {
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) return 'order';
  if (env.RAZORPAY_WEBHOOK_SECRET) return 'webhook';
  return 'off';
}
const keyId = (env) => String(env.RAZORPAY_KEY_ID || PUBLIC_KEY_ID).trim();
/* Plan prices are before GST; the customer pays the price plus 18% GST, rounded to the rupee. */
export const grossPaise = (plan) => Math.round(PLANS[plan].price * (1 + GST)) * 100;

const enc = new TextEncoder();
async function hmacHex(secret, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomRef = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/* Switches the plan on for a paid record, once. Returns the record as it is now. */
async function activate(db, rec, paymentId, paidPaise) {
  if (rec.status === 'paid') return rec;
  if (paidPaise !== undefined && +paidPaise !== +rec.paise) {
    await db.prepare(`UPDATE billing_orders SET status = 'amount_mismatch', payment_id = ? WHERE id = ? AND status != 'paid'`).bind(paymentId, rec.id).run();
    return { ...rec, status: 'amount_mismatch', payment_id: paymentId };
  }
  // claim the record first, so two deliveries (webhook + verify, or a repeated webhook) switch it on only once
  const claim = await db.prepare(`UPDATE billing_orders SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status != 'paid'`)
    .bind(paymentId, nowIso(), rec.id).run();
  if (!claim.meta.changes) return { ...rec, status: 'paid' };
  const org = await db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(rec.org_id).first();
  const until = await extendPlan(db, org, rec.plan, rec.months);
  await db.prepare(`UPDATE billing_orders SET plan_until = ? WHERE id = ?`).bind(until, rec.id).run();
  await db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, 'plan paid', ?)`)
    .bind(rec.org_id, rec.user_id, nowIso(), `${rec.plan} ${rec.months} months, ${rec.paise / 100} INR, ${paymentId}`).run();
  return { ...rec, status: 'paid', payment_id: paymentId, plan_until: until };
}

/* POST /api/billing/start { plan } */
export async function billingStart(c) {
  const mode = billingMode(c.env);
  if (mode === 'off') throw new HttpError(503, 'Online payment is not switched on yet. Please contact us on WhatsApp to upgrade.');
  const plan = String(c.body.plan || '');
  if (!PLANS[plan] || plan === 'free') throw bad('Please choose a plan.');
  const months = 12, paise = grossPaise(plan), ref = randomRef();
  const owner = await c.db.prepare(`SELECT email, name FROM users WHERE id = ?`).bind(c.user.id).first();
  const notes = { product: PRODUCT, ref, org: String(c.org.id), plan };
  let orderId = null;
  if (mode === 'order') {
    let r, o = null;
    try {
      r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(c.env.RAZORPAY_KEY_ID + ':' + c.env.RAZORPAY_KEY_SECRET) },
        body: JSON.stringify({ amount: paise, currency: 'INR', receipt: 'erp-' + ref.slice(0, 20), notes }),
      });
      o = await r.json();
    } catch (e) { o = null; }
    if (!r || !r.ok || !o || !o.id) throw new HttpError(502, 'The payment could not be started. Please try again.');
    orderId = o.id;
  }
  await c.db.prepare(`INSERT INTO billing_orders (org_id, user_id, ref, order_id, plan, months, paise, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?)`)
    .bind(c.org.id, c.user.id, ref, orderId, plan, months, paise, nowIso()).run();
  return {
    mode, ref, key_id: keyId(c.env), order_id: orderId, amount: paise, currency: 'INR', notes,
    description: `SmartTrader ERP ${PLANS[plan].label} - 1 year (incl. GST)`, name: owner && owner.name, email: owner && owner.email, business: c.org.name,
  };
}

/* POST /api/billing/verify { ref, razorpay_order_id, razorpay_payment_id, razorpay_signature }: order way only */
export async function billingVerify(c) {
  if (billingMode(c.env) !== 'order') throw bad('Payments are confirmed by Razorpay directly. Please wait a moment.');
  const b = c.body;
  const orderId = String(b.razorpay_order_id || ''), payId = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '').toLowerCase();
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(payId)) throw bad('The payment details are incomplete.');
  if (!same(await hmacHex(c.env.RAZORPAY_KEY_SECRET, orderId + '|' + payId), sig)) {
    throw bad(`The payment could not be confirmed. If money was deducted, contact us with payment ID ${payId}.`);
  }
  const rec = await c.db.prepare(`SELECT * FROM billing_orders WHERE order_id = ? AND org_id = ?`).bind(orderId, c.org.id).first();
  if (!rec) throw notFound(`This order was not found. Contact us with payment ID ${payId}.`);
  // the signature proves Razorpay took exactly the amount of this order
  return statusOut(await activate(c.db, rec, payId));
}

/* POST /api/billing/webhook: called by Razorpay. Body signed with RAZORPAY_WEBHOOK_SECRET. */
export async function billingWebhook(c) {
  const secret = c.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'The webhook is not set up.');
  const sig = String(c.request.headers.get('x-razorpay-signature') || '').trim().toLowerCase();
  if (!sig || !same(await hmacHex(secret, c.raw || ''), sig)) throw new HttpError(401, 'Bad signature.');
  const ev = c.body || {};
  const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  // anything that is not ours gets a 200, so Razorpay does not keep retrying it
  if (!pay || !['payment.captured', 'order.paid'].includes(ev.event)) return { ok: true, ignored: 'event' };
  const notes = pay.notes || {};
  if (notes.product !== PRODUCT) return { ok: true, ignored: 'another product' };
  const ref = String(notes.ref || '');
  if (!/^[0-9a-f]{32}$/.test(ref)) return { ok: true, ignored: 'no reference' };
  const rec = await c.db.prepare(`SELECT * FROM billing_orders WHERE ref = ?`).bind(ref).first();
  if (!rec) return { ok: true, ignored: 'unknown reference' };
  if (String(pay.currency || 'INR').toUpperCase() !== 'INR') return { ok: true, ignored: 'currency' };
  const out = await activate(c.db, rec, String(pay.id || '').slice(0, 60), pay.amount);
  return { ok: true, status: out.status };
}

const statusOut = (r) => ({ ref: r.ref, status: r.status, plan: r.plan, plan_until: r.plan_until || null, payment_id: r.payment_id || null, amount: r.paise / 100 });

/* GET /api/billing/status?ref= : the page waits here after Checkout closes */
export async function billingStatus(c) {
  const ref = String(c.url.searchParams.get('ref') || '');
  const rec = await c.db.prepare(`SELECT * FROM billing_orders WHERE ref = ? AND org_id = ?`).bind(ref, c.org.id).first();
  if (!rec) throw notFound('Payment not found.');
  return statusOut(rec);
}

export async function billingHistory(c) {
  const { results } = await c.db.prepare(`SELECT ref, plan, months, paise, status, payment_id, created_at, paid_at, plan_until FROM billing_orders
      WHERE org_id = ? AND status != 'created' ORDER BY id DESC LIMIT 50`).bind(c.org.id).all();
  return results.map((r) => ({ ...r, amount: r.paise / 100 }));
}
