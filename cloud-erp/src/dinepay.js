/* Paying the table's bill online through the restaurant's OWN Razorpay account (the money goes to the shop, never to us).

   Off until the owner saves their keys on the Table QR page:
     key id + key secret  -> we make a Razorpay Payment Link for the bill (UPI, cards, netbanking on Razorpay's page)
     webhook secret       -> Razorpay tells us "paid" (signed); the bill is made, paid to the UPI account, the table is free
   In the Razorpay dashboard: Settings -> Webhooks -> Add, URL = the one shown on the Table QR page, event payment_link.paid,
   secret = the same text as saved here.

   The secrets are kept sealed (AES-GCM with a key from the session secret, as the courier password) and never sent back.
   Nothing is billed on the guest's word: only a signed webhook whose amount is the bill. If the bill changed after the guest
   paid, nothing is guessed: the payment waits on the Tables page as "Paid online, check" for the staff, like a UPI claim. */
import { HttpError, bad, notFound, str, nowIso } from './lib.js';
import { USER_SQL, requireCan, randomHex, rateLimit } from './auth.js';
import { auditStatement, SYS_SQL, sysMap } from './engine.js';
import { seal, unseal } from './gdrive.js';
import { hmacHex, same } from './billing.js';
import { guestTableOf, tableBillOf, settleCore, guestSecret } from './dine.js';

export const RZP_PRODUCT = 'smarttrader-dine';
// RAZORPAY_BASE (a deployment variable, never a user setting) points the tests at a stand-in server, as SHIPROCKET_BASE does
const RZP_API = (env) => String((env && env.RAZORPAY_BASE) || 'https://api.razorpay.com').replace(/\/+$/, '') + '/v1';
const cfgOf = (o) => { try { const s = JSON.parse(o.rzp || '{}') || {}; return s && s.key_id ? s : null; } catch (e) { return null; } };
const ipOf = (c) => c.request.headers.get('CF-Connecting-IP') || 'local';

/* ---- the owner's settings ---- */
export async function rzpSettings(c) {
  requireCan(c.user, 'settings');
  const s = cfgOf(c.org);
  return { on: !!s, key_id: s ? s.key_id : '', webhook_url: s && c.org.rzp_token ? `${c.url.origin}/api/public/pg/razorpay/${c.org.rzp_token}` : '' };
}
export async function rzpSave(c) {
  requireCan(c.user, 'settings');
  const b = c.body || {}, old = cfgOf(c.org);
  const keyId = str(b.key_id, 40);
  if (!/^rzp_(live|test)_[A-Za-z0-9]{8,30}$/.test(keyId)) throw bad('The Key Id looks like rzp_live_XXXXXXXX (Razorpay dashboard → Account & Settings → API Keys).');
  const keySecret = str(b.key_secret, 80), whSecret = str(b.webhook_secret, 80);
  if (!old && (!keySecret || !whSecret)) throw bad('Fill in the Key Secret and the Webhook Secret too.');
  if (keySecret && !/^[A-Za-z0-9]{12,80}$/.test(keySecret)) throw bad('The Key Secret is letters and numbers only. Copy it again from Razorpay.');
  if (whSecret && whSecret.length < 8) throw bad('Make the Webhook Secret at least 8 characters, and use the same text in Razorpay.');
  const s = { key_id: keyId, sec: keySecret ? await seal(c.env, keySecret) : old.sec, wh: whSecret ? await seal(c.env, whSecret) : old.wh };
  const tok = c.org.rzp_token || randomHex(12);
  await c.db.batch([c.db.prepare(`UPDATE orgs SET rzp = ?, rzp_token = ? WHERE id = ?`).bind(JSON.stringify(s), tok, c.org.id),
    auditStatement(c, 'online payment at tables', `Razorpay ${keyId.startsWith('rzp_test_') ? 'test' : 'live'} keys saved`)]);
  c.org = { ...c.org, rzp: JSON.stringify(s), rzp_token: tok };
  return rzpSettings(c);
}
export async function rzpOff(c) {
  requireCan(c.user, 'settings');
  await c.db.batch([c.db.prepare(`UPDATE orgs SET rzp = NULL, rzp_token = NULL WHERE id = ?`).bind(c.org.id), auditStatement(c, 'online payment at tables', 'off')]);
  c.org = { ...c.org, rzp: null, rzp_token: null };
  return rzpSettings(c);
}
export const rzpOn = (o) => !!cfgOf(o);

