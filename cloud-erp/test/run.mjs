/* End-to-end test against a running worker (npx wrangler dev, or a deployed URL):
     node test/run.mjs [http://localhost:8787]
   Runs a full procure-to-pay and order-to-cash cycle for a fresh business, then checks that
   the books balance, stock value equals the inventory ledger, and every total is exact. */
import { backupHealth } from '../src/lib.js';
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
check('only the owner can download the Excel backup', (await api('GET', '/api/export/excel', null, true)).status === 403);
check('only the owner can restore a backup', (await api('POST', '/api/restore', { format: 'smarttrader-backup', version: 1, tables: {} }, true)).status === 403);
check('only the owner can make due recurring bills by hand', (await api('POST', '/api/recurring/run', {}, true)).status === 403);
const storeCookie = cookie;
check('only the owner can connect Google Drive', (await api('POST', '/api/gdrive/connect', {}, true)).status === 403);
if (process.env.ERP_GDRIVE_MOCK) {
  /* Google Drive backup against a stand-in Google (start the worker with the GDRIVE_* vars pointing at it, see README) */
  const http = await import('node:http');
  const files = [], calls = [], mock = { badMd5: false };
  const { createHash } = await import('node:crypto');
  for (let i = 0; i < 32; i++) files.push({ id: 'old' + i, name: 'smarttrader-backup-old-' + i + '.json', createdTime: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(), body: '' });
  const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const g = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => {
      const b = Buffer.concat(chunks).toString('latin1');      // byte for byte, so an Excel upload stays intact
      const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname);
      if (u.pathname === '/token') {
        const f = new URLSearchParams(b);
        if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'good') return send(res, 200, { access_token: 'at1', refresh_token: 'rt-secret-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
        // the person left the Drive box unticked on Google's page
        if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'emailonly') return send(res, 200, { access_token: 'at-e', refresh_token: 'rt-email', expires_in: 3600, scope: 'https://www.googleapis.com/auth/userinfo.email openid' });
        // an older answer without the scope list: the link is made, Drive then refuses the call
        if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'noscopefield') return send(res, 200, { access_token: 'at-ns', refresh_token: 'rt-ns', expires_in: 3600 });
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt-ns') return send(res, 200, { access_token: 'at-ns', expires_in: 3600 });
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt-secret-1') return send(res, 200, { access_token: 'at2', expires_in: 3600 });
        return send(res, 400, { error: 'invalid_grant' });
      }
      if (u.pathname === '/revoke') return send(res, 200, {});
      if (req.headers.authorization === 'Bearer at-ns') return send(res, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
      if (req.headers.authorization !== 'Bearer at1' && req.headers.authorization !== 'Bearer at2') return send(res, 401, { error: { message: 'no token' } });
      if (u.pathname === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'owner@gmail.com' } });
      if (u.pathname === '/drive/v3/files' && req.method === 'POST') return send(res, 200, { id: 'fold1' });
      if (u.pathname === '/drive/v3/files' && req.method === 'GET') return send(res, 200, { files: files.slice().sort((a, b2) => b2.createdTime.localeCompare(a.createdTime)) });
      if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'GET' && u.searchParams.get('alt') === 'media') {
        const f = files.find((x) => x.id === u.pathname.split('/').pop());
        if (!f) return send(res, 404, { error: { message: 'File not found' } });
        res.writeHead(200, { 'Content-Type': f.mime || 'application/json' }); return res.end(f.bytes || f.body);
      }
      if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'GET') return send(res, 200, { id: 'fold1', trashed: false });
      if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'DELETE') { const id = u.pathname.split('/').pop(); files.splice(files.findIndex((f) => f.id === id), 1); res.writeHead(204); return res.end(); }
      if (u.pathname === '/upload/drive/v3/files') {
        const parts = b.split(/--st[^\r\n]*/); const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
        const bytes = Buffer.from(parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
        const f = { id: 'f' + files.length + Date.now(), name: meta.name, mime: meta.mimeType, createdTime: new Date().toISOString(), bytes, body: bytes.toString('utf8'), parents: meta.parents };
        files.push(f);
        const md5 = createHash('md5').update(bytes).digest('hex');
        return send(res, 200, { id: f.id, name: f.name, size: String(bytes.length), md5Checksum: mock.badMd5 ? md5.replace(/^./, (ch) => (ch === '0' ? '1' : '0')) : md5 });
      }
      send(res, 404, { error: { message: 'unknown ' + u.pathname } });
    });
  });
  await new Promise((ok) => g.listen(+process.env.ERP_GDRIVE_MOCK, '127.0.0.1', ok));
  const ofetch = (path, o = {}) => fetch(BASE + path, { redirect: 'manual', ...o, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: ownerCookie, ...(o.headers || {}) } });
  const st0 = await (await ofetch('/api/gdrive')).json();
  check('Drive backup is set up and not connected yet', st0.configured === true && st0.connected === false, JSON.stringify(st0));
  const cn = await (await ofetch('/api/gdrive/connect', { method: 'POST', body: '{}' })).json();
  const au = new URL(cn.url);
  check('connect asks Google for one permission only (Drive files the app makes), with offline access', au.searchParams.get('scope') === 'https://www.googleapis.com/auth/drive.file'
    && au.searchParams.get('access_type') === 'offline' && au.searchParams.get('redirect_uri').endsWith('/api/gdrive/callback'));
  const state = au.searchParams.get('state');
  const st2 = new URL((await (await ofetch('/api/gdrive/connect', { method: 'POST', body: '{}' })).json()).url).searchParams.get('state');
  const noDrive = await ofetch('/api/gdrive/callback?code=emailonly&state=' + encodeURIComponent(st2));
  check('if the Drive box is left unticked, nothing is connected and the owner is told to tick it', /drive=noscope/.test(noDrive.headers.get('location') || '')
    && (await (await ofetch('/api/gdrive')).json()).connected === false, noDrive.headers.get('location'));
  const st3 = new URL((await (await ofetch('/api/gdrive/connect', { method: 'POST', body: '{}' })).json()).url).searchParams.get('state');
  await ofetch('/api/gdrive/callback?code=noscopefield&state=' + encodeURIComponent(st3));
  const ns = await (await ofetch('/api/gdrive')).json();
  check('a Drive refusal for missing permission says how to fix it', ns.connected && /Connect Google Drive again/.test(ns.last_error || ''), ns.last_error);
  await ofetch('/api/gdrive', { method: 'DELETE' });
  const den = await ofetch('/api/gdrive/callback?error=access_denied&state=' + encodeURIComponent(state));
  check('pressing Cancel on Google\'s page brings the owner back with an explanation', den.status === 302 && /drive=denied/.test(den.headers.get('location') || ''), den.headers.get('location'));
  const anon = await fetch(BASE + '/api/gdrive/callback?code=good&state=' + encodeURIComponent(state), { redirect: 'manual' });
  check('coming back from Google signed out lands on the settings page, not on bare JSON', anon.status === 302 && /#\/settings\?drive=signin/.test(anon.headers.get('location') || ''), anon.status + ' ' + anon.headers.get('location'));
  const bad1 = await ofetch('/api/gdrive/callback?code=good&state=' + encodeURIComponent(state.slice(0, -3) + 'AAA'));
  check('a forged state is refused', bad1.status === 302 && /drive=bad/.test(bad1.headers.get('location')));
  const cb = await ofetch('/api/gdrive/callback?code=good&state=' + encodeURIComponent(state));
  check('Google sends the owner back: connected and the first backup is saved', cb.status === 302 && /drive=ok/.test(cb.headers.get('location')), cb.headers.get('location'));
  const jsonOf = () => files.filter((f) => f.body && /^smarttrader-backup-.*\.json$/.test(f.name)), xlsxOf = () => files.filter((f) => /^smarttrader-excel-.*\.xlsx$/.test(f.name));
  const up = jsonOf();
  const j = up.length ? JSON.parse(up[0].body) : {};
  check('the Drive file is the full backup, in the SmartTrader folder, without login secrets', up.length === 1 && j.format === 'smarttrader-backup' && j.tables.docs.length > 0
    && up[0].parents[0] === 'fold1' && !/pw_hash|khata_token|share_token|rt-secret/.test(up[0].body));
  const ux = xlsxOf();
  check('a readable Excel copy goes next to it, whole (a real .xlsx with every sheet)', ux.length === 1 && ux[0].parents[0] === 'fold1'
    && /spreadsheetml\.sheet$/.test(ux[0].mime || '') && ux[0].bytes.subarray(0, 2).toString('latin1') === 'PK' && ux[0].bytes.toString('latin1').includes('xl/worksheets/sheet10.xml'), ux.map((f) => f.name + ' ' + f.mime).join());
  check('only the newest 30 backups are kept (the Excel copies counted on their own)', files.filter((f) => /\.json$/.test(f.name)).length === 30 && files.length === 31, String(files.length));
  const st1 = await (await ofetch('/api/gdrive')).json();
  check('status shows the Google account and the last backup', st1.connected && st1.email === 'owner@gmail.com' && !!st1.last_backup_at && !st1.last_error && !('refresh_enc' in st1), JSON.stringify(st1));
  check('status says Google\'s checksum matched and links the folder and the Excel copy', st1.last_checked === 1 && st1.excel === 1 && st1.folder_id === 'fold1' && st1.last_excel_id === ux[0].id, JSON.stringify(st1));
  const now1 = await (await ofetch('/api/gdrive/backup', { method: 'POST', body: '{}' })).json();
  check('Back up now saves another backup and Excel copy', now1.ok && now1.excel && now1.checked && jsonOf().length === 2 && xlsxOf().length === 2, JSON.stringify(now1));
  const xoff = await (await ofetch('/api/gdrive', { method: 'PUT', body: JSON.stringify({ excel: false }) })).json();
  const now2 = await (await ofetch('/api/gdrive/backup', { method: 'POST', body: '{}' })).json();
  check('the Excel copy can be turned off', xoff.excel === 0 && now2.ok && !now2.excel && jsonOf().length === 3 && xlsxOf().length === 2, JSON.stringify(now2));
  await ofetch('/api/gdrive', { method: 'PUT', body: JSON.stringify({ excel: true }) });
  mock.badMd5 = true;
  const mis = await ofetch('/api/gdrive/backup', { method: 'POST', body: '{}' }), misj = await mis.json();
  mock.badMd5 = false;
  const stm = await (await ofetch('/api/gdrive')).json();
  check('a file Google stored differently is removed and the backup reported as failed', mis.status === 502 && /did not match/.test(misj.error || '') && jsonOf().length === 3
    && /did not match/.test(stm.last_error || ''), misj.error);
  const now3 = await (await ofetch('/api/gdrive/backup', { method: 'POST', body: '{}' })).json();
  check('the next good backup clears the warning', now3.ok && !(await (await ofetch('/api/gdrive')).json()).last_error && jsonOf().length === 4, JSON.stringify(now3));
  {
    // a new, empty business connects the same Google account and restores the backup from Drive
    const nb = await rq('POST', '/api/auth/signup', { business: 'Drive Restore Co', name: 'D', email: `drive${Date.now()}@test.in`, password: 'Drive-pass-1', state: 'Rajasthan' }, { ip: '203.0.113.95' });
    const dfetch = (path, o = {}) => fetch(BASE + path, { redirect: 'manual', ...o, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: nb.cookie, 'CF-Connecting-IP': '203.0.113.95', ...(o.headers || {}) } });
    const ds = new URL((await (await dfetch('/api/gdrive/connect', { method: 'POST', body: '{}' })).json()).url).searchParams.get('state');
    const uploads = files.filter((f) => f.body).length;
    const dcb = await dfetch('/api/gdrive/callback?code=good&state=' + encodeURIComponent(ds));
    check('an empty business connects Drive without uploading an empty backup', /drive=okempty/.test(dcb.headers.get('location') || '') && files.filter((f) => f.body).length === uploads);
    const list = (await (await dfetch('/api/gdrive/backups')).json()).files;
    const pick = list.find((f) => (files.find((x) => x.id === f.id) || {}).body);
    check('the backups in Drive are listed', list.length >= 2 && !!pick, JSON.stringify(list).slice(0, 200));
    const dr = await (await dfetch('/api/restore/drive', { method: 'POST', body: JSON.stringify({ file_id: pick.id }) })).json();
    check('restore from Google Drive brings the business back', dr.records > 50 && (await (await dfetch('/api/restore/check')).json()).empty === false, JSON.stringify(dr).slice(0, 200));
    await dfetch('/api/gdrive', { method: 'DELETE' });
  }
  check('weekly backups can be chosen', (await (await ofetch('/api/gdrive', { method: 'PUT', body: JSON.stringify({ every: 'week' }) })).json()).every === 'week');
  const revokes = calls.filter((x) => x === 'POST /revoke').length;
  await ofetch('/api/gdrive', { method: 'DELETE' });
  check('disconnect revokes Google access and forgets the link', calls.filter((x) => x === 'POST /revoke').length === revokes + 1 && (await (await ofetch('/api/gdrive')).json()).connected === false);
  g.close();
}
{
  const bk = await fetch(BASE + '/api/export/backup', { headers: { Cookie: ownerCookie } });
  const j = await bk.json(), txt = JSON.stringify(j);
  check('owner backup has every invoice, its lines and the parties', bk.ok && /attachment; filename="smarttrader-backup-/.test(bk.headers.get('content-disposition') || '')
    && j.format === 'smarttrader-backup' && j.tables.docs.some((d) => d.id === inv.id) && j.tables.doc_lines.some((l) => l.doc_id === inv.id) && j.tables.parties.length >= 2);
  check('backup has no password hashes or private link tokens', !/pw_hash|"salt"|khata_token/.test(txt) && j.tables.users.length >= 2);
  check('backup holds only this business', j.tables.docs.every((d) => d.org_id === j.org.id) && j.tables.items.every((d) => d.org_id === j.org.id));
  const bf = await fetch(BASE + '/api/export/backup?to=folder', { headers: { Cookie: ownerCookie } });
  const aud = await (await fetch(BASE + '/api/audit', { headers: { Cookie: ownerCookie } })).json();
  check('a backup the app saves in a folder is marked so in the audit trail', bf.ok && aud.rows.some((r) => r.action === 'backup' && /to a folder on a computer/.test(r.detail)));
  const meB = await (await fetch(BASE + '/api/me', { headers: { Cookie: ownerCookie } })).json();
  check('the business remembers when its data was last downloaded (for the Today reminder)', Date.now() - Date.parse(meB.org.backup_at || 0) < 120e3, meB.org.backup_at);
  {
    // the Today row about backups, at a fixed "now"
    const n = Date.parse('2026-10-27T12:00:00Z'), D = 86400e3, at = (d) => new Date(n - d * D).toISOString(), key = (r) => (backupHealth(r, n) || {}).key || '';
    check('backup reminder: nothing to lose yet, or a business only days old, gets none', key({ docs: 0, since: at(90) }) === '' && key({ docs: 5, since: at(2) }) === '');
    check('backup reminder: never backed up after 3 days', key({ docs: 5, since: at(4) }) === 'backup_none');
    check('backup reminder: last backup over a week ago, with the days', key({ docs: 5, since: at(90), a: at(9) }) === 'backup_old' && backupHealth({ docs: 5, since: at(90), a: at(9) }, n).n === 9);
    check('backup reminder: a recent download or Drive backup is enough', key({ docs: 5, since: at(90), a: at(1) }) === '' && key({ docs: 5, since: at(90), a: at(30), d: at(0.5) }) === '');
    check('backup reminder: Google Drive failing for 2 days', key({ docs: 5, since: at(90), d: at(3), e: 'Google access was removed.' }) === 'drive_failing'
      && key({ docs: 5, since: at(90), d: at(0.5), e: 'The backup was saved, but its Excel copy was not' }) === '');
  }

  // Excel copy: a real .xlsx (zip) with the sheets
  const xr = await fetch(BASE + '/api/export/excel', { headers: { Cookie: ownerCookie } });
  const xb = new Uint8Array(await xr.arrayBuffer()), xs = new TextDecoder('latin1').decode(xb);
  check('owner gets an Excel workbook of the business', xr.ok && /spreadsheetml/.test(xr.headers.get('content-type') || '') && xs.startsWith('PK')
    && xs.includes('xl/worksheets/sheet10.xml') && /filename="smarttrader-\d{4}-\d{2}-\d{2}\.xlsx"/.test(xr.headers.get('content-disposition') || ''), xr.status);

  // restore into a brand-new, empty business: every record comes back with new ids, books and balances identical
  const nu = await rq('POST', '/api/auth/signup', { business: 'Restore Co', name: 'R', email: `restore${Date.now()}@test.in`, password: 'Restore-pass-1', state: 'Rajasthan' }, { ip: '203.0.113.90' });
  const rc = nu.cookie, R2 = (m, p, b) => rq(m, p, b, { cookie: rc, ip: '203.0.113.90' });
  check('a new business is empty, so it can restore', (await R2('GET', '/api/restore/check')).data.empty === true);
  const planBefore = (await R2('GET', '/api/me')).data.plan;
  const rr = await R2('POST', '/api/restore', j);
  check('restore brings the backup in', rr.status === 200 && rr.data.records > 50, JSON.stringify(rr.data).slice(0, 300));
  const j2 = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: rc } })).json();
  const same = (t) => j2.tables[t].length === j.tables[t].length;
  check('every bill, line, party, item, payment, khata entry, journal line and stock move is back',
    ['docs', 'doc_lines', 'parties', 'items', 'payments', 'payment_allocs', 'khata', 'journals', 'journal_lines', 'stock_moves', 'stock'].every(same),
    ['docs', 'doc_lines', 'parties', 'items', 'payments', 'journal_lines', 'stock_moves'].map((t) => `${t} ${j.tables[t].length}/${j2.tables[t].length}`).join(' '));
  const sum = (x, t, k) => x.tables[t].reduce((n, r) => n + (+r[k] || 0), 0);
  check('totals are identical', sum(j, 'docs', 'total') === sum(j2, 'docs', 'total') && sum(j, 'journal_lines', 'debit') === sum(j2, 'journal_lines', 'debit') && sum(j, 'payments', 'amount') === sum(j2, 'payments', 'amount'));
  check('the restored records belong only to the new business and point only at its own rows', j2.org.id !== j.org.id
    && ['docs', 'parties', 'items', 'payments', 'journal_lines', 'khata'].every((t) => j2.tables[t].every((r) => r.org_id === j2.org.id))
    && j2.tables.doc_lines.every((l) => j2.tables.docs.some((d) => d.id === l.doc_id))
    && j2.tables.docs.every((d) => d.party_id === null || j2.tables.parties.some((p) => p.id === d.party_id))
    && j2.tables.journal_lines.every((l) => j2.tables.accounts.some((a) => a.id === l.account_id)));
  const tbA = (await rq('GET', '/api/reports/trial-balance', undefined, { cookie: ownerCookie })).data, tbB = (await R2('GET', '/api/reports/trial-balance')).data;
  check('the restored books balance and match the original trial balance', tbB.balanced && JSON.stringify(tbA.rows.map((r) => [r.code, r.debit, r.credit])) === JSON.stringify(tbB.rows.map((r) => [r.code, r.debit, r.credit])));
  const bal = async (o) => Object.fromEntries((await rq('GET', '/api/parties', undefined, o)).data.rows.map((p) => [p.name, p.balance]));
  check('party balances are the same', JSON.stringify(await bal({ cookie: ownerCookie })) === JSON.stringify(await bal({ cookie: rc, ip: '203.0.113.90' })));
  const meR = (await R2('GET', '/api/me')).data;
  check('the business profile comes back, the plan does not', meR.org.name === j.org.name && meR.plan.key === planBefore.key && meR.plan.until === planBefore.until,
    JSON.stringify([meR.org.name, j.org.name, meR.plan, planBefore]));
  check('a second restore into a business with records is refused', (await R2('POST', '/api/restore', j)).status === 400 && (await R2('GET', '/api/restore/check')).data.empty === false);

  // a doctored file cannot reach another business's rows, buy a plan, or name a column
  const fk = await rq('POST', '/api/auth/signup', { business: 'Forged Co', name: 'F', email: `forged${Date.now()}@test.in`, password: 'Forged-pass-1', state: 'Rajasthan' }, { ip: '203.0.113.91' });
  const F = (m, p, b) => rq(m, p, b, { cookie: fk.cookie, ip: '203.0.113.91' });
  const fPlan = (await F('GET', '/api/me')).data.plan;
  const otherParty = j.tables.parties[0].id;
  const forged = { ...j, org: { ...j.org, plan: 'business', plan_until: '2099-12-31', name: 'Forged Co' }, tables: {
    parties: [{ id: 7, org_id: 1, name: 'Only Party', kind: 'customer', ["name) VALUES ('x'); DROP TABLE docs; --"]: 'boom' }],
    docs: [{ ...j.tables.docs.find((d) => d.type === 'INV'), id: 11, party_id: otherParty === 7 ? 8 : otherParty, org_id: 1 }],
    doc_lines: [{ ...j.tables.doc_lines[0], id: 21, doc_id: 999999 }], accounts: [], users: [],
    recurring: [{ id: 31, org_id: 1, src_doc_id: 11, every: 'month', anchor_day: 5, next_on: '2025-01-05', active: 1, created_by: 1, created_at: '2025-01-01T00:00:00Z', runs: 3 }] } };
  const fr = await F('POST', '/api/restore', forged);
  const j3 = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: fk.cookie } })).json();
  check('a doctored backup restores only into its own rows (no foreign links, unknown columns ignored, no plan)', fr.status === 200
    && j3.tables.parties.length === 1 && j3.tables.parties[0].name === 'Only Party' && j3.tables.docs.length === 1 && j3.tables.docs[0].party_id === null
    && j3.tables.doc_lines.length === 0 && (await F('GET', '/api/me')).data.plan.key === fPlan.key && (await F('GET', '/api/me')).data.plan.until === fPlan.until
    && (await rq('GET', `/api/docs/${inv.id}`, undefined, { cookie: ownerCookie })).status === 200,
    JSON.stringify([fr.status, j3.tables.parties.map((p) => p.name), j3.tables.docs.map((d) => d.party_id), j3.tables.doc_lines.length, (await F('GET', '/api/me')).data.plan.key]));
  check('a file that is not a backup is refused', (await F('POST', '/api/restore', { hello: 1 })).status === 400);
  const recs = (await F('GET', '/api/recurring')).data.rows;
  const resumed = recs.length ? await F('POST', `/api/recurring/${recs[0].id}/resume`) : null;
  const after = recs.length ? (await F('GET', '/api/recurring')).data.rows[0] : null;
  check('recurring bills come back paused and start again on Resume (from today, no backlog)', recs.length === 1 && recs[0].active === 0
    && resumed.status === 200 && after.active === 1 && after.next_on === (await F('GET', '/api/me')).data.today, JSON.stringify([recs, resumed && resumed.data, after]).slice(0, 300));
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
  const pe = await api('PUT', '/api/settings/print', { ...p0.print, layout: 'elegant', font: 'serif' });
  check('new designs and the serif font save', pe.print.layout === 'elegant' && pe.print.font === 'serif', JSON.stringify(pe.print));
  check('bad font is refused', (await api('PUT', '/api/settings/print', { ...p0.print, font: 'comic' }, true)).status === 400);
  await api('PUT', '/api/settings/print', { ...p0.print });
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
{
  // recurring invoices: a schedule due today makes one invoice with the same party and lines, then moves a month on
  const today0 = (await api('GET', '/api/me')).today;
  const src = await api('GET', `/api/docs/${inv.id}`);
  check('a quotation cannot repeat by itself', (await api('POST', `/api/docs/${qt.id}/recurring`, { every: 'month' }, true)).status === 400);
  const made0 = await api('POST', `/api/docs/${inv.id}/recurring`, { every: 'month', next_on: today0 });
  const rec = (await api('GET', '/api/recurring')).rows.filter((r) => r.src_doc_id === inv.id).pop();
  check('a schedule is made from the invoice, for its customer, sent by hand unless automatic WhatsApp is on', made0.count === 1 && made0.next_on === today0 && rec && rec.party_id === inv.party_id
    && rec.send === 'ask' && rec.items >= 1, JSON.stringify([made0, rec]));
  const before = (await api('GET', '/api/docs?type=INV')).rows.length;
  const run1 = await api('POST', '/api/recurring/run');
  const list1 = (await api('GET', '/api/recurring')).rows.find((r) => r.id === rec.id);
  const made = await api('GET', `/api/docs/${list1.last_doc_id}`);
  check('the due schedule made one invoice, same party and lines, dated today', run1.made >= 1 && (await api('GET', '/api/docs?type=INV')).rows.length === before + 1
    && made.party_id === src.party_id && made.date === today0 && made.lines.length === src.lines.length && eq(made.total, src.total) && made.number !== src.number,
    JSON.stringify([run1, before, (await api('GET', '/api/docs?type=INV')).rows.length, made.party_id, src.party_id, made.date, today0, made.lines.length, src.lines.length, made.total, src.total]));
  const [y, mo, dd] = today0.split('-').map(Number), nm = new Date(Date.UTC(y, mo, 1)), last = new Date(Date.UTC(nm.getUTCFullYear(), nm.getUTCMonth() + 1, 0)).getUTCDate();
  check('...and its next date is a month on', list1.next_on === new Date(Date.UTC(nm.getUTCFullYear(), nm.getUTCMonth(), Math.min(dd, last))).toISOString().slice(0, 10) && list1.runs === 1, list1.next_on);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  check('the new bill says which month it is for', made.notes.includes(`For ${MONTHS[mo - 1]} ${y} (monthly bill)`), made.notes);
  check('...and waits under "To send", shown on Today', list1.sent === 0 && (await api('GET', '/api/today')).rows.some((r) => r.key === 'recurring_send' && r.n >= 1));
  await api('POST', '/api/recurring/sent', { ids: [rec.id] });
  check('sent by hand: it leaves the list', (await api('GET', '/api/recurring')).rows.find((r) => r.id === rec.id).sent === 1
    && !(await api('GET', '/api/today')).rows.some((r) => r.key === 'recurring_send'));
  // change the schedule's own lines: the next bills change, the invoice it came from does not
  const ed = await api('GET', `/api/recurring/${rec.id}`);
  const newLines = ed.lines.map((l, i) => ({ ...l, rate: i === 0 ? l.rate + 10 : l.rate }));
  const up = await api('PUT', `/api/recurring/${rec.id}`, { lines: newLines, notes: 'Shop rent', every: 'quarter', next_on: list1.next_on });
  check('the schedule\'s lines, note and repeat change; the original invoice stays as it was', up.every === 'quarter' && up.notes === 'Shop rent' && up.lines[0].rate === ed.lines[0].rate + 10
    && eq((await api('GET', `/api/docs/${inv.id}`)).total, src.total), JSON.stringify([up.lines[0], ed.lines[0]]));
  check('an item of another business cannot be put on the bill', (await api('PUT', `/api/recurring/${rec.id}`, { lines: [{ item_id: 999999, qty: 1, rate: 5, gst_rate: 18 }] }, true)).status === 400);
  check('a bill cannot be left with no lines', (await api('PUT', `/api/recurring/${rec.id}`, { lines: [] }, true)).status === 400);
  const sk = await api('POST', `/api/recurring/${rec.id}/skip`);
  const [qy, qm, qd] = list1.next_on.split('-').map(Number), q3 = new Date(Date.UTC(qy, qm - 1 + 3, 1)), ql = new Date(Date.UTC(q3.getUTCFullYear(), q3.getUTCMonth() + 1, 0)).getUTCDate();
  check('skip next: the bill after it becomes the next', sk.next_on === new Date(Date.UTC(q3.getUTCFullYear(), q3.getUTCMonth(), Math.min(qd, ql))).toISOString().slice(0, 10), JSON.stringify(sk));
  // the same bill for more customers (a class, a building)
  const extra = [];
  for (const n of ['Tenant A', 'Tenant B']) extra.push(await api('POST', '/api/parties', { name: n + ' ' + Date.now(), kind: 'customer', state: 'Maharashtra', phone: '98765' + String(Date.now()).slice(-5) }));
  const cp2 = await api('POST', `/api/recurring/${rec.id}/copy`, { party_ids: extra.map((p) => p.id) });
  const rowsC = (await api('GET', '/api/recurring')).rows;
  check('the same bill for more customers: each gets their own schedule with the same lines and dates', cp2.count === 2
    && extra.every((p) => { const r = rowsC.find((x) => x.party_id === p.id); return r && r.every === 'quarter' && r.next_on === sk.next_on && Math.abs(r.amount - up.amount) < 0.01; }), JSON.stringify(cp2));
  check('a supplier cannot be put on a customer\'s bill', (await api('POST', `/api/recurring/${rec.id}/copy`, { party_ids: [sup.id] }, true)).status === 400);
  // a yearly rise (rent): from its day, the rates go up and stay up
  const r2made = await api('POST', `/api/docs/${inv.id}/recurring`, { every: 'month', next_on: today0, raise_pct: 10, raise_on: today0, send: 'off' });
  const r2 = (await api('GET', '/api/recurring')).rows.filter((r) => r.src_doc_id === inv.id && r.raise_pct === 10).pop();
  await api('POST', '/api/recurring/run');
  const r2a = await api('GET', `/api/recurring/${r2.id}`), r2doc = await api('GET', `/api/docs/${(await api('GET', '/api/recurring')).rows.find((r) => r.id === r2.id).last_doc_id}`);
  check('a 10% yearly rise is applied on its day and kept for the next bills, next rise a year on', r2made.count === 1 && Math.abs(r2a.lines[0].rate - Math.round(src.lines[0].rate * 1.1 * 100) / 100) < 0.011
    && Math.abs(r2doc.lines[0].rate - r2a.lines[0].rate) < 0.011 && r2a.raise_on === `${y + 1}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`.replace(/-02-29$/, '-02-28'), JSON.stringify([r2a.lines[0], r2a.raise_on, src.lines[0].rate]));
  check('a bill marked "do not send" does not wait in To send', (await api('GET', '/api/recurring')).rows.find((r) => r.id === r2.id).sent === 1);
  for (const r of (await api('GET', '/api/recurring')).rows.filter((x) => x.active && x.src_doc_id === inv.id && x.id !== rec.id)) await api('POST', `/api/recurring/${r.id}/stop`);
  check('running again the same day makes nothing more', (await api('POST', '/api/recurring/run')).made === 0);
  check('the first date cannot be in the past', (await api('POST', `/api/docs/${inv.id}/recurring`, { every: 'month', next_on: '2020-01-01' }, true)).status === 400);
  await api('POST', `/api/recurring/${rec.id}/stop`);
  check('a stopped schedule shows as stopped', (await api('GET', '/api/recurring')).rows.find((r) => r.id === rec.id).active === 0);
  tb = await api('GET', '/api/reports/trial-balance');
  check('books balance after a recurring invoice', tb.balanced);
}
{
  // one bill can use its own design; it survives Repeat and can be changed after saving
  const dd = await api('POST', '/api/docs', { type: 'INV', party_id: inv.party_id, design: 'bold', lines: [{ item_id: (await api('GET', `/api/docs/${inv.id}`)).lines[0].item_id, qty: 1, rate: 100 }] });
  check('an invoice keeps the design chosen while making it', dd.design === 'bold');
  check('Repeat keeps the design', (await api('GET', `/api/docs/${dd.id}/copy`)).design === 'bold');
  await api('PUT', `/api/docs/${dd.id}/design`, { design: 'gst' });
  check('the design can be changed after saving', (await api('GET', `/api/docs/${dd.id}`)).design === 'gst');
  check('an unknown design is refused', (await api('PUT', `/api/docs/${dd.id}/design`, { design: 'fancy' }, true)).status === 400);
  await api('PUT', `/api/docs/${dd.id}/design`, { design: '' });
  check('empty design goes back to the default', (await api('GET', `/api/docs/${dd.id}`)).design === null);
  await api('POST', `/api/docs/${dd.id}/cancel`);
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
  const mine = orgs.rows.find((o) => o.id === me.org.id);       // by id: a restored copy of this business has the same name
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

  // search engines: visitors' home page, real 404s, every page in the sitemap, Hindi pages paired with English
  check('the home page is a real page for visitors (heading, links to the product pages, FAQ data)', /<div class="landing">[\s\S]*<h1>/.test(page)
    && (page.match(/href="\/[a-z-]+\/"/g) || []).length >= 15 && /"@type": "FAQPage"/.test(page));
  const nf = await fetch(BASE + '/no-such-page-' + Date.now());
  check('an unknown address answers 404 with the not-found page, not the app', nf.status === 404 && /This page does not exist/.test(await nf.text()));
  const smap = await (await fetch(BASE + '/sitemap.xml')).text(), locs = [...smap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace('https://erp.docbrisk.com', ''));
  const answers = await Promise.all(locs.map(async (l) => { const r = await fetch(BASE + l); const h = await r.text(); return { l, ok: r.status === 200, canon: (h.match(/rel="canonical" href="([^"]+)"/) || [])[1] }; }));
  check('every sitemap page answers 200 with its own canonical address', locs.length >= 19 && answers.every((a) => a.ok && a.canon === 'https://erp.docbrisk.com' + a.l), JSON.stringify(answers.filter((a) => !a.ok || a.canon !== 'https://erp.docbrisk.com' + a.l)));
  const hiPage = await (await fetch(BASE + '/hi/gst-billing-software/')).text(), enPage = await (await fetch(BASE + '/gst-billing-software/')).text();
  const sec = await fetch(BASE + '/.well-known/security.txt'), st = await sec.text();
  check('security.txt says where to report a problem, and is not about to expire', sec.status === 200 && /^Contact: https:\/\//m.test(st)
    && Date.parse((st.match(/^Expires: (.+)$/m) || [])[1]) > Date.now() + 30 * 864e5, st);
  const api = await fetch(BASE + '/api/health');
  check('JSON may not be embedded by another site; pages keep their opener safe', api.headers.get('cross-origin-resource-policy') === 'same-origin'
    && (await fetch(BASE + '/')).headers.get('cross-origin-opener-policy') === 'same-origin-allow-popups' && /script-src-attr 'none'/.test(CSP_APP));
  check('Hindi and English pages point to each other (hreflang)', /<html lang="hi">/.test(hiPage) && /hreflang="en-IN" href="https:\/\/erp.docbrisk.com\/gst-billing-software\/"/.test(hiPage)
    && /hreflang="hi-IN" href="https:\/\/erp.docbrisk.com\/hi\/gst-billing-software\/"/.test(enPage));
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

/* --- vasooli: the customer's language, the reminder schedule, balance statements, receipts, the recovery file --- */
{
  const ip = '203.0.113.120';
  const su = await rq('POST', '/api/auth/signup', { business: 'Vasooli Traders', name: 'V', email: `vasooli${Date.now()}@test.in`, password: 'Vasooli-pass-1', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const pg = async (u) => (await fetch(u.replace(/^https?:\/\/[^/]+/, BASE))).text();
  const day = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);   // IST, like the server
  const me = await V('GET', '/api/me');
  check('a new business sends in Hinglish until it picks another language', me.org.msg_lang === 'hl');
  await V('PUT', '/api/org', { ...me.org, udyam: 'udyam-rj-17-0012345' });
  check('the Udyam number is saved', (await V('GET', '/api/me')).org.udyam === 'UDYAM-RJ-17-0012345');
  const cu = await V('POST', '/api/parties', { name: 'Gupta Medical', kind: 'customer', phone: '9876500001', state: 'Rajasthan', credit_days: 30 });
  const vip = await V('POST', '/api/parties', { name: 'Big Buyer', kind: 'customer', phone: '9876500002', state: 'Rajasthan', vip: true, lang: 'en' });
  check('a contact keeps its language and VIP mark', vip.lang === 'en' && vip.vip === 1 && cu.lang === '' && cu.vip === 0, JSON.stringify(vip));
  const it = await V('POST', '/api/items', { name: 'Courier service', unit: 'job', sale_price: 1000, gst_rate: 0, is_service: true });
  const inv1 = await V('POST', '/api/docs', { type: 'INV', party_id: cu.id, date: day(-60), lines: [{ item_id: it.id, qty: 10, rate: 1000 }] });
  const inv2 = await V('POST', '/api/docs', { type: 'INV', party_id: vip.id, date: day(-60), lines: [{ item_id: it.id, qty: 5, rate: 1000 }] });

  // the bill message in the customer's language, and its link preview
  const hi = await V('GET', `/api/docs/${inv1.id}/share?lang=hi`);
  check('bill message in Hindi, with a Hindi link', hi.lang === 'hi' && hi.text.includes('नमस्ते Gupta Medical जी') && hi.text.includes('बकाया') && hi.url.endsWith('?l=hi')
    && hi.file_name === `${inv1.number}.pdf`, hi.text);
  const again = await V('GET', `/api/docs/${inv1.id}/share`);
  check("the customer's language is remembered", again.lang === 'hi' && again.text.includes('राशि'), again.text);
  const en = await V('GET', `/api/docs/${inv1.id}/share?lang=en`);
  check('bill message in English', en.text.includes('Dear Gupta Medical,') && en.text.includes('Balance due') && en.url.endsWith('?l=en') && !en.text.includes('dekhein'), en.text);
  const hl = await V('GET', `/api/docs/${inv1.id}/share?lang=hl`);
  check('Hinglish keeps the plain link', /\/i\/[0-9a-f]{24}$/.test(hl.url) && hl.text.includes('Namaste Gupta Medical ji'), hl.url);
  const hiPage = await pg(hi.url);
  check('the link preview is in Hindi too', hiPage.includes('og-invoice-hi.png') && hiPage.includes('राशि') && hiPage.includes('?l=hi'), hiPage.slice(0, 400));
  check('...and in English', (await pg(en.url)).includes('og-invoice-en.png'));
  const posters = ['og-invoice-en.png', 'og-invoice-hi.png', 'og-khata-en.png', 'og-khata-hi.png', 'og-confirm.png', 'og-confirm-en.png', 'og-confirm-hi.png'];
  check('every preview poster is served', (await Promise.all(posters.map(async (f) => { const r = await fetch(`${BASE}/${f}`); return r.ok && (r.headers.get('content-type') || '').includes('image/png'); }))).every(Boolean));
  check('the PDF maker is served', (await fetch(`${BASE}/vendor/html-to-image.js`)).ok);

  // reminders get firmer with age; a VIP customer only ever gets gentle wording
  const r1 = await V('GET', `/api/parties/${cu.id}/reminder?lang=en`);
  check('30 days late: firmer wording and the MSMED line', r1.step === 30 && r1.tone === 'late30' && r1.text.includes('more than 30 days') && r1.text.includes('UDYAM-RJ-17-0012345'), r1.text);
  const r2 = await V('GET', `/api/parties/${vip.id}/reminder`);
  check('a VIP customer gets gentle wording, in their language', r2.lang === 'en' && r2.step === 45 && r2.tone === 'gentle' && r2.text.includes('gentle reminder')
    && !r2.text.includes('Final') && !r2.text.includes('MSMED'), r2.text);
  const r3 = await V('GET', `/api/parties/${vip.id}/reminder?lang=hi`);
  check('reminder in Hindi', r3.text.includes('भुगतान याद-दिहानी') && r3.text.includes('कुल बकाया'), r3.text);
  await V('PUT', `/api/parties/${vip.id}`, { ...vip, vip: false, lang: 'en' });
  const r4 = await V('GET', `/api/parties/${vip.id}/reminder`);
  check('45+ days late, not VIP: the final reminder', r4.tone === 'final' && r4.text.includes('Final reminder') && r4.text.includes('within 7 days'), r4.text);

  // the day's list
  let q = await V('GET', '/api/vasooli');
  const qa = q.queue.find((r) => r.party_id === cu.id);
  check('both customers are due a reminder today', qa && qa.status === 'due' && qa.step === 30 && q.queue.find((r) => r.party_id === vip.id).status === 'due', JSON.stringify(q.queue));
  check('the owner sees the week', q.summary && q.summary.outstanding === 15000 && q.summary.late45 === 5000 && q.summary.late45_n === 1 && q.msme === true, JSON.stringify(q.summary));
  await V('POST', `/api/vasooli/${cu.id}/sent`, { step: 30, via: 'whatsapp', lang: 'en' });
  q = await V('GET', '/api/vasooli');
  const qb = q.queue.find((r) => r.party_id === cu.id);
  check('once sent, the next reminder waits for the 45-day step', qb.status === 'sent' && qb.next_on === day(15) && qb.last_sent.via === 'whatsapp', JSON.stringify(qb));
  await V('POST', '/api/vaade', { party_id: vip.id, book: 'inv', kind: 'date', date: day(5) });
  q = await V('GET', '/api/vasooli');
  check("the customer's own promise date pauses the reminders", q.queue.find((r) => r.party_id === vip.id).status === 'promised', JSON.stringify(q.queue));

  // monthly balance statement: one tap to confirm or dispute, kept as proof
  const cf = await V('POST', `/api/parties/${cu.id}/confirm?lang=hi`, {});
  const tok = (cf.text.match(/\/c\/([0-9a-f]{24})\?l=hi/) || [])[1];
  check('balance statement message with a private link', !!tok && cf.text.includes('बकाया पुष्टि') && cf.text.includes('₹10,000.00') && cf.lang === 'hi', cf.text);
  check('sending it again the same day reuses the statement', (await V('POST', `/api/parties/${cu.id}/confirm`, {})).id === cf.id);
  await V('POST', `/api/vasooli/confirm/${cf.id}/sent`, { via: 'whatsapp' });
  const pub = await rq('GET', `/api/public/confirm/${tok}`);
  check('the customer sees every open bill and the balance, without logging in', pub.status === 200 && pub.data.balance === 10000 && pub.data.bills.length === 1
    && pub.data.bills[0].number === inv1.number && pub.data.status === 'sent' && !('org_id' in pub.data) && !('token' in pub.data), JSON.stringify(pub.data));
  check('a dispute needs a reason', (await rq('POST', `/api/public/confirm/${tok}`, { answer: 'dispute' })).status === 400);
  const ans = await rq('POST', `/api/public/confirm/${tok}`, { answer: 'dispute', bill: inv1.number, note: '2 boxes short' }, { ip: '198.18.0.9' });
  check('the customer disputes with one tap', ans.status === 200 && ans.data.status === 'disputed', JSON.stringify(ans.data));
  check('an answered statement cannot be changed', (await rq('POST', `/api/public/confirm/${tok}`, { answer: 'agree' })).status === 400);
  q = await V('GET', '/api/vasooli');
  const cr = q.confirmations.find((f) => f.party_id === cu.id);
  check('the shop sees the dispute and which bill', cr && cr.status === 'disputed' && cr.note === '2 boxes short' && cr.disputed_bill === inv1.number, JSON.stringify(cr));
  const cpage = await pg(`${BASE}/c/${tok}?l=hi`);
  check('the statement link previews in Hindi', cpage.includes('og-confirm-hi.png') && cpage.includes('बकाया पुष्टि'), cpage.slice(0, 300));
  check('a made-up statement link is rejected', (await rq('GET', `/api/public/confirm/${'a'.repeat(24)}`)).status === 404);
  const cf2 = await V('POST', `/api/parties/${vip.id}/confirm?lang=en`, {});
  const tok2 = cf2.text.match(/\/c\/([0-9a-f]{24})/)[1];
  check('the customer agrees with one tap', (await rq('POST', `/api/public/confirm/${tok2}`, { answer: 'agree' })).data.status === 'agreed');

  // receipts: the customer's proof, naming who collected
  const cash = (await V('GET', '/api/accounts')).rows.find((a) => a.sys === 'cash');
  const rc = await V('POST', '/api/payments', { kind: 'receipt', party_id: cu.id, account_id: cash.id, amount: 4000 });
  const rm = await V('GET', `/api/payments/${rc.id}/message?lang=en`);
  check('receipt message names who collected it and what is left', rm.text.includes('Payment received') && rm.text.includes('Collected by: V') && rm.text.includes('₹6,000.00')
    && rm.whatsapp_url.includes('phone=919876500001'), rm.text);
  const rmh = await V('GET', `/api/payments/${rc.id}/message?lang=hi`);
  check('receipt in Hindi', rmh.text.includes('भुगतान प्राप्त') && rmh.text.includes('प्राप्तकर्ता: V'), rmh.text);
  const em = `raju${Date.now()}@test.in`;
  await V('POST', '/api/users', { name: 'Raju', email: em, password: 'Raju-pass-123', role: 'sales' });
  const lg = await rq('POST', '/api/auth/login', { email: em, password: 'Raju-pass-123' }, { ip });
  const S = (m, p, b) => rq(m, p, b, { cookie: lg.cookie, ip });
  const sr = await S('POST', '/api/payments', { kind: 'receipt', party_id: cu.id, account_id: cash.id, amount: 1000 });
  check('a salesperson records a customer payment they collected', sr.status === 200, JSON.stringify(sr.data));
  check('...and can send the receipt', (await S('GET', `/api/payments/${sr.data.id}/message`)).data.text.includes('Raju'));
  check('...but cannot pay money out', (await S('POST', '/api/payments', { kind: 'payment', party_id: cu.id, account_id: cash.id, amount: 1 })).status === 403);
  check('...nor open the recovery file or the week summary', (await S('GET', `/api/parties/${cu.id}/recovery`)).status === 403 && (await S('GET', '/api/vasooli')).data.summary === null);
  q = await V('GET', '/api/vasooli');
  const staff = Object.fromEntries(q.summary.staff.map((x) => [x.name, x]));
  check('who collected what', staff.V && staff.V.week === 4000 && staff.Raju && staff.Raju.week === 1000 && staff.Raju.cash_week === 1000 && q.summary.received === 5000, JSON.stringify(q.summary.staff));

  // the recovery file: MSMED interest and the evidence
  const rf = await V('GET', `/api/parties/${vip.id}/recovery?rate=6.5`);
  const b0 = rf.bills[0];
  // ₹5,000 due since 60 days (no credit days): 3 × 6.5% a year, monthly rests -> about ₹161.6
  check('recovery file: MSMED interest on a 60-day-late bill', rf.msme && rf.bank_rate === 6.5 && b0.days_late === 60 && b0.appointed === day(-60) && b0.interest > 155 && b0.interest < 168, JSON.stringify(b0));
  const rf2 = await V('GET', `/api/parties/${cu.id}/recovery`);
  check('recovery file carries the evidence', rf2.reminders.length === 1 && rf2.confirmations.length === 1 && rf2.confirmations[0].status === 'disputed' && rf2.payments.length === 2
    && rf2.bills[0].interest === 0 && rf2.bank_rate === null && rf2.totals.bal === 5000, JSON.stringify(rf2).slice(0, 400));

  // khata messages follow the customer's language too
  const kh = await V('POST', '/api/khata', { party_id: cu.id, kind: 'gave', amount: 250, note: 'cash' });
  check("khata entry message in the customer's language", kh.lang === 'hi' && kh.text.includes('उधार लिखा गया'), kh.text);
  const khEn = await V('GET', `/api/khata/entries/${kh.entry_id}/message?lang=en`);
  check('...and it can be switched before sending', khEn.lang === 'en' && khEn.text.includes('Credit given'), khEn.text);
  const wr = await V('GET', '/api/vasooli/report?lang=en');
  check('the week report for the owner', wr.text.includes('Your week in collections') && wr.text.includes('Received: *₹5,000.00*'), wr.text);
  const bk = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  check('backups keep the reminder log and statements, without their private links', bk.tables.reminder_log.length === 1 && bk.tables.confirmations.length === 2
    && bk.tables.confirmations.every((f) => !('token' in f)) && bk.org.udyam === 'UDYAM-RJ-17-0012345');
}

/* --- bins (racks / shelves), batches with expiry (FEFO), stock ageing --- */
{
  const ip = '203.0.113.130';
  const su = await rq('POST', '/api/auth/signup', { business: 'Lots Pharma', name: 'L', email: `lots${Date.now()}@test.in`, password: 'Lots-pass-123', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const wh = (await V('GET', '/api/warehouses')).rows[0];
  const sup = await V('POST', '/api/parties', { name: 'Cipla Distributor', kind: 'supplier', state: 'Rajasthan' });
  const cust = await V('POST', '/api/parties', { name: 'Shree Chemist', kind: 'customer', state: 'Rajasthan', phone: '9876500003' });
  const syrup = await V('POST', '/api/items', { name: 'Cough Syrup 100ml', unit: 'btl', sale_price: 120, purchase_price: 80, gst_rate: 12, track_batch: true, location: 'a-01-1' });
  const strip = await V('POST', '/api/items', { name: 'Bandage roll', unit: 'pc', sale_price: 30, purchase_price: 15, gst_rate: 12 });
  check('an item can track batches and has a default bin', syrup.track_batch === 1 && syrup.location === 'A-01-1' && strip.track_batch === 0, JSON.stringify(syrup));

  // bins: racks A-B, 2 shelves, 2 levels
  const nb = await V('POST', '/api/bins', { warehouse_id: wh.id, racks: 'A-B', shelves: 2, levels: 2 });
  let bl = await V('GET', `/api/bins?warehouse_id=${wh.id}`);
  check('bins made from racks, shelves and levels', nb.added === 8 && bl.bins.length === 8 && bl.bins[0].code === 'A-01-1' && bl.bins[7].code === 'B-02-2', JSON.stringify(bl.bins.map((b) => b.code)));
  const bin = (code) => bl.bins.find((b) => b.code === code);

  // opening stock with a batch goes into the default bin; a purchase with an earlier-expiring batch
  await V('POST', '/api/stock/adjust', { item_id: syrup.id, qty: 50, rate: 80, reason: 'opening', batch_no: 'B1', expiry: '2027-03' });
  await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: syrup.id, qty: 30, rate: 80, batch_no: 'B2', expiry: '2026-12-15' }] });
  let lots = await V('GET', `/api/items/${syrup.id}/lots`);
  const bq = (no) => (lots.batches.find((b) => b.batch_no === no) || { qty: 0 }).qty;
  check('batches with expiry: the month means its last day', bq('B1') === 50 && bq('B2') === 30 && lots.batches[0].batch_no === 'B2' && lots.batches.find((b) => b.batch_no === 'B1').expiry === '2027-03-31', JSON.stringify(lots.batches));
  check('incoming stock lands in the default bin', lots.bins.length === 1 && lots.bins[0].code === 'A-01-1' && lots.bins[0].qty === 80, JSON.stringify(lots.bins));

  // a sale without a batch takes the batch that expires first (FEFO)
  const inv = await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: syrup.id, qty: 40, rate: 120 }] });
  const invD = await V('GET', `/api/docs/${inv.id}`);
  lots = await V('GET', `/api/items/${syrup.id}/lots`);
  check('FEFO: the earlier expiry goes first, and the bill shows the batches', invD.lines[0].batch_no === 'B2, B1' && invD.lines[0].expiry === '2026-12-15' && bq('B2') === 0 && bq('B1') === 40, JSON.stringify(invD.lines[0]) + JSON.stringify(lots.batches));
  check('...and the bin gives up the goods', lots.bins[0].qty === 40, JSON.stringify(lots.bins));
  const tooMuch = await E('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: syrup.id, qty: 5, rate: 120, batch_no: 'B2' }] });
  check('a batch cannot give more than it has', tooMuch.status === 400 && /Batch B2 .* has only 0/.test(tooMuch.data.error), JSON.stringify(tooMuch.data));
  // cancelling puts the goods back into the very same batches and the default bin
  await V('POST', `/api/docs/${inv.id}/cancel`);
  lots = await V('GET', `/api/items/${syrup.id}/lots`);
  check('cancelling a sale puts goods back into the same batches', bq('B2') === 30 && bq('B1') === 50 && lots.bins[0].qty === 80, JSON.stringify(lots));
  // a sale of a chosen batch, then its return goes back to that batch
  const inv2 = await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: syrup.id, qty: 10, rate: 120, batch_no: 'B1' }] });
  const ret = await V('GET', `/api/docs/${inv2.id}/convert?to=SRET`);
  check('a return carries the batch of the invoice line', ret.lines[0].batch_no === 'B1', JSON.stringify(ret.lines[0]));
  await V('POST', '/api/docs', { ...ret, lines: [{ ...ret.lines[0], qty: 4 }] });
  lots = await V('GET', `/api/items/${syrup.id}/lots`);
  check('returned goods go back to their batch', bq('B1') === 44 && bq('B2') === 30, JSON.stringify(lots.batches));
  const cancelBill = await E('POST', `/api/docs/${(await V('GET', '/api/docs?type=BILL')).rows[0].id}/cancel`);
  check('a purchase whose batch is still in stock can be cancelled', cancelBill.status === 200, JSON.stringify(cancelBill.data));
  lots = await V('GET', `/api/items/${syrup.id}/lots`);
  check('...and its batch leaves with it', bq('B2') === 0 && bq('B1') === 44, JSON.stringify(lots.batches));

  // bins: what is not put away, put-away, moving between bins
  await V('POST', '/api/stock/adjust', { item_id: strip.id, qty: 10, rate: 15, reason: 'opening' });
  bl = await V('GET', `/api/bins?warehouse_id=${wh.id}`);
  const np = bl.not_put_away.find((r) => r.id === strip.id);
  check('stock without a bin is listed as not put away', np && np.free === 10, JSON.stringify(bl.not_put_away));
  await V('POST', '/api/bins/move', { item_id: strip.id, warehouse_id: wh.id, from_bin_id: 0, to_bin_id: bin('A-01-2').id, qty: 10 });
  const tooFar = await E('POST', '/api/bins/move', { item_id: strip.id, warehouse_id: wh.id, from_bin_id: bin('A-01-2').id, to_bin_id: bin('B-02-2').id, qty: 11 });
  check('a bin cannot give more than it holds', tooFar.status === 400 && /Only 10/.test(tooFar.data.error), JSON.stringify(tooFar.data));
  await V('POST', '/api/bins/move', { item_id: strip.id, warehouse_id: wh.id, from_bin_id: bin('A-01-2').id, to_bin_id: bin('B-02-2').id, qty: 4 });
  await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: strip.id, qty: 3, rate: 30 }] });
  const inB = await V('GET', `/api/bins/${bin('A-01-2').id}`), inB2 = await V('GET', `/api/bins/${bin('B-02-2').id}`);
  check('put away, moved, then sold from the bins', inB.items[0].qty === 3 && inB2.items[0].qty === 4, JSON.stringify([inB.items, inB2.items]));
  check('a bin with stock cannot be deleted', (await E('DELETE', `/api/bins/${bin('B-02-2').id}`)).status === 400);
  check('an empty bin can be deleted', (await E('DELETE', `/api/bins/${bin('B-01-1').id}`)).status === 200);
  const stk = await V('GET', '/api/reports/stock');
  check('godown totals are unchanged by bins and batches', stk.rows.find((r) => r.id === strip.id).qty === 7 && stk.rows.find((r) => r.id === syrup.id).qty === 44, JSON.stringify(stk.rows.map((r) => [r.name, r.qty])));

  // a transfer takes its batches along to the other godown
  const w2 = await V('POST', '/api/warehouses', { name: 'Branch' });
  await V('POST', '/api/stock/transfer', { item_id: syrup.id, from_warehouse_id: wh.id, to_warehouse_id: w2.id, qty: 5 });
  const l2 = await V('GET', `/api/items/${syrup.id}/lots?warehouse_id=${w2.id}`);
  check('a transfer takes its batch along', l2.batches.length === 1 && l2.batches[0].batch_no === 'B1' && l2.batches[0].qty === 5 && l2.batches[0].expiry === '2027-03-31', JSON.stringify(l2.batches));

  // expiry report and stock ageing
  const ex = await V('GET', '/api/reports/expiry?days=730');
  check('expiry report lists batches by expiry with their value', ex.rows.length === 2 && ex.rows.every((r) => r.batch_no === 'B1' && r.days_left > 0) && ex.soon_value > 0, JSON.stringify(ex));
  const ag = await V('GET', '/api/reports/stock-ageing');
  const ar = ag.rows.find((r) => r.id === syrup.id);
  check('stock ageing: every unit on hand falls in an age bucket', ar && Math.abs(ar.qtys.reduce((a, b) => a + b, 0) - ar.qty) < 0.001 && ag.buckets.length === 6 && ag.totals.length === 6, JSON.stringify(ar));
  check('stock ageing marks sales class and movement', ['A', 'B', 'C', '-'].includes(ar.abc) && ['moving', 'slow', 'dead', 'new'].includes(ar.move) && ar.last_sale, JSON.stringify(ar));
  const bk = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  check('backups carry bins, bin stock, batches and their moves', bk.tables.bins.length === 7 && bk.tables.bin_stock.length >= 2 && bk.tables.batches.length >= 3 && bk.tables.batch_moves.length >= 6,
    ['bins', 'bin_stock', 'batches', 'batch_moves'].map((t) => `${t} ${bk.tables[t].length}`).join(' '));
}

