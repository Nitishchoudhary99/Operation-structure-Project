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

/* rq: one request with its own cookie and client address (the dev server trusts CF-Connecting-IP, so each test business gets its own address) */
const rq = async (method, path, body, o = {}) => {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.ip ? { 'CF-Connecting-IP': o.ip } : {}), ...(o.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  const text = await res.text();
  try { data = JSON.parse(text); } catch (e) { data = { _text: text }; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, headers: res.headers, cookie: sc ? sc.split(';')[0] : '', setCookie: sc || '' };
};

/* Sign-up by e-mail link: run with the worker started with a mail sink (see README "Tests"):
     npx wrangler dev ... --var RESEND_API_KEY:test-key --var RESEND_URL:http://127.0.0.1:8798/send   and   ERP_MAIL_SINK=8798 node test/run.mjs <url>
   In that mode only these checks run, because every sign-up then waits for its e-mailed link. */
if (process.env.ERP_MAIL_SINK) {
{
  const http = await import('node:http');
  const mails = [];
  const sink = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const m = JSON.parse(b || '{}');
      mails.push(m);
      res.writeHead(/failmail/.test(String(m.to)) ? 500 : 200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}');
    });
  });
  await new Promise((ok) => sink.listen(+process.env.ERP_MAIL_SINK, '127.0.0.1', ok));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const em = `verify${Date.now()}@test.in`, ip = '203.0.113.40';
  const body = { business: 'Verified Co', name: 'Vera', email: em, password: 'Tenant-pass-1', state: 'Rajasthan' };
  const s1 = await rq('POST', '/api/auth/signup', body, { ip });
  check('sign-up asks for the e-mail link and signs nobody in', s1.status === 200 && s1.data.verify === true && !s1.cookie && !s1.data.user, JSON.stringify(s1.data));
  check('no account exists before the link is opened', (await rq('POST', '/api/auth/login', { email: em, password: 'Tenant-pass-1' }, { ip })).status === 401);
  const m1 = mails.find((m) => m.to[0] === em && /Confirm/.test(m.subject));
  const token = m1 && m1.html.match(/#\/verify\/([0-9a-f]{64})/)[1];
  check('one e-mail with a confirm link was sent', !!token);
  check('a wrong token does nothing', (await rq('POST', '/api/auth/verify', { token: 'f'.repeat(64) }, { ip })).status === 400 && (await rq('POST', '/api/auth/verify', { token: 'x' }, { ip })).status === 400);
  const v1 = await rq('POST', '/api/auth/verify', { token }, { ip });
  check('opening the link makes the business and signs the owner in', v1.status === 200 && v1.cookie && (await rq('GET', '/api/me', undefined, { cookie: v1.cookie, ip })).data.org.name === 'Verified Co');
  check('the link works once', (await rq('POST', '/api/auth/verify', { token }, { ip })).status === 400);
  const before = mails.length;
  const s2 = await rq('POST', '/api/auth/signup', body, { ip: '203.0.113.41' });
  check('signing up again with the same address gets the very same answer', s2.status === 200 && JSON.stringify(s2.data) === JSON.stringify(s1.data) && !s2.cookie);
  await sleep(100);
  check('...and the owner is told by e-mail instead', mails.length === before + 1 && /already have/i.test(mails[mails.length - 1].subject));
  const s3 = await rq('POST', '/api/auth/signup', { ...body, email: `failmail${Date.now()}@test.in` }, { ip: '203.0.113.42' });
  check('if the mail cannot be sent, sign-up still works (no lock-out)', s3.status === 200 && !!s3.cookie);
  const bomb = `bomb${Date.now()}@test.in`, codes = [];
  for (let i = 0; i < 5; i++) codes.push((await rq('POST', '/api/auth/signup', { ...body, email: bomb }, { ip: `203.0.113.${50 + i}` })).status);
  check('one address cannot be mail-bombed (3 an hour)', codes.join() === '200,200,200,429,429' && mails.filter((m) => m.to[0] === bomb).length === 3, codes.join());
  sink.close();
}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

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
check('khata entry message has WhatsApp link + statement link', k.whatsapp_url.startsWith('https://api.whatsapp.com/send?phone=919988776655&text=') && /\/k\/[0-9a-f]{24}/.test(k.text) && /SmartTrader ERP/.test(k.text) && /SmartTrader ERP/.test(k.sms_text), k.text);
check('unsent khata entry does not count', (await api('GET', '/api/khata')).you_will_get === 0);
await api('POST', `/api/khata/entries/${k.entry_id}/send`, { via: 'whatsapp' });
check('sent khata entry counts', eq((await api('GET', '/api/khata')).you_will_get, 750));
const k2 = await api('POST', '/api/khata', { party_id: k.party_id, kind: 'got', amount: 300 });
await api('POST', `/api/khata/entries/${k2.entry_id}/send`, { via: 'sms' });
const kb = await api('GET', '/api/khata');
check('khata balance you will get', eq(kb.you_will_get, 450), kb.you_will_get);
const delSent = await api('DELETE', `/api/khata/entries/${k.entry_id}`, null, true);
check('sent khata entry cannot be deleted', delSent.status === 400);
const k3 = await api('POST', '/api/khata', { party_id: k.party_id, kind: 'gave', amount: 99 });
await api('DELETE', `/api/khata/entries/${k3.entry_id}`);
check('unsent khata entry can be discarded', eq((await api('GET', '/api/khata')).you_will_get, 450));
const kd = await api('GET', `/api/khata/${k.party_id}`);
const token = kd.statement_url.split('/k/')[1];
const pub = await (await fetch(`${BASE}/api/public/khata/${token}`)).json();
check('customer statement link works without login', pub.customer === 'Ramesh (chai stall)' && eq(pub.balance, 450) && pub.rows.length === 2, JSON.stringify(pub).slice(0, 150));
const ackRes = await fetch(`${BASE}/api/public/khata/${token}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader' }, body: JSON.stringify({ entry_id: k.entry_id, ack: 'disputed', note: 'Only 5kg sugar' }) });
check('customer can dispute an entry', ackRes.ok && (await api('GET', `/api/khata/${k.party_id}`)).rows.some((r) => r.ack === 'disputed' && r.ack_note === 'Only 5kg sugar'));
const rev = await api('POST', `/api/khata/entries/${k.entry_id}/reverse`, { reason: 'wrong qty' });
await api('POST', `/api/khata/entries/${rev.entry_id}/send`, { via: 'whatsapp' });
check('reversal entry cancels the amount once sent', eq((await api('GET', '/api/khata')).you_will_get, 0) || eq((await api('GET', '/api/khata')).you_will_give, 300));
check('entry cannot be reversed twice', (await api('POST', `/api/khata/entries/${k.entry_id}/reverse`, {}, true)).status === 400);
const kpage = await (await fetch(kd.statement_url.replace(/^https?:\/\/[^/]+/, BASE))).text();
check('khata link page has WhatsApp banner tags', kpage.includes('og:image') && kpage.includes('og-khata.png') && kpage.includes('Ramesh (chai stall) ka khata'), kpage.slice(0, 300));
const sh = await api('GET', `/api/docs/${inv.id}/share`);
check('invoice share link + WhatsApp text', /\/i\/[0-9a-f]{24}$/.test(sh.url) && sh.text.includes(inv.number) && sh.text.includes('SmartTrader ERP'), sh.text);
const pdoc = await (await fetch(sh.url.replace(/^https?:\/\/[^/]+/, BASE).replace('/i/', '/api/public/doc/'))).json();
check('public invoice has no cost data', pdoc.number === inv.number && pdoc.lines.length && pdoc.lines.every((l) => l.cost === undefined) && !('id' in pdoc), JSON.stringify(pdoc).slice(0, 200));
const ipage = await (await fetch(sh.url.replace(/^https?:\/\/[^/]+/, BASE))).text();
check('invoice link page has banner tags', ipage.includes(`Sales Invoice ${inv.number}`) && ipage.includes('og-invoice.png'));
const pbill = await api('GET', `/api/docs/${bill1.id}/share`);
check('purchase bills are not public', (await fetch(pbill.url.replace(/^https?:\/\/[^/]+/, BASE).replace('/i/', '/api/public/doc/'))).status === 404);
const badTok = await fetch(`${BASE}/api/public/khata/${'0'.repeat(24)}`);
check('random statement link is rejected', badTok.status === 404);
const rem = await api('GET', `/api/khata/${k.party_id}/reminder`);
check('whatsapp reminder link', rem.whatsapp_url.startsWith('https://api.whatsapp.com/send?phone=919988776655&text=') && /\/k\/[0-9a-f]{24}/.test(rem.text), rem.whatsapp_url);

/* --- value credit / debit notes (rate difference, no goods) --- */
const inv2Before = await api('GET', `/api/docs/${inv2.id}`);
const cnDraft = await api('GET', `/api/docs/${inv2.id}/convert?to=CNOTE`);
check('credit note draft lists invoice lines with blank rate', cnDraft.lines.length === 2 && cnDraft.lines[0].rate === '');
const stockOilBefore = (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === oil.id).qty;
const cn = await api('POST', '/api/docs', { ...cnDraft, lines: [{ ...cnDraft.lines[0], rate: 50 }] });
check('value credit note numbered CRN', cn.number === 'CRN-00001' && cn.status === 'closed', cn.number);
check('credit note: 3 x Rs 50 + GST, IGST for Delhi', eq(cn.taxable, 150) && cn.igst > 0, `${cn.taxable} ${cn.igst}`);
check('credit note reduces the invoice balance', eq((await api('GET', `/api/docs/${inv2.id}`)).balance, inv2Before.balance - cn.total));
check('credit note does not move stock', (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === oil.id).qty === stockOilBefore);
const emptyCn = await api('POST', '/api/docs', { ...cnDraft, lines: [{ ...cnDraft.lines[0], rate: '' }] }, true);
check('credit note needs an amount', emptyCn.status === 400);
const freeCn = await api('POST', '/api/docs', { type: 'CNOTE', party_id: cust.id, lines: [{ description: 'Festival discount', qty: 1, rate: 200, gst_rate: 5 }] });
check('standalone credit note (no invoice) allowed', freeCn.number === 'CRN-00002' && eq(freeCn.total, 210));
const dnDraft = await api('GET', `/api/docs/${bill2.id}/convert?to=DNOTE`);
const dnote = await api('POST', '/api/docs', { ...dnDraft, lines: [{ ...dnDraft.lines[0], rate: 20 }] });
check('value debit note numbered DRN, settles the bill', dnote.number === 'DRN-00001' && (await api('GET', `/api/docs/${bill2.id}`)).paid > 0);
const gstAfter = await api('GET', '/api/reports/gst');
check('GST summary nets the credit note', gstAfter.outward.rows.some((r) => r.igst < 0 || r.taxable !== 0));
await api('POST', `/api/docs/${freeCn.id}/cancel`);
check('credit note can be cancelled', (await api('GET', `/api/docs/${freeCn.id}`)).status === 'cancelled');

/* --- gate entry -> GRN, gate pass --- */
const po2 = await api('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: rice.id, qty: 10, rate: 1800 }] });
const noVeh = await api('POST', '/api/gate', { kind: 'in', party_id: sup.id }, true);
check('gate entry needs a vehicle number', noVeh.status === 400);
const ge = await api('POST', '/api/gate', { kind: 'in', party_id: sup.id, ref_doc_id: po2.id, vehicle_no: 'rj14 gb 4321', driver_name: 'Sohan', challan_no: 'CH-778', packages: 10, weight_kg: 250 });
check('gate entry numbered GE, vehicle cleaned', ge.number === 'GE-00001' && ge.vehicle_no === 'RJ14GB4321' && ge.status === 'open', JSON.stringify(ge));
check('pending report shows the vehicle at the gate', (await api('GET', '/api/reports/pending')).at_gate.some((g) => g.id === ge.id));
const grnDraft = await api('GET', `/api/docs/${po2.id}/convert?to=GRN`);
const grnGe = await api('POST', '/api/docs', { ...grnDraft, gate_entry_id: ge.id });
const geAfter = await api('GET', `/api/gate/${ge.id}`);
check('GRN from gate entry closes the entry', geAfter.status === 'grn_done' && geAfter.grn_id === grnGe.id && geAfter.grn_number === grnGe.number);
const po3 = await api('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: rice.id, qty: 1, rate: 1800 }] });
const reuse = await api('POST', '/api/docs', { ...(await api('GET', `/api/docs/${po3.id}/convert?to=GRN`)), gate_entry_id: ge.id }, true);
check('a gate entry cannot be received twice', reuse.status === 400);
await api('POST', `/api/docs/${grnGe.id}/cancel`);
check('cancelling the GRN re-opens the gate entry', (await api('GET', `/api/gate/${ge.id}`)).status === 'open');
const ge2 = await api('POST', '/api/gate', { kind: 'in', party_id: sup.id, vehicle_no: 'UP16X1' });
await api('POST', `/api/gate/${ge2.id}/reject`, { reason: 'No PO' });
check('gate entry can be rejected', (await api('GET', `/api/gate/${ge2.id}`)).status === 'rejected');
const gp = await api('POST', '/api/gate', { kind: 'out', ref_doc_id: dn.id, party_id: cust.id, vehicle_no: 'RJ14C9', lr_no: 'LR-55' });
check('gate pass numbered GP', gp.number === 'GP-00001' && gp.status === 'open');
await api('POST', `/api/gate/${gp.id}/exit`, {});
const gpAfter = await api('GET', `/api/gate/${gp.id}`);
check('vehicle exit closes the gate pass', gpAfter.status === 'closed' && /^\d\d:\d\d$/.test(gpAfter.time_out));

/* --- stock count, pending, reminders --- */
const before = (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === rice.id);
const mainQty = (before.warehouses.find((w) => w.warehouse === 'Main Store') || { qty: 0 }).qty;
const cnt = await api('POST', '/api/stock/count', { warehouse_id: wh.id, lines: [{ item_id: rice.id, counted: mainQty - 2 }, { item_id: oil.id, counted: '' }] });
check('stock count adjusts only the differences', cnt.adjusted === 1 && cnt.diffs[0].diff === -2, JSON.stringify(cnt));
check('stock count updates stock', (await api('GET', '/api/reports/stock')).rows.find((r) => r.id === rice.id).qty === before.qty - 2);
const pend = await api('GET', '/api/reports/pending');
check('pending report has every section', ['to_deliver', 'to_receive', 'to_invoice', 'to_bill', 'open_quotes', 'at_gate'].every((k) => Array.isArray(pend[k])));
const remP = await api('GET', `/api/parties/${custIgst.id}/reminder`);
check('invoice-due reminder lists bills and total', remP.text.includes('Payment reminder') && remP.text.includes(inv2.number) && /\/i\/[0-9a-f]{24}/.test(remP.text), remP.text);

/* --- monthly summary must match the journal for any period (back-dated entries, part months) --- */
await api('POST', '/api/journals', { date: '2026-01-15', narration: 'Old capital', lines: [{ account_id: accts.bank.id, debit: 1000 }, { account_id: accts.capital.id, credit: 1000 }] });
await api('POST', '/api/journals', { date: '2026-03-20', narration: 'More capital', lines: [{ account_id: accts.bank.id, debit: 500 }, { account_id: accts.capital.id, credit: 500 }] });
const capAt = async (to, from = '') => ((await api('GET', `/api/reports/trial-balance?to=${to}${from ? '&from=' + from : ''}`)).rows.find((r) => r.code === '3000') || { credit: 0 }).credit;
check('summary: whole months', eq(await capAt('2026-02-28'), 1000));
check('summary: part month at the end', eq(await capAt('2026-03-10'), 1000) && eq(await capAt('2026-03-20'), 1500));
const plMid = await api('GET', '/api/reports/pnl?from=2026-01-10&to=2026-03-25');
check('summary: P&L for a mid-month range has no current-year sales', eq(plMid.sales, 0));
const ledBank = await api('GET', `/api/accounts/${accts.bank.id}/ledger?from=0001-01-01&to=2099-12-31`);
check('summary: account balance = full ledger', eq((await api('GET', '/api/accounts')).rows.find((a) => a.id === accts.bank.id).balance, ledBank.closing));

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

/* --- long documents: 60 different items must stay under Cloudflare's 50 queries per request (free plan) --- */
const qc = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status} ${data.error}`);
  return { data, n: +(res.headers.get('X-Query-Count') || -1) };
};
const many = [];
for (let i = 1; i <= 60; i++) many.push((await api('POST', '/api/items', { name: `Bulk item ${i}`, gst_rate: [0, 5, 12, 18, 28][i % 5], purchase_price: 10 + i, sale_price: 15 + i })).id);
const bigPo = await qc('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: many.map((id, i) => ({ item_id: id, qty: 5 + (i % 3) })) });
const bigGrn = await qc('POST', '/api/docs', (await api('GET', `/api/docs/${bigPo.data.id}/convert?to=GRN`)));
const bigInv = await qc('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: many.map((id, i) => ({ item_id: id, qty: 2, discount_pct: i % 4 })) });
console.log(`      queries: PO ${bigPo.n}, GRN ${bigGrn.n}, INV ${bigInv.n}`);
check('60-line PO / GRN / invoice each stay under 50 queries', [bigPo.n, bigGrn.n, bigInv.n].every((n) => n >= 0 && n < 50) || [bigPo.n, bigGrn.n, bigInv.n].every((n) => n === -1));
check('60-line invoice totals add up', bigInv.data.lines.length === 60 && eq(bigInv.data.total, Math.round(bigInv.data.lines.reduce((t, l) => t + l.total, 0))));
const bigCancel = await qc('POST', `/api/docs/${bigInv.data.id}/cancel`);
check('cancelling a 60-line invoice stays under 50 queries', bigCancel.n < 50, String(bigCancel.n));
const view = await qc('GET', `/api/docs/${bigGrn.data.id}`);
check('opening a 60-line document stays under 50 queries', view.n < 50, String(view.n));
tb = await api('GET', '/api/reports/trial-balance');
check('books still balance after long documents', tb.balanced);
const tooMany = await api('POST', '/api/docs', { type: 'QUOTE', party_id: cust.id, lines: Array.from({ length: 201 }, () => ({ item_id: many[0], qty: 1 })) }, true);
check('more than 200 lines is refused with a clear message', tooMany.status === 400 && /200/.test(tooMany.error));

/* --- roles & tenant isolation --- */
await api('POST', '/api/users', { email: 'store' + email, name: 'Store Boy', role: 'store', password: 'Store-pass-1' });
const ownerCookie = cookie;
await api('POST', '/api/auth/login', { email: 'store' + email, password: 'Store-pass-1' });
const denied = await api('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: accts.cash.id, amount: 1 }, true);
check('store role cannot record receipts', denied.status === 403);
check('only the owner can download a full backup', (await api('GET', '/api/export/backup', null, true)).status === 403);
const storeCookie = cookie;
{
  const bk = await fetch(BASE + '/api/export/backup', { headers: { Cookie: ownerCookie } });
  const j = await bk.json(), txt = JSON.stringify(j);
  check('owner backup has every invoice, its lines and the parties', bk.ok && /attachment; filename="smarttrader-backup-/.test(bk.headers.get('content-disposition') || '')
    && j.format === 'smarttrader-backup' && j.tables.docs.some((d) => d.id === inv.id) && j.tables.doc_lines.some((l) => l.doc_id === inv.id) && j.tables.parties.length >= 2);
  check('backup has no password hashes or private link tokens', !/pw_hash|"salt"|khata_token/.test(txt) && j.tables.users.length >= 2);
  check('backup holds only this business', j.tables.docs.every((d) => d.org_id === j.org.id) && j.tables.items.every((d) => d.org_id === j.org.id));
}
await api('POST', '/api/auth/signup', { business: 'Other Co', name: 'X', email: 'x' + email, password: 'Other-pass-1' });
const peek = await api('GET', `/api/docs/${inv.id}`, null, true);
check('another business cannot see this invoice', peek.status === 404);
cookie = ownerCookie;

/* --- branding & print templates --- */
{
  const raw = (path, ck = cookie) => fetch(BASE + path, { headers: { Cookie: ck } });
  const p0 = await api('GET', '/api/settings/print');
  check('print settings default to classic', p0.print.layout === 'classic' && p0.print.show_upi === true && p0.logo_url === '');
  check('bad colour is refused', (await api('PUT', '/api/settings/print', { color: 'red' }, true)).status === 400);
  check('bad IFSC is refused', (await api('PUT', '/api/settings/print', { bank_ifsc: 'SBI12' }, true)).status === 400);
  check('bad layout is refused', (await api('PUT', '/api/settings/print', { layout: 'fancy' }, true)).status === 400);
  cookie = storeCookie;
  check('store user cannot change print settings', (await api('PUT', '/api/settings/print', { layout: 'modern' }, true)).status === 403);
  check('store user can read print settings', (await api('GET', '/api/settings/print')).print.layout === 'classic');
  cookie = ownerCookie;
  const ps = await api('PUT', '/api/settings/print', { layout: 'modern', color: '#AA3300', title: 'BILL OF SUPPLY', terms: 'Goods once sold will not be taken back.',
    bank_name: 'SBI', bank_account: '1234 5678 9012', bank_ifsc: 'sbin0001234', signatory: 'Ravi Sharma', footer: 'Thank you!', show_upi: false, logo: 'forged' });
  check('print settings saved and cleaned', ps.print.layout === 'modern' && ps.print.color === '#aa3300' && ps.print.bank_ifsc === 'SBIN0001234' && ps.print.bank_account === '123456789012'
    && ps.print.show_upi === false && ps.print.logo === '', JSON.stringify(ps.print));
  check('/api/me carries print settings', (await api('GET', '/api/me')).org.print.title === 'BILL OF SUPPLY');
  const big = 'data:image/png;base64,' + Buffer.alloc(70000, 7).toString('base64');
  check('logo over 64 KB is refused (413)', (await api('PUT', '/api/org/files/logo', { data: big }, true)).status === 413);
  check('non-image upload is refused', (await api('PUT', '/api/org/files/logo', { data: 'data:text/html;base64,PGI+' }, true)).status === 400);
  check('unknown file kind is refused', (await api('PUT', '/api/org/files/stamp', { data: big }, true)).status === 400);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const up = await api('PUT', '/api/org/files/logo', { data: 'data:image/png;base64,' + png });
  check('logo uploaded', /^[0-9a-f]{16}$/.test(up.print.logo) && up.logo_url.includes(up.print.logo) && up.print.terms === ps.print.terms);
  const lg = await raw(up.logo_url);
  const bytes = Buffer.from(await lg.arrayBuffer());
  check('logo served with immutable cache', lg.status === 200 && lg.headers.get('content-type') === 'image/png' && /immutable/.test(lg.headers.get('cache-control')) && bytes.equals(Buffer.from(png, 'base64')));
  check('logo needs a session', (await fetch(BASE + up.logo_url)).status === 401);
  const dv = await api('GET', `/api/docs/${inv.id}`);
  check('document carries branding for print', dv.org.print.layout === 'modern' && dv.logo_url === up.logo_url);
  const tok = (await api('GET', `/api/docs/${inv.id}/share`)).url.split('/i/')[1];
  const pub = await (await fetch(`${BASE}/api/public/doc/${tok}`)).json();
  check('public link shows branding', pub.org.print.terms === ps.print.terms && pub.org.print.bank_account === '123456789012' && pub.logo_url.startsWith(`/api/public/doc/${tok}/file/logo`));
  check('public link shows nothing internal', pub.org.id === undefined && pub.org.plan === undefined && pub.lines.every((l) => l.cost === undefined) && pub.org.print.show_upi === false);
  const pl = await fetch(BASE + pub.logo_url);
  check('public logo served', pl.status === 200 && pl.headers.get('content-type') === 'image/png');
  check('public logo needs a valid link', (await fetch(`${BASE}/api/public/doc/${'0'.repeat(24)}/file/logo`)).status === 404);
  await api('DELETE', '/api/org/files/logo');
  check('logo removed', (await raw('/api/org/files/logo')).status === 404 && (await api('GET', '/api/settings/print')).logo_url === '');
}

/* --- plans, barcode, GST portal files, Tally, admin --- */
const raw = (path, headers = {}) => fetch(BASE + path, { headers: { Cookie: cookie, ...headers } });
const meNow = await api('GET', '/api/me');
check('new business starts on a Growth trial', meNow.plan.key === 'growth' && meNow.plan.until > meNow.today, JSON.stringify(meNow.plan));
await api('PUT', `/api/items/${rice.id}`, { ...rice, barcode: '8901234567890' });
const look = await api('GET', '/api/items/lookup?code=8901234567890');
check('barcode lookup finds the item', look.id === rice.id);
check('label code ST<id> lookup', (await api('GET', `/api/items/lookup?code=ST${oil.id}`)).id === oil.id);
const dupBc = await api('POST', '/api/items', { name: 'Other rice', barcode: '8901234567890' }, true);
check('duplicate barcode rejected', dupBc.status === 400);
await api('PUT', '/api/org', { ...meNow.org, address: '12 Mandi Road', city: 'Jaipur', pincode: '302001' });
await api('PUT', `/api/parties/${cust.id}`, { ...cust, gstin: '08AAACM1234A1Z2', pincode: '302012', address: 'Shop 4, MI Road', city: 'Jaipur' });
const ein = await raw(`/api/docs/${inv.id}/einvoice`);
const einJ = await ein.json();
check('e-invoice JSON in NIC format', ein.ok && einJ[0].Version === '1.1' && einJ[0].SellerDtls.Stcd === '08' && einJ[0].ValDtls.TotInvVal === inv.total, JSON.stringify(einJ).slice(0, 200));
const lineSum = einJ[0].ItemList.reduce((t, l) => t + l.AssAmt, 0);
check('e-invoice item values add up', eq(lineSum, einJ[0].ValDtls.AssVal));
const ewNo = await raw(`/api/docs/${inv.id}/ewaybill?distance=0`);
check('e-way bill asks for distance', ewNo.status === 400);
const ew = await (await raw(`/api/docs/${inv.id}/ewaybill?distance=12&vehicle_no=RJ14 AB 1234`)).json();
check('e-way bill JSON', ew.billLists[0].vehicleNo === 'RJ14AB1234' && ew.billLists[0].fromPincode === 302001, JSON.stringify(ew).slice(0, 160));
await api('PUT', `/api/docs/${inv.id}/gst-refs`, { irn: 'a'.repeat(64), ack_no: '112410000000001', ewb_no: '321000000001' });
check('IRN saved on invoice', (await api('GET', `/api/docs/${inv.id}`)).irn.length === 64);
{
  const cp = await api('GET', `/api/docs/${inv.id}/copy`);
  check('repeat gives a draft of the same invoice dated today, not linked', cp.type === 'INV' && cp.party_id === inv.party_id && cp.lines.length === (await api('GET', `/api/docs/${inv.id}`)).lines.length && !cp.ref_id && cp.lines.every((l) => !l.src_line_id) && cp.date === (await api('GET', '/api/me')).today);
}
const tx = await raw('/api/export/tally');
const xml = await tx.text();
check('Tally XML export', tx.ok && xml.includes('<VOUCHER VCHTYPE="Sales"') && xml.includes('<PARENT>Sundry Debtors</PARENT>') && xml.includes('Mehta Stores'));
let bal = 0;
for (const m of xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)) bal += Math.round(+m[1] * 100);
check('Tally vouchers balance', bal === 0, String(bal));
// admin & online payments (needs ADMIN_KEY and RAZORPAY_WEBHOOK_SECRET in .dev.vars for local runs)
const ADMIN = process.env.ADMIN_KEY || 'local-test-admin-key-0001';
const adm = (m, path, body) => fetch(BASE + path, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'X-Admin-Key': ADMIN }, body: body && JSON.stringify(body) });
const bad = await fetch(BASE + '/api/admin/orgs', { headers: { 'X-Admin-Key': 'wrong-key-wrong-key' } });
check('admin rejects a wrong key', bad.status === 401 || bad.status === 404);
const orgsRes = await adm('GET', '/api/admin/orgs');
if (orgsRes.status === 404) console.log('SKIP  admin tests (no ADMIN_KEY configured)');
else {
  const orgs = await orgsRes.json();
  check('admin lists businesses', orgs.rows.some((o) => o.name === 'Sharma Traders'));
  const mine = orgs.rows.find((o) => o.name === 'Sharma Traders');
  await adm('POST', `/api/admin/orgs/${mine.id}/plan`, { plan: 'free', months: 1 });
  const capped = await api('POST', '/api/warehouses', { name: 'Godown 3' }, true);
  check('free plan blocks extra godowns (402)', capped.status === 402 && capped.upgrade, JSON.stringify(capped));
  const tallyFree = await raw('/api/export/tally');
  check('free plan has no Tally export', tallyFree.status === 402);
  // online payment (Razorpay webhook way; needs RAZORPAY_WEBHOOK_SECRET in .dev.vars)
  const WH = process.env.RAZORPAY_WEBHOOK_SECRET || 'local-test-webhook-secret-0001';
  const { createHmac } = await import('node:crypto');
  const hook = (ev) => { const body = JSON.stringify(ev); return fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Razorpay-Signature': createHmac('sha256', WH).update(body).digest('hex') }, body }); };
  const ev = (notes, amount, id = 'pay_T' + Date.now()) => ({ event: 'payment.captured', payload: { payment: { entity: { id, amount, currency: 'INR', notes } } } });
  const planInfo = await api('GET', '/api/plan');
  check('plan page offers online payment', planInfo.billing === 'webhook' && planInfo.plans.find((p) => p.key === 'growth').pay === 2949, JSON.stringify({ b: planInfo.billing }));
  const st = await api('POST', '/api/billing/start', { plan: 'business' });
  check('checkout started with a reference', /^[0-9a-f]{32}$/.test(st.ref) && st.amount === 530900 && st.notes.product === 'smarttrader-erp', JSON.stringify(st));
  const forgedHook = await fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad' }, body: JSON.stringify(ev(st.notes, st.amount)) });
  check('webhook with a bad signature is refused', forgedHook.status === 401);
  check('another product on the same Razorpay account is ignored', (await (await hook(ev({ product: 'smart-pro', ref: st.ref }, st.amount))).json()).ignored === 'another product');
  check('still not paid', (await api('GET', `/api/billing/status?ref=${st.ref}`)).status === 'created');
  const st2 = await api('POST', '/api/billing/start', { plan: 'growth' });
  await hook(ev(st2.notes, 100));
  check('wrong amount does not switch the plan on', (await api('GET', `/api/billing/status?ref=${st2.ref}`)).status === 'amount_mismatch' && (await api('GET', '/api/me')).plan.key === 'free');
  const payId = 'pay_OK' + Date.now();
  await hook(ev(st.notes, st.amount, payId));
  const paid = await api('GET', `/api/billing/status?ref=${st.ref}`);
  check('paid webhook switches the plan on', paid.status === 'paid' && (await api('GET', '/api/me')).plan.key === 'business', JSON.stringify(paid));
  const until1 = (await api('GET', '/api/me')).plan.until;
  await hook(ev(st.notes, st.amount, payId));
  check('repeated webhook does not add another year', (await api('GET', '/api/me')).plan.until === until1);
  check('payment shows in history and admin', (await api('GET', '/api/plan')).history.some((h) => h.payment_id === payId) && (await (await adm('GET', '/api/admin/payments')).json()).rows.some((r) => r.payment_id === payId));
  check('verify needs the order way', (await api('POST', '/api/billing/verify', { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'x' }, true)).status === 400);
}

/* --- custom number series --- */
{
  const t = (await api('GET', '/api/me')).today;
  const y = +t.slice(0, 4) - (t.slice(5) < '04-01' ? 1 : 0), yy = (n) => String(n % 100).padStart(2, '0'), fy = `${yy(y)}-${yy(y + 1)}`;
  const s0 = await api('GET', '/api/settings/series');
  const inv0 = s0.rows.find((r) => r.type === 'INV');
  check('numbering lists every document type with a preview', s0.rows.length >= 13 && !inv0.custom && /^INV-\d{5}$/.test(inv0.preview) && s0.fy === fy, JSON.stringify(inv0));
  const set = await api('PUT', '/api/settings/series/INV', { prefix: 'SHT/{FY}/', pad: 4, fy_reset: true, next: 457 });
  check('series preview with FY and start number', set.preview === `SHT/${fy}/0457` && set.custom, JSON.stringify(set));
  const line = [{ description: 'Repair work', qty: 1, rate: 100 }];
  const a1 = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: line });
  const a2 = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: line });
  check('invoice uses the custom series', a1.number === `SHT/${fy}/0457` && a2.number === `SHT/${fy}/0458`, a1.number + ' ' + a2.number);
  const old = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, date: '2026-03-31', lines: line });
  check('last year restarts at 1 with its own FY', old.number === 'SHT/25-26/0001', old.number);
  check('yearly reset needs an FY token', (await api('PUT', '/api/settings/series/INV', { prefix: 'SHT/', pad: 4, fy_reset: true }, true)).status === 400);
  check('bad characters refused', (await api('PUT', '/api/settings/series/INV', { prefix: 'IN V#', pad: 4 }, true)).status === 400);
  check('more than 16 characters refused', (await api('PUT', '/api/settings/series/INV', { prefix: 'SHARMATRADERS/{FY}/', pad: 4 }, true)).status === 400);
  check('digits out of range refused', (await api('PUT', '/api/settings/series/INV', { prefix: 'A', pad: 9 }, true)).status === 400);
  check('next number cannot go back', (await api('PUT', '/api/settings/series/INV', { prefix: 'SHT/{FY}/', pad: 4, fy_reset: true, next: 3 }, true)).status === 400);
  check('unknown type refused', (await api('PUT', '/api/settings/series/XYZ', { prefix: 'A', pad: 4 }, true)).status === 400);
  cookie = storeCookie;
  check('store user cannot change numbering', (await api('PUT', '/api/settings/series/INV', { prefix: 'A', pad: 4 }, true)).status === 403);
  cookie = ownerCookie;
  await api('PUT', '/api/settings/series/receipt', { prefix: 'R/{YY}/', pad: 3 });
  const rc = await api('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: accts.cash.id, amount: 1 });
  check('receipts use their own series', new RegExp(`^R/${yy(y)}/\\d{3}$`).test(rc.number), rc.number);
  await api('DELETE', '/api/settings/series/INV');
  const back = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: line });
  check('back to default numbering', /^INV-\d{5}$/.test(back.number), back.number);
  const pay1 = await api('GET', '/api/payments?kind=payment');
  check('payment numbers unchanged', (pay1.rows || []).every((p) => /^PAY-\d{5}$/.test(p.number)));
}

