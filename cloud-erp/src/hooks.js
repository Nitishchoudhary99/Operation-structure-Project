/* Live orders from the business's own web store: Shopify, WooCommerce, or any site that can send a signed webhook.
   Each connected store gets a private address (/api/hooks/<token>) and a signing secret. The store sends every new
   paid order there; the order is checked against the secret (HMAC-SHA256 of the raw body, base64, the scheme Shopify
   and WooCommerce both use) and billed as a sales invoice at once, the same way as an imported order report
   (src/channels.js: one party per store and buyer state, items by SKU, an order is never billed twice).
   The store always gets 200 once the signature is good, so it does not keep re-sending an order that cannot be billed
   (an unknown SKU): what happened is kept on the connection for the shop to see. */
import { bad, notFound, str, nowIso, today, oneOf, HttpError } from './lib.js';
import { requireCan, randomHex, sameText } from './auth.js';
import { SYS_SQL, sysMap } from './engine.js';
import { matchOrders, billOrder, cleanState } from './channels.js';

const KINDS = { shopify: 'Shopify', woocommerce: 'WooCommerce', custom: 'Website' };

async function hmac(secret, raw) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let s = ''; for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

const hookOut = (h, origin) => ({ id: h.id, kind: h.kind, name: h.name, warehouse_id: h.warehouse_id, active: h.active, created_at: h.created_at,
  last_at: h.last_at, last_error: h.last_error, orders: h.orders, url: `${origin}/api/hooks/${h.token}` });

export async function listHooks(c) {
  requireCan(c.user, 'settings');
  const { results } = await c.db.prepare(`SELECT * FROM shop_hooks WHERE org_id = ? ORDER BY id`).bind(c.org.id).all();
  return { rows: results.map((h) => hookOut(h, c.url.origin)) };
}

