/* Paying a table's bill online through the shop's own Razorpay (src/dinepay.js), against a stand-in Razorpay.
   Run with the worker started as:  npx wrangler dev --var RAZORPAY_BASE:http://127.0.0.1:8897
   then:                           node test/dinepay.mjs http://localhost:8787
   The real Razorpay is never called by the tests. */
import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.argv[2] || process.env.ERP_URL || 'http://localhost:8787';
const PORT = +(process.env.RAZORPAY_MOCK_PORT || 8897);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

/* ---- the stand-in Razorpay: Payment Links only ---- */
const KEY_ID = 'rzp_test_AbCdEf123456', KEY_SECRET = 'TestKeySecret0123456789', WH = 'webhook-secret-for-tests';
const links = [];
let down = false;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64')) return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    if (req.url === '/v1/payment_links' && req.method === 'POST') {
      if (down) return send(500, { error: { description: 'Server error' } });
      const j = JSON.parse(body), id = 'plink_' + crypto.randomBytes(7).toString('hex');
      links.push({ id, ...j });
      return send(200, { id, short_url: 'https://rzp.io/i/' + id.slice(6, 14), amount: j.amount, reference_id: j.reference_id, status: 'created', notes: j.notes });
    }
    send(404, { error: { description: 'not found' } });
  });
});
await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));

const rq = async (method, path, body, o = {}) => {
  const res = await fetch(BASE + path, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(o.raw ? {} : { 'X-Requested-With': 'SmartTrader' }), ...(o.cookie ? { Cookie: o.cookie } : {}), 'CF-Connecting-IP': o.ip || '198.51.100.201', ...(o.headers || {}) },
    body: o.raw !== undefined ? o.raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { data = { _text: text }; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : '' };
};
const ip = '198.51.100.' + (20 + Math.floor(Math.random() * 150));
const su = await rq('POST', '/api/auth/signup', { business: 'Online Dhaba', name: 'Owner', email: `rzp${Date.now()}@test.in`, password: 'Online-pass-123', state: 'Rajasthan' }, { ip });
if (su.status !== 200) { console.log('signup failed', su.status, su.data); process.exit(1); }
const O = async (m, p, b) => (await rq(m, p, b, { cookie: su.cookie, ip })).data, OE = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
const G = (m, p, b) => rq(m, p, b, { ip: '203.0.113.' + (10 + Math.floor(Math.random() * 200)) });
const sign = (raw, secret = WH) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const hook = (url, ev, secret) => { const raw = JSON.stringify(ev); return rq('POST', url, undefined, { raw, headers: { 'X-Razorpay-Signature': sign(raw, secret) } }); };
const paidEvent = (l, amount = l.amount, payId = 'pay_' + crypto.randomBytes(6).toString('hex')) => ({ event: 'payment_link.paid',
  payload: { payment_link: { entity: { id: l.id, amount: l.amount, amount_paid: amount, status: 'paid', reference_id: l.reference_id, notes: l.notes } },
    payment: { entity: { id: payId, amount, method: 'upi', status: 'captured' } } } });

/* the shop: dishes, two tables, QR ordering on */
const dal = await O('POST', '/api/items', { name: 'Dal Baati', sale_price: 200, gst_rate: 5, is_service: true });
const lassi = await O('POST', '/api/items', { name: 'Lassi', sale_price: 60, gst_rate: 5, is_service: true });
await O('POST', '/api/dine/tables', { count: 2, prefix: 'T' });
const q = await O('PUT', '/api/dine/qr', { qr: true });
const [t1, t2] = q.tables, tok = (t) => t.link.split('/t/')[1];

/* ---- the owner's settings ---- */
check('online payment is off until the keys are saved', (await O('GET', '/api/dine/razorpay')).on === false && (await G('GET', `/api/public/dine/${tok(t1)}/bill`)).data.online === false);
await O('POST', '/api/users', { name: 'Waiter', email: `w${Date.now()}@test.in`, password: 'Waiter-pass-123', role: 'sales' });
const wl = await rq('POST', '/api/auth/login', { email: (await O('GET', '/api/users')).rows.find((u) => u.role === 'sales').email, password: 'Waiter-pass-123' }, { ip });
check('a waiter cannot see or change the Razorpay keys', (await rq('GET', '/api/dine/razorpay', undefined, { cookie: wl.cookie, ip })).status === 403
  && (await rq('PUT', '/api/dine/razorpay', { key_id: KEY_ID, key_secret: KEY_SECRET, webhook_secret: WH }, { cookie: wl.cookie, ip })).status === 403);
check('a wrong Key Id is refused', (await OE('PUT', '/api/dine/razorpay', { key_id: 'pk_live_123', key_secret: KEY_SECRET, webhook_secret: WH })).status === 400);
check('the first save needs both secrets', (await OE('PUT', '/api/dine/razorpay', { key_id: KEY_ID, key_secret: KEY_SECRET })).status === 400);
const saved = await OE('PUT', '/api/dine/razorpay', { key_id: KEY_ID, key_secret: KEY_SECRET, webhook_secret: WH });
const hookUrl = saved.data.webhook_url ? new URL(saved.data.webhook_url).pathname : '';
check('saved: on, with the webhook address; the secrets never come back', saved.status === 200 && saved.data.on && /^\/api\/public\/pg\/razorpay\/[0-9a-f]{24}$/.test(hookUrl)
  && !JSON.stringify(await O('GET', '/api/dine/razorpay')).includes(KEY_SECRET) && !JSON.stringify(await O('GET', '/api/org')).includes(KEY_SECRET), JSON.stringify(saved.data));
const keep = await OE('PUT', '/api/dine/razorpay', { key_id: KEY_ID });
check('saving again with the secrets left empty keeps them', keep.status === 200 && keep.data.webhook_url === saved.data.webhook_url);

