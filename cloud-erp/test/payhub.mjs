/* Paying for a plan by UPI through DocBrisk Pay (src/billing.js), against a stand-in hub that checks every request's
   signature like the real one, and the Rs 1 test payment. Run with the worker started as:
     npx wrangler dev --port 8789 --var PAYHUB_URL:http://127.0.0.1:8896 --var PAYHUB_SECRET:test-hub-secret-0123456789
       --var PAY_PRIMARY:upi --var OWNER_EMAILS:owner-paytest@test.in
   then:  node test/payhub.mjs http://localhost:8789          The real hub and real money are never used. */
import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:8789', PORT = +(process.env.PAYHUB_MOCK_PORT || 8896);
const SECRET = 'test-hub-secret-0123456789', TEST_EMAIL = 'owner-paytest@test.in';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---- the stand-in hub: orders, signed like the real one ---- */
const orders = new Map(); let badSigs = 0;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const ts = req.headers['x-payhub-ts'], want = 'v1=' + hmac(`${ts}\n${req.method}\n${req.url}\n${sha(raw)}`);
    if (req.headers['x-payhub-sig'] !== want || req.headers['x-payhub-key'] !== 'smarttrader-erp') { badSigs++; return send(401, { error: 'bad signature' }); }
    if (req.method === 'POST' && req.url === '/api/pay/hub/orders') {
      const b = JSON.parse(raw), id = 'hub_' + crypto.randomBytes(5).toString('hex'), amt = b.base_paise + 7;     // the hub makes each amount unique
      orders.set(id, { ...b, id, amount_paise: amt, status: 'pending' });
      return send(201, { order_id: id, amount_paise: amt, amount: amt / 100, base: b.base_paise / 100, vpa: 'shop@upi', payee: 'DocBrisk', note: 'DB' + id.slice(-5),
        upi_link: `upi://pay?pa=shop@upi&am=${amt / 100}`, qr_text: `upi://pay?pa=shop@upi&am=${amt / 100}`, app_links: {}, vpa_kind: 'personal',
        created_at: Date.now(), expires_at: Date.now() + 900000, server_time: Date.now() });
    }
    const m = /^\/api\/pay\/hub\/orders\/([\w-]+)(\/fulfilled)?$/.exec(req.url);
    if (m && orders.has(m[1])) return send(200, { ...orders.get(m[1]), order_id: m[1] });
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));

