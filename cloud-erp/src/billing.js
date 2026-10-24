/* Buying a plan online: the plan switches on by itself, no codes, no screenshots.

   MAIN WAY: DocBrisk Pay (automatic UPI, our own hub in the docbrisk-api worker).
     Worker var PAYHUB_URL (the hub address) + secret PAYHUB_SECRET (the same text as on the hub).
     POST /api/billing/start        -> the hub gives this checkout a unique amount (e.g. Rs 5309.07), UPI links and QR text
     POST /api/billing/upi-callback -> the hub says "paid" (HMAC signed); the plan is switched on
     GET  /api/billing/status       -> the page waits here; if the callback is late, a signed status call to the hub heals it
     POST /api/billing/upi-claim    -> the buyer types the 12-digit UPI Ref; the hub checks it against bank-signed credits
     The browser only ever talks to this worker, never to the hub.

   OPTIONAL: Razorpay (card / netbanking), only when its keys are set. Same setup as docbrisk.com's Pro keys.
     ORDER WAY: secrets RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
       POST /api/billing/start { method:'razorpay' } -> Razorpay order created here, the page opens Razorpay Checkout
       POST /api/billing/verify -> the payment signature is checked, the plan is switched on
     WEBHOOK WAY (no Key Secret needed): secret RAZORPAY_WEBHOOK_SECRET, and in the Razorpay dashboard:
       Settings -> Webhooks -> Add -> https://erp.docbrisk.com/api/billing/webhook, event payment.captured, secret = the same text.
       POST /api/billing/webhook -> Razorpay confirms the payment, the plan is switched on
     With both set, the webhook is a safety net for a browser that closed before /verify.
     Every payment carries notes.product = 'smarttrader-erp'; payments for other products are ignored.

   Every way ends in activate(): it claims the billing_orders row first, so a plan is extended exactly once per checkout. */
import { HttpError, bad, notFound, nowIso } from './lib.js';
import { PLANS, extendPlan } from './saas.js';
export const PRODUCT = 'smarttrader-erp';
const PUBLIC_KEY_ID = 'rzp_live_Tbn7nsYH0g4Q8e';   // docbrisk.com's public Razorpay key id (public by design)
const GST = 0.18;

/* Razorpay on its own: 'order' | 'webhook' | 'off' */
export function razorpayMode(env) {
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) return 'order';
  if (env.RAZORPAY_WEBHOOK_SECRET) return 'webhook';
  return 'off';
}
/* DocBrisk Pay is on when the hub address (or a service binding to it) and the shared secret are set. */
const hubSecret = (env) => String(env.PAYHUB_SECRET || '').trim();
export const hubOn = (env) => !!((env.PAYHUB_URL || (env.PAYHUB_API && env.PAYHUB_API.fetch)) && hubSecret(env));
/* The main way to pay: 'upi' | 'order' | 'webhook' | 'off' */
/* Razorpay is the main way while UPI-auto is not fully live (its checkout takes UPI too). Variable PAY_PRIMARY=upi puts DocBrisk Pay
   first again. Razorpay leads only when it can confirm by itself (Key Secret or webhook secret set). */
const rzpFirst = (env) => String(env.PAY_PRIMARY || 'razorpay').toLowerCase() === 'razorpay' && razorpayMode(env) !== 'off';
export function billingMode(env) { return hubOn(env) && !rzpFirst(env) ? 'upi' : razorpayMode(env); }
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
const sha256hex = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
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

/* ---------------------------------------------------------------- DocBrisk Pay hub (server to server)
   Request signing (hub spec 10.1): X-PayHub-Sig = v1=HMAC(secret, ts \n METHOD \n path?query \n sha256hex(body)).
   Returns { status, data }; status 0 = the hub could not be reached. */