/* ---- a guest pays online ---- */
await O('POST', `/api/dine/tables/${t1.id}/kot`, { lines: [{ item_id: dal.id, qty: 2 }, { item_id: lassi.id, qty: 1 }] });
const bill = (await G('GET', `/api/public/dine/${tok(t1)}/bill`)).data;
check('the guest\'s bill offers paying online', bill.online === true && bill.pay === 483, JSON.stringify(bill));
check('a payment link for an old amount is refused', (await G('POST', `/api/public/dine/${tok(t1)}/pay-online`, { amount: bill.pay - 10 })).status === 400 && links.length === 0);
const po = await G('POST', `/api/public/dine/${tok(t1)}/pay-online`, { amount: bill.pay });
const L1 = links[links.length - 1];
check('the guest gets a Razorpay link for exactly the bill, with our notes', po.status === 200 && /^https:\/\/rzp\.io\//.test(po.data.url) && L1.amount === 48300 && L1.currency === 'INR'
  && L1.notes.product === 'smarttrader-dine' && L1.accept_partial === false && /\/t\/[0-9a-f]{24}$/.test(L1.callback_url), JSON.stringify([po.status, po.data, L1]));
check('a link waiting for payment is not in the staff\'s queue', !(await O('GET', '/api/dine/requests')).requests.some((r) => r.kind === 'pay'));
check('a webhook with a wrong signature is refused, and bills nothing', (await hook(hookUrl, paidEvent(L1), 'wrong-secret')).status === 401 && (await O('GET', `/api/dine/tables/${t1.id}`)).order !== null);
check('an unknown webhook address is refused', (await hook('/api/public/pg/razorpay/' + 'a'.repeat(24), paidEvent(L1))).status === 404);
check('other events are acknowledged and ignored', (await hook(hookUrl, { event: 'payment.failed', payload: {} })).data.ignored === 'event');
const wh = await hook(hookUrl, paidEvent(L1));
const after = await O('GET', `/api/dine/tables/${t1.id}`);
const invs = (await O('GET', '/api/docs?type=INV')).rows;
check('Razorpay says paid: the bill is made, paid in full, and the table is free', wh.status === 200 && /^.+/.test(wh.data.bill || '') && after.order === null
  && invs.length === 1 && invs[0].status === 'paid' && invs[0].total === 483, JSON.stringify([wh.status, wh.data, invs.map((d) => [d.number, d.status, d.total])]));
const st = (await G('GET', `/api/public/dine/${tok(t1)}/status?r=${po.data.id}.${po.data.token}`)).data.requests[0];
check('the guest sees the payment done', st && st.status === 'done', JSON.stringify(st));
const again = await hook(hookUrl, paidEvent(L1));
check('Razorpay sending the same webhook again bills nothing more', again.status === 200 && again.data.already === 'done' && (await O('GET', '/api/docs?type=INV')).rows.length === 1, JSON.stringify(again.data));
const audit = (await O('GET', '/api/audit')).rows || [];
check('the audit log says Razorpay paid it', audit.some((a) => /paid online \(Razorpay\)/.test(a.action)), JSON.stringify(audit.slice(0, 3)));

/* ---- the bill changed after the guest paid: nothing guessed, the staff decide ---- */
await O('POST', `/api/dine/tables/${t2.id}/kot`, { lines: [{ item_id: dal.id, qty: 1 }] });
const b2 = (await G('GET', `/api/public/dine/${tok(t2)}/bill`)).data;
const po2 = await G('POST', `/api/public/dine/${tok(t2)}/pay-online`, { amount: b2.pay });
const L2 = links[links.length - 1];
await O('POST', `/api/dine/tables/${t2.id}/kot`, { lines: [{ item_id: lassi.id, qty: 1 }] });
const wh2 = await hook(hookUrl, paidEvent(L2));
const q2 = (await O('GET', '/api/dine/requests')).requests.find((r) => r.id === po2.data.id);
check('paid, but the bill grew meanwhile: no bill is made; it waits for the staff as "Paid online, check"', wh2.status === 200 && wh2.data.to_staff && q2 && q2.help === 'Paid online, check' && /^Razorpay pay_/.test(q2.note)
  && (await O('GET', `/api/dine/tables/${t2.id}`)).order !== null && (await O('GET', '/api/docs?type=INV')).rows.length === 1, JSON.stringify([wh2.data, q2]));
check('a webhook paying less than the link goes to the staff too', await (async () => {
  const b3 = (await G('GET', `/api/public/dine/${tok(t2)}/bill`)).data; const p3 = await G('POST', `/api/public/dine/${tok(t2)}/pay-online`, { amount: b3.pay });
  const r3 = await hook(hookUrl, paidEvent(links[links.length - 1], 100)); return p3.status === 200 && /paid ₹1/.test(r3.data.to_staff || ''); })());

/* ---- Razorpay down, and switching off ---- */
down = true;
const pd = await G('POST', `/api/public/dine/${tok(t2)}/pay-online`, { amount: (await G('GET', `/api/public/dine/${tok(t2)}/bill`)).data.pay });
check('Razorpay not answering: the guest is told to pay by UPI or at the counter', pd.status === 502 && /UPI or at the counter/.test(pd.data.error || ''), JSON.stringify(pd.data));
down = false;
await O('DELETE', '/api/dine/razorpay');
check('switched off: the bill offers no online payment, a link is refused, and the old webhook address is gone',
  (await G('GET', `/api/public/dine/${tok(t2)}/bill`)).data.online === false && (await G('POST', `/api/public/dine/${tok(t2)}/pay-online`, { amount: 1 })).status === 400
  && (await hook(hookUrl, paidEvent(L2))).status === 404);

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