const rq = async (method, path, body, o = {}) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'CF-Connecting-IP': o.ip || '198.51.100.88',
    ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.headers || {}) }, body: o.raw !== undefined ? o.raw : body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let data = {}; try { data = JSON.parse(t); } catch (e) { data = { _text: t }; }
  const sc = res.headers.get('set-cookie'); return { status: res.status, data, cookie: sc ? sc.split(';')[0] : '' };
};
/* the hub's callback to the ERP: X-PayHub-Sig = v1=HMAC(secret, ts + "." + body) */
const callback = (body, { ts = Date.now(), secret = SECRET } = {}) => { const raw = JSON.stringify(body);
  return rq('POST', '/api/billing/upi-callback', undefined, { raw, headers: { 'X-PayHub-Ts': String(ts), 'X-PayHub-Sig': 'v1=' + crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex') } }); };
const paid = (ref, o, extra = {}) => ({ event: 'payment.confirmed', product: 'smarttrader-erp', client_ref: ref, base_paise: o.base_paise, order_id: o.id, rrn: '412345678901', paid_paise: o.amount_paise, ...extra });

const su = await rq('POST', '/api/auth/signup', { business: 'Pay Test Traders', name: 'Owner', email: TEST_EMAIL, password: 'Paytest-pass-123', state: 'Rajasthan' });
if (su.status !== 200) { console.log('signup failed', su.status, su.data); process.exit(1); }
const O = async (m, p, b) => (await rq(m, p, b, { cookie: su.cookie })).data;
const plan0 = await O('GET', '/api/plan');
check('UPI is the way to pay, and the test payment is offered to this e-mail only', plan0.billing === 'upi' && plan0.test_pay === true, JSON.stringify({ b: plan0.billing, t: plan0.test_pay }));

const other = await rq('POST', '/api/auth/signup', { business: 'Other Traders', name: 'X', email: `other-pay${Date.now()}@test.in`, password: 'Otherpay-pass-123', state: 'Rajasthan' }, { ip: '198.51.100.89' });
const X = (m, p, b) => rq(m, p, b, { cookie: other.cookie, ip: '198.51.100.89' });
check('anyone else neither sees nor can start a test payment', (await X('GET', '/api/plan')).data.test_pay === false && (await X('POST', '/api/billing/start', { plan: 'test' })).status === 400);

/* ---- the Rs 1 test payment ---- */
const before = (await O('GET', '/api/me')).plan;
const t = await O('POST', '/api/billing/start', { plan: 'test' });
const tho = orders.get(t.upi && t.upi.order_id);
check('the test checkout asks the hub for Rs 1, signed as the hub expects', t.method === 'upi' && t.amount === 100 && tho && tho.base_paise === 100 && badSigs === 0, JSON.stringify([t, badSigs]));
check('a callback with a wrong signature is refused', (await callback(paid(t.ref, tho), { secret: 'not-the-secret' })).status === 401);
check('an old callback (replayed after 10 minutes) is refused', (await callback(paid(t.ref, tho), { ts: Date.now() - 11 * 60000 })).status === 401);
check('a callback for another amount is refused and switches nothing on', (await callback(paid(t.ref, tho, { base_paise: 99 }))).status === 409
  && (await O('GET', `/api/billing/status?ref=${t.ref}`)).status === 'created');
check('a callback for another product is refused', (await callback(paid(t.ref, tho, { product: 'docbrisk-pro' }))).status === 409);
const ok = await callback(paid(t.ref, tho));
const st = await O('GET', `/api/billing/status?ref=${t.ref}`);
check('the hub says paid: the test payment is confirmed by itself', ok.status === 200 && ok.data.ok === true && st.status === 'paid' && st.plan === 'test' && /^upi:/.test(st.payment_id), JSON.stringify([ok.status, ok.data, st]));
const after = (await O('GET', '/api/me')).plan;
check('the test payment changes no plan', after.key === before.key && after.until === before.until, JSON.stringify([before, after]));
check('the same callback again is harmless', (await callback(paid(t.ref, tho))).data.already === true);
const hist = (await O('GET', '/api/plan')).history;
check('it is listed as a paid test payment of Rs 1', hist.some((h) => h.plan === 'test' && h.status === 'paid' && h.amount === 1), JSON.stringify(hist));

/* ---- a real plan by UPI ---- */
const s = await O('POST', '/api/billing/start', { plan: 'starter' });
const so = orders.get(s.upi && s.upi.order_id);
check('a real plan asks for its price with GST', s.method === 'upi' && s.amount === Math.round(999 * 1.18) * 100 && so.base_paise === s.amount, JSON.stringify(s));
const ok2 = await callback(paid(s.ref, so));
const me = (await O('GET', '/api/me')).plan;
const year = new Date(Date.now() + 5.5 * 3600e3); year.setUTCFullYear(year.getUTCFullYear() + 1);
check('the hub says paid: the plan switches on by itself for a year', ok2.status === 200 && me.key === 'starter' && me.until >= year.toISOString().slice(0, 10).replace(/-\d\d$/, ''), JSON.stringify(me));
const until1 = me.until;
await callback(paid(s.ref, so));
check('a repeated callback adds no second year', (await O('GET', '/api/me')).plan.until === until1);
check('a callback for a checkout nobody started is refused', (await callback(paid('0'.repeat(32), so))).status === 404);
check('every request to the hub was signed correctly', badSigs === 0, String(badSigs));

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