export async function hubFetch(env, method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const url = new URL(String(env.PAYHUB_URL || 'https://payhub.internal').trim().replace(/\/+$/, '') + path);
  const ts = String(Date.now());
  const sig = 'v1=' + await hmacHex(hubSecret(env), ts + '\n' + method + '\n' + url.pathname + url.search + '\n' + await sha256hex(raw));
  const init = { method, headers: { 'Content-Type': 'application/json', 'X-PayHub-Key': PRODUCT, 'X-PayHub-Ts': ts, 'X-PayHub-Sig': sig } };
  if (method !== 'GET') init.body = raw;
  try {
    const svc = env.PAYHUB_API;   // optional service binding to the docbrisk-api worker (same Cloudflare account)
    const res = await (svc && svc.fetch ? svc.fetch(url.toString(), init) : fetch(url.toString(), init));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: {} }; }
}
const hubPath = (id, act) => `/api/pay/hub/orders/${encodeURIComponent(id)}${act ? '/' + act : ''}`;

/* Callback signing (hub spec 10.2): X-PayHub-Sig = v1=HMAC(secret, ts + "." + rawBody), ts within 10 minutes. */
async function hubCallbackOk(env, headers, raw) {
  const ts = Number(headers.get('X-PayHub-Ts') || 0), secret = hubSecret(env);
  if (!secret || !Number.isFinite(ts) || !ts || Math.abs(Date.now() - ts) > 600000) return false;
  return same(String(headers.get('X-PayHub-Sig') || '').trim(), 'v1=' + await hmacHex(secret, ts + '.' + raw));
}

/* The UPI part of a checkout, as the page needs it (from the hub's order reply) */
const upiOut = (h) => ({
  order_id: h.order_id, amount_paise: h.amount_paise, amount: h.amount, base: h.base, vpa: h.vpa, payee: h.payee, note: h.note,
  upi_link: h.upi_link, qr_text: h.qr_text, app_links: h.app_links, vpa_kind: h.vpa_kind, created_at: h.created_at, expires_at: h.expires_at,
  hold_until: h.hold_until, server_time: h.server_time,
});

/* POST /api/billing/start { plan, method? }: method 'razorpay' asks for card / netbanking; anything else means the main way */
export async function billingStart(c) {
  const rzp = razorpayMode(c.env), upi = hubOn(c.env);
  const plan = String(c.body.plan || '');
  if (!Object.hasOwn(PLANS, plan) || plan === 'free') throw bad('Please choose a plan.');
  const wantRzp = c.body.method === 'razorpay';
  if (wantRzp && rzp === 'off') throw bad('Card payment is not available. Please pay by UPI.');
  if (!wantRzp && upi && !rzpFirst(c.env)) {
    const out = await upiStart(c, plan);
    if (out) return out;
    // the hub is not ready or busy: card / netbanking if Razorpay is set up, otherwise ask to retry
    if (rzp === 'off') throw new HttpError(503, 'UPI payment is busy right now. Please try again in a minute.');
  }
  if (rzp === 'off') throw new HttpError(503, 'Online payment is not switched on yet. Please contact us on WhatsApp to upgrade.');
  return razorpayStart(c, plan, rzp);
}

/* A checkout through DocBrisk Pay. Returns null when the hub cannot take it now (not set up, busy, down). */
async function upiStart(c, plan) {
  const months = 12, paise = grossPaise(plan), ref = randomRef();
  // the row exists before the hub knows the ref, so a callback can always find it
  await c.db.prepare(`INSERT INTO billing_orders (org_id, user_id, ref, plan, months, paise, status, created_at, method) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, 'upi')`)
    .bind(c.org.id, c.user.id, ref, plan, months, paise, nowIso()).run();
  const owner = await c.db.prepare(`SELECT email FROM users WHERE id = ?`).bind(c.user.id).first();
  const r = await hubFetch(c.env, 'POST', '/api/pay/hub/orders', {
    product: PRODUCT, client_ref: ref, base_paise: paise, plan, label: `SmartTrader ${PLANS[plan].label} 12 months`,
    buyer: { email: (owner && owner.email) || undefined, name: String(c.org.name || '').slice(0, 80), ip: c.request.headers.get('CF-Connecting-IP') || undefined },
  });
  const h = r.data || {};
  if (r.status === 429 && h.code === 'too_many_open' && razorpayMode(c.env) === 'off') throw new HttpError(429, 'Too many open payments. Finish or close one, then try again.');
  if (!(r.status === 200 || r.status === 201) || !h.order_id || !h.qr_text || !Number.isInteger(h.amount_paise)) return null;
  await c.db.prepare(`UPDATE billing_orders SET hub_id = ?, pay_paise = ?, pay_expires_at = ? WHERE ref = ?`)
    .bind(String(h.order_id).slice(0, 40), h.amount_paise, new Date(+h.expires_at || Date.now()).toISOString(), ref).run();
  return {
    mode: 'upi', method: 'upi', ref, plan, amount: paise, currency: 'INR', upi: upiOut(h), razorpay: razorpayMode(c.env) !== 'off',
    description: `SmartTrader ERP ${PLANS[plan].label} - 1 year (incl. GST)`,
  };
}

