/* Quick Bill (POS) money rules, worked out by hand. node test/pos.mjs http://localhost:8787
   split payment, line discount, MRP (GST-inclusive) price, a repeated save, stock taken once, credit remainder */
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (info ? '  ' + info : '')); } };
const BASE = process.argv[2] || 'http://localhost:8787';
let ck = '';
const ip = '203.0.113.' + (10 + Math.floor(Math.random() * 200));
const rq = async (m, p, b, key) => {
  const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: ck, 'CF-Connecting-IP': ip };
  if (key) h['Idempotency-Key'] = key;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && !ck) ck = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const n = Date.now();
await rq('POST', '/api/auth/signup', { business: 'POS Test Shop', name: 'O', email: `pos${n}@test.in`, password: 'Tenant-pass-1', state: 'Rajasthan' });
const soap = (await rq('POST', '/api/items', { name: 'Soap 100g', barcode: '8901234567890', unit: 'Pcs', gst_rate: 18, sale_price: 50, opening_qty: 20, opening_rate: 30 })).data;
const tea = (await rq('POST', '/api/items', { name: 'Tea 250g', unit: 'Pcs', gst_rate: 5, sale_price: 200, price_incl: 1, opening_qty: 10, opening_rate: 120 })).data;
const cust = (await rq('POST', '/api/parties', { name: 'Ramesh', phone: '9876543210', kind: 'customer' })).data;
const accts = (await rq('GET', '/api/accounts')).data.rows || [];
const sys = (s) => (accts.find((a) => a.sys === s) || accts.find((a) => a.is_cash) || {}).id;
check('setup: two items with stock and a customer', soap.id && tea.id && cust.id && soap.qty_on_hand === 20, JSON.stringify([soap.qty_on_hand, tea.qty_on_hand, cust.id]));
check('a barcode finds its item', (await rq('GET', '/api/items/lookup?code=8901234567890')).data.id === soap.id);
check('an unknown barcode is a clear 404, not a wrong item', (await rq('GET', '/api/items/lookup?code=1111111111111')).status === 404);
// 4 soap @ 50, 10% off, GST 18%: 180 taxable + 32.40 GST = 212.40; 2 tea @ 210 incl. 5% GST (sale 200 + 5%): 420 gross
// total 632.40 -> rounded 632. Paid 300 cash + 200 UPI; 132 on the customer's khata.
const body = { type: 'INV', party_id: cust.id, date: undefined, notes: 'POS sale', lines: [
  { item_id: soap.id, qty: 4, rate: 50, discount_pct: 10, gst_rate: 18 }, { item_id: tea.id, qty: 2, rate: 210, gst_rate: 5, incl: true }],
  payments: [{ amount: 300, account_id: sys('cash') }, { amount: 200, account_id: sys('upi'), reference: 'UPI' }], credit_ok: true };
const key = 'pos-test-' + n;
const d1 = await rq('POST', '/api/docs', body, key);
const d = d1.data;
check('the bill saves', d1.status === 200 && d.number, JSON.stringify(d).slice(0, 300));
check('discount and GST are worked out right (632)', d.total === 632, String(d.total));
check('split payment: 500 paid in two parts, 132 left on khata', d.paid === 500 && d.balance === 132, JSON.stringify([d.paid, d.balance]));
const again = await rq('POST', '/api/docs', body, key);
check('the same save sent again (double tap, lost answer) gives the same bill', again.data.id === d.id && again.data.number === d.number, JSON.stringify([again.status, again.data.id, d.id]));
const items = (await rq('GET', '/api/items')).data.rows || [];
check('stock is taken once: soap 20 -> 16, tea 10 -> 8', items.find((i) => i.id === soap.id).qty_on_hand === 16 && items.find((i) => i.id === tea.id).qty_on_hand === 8,
  JSON.stringify(items.map((i) => [i.name, i.qty_on_hand])));
const pays = (await rq('GET', '/api/payments?kind=receipt')).data.rows || [];
check('two receipts recorded, one per part', pays.filter((p) => p.party_id === cust.id || p.party === 'Ramesh').length === 2, JSON.stringify(pays.map((p) => [p.amount, p.party])));
const over = await rq('POST', '/api/docs', { ...body, payments: [{ amount: 900, account_id: sys('cash') }] }, key + 'b');
check('a part bigger than the bill is capped at the bill', over.status === 200 && over.data.paid === 632 && over.data.balance === 0, JSON.stringify([over.status, over.data.paid]));
const short = await rq('POST', '/api/docs', { ...body, lines: [{ item_id: soap.id, qty: 500, rate: 50, gst_rate: 18 }], payments: [] }, key + 'c');
check('selling more than the stock is refused and nothing is saved', short.status >= 400 && (await rq('GET', '/api/items')).data.rows.find((i) => i.id === soap.id).qty_on_hand === 12, JSON.stringify([short.status, short.data.error]));
// "What hurts most?" and screen use
const st = (await rq('PUT', '/api/settings/setup', { pains: ['udhaar', 'speed', 'nonsense', 'udhaar', 'gst', 'stock'] })).data.setup;
check('pains: unknown and repeated ones dropped, at most 3 kept', JSON.stringify(st.pains) === JSON.stringify(['udhaar', 'speed', 'gst']), JSON.stringify(st.pains));
check('pains: other settings are kept', (await rq('PUT', '/api/settings/setup', { item_defaults: { unit: 'Kg' } })).data.setup.pains.length === 3);
const u1 = await rq('POST', '/api/usage', { screens: { pos: 3, khata: 1, 'BAD NAME': 5, 'x/../y': 2, items: -4 } });
await rq('POST', '/api/usage', { screens: { pos: 2 } });
const ur = (await rq('GET', '/api/usage')).data.rows || [];
check('usage: only screen-like names with real counts are kept', u1.data.kept === 2, JSON.stringify(u1.data));
check('usage: counts add up per screen', (ur.find((r) => r.screen === 'pos') || {}).n === 5 && !ur.some((r) => r.screen === 'items'), JSON.stringify(ur));
const dr = await rq('GET', '/api/doctor');
check('Dukaan Doctor answers on the real database (a new shop: nothing to report)', dr.status === 200 && Array.isArray(dr.data.rows), JSON.stringify(dr));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