/* body { kind, name, warehouse_id, secret? }: Shopify shows its own signing key (pasted here); for the others one is made */
export async function addHook(c, body) {
  requireCan(c.user, 'settings');
  const kind = oneOf(body.kind, Object.keys(KINDS), 'Store');
  const n = await c.db.prepare(`SELECT COUNT(*) AS n FROM shop_hooks WHERE org_id = ?`).bind(c.org.id).first();
  if (n.n >= 10) throw bad('At most 10 store connections.');
  let secret = str(body.secret, 200);
  if (kind === 'shopify' && secret.length < 16) throw bad('Paste the signing key Shopify shows under Settings → Notifications → Webhooks.');
  if (kind !== 'shopify') secret = randomHex(24);
  const wh = +body.warehouse_id || null;
  if (wh && !(await c.db.prepare(`SELECT 1 FROM warehouses WHERE id = ? AND org_id = ?`).bind(wh, c.org.id).first())) throw bad('Unknown godown.');
  const h = await c.db.prepare(`INSERT INTO shop_hooks (org_id, kind, name, token, secret, warehouse_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, kind, str(body.name, 40) || KINDS[kind], randomHex(16), secret, wh, nowIso()).first();
  // the secret is shown once, for the store's webhook form
  return { ...hookOut(h, c.url.origin), secret: kind === 'shopify' ? '' : secret };
}

export async function deleteHook(c, id) {
  requireCan(c.user, 'settings');
  const r = await c.db.prepare(`DELETE FROM shop_hooks WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Connection not found.');
  return { ok: true };
}

/* the store's order as { order_id, date, state, lines: [{ sku, name, qty, gross }] }, or null when it is not to be billed */
export function orderFrom(kind, o) {
  if (!o || typeof o !== 'object') return null;
  const date = String(o.created_at || o.date_created || o.date || '').slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
  if (kind === 'shopify') {
    if (o.cancelled_at || ['refunded', 'voided'].includes(o.financial_status)) return null;
    const addr = o.shipping_address || o.billing_address || {};
    return { order_id: String(o.name || o.order_number || o.id), date: d, state: cleanState(addr.province || addr.province_code || ''),
      lines: (o.line_items || []).map((l) => {
        const qty = +l.quantity || 0, unit = +l.price || 0, tax = (l.tax_lines || []).reduce((s, t) => s + (+t.price || 0), 0);
        const disc = Array.isArray(l.discount_allocations) && l.discount_allocations.length ? l.discount_allocations.reduce((s, a) => s + (+a.amount || 0), 0) : +l.total_discount || 0;
        return { sku: l.sku || '', name: l.title || l.name || '', qty, gross: Math.max(0, unit * qty - disc + (o.taxes_included ? 0 : tax)) };
      }) };
  }
  if (kind === 'woocommerce') {
    if (!['processing', 'completed', 'on-hold'].includes(o.status)) return null;
    const addr = (o.shipping && o.shipping.state ? o.shipping : o.billing) || {};
    return { order_id: String(o.number || o.id), date: d, state: cleanState(addr.state || ''),
      lines: (o.line_items || []).map((l) => ({ sku: l.sku || '', name: l.name || '', qty: +l.quantity || 0, gross: Math.max(0, (+l.total || 0) + (+l.total_tax || 0)) })) };
  }
  if (o.status && /cancel|refund/i.test(o.status)) return null;
  return { order_id: str(o.order_id || o.id, 60), date: d, state: cleanState(o.state || ''),
    lines: (Array.isArray(o.lines) ? o.lines : []).map((l) => ({ sku: l.sku || '', name: l.name || '', qty: +l.qty || 0, gross: +l.amount || 0 })) };
}

/* POST /api/hooks/:token (no cookie): a store sending an order */
export async function receiveHook(c, token) {
  const h = await c.db.prepare(`SELECT * FROM shop_hooks WHERE token = ?`).bind(String(token).slice(0, 64)).first();
  if (!h || !h.active) throw notFound('Unknown address.');
  const sig = c.request.headers.get('X-Shopify-Hmac-Sha256') || c.request.headers.get('X-WC-Webhook-Signature') || c.request.headers.get('X-Signature') || '';
  // WooCommerce checks a new webhook with an unsigned ping ("webhook_id=12"): say yes, bill nothing
  if (!sig && h.kind === 'woocommerce' && /^webhook_id=\d+$/.test(c.raw.trim())) return { ok: true, ping: true };
  if (!sig || !sameText(sig, await hmac(h.secret, c.raw))) throw new HttpError(401, 'Bad signature.');
  let body;
  try { body = JSON.parse(c.raw); } catch (e) { throw bad('Bad body.'); }
  const org = await c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(h.org_id).first();
  const user = await c.db.prepare(`SELECT * FROM users WHERE org_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1`).bind(h.org_id).first();
  if (!org || !user) throw notFound('Unknown address.');
  const ctx = { db: c.db, org, user, url: c.url, request: c.request, body: {}, sys: sysMap((await c.db.prepare(SYS_SQL).bind(org.id).all()).results) };
  Object.defineProperty(ctx, 'env', { value: c.env, enumerable: false });
  const o = orderFrom(h.kind, body);
  const note = async (err, billed = 0) => c.db.prepare(`UPDATE shop_hooks SET last_at = ?, last_error = ?, orders = orders + ? WHERE id = ?`).bind(nowIso(), err.slice(0, 300), billed, h.id).run();
  if (!o) { await note(''); return { ok: true, skipped: 'not a paid order' }; }
  const R = await matchOrders(ctx, 'web' + h.id, h.name, [o]);
  const m = R.orders[0];
  if (m.done) { await note(''); return { ok: true, skipped: 'already billed' }; }
  if (m.problems.length || !m.lines.length) { await note(`Order ${m.order_id}: ${m.problems.join('; ') || 'no lines'}`); return { ok: true, skipped: m.problems.join('; ') }; }
  try {
    const doc = await billOrder(ctx, R, m, h.warehouse_id || 0);
    await note('', 1);
    return { ok: true, number: doc.number };
  } catch (e) {
    const known = e instanceof HttpError && e.status < 500;
    if (!known) throw e;                              // a server fault: the store tries again later
    await note(`Order ${m.order_id}: ${e.message}`);
    return { ok: true, skipped: e.message };
  }
}
