/* Courier booking through Shiprocket (one account reaches Delhivery, Blue Dart, DTDC, Ekart, Xpressbees, Shadowfax,
   India Post and more), from the Dispatch Desk: the courier's rates for the parcel, then one tap books it: the order is
   created on Shiprocket, the AWB is assigned, the pickup is asked for and the courier's label comes back. Tracking is
   read back on demand ("Refresh tracking"); a delivered parcel is marked delivered by itself.
   The owner connects once in Settings → Orders & dispatch with a Shiprocket API user (Shiprocket panel → Settings → API).
   Its password and the 10-day token are kept sealed (AES-GCM, src/gdrive.js seal) and never sent back to the browser.
   SHIPROCKET_BASE (a deployment variable, never a user setting) points the tests at a stand-in server. */
import { bad, forbidden, notFound, str, num, nowIso, today, HttpError } from './lib.js';
import { can, requireCan, legacySecret } from './auth.js';
import { auditStatement } from './engine.js';
import { seal, unseal } from './gdrive.js';
import { mayShip as mayDispatch } from './dispatch.js';

const BASE = (env) => String((env && env.SHIPROCKET_BASE) || 'https://apiv2.shiprocket.in').replace(/\/+$/, '');
const TOKEN_DAYS = 9;      // Shiprocket tokens last 10 days; a fresh one is taken a day early
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
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = null; }
    return { ok: r.ok, status: r.status, j: j && typeof j === 'object' ? j : {} };     // an empty or odd body reads as {}
  } catch (e) { throw bad('Shiprocket did not answer. Try again in a minute.'); }
}
async function login(env, email, password) {
  const r = await call(env, '/v1/external/auth/login', { method: 'POST', body: { email, password } });
  if (!r.ok || !r.j.token) throw bad(`Shiprocket did not accept this API user: ${errText(r.j) || 'wrong email or password'}. Use the API user made in Shiprocket → Settings → API.`);
  return r.j.token;
}
const linkOf = (c) => c.db.prepare(`SELECT * FROM courier_links WHERE org_id = ?`).bind(c.org.id).first();
/* the API user's password: today's key, else the key kept in the database before SESSION_SECRET was added (sealed again
   with today's key); a password neither opens asks the owner to connect again, never a server error */