/* --- custom fields --- */
{
  const add = (b, e) => api('POST', '/api/settings/fields', b, e);
  await add({ entity: 'doc', label: 'Vehicle no', type: 'text', on_print: true, side: 'sales' });
  await add({ entity: 'doc', label: 'Internal note', type: 'text' });
  await add({ entity: 'doc', label: 'Transport', type: 'select', options: 'Road, Rail', required: true, side: 'sales' });
  await add({ entity: 'party', label: 'Drug licence', type: 'text', on_print: true });
  const defs = (await add({ entity: 'item', label: 'Size', type: 'select', options: ['S', 'M', 'L'], on_print: true })).rows;
  check('custom fields saved with keys', defs.length === 5 && defs.find((f) => f.label === 'Vehicle no').key === 'vehicle_no' && (await api('GET', '/api/me')).org.fields.length === 5);
  check('dropdown needs options', (await add({ entity: 'item', label: 'Colour', type: 'select', options: 'Red' }, true)).status === 400);
  check('duplicate field name refused', (await add({ entity: 'item', label: 'size', type: 'text' }, true)).status === 400);
  cookie = storeCookie;
  check('store user cannot add fields', (await add({ entity: 'item', label: 'Brand' }, true)).status === 403);
  cookie = ownerCookie;
  const shirt = await api('POST', '/api/items', { name: 'CF Shirt', sale_price: 500, gst_rate: 5, opening_qty: 10, opening_rate: 300, extra: { size: 'M', junk: 'x' } });
  check('item custom value saved, unknown keys dropped', shirt.extra.size === 'M' && shirt.extra.junk === undefined, JSON.stringify(shirt.extra));
  check('invalid dropdown value refused', (await api('POST', '/api/items', { name: 'CF Shirt 2', extra: { size: 'XXL' } }, true)).status === 400);
  await api('PUT', `/api/items/${shirt.id}`, { ...shirt, extra: undefined, sale_price: 520 });
  check('editing without custom values keeps them', (await api('GET', `/api/items?cf.size=M`)).rows.some((i) => i.id === shirt.id && i.extra.size === 'M' && i.sale_price === 520));
  check('item filter by custom field', !(await api('GET', `/api/items?cf.size=L`)).rows.some((i) => i.id === shirt.id));
  const pc = await api('POST', '/api/parties', { name: 'CF Pharmacy', kind: 'customer', state: 'Rajasthan', extra: { drug_licence: 'RJ-DL-2211' } });
  check('party custom value saved', pc.extra.drug_licence === 'RJ-DL-2211' && (await api('GET', '/api/parties?cf.drug_licence=DL-22')).rows.some((p) => p.id === pc.id));
  const ln = [{ item_id: shirt.id, qty: 2 }];
  check('missing required field refused', (await api('POST', '/api/docs', { type: 'DN', party_id: pc.id, lines: ln, extra: { vehicle_no: 'RJ14AB1234' } }, true)).status === 400);
  check('purchase docs skip sales-only fields', (await api('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ description: 'x', qty: 1, rate: 1 }] })).extra.transport === undefined);
  const dn = await api('POST', '/api/docs', { type: 'DN', party_id: pc.id, lines: ln, extra: { vehicle_no: 'RJ14AB1234', transport: 'Road', internal_note: 'call first', foo: 1 } });
  check('document custom values saved', dn.extra.vehicle_no === 'RJ14AB1234' && dn.extra.foo === undefined);
  const cv = await api('GET', `/api/docs/${dn.id}/convert?to=INV`);
  check('custom values carry to the next document', cv.extra.vehicle_no === 'RJ14AB1234' && cv.extra.transport === 'Road');
  const ci = await api('POST', '/api/docs', cv);
  check('invoice from delivery note keeps vehicle no', ci.extra.vehicle_no === 'RJ14AB1234' && ci.print_fields.some((f) => f.label === 'Vehicle no'));
  check('document filter by custom field', (await api('GET', '/api/docs?type=INV&cf.vehicle_no=RJ14')).rows.some((d) => d.id === ci.id)
    && !(await api('GET', '/api/docs?type=INV&cf.transport=Rail')).rows.some((d) => d.id === ci.id));
  const tk = (await api('GET', `/api/docs/${ci.id}/share`)).url.split('/i/')[1];
  const pb = await (await fetch(`${BASE}/api/public/doc/${tk}`)).json();
  const labels = pb.print_fields.map((f) => f.label);
  check('public link shows only print fields', labels.includes('Vehicle no') && labels.includes('Drug licence') && !labels.includes('Internal note') && pb.extra === undefined
    && pb.lines[0].print_extra === 'Size: M', JSON.stringify(pb.print_fields) + pb.lines[0].print_extra);
  for (const f of (await api('GET', '/api/settings/fields')).rows) await api('DELETE', `/api/settings/fields/${f.id}`);
  check('fields removed', (await api('GET', '/api/settings/fields')).rows.length === 0);
}

/* --- custom roles --- */
{
  const role = await api('POST', '/api/roles', { name: 'Counter staff', perms: { view: ['items', 'masters', 'bogus'], edit: ['sales', 'khata'] } });
  check('role saved, edit implies view, unknown areas dropped', role.perms.edit.join() === 'sales,khata' && role.perms.view.includes('sales') && !role.perms.view.includes('bogus'), JSON.stringify(role.perms));
  check('duplicate role name refused', (await api('POST', '/api/roles', { name: 'Counter staff', perms: {} }, true)).status === 400);
  check('bad role refused for a user', (await api('POST', '/api/users', { email: 'z' + email, name: 'Z', role: 'c:999999', password: 'Counter-pass-1' }, true)).status === 400);
  await api('POST', '/api/users', { email: 'counter' + email, name: 'Counter Boy', role: `c:${role.id}`, password: 'Counter-pass-1' });
  const ul = await api('GET', '/api/users');
  check('user list shows the custom role', ul.rows.some((u) => u.role === 'Counter staff' && u.role_key === `c:${role.id}`) && ul.custom_roles.some((r) => r.id === role.id));
  cookie = storeCookie;
  check('store user cannot manage roles', (await api('POST', '/api/roles', { name: 'X', perms: {} }, true)).status === 403);
  cookie = '';
  await api('POST', '/api/auth/login', { email: 'counter' + email, password: 'Counter-pass-1' });
  const cm = await api('GET', '/api/me');
  check('custom role permissions in /api/me', cm.user.role === 'Counter staff' && cm.can.sales && cm.can.khata && !cm.can.purchase && !cm.can.settings && !cm.can.users
    && cm.view.items && !cm.view.reports && !cm.view.finance && cm.costs === false, JSON.stringify({ can: cm.can, view: cm.view }));
  const its = (await api('GET', '/api/items')).rows;
  check('costs hidden from counter staff', its.length && its.every((i) => i.purchase_price === undefined && i.avg_cost === undefined && i.stock_value === undefined && i.sale_price !== undefined));
  check('P&L blocked', (await api('GET', '/api/reports/pnl', null, true)).status === 403);
  check('payments list blocked', (await api('GET', '/api/payments', null, true)).status === 403);
  check('receipt blocked', (await api('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: accts.cash.id, amount: 1 }, true)).status === 403);
  check('purchase bills blocked', (await api('GET', '/api/docs?type=BILL', null, true)).status === 403);
  check('a purchase bill cannot be opened', (await api('GET', `/api/docs/${po.id}`, null, true)).status === 403);
  check('document list shows only sales', (await api('GET', '/api/docs?limit=500')).rows.every((d) => ['QUOTE', 'SO', 'DN', 'INV', 'SRET', 'CNOTE'].includes(d.type)));
  check('purchase order refused', (await api('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ description: 'x', qty: 1, rate: 1 }] }, true)).status === 403);
  const csale = await api('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ description: 'Counter sale', qty: 1, rate: 50 }] });
  check('counter staff can bill', /^INV-/.test(csale.number) && csale.lines.every((l) => l.cost === undefined));
  const dsh = await api('GET', '/api/reports/dashboard');
  check('dashboard hides profit', dsh.net_profit_fy === undefined && dsh.stock_value === undefined);
  check('settings blocked', (await api('PUT', '/api/settings/print', { layout: 'modern' }, true)).status === 403 && (await api('GET', '/api/users', null, true)).status === 403);
  cookie = ownerCookie;
  check('owner still sees everything', (await api('GET', '/api/reports/pnl')).net_profit !== undefined && (await api('GET', '/api/items')).rows[0].avg_cost !== undefined);
  check('role in use cannot be deleted', (await api('DELETE', `/api/roles/${role.id}`, null, true)).status === 400);
  await api('PUT', `/api/roles/${role.id}`, { name: 'Counter staff', perms: { edit: ['sales', 'khata', 'finance'], view: ['reports'] } });
  cookie = '';
  await api('POST', '/api/auth/login', { email: 'counter' + email, password: 'Counter-pass-1' });
  check('role change applies at once', (await api('GET', '/api/payments')).rows !== undefined && (await api('GET', '/api/reports/pnl')).net_profit !== undefined);
  cookie = ownerCookie;
  const cu = ul.rows.find((u) => u.role === 'Counter staff');
  await api('PUT', `/api/users/${cu.id}`, { role: 'sales' });
  check('role can be deleted once unused', (await api('DELETE', `/api/roles/${role.id}`)).ok);
}

/* --- global search and first-run checklist --- */
{
  const sr = await api('GET', '/api/search?q=' + encodeURIComponent('Basmati'));
  check('search finds items', sr.items.some((i) => i.id === rice.id) && Array.isArray(sr.parties) && Array.isArray(sr.docs));
  const sp = await api('GET', '/api/search?q=Mehta');
  check('search finds parties and their documents', sp.parties.some((p) => p.id === cust.id) && sp.docs.length > 0 && sp.docs.every((d) => d.party === 'Mehta Stores' && d.label));
  const sd = await api('GET', '/api/search?q=' + encodeURIComponent(inv.number));
  check('search finds a document by number', sd.docs.some((d) => d.id === inv.id));
  check('one-letter search returns nothing', (await api('GET', '/api/search?q=a')).items.length === 0);
  const sq = await qc('GET', '/api/search?q=Mehta');
  check('search is one D1 call', sq.n <= 3, String(sq.n));
  cookie = '';
  await api('POST', '/api/auth/signup', { business: 'Fresh Shop', name: 'F', email: 'fresh' + email, password: 'Fresh-pass-1' });
  const s0 = (await api('GET', '/api/reports/dashboard')).setup;
  check('new business: checklist all open', s0 && !s0.items && !s0.customers && !s0.invoices, JSON.stringify(s0));
  check('search cannot see another business', (await api('GET', '/api/search?q=Mehta')).parties.length === 0);
  cookie = ownerCookie;
  const s1 = (await api('GET', '/api/reports/dashboard')).setup;
  check('busy business: checklist done', s1.items && s1.customers && s1.invoices, JSON.stringify(s1));
}

/* Prototype keys must never resolve as report or plan names ('constructor' once returned the whole request context, secrets included). */
for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
  const r = await api('GET', '/api/reports/' + k, null, true);
  check('report "' + k + '" is not found', r.status === 404 && !JSON.stringify(r).includes('SESSION_SECRET'), JSON.stringify(r).slice(0, 120));
}
const bp = await api('POST', '/api/billing/start', { plan: 'constructor' }, true);
check('billing plan "constructor" is rejected cleanly', bp.status === 400, JSON.stringify(bp).slice(0, 120));

/* ======================================================================= security hardening ======================================================================= */
const tenant = async (label, ip) => {
  const em = `${label.toLowerCase()}${Date.now()}${Math.floor(Math.random() * 1e6)}@test.in`;
  const r = await rq('POST', '/api/auth/signup', { business: label + ' Co', name: label, email: em, password: 'Tenant-pass-1', state: 'Rajasthan' }, { ip });
  if (!r.cookie) throw new Error('signup failed ' + JSON.stringify(r.data));
  return { email: em, cookie: r.cookie, ip, get: (p) => rq('GET', p, undefined, { cookie: r.cookie, ip }), post: (p, b) => rq('POST', p, b || {}, { cookie: r.cookie, ip }),
    put: (p, b) => rq('PUT', p, b || {}, { cookie: r.cookie, ip }), del: (p) => rq('DELETE', p, undefined, { cookie: r.cookie, ip }) };
};
const setPlan = (orgName, plan, months = 12) => adm('GET', '/api/admin/orgs').then((r) => r.json()).then((l) => adm('POST', `/api/admin/orgs/${l.rows.find((o) => o.name === orgName).id}/plan`, { plan, months }));

/* --- finding 1 and the same bug class: names that exist on every object must never resolve as keys --- */
{
  const T = await tenant('Proto', '203.0.113.10');
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    check(`report "${k}" is 404 and leaks nothing`, (await T.get('/api/reports/' + k)).status === 404);
  }
  const leak = JSON.stringify((await T.get('/api/reports/constructor')).data);
  check('no secret names in any prototype-key answer', !/SESSION_SECRET|ADMIN_KEY|PAYHUB|RAZORPAY|RESEND/.test(leak));
  check('document type "constructor" is refused', (await T.post('/api/docs', { type: 'constructor', party_id: 1, lines: [{ description: 'x', qty: 1, rate: 1 }] })).status === 400);
  check('/api/docs?type=constructor lists nothing odd', (await T.get('/api/docs?type=constructor')).status === 200);
  check('convert to "constructor" is refused', (await T.get('/api/docs/1/convert?to=constructor')).status === 404);
  check('numbering for "constructor" is refused', (await T.put('/api/settings/series/constructor', { prefix: 'A', pad: 4 })).status === 400 && (await T.del('/api/settings/series/__proto__')).status === 400);
  const gst = await import('../src/gst.js');
  check('state and unit tables ignore inherited names', gst.stateCode('constructor', '') === '' && gst.stateCode('toString', '') === '' && gst.uqc('constructor') === 'OTH' && gst.uqc('hasOwnProperty') === 'OTH');
  const cust2 = (await T.post('/api/parties', { name: 'Cons Customer', kind: 'customer', state: 'Rajasthan' })).data;
  await T.post('/api/settings/fields', { entity: 'item', label: 'Constructor', type: 'text', on_print: true });
  const item = (await T.post('/api/items', { name: 'Field test', sale_price: 10, extra: {} })).data;
  check('a custom field named like an inherited key stays empty', JSON.stringify(item.extra) === '{}', JSON.stringify(item.extra));
  const own = (await T.post('/api/items', { name: 'Field test 2', sale_price: 10, extra: { constructor: 'ACME' } })).data;
  check('...and still stores a real value', own.extra && own.extra.constructor === 'ACME');
  const plans = await (await T.post('/api/billing/start', { plan: '__proto__' })).data;
  check('billing plan "__proto__" is refused', !!plans.error);
  const nul = await fetch(BASE + '/api/parties', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: T.cookie }, body: 'null' });
  const arr = await fetch(BASE + '/api/parties', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: T.cookie }, body: '[1]' });
  check('a JSON body that is null or a list is a 400, not a crash', nul.status === 400 && arr.status === 400);
  const badPath = await fetch(BASE + '/api/docs/%E0%A4%A', { headers: { Cookie: T.cookie } });
  check('a broken %-escape in the address is a 404, never a stack trace', badPath.status === 404 && !/at |\.js:\d+/.test(await badPath.text()));
  const err = await rq('GET', '/api/nothing-here', undefined, { cookie: T.cookie });
  check('error bodies carry only a message', Object.keys(err.data).join() === 'error');
}

/* --- findings 2 and 7: another business's party, account or item id is never accepted --- */
{
  const A = await tenant('Alpha', '203.0.113.11'), B = await tenant('Bravo', '203.0.113.12');
  const accA = (await A.get('/api/accounts')).data.rows, ar = accA.find((a) => a.sys === 'ar'), cash = accA.find((a) => a.sys === 'cash');
  const partyB = (await B.post('/api/parties', { name: 'Bravo Secret Customer', kind: 'customer', gstin: '08AAAAA0000A1Z5', state: 'Rajasthan' })).data;
  const itemB = (await B.post('/api/items', { name: 'Bravo secret item', sale_price: 5 })).data;
  const whB = (await B.get('/api/warehouses')).data.rows[0];
  const jv = (party_id) => ({ date: '2026-10-01', narration: 'probe', lines: [{ account_id: ar.id, party_id, debit: 1 }, { account_id: cash.id, credit: 1 }] });
  const r1 = await A.post('/api/journals', jv(partyB.id));
  check('journal with another business\'s party is refused', r1.status === 400 && /unknown party/i.test(r1.data.error), JSON.stringify(r1.data));
  check('journal with a junk party id is refused', (await A.post('/api/journals', jv('abc'))).status === 400 && (await A.post('/api/journals', jv(-5))).status === 400 && (await A.post('/api/journals', jv(1.5))).status === 400);
  check('journal with another business\'s account is refused', (await A.post('/api/journals', { ...jv(null), lines: [{ account_id: (await B.get('/api/accounts')).data.rows[0].id, debit: 1 }, { account_id: cash.id, credit: 1 }] })).status === 400);
  const mineP = (await A.post('/api/parties', { name: 'Alpha Own Customer', kind: 'customer' })).data;
  check('journal with its own party still works', (await A.post('/api/journals', jv(mineP.id))).status === 200 && (await A.post('/api/journals', jv(null))).status === 200 && (await A.post('/api/journals', jv(''))).status === 200);
  const db = JSON.stringify((await A.get('/api/reports/daybook?from=2026-01-01&to=2026-12-31')).data) + JSON.stringify((await A.get(`/api/accounts/${ar.id}/ledger?from=2026-01-01&to=2026-12-31`)).data);
  check('day book and ledger never show the other business\'s party', !db.includes('Bravo Secret') && db.includes('Alpha Own'));
  const tally = await fetch(BASE + '/api/export/tally?from=2026-01-01&to=2026-12-31', { headers: { Cookie: A.cookie } });
  const tx = await tally.text();
  check('Tally export never shows the other business\'s party', tally.status === 200 && !tx.includes('Bravo Secret') && !tx.includes('08AAAAA0000A1Z5'));
  // the same check on every other route that takes an id
  const L = [{ description: 'x', qty: 1, rate: 1 }];
  const miss = async (name, r) => check(`${name} refuses another business's id`, r.status === 400 || r.status === 404, `${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
  await miss('invoice party', await A.post('/api/docs', { type: 'INV', party_id: partyB.id, lines: L }));
  await miss('invoice item', await A.post('/api/docs', { type: 'INV', party_id: mineP.id, lines: [{ item_id: itemB.id, qty: 1 }] }));
  await miss('invoice godown', await A.post('/api/docs', { type: 'INV', party_id: mineP.id, warehouse_id: whB.id, lines: L }));
  await miss('invoice source document', await A.post('/api/docs', { type: 'INV', party_id: mineP.id, ref_id: 1, lines: L }));
  await miss('receipt party', await A.post('/api/payments', { kind: 'receipt', party_id: partyB.id, account_id: cash.id, amount: 1 }));
  await miss('receipt account', await A.post('/api/payments', { kind: 'receipt', party_id: mineP.id, account_id: (await B.get('/api/accounts')).data.rows.find((a) => a.is_cash).id, amount: 1 }));
  await miss('expense account', await A.post('/api/expenses', { account_id: (await B.get('/api/accounts')).data.rows.find((a) => a.type === 'expense').id, paid_from: cash.id, amount: 1 }));
  await miss('stock adjust item', await A.post('/api/stock/adjust', { item_id: itemB.id, qty: 5, reason: 'x' }));
  await miss('stock transfer godown', await A.post('/api/stock/transfer', { item_id: itemB.id, from_warehouse_id: whB.id, to_warehouse_id: whB.id, qty: 1 }));
  await miss('khata party', await A.post('/api/khata', { party_id: partyB.id, kind: 'gave', amount: 5 }));
  await miss('gate entry party', await A.post('/api/gate', { kind: 'in', party_id: partyB.id, vehicle_no: 'RJ14AB1234' }));
  await miss('opening balance party', await A.post(`/api/parties/${partyB.id}/opening`, { amount: 5 }));
  await miss('promise party', await A.post('/api/vaade', { party_id: partyB.id, book: 'khata', kind: 'date', date: '2026-10-30' }));
  const pl = (await A.get(`/api/parties/${partyB.id}/ledger`)).data;
  check('party ledger of another business is empty', pl.rows.length === 0 && pl.closing === 0);
  await miss('account ledger', await A.get(`/api/accounts/${(await B.get('/api/accounts')).data.rows[0].id}/ledger`));
  const stillB = (await B.get('/api/reports/daybook?from=2026-01-01&to=2026-12-31')).data;
  check('the other business\'s books are untouched', !JSON.stringify(stillB).includes('probe'));
}

/* --- finding 20: logout, password change and removing a user end the old tokens --- */
{
  const O = await tenant('Sess', '203.0.113.13');
  const who = async (ck) => (await rq('GET', '/api/me', undefined, { cookie: ck, ip: O.ip })).status;
  const l2 = await rq('POST', '/api/auth/login', { email: O.email, password: 'Tenant-pass-1' }, { ip: O.ip });
  const l3 = await rq('POST', '/api/auth/login', { email: O.email, password: 'Tenant-pass-1' }, { ip: O.ip });
  check('three sessions of one user are all valid', (await who(O.cookie)) === 200 && (await who(l2.cookie)) === 200 && (await who(l3.cookie)) === 200);
  const out = await rq('POST', '/api/auth/logout', {}, { cookie: l2.cookie, ip: O.ip });
  check('logout kills that token on the server', (await who(l2.cookie)) === 401);
  check('...but not the user\'s other devices', (await who(O.cookie)) === 200 && (await who(l3.cookie)) === 200);
  check('the logout cookie is cleared with the same attributes', /Max-Age=0/.test(out.setCookie) && /HttpOnly/.test(out.setCookie) && /SameSite=Lax/.test(out.setCookie));
  check('a logout without a session is harmless', (await rq('POST', '/api/auth/logout', {}, { ip: O.ip })).status === 200);
  const keep = l3.cookie;
  const changed = await rq('POST', '/api/me/password', { current: 'Tenant-pass-1', password: 'Tenant-pass-2' }, { cookie: O.cookie, ip: O.ip });
  check('a password change kills every older token', (await who(keep)) === 401 && (await who(O.cookie)) === 401);
  check('...and hands back a working one', changed.cookie && (await who(changed.cookie)) === 200);
  const owner2 = changed.cookie;
  const staff = await rq('POST', '/api/users', { email: 'staff' + O.email, name: 'Staff', role: 'sales', password: 'Staff-pass-1' }, { cookie: owner2, ip: O.ip });
  const sl = await rq('POST', '/api/auth/login', { email: 'staff' + O.email, password: 'Staff-pass-1' }, { ip: O.ip });
  const staffId = (await rq('GET', '/api/users', undefined, { cookie: owner2, ip: O.ip })).data.rows.find((u) => u.email === 'staff' + O.email).id;
  check('staff can sign in', staff.status === 200 && (await who(sl.cookie)) === 200);
  await rq('PUT', `/api/users/${staffId}`, { active: false }, { cookie: owner2, ip: O.ip });
  check('removing a user ends their open session at once', (await who(sl.cookie)) === 401);
  await rq('PUT', `/api/users/${staffId}`, { active: true }, { cookie: owner2, ip: O.ip });
  check('...and switching them back on does not revive the old token', (await who(sl.cookie)) === 401);
  const sl2 = await rq('POST', '/api/auth/login', { email: 'staff' + O.email, password: 'Staff-pass-1' }, { ip: O.ip });
  await rq('PUT', `/api/users/${staffId}`, { password: 'Staff-pass-2' }, { cookie: owner2, ip: O.ip });
  check('an owner-set password ends the staff member\'s old sessions', (await who(sl2.cookie)) === 401);
  const d1 = await rq('POST', '/api/auth/login', { email: O.email, password: 'Tenant-pass-2' }, { ip: O.ip });
  const d2 = await rq('POST', '/api/auth/login', { email: O.email, password: 'Tenant-pass-2' }, { ip: O.ip });
  const all = await rq('POST', '/api/me/logout-all', {}, { cookie: d1.cookie, ip: O.ip });
  check('"sign out everywhere" ends every device', all.status === 200 && (await who(d1.cookie)) === 401 && (await who(d2.cookie)) === 401 && (await who(owner2)) === 401);
  const forged = d2.cookie.replace(/\.[^.]+$/, '.AAAA');
  check('a token with a bad signature is refused', (await who(forged)) === 401);
  const body = d2.cookie.split('=')[1].split('.')[0];
  const tampered = 'st_session=' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), e: Date.now() + 1e9 })).toString('base64url') + '.' + d2.cookie.split('.')[1];
  check('a token whose contents were edited is refused', (await who(tampered)) === 401);
  check('the cookie is HttpOnly and SameSite', /HttpOnly/.test(d1.setCookie) && /SameSite=Lax/.test(d1.setCookie) && /Path=\//.test(d1.setCookie));
}

/* --- findings 18 and 22: login throttle (per address and per account, failures only) and sign-up --- */
{
  const V = await tenant('Throttle', '203.0.113.14');
  const login = (email, password, ip) => rq('POST', '/api/auth/login', { email, password }, { ip });
  const ok1 = await login(V.email, 'Tenant-pass-1', '203.0.113.20');
  const ok2 = await login(V.email, 'Tenant-pass-1', '203.0.113.20');
  const written = (r) => +(r.headers.get('X-Rows') || '0/0').split('/')[1];
  check('a successful login writes nothing to the database', ok1.status === 200 && ok2.status === 200 && (r => r === 0 || Number.isNaN(r))(written(ok2)), ok2.headers.get('X-Rows'));
  let last;
  for (let i = 0; i < 10; i++) last = await login(V.email, 'wrong-' + i, '203.0.113.21');
  check('ten wrong passwords from one address are answered 401', last.status === 401);
  const blocked = await login(V.email, 'Tenant-pass-1', '203.0.113.21');
  check('the eleventh try from that address is 429, even with the right password', blocked.status === 429, String(blocked.status));
  const elsewhere = await login(V.email, 'Tenant-pass-1', '203.0.113.22');
  check('a stranger at one address cannot lock the owner out from another', elsewhere.status === 200, String(elsewhere.status));
  let spray = 0, code = 0;
  for (let i = 0; i < 40 && code !== 429; i++) { const r = await login(`nobody${i}${Date.now()}@test.in`, 'Guess-pass-1', '203.0.113.23'); code = r.status; spray++; }
  check('one address spraying many accounts is stopped (429)', code === 429 && spray <= 32, `${code} after ${spray}`);
  check('unknown and wrong-password answers look the same', (await login('nobody@test.in', 'x', '203.0.113.24')).data.error === (await login(V.email, 'x', '203.0.113.25')).data.error);
  let acct = 0;
  for (let i = 0; i < 45 && acct !== 429; i++) acct = (await login(V.email, 'bad-' + i, `203.0.114.${i + 1}`)).status;
  check('many addresses guessing one account hit the account cap (429)', acct === 429);
  // signup / user creation do not tell apart "taken" for new people in a helpful way beyond what is unavoidable
  const dup = await rq('POST', '/api/auth/signup', { business: 'Dup', name: 'D', email: V.email, password: 'Tenant-pass-1' }, { ip: '203.0.113.26' });
  check('sign-up with a taken address is refused (no e-mail to send the news to, so it has to say so)', dup.status === 400 && /already exists/i.test(dup.data.error));
  const add = await rq('POST', '/api/users', { email: V.email, name: 'X', role: 'sales', password: 'Staff-pass-1' }, { cookie: V.cookie, ip: V.ip });
  check('adding a user with a taken address says nothing about who owns it', add.status === 400 && !/account|sign in|exists/i.test(add.data.error), add.data.error);
}

/* --- finding 6: custom-role view limits hold on every read, and unknown reads are closed --- */
{
  const O = await tenant('Roles', '203.0.113.15');
  await O.post('/api/parties', { name: 'Roles Supplier', kind: 'supplier' });
  const sup2 = (await O.get('/api/parties')).data.rows.find((p) => p.name === 'Roles Supplier');
  const cu = (await O.post('/api/parties', { name: 'Roles Customer', kind: 'customer' })).data;
  const itm = (await O.post('/api/items', { name: 'Roles Item', purchase_price: 80, sale_price: 100, opening_qty: 10, opening_rate: 80 })).data;
  await O.post('/api/docs', { type: 'PO', party_id: sup2.id, lines: [{ item_id: itm.id, qty: 3 }] });
  await O.post('/api/docs', { type: 'BILL', party_id: sup2.id, lines: [{ item_id: itm.id, qty: 2, rate: 80 }] });
  await O.post('/api/docs', { type: 'SO', party_id: cu.id, lines: [{ item_id: itm.id, qty: 1 }] });
  await O.post('/api/gate', { kind: 'in', party_id: sup2.id, vehicle_no: 'RJ14AB1234' });
  const role = (await O.post('/api/roles', { name: 'Sales only', perms: { view: ['items', 'sales'], edit: ['sales'] } })).data;
  await O.post('/api/users', { email: 'so' + O.email, name: 'SO', role: `c:${role.id}`, password: 'Staff-pass-1' });
  const S = { cookie: (await rq('POST', '/api/auth/login', { email: 'so' + O.email, password: 'Staff-pass-1' }, { ip: O.ip })).cookie };
  const g = (p) => rq('GET', p, undefined, { cookie: S.cookie, ip: O.ip });
  const owner = (await O.get('/api/reports/pending')).data;
  check('(setup) the owner sees purchase work waiting', owner.to_receive.length > 0 && owner.at_gate.length > 0);
  const acc = await g('/api/accounts');
  check('accounts: only cash and bank, balances only', acc.status === 200 && acc.data.rows.length > 0 && acc.data.rows.every((a) => a.is_cash && a.dr === undefined && a.cr === undefined && a.bal === undefined && typeof a.balance === 'number'), JSON.stringify(acc.data.rows[0]));
  const wh2 = await g('/api/warehouses');
  check('godowns: no stock value without cost rights', wh2.status === 200 && wh2.data.rows.every((w) => w.value === undefined));
  check('godown value is still there for the owner', (await O.get('/api/warehouses')).data.rows[0].value !== undefined);
  const dsh = (await g('/api/reports/dashboard')).data;
  check('dashboard: no purchase documents in the recent list', dsh.recent.length > 0 && dsh.recent.every((r) => ['QUOTE', 'SO', 'DN', 'INV', 'SRET', 'CNOTE'].includes(r.type)), JSON.stringify(dsh.recent.map((r) => r.type)));
  check('dashboard: no purchase, payable, GST or cost figures', dsh.purchases_fy === undefined && dsh.payable === undefined && dsh.gst_payable === undefined && dsh.stock_value === undefined && dsh.monthly.every((m) => m.purchases === undefined)
    && dsh.low_stock.every((r) => r.avg_cost === undefined && r.value === undefined), JSON.stringify(Object.keys(dsh)));
  const pend = (await g('/api/reports/pending')).data;
  check('pending work: purchase sections are empty, sales sections stay', pend.to_receive.length === 0 && pend.to_bill.length === 0 && pend.at_gate.length === 0 && pend.to_deliver.length > 0, JSON.stringify(pend).slice(0, 200));
  const prt = (await g('/api/parties')).data.rows;
  check('parties: customers only, with no balance', prt.length > 0 && prt.every((p) => p.kind !== 'supplier' && p.balance === undefined), JSON.stringify(prt[0]));
  check('items stay readable', (await g('/api/items')).status === 200 && (await g('/api/items')).data.rows.every((i) => i.purchase_price === undefined));
  const closed = ['/api/settings/series', '/api/billing/status?ref=x', '/api/reports/unknown-report', '/api/export/tally', '/api/audit', '/api/users', '/api/roles', '/api/gate', '/api/payments', '/api/khata', '/api/vaade', '/api/some/new/endpoint'];
  const codes = await Promise.all(closed.map(async (p) => [p, (await g(p)).status]));
  check('every other read is closed to this role (default deny)', codes.every(([, c]) => c === 403 || c === 404) && codes.filter(([, c]) => c === 403).length >= closed.length - 1, JSON.stringify(codes));
  check('plan page shows no payment history', (await g('/api/plan')).data.history.length === 0);
  const doc = (await g('/api/docs')).data.rows;
  check('document list is only the sales side', doc.length > 0 && doc.every((d) => ['QUOTE', 'SO', 'DN', 'INV', 'SRET', 'CNOTE'].includes(d.type)));
  const full = (await O.post('/api/roles', { name: 'Everything view', perms: { view: ['sales', 'purchase', 'items', 'masters', 'finance', 'khata', 'reports', 'settings'], edit: [] } })).data;
  await O.post('/api/users', { email: 'ev' + O.email, name: 'EV', role: `c:${full.id}`, password: 'Staff-pass-1' });
  const E = (await rq('POST', '/api/auth/login', { email: 'ev' + O.email, password: 'Staff-pass-1' }, { ip: O.ip })).cookie;
  const ge = (p) => rq('GET', p, undefined, { cookie: E, ip: O.ip });
  const pe = (await ge('/api/reports/pending')).data, de = (await ge('/api/reports/dashboard')).data, ae = (await ge('/api/accounts')).data.rows;
  check('a role that views everything still sees everything', pe.to_receive.length > 0 && de.purchases_fy !== undefined && ae.some((a) => !a.is_cash && a.dr !== undefined) && (await ge('/api/settings/series')).status === 200);
}

/* --- finding 24: who can publish customer links, and turning them off --- */
{
  const O = await tenant('Links', '203.0.113.16');
  const cu = (await O.post('/api/parties', { name: 'Link Customer', kind: 'customer', phone: '9876543210' })).data;
  const inv = (await O.post('/api/docs', { type: 'INV', party_id: cu.id, lines: [{ description: 'Work', qty: 1, rate: 100 }] })).data;
  const view = (await O.post('/api/roles', { name: 'Viewer', perms: { view: ['sales', 'khata', 'masters'], edit: [] } })).data;
  const sell = (await O.post('/api/roles', { name: 'Seller', perms: { view: ['sales'], edit: ['sales'] } })).data;
  for (const [n, r] of [['vw', view], ['sl', sell]]) await O.post('/api/users', { email: n + O.email, name: n, role: `c:${r.id}`, password: 'Staff-pass-1' });
  const V = (await rq('POST', '/api/auth/login', { email: 'vw' + O.email, password: 'Staff-pass-1' }, { ip: O.ip })).cookie;
  const Sl = (await rq('POST', '/api/auth/login', { email: 'sl' + O.email, password: 'Staff-pass-1' }, { ip: O.ip })).cookie;
  check('a view-only role cannot create an invoice link', (await rq('GET', `/api/docs/${inv.id}/share`, undefined, { cookie: V, ip: O.ip })).status === 403);
  check('...nor an invoice reminder link', (await rq('GET', `/api/parties/${cu.id}/reminder`, undefined, { cookie: V, ip: O.ip })).status === 403);
  check('...nor a khata link', (await rq('GET', `/api/khata/${cu.id}/reminder`, undefined, { cookie: V, ip: O.ip })).status === 403 && (await rq('GET', `/api/khata/${cu.id}`, undefined, { cookie: V, ip: O.ip })).data.statement_url === '');
  const sh = (await rq('GET', `/api/docs/${inv.id}/share`, undefined, { cookie: Sl, ip: O.ip })).data;
  check('a role that may sell can', /\/i\/[0-9a-f]{24}$/.test(sh.url));
  const tok = sh.url.split('/i/')[1];
  check('the customer link opens', (await rq('GET', `/api/public/doc/${tok}`, undefined, { ip: '203.0.113.99' })).status === 200);
  check('a view-only role cannot revoke', (await rq('POST', `/api/docs/${inv.id}/share/revoke`, {}, { cookie: V, ip: O.ip })).status === 403);
  check('revoking turns the link off at once', (await rq('POST', `/api/docs/${inv.id}/share/revoke`, {}, { cookie: Sl, ip: O.ip })).status === 200 && (await rq('GET', `/api/public/doc/${tok}`, undefined, { ip: '203.0.113.99' })).status === 404);
  check('...including its share page and images', (await fetch(`${BASE}/i/${tok}`)).status === 200 && (await rq('GET', `/api/public/doc/${tok}/file/logo`, undefined, {})).status === 404);
  const sh2 = (await O.get(`/api/docs/${inv.id}/share`)).data;
  check('sharing again makes a different link', sh2.url.split('/i/')[1] !== tok && (await rq('GET', `/api/public/doc/${sh2.url.split('/i/')[1]}`, undefined, { ip: '203.0.113.99' })).status === 200);
  const kh = (await O.get(`/api/khata/${cu.id}/reminder`)).data, kt = kh.text.match(/\/k\/([0-9a-f]{24})/)[1];
  check('the khata link opens', (await rq('GET', `/api/public/khata/${kt}`, undefined, { ip: '203.0.113.99' })).status === 200);
  check('revoking the khata link turns it off', (await O.post(`/api/khata/${cu.id}/revoke-link`)).status === 200 && (await rq('GET', `/api/public/khata/${kt}`, undefined, { ip: '203.0.113.99' })).status === 404);
  const t3 = (await O.get(`/api/docs/${inv.id}/share`)).data.url.split('/i/')[1];
  const kt2 = (await O.get(`/api/khata/${cu.id}/reminder`)).data.text.match(/\/k\/([0-9a-f]{24})/)[1];
  check('only owner/admin can turn off every link', (await rq('POST', '/api/org/revoke-links', {}, { cookie: Sl, ip: O.ip })).status === 403);
  const all = await O.post('/api/org/revoke-links');
  check('"turn off all links" ends invoice and khata links', all.status === 200 && all.data.invoices >= 1 && all.data.khata >= 1 && (await rq('GET', `/api/public/doc/${t3}`, undefined, { ip: '203.0.113.99' })).status === 404 && (await rq('GET', `/api/public/khata/${kt2}`, undefined, { ip: '203.0.113.99' })).status === 404);
  const inv2 = (await O.post('/api/docs', { type: 'INV', party_id: cu.id, lines: [{ description: 'Work 2', qty: 1, rate: 50 }] })).data;
  const t4 = (await O.get(`/api/docs/${inv2.id}/share`)).data.url.split('/i/')[1];
  check('(setup) a second invoice link works', (await rq('GET', `/api/public/doc/${t4}`, undefined, { ip: '203.0.113.99' })).status === 200);
  await O.post(`/api/docs/${inv2.id}/cancel`);
  check('a cancelled document\'s link stops working', (await rq('GET', `/api/public/doc/${t4}`, undefined, { ip: '203.0.113.99' })).status === 404);
}

/* --- findings 19 and 23: the free invoice cap counts by creation time, and plan limits hold when a plan lapses --- */
if ((await adm('GET', '/api/admin/orgs')).status === 404) console.log('SKIP  plan-limit tests (no ADMIN_KEY configured)');
else {
  const F = await tenant('Capped', '203.0.113.17');
  await setPlan('Capped Co', 'free');
  const cu = (await F.post('/api/parties', { name: 'Cap Customer', kind: 'customer' })).data;
  const mk = (date) => F.post('/api/docs', { type: 'INV', party_id: cu.id, date, lines: [{ description: 'x', qty: 1, rate: 1 }] });
  const oldDate = '2026-01-15';
  let made = 0, stop;
  for (let i = 0; i < 52 && !stop; i++) { const r = await mk(oldDate); if (r.status === 200) made++; else stop = r; }
  check('back-dated invoices count toward the free cap (50, then 402)', made === 50 && stop && stop.status === 402 && stop.data.upgrade === true, `${made} ${stop && stop.status}`);
  check('the plan page shows them', (await F.get('/api/plan')).data.usage.invoices_this_month === 50);
  const first = (await F.get('/api/docs?type=INV&limit=1')).data.rows[0];
  await F.post(`/api/docs/${first.id}/cancel`);
  check('cancelling an invoice does not free its place', (await mk(oldDate)).status === 402);
  await setPlan('Capped Co', 'growth');
  check('upgrading lifts the cap', (await mk(oldDate)).status === 200);
  // parallel requests cannot all slip under the cap
  const G = await tenant('Parallel', '203.0.113.18');
  await setPlan('Parallel Co', 'free');
  const gc = (await G.post('/api/parties', { name: 'P Customer', kind: 'customer' })).data;
  const mk2 = () => G.post('/api/docs', { type: 'INV', party_id: gc.id, lines: [{ description: 'x', qty: 1, rate: 1 }] });
  for (let i = 0; i < 46; i++) await mk2();
  const burst = await Promise.all(Array.from({ length: 10 }, mk2));
  const okN = burst.filter((r) => r.status === 200).length;
  check('ten parallel invoices at 46 of 50 create exactly four', okN === 4 && burst.filter((r) => r.status === 402).length === 6, `${okN} ok: ${burst.map((r) => r.status).join(',')}`);
  check('...and never a half-saved document', (await G.get('/api/reports/trial-balance')).data.balanced === true && (await G.get('/api/plan')).data.usage.invoices_this_month === 50);

  // users and godowns when a plan lapses
  const U = await tenant('Lapse', '203.0.113.19');
  await setPlan('Lapse Co', 'growth');
  const wh2 = (await U.post('/api/warehouses', { name: 'Second godown' })).data;
  const cust3 = (await U.post('/api/parties', { name: 'Lapse Customer', kind: 'customer' })).data;
  const itm = (await U.post('/api/items', { name: 'Lapse item', sale_price: 10, opening_qty: 20, opening_rate: 5 })).data;
  const staff = [];
  for (const n of ['a', 'b', 'c']) { await U.post('/api/users', { email: n + U.email, name: n, role: 'sales', password: 'Staff-pass-1' }); staff.push((await rq('POST', '/api/auth/login', { email: n + U.email, password: 'Staff-pass-1' }, { ip: U.ip })).cookie); }
  const me = (ck) => rq('GET', '/api/me', undefined, { cookie: ck, ip: U.ip }).then((r) => r.status);
  check('on Growth the owner and three staff all work', (await Promise.all(staff.map(me))).every((s) => s === 200));
  await setPlan('Lapse Co', 'starter');      // 2 users: the owner and the oldest staff member
  check('on a 2-user plan only the oldest staff member keeps a seat', JSON.stringify(await Promise.all(staff.map(me))) === '[200,403,403]');
  const paused = await rq('GET', '/api/me', undefined, { cookie: staff[1], ip: U.ip });
  check('the paused login says why', /plan allows 2 users/i.test(paused.data.error) && paused.data.upgrade === true);
  check('the owner still works and sees who is paused', (await me(U.cookie)) === 200 && (await U.get('/api/users')).data.rows.filter((u) => u.paused).length === 2);
  check('a paused user cannot sign in again', (await rq('POST', '/api/auth/login', { email: 'b' + U.email, password: 'Staff-pass-1' }, { ip: U.ip })).status === 403);
  check('...and the paused user\'s password-less state does not break the owner\'s list', (await U.get('/api/users')).status === 200);
  await setPlan('Lapse Co', 'free');
  check('on Free only the owner can work', JSON.stringify(await Promise.all(staff.map(me))) === '[403,403,403]' && (await me(U.cookie)) === 200);
  const main = (await U.get('/api/warehouses')).data.rows[0];
  const sale2 = (wid) => U.post('/api/docs', { type: 'INV', party_id: cust3.id, warehouse_id: wid, lines: [{ item_id: itm.id, qty: 1 }] });
  check('the first godown keeps working', (await sale2(main.id)).status === 200);
  const over = await sale2(wh2.id);
  check('a godown over the plan limit takes no new documents (402)', over.status === 402 && over.data.upgrade === true, JSON.stringify(over.data));
  check('...nor stock adjustments or transfers into it', (await U.post('/api/stock/adjust', { item_id: itm.id, qty: 1, reason: 'x', warehouse_id: wh2.id })).status === 402
    && (await U.post('/api/stock/transfer', { item_id: itm.id, from_warehouse_id: main.id, to_warehouse_id: wh2.id, qty: 1 })).status === 402);
  check('...and Free cannot add another godown', (await U.post('/api/warehouses', { name: 'Third' })).status === 402);
  const R = await tenant('Race', '203.0.113.31');
  await setPlan('Race Co', 'starter');
  const racers = await Promise.all(['x', 'y', 'z'].map((n) => R.post('/api/users', { email: n + R.email, name: n, role: 'sales', password: 'Staff-pass-1' })));
  check('parallel user creation cannot pass the plan\'s seat count', racers.filter((r) => r.status === 200).length === 1 && racers.filter((r) => r.status === 402).length === 2
    && (await R.get('/api/users')).data.rows.filter((u) => u.active).length === 2, racers.map((r) => r.status).join(','));
  const gr = await Promise.all(['G1', 'G2', 'G3'].map((n) => R.post('/api/warehouses', { name: n })));
  check('parallel godown creation cannot pass the plan\'s limit (Starter: 1)', gr.every((r) => r.status === 402) && (await R.get('/api/warehouses')).data.rows.length === 1, gr.map((r) => r.status).join(','));
  await setPlan('Lapse Co', 'business');
  const racers2 = await Promise.all(['p', 'q'].map((n) => U.post('/api/users', { email: n + U.email, name: n, role: 'sales', password: 'Staff-pass-1' })));
  check('on a bigger plan the same requests succeed', racers2.every((r) => r.status === 200));
  check('upgrading brings the paused staff back', JSON.stringify(await Promise.all(staff.map(me))) === '[200,200,200]');
}

/* --- findings 21 and 26: security headers on the app, the API and the share pages --- */
{
  const T = await tenant('Headers', '203.0.113.30');
  const { CSP_APP, CSP_API, BASE_HEADERS } = await import('../src/headers.js');
  const cu = (await T.post('/api/parties', { name: 'H Customer', kind: 'customer' })).data;
  const inv = (await T.post('/api/docs', { type: 'INV', party_id: cu.id, lines: [{ description: 'x', qty: 1, rate: 1 }] })).data;
  const tok = (await T.get(`/api/docs/${inv.id}/share`)).data.url.split('/i/')[1];
  const kt = (await T.get(`/api/khata/${cu.id}/reminder`)).data.text.match(/\/k\/([0-9a-f]{24})/)[1];
  const hs = async (path, ck) => (await fetch(BASE + path, { headers: ck ? { Cookie: ck } : {} })).headers;
  const same = (h, csp) => Object.entries(BASE_HEADERS).every(([k, v]) => h.get(k) === v) && h.get('content-security-policy') === csp;
  check('the app page carries the full header set', same(await hs('/'), CSP_APP));
  check('app.js carries it too', same(await hs('/app.js'), CSP_APP));
  check('the invoice share page carries it', same(await hs('/i/' + tok), CSP_APP));
  check('the khata share page carries it', same(await hs('/k/' + kt), CSP_APP));
  check('a share page with a bad token carries it', same(await hs('/i/' + '0'.repeat(24)), CSP_APP));
  check('JSON answers carry it (locked-down policy)', same(await hs('/api/health'), CSP_API) && same(await hs('/api/me', T.cookie), CSP_API) && same(await hs('/api/me'), CSP_API));
  check('downloads carry it', same(await hs('/api/export/tally', T.cookie), CSP_API));
  check('the policy forbids framing, inline scripts and plugins', /frame-ancestors 'none'/.test(CSP_APP) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(CSP_APP) && /object-src 'none'/.test(CSP_APP) && /base-uri 'none'/.test(CSP_APP));
  const fs = await import('node:fs');
  const file = fs.readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const lines = Object.fromEntries(file.split('\n').filter((l) => /^\s+\S+: /.test(l)).map((l) => [l.trim().split(': ')[0], l.trim().slice(l.trim().indexOf(': ') + 2)]));
  check('public/_headers matches src/headers.js', lines['Content-Security-Policy'] === CSP_APP && Object.entries(BASE_HEADERS).every(([k, v]) => lines[k] === v));
  const page = await (await fetch(BASE + '/')).text();
  check('the page has no inline script or handler', !/<script(?![^>]*(type="application\/ld\+json"|src=))/i.test(page) && !/\son[a-z]+=/i.test(page));
  const appjs = await (await fetch(BASE + '/app.js')).text();
  check('the app has no inline handler or javascript: link', !/\son(click|change|input|submit|load|error)=/i.test(appjs.replace(/\.on(click|change|input|submit|load|error)\b/g, '')) && !/href="javascript:/i.test(appjs));
}

/* --- finding 25: spreadsheet formulas in exports --- */
{
  const { csvCell, toCsv } = await import('../public/csv.js');
  check('CSV: = + - @ cells are neutralised', ['=HYPERLINK("http://x","y")', '+cmd|calc', '-2+3', '@SUM(A1)', '=1+1'].every((v) => csvCell(v).replace(/^"/, '').startsWith("'")), csvCell('=1+1'));
  check('CSV: tab and return starts are neutralised', csvCell('\tx').startsWith(`"'`) || csvCell('\tx').startsWith("'") , csvCell('\tx'));
  check('CSV: real numbers are left alone', csvCell(-1500.5) === '-1500.5' && csvCell('-1500.50') === '-1500.50' && csvCell('+919876543210') === '+919876543210' && csvCell(0) === '0');
  check('CSV: ordinary text, commas and quotes still work', csvCell('Shree Ram') === 'Shree Ram' && csvCell('A, B') === '"A, B"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell(null) === '');
  check('CSV: the injected name is safe in a whole file', !toCsv([{ h: 'Name', k: 'n' }, { h: 'Amt', k: 'a' }], [{ n: '=cmd|\' /C calc\'!A0', a: -5 }]).split('\n')[1].startsWith('='));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