/* A checkout through Razorpay (order or webhook way) */
async function razorpayStart(c, plan, mode) {
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
  await c.db.prepare(`INSERT INTO billing_orders (org_id, user_id, ref, order_id, plan, months, paise, status, created_at, method) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, 'razorpay')`)
    .bind(c.org.id, c.user.id, ref, orderId, plan, months, paise, nowIso()).run();
  return {
    mode, method: 'razorpay', ref, key_id: keyId(c.env), order_id: orderId, amount: paise, currency: 'INR', notes,
    description: `SmartTrader ERP ${PLANS[plan].label} - 1 year (incl. GST)`, name: owner && owner.name, email: owner && owner.email, business: c.org.name,
  };
}

/* POST /api/billing/verify { ref, razorpay_order_id, razorpay_payment_id, razorpay_signature }: order way only */
export async function billingVerify(c) {
  if (razorpayMode(c.env) !== 'order') throw bad('Payments are confirmed by Razorpay directly. Please wait a moment.');
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

/* POST /api/billing/upi-callback: called by the DocBrisk Pay hub when a UPI payment is confirmed (hub spec 9.3 / 10.2).
   Only a correctly signed, fresh callback for our product, a known checkout and the exact plan price switches a plan on.
   The hub retries anything that is not 200 {ok:true}, and repeats are harmless (activate() claims the row once). */
export async function billingUpiCallback(c) {
  if (!hubOn(c.env)) throw new HttpError(503, 'DocBrisk Pay is not set up here.');
  if (!(await hubCallbackOk(c.env, c.request.headers, c.raw || ''))) throw new HttpError(401, 'Bad signature.');
  const b = c.body || {};
  if (b.event !== 'payment.confirmed') return { ok: true, ignored: 'event' };
  if (b.product !== PRODUCT) throw new HttpError(409, 'Another product.');
  const ref = String(b.client_ref || '');
  const rec = /^[0-9a-f]{32}$/.test(ref) ? await c.db.prepare(`SELECT * FROM billing_orders WHERE ref = ?`).bind(ref).first() : null;
  if (!rec) throw notFound('Unknown checkout.');
  if (b.base_paise !== rec.paise) throw new HttpError(409, 'Amount does not match this checkout.');
  if (rec.status === 'paid') return { ok: true, already: true };
  const hubId = String(b.order_id || '').slice(0, 40), rrn = String(b.rrn || '').replace(/\D/g, '').slice(0, 20);
  const out = await activate(c.db, rec, 'upi:' + (rrn || hubId), rec.paise);
  if (out.status !== 'paid') throw new HttpError(409, 'The checkout could not be switched on.');
  const paid = Number.isInteger(b.paid_paise) ? b.paid_paise : rec.pay_paise;
  await c.db.prepare(`UPDATE billing_orders SET method = 'upi', hub_id = COALESCE(?, hub_id), pay_paise = ? WHERE id = ?`).bind(hubId || null, paid, rec.id).run();
  return { ok: true };
}

/* POST /api/billing/upi-claim { ref, rrn }: "paid but not active?" The hub checks the UPI Ref against bank-signed credits only. */
export async function billingUpiClaim(c) {
  const rec = await upiRecord(c, c.body.ref);
  const rrn = String(c.body.rrn || '').replace(/\D/g, '');
  if (!/^\d{12}$/.test(rrn)) throw bad('Enter the 12-digit UPI Ref No. (UTR) from your UPI app.');
  if (rec.status === 'paid') return { status: 'paid' };
  const r = await hubFetch(c.env, 'POST', hubPath(rec.hub_id, 'claim'), { rrn });
  const d = r.data || {};
  if (r.status === 404) return { status: 'not_found' };
  if (r.status !== 200 || !d.status) throw new HttpError(502, 'Could not check right now. Please try again in a minute.');
  const out = { status: String(d.status) };
  if (d.status === 'underpaid') { out.paid = (+d.paid_paise || 0) / 100; out.price = (+d.price_paise || 0) / 100; }
  return out;
}

/* POST /api/billing/upi-cancel { ref }: the buyer closed the UPI panel or asked for a new code. A late payment still counts. */
export async function billingUpiCancel(c) {
  const rec = await upiRecord(c, c.body.ref);
  if (rec.status !== 'created') return { ok: true };
  const r = await hubFetch(c.env, 'POST', hubPath(rec.hub_id, 'cancel'), {});
  return { ok: r.status === 200 };
}

async function upiRecord(c, refIn) {
  if (!hubOn(c.env)) throw new HttpError(503, 'UPI payment is not switched on.');
  const ref = String(refIn || '');
  const rec = /^[0-9a-f]{32}$/.test(ref) ? await c.db.prepare(`SELECT * FROM billing_orders WHERE ref = ? AND org_id = ?`).bind(ref, c.org.id).first() : null;
  if (!rec || rec.method !== 'upi' || !rec.hub_id) throw notFound('Payment not found.');
  return rec;
}

const statusOut = (r) => ({ ref: r.ref, status: r.status, plan: r.plan, plan_until: r.plan_until || null, payment_id: r.payment_id || null, amount: r.paise / 100 });

/* GET /api/billing/status?ref= : the page waits here. For a UPI checkout still open, it asks the hub at most every
   20 seconds (signed call). If the hub says paid more than a minute ago (so the callback is late or lost), the plan is
   switched on here and the hub is told, so it stops retrying. */
export async function billingStatus(c) {
  const ref = String(c.url.searchParams.get('ref') || '');
  let rec = await c.db.prepare(`SELECT * FROM billing_orders WHERE ref = ? AND org_id = ?`).bind(ref, c.org.id).first();
  if (!rec) throw notFound('Payment not found.');
  const now = Date.now();
  const last = +rec.pay_checked_at || Date.parse(rec.created_at) || 0;
  if (rec.status !== 'created' || rec.method !== 'upi' || !rec.hub_id || !hubOn(c.env) || now - last < 20000) return statusOut(rec);
  // one puller per 20 seconds, even with two tabs open
  const turn = await c.db.prepare(`UPDATE billing_orders SET pay_checked_at = ? WHERE id = ? AND status = 'created' AND COALESCE(pay_checked_at, 0) = ?`)
    .bind(now, rec.id, +rec.pay_checked_at || 0).run();
  if (!turn.meta.changes) return statusOut(rec);
  const r = await hubFetch(c.env, 'GET', hubPath(rec.hub_id));
  const h = r.data || {};
  if (r.status !== 200 || h.order_id !== rec.hub_id) return statusOut(rec);
  const out = { hub: { status: String(h.status || ''), claim: h.claim ? h.claim.state : null } };
  const paidRaw = h.status_raw === 'paid' || (!h.status_raw && (h.status === 'paid' || h.status === 'activating'));
  if (paidRaw && h.product === PRODUCT && h.client_ref === rec.ref && h.base_paise === rec.paise && +h.paid_at && now - +h.paid_at > 60000) {
    rec = await activate(c.db, rec, 'upi:' + rec.hub_id, rec.paise);
    if (rec.status === 'paid') {
      if (Number.isInteger(h.amount_paise)) await c.db.prepare(`UPDATE billing_orders SET pay_paise = ? WHERE id = ?`).bind(h.amount_paise, rec.id).run();
      await hubFetch(c.env, 'POST', hubPath(rec.hub_id, 'fulfilled'), {});
    }
  }
  return { ...statusOut(rec), ...out };
}

export async function billingHistory(c) {
  const { results } = await c.db.prepare(`SELECT ref, plan, months, paise, status, payment_id, method, created_at, paid_at, plan_until FROM billing_orders
      WHERE org_id = ? AND status != 'created' ORDER BY id DESC LIMIT 50`).bind(c.org.id).all();
  return results.map((r) => ({ ...r, amount: r.paise / 100 }));
}
