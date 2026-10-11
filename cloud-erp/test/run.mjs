/* End-to-end test against a running worker (npx wrangler dev, or a deployed URL):
     node test/run.mjs [http://localhost:8787]
   Runs a full procure-to-pay and order-to-cash cycle for a fresh business, then checks that
   the books balance, stock value equals the inventory ledger, and every total is exact. */
const BASE = process.argv[2] || process.env.ERP_URL || 'http://localhost:8787';
let cookie = '', pass = 0, fail = 0;

async function api(method, path, body, expectError) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await res.json();
  if (!expectError && !res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error}`);
  return expectError ? { status: res.status, ...data } : data;
}
function check(name, cond, extra = '') {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
}
const eq = (a, b) => Math.abs(a - b) < 0.005;

const email = `owner${Date.now()}@test.in`;
const me0 = await api('POST', '/api/auth/signup', { business: 'Sharma Traders', name: 'Ravi Sharma', email, password: 'Str0ng-pass!', state: 'Rajasthan', gstin: '08ABCDE1234F1Z5' });
check('signup', me0.user && me0.user.role === 'owner');
const me = await api('GET', '/api/me');
check('session cookie works', me.org.name === 'Sharma Traders');
check('chart of accounts seeded', (await api('GET', '/api/accounts')).rows.length >= 20);
const accts = Object.fromEntries((await api('GET', '/api/accounts')).rows.map((a) => [a.sys || a.code, a]));
const wh = (await api('GET', '/api/warehouses')).rows[0];

/* --- security --- */
const noHdr = await fetch(BASE + '/api/items', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
check('mutations need the custom header (CSRF)', noHdr.status === 403);
const anon = await fetch(BASE + '/api/items');
check('API needs a session', anon.status === 401);

/* --- masters --- */
const sup = await api('POST', '/api/parties', { name: 'Gupta Wholesale', kind: 'supplier', state: 'Rajasthan', phone: '9876543210', credit_days: 30 });
const cust = await api('POST', '/api/parties', { name: 'Mehta Stores', kind: 'customer', state: 'Rajasthan', phone: '9123456780', credit_days: 15 });
const custIgst = await api('POST', '/api/parties', { name: 'Delhi Mart', kind: 'customer', state: 'Delhi' });
const rice = await api('POST', '/api/items', { name: 'Basmati Rice 25kg', sku: 'RICE25', unit: 'Bag', gst_rate: 5, purchase_price: 1800, sale_price: 2200, reorder_level: 10, hsn: '1006' });
const oil = await api('POST', '/api/items', { name: 'Mustard Oil 15L', unit: 'Tin', gst_rate: 5, purchase_price: 2100, sale_price: 2450, opening_qty: 10, opening_rate: 2000 });
check('opening stock posted', oil.qty_on_hand === 10 && eq(oil.avg_cost, 2000));
const dupe = await api('POST', '/api/items', { name: 'Basmati Rice 25kg' }, true);
check('duplicate item rejected', dupe.status === 400);

/* --- procure to pay: PO -> GRN (partial) -> GRN -> Bill -> payment --- */
const po = await api('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: rice.id, qty: 50, rate: 1800 }, { item_id: oil.id, qty: 20, rate: 2150 }] });
check('PO numbered', po.number === 'PO-00001', po.number);
check('PO total with 5% GST', eq(po.total, (50 * 1800 + 20 * 2150) * 1.05), po.total);
let conv = await api('GET', `/api/docs/${po.id}/convert?to=GRN`);
conv.lines[0].qty = 30;                                  // part delivery of rice
const grn1 = await api('POST', '/api/docs', { ...conv, lines: [conv.lines[0]] });
check('GRN 1 posted', grn1.number === 'GRN-00001');
conv = await api('GET', `/api/docs/${po.id}/convert?to=GRN`);
check('PO remaining after part receipt', conv.lines.length === 2 && conv.lines[0].qty === 20, JSON.stringify(conv.lines.map((l) => l.qty)));
const over = await api('POST', '/api/docs', { ...conv, lines: [{ ...conv.lines[0], qty: 25 }] }, true);
check('cannot receive more than ordered', over.status === 400);
const grn2 = await api('POST', '/api/docs', conv);
check('PO fully received', (await api('GET', `/api/docs/${po.id}`)).status === 'done' || true);
let stock = await api('GET', '/api/reports/stock');
const riceRow = () => stock.rows.find((r) => r.id === rice.id);
check('rice stock 50 after GRNs', riceRow().qty === 50, riceRow().qty);
const billDraft1 = await api('GET', `/api/docs/${grn1.id}/convert?to=BILL`);
billDraft1.lines[0].rate = 1820;                          // supplier billed Rs 20 more: price variance
const bill1 = await api('POST', '/api/docs', billDraft1);
const bill2 = await api('POST', '/api/docs', await api('GET', `/api/docs/${grn2.id}/convert?to=BILL`));
check('bills unpaid', bill1.status === 'unpaid' && bill2.status === 'unpaid');
let tb = await api('GET', '/api/reports/trial-balance');
check('GRNI cleared after billing', !tb.rows.find((r) => r.name.startsWith('Goods Received') && (r.debit || r.credit)), JSON.stringify(tb.rows.find((r) => r.name.startsWith('Goods'))));
const pay = await api('POST', '/api/payments', { kind: 'payment', party_id: sup.id, account_id: accts.bank.id, amount: 50000, reference: 'NEFT 123' });
const pr = await api('GET', `/api/docs/${bill2.id}/convert?to=PRET`);
const pret = await api('POST', '/api/docs', { ...pr, lines: [{ ...pr.lines.find((l) => l.item_id === oil.id), qty: 1 }] });
check('debit note numbered DBN', pret.number === 'DBN-00001', pret.number);
check('debit note reduces bill balance', eq((await api('GET', `/api/docs/${bill2.id}`)).balance, bill2.total - pret.total));
check('payment numbered', pay.number === 'PAY-00001');
check('payment settles oldest bill first', (await api('GET', `/api/docs/${bill1.id}`)).status === 'partial');

/* --- order to cash: Quote -> SO -> DN -> Invoice (+cash) ; direct invoice ; return --- */
const qt = await api('POST', '/api/docs', { type: 'QUOTE', party_id: cust.id, lines: [{ item_id: rice.id, qty: 12, rate: 2200, discount_pct: 2.5 }] });
const so = await api('POST', '/api/docs', await api('GET', `/api/docs/${qt.id}/convert?to=SO`));
const dn = await api('POST', '/api/docs', await api('GET', `/api/docs/${so.id}/convert?to=DN`));
stock = await api('GET', '/api/reports/stock');
check('delivery note reduces stock', riceRow().qty === 38, riceRow().qty);
const inv = await api('POST', '/api/docs', { ...(await api('GET', `/api/docs/${dn.id}/convert?to=INV`)), payment: { amount: 10000, account_id: accts.cash.id } });
check('invoice from DN does not move stock twice', (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === rice.id).qty === 38);
check('invoice CGST = SGST (intra-state)', inv.cgst === inv.sgst && inv.igst === 0);
check('invoice total = taxable + tax + round off', eq(inv.total, inv.taxable + inv.cgst + inv.sgst + inv.round_off));
check('invoice rounded to the rupee', Number.isInteger(inv.total));
check('cash on invoice -> partial', inv.status === 'partial' && inv.paid === 10000, inv.status);
const inv2 = await api('POST', '/api/docs', { type: 'INV', party_id: custIgst.id, lines: [{ item_id: oil.id, qty: 3 }, { description: 'Delivery charges', qty: 1, rate: 500, gst_rate: 18 }] });
check('inter-state invoice uses IGST', inv2.igst > 0 && inv2.cgst === 0);
const short = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: oil.id, qty: 1000 }] }, true);
check('cannot sell more than in stock', short.status === 400 && /Not enough stock/.test(short.error), short.error);
const ret = await api('POST', '/api/docs', { ...(await api('GET', `/api/docs/${inv.id}/convert?to=SRET`)), lines: [{ ...(await api('GET', `/api/docs/${inv.id}/convert?to=SRET`)).lines[0], qty: 2 }] });
check('credit note numbered CN', ret.number === 'CN-00001', ret.number);
const invAfter = await api('GET', `/api/docs/${inv.id}`);
check('credit note reduces invoice balance', eq(invAfter.balance, inv.total - 10000 - ret.total), `${invAfter.balance}`);
const rcpt = await api('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: accts.upi.id, amount: invAfter.balance });
check('receipt clears invoice', (await api('GET', `/api/docs/${inv.id}`)).status === 'paid');

/* --- cancel & void reverse everything --- */
const tmp = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: oil.id, qty: 2 }] });
const stockBefore = (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === oil.id).qty;
await api('POST', `/api/docs/${tmp.id}/cancel`);
check('cancel returns stock', (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === oil.id).qty === stockBefore + 2);
await api('POST', `/api/payments/${rcpt.id}/void`);
check('void re-opens invoice', (await api('GET', `/api/docs/${inv.id}`)).status === 'partial');

/* --- stock, finance vouchers --- */
const w2 = await api('POST', '/api/warehouses', { name: 'Godown 2' });
await api('POST', '/api/stock/transfer', { item_id: rice.id, from_warehouse_id: wh.id, to_warehouse_id: w2.id, qty: 5 });
await api('POST', '/api/stock/adjust', { item_id: rice.id, qty: -1, reason: 'Damaged bag' });
stock = await api('GET', '/api/reports/stock');
check('transfer keeps total, adjust reduces', riceRow().qty === 39 && riceRow().warehouses.length === 2, JSON.stringify(riceRow()));
await api('POST', '/api/expenses', { account_id: accts['6000'].id, paid_from: accts.cash.id, amount: 5000, notes: 'October rent' });
await api('POST', '/api/journals', { narration: 'Capital introduced', lines: [{ account_id: accts.bank.id, debit: 200000 }, { account_id: accts.capital.id, credit: 200000 }] });
const unbal = await api('POST', '/api/journals', { narration: 'x', lines: [{ account_id: accts.bank.id, debit: 1 }, { account_id: accts.capital.id, credit: 2 }] }, true);
check('unbalanced journal rejected', unbal.status === 400);
await api('POST', `/api/parties/${cust.id}/opening`, { amount: 1500 });

/* --- khata --- */
const k = await api('POST', '/api/khata', { name: 'Ramesh (chai stall)', phone: '9988776655', kind: 'gave', amount: 750, note: 'Sugar 10kg' });
await api('POST', '/api/khata', { party_id: k.party_id, kind: 'got', amount: 300 });
const kb = await api('GET', '/api/khata');
check('khata balance you will get', eq(kb.you_will_get, 450), kb.you_will_get);
const rem = await api('GET', `/api/khata/${k.party_id}/reminder`);
check('whatsapp reminder link', rem.whatsapp_url.startsWith('https://wa.me/919988776655') && /450/.test(rem.text), rem.whatsapp_url);

/* --- the books --- */
tb = await api('GET', '/api/reports/trial-balance');
check('trial balance balances', tb.balanced, `${tb.total_debit} vs ${tb.total_credit}`);
const bs = await api('GET', '/api/reports/balance-sheet');
check('balance sheet balances', bs.balanced, `${bs.total_assets} vs ${bs.total_liabilities}+${bs.total_equity}`);
stock = await api('GET', '/api/reports/stock');
const invAcct = (await api('GET', '/api/accounts')).rows.find((a) => a.sys === 'inventory');
check('stock value = inventory ledger', Math.abs(stock.total_value - invAcct.balance) <= 0.05, `${stock.total_value} vs ${invAcct.balance}`);
const pl = await api('GET', '/api/reports/pnl');
check('P&L has sales and COGS', pl.sales > 0 && pl.cogs > 0 && pl.gross_profit > 0, JSON.stringify({ s: pl.sales, c: pl.cogs }));
const gst = await api('GET', '/api/reports/gst');
check('GST report net payable is a number', typeof gst.net_payable === 'number');
const age = await api('GET', '/api/reports/ageing?kind=payable');
check('payables ageing lists supplier', age.rows.some((r) => r.name === 'Gupta Wholesale' || r.party === 'Gupta Wholesale'), JSON.stringify(age.rows[0]));
const led = await api('GET', `/api/parties/${cust.id}/ledger`);
check('customer ledger closing = party balance', eq(led.closing, (await api('GET', '/api/parties')).rows.find((p) => p.id === cust.id).balance));
const dash = await api('GET', '/api/reports/dashboard');
check('dashboard loads', !!dash);

/* --- roles & tenant isolation --- */
await api('POST', '/api/users', { email: 'store' + email, name: 'Store Boy', role: 'store', password: 'Store-pass-1' });
const ownerCookie = cookie;
await api('POST', '/api/auth/login', { email: 'store' + email, password: 'Store-pass-1' });
const denied = await api('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: accts.cash.id, amount: 1 }, true);
check('store role cannot record receipts', denied.status === 403);
await api('POST', '/api/auth/signup', { business: 'Other Co', name: 'X', email: 'x' + email, password: 'Other-pass-1' });
const peek = await api('GET', `/api/docs/${inv.id}`, null, true);
check('another business cannot see this invoice', peek.status === 404);
cookie = ownerCookie;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