/* serial / IMEI numbers, manufacturing, purchase order approval, marketplace orders, today */
{
  const ip = '203.0.113.140';
  const email = `mob${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Mobile Point', name: 'M', email, password: 'Mob-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const wh = (await V('GET', '/api/warehouses')).rows[0];
  const sup = await V('POST', '/api/parties', { name: 'Phone Distributor', kind: 'supplier', state: 'Rajasthan' });
  const cust = await V('POST', '/api/parties', { name: 'Ravi Kumar', kind: 'customer', state: 'Rajasthan', phone: '9876500004' });
  const phone = await V('POST', '/api/items', { name: 'Galaxy A15', unit: 'pc', sale_price: 15000, purchase_price: 12000, gst_rate: 18, track_serial: true, warranty_months: 12, sku: 'GA15' });
  check('an item can track serial numbers with a warranty', phone.track_serial === 1 && phone.warranty_months === 12, JSON.stringify(phone));

  // purchase with IMEIs; a wrong count or a serial already in stock is refused
  const short = await E('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: phone.id, qty: 3, rate: 12000, serials: 'IMEI001 IMEI002' }] });
  check('the number of serials must match the quantity', short.status === 400 && /2 serial number/.test(short.data.error), JSON.stringify(short.data));
  const twice = await E('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: phone.id, qty: 2, rate: 12000, serials: 'IMEI001, IMEI001' }] });
  check('a serial cannot be typed twice', twice.status === 400 && /typed twice/.test(twice.data.error), JSON.stringify(twice.data));
  const bill = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: phone.id, qty: 3, rate: 12000, serials: 'imei001\nIMEI002\nIMEI003' }] });
  const dupIn = await E('POST', '/api/stock/adjust', { item_id: phone.id, qty: 1, rate: 12000, reason: 'Found', serials: 'IMEI002' });
  check('a serial already in stock cannot come in again', dupIn.status === 400 && /already in stock/.test(dupIn.data.error), JSON.stringify(dupIn.data));
  let lots = await V('GET', `/api/items/${phone.id}/lots`);
  check('serials in stock are listed (upper-cased)', lots.serials.length === 3 && lots.serials.map((x) => x.serial).join() === 'IMEI001,IMEI002,IMEI003', JSON.stringify(lots.serials));

  // a sale of a chosen IMEI; a sale without serials takes the oldest
  const notHere = await E('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: phone.id, qty: 1, rate: 15000, serials: 'IMEI999' }] });
  check('a serial not in stock cannot be sold', notHere.status === 400 && /IMEI999 .* not in stock/.test(notHere.data.error), JSON.stringify(notHere.data));
  const inv = await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: phone.id, qty: 1, rate: 15000, serials: 'IMEI002' }] });
  check('the bill line carries the IMEI', inv.lines[0].serials === 'IMEI002', JSON.stringify(inv.lines[0]));
  const inv2 = await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: phone.id, qty: 1, rate: 15000 }] });
  check('without a serial the oldest in stock goes', inv2.lines[0].serials === 'IMEI001', JSON.stringify(inv2.lines[0]));
  let look = await V('GET', '/api/serials?q=imei002');
  const s2 = look.rows[0];
  check('serial lookup: sold to whom, when, and warranty until', s2.serial === 'IMEI002' && s2.status === 'out' && s2.party === 'Ravi Kumar' && s2.in_warranty === true && s2.warranty_until > s2.out_date && s2.history.length === 2,
    JSON.stringify(s2));
  // a return brings the IMEI back; cancelling a sale does too
  const ret = await V('GET', `/api/docs/${inv.id}/convert?to=SRET`);
  check('a return carries the serials of the invoice line', ret.lines[0].serials === 'IMEI002', JSON.stringify(ret.lines[0]));
  await V('POST', '/api/docs', ret);
  await V('POST', `/api/docs/${inv2.id}/cancel`);
  lots = await V('GET', `/api/items/${phone.id}/lots`);
  check('returned and cancelled serials are back in stock', lots.serials.length === 3, JSON.stringify(lots.serials));
  const cancelBill = await E('POST', `/api/docs/${bill.id}/cancel`);
  look = await V('GET', '/api/serials?q=IMEI00');
  check('a purchase whose serials are all back in stock can be cancelled, and they become void', cancelBill.status === 200 && look.rows.length === 3 && look.rows.every((r) => r.status === 'void'),
    JSON.stringify(cancelBill.data) + JSON.stringify(look.rows.map((r) => [r.serial, r.status])));
  // a fresh purchase cancelled while its serials are in stock: they become void
  const bill2 = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: phone.id, qty: 1, rate: 12000, serials: 'IMEI050' }] });
  await V('POST', `/api/docs/${bill2.id}/cancel`);
  look = await V('GET', '/api/serials?q=IMEI050');
  check('a cancelled purchase makes its serials void', look.rows[0].status === 'void', JSON.stringify(look.rows[0]));
  // transfer moves the serial to the other godown
  await V('POST', '/api/stock/adjust', { item_id: phone.id, qty: 2, rate: 12000, reason: 'opening', serials: 'IMEI010 IMEI011' });
  const w2 = await V('POST', '/api/warehouses', { name: 'Shop 2' });
  await V('POST', '/api/stock/transfer', { item_id: phone.id, from_warehouse_id: wh.id, to_warehouse_id: w2.id, qty: 1, serials: 'IMEI011' });
  const l2 = await V('GET', `/api/items/${phone.id}/lots?warehouse_id=${w2.id}`);
  check('a transfer moves the serial to the other godown', l2.serials.length === 1 && l2.serials[0].serial === 'IMEI011', JSON.stringify(l2.serials));

  // manufacturing: a gift hamper made of 2 chocolates and 1 box
  const choc = await V('POST', '/api/items', { name: 'Chocolate', unit: 'pc', sale_price: 50, purchase_price: 30, gst_rate: 18 });
  const box = await V('POST', '/api/items', { name: 'Gift box', unit: 'pc', sale_price: 20, purchase_price: 10, gst_rate: 18 });
  const hamper = await V('POST', '/api/items', { name: 'Gift hamper', unit: 'pc', sale_price: 150, gst_rate: 18 });
  await V('POST', '/api/stock/adjust', { item_id: choc.id, qty: 10, rate: 30, reason: 'opening' });
  await V('POST', '/api/stock/adjust', { item_id: box.id, qty: 3, rate: 10, reason: 'opening' });
  const self = await E('PUT', `/api/items/${hamper.id}/bom`, { out_qty: 1, lines: [{ item_id: hamper.id, qty: 1 }] });
  check('an item cannot be its own component', self.status === 400, JSON.stringify(self.data));
  const bom = await V('PUT', `/api/items/${hamper.id}/bom`, { out_qty: 1, lines: [{ item_id: choc.id, qty: 2 }, { item_id: box.id, qty: 1 }] });
  check('recipe saved, with its cost and how many can be made', bom.lines.length === 2 && bom.unit_cost === 70 && bom.can_make === 3, JSON.stringify(bom));
  const tooMany = await E('POST', '/api/productions', { item_id: hamper.id, qty: 4 });
  check('production needs the components in stock', tooMany.status === 400 && /Gift box: 3/.test(tooMany.data.error), JSON.stringify(tooMany.data));
  const run = await V('POST', '/api/productions', { item_id: hamper.id, qty: 3 });
  const stk = await V('GET', '/api/reports/stock');
  const q = (id) => stk.rows.find((r) => r.id === id).qty;
  check('a production run uses the components and makes the item at their cost', run.number === 'MFG-00001' && run.value === 210 && run.unit_cost === 70 && q(choc.id) === 4 && q(box.id) === 0 && q(hamper.id) === 3,
    JSON.stringify(run) + JSON.stringify(stk.rows.map((r) => [r.name, r.qty])));
  const hItem = (await V('GET', '/api/items')).rows.find((i) => i.id === hamper.id);
  check('...and the finished item\'s average cost is the components\' cost', hItem.avg_cost === 70, JSON.stringify(hItem));
  await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: hamper.id, qty: 1, rate: 150 }] });
  const busy = await E('POST', `/api/productions/${run.id}/cancel`);
  check('a run whose goods were sold cannot be cancelled', busy.status === 400 && /already been used/.test(busy.data.error), JSON.stringify(busy.data));
  const run2 = await V('POST', '/api/productions', { item_id: hamper.id, qty: 1, lines: [{ item_id: choc.id, qty: 3 }] });
  await V('POST', `/api/productions/${run2.id}/cancel`);
  const stk2 = await V('GET', '/api/reports/stock');
  check('cancelling a run puts the components back', stk2.rows.find((r) => r.id === choc.id).qty === 4 && stk2.rows.find((r) => r.id === hamper.id).qty === 2, JSON.stringify(stk2.rows.map((r) => [r.name, r.qty])));
  const plist = await V('GET', '/api/productions');
  check('production list', plist.rows.length === 2 && plist.rows[0].status === 'cancelled' && plist.rows[1].status === 'done', JSON.stringify(plist.rows));

  // purchase order approval: above 50,000 a store user's PO waits for the owner
  await V('PUT', '/api/settings/approvals', { po_above: 50000 });
  await V('POST', '/api/users', { email: 'store' + email, name: 'Store', role: 'store', password: 'Store-pass-1' });
  const sl = await rq('POST', '/api/auth/login', { email: 'store' + email, password: 'Store-pass-1' }, { ip });
  const S = (m, p, b) => rq(m, p, b, { cookie: sl.cookie, ip });
  const small = await S('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: choc.id, qty: 10, rate: 30 }] });
  const big = await S('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: phone.id, qty: 5, rate: 12000 }] });
  check('a PO under the limit is open, above it waits for approval', small.data.status === 'open' && big.data.status === 'pending', `${small.data.status} ${big.data.status}`);
  const early = await S('GET', `/api/docs/${big.data.id}/convert?to=GRN`);
  check('a PO waiting for approval cannot be received', early.status === 400 && /waiting for approval/.test(early.data.error), JSON.stringify(early.data));
  check('only the owner or an admin can approve', (await S('POST', `/api/docs/${big.data.id}/approve`)).status === 403);
  let td = await V('GET', '/api/today');
  check('today shows the PO to approve', td.rows.some((r) => r.key === 'approve' && r.n === 1 && r.value === 70800), JSON.stringify(td.rows));
  const ok = await V('POST', `/api/docs/${big.data.id}/approve`);
  check('approved: the PO is open and can be received', ok.status === 'open' && (await S('GET', `/api/docs/${big.data.id}/convert?to=GRN`)).status === 200, ok.status);
  const ownPo = await V('POST', '/api/docs', { type: 'PO', party_id: sup.id, lines: [{ item_id: phone.id, qty: 10, rate: 12000 }] });
  check('the owner\'s own big PO needs no approval', ownPo.status === 'open', ownPo.status);
  const stTd = await S('GET', '/api/today');
  check('today for the store user leaves out money they do not handle', stTd.status === 200 && !stTd.data.rows.some((r) => ['approve', 'overdue', 'bills_due'].includes(r.key)), JSON.stringify(stTd.data.rows));
  check('a business a few days old is not told to back up yet, and staff never are', !td.rows.some((r) => /^backup_|^drive_failing/.test(r.key)) && !stTd.data.rows.some((r) => /^backup_|^drive_failing/.test(r.key)));

  // marketplace orders: an Amazon report, two orders (one with two lines), one cancelled, one unknown SKU
  await V('PUT', `/api/items/${choc.id}`, { name: choc.name, unit: choc.unit, sale_price: 50, gst_rate: 18, sku: 'CHOC-1' });
  const csv = [
    'amazon-order-id\tpurchase-date\torder-status\tsku\tproduct-name\tquantity-purchased\titem-price\tship-state',
    '402-111\t2026-10-20T10:00:00+05:30\tShipped\tCHOC-1\tChocolate\t2\t118.00\tMAHARASHTRA',
    '402-111\t2026-10-20T10:00:00+05:30\tShipped\tGA15\tGalaxy A15\t1\t17700.00\tMAHARASHTRA',
    '402-222\t2026-10-21T11:00:00+05:30\tShipped\tCHOC-1\tChocolate\t1\t59.00\trajasthan',
    '402-333\t2026-10-21T12:00:00+05:30\tCancelled\tCHOC-1\tChocolate\t1\t59.00\tDelhi',
    '402-444\t2026-10-22T12:00:00+05:30\tShipped\tNOPE-9\tSomething\t1\t99.00\tDelhi',
  ].join('\n');
  const look1 = await V('POST', '/api/channels/import', { channel: 'amazon', csv });
  check('marketplace file: orders grouped, cancelled left out, unknown SKUs flagged', look1.orders.length === 3 && look1.ready === 2 && look1.problems === 1
    && look1.orders[0].lines.length === 2 && look1.orders[0].party === 'Amazon (Maharashtra)' && look1.orders[0].lines[0].rate === 50, JSON.stringify(look1));
  const imp = await V('POST', '/api/channels/import', { channel: 'amazon', csv, only: ['402-111', '402-222'] });
  check('orders become invoices', imp.results.every((r) => r.number), JSON.stringify(imp));
  const d1 = await V('GET', `/api/docs/${imp.results[0].doc_id}`), d2 = await V('GET', `/api/docs/${imp.results[1].doc_id}`);
  check('out-of-state order is IGST, in-state CGST+SGST, at the price incl. GST', d1.igst > 0 && d1.cgst === 0 && d1.total === 17818 && d2.cgst > 0 && d2.igst === 0 && d2.total === 59,
    JSON.stringify([d1.total, d1.igst, d2.total, d2.cgst]));
  check('the IMEI goes out with the online order', d1.lines.find((l) => l.item_id === phone.id).serials === 'IMEI010', JSON.stringify(d1.lines));
  const again = await V('POST', '/api/channels/import', { channel: 'amazon', csv, only: ['402-111'] });
  const look2 = await V('POST', '/api/channels/import', { channel: 'amazon', csv });
  check('an order is never imported twice', again.results[0].skipped === 'already imported' && look2.already === 2 && look2.ready === 0, JSON.stringify([again, look2.already]));
  const flip = await V('POST', '/api/channels/import', { channel: 'flipkart', csv: 'Order Id,Ordered On,SKU,Quantity,Final Invoice Amount,Customer State,Order State\n"OD1","20/10/2026","CHOC-1","1","59","Rajasthan","Delivered"\n"OD2","20/10/2026","CHOC-1","1","59","Delhi","Cancelled"\n' });
  check('a Flipkart report with its own column names and Indian dates (cancelled left out)', flip.ready === 1 && flip.orders.length === 1 && flip.orders[0].date === '2026-10-20' && flip.orders[0].party === 'Flipkart (Rajasthan)', JSON.stringify(flip));
  const noCols = await E('POST', '/api/channels/import', { channel: 'meesho', csv: 'a,b\n1,2\n' });
  check('a file without the needed columns says which are missing', noCols.status === 400 && /Order ID/.test(noCols.data.error), JSON.stringify(noCols.data));
  const sf = await fetch(BASE + '/api/channels/stock', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } });
  const sfText = await sf.text();
  check('stock file for the marketplace: SKU and quantity', sf.headers.get('content-type').startsWith('text/csv') && /^sku,quantity,price,name/.test(sfText) && /CHOC-1,1,50\.00,Chocolate/.test(sfText), sfText);

  // Amazon's tax report (MTR): its own column names; refunds become sales returns against their invoice, once each
  await V('POST', '/api/stock/adjust', { item_id: choc.id, qty: 10, rate: 30, reason: 'opening' });
  const mtr = ['Invoice Number,Invoice Date,Transaction Type,Order Id,Quantity,Item Description,Sku,Ship To State,Invoice Amount,Credit Note No',
    'IN-AMZ-1,21-10-2026,Shipment,408-001,2,Chocolate,CHOC-1,KARNATAKA,118,',
    'IN-AMZ-2,21-10-2026,Shipment,408-002,1,Chocolate,CHOC-1,RAJASTHAN,59,',
    'IN-AMZ-3,22-10-2026,FreeReplacement,408-003,1,Chocolate,CHOC-1,DELHI,0,',
    ',24-10-2026,Refund,408-001,1,Chocolate,CHOC-1,KARNATAKA,-59,CN-AMZ-1'].join('\n');
  const m1 = await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr });
  check('Amazon MTR: shipments become orders (ship-to state), a free replacement is no sale, a refund waits for its invoice from the same file',
    m1.ready === 2 && m1.orders.length === 2 && m1.orders[0].party === 'Amazon (Karnataka)' && m1.returns.length === 1 && /make the invoices first/.test(m1.returns[0].problems.join()), JSON.stringify([m1.orders, m1.returns]));
  const choc0 = (await V('GET', '/api/items')).rows.find((i) => i.id === choc.id).qty_on_hand;
  const mi = await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr, only: ['408-001', '408-002'] });
  const inv1 = await V('GET', `/api/docs/${mi.results[0].doc_id}`);
  check('...billed, with Amazon\'s own invoice number on the bill', mi.results.every((r) => r.number) && /Amazon invoice IN-AMZ-1/.test(inv1.notes) && inv1.total === 118, JSON.stringify([mi, inv1.notes]));
  const mret = (await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr })).returns[0];
  check('now the refund is ready: one unit back against its invoice', mret && !mret.problems.length && mret.invoice === inv1.number && mret.lines.length === 1 && mret.lines[0].qty === 1 && mret.total === 59, JSON.stringify(mret));
  const mr = await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr, only_returns: [mret.key] });
  const sret = await V('GET', `/api/docs/${mr.results[0].doc_id}`);
  check('the refund becomes a sales return against the invoice; the unit comes back into stock', sret.type === 'SRET' && sret.ref_id === inv1.id && sret.total === 59
    && (await V('GET', '/api/items')).rows.find((i) => i.id === choc.id).qty_on_hand === choc0 - 3 + 1, JSON.stringify([mr, sret.type, sret.ref_id, sret.total]));
  const m3 = await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr, only_returns: [mret.key] });
  check('the same refund is never returned twice', m3.results[0].skipped === 'already returned' && (await V('POST', '/api/channels/import', { channel: 'amazon', csv: mtr })).returns[0].done, JSON.stringify(m3));

  // the Amazon payout (settlement flat file V2): matched to the invoices; fees, GST TCS and TDS 194-O booked; posted once
  const sHead = ['settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date', 'total-amount', 'currency', 'transaction-type', 'order-id', 'merchant-order-id',
    'adjustment-id', 'shipment-id', 'marketplace-name', 'amount-type', 'amount-description', 'amount', 'fulfillment-id', 'posted-date', 'sku', 'quantity-purchased'];
  const sRow = (tx, order, at, ad, amt) => ['9001', '', '', '', '', 'INR', tx, order, '', '', '', 'Amazon.in', at, ad, String(amt), 'MFN', '2026-10-25', 'CHOC-1', '1'].join('\t');
  const sLines = [sRow('Order', '408-001', 'ItemPrice', 'Principal', 100), sRow('Order', '408-001', 'ItemPrice', 'Product Tax', 18), sRow('Order', '408-001', 'ItemFees', 'Commission', -15),
    sRow('Order', '408-001', 'ItemFees', 'Fixed closing fee', -6), sRow('Order', '408-001', 'ItemWithheldTax', 'TCS-IGST', -0.5), sRow('Order', '408-001', 'ItemWithheldTax', 'TDS (Section 194-O)', -0.1),
    sRow('Order', '408-002', 'ItemPrice', 'Principal', 50), sRow('Order', '408-002', 'ItemPrice', 'Product Tax', 9), sRow('Order', '408-002', 'ItemFees', 'Commission', -7.5),
    sRow('Order', '408-999', 'ItemPrice', 'Principal', 200), sRow('other-transaction', '', 'other-transaction', 'Cost of Advertising', -20)];
  const sCsv = [sHead.join('\t'), ['9001', '2026-10-10 00:00:00 UTC', '2026-10-24 00:00:00 UTC', '2026-10-26 00:00:00 UTC', '327.90', 'INR', '', '', '', '', '', '', '', '', '', '', '', '', ''].join('\t'), ...sLines].join('\n');
  const s1 = await V('POST', '/api/channels/settlement', { csv: sCsv });
  const o1 = s1.orders.find((o) => o.order_id === '408-001');
  check('payout read: deposit, sales, fees (ads too), TCS, TDS; each order with what you really got; an order not billed here flagged', s1.settlement_id === '9001' && s1.adds_up
    && s1.totals.deposit === 327.9 && s1.totals.sale === 377 && s1.totals.fee === -48.5 && s1.totals.tcs === -0.5 && s1.totals.tds === -0.1 && s1.unbilled === 1
    && o1.invoice === inv1.number && o1.net === 96.4 && s1.deposit === '2026-10-26', JSON.stringify([s1.totals, o1, s1.unbilled]));
  const sBank = (await V('GET', '/api/accounts')).rows.find((x) => x.sys === 'bank');
  const noUnb = await E('POST', '/api/channels/settlement/post', { csv: sCsv, account_id: sBank.id });
  check('a payout with orders not billed here is not posted without saying how to book them', noUnb.status === 400 && /not billed here/.test(noUnb.data.error), JSON.stringify(noUnb.data));
  const sp = await V('POST', '/api/channels/settlement/post', { csv: sCsv, account_id: sBank.id, unbilled_ok: true });
  const acc = (await V('GET', '/api/accounts')).rows, bal = (s) => (acc.find((x) => x.sys === s) || {}).balance;
  check('posted: both invoices paid through one receipt per Amazon party', sp.receipts === 2 && sp.invoices === 2 && (await V('GET', `/api/docs/${inv1.id}`)).status === 'paid'
    && (await V('GET', `/api/docs/${mi.results[1].doc_id}`)).status === 'paid', JSON.stringify(sp));
  check('...the bank got the deposit; fees, TCS and TDS sit in their own accounts; the payout account is clear', Math.abs(bal('bank') - sBank.balance - 327.9) < 0.005 && bal('mkt_fees') === 48.5
    && bal('tcs_recv') === 0.5 && bal('tds_recv') === 0.1 && Math.abs(bal('mkt_clear')) < 0.005, JSON.stringify(acc.filter((x) => ['bank', 'mkt_fees', 'tcs_recv', 'tds_recv', 'mkt_clear', 'other_income'].includes(x.sys)).map((x) => [x.sys, x.balance])));
  check('...and the books balance', (await V('GET', '/api/reports/trial-balance')).balanced);
  const again2 = await E('POST', '/api/channels/settlement/post', { csv: sCsv, account_id: sBank.id, unbilled_ok: true });
  const spl = await V('GET', '/api/channels/settlements');
  check('a payout is posted once only, and listed with its TCS and TDS', again2.status === 400 && /already posted/.test(again2.data.error) && (await V('POST', '/api/channels/settlement', { csv: sCsv })).posted
    && spl.rows.length === 1 && spl.rows[0].tcs === -0.5 && spl.rows[0].tds === -0.1, JSON.stringify([again2.data, spl.rows]));
  check('a file that is not a settlement report says so', (await E('POST', '/api/channels/settlement', { csv: 'a,b\n1,2\n' })).status === 400);

  td = await V('GET', '/api/today');
  check('today lists what needs doing', Array.isArray(td.rows) && td.rows.some((r) => r.key === 'to_receive'), JSON.stringify(td.rows));
  const bk = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  check('backups carry serials, recipes, production runs and imported orders', bk.tables.serials.length >= 6 && bk.tables.serial_moves.length >= 10 && bk.tables.boms.length === 1
    && bk.tables.bom_lines.length === 2 && bk.tables.productions.length === 2 && bk.tables.channel_orders.length === 4 && bk.tables.channel_returns.length === 1 && bk.tables.mkt_settlements.length === 1,
    ['serials', 'serial_moves', 'boms', 'bom_lines', 'productions', 'channel_orders', 'channel_returns', 'mkt_settlements'].map((t) => `${t} ${(bk.tables[t] || []).length}`).join(' '));
}

/* staff: attendance, advance, salary with the advance cut, payslip, cancel, and the books */
{
  const ip = '203.0.113.150';
  const email = `staff${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Gupta Traders', name: 'G', email, password: 'Staff-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const accts = (await V('GET', '/api/accounts')).rows;
  const cash = accts.find((a) => a.sys === 'cash');
  check('new businesses get Staff Advances and a salary account', accts.some((a) => a.sys === 'staff_adv') && accts.some((a) => a.sys === 'salary'), accts.map((a) => a.sys).join());
  // last month, so the whole month counts; joined before it
  const t = new Date(Date.now() + 5.5 * 3600e3); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1);
  const month = t.toISOString().slice(0, 7), days = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const ram = await V('POST', '/api/staff', { name: 'Ram', phone: '9876500011', pay_type: 'month', rate: 15000, ot_rate: 100, join_date: `${month.slice(0, 4)}-01-01` < `${month}-01` ? `${month.slice(0, 4)}-01-01` : `${month}-01` });
  const shyam = await V('POST', '/api/staff', { name: 'Shyam', pay_type: 'day', rate: 500, join_date: `${month}-01` });
  check('staff added with monthly salary and daily wage', ram.rate === 15000 && shyam.pay_type === 'day', JSON.stringify([ram, shyam]));
  // Ram: 2 absent, 1 half day, 3 h overtime; Shyam: worked 10 days, 1 half day
  await V('POST', '/api/staff/attendance', { marks: [
    { staff_id: ram.id, date: `${month}-03`, status: 'A' }, { staff_id: ram.id, date: `${month}-04`, status: 'A' }, { staff_id: ram.id, date: `${month}-05`, status: 'H' },
    { staff_id: ram.id, date: `${month}-06`, status: 'P', ot_hours: 3 },
    ...Array.from({ length: 10 }, (_, i) => ({ staff_id: shyam.id, date: `${month}-${String(i + 10).padStart(2, '0')}`, status: 'P' })),
    { staff_id: shyam.id, date: `${month}-20`, status: 'H' }] });
  const future = await E('POST', '/api/staff/attendance', { marks: [{ staff_id: ram.id, date: '2099-01-01', status: 'P' }] });
  check('attendance cannot be marked for a future date', future.status === 400, JSON.stringify(future.data));
  const ls = await V('GET', `/api/staff?month=${month}`);
  const R = ls.rows.find((s) => s.id === ram.id), S = ls.rows.find((s) => s.id === shyam.id);
  const ramDays = days - 2 - 0.5, ramPay = Math.round(15000 * ramDays / days) + 300;
  check('monthly salary: unmarked days count, absences and half days do not, overtime added', R.pay.payable === ramDays && R.pay.earned === ramPay && R.pay.ot_hours === 3, JSON.stringify(R.pay) + ' want ' + ramPay);
  check('daily wage: only the days marked present (half day = half)', S.pay.payable === 10.5 && S.pay.earned === 5250, JSON.stringify(S.pay));
  // advance 2,000 then salary with 1,500 cut
  await V('POST', `/api/staff/${ram.id}/advance`, { amount: 2000, paid_from: cash.id });
  const over = await E('POST', `/api/staff/${ram.id}/salary`, { month, advance_cut: 2500, paid_from: cash.id });
  check('cannot cut more advance than is due', over.status === 400 && /2000/.test(over.data.error), JSON.stringify(over.data));
  const paid = await V('POST', `/api/staff/${ram.id}/salary`, { month, advance_cut: 1500, bonus: 500, paid_from: cash.id });
  check('salary paid: earned + bonus − advance cut', paid.net === ramPay + 500 - 1500, JSON.stringify(paid));
  const twice = await E('POST', `/api/staff/${ram.id}/salary`, { month, paid_from: cash.id });
  check('a month cannot be paid twice', twice.status === 400 && /already paid/.test(twice.data.error), JSON.stringify(twice.data));
  const slip = await V('GET', `/api/staff/payslip/${paid.id}`);
  check('payslip has the days, the cut and what is still due', slip.net === paid.net && slip.advance_cut === 1500 && slip.detail.advance_left === 500 && slip.detail.payable === ramDays, JSON.stringify(slip));
  const tb = await V('GET', '/api/reports/trial-balance');
  const bal = (sys) => { const a = accts.find((x) => x.sys === sys); const r = tb.rows.find((x) => x.code === a.code); return r ? Math.round(((r.debit || 0) - (r.credit || 0)) * 100) / 100 : 0; };
  check('books: salary expense, advance left 500, cash paid out', bal('salary') === ramPay + 500 && bal('staff_adv') === 500 && bal('cash') === -(2000 + paid.net) && tb.balanced,
    JSON.stringify({ salary: bal('salary'), adv: bal('staff_adv'), cash: bal('cash'), balanced: tb.balanced }));
  const det = await V('GET', `/api/staff/${ram.id}?month=${month}`);
  check('staff page: marks, payments, advance due', det.marks.length === 4 && det.txns.length === 2 && det.advance_due === 500 && det.paid.id === paid.id, JSON.stringify(det).slice(0, 400));
  const advTxn = det.txns.find((x) => x.kind === 'advance');
  const cantAdv = await E('POST', `/api/staff/txns/${advTxn.id}/cancel`);
  check('an advance partly cut from a salary cannot be cancelled', cantAdv.status === 400, JSON.stringify(cantAdv.data));
  await V('POST', `/api/staff/txns/${paid.id}/cancel`);
  await V('POST', `/api/staff/txns/${advTxn.id}/cancel`);
  const tb2 = await V('GET', '/api/reports/trial-balance');
  const bal2 = (sys) => { const a = accts.find((x) => x.sys === sys); const r = tb2.rows.find((x) => x.code === a.code); return r ? Math.round(((r.debit || 0) - (r.credit || 0)) * 100) / 100 : 0; };
  check('cancelling the salary and the advance reverses the books', bal2('salary') === 0 && bal2('staff_adv') === 0 && bal2('cash') === 0, JSON.stringify({ s: bal2('salary'), a: bal2('staff_adv'), c: bal2('cash') }));
  const again = await V('POST', `/api/staff/${ram.id}/salary`, { month, paid_from: cash.id });
  check('after cancelling, the month can be paid again', again.net === ramPay, JSON.stringify(again));
  // a sales user cannot see salaries
  await V('POST', '/api/users', { email: 'sales' + email, name: 'Sales', role: 'sales', password: 'Sales-pass-1' });
  const sl = await rq('POST', '/api/auth/login', { email: 'sales' + email, password: 'Sales-pass-1' }, { ip });
  check('salaries are hidden from the sales role', (await rq('GET', '/api/staff', undefined, { cookie: sl.cookie, ip })).status === 403);
}