async function passwordOf(c, link) {
  try { return await unseal(c.env, link.secret_enc); } catch (e) { /* try the older key */ }
  const old = await legacySecret(c.env);
  if (old) {
    try {
      const pw = await unseal(c.env, link.secret_enc, old);
      await c.db.prepare(`UPDATE courier_links SET secret_enc = ? WHERE org_id = ? AND secret_enc = ?`).bind(await seal(c.env, pw), c.org.id, link.secret_enc).run();
      return pw;
    } catch (e) { /* neither key */ }
  }
  throw bad('The saved Shiprocket login cannot be read any more. Connect Shiprocket again in Settings → Orders & dispatch.');
}
async function tokenOf(c, link, fresh = false) {
  if (!fresh && link.token_enc && link.token_at && Date.now() - Date.parse(link.token_at) < TOKEN_DAYS * 86400e3) {
    try { return await unseal(c.env, link.token_enc); } catch (e) { /* sealed with an older key: log in again */ }
  }
  const token = await login(c.env, link.email, await passwordOf(c, link));
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
  // another Shiprocket account has its own pickup addresses: the old choice is dropped when the email changes
  await c.db.batch([c.db.prepare(`INSERT INTO courier_links (org_id, provider, email, secret_enc, token_enc, token_at, created_by, created_at) VALUES (?, 'shiprocket', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET provider = excluded.provider, secret_enc = excluded.secret_enc, token_enc = excluded.token_enc, token_at = excluded.token_at,
        pickup = CASE WHEN courier_links.email = excluded.email THEN courier_links.pickup ELSE '' END,
        pickup_pin = CASE WHEN courier_links.email = excluded.email THEN courier_links.pickup_pin ELSE '' END, email = excluded.email`)
    .bind(c.org.id, email, await seal(c.env, password), await seal(c.env, token), now, c.user.id, now), auditStatement(c, 'courier connected', `Shiprocket ${email}`)]);
  const link = await linkOf(c), list = await pickups(c, link);
  const keep = list.find((p) => p.name === link.pickup);
  if (list.length && !keep) {
    await c.db.prepare(`UPDATE courier_links SET pickup = ?, pickup_pin = ? WHERE org_id = ?`).bind(list[0].name, list[0].pin, c.org.id).run();
  } else if (keep && keep.pin !== link.pickup_pin) {
    await c.db.prepare(`UPDATE courier_links SET pickup_pin = ? WHERE org_id = ?`).bind(keep.pin, c.org.id).run();
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
  if (d.ship === 'delivered' || d.ship === 'rto') throw bad(`${d.number} is already ${d.ship === 'rto' ? 'returned' : 'delivered'}.`);
  if (!d.address || !/^\d{6}$/.test(d.pincode || '') || !/\d{10}$/.test(String(d.phone || '').replace(/\D/g, ''))) throw bad(`Add ${d.party || 'the customer'}'s address, 6-digit pincode and mobile on the customer page first.`);
  const w = dims(b), courierId = +b.courier_id || 0, ref = refOf(d);
  // 0. one booking at a time: the parcel is marked "booking" (compare-and-swap on what was read); a second tap, or a
  //    second person, is turned away instead of making a second Shiprocket order. A mark older than 3 minutes is stale.
  if (ref.booking && Date.now() - Date.parse(ref.booking) < 180e3) throw new HttpError(409, `${d.number} is being booked right now. Wait a moment and refresh.`);
  const lock = await c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ? AND awb = '' AND ship_ref = ?`)
    .bind(JSON.stringify({ ...ref, booking: nowIso() }), d.id, c.org.id, d.ship_ref || '').run();
  if (!lock.meta.changes) throw new HttpError(409, `${d.number} is being booked right now. Wait a moment and refresh.`);
  const unlock = () => c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ? AND awb = ''`).bind(JSON.stringify(ref), d.id, c.org.id).run();
  try {
    return await book(c, d, link, ref, w, courierId);
  } catch (e) { await unlock().catch(() => {}); throw e; }
}
async function book(c, d, link, ref, w, courierId) {
  // a Shiprocket order made earlier under another account is not this account's: start again
  if (ref.shipment_id && ref.acct && ref.acct !== link.email) { delete ref.order_id; delete ref.shipment_id; }
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
    Object.assign(ref, { p: 'shiprocket', acct: link.email, order_id: order.order_id, shipment_id: order.shipment_id });
    await c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ?`).bind(JSON.stringify({ ...ref, booking: nowIso() }), d.id, c.org.id).run();
  }
  // 2. the AWB (the chosen courier, or Shiprocket's pick)
  const awb = await sr(c, link, '/v1/external/courier/assign/awb', { method: 'POST', body: { shipment_id: ref.shipment_id, ...(courierId ? { courier_id: courierId } : {}) } });
  const data = (awb.response && awb.response.data) || {};
  // Shiprocket answers 200 with awb_assign_status 0 and the reason in response.data.awb_assign_error (no balance, courier not serving)
  if (!data.awb_code || awb.awb_assign_status === 0) {
    throw bad(`Shiprocket could not assign a courier: ${str(data.awb_assign_error, 200) || errText(awb) || errText(awb.response) || 'try another courier'}`);
  }
  // 3. pickup and label: the parcel is booked even if these two fail; they can be asked again from Shiprocket
  let label = '', pickup = '';
  try { const pk = await sr(c, link, '/v1/external/courier/generate/pickup', { method: 'POST', body: { shipment_id: [ref.shipment_id] } }); pickup = str((pk.response && (pk.response.pickup_scheduled_date || pk.response.data)) || '', 40); } catch (e) { pickup = ''; }
  try { const lb = await sr(c, link, '/v1/external/courier/generate/label', { method: 'POST', body: { shipment_id: [ref.shipment_id] } }); label = /^https:\/\//.test(lb.label_url || '') ? str(lb.label_url, 500) : ''; } catch (e) { label = ''; }
  Object.assign(ref, { courier_id: +data.courier_company_id || courierId, label_url: label, pickup, status: 'AWB assigned', checked_at: nowIso() });
  delete ref.booking;
  const courier = str(data.courier_name, 40) || 'Shiprocket', code = str(data.awb_code, 40);
  // awb = '' : a tracking number typed by hand meanwhile is never overwritten
  const [u] = await c.db.batch([c.db.prepare(`UPDATE docs SET courier = ?, awb = ?, ship = 'shipped', ship_at = ?, ship_ref = ? WHERE id = ? AND org_id = ? AND awb = ''`)
    .bind(courier, code, nowIso(), JSON.stringify(ref), d.id, c.org.id), auditStatement(c, 'courier booked', `${d.number}: ${courier} ${code}`)]);
  if (!u.meta.changes) throw new HttpError(409, `${d.number} got another tracking number meanwhile. Shiprocket AWB ${code} was also made: cancel it in Shiprocket if it is not needed.`);
  return { ok: true, courier, awb: code, label_url: label, pickup };
}

/* POST /api/courier/track/:id: the courier's latest status; delivered marks the parcel delivered */
export async function courierTrack(c, id) {
  const d = await parcel(c, id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  if (!d.awb) throw bad(`${d.number} has no tracking number yet.`);
  return trackOne(c, link, d);
}
async function trackOne(c, link, d) {
  const j = await sr(c, link, `/v1/external/courier/track/awb/${encodeURIComponent(d.awb)}`);
  const t = j.tracking_data || {}, last = (Array.isArray(t.shipment_track) && t.shipment_track[0]) || {};
  const status = str(last.current_status || t.current_status || '', 60).toUpperCase() || 'NO UPDATE YET';
  const ref = { ...refOf(d), status, track_url: /^https:\/\//.test(t.track_url || '') ? str(t.track_url, 300) : refOf(d).track_url || '', checked_at: nowIso() };
  const delivered = status === 'DELIVERED' && d.ship === 'shipped';
  await c.db.batch([c.db.prepare(`UPDATE docs SET ship_ref = ?${delivered ? `, ship = 'delivered', ship_at = ?` : ''} WHERE id = ? AND org_id = ?`)
    .bind(...[JSON.stringify(ref), ...(delivered ? [nowIso()] : []), d.id, c.org.id]),
    ...(delivered ? [auditStatement(c, 'dispatch', `${d.number}: delivered (courier tracking)`)] : [])]);
  // a parcel coming back is only marked returned by a person, once it is in the godown (RTO cancels the delivery note)
  return { status, delivered, rto: /^RTO/.test(status), track_url: ref.track_url };
}
/* POST /api/courier/sync: refresh the parcels on the way (30 at a time) */
/* the ones checked longest ago come first, so with more than 30 on the way every parcel gets its turn */
export async function courierSync(c) {
  if (!mayDispatch(c.user)) throw forbidden('Your role cannot dispatch orders.');
  const link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  const { results } = await c.db.prepare(`SELECT id, number, awb, ship, ship_ref FROM docs WHERE org_id = ? AND type = 'DN' AND status != 'cancelled' AND ship = 'shipped' AND awb != ''
      AND json_valid(ship_ref) AND json_extract(ship_ref, '$.p') = 'shiprocket'
      ORDER BY COALESCE(json_extract(ship_ref, '$.checked_at'), ''), id LIMIT 30`).bind(c.org.id).all();
  let delivered = 0, rto = 0, failed = 0;
  await tokenOf(c, link);                                  // one login (if due) before the parcels, not one each
  for (let i = 0; i < results.length; i += 5) {           // five at a time
    const got = await Promise.allSettled(results.slice(i, i + 5).map((d) => trackOne(c, link, d)));
    for (const g of got) { if (g.status === 'fulfilled') { delivered += g.value.delivered ? 1 : 0; rto += g.value.rto ? 1 : 0; } else failed++; }
  }
  return { checked: results.length, delivered, rto, failed, at: today() };
}

/* ---------- failed deliveries (NDR) and returns ----------
   NDR: the courier could not deliver (customer away, refused, wrong address). Shiprocket lists them; the shop asks for
   another attempt (with a new phone or address line if they have one) or has it sent back (RTO).
   Return: a customer sends a delivered item back: Shiprocket's return order brings it from the customer to the pickup
   address. The money side stays where it is in the app: a Sales Return (credit note) when the goods arrive. */
const NDR_ACTIONS = { reattempt: 're-attempt', return: 'return' };
/* GET /api/courier/ndr: this business's parcels waiting for an answer on Shiprocket */
export async function courierNdr(c) {
  if (!mayDispatch(c.user)) throw forbidden('Your role cannot dispatch orders.');
  const link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  const j = await sr(c, link, '/v1/external/ndr/all?per_page=100');
  const list = Array.isArray(j.data) ? j.data : [];
  const awbs = list.map((x) => str(x.awb_code, 40)).filter(Boolean);
  // only the parcels booked from this business (an AWB not in its delivery notes is left out)
  const mine = awbs.length ? (await c.db.prepare(`SELECT id, number, awb, party_id, (SELECT name FROM parties WHERE id = docs.party_id) AS party FROM docs
      WHERE org_id = ? AND type = 'DN' AND awb IN (${awbs.map(() => '?').join(',')})`).bind(c.org.id, ...awbs).all()).results : [];
  const by = new Map(mine.map((d) => [d.awb, d]));
  return { rows: list.filter((x) => by.has(str(x.awb_code, 40))).map((x) => {
    const d = by.get(str(x.awb_code, 40));
    return { dn_id: d.id, number: d.number, party: d.party, awb: d.awb, courier: str(x.courier, 60), reason: str(x.reason, 200), attempts: +x.attempts || 0,
      raised_at: str(x.ndr_raised_at, 30), status: str(x.status, 60) };
  }) };
}
/* POST /api/courier/ndr/:id { action: reattempt | return, comments, phone, address, date } */
export async function courierNdrAction(c, id, b) {
  const d = await parcel(c, id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  if (!d.awb) throw bad(`${d.number} has no tracking number.`);
  const action = NDR_ACTIONS[String(b.action || '')];
  if (!action) throw bad('Choose: try delivering again, or send it back.');
  const comments = str(b.comments, 200) || (action === 'return' ? 'Send back to the seller' : 'Please deliver again');
  const phone = String(b.phone || '').replace(/\D/g, '').slice(-10), address = str(b.address, 190);
  if (b.phone && phone.length !== 10) throw bad('The new mobile number has 10 digits.');
  const on = b.date ? String(b.date).slice(0, 10) : '';
  if (on && (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on < today())) throw bad('Choose a date from today on.');
  await sr(c, link, `/v1/external/ndr/${encodeURIComponent(d.awb)}/action`, { method: 'POST', body: {
    action, comments, ...(action === 're-attempt' && phone ? { phone } : {}), ...(action === 're-attempt' && address ? { address1: address } : {}),
    ...(action === 're-attempt' && on ? { deferred_date: on } : {}) } });
  const ref = { ...refOf(d), ndr: { action, at: nowIso(), comments } };
  await c.db.batch([c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ?`).bind(JSON.stringify(ref), d.id, c.org.id),
    auditStatement(c, 'dispatch', `${d.number}: failed delivery, ${action === 'return' ? 'asked to send back' : 'asked to try again'}`)]);
  return { ok: true, action: b.action };
}
/* POST /api/courier/return { dn_id, items: [{ line_id, qty }], reason, weight, length, breadth, height }: a pickup from the
   customer back to the business's pickup address */
