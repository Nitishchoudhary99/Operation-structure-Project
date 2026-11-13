/* Online catalogue (/s/<token>): products, photos and orders.

   Products: items made with "Sizes & colours" are named "Kurti 101 - Red - M". On the public page they are one product
   ("Kurti 101") with a choice of colour and size, not sixteen lines. Items without " - " in the name stay as they are.

   Photos: one photo per product (the design, or the item's own name), sent from the owner's phone already made small
   (about 900 px, a JPEG / WebP / PNG of at most 400 KB) and kept in D1. The public page shows it; nothing else does.

   Orders: the customer's cart is saved here as an online order (name, phone, address, items at the prices shown), and
   WhatsApp still opens with the order number so the shop sees it at once. The staff turn it into a Sales Order with
   one tap (the customer is found by phone, or added), or decline it. Nothing from the public page changes stock or books. */
import { HttpError, bad, notFound, str, nowIso } from './lib.js';
import { requireCan, rateLimit } from './auth.js';
import { createDoc, auditStatement } from './engine.js';

const R = (p) => Math.round(p) / 100;
const ipOf = (c) => c.request.headers.get('CF-Connecting-IP') || 'local';
export const shopOf = (o) => { let s = {}; try { s = JSON.parse(o.shop || '{}') || {}; } catch (e) { s = {}; } return { on: !!s.on, stock: s.stock !== false, wa: String(s.wa || ''), note: String(s.note || '') }; };

/* ---- products from items ---- */
const SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl|free( ?size)?|\d{1,2}(\s?(cm|in|inch|yrs?|y|m|months?))?|\d{1,2}\s?-\s?\d{1,2}\s?(yrs?|y)|\d{2,3}|small|medium|large|(extra )?large)$/i;
const LETTER = ['xxs', 'xs', 's', 'small', 'm', 'medium', 'l', 'large', 'xl', 'extra large', 'xxl', '2xl', 'xxxl', '3xl', '4xl', '5xl', '6xl'];
const sizeRank = (v) => { const t = v.toLowerCase().trim(), i = LETTER.indexOf(t); if (i >= 0) return i; const n = parseFloat(t); return Number.isFinite(n) ? 100 + n : 1000; };
/* key: the part before the first " - " when at least two items share it, else the whole name */
export function productsOf(items) {
  const base = (n) => { const i = n.indexOf(' - '); return i > 0 ? n.slice(0, i).trim() : ''; };
  const count = new Map();
  for (const i of items) { const b = base(i.name); if (b) count.set(b, (count.get(b) || 0) + 1); }
  const out = new Map();
  for (const i of items) {
    const b = base(i.name), grouped = b && count.get(b) >= 2, key = grouped ? b : i.name;
    if (!out.has(key)) out.set(key, { key, name: key, category: i.category && i.category !== key ? i.category : '', variants: [] });
    out.get(key).variants.push({ ...i, opts: grouped ? i.name.slice(b.length + 3).split(' - ').map((x) => x.trim()) : [] });
  }
  return [...out.values()].map((p) => {
    // the choices, and what each one is called: a column of sizes is "Size", anything else "Colour" (or "Option")
    const n = Math.max(0, ...p.variants.map((v) => v.opts.length));
    const dims = Array.from({ length: n }, (_, k) => {
      const vals = [...new Set(p.variants.map((v) => v.opts[k]).filter(Boolean))];
      const sizes = vals.filter((v) => SIZE.test(v)).length;
      const isSize = sizes >= Math.ceil(vals.length / 2);
      if (isSize) vals.sort((x, y) => sizeRank(x) - sizeRank(y) || x.localeCompare(y));      // S, M, L, XL; 28, 30, 32
      return { name: isSize ? 'Size' : k === 0 || n === 1 ? 'Colour' : 'Option', values: vals };
    });
    return { ...p, dims };
  });
}

/* ---- the public page ---- */
export async function shopOrg(c, token) {
  token = str(token, 40);
  const o = /^[0-9a-f]{24}$/.test(token) && await c.db.prepare(`SELECT id, name, city, phone, address, upi_id, shop FROM orgs WHERE shop_token = ?`).bind(token).first();
  const s = o ? shopOf(o) : null;
  if (!o || !s.on) throw notFound('This rate list is not available. Ask the shop for a new link.');
  return { o, s };
}
const visible = (c, orgId) => c.db.prepare(`SELECT id, name, unit, category, sale_price, gst_rate, qty_on_hand, is_service FROM items
    WHERE org_id = ? AND shop_hide = 0 AND sale_price > 0 ORDER BY category, name LIMIT 2000`).bind(orgId).all();
