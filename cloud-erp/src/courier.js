/* Courier booking through Shiprocket (one account reaches Delhivery, Blue Dart, DTDC, Ekart, Xpressbees, Shadowfax,
   India Post and more), from the Dispatch Desk: the courier's rates for the parcel, then one tap books it: the order is
   created on Shiprocket, the AWB is assigned, the pickup is asked for and the courier's label comes back. Tracking is
   read back on demand ("Refresh tracking"); a delivered parcel is marked delivered by itself.
   The owner connects once in Settings → Orders & dispatch with a Shiprocket API user (Shiprocket panel → Settings → API).
   Its password and the 10-day token are kept sealed (AES-GCM, src/gdrive.js seal) and never sent back to the browser.
   SHIPROCKET_BASE (a deployment variable, never a user setting) points the tests at a stand-in server. */
import { bad, forbidden, notFound, str, num, nowIso, today } from './lib.js';
import { can, canView, rulesOf, requireCan } from './auth.js';
import { auditStatement } from './engine.js';
import { seal, unseal } from './gdrive.js';

const BASE = (env) => String((env && env.SHIPROCKET_BASE) || 'https://apiv2.shiprocket.in').replace(/\/+$/, '');
const TOKEN_DAYS = 9;      // Shiprocket tokens last 10 days; a fresh one is taken a day early
const mayDispatch = (u) => (can(u, 'sales') || (can(u, 'stock') && !rulesOf(u).no_dispatch)) && canView(u, 'sales');
const errText = (j) => {
  if (!j || typeof j !== 'object') return '';
  if (j.message) return String(j.message);
  if (j.errors && typeof j.errors === 'object') return Object.values(j.errors).flat().map(String).join(' ');
  return '';
};
async function call(env, path, { method = 'GET', token, body } = {}) {
  let r;
  try {
    r = await fetch(BASE(env) + path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw bad('Shiprocket did not answer. Try again in a minute.'); }
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch (e) { j = {}; }
  return { ok: r.ok, status: r.status, j };
}
async function login(env, email, password) {
  const r = await call(env, '/v1/external/auth/login', { method: 'POST', body: { email, password } });
  if (!r.ok || !r.j.token) throw bad(`Shiprocket did not accept this API user: ${errText(r.j) || 'wrong email or password'}. Use the API user made in Shiprocket → Settings → API.`);
  return r.j.token;
}
const linkOf = (c) => c.db.prepare(`SELECT * FROM courier_links WHERE org_id = ?`).bind(c.org.id).first();
async function tokenOf(c, link, fresh = false) {
  if (!fresh && link.token_enc && link.token_at && Date.now() - Date.parse(link.token_at) < TOKEN_DAYS * 86400e3) {
    try { return await unseal(c.env, link.token_enc); } catch (e) { /* sealed with an older key: log in again */ }
  }
  const token = await login(c.env, link.email, await unseal(c.env, link.secret_enc));
  const at = nowIso(), sealed = await seal(c.env, token);
  await c.db.prepare(`UPDATE courier_links SET token_enc = ?, token_at = ? WHERE org_id = ?`).bind(sealed, at, c.org.id).run();
  link.token_enc = sealed; link.token_at = at;
  return token;
}
/* one Shiprocket call with the business's token; an expired token is renewed once */
async function sr(c, link, path, opts = {}) {
  let r = await call(c.env, path, { ...opts, token: await tokenOf(c, link) });
  if (r.status === 401) r = await call(c.env, path, { ...opts, token: await tokenOf(c, link, true) });
  if (!r.ok) throw bad(`Shiprocket: ${errText(r.j) || 'request failed (' + r.status + ')'}`);
  return r.j;
}
async function pickups(c, link) {
  const j = await sr(c, link, '/v1/external/settings/company/pickup');
  const list = (j.data && (j.data.shipping_address || j.data)) || [];
  return (Array.isArray(list) ? list : []).map((p) => ({ name: str(p.pickup_location, 60), pin: str(p.pin_code, 10), city: str(p.city, 60), address: str(p.address, 120) })).filter((p) => p.name);
}

/* GET /api/courier: is a courier account connected (no secrets) */
export async function courierStatus(c) {
  const link = await linkOf(c);
  if (!link) return { connected: false };
  const out = { connected: true, provider: link.provider, pickup: link.pickup, pickup_pin: link.pickup_pin };
  if (can(c.user, 'settings')) out.email = link.email;
  return out;
}
/* POST /api/courier/connect { email, password } */
export async function courierConnect(c, b) {
  requireCan(c.user, 'settings');
  const email = str(b.email, 120).toLowerCase(), password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Type the Shiprocket API user email.');
  if (!password || password.length > 200) throw bad('Type the Shiprocket API user password.');
  const token = await login(c.env, email, password);
  const now = nowIso();
  await c.db.batch([c.db.prepare(`INSERT INTO courier_links (org_id, provider, email, secret_enc, token_enc, token_at, created_by, created_at) VALUES (?, 'shiprocket', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET provider = excluded.provider, email = excluded.email, secret_enc = excluded.secret_enc, token_enc = excluded.token_enc, token_at = excluded.token_at`)
    .bind(c.org.id, email, await seal(c.env, password), await seal(c.env, token), now, c.user.id, now), auditStatement(c, 'courier connected', `Shiprocket ${email}`)]);
  const link = await linkOf(c), list = await pickups(c, link);
  if (list.length && !link.pickup) {
    await c.db.prepare(`UPDATE courier_links SET pickup = ?, pickup_pin = ? WHERE org_id = ?`).bind(list[0].name, list[0].pin, c.org.id).run();
  }
  return { ...(await courierStatus(c)), pickups: list };
}
/* PUT /api/courier { pickup }: which Shiprocket pickup address parcels leave from */
export async function courierPickup(c, b) {
  requireCan(c.user, 'settings');
  const link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  const list = await pickups(c, link), p = list.find((x) => x.name === str(b.pickup, 60));
  if (!p) throw bad('Choose one of your Shiprocket pickup addresses.');
  await c.db.prepare(`UPDATE courier_links SET pickup = ?, pickup_pin = ? WHERE org_id = ?`).bind(p.name, p.pin, c.org.id).run();
  return { ...(await courierStatus(c)), pickups: list };
}
export async function courierPickups(c) {
  requireCan(c.user, 'settings');
  const link = await linkOf(c);
  return { ...(await courierStatus(c)), pickups: link ? await pickups(c, link) : [] };
}
export async function courierDisconnect(c) {
  requireCan(c.user, 'settings');
  await c.db.batch([c.db.prepare(`DELETE FROM courier_links WHERE org_id = ?`).bind(c.org.id), auditStatement(c, 'courier disconnected', 'Shiprocket')]);
  return { connected: false };
}

/* the delivery note to ship, with its customer and lines */
async function parcel(c, id) {
  if (!mayDispatch(c.user)) throw forbidden('Your role cannot dispatch orders.');
  const d = await c.db.prepare(`SELECT d.*, p.name AS party, p.phone, p.address, p.city, p.state, p.pincode, p.email
      FROM docs d LEFT JOIN parties p ON p.id = d.party_id WHERE d.id = ? AND d.org_id = ?`).bind(id, c.org.id).first();
  if (!d || d.type !== 'DN') throw notFound('Delivery note not found.');
  if (d.status === 'cancelled') throw bad(`${d.number} is cancelled.`);
  return d;
}
const refOf = (d) => { try { return JSON.parse(d.ship_ref || '{}') || {}; } catch (e) { return {}; } };
const dims = (b) => ({ weight: num(b.weight, 'Weight (kg)', { min: 0.01, max: 500 }), length: num(b.length, 'Length (cm)', { min: 1, max: 500, def: 10 }),
  breadth: num(b.breadth, 'Breadth (cm)', { min: 1, max: 500, def: 10 }), height: num(b.height, 'Height (cm)', { min: 1, max: 500, def: 5 }) });

/* GET /api/courier/rates?dn=&weight=: the couriers that reach this pincode, with rate and days */
export async function courierRates(c, id, b) {
  const d = await parcel(c, id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket in Settings → Orders & dispatch first.');
  if (!link.pickup_pin) throw bad('Choose the pickup address in Settings → Orders & dispatch.');
  if (!/^\d{6}$/.test(d.pincode || '')) throw bad(`Add ${d.party || 'the customer'}'s 6-digit pincode on the customer page.`);
  const w = dims(b), cod = d.pay_mode !== 'prepaid';
  const q = new URLSearchParams({ pickup_postcode: link.pickup_pin, delivery_postcode: d.pincode, weight: String(w.weight), cod: cod ? '1' : '0', declared_value: String(Math.round(d.total / 100)) });
  const j = await sr(c, link, `/v1/external/courier/serviceability/?${q}`);
  const list = ((j.data && j.data.available_courier_companies) || []).map((x) => ({ id: +x.courier_company_id, name: str(x.courier_name, 60), rate: +x.rate || +x.freight_charge || 0,
    days: str(x.estimated_delivery_days || x.etd, 20), cod_charges: +x.cod_charges || 0, rating: +x.rating || 0 })).filter((x) => x.id).sort((a, b2) => a.rate - b2.rate);
  return { cod, couriers: list.slice(0, 15) };
}

/* POST /api/courier/book { dn_id, courier_id, weight, length, breadth, height } */
export async function courierBook(c, b) {
  const d = await parcel(c, +b.dn_id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket in Settings → Orders & dispatch first.');
  if (!link.pickup) throw bad('Choose the pickup address in Settings → Orders & dispatch.');
  if (d.awb) throw bad(`${d.number} already has a tracking number (${d.awb}).`);
  if (!d.address || !/^\d{6}$/.test(d.pincode || '') || !/\d{10}$/.test(String(d.phone || '').replace(/\D/g, ''))) throw bad(`Add ${d.party || 'the customer'}'s address, 6-digit pincode and mobile on the customer page first.`);
  const w = dims(b), courierId = +b.courier_id || 0, ref = refOf(d);
  // 1. the order on Shiprocket (once: a retry after a failed AWB reuses it)
  if (!ref.shipment_id) {
    const { results: lines } = await c.db.prepare(`SELECT l.*, i.name AS item, i.sku, i.hsn FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ?`).bind(d.id).all();
    const items = lines.filter((l) => l.qty > 0).map((l) => ({ name: str(l.item || l.description, 100) || 'Item', sku: str(l.sku || `ST${l.item_id || l.id}`, 40), units: Math.max(1, Math.ceil(l.qty)),
      selling_price: Math.round(l.total / Math.max(1, Math.ceil(l.qty))) / 100, hsn: str(l.hsn, 10) }));
    const phone = String(d.phone || '').replace(/\D/g, '').slice(-10), [first, ...rest] = String(d.party || 'Customer').split(' ');
    const order = await sr(c, link, '/v1/external/orders/create/adhoc', { method: 'POST', body: {
      order_id: d.number, order_date: `${d.date} 10:00`, pickup_location: link.pickup, billing_customer_name: first, billing_last_name: rest.join(' '),
      billing_address: str(d.address, 190), billing_city: str(d.city || '', 60) || str(d.state, 60), billing_pincode: d.pincode, billing_state: str(d.state, 60), billing_country: 'India',
      billing_email: str(d.email, 100) || undefined, billing_phone: phone, shipping_is_billing: true, order_items: items,
      payment_method: d.pay_mode === 'prepaid' ? 'Prepaid' : 'COD', sub_total: Math.round(d.total) / 100, ...w } });
    if (!order.shipment_id) throw bad(`Shiprocket did not make the order: ${errText(order) || 'no shipment id'}`);
    Object.assign(ref, { p: 'shiprocket', order_id: order.order_id, shipment_id: order.shipment_id });
    await c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ?`).bind(JSON.stringify(ref), d.id, c.org.id).run();
  }
  // 2. the AWB (the chosen courier, or Shiprocket's pick)
  const awb = await sr(c, link, '/v1/external/courier/assign/awb', { method: 'POST', body: { shipment_id: ref.shipment_id, ...(courierId ? { courier_id: courierId } : {}) } });
  const data = (awb.response && awb.response.data) || {};
  if (!data.awb_code) throw bad(`Shiprocket could not assign a courier: ${errText(awb) || errText(awb.response) || 'try another courier'}`);
  // 3. pickup and label: the parcel is booked even if these two fail; they can be asked again from Shiprocket
  let label = '', pickup = '';
  try { const pk = await sr(c, link, '/v1/external/courier/generate/pickup', { method: 'POST', body: { shipment_id: [ref.shipment_id] } }); pickup = str((pk.response && (pk.response.pickup_scheduled_date || pk.response.data)) || '', 40); } catch (e) { pickup = ''; }
  try { const lb = await sr(c, link, '/v1/external/courier/generate/label', { method: 'POST', body: { shipment_id: [ref.shipment_id] } }); label = /^https:\/\//.test(lb.label_url || '') ? str(lb.label_url, 500) : ''; } catch (e) { label = ''; }
  Object.assign(ref, { courier_id: +data.courier_company_id || courierId, label_url: label, pickup, status: 'AWB assigned', checked_at: nowIso() });
  const courier = str(data.courier_name, 40) || 'Shiprocket', code = str(data.awb_code, 40);
  await c.db.batch([c.db.prepare(`UPDATE docs SET courier = ?, awb = ?, ship = 'shipped', ship_at = ?, ship_ref = ? WHERE id = ? AND org_id = ?`)
    .bind(courier, code, nowIso(), JSON.stringify(ref), d.id, c.org.id), auditStatement(c, 'courier booked', `${d.number}: ${courier} ${code}`)]);
  return { ok: true, courier, awb: code, label_url: label, pickup };
}

/* POST /api/courier/track/:id: the courier's latest status; delivered marks the parcel delivered */
export async function courierTrack(c, id) {
  const d = await parcel(c, id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  if (!d.awb) throw bad(`${d.number} has no tracking number yet.`);
  const j = await sr(c, link, `/v1/external/courier/track/awb/${encodeURIComponent(d.awb)}`);
  const t = j.tracking_data || {}, last = (Array.isArray(t.shipment_track) && t.shipment_track[0]) || {};
  const status = str(last.current_status || t.current_status || '', 60).toUpperCase() || 'NO UPDATE YET';
  const ref = { ...refOf(d), status, track_url: /^https:\/\//.test(t.track_url || '') ? str(t.track_url, 300) : refOf(d).track_url || '', checked_at: nowIso() };
  const delivered = status === 'DELIVERED' && d.ship === 'shipped';
  await c.db.prepare(`UPDATE docs SET ship_ref = ?${delivered ? `, ship = 'delivered', ship_at = ?` : ''} WHERE id = ? AND org_id = ?`)
    .bind(...[JSON.stringify(ref), ...(delivered ? [nowIso()] : []), d.id, c.org.id]).run();
  // a parcel coming back is only marked returned by a person, once it is in the godown (RTO cancels the delivery note)
  return { status, delivered, rto: /^RTO/.test(status), track_url: ref.track_url };
}
/* POST /api/courier/sync: refresh the parcels on the way (30 at a time) */
export async function courierSync(c) {
  if (!mayDispatch(c.user)) throw forbidden('Your role cannot dispatch orders.');
  const { results } = await c.db.prepare(`SELECT id FROM docs WHERE org_id = ? AND type = 'DN' AND ship = 'shipped' AND awb != '' AND ship_ref LIKE '%shiprocket%' ORDER BY ship_at LIMIT 30`).bind(c.org.id).all();
  let delivered = 0, rto = 0, failed = 0;
  for (const r of results) {
    try { const x = await courierTrack(c, r.id); delivered += x.delivered ? 1 : 0; rto += x.rto ? 1 : 0; } catch (e) { failed++; }
  }
  return { checked: results.length, delivered, rto, failed, at: today() };
}