/* ---- the guest: a Payment Link for the bill as it is now ---- */
export async function guestPayOnline(c, token, body) {
  await rateLimit(c.env, 'dine-pay:' + ipOf(c), 10, 600);
  const t = await guestTableOf(c, token);
  const o = await c.db.prepare(`SELECT id, name, rzp FROM orgs WHERE id = ?`).bind(t.org_id).first();
  const s = cfgOf(o);
  if (!s) throw bad('Online payment is not on for this restaurant. Pay by UPI or at the counter.');
  const bill = await tableBillOf(c, t.id);
  if (!bill.pay) throw bad('There is no bill on this table yet.');
  if (Math.round(+(body && body.amount)) !== bill.pay) throw bad('The bill has changed. Please look at it again before paying.');
  const open = await c.db.prepare(`SELECT COUNT(*) AS n FROM dine_requests WHERE table_id = ? AND kind = 'pay' AND status = 'online' AND created_at > ?`)
    .bind(t.id, new Date(Date.now() - 30 * 60e3).toISOString()).first();
  if (open.n >= 5) throw bad('Too many payment links for this table. Please wait, or pay at the counter.');
  const secret = await guestSecret();
  const r = await c.db.prepare(`INSERT INTO dine_requests (org_id, table_id, kind, status, what, note, token_hash, created_at, amount)
      VALUES (?, ?, 'pay', 'online', 'online', '', ?, ?, ?) RETURNING id`).bind(t.org_id, t.id, secret.hash, nowIso(), bill.pay).first();
  let link;
  try {
    const keySecret = await unseal(c.env, s.sec);
    const res = await fetch(RZP_API(c.env) + '/payment_links', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(s.key_id + ':' + keySecret) },
      body: JSON.stringify({ amount: bill.pay * 100, currency: 'INR', accept_partial: false, reference_id: `st-${r.id}-${randomHex(4)}`,
        description: `${o.name}: Table ${t.name} bill`.slice(0, 2000), expire_by: Math.floor(Date.now() / 1000) + 20 * 60,
        notes: { product: RZP_PRODUCT, org: String(t.org_id), req: String(r.id) }, callback_url: `${c.url.origin}/t/${token}`, callback_method: 'get' }),
    });
    link = await res.json().catch(() => ({}));
    if (!res.ok || !link.id || !link.short_url) throw new Error((link.error && link.error.description) || 'HTTP ' + res.status);
  } catch (e) {
    await c.db.prepare(`UPDATE dine_requests SET status = 'rejected', reason = ? WHERE id = ?`).bind(('online payment failed: ' + e.message).slice(0, 120), r.id).run();
    throw new HttpError(502, 'Online payment is not working right now. Pay by UPI or at the counter.');
  }
  await c.db.prepare(`UPDATE dine_requests SET pg_ref = ? WHERE id = ?`).bind(link.id, r.id).run();
  return { id: r.id, token: secret.token, url: link.short_url };
}

/* ---- Razorpay calls us: payment_link.paid, signed with the shop's webhook secret ---- */
export async function rzpWebhook(c, tok) {
  if (!/^[0-9a-f]{24}$/.test(String(tok || ''))) throw notFound('Unknown webhook.');
  const o = await c.db.prepare(`SELECT * FROM orgs WHERE rzp_token = ?`).bind(tok).first();
  const s = o && cfgOf(o);
  if (!s) throw notFound('Unknown webhook.');
  const sig = String(c.request.headers.get('x-razorpay-signature') || '').trim().toLowerCase();
  if (!sig || !same(await hmacHex(await unseal(c.env, s.wh), c.raw || ''), sig)) throw new HttpError(401, 'Bad signature.');
  const ev = c.body || {}, pl = ev.payload && ev.payload.payment_link && ev.payload.payment_link.entity, pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  // anything that is not a paid link of ours gets a 200, so Razorpay does not keep retrying it
  if (ev.event !== 'payment_link.paid' || !pl || !pl.id) return { ok: true, ignored: 'event' };
  if ((pl.notes || {}).product !== RZP_PRODUCT || String((pl.notes || {}).org) !== String(o.id)) return { ok: true, ignored: 'not ours' };
  const r = await c.db.prepare(`SELECT * FROM dine_requests WHERE org_id = ? AND pg_ref = ? AND kind = 'pay'`).bind(o.id, pl.id).first();
  if (!r) return { ok: true, ignored: 'no request' };
  if (r.status !== 'online') return { ok: true, already: r.status };
  const paid = Math.round(+(pl.amount_paid || 0)), payId = str(pay && pay.id, 40);
  const note = `Razorpay ${payId || pl.id}`.slice(0, 60);
  // acting for the business: as its owner (as recurring invoices do), with the audit saying it was Razorpay
  const owner = await c.db.prepare(`SELECT id FROM users WHERE org_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1`).bind(o.id).first();
  const user = owner && await c.db.prepare(USER_SQL).bind(owner.id).first();
  const ctx = { ...c, org: o, user, sys: sysMap((await c.db.prepare(SYS_SQL).bind(o.id).all()).results) };
  Object.defineProperty(ctx, 'env', { value: c.env, enumerable: false });
  const toStaff = async (why) => {   // the money came; something does not match: the staff decide, nothing is guessed
    await c.db.batch([c.db.prepare(`UPDATE dine_requests SET status = 'new', note = ?, amount = ? WHERE id = ? AND status = 'online'`).bind(note, paid / 100, r.id),
      ...(user ? [auditStatement(ctx, 'table paid online, needs a check', `₹${paid / 100} ${note}: ${why}`.slice(0, 300))] : [])]);
    return { ok: true, to_staff: why };
  };
  if (!user) return toStaff('no active owner');
  if (paid !== Math.round(r.amount * 100)) return toStaff(`paid ₹${paid / 100}, link was for ₹${r.amount}`);
  try {
    const b = await settleCore(ctx, r, note, 'online');
    return { ok: true, bill: b.number };
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return toStaff(e.message);
    throw e;   // a real failure: Razorpay retries the webhook
  }
}