export async function publicShop(c, token) {
  await rateLimit(c.env, 'shop:' + ipOf(c), 120, 600);
  const { o, s } = await shopOrg(c, token);
  const [{ results }, ph] = await Promise.all([visible(c, o.id), c.db.prepare(`SELECT gkey, v FROM shop_photos WHERE org_id = ?`).bind(o.id).all()]);
  const photos = new Map(ph.results.map((p) => [p.gkey, p.v]));
  const wa = (s.wa || String(o.phone || '').replace(/\D/g, '')).replace(/^(\d{10})$/, '91$1');
  const products = productsOf(results).map((p) => ({ key: p.key, name: p.name, category: p.category, dims: p.dims, photo: photos.has(p.key) ? photos.get(p.key) : null,
    variants: p.variants.map((i) => ({ id: i.id, opts: i.opts, unit: i.unit, price: R(i.sale_price * (100 + (i.gst_rate || 0)) / 100),
      ...(s.stock ? { in_stock: !!i.is_service || i.qty_on_hand > 0 } : {}) })) }));
  return { shop: { name: o.name, city: o.city || '', note: s.note, wa: /^91\d{10}$/.test(wa) ? wa : '' }, products };
}
export async function publicPhoto(c, token, key) {
  await rateLimit(c.env, 'shopimg:' + ipOf(c), 600, 600);
  const { o } = await shopOrg(c, token);
  const p = await c.db.prepare(`SELECT data, mime, v FROM shop_photos WHERE org_id = ? AND gkey = ?`).bind(o.id, str(key, 120)).first();
  if (!p) throw notFound('No photo.');
  // D1 gives a BLOB back as an array of numbers (an ArrayBuffer in some versions): bytes either way
  const bytes = p.data instanceof ArrayBuffer ? new Uint8Array(p.data) : Uint8Array.from(p.data);
  return new Response(bytes, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
}

/* ---- photos (the owner) ---- */
const MIMES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return MIMES.jpeg;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return MIMES.png;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return MIMES.webp;
  return null;
}
export async function savePhoto(c, body) {
  requireCan(c.user, 'items');
  const key = str(body && body.key, 120);
  if (!key) throw bad('Which product is the photo for?');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
  if (!m) throw bad('Send a JPEG, PNG or WebP photo.');
  const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  if (bin.length > 400 * 1024) throw bad('The photo is too big: at most 400 KB after making it small.');
  const mime = sniff(bin);
  if (!mime) throw bad('That file is not a photo.');
  const { results } = await visible(c, c.org.id);
  if (!productsOf(results).some((p) => p.key === key)) throw notFound('No product of that name in the catalogue.');
  await c.db.batch([c.db.prepare(`INSERT INTO shop_photos (org_id, gkey, data, mime, v) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (org_id, gkey) DO UPDATE SET data = excluded.data, mime = excluded.mime, v = shop_photos.v + 1`).bind(c.org.id, key, bin.buffer, mime),
    auditStatement(c, 'catalogue photo', key)]);
  return { ok: true };
}
export async function deletePhoto(c, key) {
  requireCan(c.user, 'items');
  await c.db.prepare(`DELETE FROM shop_photos WHERE org_id = ? AND gkey = ?`).bind(c.org.id, str(key, 120)).run();
  return { ok: true };
}
/* the owner's view: products with their variants (shown or not), photo or not, and new orders waiting */
export async function shopProducts(c) {
  const [all, ph, n] = await Promise.all([
    c.db.prepare(`SELECT id, name, unit, category, sale_price, gst_rate, qty_on_hand, is_service, shop_hide FROM items WHERE org_id = ? AND sale_price > 0 ORDER BY category, name LIMIT 5000`).bind(c.org.id).all(),
    c.db.prepare(`SELECT gkey, v FROM shop_photos WHERE org_id = ?`).bind(c.org.id).all(),
    c.db.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE org_id = ? AND status = 'new'`).bind(c.org.id).first()]);
  const photos = new Map(ph.results.map((p) => [p.gkey, p.v]));
  return { new_orders: n.n, products: productsOf(all.results).map((p) => ({ key: p.key, category: p.category, dims: p.dims, photo: photos.get(p.key) || null,
    variants: p.variants.map((i) => ({ id: i.id, opts: i.opts, shown: !i.shop_hide, price: R(i.sale_price * (100 + (i.gst_rate || 0)) / 100), in_stock: !!i.is_service || i.qty_on_hand > 0 })) })) };
}
/* show or hide a whole product (every colour and size of a design) */
export async function showProduct(c, body) {
  requireCan(c.user, 'items');
  const ids = (Array.isArray(body && body.ids) ? body.ids : []).map(Number).filter((x) => x > 0).slice(0, 500);
  if (!ids.length) throw bad('Nothing to change.');
  const hide = body.show === false ? 1 : 0;
  await c.db.prepare(`UPDATE items SET shop_hide = ? WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(hide, c.org.id, ...ids).run();
  return { ok: true };
}

/* ---- orders ---- */
const phone10 = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''); return /^[6-9]\d{9}$/.test(d) ? d : ''; };
export async function placeOrder(c, token, body) {
  await rateLimit(c.env, 'shop-order:' + ipOf(c), 10, 600);
  const { o, s } = await shopOrg(c, token);
  const name = str(body && body.name, 60), ph = phone10(body && body.phone);
  if (!name) throw bad('Please write your name.');
  if (!ph) throw bad('Please write your 10-digit mobile number, so the shop can call you.');
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (!raw.length) throw bad('Your cart is empty.');
  if (raw.length > 50) throw bad('At most 50 different items in one order.');
  const waiting = await c.db.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE org_id = ? AND status = 'new'`).bind(o.id).first();
  if (waiting.n >= 300) throw new HttpError(429, 'The shop has many orders waiting. Please send this one on WhatsApp.');
  const ids = [...new Set(raw.map((l) => +l.item_id || 0))];
  const { results } = await c.db.prepare(`SELECT id, name, unit, sale_price, gst_rate, qty_on_hand, is_service FROM items WHERE org_id = ? AND shop_hide = 0 AND sale_price > 0
      AND id IN (${ids.map(() => '?').join(',')})`).bind(o.id, ...ids).all();
  const byId = new Map(results.map((i) => [i.id, i]));
  let total = 0;
  const lines = raw.map((l) => {
    const it = byId.get(+l.item_id);
    if (!it) throw bad('Something in your cart is no longer in the catalogue. Please open the link again.');
    if (s.stock && !it.is_service && !(it.qty_on_hand > 0)) throw bad(`${it.name} is out of stock now. Please take it out of the cart.`);
    const qty = Math.round(+l.qty);
    if (!(qty >= 1 && qty <= 99)) throw bad(`${it.name}: choose 1 to 99.`);
    const price = R(it.sale_price * (100 + (it.gst_rate || 0)) / 100);
    total += price * qty;
    return { item_id: it.id, name: it.name, unit: it.unit, qty, price };
  });
  total = Math.round(total * 100) / 100;
  const r = await c.db.prepare(`INSERT INTO shop_orders (org_id, lines, name, phone, address, note, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?) RETURNING id`)
    .bind(o.id, JSON.stringify(lines), name, ph, str(body.address, 300), str(body.note, 200), total, nowIso()).first();
  return { id: r.id, number: 'W-' + r.id, total, lines };
}
export async function shopOrders(c, status) {
  requireCan(c.user, 'sales');
  const st = ['new', 'accepted', 'declined'].includes(status) ? status : 'new';
  const { results } = await c.db.prepare(`SELECT s.*, d.number AS doc_number FROM shop_orders s LEFT JOIN docs d ON d.id = s.doc_id
      WHERE s.org_id = ? AND s.status = ? ORDER BY s.id DESC LIMIT 200`).bind(c.org.id, st).all();
  return { orders: results.map((r) => ({ id: r.id, number: 'W-' + r.id, name: r.name, phone: r.phone, address: r.address, note: r.note, total: r.total, status: r.status,
    reason: r.reason || '', created_at: r.created_at, doc_id: r.doc_id, doc_number: r.doc_number || '', lines: JSON.parse(r.lines || '[]') })) };
}
/* accept: the customer (found by phone, else added) gets a Sales Order of these items, at today's prices */
export async function acceptOrder(c, id) {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`SELECT * FROM shop_orders WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!r) throw notFound('Order not found.');
  const hold = await c.db.prepare(`UPDATE shop_orders SET status = 'accepting', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'new'`).bind(c.user.id, nowIso(), r.id).run();
  if (!hold.meta.changes) throw bad('Someone has already answered this order.');
  try {
    const { results } = await c.db.prepare(`SELECT id, name, phone, address FROM parties WHERE org_id = ? AND kind != 'supplier' AND phone != ''`).bind(c.org.id).all();
    let party = results.find((p) => phone10(p.phone) === r.phone);
    if (!party) {
      let name = r.name;
      if (await c.db.prepare(`SELECT 1 FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first()) name = `${r.name} (${r.phone.slice(-4)})`;
      party = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, address, state, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)
          ON CONFLICT (org_id, name) DO UPDATE SET phone = parties.phone RETURNING id, name`).bind(c.org.id, name, r.phone, r.address || '', c.org.state || '', nowIso()).first();
    }
    const lines = JSON.parse(r.lines);
    const doc = await createDoc(c, { type: 'SO', party_id: party.id, notes: [`Online order W-${r.id}`, r.address && `Deliver to: ${r.address}`, r.note].filter(Boolean).join(' · ').slice(0, 1000),
      lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.price, incl: true })) });
    await c.db.batch([c.db.prepare(`UPDATE shop_orders SET status = 'accepted', doc_id = ?, party_id = ? WHERE id = ?`).bind(doc.id, party.id, r.id),
      auditStatement(c, 'online order accepted', `W-${r.id} → ${doc.number}, ${party.name}`)]);
    return { doc_id: doc.id, number: doc.number, party: party.name };
  } catch (e) {
    await c.db.prepare(`UPDATE shop_orders SET status = 'new', handled_by = NULL, handled_at = NULL WHERE id = ? AND status = 'accepting'`).bind(r.id).run();
    throw e;
  }
}
export async function declineOrder(c, id, body) {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`UPDATE shop_orders SET status = 'declined', reason = ?, handled_by = ?, handled_at = ? WHERE id = ? AND org_id = ? AND status = 'new'`)
    .bind(str(body && body.reason, 120), c.user.id, nowIso(), id, c.org.id).run();
  if (!r.meta.changes) throw bad('This order was already answered.');
  await auditStatement(c, 'online order declined', `W-${id}`).run();
  return { ok: true };
}
