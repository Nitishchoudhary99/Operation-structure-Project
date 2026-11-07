/* Courier booking (src/courier.js) against a stand-in Shiprocket that answers like the real API.
   Run with the worker started as:  npx wrangler dev --var SHIPROCKET_BASE:http://127.0.0.1:8899
   then:                           node test/courier.mjs http://localhost:8787
   The real Shiprocket is never called by the tests. */
import http from 'node:http';

const BASE = process.argv[2] || process.env.ERP_URL || 'http://localhost:8787';
const PORT = +(process.env.SHIPROCKET_MOCK_PORT || 8899);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

/* ---- the stand-in Shiprocket ---- */
const seen = { logins: 0, orders: [], awb: [], pickups: 0, labels: 0, rates: [], ndr: [], returns: [] };
const tokens = new Set();
let expireFirst = true, trackState = 'IN TRANSIT', failAwb = '', slowOrder = 0;
const ACCOUNTS = { 'api@shop.in': 'right-pass', 'other@shop.in': 'other-pass' };
const PICKUPS = { 'api@shop.in': [{ pickup_location: 'Imphal Godown', pin_code: '795001', city: 'Imphal', state: 'Manipur', address: 'Paona Bazar', phone: '9876543210' }],
  'other@shop.in': [{ pickup_location: 'Shillong Store', pin_code: '793001', city: 'Shillong', state: 'Meghalaya', address: 'Police Bazar', phone: '9876543211' }] };
const who = new Map();          // token -> account email
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'), j = body ? JSON.parse(body) : {};
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/v1/external/auth/login' && req.method === 'POST') {
      if (!ACCOUNTS[j.email] || ACCOUNTS[j.email] !== j.password) return send(400, { message: 'Invalid email and password combination', status_code: 400 });
      seen.logins++; const t = 'T' + seen.logins; tokens.add(t); who.set(t, j.email); return send(200, { token: t, email: j.email });
    }
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!tokens.has(tok)) return send(401, { message: 'Token has expired', status_code: 401 });
    if (url.pathname === '/v1/external/settings/company/pickup') {
      if (expireFirst) { expireFirst = false; tokens.delete(tok); }      // the next call finds the token expired
      return send(200, { data: { shipping_address: PICKUPS[who.get(tok)] || [] } });
    }
    if (url.pathname === '/v1/external/courier/serviceability/') {
      seen.rates.push(Object.fromEntries(url.searchParams));
      return send(200, { data: { available_courier_companies: [{ courier_company_id: 10, courier_name: 'Delhivery Surface', rate: 85, estimated_delivery_days: '5', cod_charges: 40 },
        { courier_company_id: 24, courier_name: 'India Post', rate: 60, estimated_delivery_days: '7', cod_charges: 30 }] } });
    }
    if (url.pathname === '/v1/external/orders/create/adhoc') {
      seen.orders.push(j);
      if (slowOrder) { const ms = slowOrder; slowOrder = 0; return setTimeout(() => send(200, { order_id: 555000 + seen.orders.length, shipment_id: 777000 + seen.orders.length, status: 'NEW' }), ms); }
      const miss = ['order_id', 'order_date', 'pickup_location', 'billing_customer_name', 'billing_address', 'billing_city', 'billing_pincode', 'billing_state', 'billing_country', 'billing_phone', 'order_items', 'payment_method', 'sub_total', 'length', 'breadth', 'height', 'weight'].filter((k) => j[k] === undefined || j[k] === '');
      if (miss.length) return send(422, { message: 'Oops! Invalid Data.', errors: Object.fromEntries(miss.map((k) => [k, [`The ${k} field is required.`]])) });
      return send(200, { order_id: 555000 + seen.orders.length, shipment_id: 777000 + seen.orders.length, status: 'NEW' });
    }
    if (url.pathname === '/v1/external/orders/create/return') {
      seen.returns.push(j);
      return send(200, { order_id: 666001, shipment_id: 888001, status: 'RETURN PENDING' });
    }
    if (url.pathname === '/v1/external/ndr/all') {
      return send(200, { data: [{ id: 1, awb_code: 'AWB777002', courier: 'Delhivery Surface', reason: 'Customer not available', attempts: 1, ndr_raised_at: '2026-11-06 18:00:00', status: 'NDR' },
        { id: 2, awb_code: 'SOMEONE-ELSES-AWB', courier: 'DTDC', reason: 'Refused', attempts: 2, status: 'NDR' }] });
    }
    const nm = url.pathname.match(/^\/v1\/external\/ndr\/([^/]+)\/action$/);
    if (nm) { seen.ndr.push({ awb: decodeURIComponent(nm[1]), ...j }); return send(200, { status: 'success' }); }
    if (url.pathname === '/v1/external/courier/assign/awb') {
      seen.awb.push(j);
      if (failAwb) { const m = failAwb; failAwb = ''; return send(200, { awb_assign_status: 0, response: { data: { awb_assign_error: m } } }); }
      if (j.is_return) return send(200, { awb_assign_status: 1, response: { data: { awb_code: 'RET123', courier_name: 'Xpressbees' } } });
      if (!(j.shipment_id > 777000 && j.shipment_id <= 777000 + seen.orders.length)) return send(400, { message: 'Invalid shipment' });
      return send(200, { awb_assign_status: 1, response: { data: { awb_code: j.shipment_id === 777001 ? 'AWB998877' : 'AWB' + j.shipment_id, courier_company_id: j.courier_id || 10,
        courier_name: j.courier_id === 24 ? 'India Post' : 'Delhivery Surface' } } });
    }
    if (url.pathname === '/v1/external/courier/generate/pickup') { seen.pickups++; return send(200, { pickup_status: 1, response: { pickup_scheduled_date: '2026-11-08 12:00:00' } }); }
    if (url.pathname === '/v1/external/courier/generate/label') { seen.labels++; return send(200, { label_created: 1, label_url: 'https://kr-shipmultichannel.s3.ap-south-1.amazonaws.com/label-777001.pdf' }); }
    const tm = url.pathname.match(/^\/v1\/external\/courier\/track\/awb\/([^/]+)$/);
    if (tm) {
      const a = decodeURIComponent(tm[1]), st = a === 'AWB998877' ? trackState : 'IN TRANSIT';
      return send(200, { tracking_data: { track_status: 1, shipment_status: st === 'DELIVERED' ? 7 : 6, shipment_track: [{ awb_code: a, current_status: st }], track_url: `https://shiprocket.co/tracking/${a}` } });
    }
    return send(404, { message: 'Not found' });
  });
});
await new Promise((ok) => mock.listen(PORT, '127.0.0.1', ok));