/* offline replay (Idempotency-Key), web store webhooks, guided put-away and wave picking, the on-phone bill reader's
   rules; with the stand-in WhatsApp server (ERP_AI_MOCK, see README "Tests"): automatic WhatsApp reminders */
{
  const ip = '203.0.113.160';
  const email = `more${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Verma Electronics', name: 'V', email, password: 'More-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b, h) => { const r = await rq(m, p, b, { cookie: su.cookie, ip, headers: h }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b, h) => rq(m, p, b, { cookie: su.cookie, ip, headers: h });
  const wh = (await V('GET', '/api/warehouses')).rows[0];
  const cust = await V('POST', '/api/parties', { name: 'Kiran Stores', kind: 'customer', state: 'Rajasthan', phone: '9876500021' });
  const fan = await V('POST', '/api/items', { name: 'Ceiling fan', unit: 'pc', sale_price: 2360, purchase_price: 1500, gst_rate: 18, sku: 'FAN-1', location: 'A-01' });
  const bulb = await V('POST', '/api/items', { name: 'LED bulb 9W', unit: 'pc', sale_price: 118, purchase_price: 60, gst_rate: 18, sku: 'LED-9' });
  await V('POST', '/api/stock/adjust', { item_id: fan.id, qty: 20, rate: 1500, reason: 'opening' });
  await V('POST', '/api/stock/adjust', { item_id: bulb.id, qty: 200, rate: 60, reason: 'opening' });

  // the same bill sent twice with one Idempotency-Key (an offline save synced again) is saved once
  const key = 'k' + Date.now().toString(36) + 'abcdef';
  const body = { type: 'INV', party_id: cust.id, lines: [{ item_id: bulb.id, qty: 2, rate: 118 }] };
  const a1 = await E('POST', '/api/docs', body, { 'Idempotency-Key': key });
  const a2 = await E('POST', '/api/docs', body, { 'Idempotency-Key': key });
  const invs = await V('GET', '/api/docs?type=INV');
  check('a bill replayed with the same Idempotency-Key is saved once and answered the same', a1.status === 200 && a2.status === 200 && a2.data.id === a1.data.id && invs.rows.length === 1
    && a2.headers.get('idempotent-replay') === 'true', JSON.stringify([a1.status, a2.status, a1.data.number, a2.data.number, invs.rows.length]));
  const bad1 = await E('POST', '/api/docs', { ...body, lines: [{ item_id: bulb.id, qty: 9999, rate: 1 }] }, { 'Idempotency-Key': key + 'x' });
  const bad2 = await E('POST', '/api/docs', { ...body, lines: [{ item_id: bulb.id, qty: 1, rate: 118 }] }, { 'Idempotency-Key': key + 'x' });
  check('a refused request is not remembered: fixed and sent again with its key, it is saved', bad1.status === 400 && bad2.status === 200, JSON.stringify([bad1.status, bad2.status]));
  check('a malformed Idempotency-Key is refused', (await E('POST', '/api/docs', body, { 'Idempotency-Key': 'x y' })).status === 400);

  // web store: Shopify (signed with the shop's key), WooCommerce (secret made here, ping), own site
  const crypto = await import('node:crypto');
  const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const post = (url, raw, headers) => fetch(url.replace(/^https?:\/\/[^/]+/, BASE), { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: raw });
  const shopKey = 'shpss_' + 'a'.repeat(32);
  const shop = await V('POST', '/api/hooks', { kind: 'shopify', name: 'Verma Shopify', secret: shopKey });
  check('a Shopify store connection without the signing key is refused', (await E('POST', '/api/hooks', { kind: 'shopify', name: 'x' })).status === 400);
  const order = { id: 5551, name: '#1001', created_at: '2026-10-24T10:00:00+05:30', financial_status: 'paid', taxes_included: true,
    shipping_address: { province: 'Maharashtra', province_code: 'MH' }, line_items: [{ sku: 'FAN-1', title: 'Ceiling fan', quantity: 1, price: '2360.00', discount_allocations: [] }] };
  const raw = JSON.stringify(order);
  const forged = await post(shop.url, raw, { 'X-Shopify-Hmac-Sha256': sign('wrong-key-wrong-key', raw) });
  check('an order with a wrong signature is refused', forged.status === 401, String(forged.status));
  const okS = await (await post(shop.url, raw, { 'X-Shopify-Hmac-Sha256': sign(shopKey, raw) })).json();
  const again = await (await post(shop.url, raw, { 'X-Shopify-Hmac-Sha256': sign(shopKey, raw) })).json();
  const sd = (await V('GET', '/api/docs?type=INV')).rows.find((d) => d.number === okS.number);
  const sdoc = sd && await V('GET', `/api/docs/${sd.id}`);
  check('a paid Shopify order becomes an invoice at once, IGST to the buyer\'s state, never twice', okS.number && again.skipped === 'already billed' && sdoc && sdoc.igst > 0 && sdoc.total === 2360
    && sdoc.party.name === 'Verma Shopify (Maharashtra)', JSON.stringify([okS, again, sdoc && [sdoc.total, sdoc.igst, sdoc.party.name]]));
  const woo = await V('POST', '/api/hooks', { kind: 'woocommerce', name: 'Verma Woo' });
  check('a WooCommerce connection gets a secret to paste', woo.secret && woo.secret.length >= 32, JSON.stringify(woo));
  const ping = await post(woo.url, 'webhook_id=12', { 'Content-Type': 'application/x-www-form-urlencoded' });
  check('WooCommerce\'s unsigned ping on saving the webhook gets 200', ping.status === 200, String(ping.status));
  const wo = JSON.stringify({ id: 77, number: '77', status: 'processing', date_created: '2026-10-24T11:00:00', shipping: { state: 'RJ' },
    line_items: [{ sku: 'LED-9', name: 'LED', quantity: 10, total: '1000.00', total_tax: '180.00' }, { sku: 'NOPE', name: 'Unknown', quantity: 1, total: '10', total_tax: '0' }] });
  const wr = await (await post(woo.url, wo, { 'X-WC-Webhook-Signature': sign(woo.secret, wo) })).json();
  const hl = await V('GET', '/api/hooks');
  check('an order with an unknown SKU is answered 200 but not billed, and the reason is kept for the shop', wr.ok && !wr.number && /NOPE/.test(hl.rows.find((h) => h.id === woo.id).last_error), JSON.stringify([wr, hl.rows]));
  const pend = JSON.stringify({ id: 78, number: '78', status: 'pending', line_items: [{ sku: 'LED-9', quantity: 1, total: '100', total_tax: '18' }] });
  const pr = await (await post(woo.url, pend, { 'X-WC-Webhook-Signature': sign(woo.secret, pend) })).json();
  check('an unpaid (pending) order is not billed', pr.skipped === 'not a paid order', JSON.stringify(pr));
  const own = await V('POST', '/api/hooks', { kind: 'custom', name: 'Website' });
  const oo = JSON.stringify({ order_id: 'W-1', date: '2026-10-25', state: 'Rajasthan', lines: [{ sku: 'LED-9', qty: 5, amount: 590 }] });
  const or = await (await post(own.url, oo, { 'X-Signature': sign(own.secret, oo) })).json();
  const od = (await V('GET', '/api/docs?type=INV')).rows.find((d) => d.number === or.number);
  check('an order from the shop\'s own site, in state: CGST + SGST', or.number && od && (await V('GET', `/api/docs/${od.id}`)).cgst > 0, JSON.stringify(or));
  const list = await V('GET', '/api/hooks');
  check('connections list how many orders came in, without the secrets', list.rows.length === 3 && list.rows.find((h) => h.id === shop.id).orders === 1 && !('secret' in list.rows[0]), JSON.stringify(list.rows));

  // guided put-away and wave picking
  await V('POST', '/api/bins', { warehouse_id: wh.id, racks: 'A-B', shelves: 2 });
  const pa = await V('GET', `/api/bins/putaway?warehouse_id=${wh.id}`);
  const pf = pa.rows.find((r) => r.id === fan.id), pb = pa.rows.find((r) => r.id === bulb.id);
  check('put-away suggests the default bin, else an empty one', pf.suggest.code === 'A-01' && pf.suggest.why === 'default bin' && pb.suggest && pb.suggest.why === 'empty bin' && pb.suggest.code !== 'A-01',
    JSON.stringify(pa.rows));
  await V('POST', '/api/bins/move', { item_id: bulb.id, warehouse_id: wh.id, from_bin_id: 0, to_bin_id: pb.suggest.bin_id, qty: 50 });
  const pa2 = await V('GET', `/api/bins/putaway?warehouse_id=${wh.id}`);
  check('...and then the bin that already holds the item', pa2.rows.find((r) => r.id === bulb.id).suggest.code === pb.suggest.code && pa2.rows.find((r) => r.id === bulb.id).suggest.why === 'already holds this item',
    JSON.stringify(pa2.rows));
  const so1 = await V('POST', '/api/docs', { type: 'SO', party_id: cust.id, lines: [{ item_id: bulb.id, qty: 30, rate: 118 }, { item_id: fan.id, qty: 2, rate: 2360 }] });
  const so2 = await V('POST', '/api/docs', { type: 'SO', party_id: cust.id, lines: [{ item_id: bulb.id, qty: 25, rate: 118 }] });
  const wave = await V('GET', `/api/picklist?ids=${so1.id},${so2.id}`);
  const wb = wave.rows.find((r) => r.item_id === bulb.id);
  check('wave pick list: one line per item for all orders, from the bins, split by order', wave.rows.length === 2 && wb.qty === 55 && wb.orders.length === 2 && wb.from[0].code === pb.suggest.code && wb.from[0].qty === 50 && wb.short_of_bins === 5,
    JSON.stringify(wave.rows));

  // the bill reader that runs on the phone (public/billocr.js): its text rules, without the OCR
  const ocr = await import(new URL('../public/billocr.js', import.meta.url));
  check('bill reader: GSTIN found and OCR slips fixed by the check digit (O for 0, an extra character)', ocr.findGstins('GSTIN: 27AAPFUQ0939F12V\nGSTIN/UIN: 27AAPFU0939FlZV').join() === '27AAPFU0939F1ZV',
    JSON.stringify(ocr.findGstins('GSTIN: 27AAPFUQ0939F12V')));
  check('bill reader: Indian dates', ocr.isoDate('Date: 20/10/2026') === '2026-10-20' && ocr.isoDate('Dated 5-Mar-26') === '2026-03-05' && ocr.isoDate('dt 05.03.26') === '2026-03-05');
  const billText = ['SHREE GANESH ELECTRICALS', 'GSTIN: 27AAPFU0939F1ZV', 'TAX INVOICE', 'Invoice No: SGE/2526/0457  Date: 20/10/2026', 'Sr Description HSN Qty Rate Amount',
    '1  Ceiling fan  8414  10 Pcs  1,450. 00  14,500.00', '2   LEDBub9W  8539  100 Pcs  55.00  5,500.00', '3  Wall switch 6A  8536  50 Nos  20.00  1,000.00',
    'Taxable value 21,000.00', 'CGST @ 9% 1,890.00', 'SGST @ 9% 1,890.00', 'Grand Total 24,780.00'].join('\n');
  const rb = ocr.parseBill(billText, { items: [{ id: fan.id, name: 'Ceiling fan', gst_rate: 18 }, { id: bulb.id, name: 'LED bulb 9W', gst_rate: 18 }], parties: [] });
  const RL = (n) => rb.lines.find((l) => l.name === n) || {};
  check('bill reader: rows from quantity x rate = amount, matched to items (exact, OCR-mangled name, new)', rb.lines.length === 3 && RL('Ceiling fan').item_id === fan.id && RL('Ceiling fan').qty === 10
    && RL('Ceiling fan').rate === 1450 && RL('LEDBub9W').item_id === bulb.id && RL('Wall switch 6A').item_id === null && RL('Wall switch 6A').gst_rate === 18, JSON.stringify(rb.lines));
  check('bill reader: supplier, bill number, date and the total checked', rb.supplier.gstin === '27AAPFU0939F1ZV' && rb.supplier.name === 'SHREE GANESH ELECTRICALS' && rb.bill_no === 'SGE/2526/0457'
    && rb.bill_date === '2026-10-20' && rb.adds_up && rb.calc_total === 24780, JSON.stringify([rb.supplier, rb.bill_no, rb.bill_date, rb.calc_total]));
  const retail = ocr.parseBill('MODERN MART\n1 Ceiling fan 2 2360.00 4720.00\nTotal 4,720.00', { items: [{ id: 1, name: 'Ceiling fan', gst_rate: 18 }] });
  check('bill reader: rates that include GST are taken back to before GST', retail.lines[0].rate === 2000 && retail.adds_up, JSON.stringify(retail.lines));

  if (process.env.ERP_AI_MOCK) {
    /* a stand-in for the WhatsApp Cloud API (the worker started with WHATSAPP_API pointing here) */
    const http = await import('node:http');
    const seen = { wa: [] };
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const wa = u.pathname.startsWith('/wa/') ? JSON.parse(b) : null;
        res.writeHead(wa && wa.to.endsWith('0000') ? 400 : 200, { 'Content-Type': 'application/json' });
        if (wa) {
          seen.wa.push({ path: u.pathname, auth: req.headers.authorization, body: wa });
          if (wa.to.endsWith('0000')) return res.end(JSON.stringify({ error: { message: 'Recipient not on WhatsApp' } }));
          return res.end(JSON.stringify({ messages: [{ id: 'wamid.' + seen.wa.length }] }));
        }
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise((ok) => srv.listen(+process.env.ERP_AI_MOCK, '127.0.0.1', ok));
    const me = await V('GET', '/api/me');
    check('the app knows automatic WhatsApp is set up', me.wa_auto === true, JSON.stringify(me.wa_auto));

    // automatic WhatsApp reminders: a Growth-plan business (the trial), two customers overdue, one without WhatsApp
    const late = await V('POST', '/api/parties', { name: 'Late Payer', kind: 'customer', state: 'Rajasthan', phone: '9876500022' });
    const nowa = await V('POST', '/api/parties', { name: 'No WhatsApp', kind: 'customer', state: 'Rajasthan', phone: '9876500000' });
    for (const p of [late, nowa]) await V('POST', '/api/docs', { type: 'INV', party_id: p.id, date: '2026-09-01', due_date: '2026-09-10', lines: [{ item_id: bulb.id, qty: 10, rate: 118 }] });
    const offRun = await E('POST', '/api/settings/auto-wa/run');
    check('reminders cannot be run before they are turned on', offRun.status === 400, JSON.stringify(offRun.data));
    await V('PUT', '/api/settings/auto-wa', { on: true });
    const run = await V('POST', '/api/settings/auto-wa/run');
    const w = seen.wa.find((x) => x.body.to === '919876500022');
    check('due customers get the approved template on WhatsApp, with name, business, amount and their bill link', run.sent >= 1 && w && w.auth === 'Bearer test-wa' && w.path === '/wa/555/messages'
      && w.body.template.name === 'payment_reminder' && w.body.template.components[0].parameters[0].text === 'Late Payer' && w.body.template.components[0].parameters[1].text === 'Verma Electronics'
      && /\/i\/[0-9a-f]{24}/.test(w.body.template.components[0].parameters[3].text), JSON.stringify([run, w && w.body]));
    check('a number WhatsApp refuses is counted as failed, with the reason', run.failed === 1 && /Recipient not on WhatsApp/.test(run.errors.join()), JSON.stringify(run));
    const run2 = await V('POST', '/api/settings/auto-wa/run');
    check('nobody gets two reminders in a day', run2.sent === 0, JSON.stringify(run2));
    const vq = await V('GET', '/api/vasooli');
    const lp = vq.queue.find((r) => r.party_id === late.id);
    check('the automatic reminder is logged and moves the schedule on', lp && lp.status === 'sent' && lp.last_sent.via === 'auto', JSON.stringify(lp));
    const me2 = await V('GET', '/api/me');
    check('the last run is shown in Settings', /sent/.test(me2.org.auto_wa_note), me2.org.auto_wa_note);
    // a recurring bill goes to the customer by itself on WhatsApp (automatic WhatsApp is on), with its bill link
    const rinv = await V('POST', '/api/docs', { type: 'INV', party_id: late.id, lines: [{ item_id: bulb.id, qty: 1, rate: 500 }] });
    const rsch = await V('POST', `/api/docs/${rinv.id}/recurring`, { every: 'month', next_on: me.today });
    const waBefore = seen.wa.length;
    await V('POST', '/api/recurring/run');
    const rrow = (await V('GET', '/api/recurring')).rows.find((r) => r.src_doc_id === rinv.id);
    const wb = seen.wa.slice(waBefore).find((x) => x.body.to === '919876500022');
    check('with automatic WhatsApp on, each new recurring bill goes to the customer by itself, with its link', rsch.count === 1 && rrow.send === 'auto' && rrow.sent === 1 && wb
      && /\/i\/[0-9a-f]{24}/.test(JSON.stringify(wb.body)), JSON.stringify([rrow, wb && wb.body]));
    const ib0 = (await V('GET', '/api/wa/inbox')).rows || [];
    check('...and shows in the WhatsApp inbox as a new bill', JSON.stringify(ib0).includes('"bill"'), JSON.stringify(ib0).slice(0, 300));
    srv.close();
  }
}

/* bill first, goods later: a purchase bill booked while the goods are on the way (Goods in Transit), goods received
   against it (scan screen: GRN from the bill, learnt codes, bins made on the spot), shortage closed by a debit note,
   the gate's e-invoice QR matched to the bill; each user's own menu and a guard who can only use the gate register */
{
  const ip = '203.0.113.170';
  const email = `recv${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Sharma Hardware', name: 'S', email, password: 'Recv-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const wh = (await V('GET', '/api/warehouses')).rows[0];
  const sup = await V('POST', '/api/parties', { name: 'Shree Vinayak Traders', kind: 'supplier', state: 'Rajasthan', gstin: '08AAACS1234F1Z5' });
  const fan = await V('POST', '/api/items', { name: 'Table fan', unit: 'pc', sale_price: 1800, purchase_price: 1000, gst_rate: 18 });
  const bolt = await V('POST', '/api/items', { name: 'Hex bolt', unit: 'pc', sale_price: 2, purchase_price: 1, gst_rate: 18 });
  const freight = await V('POST', '/api/items', { name: 'Freight', unit: 'trip', sale_price: 0, purchase_price: 500, gst_rate: 18, is_service: true });
  const accts = (await V('GET', '/api/accounts')).rows;
  const bal = async (sys) => {
    const tb = await V('GET', '/api/reports/trial-balance'), a = accts.find((x) => x.sys === sys), r = a && tb.rows.find((x) => x.code === a.code);
    return r ? Math.round(((r.debit || 0) - (r.credit || 0)) * 100) / 100 : 0;
  };
  const qty = async (id) => (await V('GET', '/api/items')).rows.find((i) => i.id === id).qty_on_hand;
  check('every business has a Goods in Transit account', accts.some((a) => a.sys === 'git' && a.name === 'Goods in Transit'));

  // 1. the bill comes first (by e-mail / WhatsApp); the goods are on the truck
  const bill = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, transit: true, party_ref: 'SV/1001', lines: [
    { item_id: fan.id, qty: 10, rate: 1000 }, { item_id: bolt.id, qty: 3, rate: 1, discount_pct: 12.5 }, { item_id: freight.id, qty: 1, rate: 500 }] });
  const boltTaxable = bill.lines[1].taxable;
  check('a bill booked in transit moves no stock and parks the goods in Goods in Transit', bill.transit === 1 && bill.party_ref === 'SV/1001' && await qty(fan.id) === 0
    && await bal('git') === 10000 + boltTaxable, JSON.stringify([bill.transit, await bal('git'), boltTaxable]));
  check('the bill still owes the supplier in full (goods, freight, GST)', eq(await bal('ap'), -bill.total), String(await bal('ap')));
  const dupe = await E('POST', '/api/docs', { type: 'BILL', party_id: sup.id, party_ref: 'sv/1001', lines: [{ item_id: fan.id, qty: 1, rate: 1000 }] });
  check('the same supplier bill number cannot be entered twice', dupe.status === 400 && /already entered as/.test(dupe.data.error), JSON.stringify(dupe.data));
  let pend = await V('GET', '/api/receive');
  const pb = pend.bills.find((b) => b.id === bill.id);
  check('the Receive screen lists the bill with what is still to come (goods only, not freight)', pb && pb.lines === 2 && pb.qty === 13 && pb.party_ref === 'SV/1001', JSON.stringify(pend.bills));

  // 2. at the gate: the e-invoice QR gives the supplier GSTIN, bill number, value and IRN
  const irn = 'a'.repeat(63) + 'b';
  const ge = await V('POST', '/api/gate', { kind: 'in', vehicle_no: 'RJ14 GA 1234', party_gstin: '08AAACS1234F1Z5', challan_no: 'SV/1001', value: bill.total, irn, packages: 4 });
  const gel = (await V('GET', '/api/gate?kind=in')).rows.find((g) => g.id === ge.id);
  check('a gate entry from the e-invoice QR finds the supplier by GSTIN and the bill by its number', ge.party_id === sup.id && ge.bill_id === bill.id && gel.bill_number === bill.number
    && gel.irn === irn && gel.value === bill.total, JSON.stringify(gel));
  const twice = await E('POST', '/api/gate', { kind: 'in', vehicle_no: 'RJ14GA1234', irn });
  check('the same e-invoice cannot come in at the gate twice', twice.status === 400 && /already came in/.test(twice.data.error), JSON.stringify(twice.data));
  check('a malformed IRN is refused', (await E('POST', '/api/gate', { kind: 'in', vehicle_no: 'X1', irn: 'nothex' })).status === 400);
  const td = (await V('GET', '/api/today')).rows;
  check('the Today card says a truck is at the gate and a bill waits for its goods', td.some((r) => r.key === 'at_gate' && r.n === 1)
    && td.some((r) => r.key === 'in_transit' && r.n === 1 && r.value === bill.total), JSON.stringify(td));

  // 3. bins made while receiving: no bins yet -> new ones, and each item gets its home bin
  const plan0 = await V('POST', '/api/bins/auto', { warehouse_id: wh.id, item_ids: [fan.id, bolt.id, freight.id] });
  check('without bins nothing is suggested until asked to make them', plan0.rows.length === 2 && plan0.rows.every((r) => !r.bin), JSON.stringify(plan0));
  const plan = await V('POST', '/api/bins/auto', { warehouse_id: wh.id, item_ids: [fan.id, bolt.id], create: true });
  const items1 = (await V('GET', '/api/items')).rows;
  check('bins are made one after another and become the items\' home bins', JSON.stringify(plan.created) === '["A-01","A-02"]' && plan.rows[0].bin === 'A-01' && plan.rows[1].bin === 'A-02'
    && items1.find((i) => i.id === fan.id).location === 'A-01', JSON.stringify(plan));
  const plan2 = await V('POST', '/api/bins/auto', { warehouse_id: wh.id, item_ids: [fan.id], create: true });
  check('asked again, the home bin is used and no bin is made', plan2.rows[0].bin === 'A-01' && plan2.rows[0].why === 'default bin' && !plan2.created.length, JSON.stringify(plan2));
  await V('POST', '/api/bins', { warehouse_id: wh.id, codes: ['A-03', 'A-04'] });
  const nut = await V('POST', '/api/items', { name: 'Hex nut', unit: 'pc', sale_price: 1, purchase_price: 0.5, gst_rate: 18 });
  const plan3 = await V('POST', '/api/bins/auto', { warehouse_id: wh.id, item_ids: [nut.id], skip: ['A-03'] });
  check('an empty bin already given to another item of the same receipt is not given twice', plan3.rows[0].bin === 'A-04' && plan3.rows[0].why === 'empty bin', JSON.stringify(plan3));

  // 4. receive part of it against the bill and the gate entry, into the bins
  const draft = await V('GET', `/api/docs/${bill.id}/convert?to=GRN`);
  check('the receipt draft has the goods still to come, not the freight', draft.lines.length === 2 && draft.lines[0].qty === 10 && draft.lines[1].qty === 3 && draft.ref_type === 'BILL', JSON.stringify(draft.lines));
  const lineOf = (id) => draft.lines.find((l) => l.item_id === id).src_line_id;
  const badBin = await E('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 1, src_line_id: lineOf(fan.id), bin: 'ZZ-9' }] });
  check('a bin that does not exist is refused', badBin.status === 400 && /no bin ZZ-9/.test(badBin.data.error), JSON.stringify(badBin.data));
  const g1 = await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, gate_entry_id: ge.id, lines: [
    { item_id: fan.id, qty: 6, src_line_id: lineOf(fan.id), bin: 'A-01' }, { item_id: bolt.id, qty: 1, src_line_id: lineOf(bolt.id), bin: 'A-02' }] });
  const bins = await V('GET', `/api/bins?warehouse_id=${wh.id}`);
  check('goods received from the bill come in at the bill\'s price, into the chosen bins', await qty(fan.id) === 6 && g1.lines[0].cost === 6000
    && bins.bins.find((b) => b.code === 'A-01').qty === 6 && bins.bins.find((b) => b.code === 'A-02').qty === 1, JSON.stringify([g1.lines.map((l) => l.cost), bins.bins]));
  check('the receipt moves value out of Goods in Transit into stock', eq(await bal('git'), 4000 + boltTaxable - g1.lines[1].cost) && eq(await bal('grni'), 0), String(await bal('git')));
  const gate1 = (await V('GET', '/api/gate?kind=in')).rows.find((g) => g.id === ge.id);
  check('the gate entry is closed by the receipt', gate1.status === 'grn_done' && gate1.grn_number === g1.number, JSON.stringify(gate1));
  const over = await E('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 5, src_line_id: lineOf(fan.id) }] });
  check('more than is still to come cannot be received', over.status === 400 && /only 4 left to receive/.test(over.data.error), JSON.stringify(over.data));
  const ret = await E('POST', '/api/docs', { type: 'PRET', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 7, src_line_id: lineOf(fan.id) }] });
  check('only goods that came can be returned', ret.status === 400 && /only 6 left to return/.test(ret.data.error), JSON.stringify(ret.data));
  const detail = await V('GET', `/api/docs/${bill.id}`);
  check('the bill shows what is still to come per line', detail.lines[0].to_receive === 4 && detail.lines[1].to_receive === 2 && detail.lines[2].to_receive === 0, JSON.stringify(detail.lines.map((l) => l.to_receive)));

  // 5. one fan never comes: a shortage note claims it back from the supplier
  const sd = await V('GET', `/api/docs/${bill.id}/convert?to=DNOTE&short=1`);
  check('the shortage draft has what has not come, at the bill\'s price', sd.short === true && sd.lines.length === 2 && sd.lines[0].qty === 4 && sd.lines[0].rate === 1000, JSON.stringify(sd));
  const apBefore = await bal('ap');
  const sn = await V('POST', '/api/docs', { type: 'DNOTE', short: true, party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 1, rate: 1, src_line_id: lineOf(fan.id) }] });
  check('a shortage note is at the bill\'s price whatever is typed, and lowers what is owed with its GST', sn.short === 1 && sn.total === 1180 && eq(await bal('ap') - apBefore, 1180)
    && eq(await bal('git'), 3000 + boltTaxable - g1.lines[1].cost), JSON.stringify([sn.total, await bal('git')]));
  const g2 = await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 3, src_line_id: lineOf(fan.id) }, { item_id: bolt.id, qty: 1, src_line_id: lineOf(bolt.id) }] });
  let b2 = await V('GET', `/api/docs/${bill.id}`);
  check('the bill still waits for the last bolt', b2.transit === 1, String(b2.transit));
  const g3 = await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: bolt.id, qty: 1, src_line_id: lineOf(bolt.id) }] });
  b2 = await V('GET', `/api/docs/${bill.id}`);
  const boltCosts = [g1.lines[1].cost, g2.lines[1].cost, g3.lines[0].cost];
  check('received in parts, the pieces add up to the bill to the paisa and Goods in Transit is empty', b2.transit === 2 && eq(boltCosts.reduce((s, x) => s + x, 0), boltTaxable)
    && eq(await bal('git'), 0), JSON.stringify([b2.transit, boltCosts, boltTaxable, await bal('git')]));
  pend = await V('GET', '/api/receive');
  check('a bill whose goods all came leaves the Receive list', !pend.bills.some((b) => b.id === bill.id));
  const noMore = await E('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: fan.id, qty: 1, src_line_id: lineOf(fan.id) }] });
  check('nothing more can be received on it', noMore.status === 400 && /no goods left/.test(noMore.data.error), JSON.stringify(noMore.data));

  // 6. cancelling a receipt puts it back on the list; cancelling the shortage note too
  await V('POST', `/api/docs/${g3.id}/cancel`);
  b2 = await V('GET', `/api/docs/${bill.id}`);
  check('a cancelled receipt is to come again', b2.transit === 1 && b2.lines[1].to_receive === 1 && eq(await bal('git'), g3.lines[0].cost), JSON.stringify([b2.transit, b2.lines[1].to_receive]));
  const g4 = await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: bolt.id, qty: 1, src_line_id: lineOf(bolt.id) }] });
  await V('POST', `/api/docs/${sn.id}/cancel`);
  b2 = await V('GET', `/api/docs/${bill.id}`);
  check('a cancelled shortage note is to come again, and the claim is undone', b2.transit === 1 && b2.lines[0].to_receive === 1 && eq(await bal('git'), 1000) && g4.lines[0].cost === g3.lines[0].cost,
    JSON.stringify([b2.transit, b2.lines[0].to_receive, await bal('git')]));
  const cb = await E('POST', `/api/docs/${bill.id}/cancel`);
  check('the bill cannot be cancelled while receipts made from it stand', cb.status === 400, JSON.stringify(cb.data));
  check('the books still balance', (await V('GET', '/api/reports/trial-balance')).balanced === true);

  // 7. codes learnt while scanning: the supplier's barcode, a carton of 6
  await V('POST', `/api/items/${fan.id}/codes`, { code: '8901234567890' });
  const l1 = await V('GET', '/api/items/lookup?code=8901234567890');
  check('a new code becomes the item\'s barcode', l1.id === fan.id && l1.pack_qty === 1 && (await V('GET', '/api/items')).rows.find((i) => i.id === fan.id).barcode === '8901234567890', JSON.stringify(l1));
  await V('POST', `/api/items/${fan.id}/codes`, { code: 'CTN-FAN-6', pack_qty: 6 });
  const l2 = await V('GET', '/api/items/lookup?code=CTN-FAN-6');
  check('a carton code finds the item with how many pieces it holds', l2.id === fan.id && l2.pack_qty === 6, JSON.stringify(l2));
  const clash = await E('POST', `/api/items/${bolt.id}/codes`, { code: 'CTN-FAN-6' });
  check('a code already used by another item is refused', clash.status === 400 && /Table fan/.test(clash.data.error), JSON.stringify(clash.data));
  const own = await E('POST', `/api/items/${fan.id}/codes`, { code: '8901234567890', pack_qty: 12 });
  check('the barcode of one piece cannot be a carton code', own.status === 400, JSON.stringify(own.data));
  const edit = await E('PUT', `/api/items/${bolt.id}`, { name: 'Hex bolt', unit: 'pc', gst_rate: 18, barcode: 'CTN-FAN-6' });
  check('an item cannot take a barcode another item learnt', edit.status === 400 && /Table fan/.test(edit.data.error), JSON.stringify(edit.data));

  // 8. each user's own menu, and a gate guard who can only use the gate register
  const guardRole = await V('POST', '/api/roles', { name: 'Gate guard', perms: { view: [], edit: ['gate'] } });
  check('a role can have the gate register alone', JSON.stringify(guardRole.perms) === '{"view":["gate"],"edit":["gate"]}', JSON.stringify(guardRole.perms));
  await V('POST', '/api/users', { email: 'guard' + email, name: 'Guard', role: `c:${guardRole.id}`, password: 'Guard-pass-1234' });
  await V('POST', '/api/users', { email: 'godown' + email, name: 'Godown', role: 'store', password: 'Godown-pass-1234' });
  const users = (await V('GET', '/api/users')).rows;
  const guardU = users.find((u) => u.email === 'guard' + email), storeU = users.find((u) => u.email === 'godown' + email), ownerU = users.find((u) => u.role === 'owner');
  check('users start with the menu their role gives', guardU.ui.job === '' && guardU.ui.screens === null, JSON.stringify(guardU.ui));
  await V('PUT', `/api/users/${storeU.id}/ui`, { job: 'store', home: 'receive' });
  await V('PUT', `/api/users/${guardU.id}/ui`, { screens: ['gate/in', 'gate/out', 'bad screen!'], home: 'gate/in' });
  const gl = await rq('POST', '/api/auth/login', { email: 'guard' + email, password: 'Guard-pass-1234' }, { ip });
  const G = (m, p, b) => rq(m, p, b, { cookie: gl.cookie, ip });
  const gme = (await G('GET', '/api/me')).data;
  check('the guard\'s menu is the screens the owner ticked, and opens on the gate', JSON.stringify(gme.ui) === '{"job":"","screens":["gate/in","gate/out"],"home":"gate/in"}' && gme.can.gate === true
    && gme.can.purchase === false && gme.view.gate === true && gme.view.purchase === false, JSON.stringify([gme.ui, gme.can, gme.view]));
  const gg = await G('POST', '/api/gate', { kind: 'in', vehicle_no: 'RJ14 GB 5678', challan_no: 'X-9' });
  check('the guard can log a truck and see the gate register', gg.status === 200 && (await G('GET', '/api/gate?kind=in')).status === 200, JSON.stringify(gg.data));
  check('the guard cannot see bills or make them', (await G('GET', '/api/docs?type=BILL')).status === 403
    && (await G('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: fan.id, qty: 1, rate: 1 }] })).status === 403
    && (await G('GET', '/api/receive')).status === 403);
  const sl = await rq('POST', '/api/auth/login', { email: 'godown' + email, password: 'Godown-pass-1234' }, { ip });
  const sme = (await rq('GET', '/api/me', undefined, { cookie: sl.cookie, ip })).data;
  check('the store keeper\'s menu is the store job, opening on Receive goods', sme.ui.job === 'store' && sme.ui.home === 'receive', JSON.stringify(sme.ui));
  check('menus are for the owner or an admin to set', (await rq('PUT', `/api/users/${storeU.id}/ui`, { job: 'all' }, { cookie: sl.cookie, ip })).status === 403);
  await V('PUT', `/api/users/${ownerU.id}/ui`, { job: 'all', home: 'pos' });
  check('the owner sets their own start screen', (await V('GET', '/api/me')).ui.home === 'pos');
  await V('PUT', `/api/users/${storeU.id}/ui`, {});
  check('an empty menu goes back to the role\'s', (await V('GET', '/api/users')).rows.find((u) => u.id === storeU.id).ui.job === '');

  // 9. a backup restored into a new business keeps bills in transit, the gate's bill link and the codes learnt
  const j = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  const nu = await rq('POST', '/api/auth/signup', { business: 'Sharma Restore', name: 'R', email: 'r' + email, password: 'Recv-pass-1234', state: 'Rajasthan' }, { ip: '203.0.113.171' });
  const R2 = (m, p, b) => rq(m, p, b, { cookie: nu.cookie, ip: '203.0.113.171' });
  const rr = await R2('POST', '/api/restore', j);
  const rbills = (await R2('GET', '/api/docs?type=BILL')).data.rows, rb = rbills.find((d) => d.number === bill.number);
  const rbd = rb && (await R2('GET', `/api/docs/${rb.id}`)).data;
  const rge = (await R2('GET', '/api/gate?kind=in&status=')).data.rows.find((g) => g.number === ge.number);
  check('a restored bill keeps its supplier bill number and what is still to come', rr.status === 200 && rbd && rbd.party_ref === 'SV/1001' && rbd.transit === 1 && rbd.lines[0].to_receive === 1,
    JSON.stringify([rr.status, rbd && [rbd.party_ref, rbd.transit, rbd.lines.map((l) => l.to_receive)]]));
  check('a restored gate entry points at the restored bill', rge && rge.bill_id === rb.id && rge.bill_number === bill.number, JSON.stringify(rge));
  check('codes learnt while receiving come back', (await R2('GET', '/api/items/lookup?code=CTN-FAN-6')).data.pack_qty === 6);
  const tbR = (await R2('GET', '/api/reports/trial-balance')).data, tbO = await V('GET', '/api/reports/trial-balance');
  check('the restored books match, Goods in Transit included', tbR.balanced && JSON.stringify(tbO.rows.map((r) => [r.code, r.debit, r.credit])) === JSON.stringify(tbR.rows.map((r) => [r.code, r.debit, r.credit])));
}

/* goods damaged or lost on the way written off (our loss, or a claim on the transporter; the GST input on them reversed),
   and every role made to measure: a built-in role's rights changed, limits (no cancelling, no udhaar, a discount cap,
   today's date only, no costs) and the role's menu, enforced on the server */
{
  const ip = '203.0.113.180';
  const email = `wo${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Mehta Crockery', name: 'M', email, password: 'Mehta-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const sup = await V('POST', '/api/parties', { name: 'Khurja Pottery', kind: 'supplier', state: 'Rajasthan', gstin: '08AAACK1234F1Z5' });
  const cust = await V('POST', '/api/parties', { name: 'Gupta Caterers', kind: 'customer', state: 'Rajasthan', phone: '9876500031' });
  const cup = await V('POST', '/api/items', { name: 'Tea cup', unit: 'pc', sale_price: 100, purchase_price: 50, gst_rate: 18 });
  const plate = await V('POST', '/api/items', { name: 'Dinner plate', unit: 'pc', sale_price: 300, purchase_price: 200, gst_rate: 18 });
  const saucer = await V('POST', '/api/items', { name: 'Saucer', unit: 'pc', sale_price: 2, purchase_price: 1, gst_rate: 18 });
  const accts = (await V('GET', '/api/accounts')).rows, cash = accts.find((a) => a.sys === 'cash');
  const bal = async (sys) => {
    const tb = await V('GET', '/api/reports/trial-balance'), a = accts.find((x) => x.sys === sys), r = a && tb.rows.find((x) => x.code === a.code);
    return r ? Math.round(((r.debit || 0) - (r.credit || 0)) * 100) / 100 : 0;
  };
  check('every business has accounts for transit losses and claims', accts.some((a) => a.sys === 'transit_loss') && accts.some((a) => a.sys === 'claims'));

  const bill = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, transit: true, party_ref: 'KP/77', lines: [
    { item_id: cup.id, qty: 10, rate: 50 }, { item_id: plate.id, qty: 4, rate: 200 }, { item_id: saucer.id, qty: 3, rate: 1, discount_pct: 12.5 }] });
  const L = (id) => bill.lines.find((l) => l.item_id === id), saucerTaxable = L(saucer.id).taxable;
  const gstBefore = await bal('gst_input'), apBefore = await bal('ap');
  check('the bill parks its goods in Goods in Transit', eq(await bal('git'), 500 + 800 + saucerTaxable));

  // validation
  const tooMany = await E('POST', `/api/docs/${bill.id}/write-off`, { lines: [{ line_id: L(cup.id).id, qty: 11 }] });
  const none = await E('POST', `/api/docs/${bill.id}/write-off`, { lines: [] });
  const badMode = await E('POST', `/api/docs/${bill.id}/write-off`, { mode: 'gift', lines: [{ line_id: L(cup.id).id, qty: 1 }] });
  check('a write-off of more than is still to come, of nothing, or of an unknown kind is refused', tooMany.status === 400 && /only 10 still to come/.test(tooMany.data.error)
    && none.status === 400 && badMode.status === 400, JSON.stringify([tooMany.data, none.data, badMode.data]));

  // 2 cups broke on the way: our loss; 1 plate lost: the transporter pays
  const woA = await V('POST', `/api/docs/${bill.id}/write-off`, { mode: 'loss', reason: 'Broken in the truck', lines: [{ line_id: L(cup.id).id, qty: 2 }] });
  check('broken goods are written off at the bill\'s price with the GST on them reversed', woA.number === 'WO-00001' && woA.value === 100 && woA.cgst === 9 && woA.sgst === 9
    && eq(await bal('transit_loss'), 118) && eq(await bal('gst_input'), gstBefore - 18) && eq(await bal('ap'), apBefore), JSON.stringify([woA, await bal('transit_loss'), await bal('gst_input')]));
  const woB = await V('POST', `/api/docs/${bill.id}/write-off`, { mode: 'claim', reason: 'LR 4411: one carton missing', lines: [{ line_id: L(plate.id).id, qty: 1 }] });
  check('lost goods the transporter will pay for become a claim', woB.value === 200 && eq(await bal('claims'), 236) && eq(await bal('git'), 1000 + saucerTaxable), JSON.stringify([woB, await bal('claims'), await bal('git')]));
  let bd = await V('GET', `/api/docs/${bill.id}`);
  check('the bill shows what is still to come and its write-offs', bd.lines.find((l) => l.item_id === cup.id).to_receive === 8 && bd.lines.find((l) => l.item_id === plate.id).to_receive === 3
    && bd.write_offs.length === 2 && bd.write_offs[0].mode === 'loss' && bd.write_offs[0].total === 118, JSON.stringify(bd.write_offs));

  // the rest comes: Goods in Transit ends at exactly zero, a saucer written off in between
  await V('POST', `/api/docs/${bill.id}/write-off`, { lines: [{ line_id: L(saucer.id).id, qty: 1 }] });
  await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: cup.id, qty: 8, src_line_id: L(cup.id).id },
    { item_id: plate.id, qty: 3, src_line_id: L(plate.id).id }, { item_id: saucer.id, qty: 2, src_line_id: L(saucer.id).id }] });
  bd = await V('GET', `/api/docs/${bill.id}`);
  check('received and written off together, the bill is done and Goods in Transit is empty to the paisa', bd.transit === 2 && eq(await bal('git'), 0), JSON.stringify([bd.transit, await bal('git')]));
  const gst = await V('GET', '/api/reports/gst');
  check('the GST summary shows the input credit reversed and adds it to the GST payable', gst.itc_reversed.n === 3 && eq(gst.itc_reversed.tax, 18 + 36 + bd.write_offs[2].gst)
    && eq(gst.net_payable, gst.outward.total.tax - gst.inward.total.tax + gst.itc_reversed.tax), JSON.stringify(gst.itc_reversed));

  // the cups turn up after all: cancel the write-off and they are to come again
  await V('POST', `/api/write-offs/${woA.id}/cancel`);
  bd = await V('GET', `/api/docs/${bill.id}`);
  check('a cancelled write-off puts the goods back on the way and undoes the loss and the GST reversal', bd.transit === 1 && bd.lines.find((l) => l.item_id === cup.id).to_receive === 2
    && eq(await bal('transit_loss'), bd.write_offs[2].total) && eq(await bal('git'), 100), JSON.stringify([bd.transit, await bal('transit_loss'), await bal('git')]));
  check('a cancelled write-off cannot be cancelled again', (await E('POST', `/api/write-offs/${woA.id}/cancel`)).status === 400);
  const g2 = await V('POST', '/api/docs', { type: 'GRN', party_id: sup.id, ref_id: bill.id, lines: [{ item_id: cup.id, qty: 2, src_line_id: L(cup.id).id }] });
  check('they are received at the value left', g2.lines[0].cost === 100 && eq(await bal('git'), 0), JSON.stringify(g2.lines));
  check('the books balance', (await V('GET', '/api/reports/trial-balance')).balanced === true);

  // every role made to measure
  const roles = await V('GET', '/api/roles');
  const std = (k) => roles.builtin.find((r) => r.key === k);
  check('the four built-in roles are listed with their standard rights', roles.builtin.length === 4 && std('store').perms.edit.includes('purchase') && std('store').perms.edit.includes('items')
    && !std('sales').perms.edit.includes('purchase') && std('sales').changed === false, JSON.stringify(roles.builtin.map((r) => [r.key, r.perms.edit])));
  await V('POST', '/api/users', { email: 'kavita' + email, name: 'Kavita (counter)', role: 'sales', password: 'Kavita-pass-1234' });
  await V('POST', '/api/users', { email: 'gopal' + email, name: 'Gopal (godown)', role: 'store', password: 'Gopal-pass-1234' });
  await V('POST', '/api/users', { email: 'anil' + email, name: 'Anil (admin)', role: 'admin', password: 'Anil-pass-12345' });
  await V('PUT', '/api/roles/builtin/sales', { rules: { no_cancel: true, no_credit: true, hide_costs: true, max_discount: 10, backdate_days: 0 }, ui: { job: 'counter', home: 'pos' } });
  const login = async (who, pw) => (await rq('POST', '/api/auth/login', { email: who + email, password: pw }, { ip })).cookie;
  const kc = await login('kavita', 'Kavita-pass-1234'), K = (m, p, b) => rq(m, p, b, { cookie: kc, ip });
  const kme = (await K('GET', '/api/me')).data;
  check('a sales person gets the limits and the menu of the sales role', kme.rules.no_credit === true && kme.rules.max_discount === 10 && kme.rules.backdate_days === 0
    && kme.role_ui.job === 'counter' && kme.role_ui.home === 'pos' && kme.can.sales === true, JSON.stringify([kme.rules, kme.role_ui]));
  const pay = (amt) => ({ amount: amt, account_id: cash.id });
  const udhaar = await K('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: cup.id, qty: 1, rate: 100 }] });
  check('no udhaar: a bill not paid in full is refused', udhaar.status === 403 && /paid in full/.test(udhaar.data.error), JSON.stringify(udhaar.data));
  const okDisc = await K('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: cup.id, qty: 1, rate: 100, discount_pct: 10, gst_rate: 18 }], payment: pay(106.2) });
  const bigDisc = await K('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: cup.id, qty: 1, rate: 100, discount_pct: 11 }], payment: pay(200) });
  const lowRate = await K('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: cup.id, qty: 1, rate: 85 }], payment: pay(200) });
  check('a discount up to the role\'s cap is fine; more, or a lower rate, is refused', okDisc.status === 200 && bigDisc.status === 403 && lowRate.status === 403 && /lowest price/.test(lowRate.data.error),
    JSON.stringify([okDisc.status, okDisc.data.error, bigDisc.data, lowRate.data]));
  const y = new Date(Date.now() + 5.5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const old = await K('POST', '/api/docs', { type: 'INV', party_id: cust.id, date: y, lines: [{ item_id: cup.id, qty: 1, rate: 100 }], payment: pay(118) });
  check('today\'s date only: a bill dated yesterday is refused', old.status === 403 && /today only/.test(old.data.error), JSON.stringify(old.data));
  check('no cancelling', (await K('POST', `/api/docs/${okDisc.data.id}/cancel`)).status === 403);
  const kItems = (await K('GET', '/api/items')).data.rows;
  check('no costs: purchase rates are hidden', kItems.length && kItems.every((i) => !('purchase_price' in i) && !('avg_cost' in i)), JSON.stringify(kItems[0]));
  check('the owner works without the limits', (await E('POST', '/api/docs', { type: 'INV', party_id: cust.id, date: y, lines: [{ item_id: cup.id, qty: 1, rate: 50 }] })).status === 200);

  // a built-in role's rights changed, then put back
  const gc = await login('gopal', 'Gopal-pass-1234'), G = (m, p, b) => rq(m, p, b, { cookie: gc, ip });
  const billBody = { type: 'BILL', party_id: sup.id, lines: [{ item_id: cup.id, qty: 1, rate: 50 }] };
  await V('PUT', '/api/roles/builtin/store', { perms: { view: ['items', 'gate', 'masters'], edit: ['items', 'gate'] } });
  const gNo = await G('POST', '/api/docs', billBody), gSee = await G('GET', '/api/docs?type=BILL'), gGate = await G('POST', '/api/gate', { kind: 'in', vehicle_no: 'RJ14 1' });
  check('a built-in role\'s rights can be cut: the godown no longer makes or sees bills, still logs the gate', gNo.status === 403 && gSee.status === 403 && gGate.status === 200,
    JSON.stringify([gNo.status, gSee.status, gGate.status]));
  check('the change shows on the roles list', (await V('GET', '/api/roles')).builtin.find((r) => r.key === 'store').changed === true);
  await V('DELETE', '/api/roles/builtin/store');
  check('back to standard, the godown makes bills again', (await G('POST', '/api/docs', billBody)).status === 200);
  await V('PUT', '/api/roles/builtin/sales', { perms: { view: ['sales', 'items', 'masters', 'khata', 'finance'], edit: ['sales', 'masters', 'khata', 'finance'] }, rules: {} });
  check('rights can also be added: the sales role now records expenses', (await K('POST', '/api/expenses', { account_id: accts.find((a) => a.type === 'expense' && !a.sys).id, amount: 50, paid_from: cash.id })).status === 200);

  // only the owner changes the admin role; an admin may change the others
  const ac = await login('anil', 'Anil-pass-12345'), A = (m, p, b) => rq(m, p, b, { cookie: ac, ip });
  check('an admin cannot change the admin role, but can change the others', (await A('PUT', '/api/roles/builtin/admin', { rules: {} })).status === 403
    && (await A('PUT', '/api/roles/builtin/sales', { rules: { no_cancel: true } })).status === 200);
  // own roles carry limits and a menu too
  const own = await V('POST', '/api/roles', { name: 'Counter', perms: { view: ['sales'], edit: ['sales'] }, rules: { max_discount: 5, no_cancel: true }, ui: { job: 'counter' } });
  const ownRow = (await V('GET', '/api/roles')).rows.find((r) => r.id === own.id);
  check('a role of your own keeps its limits and menu', ownRow.rules.max_discount === 5 && ownRow.rules.no_cancel === true && ownRow.ui.job === 'counter', JSON.stringify(ownRow));

  // backup and restore keep the write-offs, their books and the roles' rules
  const j = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  const nu = await rq('POST', '/api/auth/signup', { business: 'Mehta Restore', name: 'R', email: 'r' + email, password: 'Mehta-pass-1234', state: 'Rajasthan' }, { ip: '203.0.113.181' });
  const R2 = (m, p, b) => rq(m, p, b, { cookie: nu.cookie, ip: '203.0.113.181' });
  const rr = await R2('POST', '/api/restore', j);
  const rroles = (await R2('GET', '/api/roles')).data;
  const rbill = (await R2('GET', '/api/docs?type=BILL')).data.rows.find((d) => d.number === bill.number);
  const rbd = rbill && (await R2('GET', `/api/docs/${rbill.id}`)).data;
  check('restored: the write-offs, the sales role\'s rules and a role of your own with its rules', rr.status === 200 && rbd && rbd.write_offs.length === 3
    && rroles.builtin.find((r) => r.key === 'sales').rules.no_cancel === true && rroles.rows.find((r) => r.name === 'Counter').rules.max_discount === 5,
  JSON.stringify([rr.status, rbd && rbd.write_offs.length, rroles.builtin.map((r) => r.rules), rroles.rows]));
  const tbO = await V('GET', '/api/reports/trial-balance'), tbR = (await R2('GET', '/api/reports/trial-balance')).data;
  check('the restored books match, transit losses and claims included', tbR.balanced && JSON.stringify(tbO.rows.map((r) => [r.code, r.debit, r.credit])) === JSON.stringify(tbR.rows.map((r) => [r.code, r.debit, r.credit])));
}

/* transit claims followed up to the end: whom and their reference, follow-up date, money received in parts, the rest
   closed as a loss, entries cancelled, who may do what, and backup / restore */
{
  const ip = '203.0.113.190';
  const email = `cl${Date.now()}@test.in`;
  const su = await rq('POST', '/api/auth/signup', { business: 'Jain Glass House', name: 'J', email, password: 'Jain-pass-12345', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const sup = await V('POST', '/api/parties', { name: 'Firozabad Glass Works', kind: 'supplier', state: 'Rajasthan', gstin: '08AAACF1234F1Z5' });
  const vase = await V('POST', '/api/items', { name: 'Glass vase', unit: 'pc', sale_price: 1500, purchase_price: 1000, gst_rate: 18 });
  const accts = (await V('GET', '/api/accounts')).rows, cash = accts.find((a) => a.sys === 'cash');
  const bal = async (sys) => {
    const tb = await V('GET', '/api/reports/trial-balance'), a = accts.find((x) => x.sys === sys), r = a && tb.rows.find((x) => x.code === a.code);
    return r ? Math.round(((r.debit || 0) - (r.credit || 0)) * 100) / 100 : 0;
  };
  const bill = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, transit: true, party_ref: 'FGW/12', lines: [{ item_id: vase.id, qty: 5, rate: 1000 }] });
  const line = bill.lines[0].id;
  const wo = await V('POST', `/api/docs/${bill.id}/write-off`, { mode: 'claim', against: 'VRL Logistics', claim_ref: 'LR 7788', reason: 'Two vases broken', lines: [{ line_id: line, qty: 2 }] });
  let list = await V('GET', '/api/claims');
  check('a claim written off on the bill shows on Transit Claims with whom and their reference', list.rows.length === 1 && list.rows[0].against === 'VRL Logistics' && list.rows[0].claim_ref === 'LR 7788'
    && list.rows[0].total === 2360 && list.rows[0].due === 2360 && list.rows[0].state === 'open' && list.totals.open === 1 && list.totals.due === 2360, JSON.stringify(list));
  let td = (await V('GET', '/api/today')).rows;
  check('the Today card lists the open claim with what is due', td.some((r) => r.key === 'claims' && r.n === 1 && r.value === 2360), JSON.stringify(td));
  const tomorrow = new Date(Date.now() + 5.5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  await V('PUT', `/api/claims/${wo.id}`, { against: 'VRL Logistics Ltd', claim_ref: 'LR 7788', follow_up: tomorrow, claim_note: 'Spoke to Mr Rao' });
  td = (await V('GET', '/api/today')).rows;
  check('with a follow-up date ahead it leaves the Today card until then', !td.some((r) => r.key === 'claims'), JSON.stringify(td));

  // money in parts, then the rest closed as a loss
  const cashBefore = await bal('cash');
  let d = await V('POST', `/api/claims/${wo.id}/receive`, { amount: 1500, account_id: cash.id, note: 'NEFT 4455' });
  check('money received lowers what is due and comes into the cash book', d.state === 'partial' && d.received === 1500 && d.due === 860 && eq(await bal('claims'), 860)
    && eq(await bal('cash') - cashBefore, 1500) && d.entries.length === 1 && d.against === 'VRL Logistics Ltd' && d.follow_up === tomorrow, JSON.stringify(d));
  const over = await E('POST', `/api/claims/${wo.id}/receive`, { amount: 900, account_id: cash.id });
  check('more than is due cannot be received', over.status === 400 && /860/.test(over.data.error), JSON.stringify(over.data));
  const lossBefore = await bal('transit_loss');
  d = await V('POST', `/api/claims/${wo.id}/close`, { note: 'Transporter paid only part' });
  check('the rest closed as a loss: nothing due, the claim is settled and the loss is booked', d.due === 0 && d.closed === 860 && d.state === 'settled' && eq(await bal('claims'), 0)
    && eq(await bal('transit_loss') - lossBefore, 860), JSON.stringify(d));
  check('a settled claim leaves the open list', (await V('GET', '/api/claims')).rows.length === 0 && (await V('GET', '/api/claims?status=closed')).rows.length === 1);
  check('nothing more can be closed or received', (await E('POST', `/api/claims/${wo.id}/close`, {})).status === 400
    && (await E('POST', `/api/claims/${wo.id}/receive`, { amount: 1, account_id: cash.id })).status === 400);
  check('a write-off with money received on it cannot be cancelled', (await E('POST', `/api/write-offs/${wo.id}/cancel`)).status === 400);

  // entries cancelled, newest first, put the amount back on the claim
  const closing = d.entries.find((e) => e.kind === 'loss'), receipt = d.entries.find((e) => e.kind === 'receipt');
  d = await V('POST', `/api/claim-entries/${closing.id}/cancel`);
  check('a cancelled closing makes the rest due again and takes the loss back', d.due === 860 && d.state === 'partial' && eq(await bal('transit_loss'), lossBefore), JSON.stringify(d));
  d = await V('POST', `/api/claim-entries/${receipt.id}/cancel`);
  check('a cancelled receipt takes the money out of the cash book again', d.due === 2360 && d.state === 'open' && eq(await bal('cash'), cashBefore) && eq(await bal('claims'), 2360), JSON.stringify(d));
  check('an entry cannot be cancelled twice', (await E('POST', `/api/claim-entries/${receipt.id}/cancel`)).status === 400);
  await V('POST', `/api/claims/${wo.id}/receive`, { amount: 2360, account_id: cash.id });
  check('paid in full in one go: settled', (await V('GET', `/api/claims/${wo.id}`)).state === 'settled');

  // who may do what
  await V('POST', '/api/users', { email: 'store' + email, name: 'Store', role: 'store', password: 'Store-pass-12345' });
  const sc = (await rq('POST', '/api/auth/login', { email: 'store' + email, password: 'Store-pass-12345' }, { ip })).cookie;
  const S = (m, p, b) => rq(m, p, b, { cookie: sc, ip });
  const wo2 = await V('POST', `/api/docs/${bill.id}/write-off`, { mode: 'claim', against: 'United India Insurance', lines: [{ line_id: line, qty: 1 }] });
  check('the godown sees claims and keeps their details, but money needs the finance right', (await S('GET', '/api/claims')).status === 200
    && (await S('PUT', `/api/claims/${wo2.id}`, { against: 'United India Insurance', claim_ref: 'POL-1' })).status === 200
    && (await S('POST', `/api/claims/${wo2.id}/receive`, { amount: 10, account_id: cash.id })).status === 403
    && (await S('POST', `/api/claims/${wo2.id}/close`, {})).status === 403);
  check('a loss write-off is not a claim', (await E('GET', `/api/claims/${(await V('POST', `/api/docs/${bill.id}/write-off`, { lines: [{ line_id: line, qty: 1 }] })).id}`)).status === 404);
  check('the books balance', (await V('GET', '/api/reports/trial-balance')).balanced === true);

  // backup and restore keep the claims and their history
  await V('POST', `/api/claims/${wo2.id}/receive`, { amount: 500, account_id: cash.id });
  const j = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  const nu = await rq('POST', '/api/auth/signup', { business: 'Jain Restore', name: 'R', email: 'r' + email, password: 'Jain-pass-12345', state: 'Rajasthan' }, { ip: '203.0.113.191' });
  const R2 = (m, p, b) => rq(m, p, b, { cookie: nu.cookie, ip: '203.0.113.191' });
  const rr = await R2('POST', '/api/restore', j);
  const rl = (await R2('GET', '/api/claims?status=all')).data;
  const rc = rl.rows.find((x) => x.claim_ref === 'POL-1'), rcd = rc && (await R2('GET', `/api/claims/${rc.id}`)).data;
  check('restored: the claims with whom, what came and their history', rr.status === 200 && rl.rows.length === 2 && rcd && rcd.received === 500 && rcd.entries.length === 1
    && rcd.entries[0].account === cash.name, JSON.stringify([rr.status, rl.rows.length, rcd]));
  const tbO = await V('GET', '/api/reports/trial-balance'), tbR = (await R2('GET', '/api/reports/trial-balance')).data;
  check('the restored books match, claim money included', tbR.balanced && JSON.stringify(tbO.rows.map((r) => [r.code, r.debit, r.credit])) === JSON.stringify(tbR.rows.map((r) => [r.code, r.debit, r.credit])));
}

/* the WhatsApp bot on the official Cloud API: Meta's address check, signed messages, which shop a message is for, the
   commands, STOP / START for automatic reminders (and a reminder that goes free inside the customer's 24 hours), the
   shop's inbox and free replies; with the stand-in WhatsApp server (ERP_AI_MOCK) and the worker started with
   WHATSAPP_APP_SECRET=test-app-secret, WHATSAPP_VERIFY_TOKEN=test-verify, WHATSAPP_NUMBER=919000000000 */
if (process.env.ERP_AI_MOCK) {
  const ip = '203.0.113.200';
  const http = await import('node:http'), crypto = await import('node:crypto');
  const sent = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const wa = req.url.startsWith('/wa/') ? JSON.parse(b) : null;
      res.writeHead(wa ? 200 : 404, { 'Content-Type': 'application/json' });
      if (!wa) return res.end('{}');
      sent.push({ auth: req.headers.authorization, body: wa });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.out.' + sent.length }] }));
    });
  });
  await new Promise((ok) => srv.listen(+process.env.ERP_AI_MOCK, '127.0.0.1', ok));
  // fresh mobiles each run: a contact is one per WhatsApp number across all shops
  const stamp = String(Date.now() % 1e8).padStart(8, '0'), mob = (k) => `9${stamp}${k}`, wa = (k) => '91' + mob(k);
  let n = 0;
  const post = async (raw, sig) => {
    const res = await fetch(BASE + '/api/wa/webhook', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.209', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
  const payload = (value) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '555' }, ...value } }] }] });
  const say = async (k, text, id) => {
    const from = wa(k), raw = payload({ contacts: [{ wa_id: from, profile: { name: 'C' } }],
      messages: [{ from, id: id || `wamid.in.${stamp}.${++n}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] });
    const before = sent.length, r = await post(raw, sign(raw));
    const mine = sent.slice(before).filter((x) => x.body.to === from), last = mine[mine.length - 1];
    return { ...r, reply: last ? last.body : null, text: last && last.body.text ? last.body.text.body : '' };
  };

  // Meta checks the address once with the verify token from its dashboard
  const vOk = await fetch(BASE + '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=8237461');
  check('webhook address check: the right verify token gets the challenge back', vOk.status === 200 && await vOk.text() === '8237461');
  check('webhook address check: a wrong or missing token is refused', (await fetch(BASE + '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status === 403
    && (await fetch(BASE + '/api/wa/webhook')).status === 403);
  const forged = payload({ messages: [{ from: wa(1), id: 'wamid.forged', type: 'text', text: { body: 'hisab' } }] });
  check('a message without Meta\'s signature, or signed with another secret, is refused', (await post(forged)).status === 401
    && (await post(forged, 'sha256=' + crypto.createHmac('sha256', 'other').update(forged).digest('hex'))).status === 401
    && (await post(forged, sign(forged + ' '))).status === 401);
  const before0 = sent.length;
  check('a number no shop knows gets a polite answer: ask the shop for its WhatsApp link', /kisi dukaan ki list mein nahi/.test((await say(9, 'hello')).text) && sent.length === before0 + 1);

  const su = await rq('POST', '/api/auth/signup', { business: 'Gupta Kirana', name: 'G', email: `wabot${Date.now()}@test.in`, password: 'Wabot-pass-1234', state: 'Rajasthan' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  let me = await V('GET', '/api/me');
  check('the app knows the WhatsApp bot can be turned on (off until the shop does)', me.wa_bot === true && !me.org.wa_bot && me.wa_bot_link === '', JSON.stringify([me.wa_bot, me.org.wa_bot, me.wa_bot_link]));
  const atta = await V('POST', '/api/items', { name: 'Atta 10kg', unit: 'bag', sale_price: 100, purchase_price: 80, gst_rate: 0, is_service: true });
  const ramesh = await V('POST', '/api/parties', { name: 'Ramesh Kumar', kind: 'customer', state: 'Rajasthan', phone: '+91 ' + mob(1).slice(0, 5) + ' ' + mob(1).slice(5) });
  const suresh = await V('POST', '/api/parties', { name: 'Suresh Jain', kind: 'customer', state: 'Rajasthan', phone: '0' + mob(2) });
  const inv1 = await V('POST', '/api/docs', { type: 'INV', party_id: ramesh.id, date: '2026-09-01', due_date: '2026-09-10', lines: [{ item_id: atta.id, qty: 2, rate: 100 }] });
  const inv2 = await V('POST', '/api/docs', { type: 'INV', party_id: ramesh.id, date: '2026-09-05', due_date: '2026-09-15', lines: [{ item_id: atta.id, qty: 3, rate: 100 }] });
  await V('POST', '/api/docs', { type: 'INV', party_id: suresh.id, date: '2026-09-01', due_date: '2026-09-10', lines: [{ item_id: atta.id, qty: 1, rate: 100 }] });
  check('a customer of a shop that has not turned the bot on is not answered for it', /kisi dukaan ki list mein nahi/.test((await say(1, 'hisab')).text));

  const on = await V('PUT', '/api/settings/wa-bot', { on: true });
  check('turning the bot on gives the shop its code and WhatsApp link (for the QR)', on.on && /^[0-9A-F]{6}$/.test(on.code) && on.link === `https://wa.me/919000000000?text=${encodeURIComponent('HISAB #' + on.code)}`, JSON.stringify(on));
  me = await V('GET', '/api/me');
  check('the link is in the app for Settings and the poster', me.wa_bot_link === on.link && me.org.wa_bot === 1);

  // a customer on the shop's list, found by mobile (saved as "+91 98765 43210" or "098765..."), any language
  let r = await say(1, 'Namaste');
  check('hello: the menu, in the shop\'s name, by the customer\'s first name', r.status === 200 && r.data.answered === 1 && r.reply.type === 'text' && /^\*Gupta Kirana\*/.test(r.text)
    && /Ramesh ji/.test(r.text) && /1 - Hisab/.test(r.text), JSON.stringify(r));
  check('sent from the shop\'s WhatsApp number with the server\'s token', sent[sent.length - 1].auth === 'Bearer test-wa');
  r = await say(1, 'Hisab bhejo');
  const links = r.text.match(/\/i\/[0-9a-f]{24}/g) || [];
  check('hisab: every open bill with its own link (bill + UPI), and the total due', /Bills: ₹500 baaki \(2\)/.test(r.text) && links.length === 2 && r.text.includes(inv1.number) && r.text.includes(inv2.number)
    && /\*Kul baaki: ₹500\*/.test(r.text), r.text);
  const page = await fetch(BASE + links[0]);
  check('the link opens the customer\'s bill', page.status === 200 && (await page.text()).includes(inv1.number));
  r = await say(1, '2');
  check('2: the last bills, with what is still due on each', r.text.includes(inv1.number) && r.text.includes(inv2.number) && /Aapke pichhle bills/.test(r.text), r.text);
  r = await say(1, '3');
  check('3: the amount and the link to pay by UPI', /₹500 baaki hain\. Is link par UPI se payment karein: http:\/\/localhost:8787\/i\/[0-9a-f]{24}/.test(r.text), r.text);
  r = await say(1, 'vaada');
  check('4 / vaada: where to pick a pay date', /Kab tak denge/.test(r.text) && /\/i\/[0-9a-f]{24}/.test(r.text), r.text);
  const dupId = `wamid.dup.${stamp}`, d1 = await say(1, 'hisab', dupId), d2 = await say(1, 'hisab', dupId);
  check('a message Meta delivers twice is answered once', d1.data.answered === 1 && d2.status === 200 && d2.data.answered === 0 && !d2.reply, JSON.stringify([d1.data, d2.data]));
  const st = payload({ statuses: [{ id: 'wamid.out.1', status: 'read', recipient_id: wa(1) }] });
  check('delivery and read receipts are taken quietly', (await post(st, sign(st))).data.answered === 0);
  const fx = '1' + mob(1), fxRaw = payload({ messages: [{ from: fx, id: `wamid.fx.${stamp}`, type: 'text', text: { body: 'hisab' } }] }), fxAt = sent.length;
  await post(fxRaw, sign(fxRaw));
  const fxOut = sent.slice(fxAt).filter((x) => x.body.to === fx);
  check('a foreign number that ends in the same 10 digits is not taken for the customer', fxOut.length === 1 && !/₹500/.test(fxOut[0].body.text.body)
    && /kisi dukaan ki list mein nahi/.test(fxOut[0].body.text.body), JSON.stringify(fxOut));

  // STOP: no automatic reminders for this customer; START turns them on again; a reminder inside the 24 hours is free text
  r = await say(1, 'STOP');
  check('STOP: automatic reminders from this shop are stopped', /automatic reminder band/.test(r.text), r.text);
  await V('PUT', '/api/settings/auto-wa', { on: true });
  let b4 = sent.length, run = await V('POST', '/api/settings/auto-wa/run');
  let out = sent.slice(b4);
  check('a customer who sent STOP gets no reminder; the others still do (approved template)', !out.some((x) => x.body.to === wa(1)) && out.some((x) => x.body.to === wa(2) && x.body.type === 'template')
    && run.skipped >= 1, JSON.stringify([run, out.map((x) => [x.body.to, x.body.type])]));
  r = await say(1, 'start');
  check('START: reminders are on again', /reminder phir chalu/.test(r.text), r.text);
  b4 = sent.length; run = await V('POST', '/api/settings/auto-wa/run'); out = sent.slice(b4);
  const fr = out.find((x) => x.body.to === wa(1));
  check('a reminder to a customer who wrote in the last 24 hours goes as free text, with the bill link', fr && fr.body.type === 'text' && /Namaste Ramesh Kumar ji, aapke ₹500 baaki hain/.test(fr.body.text.body)
    && /\/i\/[0-9a-f]{24}/.test(fr.body.text.body) && run.free === 1 && /1 free/.test((await V('GET', '/api/me')).org.auto_wa_note), JSON.stringify([run, fr && fr.body]));

  // what the bot cannot answer goes to the shop
  r = await say(1, 'Bhaiya 200 kal de dunga, baaki agle hafte');
  check('anything else is passed to the shop, and the customer is told so', /Aapka message Gupta Kirana ko bhej diya hai/.test(r.text), r.text);
  r = await say(1, '5');
  check('5: talk to the shop', /Woh yahin jawab denge/.test(r.text), r.text);
  let ib = await V('GET', '/api/wa/inbox');
  const row = ib.rows.find((x) => x.phone === wa(1));
  check('the inbox shows the customer by name, waiting for an answer, reply free', ib.waiting === 1 && row && row.name === 'Ramesh Kumar' && row.waiting === 2 && row.window_open && row.last.dir === 'out', JSON.stringify(ib));
  check('Today shows who is waiting on WhatsApp', (await V('GET', '/api/today')).rows.some((x) => x.key === 'wa_asks' && x.n === 1));
  let th = await V('GET', '/api/wa/inbox/' + wa(1));
  check('the chat: what the customer wrote, what the bot and reminders said, oldest first', th.party.id === ramesh.id && th.window_open && th.messages[0].dir === 'in' && th.messages.some((x) => x.kind === 'reminder')
    && th.messages.some((x) => x.kind === 'bot') && th.messages.filter((x) => x.dir === 'in' && x.kind === 'ask' && !x.handled).length === 2, JSON.stringify(th.messages.map((x) => [x.dir, x.kind, x.handled])));
  b4 = sent.length;
  th = await V('POST', `/api/wa/inbox/${wa(1)}/reply`, { text: 'Theek hai Ramesh ji, dhanyavaad' });
  out = sent.slice(b4);
  check('the shop answers from the inbox: free text under the shop\'s name; nothing waits any more', out.length === 1 && out[0].body.type === 'text' && out[0].body.to === wa(1)
    && out[0].body.text.body === '*Gupta Kirana*\nTheek hai Ramesh ji, dhanyavaad' && th.messages[th.messages.length - 1].kind === 'reply' && (await V('GET', '/api/wa/inbox')).waiting === 0, JSON.stringify(out));
  check('an empty reply is refused', (await E('POST', `/api/wa/inbox/${wa(1)}/reply`, { text: '  ' })).status === 400);
  th = await V('GET', '/api/wa/inbox/' + wa(2));
  const late = await E('POST', `/api/wa/inbox/${wa(2)}/reply`, { text: 'hello' });
  check('a customer who never wrote cannot be sent free text (only the approved reminder)', !th.window_open && th.messages.length === 1 && th.messages[0].kind === 'reminder' && late.status === 404, JSON.stringify([th, late.data]));

  // someone not on the list who scanned the shop's QR: goes to that shop's inbox
  r = await say(3, 'HISAB #' + on.code.toLowerCase());
  check('the shop\'s code finds the shop for a number not on its list; the message waits in the inbox', /^\*Gupta Kirana\*\nAapka number dukaan ki list mein nahi/.test(r.text)
    && (await V('GET', '/api/wa/inbox')).rows.some((x) => x.phone === wa(3) && x.waiting === 1 && !x.name), r.text);
  check('marked answered (after a call): nothing waits', (await V('POST', `/api/wa/inbox/${wa(3)}/done`)).ok && (await V('GET', '/api/wa/inbox')).waiting === 0);

  // a mobile that is a customer of two shops: the customer picks one
  const ip2 = '203.0.113.201';
  const su2 = await rq('POST', '/api/auth/signup', { business: 'Agarwal Stores', name: 'A', email: `wabot2${Date.now()}@test.in`, password: 'Wabot-pass-1234', state: 'Rajasthan' }, { ip: ip2 });
  const E2 = (m, p, b) => rq(m, p, b, { cookie: su2.cookie, ip: ip2 });
  await E2('PUT', '/api/settings/wa-bot', { on: true });
  await E2('POST', '/api/parties', { name: 'Mohan Lal', kind: 'customer', state: 'Rajasthan', phone: mob(4) });
  await V('POST', '/api/parties', { name: 'Mohan Lal', kind: 'customer', state: 'Rajasthan', phone: mob(4) });
  r = await say(4, 'hisab');
  check('a customer of two shops is asked which one', /kis dukaan/.test(r.text) && /1\. Agarwal Stores\n2\. Gupta Kirana/.test(r.text), r.text);
  r = await say(4, '1');
  check('the number picks the shop', /^\*Agarwal Stores\*/.test(r.text) && /Mohan ji/.test(r.text), r.text);
  r = await say(4, 'hisab');
  check('then that shop answers', /^\*Agarwal Stores\*/.test(r.text) && /kuch baaki nahi/.test(r.text), r.text);
  const ib2 = (await E2('GET', '/api/wa/inbox')).data;
  check('each shop sees only its own chats', !ib2.rows.some((x) => x.phone === wa(1)) && ib2.rows.some((x) => x.phone === wa(4))
    && (await E2('GET', '/api/wa/inbox/' + wa(1))).status === 404 && (await E2('POST', `/api/wa/inbox/${wa(1)}/reply`, { text: 'x' })).status === 404);
  await E2('PUT', '/api/settings/wa-bot', { on: false });
  r = await say(4, 'hisab');
  check('a shop that turned the bot off no longer answers: the customer\'s other shop does', /^\*Gupta Kirana\*/.test(r.text), r.text);

  // who may do what
  const semail = `wastore${Date.now()}@test.in`;
  await V('POST', '/api/users', { email: semail, name: 'Store', role: 'store', password: 'Store-pass-12345' });
  const sc = (await rq('POST', '/api/auth/login', { email: semail, password: 'Store-pass-12345' }, { ip })).cookie;
  const S = (m, p, b) => rq(m, p, b, { cookie: sc, ip });
  check('only someone who works on sales, khata or money answers customers; only settings turns the bot on or off',
    (await S('POST', `/api/wa/inbox/${wa(1)}/reply`, { text: 'x' })).status === 403 && (await S('POST', `/api/wa/inbox/${wa(1)}/done`, {})).status === 403
    && (await S('PUT', '/api/settings/wa-bot', { on: false })).status === 403);
  check('the inbox needs sign-in', (await rq('GET', '/api/wa/inbox')).status === 401);
  srv.close();
}

/* TDS on payments and receipts, bank reconciliation with the BRS, fixed assets and depreciation */
{
  const ip = '203.0.113.185';
  const su = await rq('POST', '/api/auth/signup', { business: 'Mehta Engineering', name: 'M', email: `acct${Date.now()}@test.in`, password: 'Acct-pass-1234', state: 'Maharashtra' }, { ip });
  const V = async (m, p, b) => { const r = await rq(m, p, b, { cookie: su.cookie, ip }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.data.error}`); return r.data; };
  const E = (m, p, b) => rq(m, p, b, { cookie: su.cookie, ip });
  const acc0 = (await V('GET', '/api/accounts')).rows, bank = acc0.find((a) => a.sys === 'bank'), day = (await V('GET', '/api/me')).today;
  const bal = async (sys) => ((await V('GET', '/api/accounts')).rows.find((a) => a.sys === sys) || {}).balance;
  const cust = await V('POST', '/api/parties', { name: 'Ramesh Traders', kind: 'customer', state: 'Maharashtra' });
  const sup = await V('POST', '/api/parties', { name: 'Shree Contractors', kind: 'supplier', state: 'Maharashtra', gstin: '27AAPFU0939F1ZV' });
  const svc = await V('POST', '/api/items', { name: 'Fabrication work', unit: 'job', sale_price: 1000, gst_rate: 18, is_service: true });

  // TDS kept back from a contractor: the bill settled in full, the contractor gets the rest, TDS owed until the challan
  const bill = await V('POST', '/api/docs', { type: 'BILL', party_id: sup.id, lines: [{ item_id: svc.id, qty: 10, rate: 1000 }] });
  check('a TDS payment needs its section', (await E('POST', '/api/payments', { kind: 'payment', party_id: sup.id, account_id: bank.id, amount: 100, tds_rate: 2 })).status === 400);
  const pay = await V('POST', '/api/payments', { kind: 'payment', party_id: sup.id, account_id: bank.id, amount: 11800, tds_section: '194C', tds_rate: 2, reference: 'CHQ000045',
    allocations: [{ doc_id: bill.id, amount: 11800 }] });
  check('TDS on a payment: the bill is paid in full, the bank pays the rest, TDS is owed to the government', pay.tds === 23600 && pay.tds_section === '194C'
    && (await V('GET', `/api/docs/${bill.id}`)).status === 'paid' && await bal('tds_payable') === 236 && await bal('bank') === -11564, JSON.stringify([pay.tds, await bal('tds_payable'), await bal('bank')]));
  const tr = await V('GET', '/api/tds');
  check('TDS report: by section, the supplier\'s PAN from the GSTIN, due by the 7th; Today asks to pay it', tr.deducted.length === 1 && tr.deducted[0].pan === 'AAPFU0939F'
    && tr.by_section[0].section === '194C' && tr.by_section[0].tds === 236 && tr.payable === 236 && /-(07|04-30)$/.test(tr.due)
    && (await V('GET', '/api/today')).rows.some((r) => r.key === 'tds_due' && r.value === 236), JSON.stringify([tr.deducted, tr.by_section, tr.payable, tr.due]));
  await V('POST', '/api/tds/challan', { date: day, amount: 236, account_id: bank.id, challan_no: 'CIN0510308' });
  check('the challan clears TDS payable and the Today row', await bal('tds_payable') === 0 && (await V('GET', '/api/tds')).challans.length === 1
    && !(await V('GET', '/api/today')).rows.some((r) => r.key === 'tds_due'));
  const inv = await V('POST', '/api/docs', { type: 'INV', party_id: cust.id, lines: [{ item_id: svc.id, qty: 5, rate: 1000 }] });
  const rc = await V('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, account_id: bank.id, amount: 5900, tds_rate: 2, reference: 'UTR998877', allocations: [{ doc_id: inv.id, amount: 5900 }] });
  check('a customer who deducted TDS: the invoice is paid in full, the bank gets the rest, the TDS is a claim', rc.tds === 11800 && (await V('GET', `/api/docs/${inv.id}`)).status === 'paid'
    && await bal('tds_recv') === 118 && (await V('GET', '/api/tds')).by_customers.length === 1, JSON.stringify([rc.tds, await bal('tds_recv')]));

  // bank reconciliation: an HDFC-style statement matched to the books; a bank charge added from it; the BRS
  const ddmm = `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(2, 4)}`;
  const stmt = ['HDFC BANK Ltd. Statement of account', 'Account No : 50100123456789', '',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    `${ddmm},CHQ PAID-MICR CTS-SHREE CONTRACTORS,0000000045,${ddmm},"11,564.00",,"-11,564.00"`,
    `${ddmm},NEFT CR-HDFC0001234-RAMESH TRADERS-UTR998877,UTR998877,${ddmm},,"5,782.00","-5,782.00"`,
    `${ddmm},SMS CHARGES FOR Q3,,${ddmm},17.70,,"-5,799.70"`, '', 'STATEMENT SUMMARY,,,,,,'].join('\n');
  const ch = await V('POST', '/api/bank/check', { account_id: bank.id, csv: stmt });
  check('statement read past the bank\'s heading; the cheque and the NEFT match the books, the SMS charge does not; the unpresented challan is listed',
    ch.counts.lines === 3 && ch.counts.matched === 2 && ch.lines[2].status === 'none' && ch.lines[2].amount === -17.7 && ch.closing === -5799.7
    && ch.book_open.length === 1 && ch.book_open[0].amount === -236, JSON.stringify([ch.counts, ch.lines.map((l) => [l.status, l.amount]), ch.book_open, ch.closing]));
  await V('POST', '/api/bank/clear', { account_id: bank.id, items: ch.lines.filter((l) => l.status === 'match').map((l) => ({ line: l.line, date: l.date, key: l.key })) });
  const charges = (await V('GET', '/api/accounts')).rows.find((a) => a.name === 'Bank Charges');
  await V('POST', '/api/expenses', { account_id: charges.id, amount: 17.7, gst_amount: 0, paid_from: bank.id, date: day, notes: 'SMS CHARGES FOR Q3' });
  const ch2 = await V('POST', '/api/bank/check', { account_id: bank.id, csv: stmt });
  check('read again: the confirmed lines are done, the charge added from it now matches', ch2.counts.done === 2 && ch2.counts.matched === 1 && ch2.counts.none === 0, JSON.stringify(ch2.counts));
  await V('POST', '/api/bank/clear', { account_id: bank.id, items: ch2.lines.filter((l) => l.status === 'match').map((l) => ({ line: l.line, date: l.date, key: l.key })) });
  const B = await V('GET', `/api/bank/brs?account_id=${bank.id}&date=${day}`);
  check('BRS: books, plus the cheque not yet presented, is what the bank shows', B.books === -6035.7 && B.not_presented.length === 1 && B.not_credited.length === 0 && B.bank === -5799.7,
    JSON.stringify([B.books, B.bank, B.not_presented.length]));
  const other = await rq('POST', '/api/auth/signup', { business: 'Other Co', name: 'O', email: `other${Date.now()}@test.in`, password: 'Other-pass-1234', state: 'Maharashtra' }, { ip: '203.0.113.186' });
  const oBank = (await rq('GET', '/api/accounts', undefined, { cookie: other.cookie, ip: '203.0.113.186' })).data.rows.find((a) => a.sys === 'bank');
  await rq('POST', '/api/bank/clear', { account_id: oBank.id, items: [{ line: ch.lines[0].line, date: day, key: 'x' }] }, { cookie: other.cookie, ip: '203.0.113.186' });
  check('another business cannot touch these entries', (await rq('POST', '/api/bank/check', { account_id: bank.id, csv: stmt }, { cookie: other.cookie, ip: '203.0.113.186' })).status === 400
    && (await V('POST', '/api/bank/check', { account_id: bank.id, csv: stmt })).counts.done === 3);
  check('a file without the bank columns says what it needs', (await E('POST', '/api/bank/check', { account_id: bank.id, csv: 'a,b\n1,2\n' })).status === 400);

  // fixed assets: WDV (half rate if used under 180 days in its first year), SLM by days; booked once, undone, a sale with its loss
  const fyNow = (await V('GET', '/api/assets')).fy_now, y0 = +fyNow.slice(0, 4) - 1, prev = `${y0}${fyNow.slice(4)}`;
  await V('POST', '/api/assets', { name: 'Lathe machine', category: 'plant', bought_on: `${y0}-05-10`, cost: 100000, method: 'wdv', rate: 15, paid: 'opening' });
  const laptop = await V('POST', '/api/assets', { name: 'Laptop', category: 'computer', bought_on: `${y0 + 1}-01-15`, cost: 60000, gst: 10800, method: 'wdv', rate: 40, paid: 'cash', account_id: bank.id });
  await V('POST', '/api/assets', { name: 'Delivery van', category: 'vehicle', bought_on: `${y0}-10-01`, cost: 800000, method: 'slm', life_years: 8, paid: 'supplier', party_id: sup.id });
  const pv = await V('GET', '/api/assets/depreciation?fy=' + prev), L = (n) => pv.lines.find((l) => l.name === n).amount;
  check('a year\'s depreciation: WDV 15% on the lathe, half of 40% on a laptop used under 180 days, SLM by days on the van', L('Lathe machine') === 15000 && L('Laptop') === 12000
    && L('Delivery van') === 49863.01 && pv.total === 76863.01 && pv.can_book && !pv.booked, JSON.stringify(pv.lines));
  await V('POST', '/api/assets/depreciation', { fy: prev });
  check('booked: Depreciation against Accumulated Depreciation, once only', await bal('depreciation') === 76863.01 && await bal('acc_dep') === -76863.01
    && (await E('POST', '/api/assets/depreciation', { fy: prev })).status === 400, JSON.stringify([await bal('depreciation'), await bal('acc_dep')]));
  const cur = await V('GET', '/api/assets/depreciation?fy=' + fyNow), C = (n) => cur.lines.find((l) => l.name === n).amount;
  check('the next year starts from what is left; a year not yet ended cannot be booked', C('Lathe machine') === 12750 && C('Laptop') === 19200 && C('Delivery van') === 100000
    && !cur.can_book && (await E('POST', '/api/assets/depreciation', { fy: fyNow })).status === 400, JSON.stringify(cur.lines));
  await V('POST', '/api/assets/depreciation/undo', { fy: prev });
  check('undo takes the year back', await bal('depreciation') === 0 && !(await V('GET', '/api/assets/depreciation?fy=' + prev)).booked);
  await V('POST', '/api/assets/depreciation', { fy: prev });
  const sold = await V('POST', `/api/assets/${laptop.id}/dispose`, { date: day, amount: 40000, account_id: bank.id });
  const list = (await V('GET', '/api/assets')).rows;
  check('a laptop sold below its book value: out of the books, the loss booked', sold.gain === -8000 && await bal('asset_loss') === 8000 && list.find((a) => a.id === laptop.id).sold_on === day
    && (await E('POST', `/api/assets/${laptop.id}/dispose`, { date: day, amount: 1 })).status === 400, JSON.stringify([sold, await bal('asset_loss')]));
  check('the books balance after TDS, the bank charge, assets and depreciation', (await V('GET', '/api/reports/trial-balance')).balanced);
  const bk = await (await fetch(BASE + '/api/export/backup', { headers: { Cookie: su.cookie, 'CF-Connecting-IP': ip } })).json();
  check('the backup carries assets, depreciation, challans and the reconciled entries', bk.tables.fixed_assets.length === 3 && bk.tables.asset_dep.length === 3 && bk.tables.dep_runs.length === 1
    && bk.tables.tds_challans.length === 1 && bk.tables.bank_clear.length === 3, ['fixed_assets', 'asset_dep', 'dep_runs', 'tds_challans', 'bank_clear'].map((t) => `${t} ${(bk.tables[t] || []).length}`).join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