export async function courierReturn(c, b) {
  const d = await parcel(c, +b.dn_id), link = await linkOf(c);
  if (!link) throw bad('Connect Shiprocket first.');
  if (d.ship !== 'delivered') throw bad(`${d.number} is not delivered yet: a return is for goods the customer has.`);
  const ref = refOf(d);
  if (ref.ret && ref.ret.awb) throw bad(`A return for ${d.number} is already booked (${ref.ret.awb}).`);
  if (!d.address || !/^\d{6}$/.test(d.pincode || '') || !/\d{10}$/.test(String(d.phone || '').replace(/\D/g, ''))) throw bad(`Add ${d.party || 'the customer'}'s address, 6-digit pincode and mobile first.`);
  const { results: lines } = await c.db.prepare(`SELECT l.*, i.name AS item, i.sku, i.hsn FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ?`).bind(d.id).all();
  const want = Array.isArray(b.items) && b.items.length ? b.items : lines.map((l) => ({ line_id: l.id, qty: l.qty }));
  const items = [];
  for (const w of want) {
    const l = lines.find((x) => x.id === +w.line_id);
    if (!l) throw bad('A returned item is not on this delivery note.');
    const qty = num(w.qty, 'Quantity', { min: 0, max: l.qty });
    if (!qty) continue;
    items.push({ name: str(l.item || l.description, 100) || 'Item', sku: str(l.sku || `ST${l.item_id || l.id}`, 40), units: Math.max(1, Math.ceil(qty)),
      selling_price: Math.round(l.total / Math.max(1, l.qty)) / 100, hsn: str(l.hsn, 10), return_reason: str(b.reason, 100) || undefined });
  }
  if (!items.length) throw bad('Choose what comes back.');
  const pickups = await (async () => { try { return await sr(c, link, '/v1/external/settings/company/pickup'); } catch (e) { return {}; } })();
  const list = (pickups.data && (pickups.data.shipping_address || pickups.data)) || [];
  const home = (Array.isArray(list) ? list : []).find((p) => p.pickup_location === link.pickup);
  if (!home) throw bad('The pickup address chosen in Settings → Orders & dispatch is not on Shiprocket any more. Choose it again.');
  const w = dims(b), phone = String(d.phone || '').replace(/\D/g, '').slice(-10), [first, ...rest] = String(d.party || 'Customer').split(' ');
  const sub = items.reduce((a, x) => a + x.selling_price * x.units, 0);
  const order = await sr(c, link, '/v1/external/orders/create/return', { method: 'POST', body: {
    order_id: `R-${d.number}`, order_date: today(), pickup_customer_name: first, pickup_last_name: rest.join(' '), pickup_address: str(d.address, 190),
    pickup_city: str(d.city || '', 60) || str(d.state, 60), pickup_state: str(d.state, 60), pickup_country: 'India', pickup_pincode: d.pincode,
    pickup_email: str(d.email, 100) || undefined, pickup_phone: phone,
    shipping_customer_name: str(c.org.name, 60), shipping_address: str(home.address, 190), shipping_city: str(home.city, 60), shipping_state: str(home.state, 60),
    shipping_country: 'India', shipping_pincode: str(home.pin_code, 10), shipping_phone: String(home.phone || c.org.phone || '').replace(/\D/g, '').slice(-10),
    order_items: items, payment_method: 'PREPAID', sub_total: Math.round(sub * 100) / 100, ...w } });
  if (!order.shipment_id) throw bad(`Shiprocket did not make the return: ${errText(order) || 'no shipment id'}`);
  let awb = '', courier = '';
  try {
    const a = await sr(c, link, '/v1/external/courier/assign/awb', { method: 'POST', body: { shipment_id: order.shipment_id, is_return: true } });
    const data = (a.response && a.response.data) || {};
    if (data.awb_code) { awb = str(data.awb_code, 40); courier = str(data.courier_name, 40); }
  } catch (e) { /* the return order stands; a courier can be given in Shiprocket */ }
  ref.ret = { order_id: order.order_id, shipment_id: order.shipment_id, awb, courier, at: nowIso(), items: items.length };
  await c.db.batch([c.db.prepare(`UPDATE docs SET ship_ref = ? WHERE id = ? AND org_id = ?`).bind(JSON.stringify(ref), d.id, c.org.id),
    auditStatement(c, 'dispatch', `${d.number}: return pickup booked${awb ? ` ${courier} ${awb}` : ' (courier to be given in Shiprocket)'}`)]);
  return { ok: true, awb, courier, note: awb ? '' : 'The return is made on Shiprocket; give it a courier there (Returns), then refresh.' };
}