/* ---- the ERP ---- */
let cookie = '';
const ip = '203.0.113.' + (60 + Math.floor(Math.random() * 100));
async function api(method, path, body, expectError) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let data = {}; try { data = JSON.parse(t); } catch (e) { data = { _text: t }; }
  if (!expectError && !res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error}`);
  return expectError ? { status: res.status, ...data } : data;
}
try {
  const em = `courier${Date.now()}@test.in`;
  await api('POST', '/api/auth/signup', { business: 'Kapda Ghar', name: 'Owner', email: em, password: 'Owner-pass-12', state: 'Meghalaya' });
  const owner = cookie;
  const accts = Object.fromEntries((await api('GET', '/api/accounts')).rows.map((a) => [a.sys || a.code, a]));
  check('not connected at first', (await api('GET', '/api/courier')).connected === false);
  const bad = await api('POST', '/api/courier/connect', { email: 'api@shop.in', password: 'wrong' }, true);
  check('a wrong Shiprocket password is refused with its message', bad.status === 400 && /Invalid email and password/.test(bad.error), JSON.stringify(bad));
  const con = await api('POST', '/api/courier/connect', { email: 'api@shop.in', password: 'right-pass' });
  check('connected: the first pickup address is chosen', con.connected && con.pickup === 'Imphal Godown' && con.pickup_pin === '795001' && con.pickups.length === 1, JSON.stringify(con));
  check('the password and token never come back', !JSON.stringify(await api('GET', '/api/courier/pickups')).includes('right-pass') && !JSON.stringify(con).includes('T1'));
  const kurti = await api('POST', '/api/items', { name: 'Kurti Red M', sale_price: 500, gst_rate: 5, opening_qty: 10, sku: 'K101-RED-M' });
  const riya = await api('POST', '/api/parties', { name: 'Riya Devi', kind: 'customer', phone: '9876500011', address: 'House 12, Paltan Bazar', city: 'Imphal', state: 'Manipur', pincode: '795001' });
  const noPin = await api('POST', '/api/parties', { name: 'No Pin', kind: 'customer', phone: '9876500012', address: 'Somewhere', state: 'Manipur' });
  const so = await api('POST', '/api/docs', { type: 'SO', party_id: riya.id, pay_mode: 'cod', lines: [{ item_id: kurti.id, qty: 2, rate: 500 }] });
  const dn = await api('POST', '/api/docs', { ...(await api('GET', `/api/docs/${so.id}/convert?to=DN`)), packed_check: true });
  const so2 = await api('POST', '/api/docs', { type: 'SO', party_id: noPin.id, lines: [{ item_id: kurti.id, qty: 1, rate: 500 }] });
  const dn2 = await api('POST', '/api/docs', await api('GET', `/api/docs/${so2.id}/convert?to=DN`));
  const rates = await api('GET', `/api/courier/rates/${dn.id}?weight=0.5`);
  check('rates: cheapest first, with days and COD charge', rates.cod === true && rates.couriers[0].name === 'India Post' && rates.couriers[0].rate === 60 && rates.couriers[1].days === '5', JSON.stringify(rates));
  check('an expired token is renewed by itself', seen.logins === 2, String(seen.logins));     // connect, then one renewal (a wrong password is not counted)
  check('rates ask from the pickup pincode to the customer\'s, as COD', seen.rates[0].pickup_postcode === '795001' && seen.rates[0].delivery_postcode === '795001' && seen.rates[0].cod === '1' && seen.rates[0].weight === '0.5');
  check('no pincode: a clear message', /pincode/.test((await api('GET', `/api/courier/rates/${dn2.id}?weight=0.5`, null, true)).error || ''));
  const bk = await api('POST', '/api/courier/book', { dn_id: dn.id, courier_id: 24, weight: 0.5, length: 20, breadth: 15, height: 5 });
  check('booked: AWB, courier and label come back', bk.awb === 'AWB998877' && bk.courier === 'India Post' && /^https:\/\/.*label-777001\.pdf$/.test(bk.label_url) && seen.pickups === 1 && seen.labels === 1, JSON.stringify(bk));
  const o = seen.orders[0] || {};
  check('the Shiprocket order carries the delivery note, address, COD and items', o.order_id === dn.number && o.billing_pincode === '795001' && o.billing_phone === '9876500011' && o.payment_method === 'COD'
    && o.pickup_location === 'Imphal Godown' && o.order_items.length === 1 && o.order_items[0].units === 2 && o.order_items[0].sku === 'K101-RED-M' && o.sub_total === 1050 && o.weight === 0.5, JSON.stringify(o));
  const B = await api('GET', '/api/dispatch');
  const row = B.shipped.find((r) => r.id === dn.id);
  check('the parcel moves to On the way with its tracking number', row && row.awb === 'AWB998877' && row.courier === 'India Post' && row.sr && row.sr.label_url && !('shipment_id' in row.sr), JSON.stringify(row && row.sr));
  check('booking twice is refused', (await api('POST', '/api/courier/book', { dn_id: dn.id, weight: 0.5 }, true)).status === 400);
  const t1 = await api('POST', `/api/courier/track/${dn.id}`);
  check('tracking reads the courier status', t1.status === 'IN TRANSIT' && !t1.delivered && t1.track_url === 'https://shiprocket.co/tracking/AWB998877');
  trackState = 'DELIVERED';
  const sy = await api('POST', '/api/courier/sync');
  check('refresh all: a delivered parcel is marked delivered by itself', sy.checked === 1 && sy.delivered === 1 && (await api('GET', '/api/dispatch')).done.some((r) => r.id === dn.id && r.ship === 'delivered'), JSON.stringify(sy));
  const nb = await api('POST', '/api/courier/book', { dn_id: dn2.id, weight: 0.5 }, true);
  check('booking without the customer\'s pincode is refused before Shiprocket is asked', nb.status === 400 && /pincode/.test(nb.error) && seen.orders.length === 1);
  check('a wrong weight is refused', (await api('POST', '/api/courier/book', { dn_id: dn2.id, weight: 0 }, true)).status === 400);
  // a delivered parcel the customer sends back: a return pickup from the customer to the pickup address
  const ret = await api('POST', '/api/courier/return', { dn_id: dn.id, reason: 'Size does not fit', weight: 0.5 });
  const rj = seen.returns[0] || {};
  check('return pickup: from the customer to the godown, prepaid, with its own courier', ret.awb === 'RET123' && ret.courier === 'Xpressbees' && rj.order_id === `R-${dn.number}`
    && rj.pickup_pincode === '795001' && rj.pickup_phone === '9876500011' && rj.shipping_pincode === '795001' && rj.shipping_city === 'Imphal' && rj.payment_method === 'PREPAID'
    && rj.order_items.length === 1 && rj.order_items[0].units === 2 && seen.awb.some((a) => a.is_return === true && a.shipment_id === 888001), JSON.stringify(rj));
  check('a second return for the same parcel is refused', (await api('POST', '/api/courier/return', { dn_id: dn.id, weight: 0.5 }, true)).status === 400);
  check('the Done tab shows the return pickup', ((await api('GET', '/api/dispatch')).done.find((r) => r.id === dn.id).sr.ret || {}).awb === 'RET123');
  check('a return is only for a delivered parcel', /not delivered/.test((await api('POST', '/api/courier/return', { dn_id: dn2.id, weight: 0.5 }, true)).error || ''));

  // two taps on Book at the same moment: one Shiprocket order, one AWB
  const so3 = await api('POST', '/api/docs', { type: 'SO', party_id: riya.id, pay_mode: 'prepaid', lines: [{ item_id: kurti.id, qty: 1, rate: 500 }] });
  const dn3 = await api('POST', '/api/docs', await api('GET', `/api/docs/${so3.id}/convert?to=DN`));
  const ordersBefore = seen.orders.length;
  slowOrder = 400;
  const two = await Promise.all([1, 2].map(() => api('POST', '/api/courier/book', { dn_id: dn3.id, weight: 0.5 }, true)));
  check('booking twice at the same moment: one booked, the other told to wait; one Shiprocket order', two.filter((r) => r.status === 200 && r.awb).length === 1
    && two.some((r) => r.status === 409) && seen.orders.length === ordersBefore + 1, JSON.stringify(two.map((r) => r.status || r.awb)));
  const d3 = (await api('GET', '/api/dispatch')).shipped.find((r) => r.id === dn3.id);
  check('the parcel has its own tracking number', d3 && d3.awb === 'AWB' + (777000 + seen.orders.length), JSON.stringify(d3 && d3.awb));

  // Shiprocket says 200 but gives no AWB (wallet empty): its reason is shown, and the retry reuses the same Shiprocket order
  const so4 = await api('POST', '/api/docs', { type: 'SO', party_id: riya.id, pay_mode: 'cod', lines: [{ item_id: kurti.id, qty: 1, rate: 500 }] });
  const dn4 = await api('POST', '/api/docs', await api('GET', `/api/docs/${so4.id}/convert?to=DN`));
  failAwb = 'Insufficient wallet balance';
  const nob = await api('POST', '/api/courier/book', { dn_id: dn4.id, weight: 0.5 }, true);
  check('no AWB: Shiprocket\'s own reason is shown', nob.status === 400 && /Insufficient wallet balance/.test(nob.error), JSON.stringify(nob));
  const n1 = seen.orders.length, again = await api('POST', '/api/courier/book', { dn_id: dn4.id, weight: 0.5 });
  check('the retry books it on the same Shiprocket order', again.awb && seen.orders.length === n1, JSON.stringify([again, seen.orders.length, n1]));

  // failed deliveries (NDR): only this business's parcels, answered from the desk
  const ndr = await api('GET', '/api/courier/ndr');
  check('failed deliveries list shows only our parcels', ndr.rows.length === 1 && ndr.rows[0].awb === 'AWB777002' && ndr.rows[0].reason === 'Customer not available' && ndr.rows[0].dn_id === dn3.id, JSON.stringify(ndr));
  await api('POST', `/api/courier/ndr/${dn3.id}`, { action: 'reattempt', phone: '98765 00099', address: 'Near the temple', date: '2099-01-02' });
  const na = seen.ndr[0] || {};
  check('try again: Shiprocket gets re-attempt with the new phone, address and date', na.awb === 'AWB777002' && na.action === 're-attempt' && na.phone === '9876500099' && na.address1 === 'Near the temple' && na.deferred_date === '2099-01-02', JSON.stringify(na));
  await api('POST', `/api/courier/ndr/${dn3.id}`, { action: 'return' });
  check('send back: Shiprocket gets return', (seen.ndr[1] || {}).action === 'return');
  check('a past date or an unknown answer is refused', (await api('POST', `/api/courier/ndr/${dn3.id}`, { action: 'reattempt', date: '2020-01-01' }, true)).status === 400
    && (await api('POST', `/api/courier/ndr/${dn3.id}`, { action: 'cancel' }, true)).status === 400);

  // another Shiprocket account has other pickup addresses: the old choice is not kept
  const other = await api('POST', '/api/courier/connect', { email: 'other@shop.in', password: 'other-pass' });
  check('a different Shiprocket account picks its own pickup address', other.pickup === 'Shillong Store' && other.pickup_pin === '793001', JSON.stringify(other));
  await api('POST', '/api/courier/connect', { email: 'api@shop.in', password: 'right-pass' });

  // staff rights
  await api('POST', '/api/users', { email: 'store' + em, name: 'Store', role: 'store', password: 'Store-pass-12' });
  await api('POST', '/api/auth/login', { email: 'store' + em, password: 'Store-pass-12' });
  check('godown staff see that a courier is connected, not the account email', (await api('GET', '/api/courier')).connected === true && !(await api('GET', '/api/courier')).email);
  check('godown staff cannot change the courier account', (await api('POST', '/api/courier/connect', { email: 'x@y.in', password: 'z' }, true)).status === 403
    && (await api('DELETE', '/api/courier', null, true)).status === 403);
  cookie = owner;
  await api('DELETE', '/api/courier');
  check('disconnect', (await api('GET', '/api/courier')).connected === false && (await api('POST', `/api/courier/track/${dn.id}`, null, true)).status === 400);
} catch (e) {
  fail++; console.log('FAIL  ' + e.message);
} finally {
  mock.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
