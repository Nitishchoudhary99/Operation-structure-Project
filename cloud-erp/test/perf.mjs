/* Speed budgets: D1 calls and rows per screen, for a small business sharing the database with a big one.
     node test/perf.mjs [http://localhost:8787]        (needs QUERY_COUNT=1 in .dev.vars)
   A screen fails when it makes more D1 calls than its budget, reads more rows than its cap, or reads
   more rows after the OTHER business grows (that means some query scans every business's data). */
const BASE = process.argv[2] || process.env.ERP_URL || 'http://localhost:8787';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const octet = () => 1 + Math.floor(Math.random() * 250);

function client() {
  let cookie = '';
  const ip = `10.${octet()}.${octet()}.${octet()}`;           // signup is rate limited per IP
  return async (method, path, body) => {
    const res = await fetch(BASE + path, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: cookie, 'CF-Connecting-IP': ip } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error}`);
    const [read, written] = (res.headers.get('x-rows') || '0/0').split('/').map(Number);
    return { data, q: +res.headers.get('x-query-count'), read, written };
  };
}

async function business(name, nItems, nParties) {
  const api = client();
  await api('POST', '/api/auth/signup', { business: name, name: 'Owner', email: `perf${Date.now()}${octet()}@test.in`, password: 'Str0ng-pass!', state: 'Rajasthan' });
  const b = { api, items: [], parties: [], invoices: [] };
  for (let i = 0; i < nItems; i++) b.items.push((await api('POST', '/api/items', { name: 'Item ' + i, unit: 'Pcs', gst_rate: 18, purchase_price: 100 + i, sale_price: 150 + i, opening_qty: 500, opening_rate: 100 + i, reorder_level: i % 4 ? 0 : 600 })).data);
  for (let i = 0; i < nParties; i++) b.parties.push((await api('POST', '/api/parties', { name: 'Cust ' + i, kind: 'customer', state: i % 3 ? 'Rajasthan' : 'Delhi', credit_days: 15 })).data);
  b.accounts = (await api('GET', '/api/accounts')).data.rows;
  b.cash = b.accounts.find((a) => a.sys === 'cash');
  return b;
}
async function sell(b, n) {                // invoices (half paid at once), khata entries, a receipt
  for (let i = 0; i < n; i++) {
    const lines = [0, 1, 2].map((k) => ({ item_id: b.items[(i * 3 + k) % b.items.length].id, qty: 1 + k }));
    const party = b.parties[i % b.parties.length];
    b.invoices.push((await b.api('POST', '/api/docs', { type: 'INV', party_id: party.id, lines, ...(i % 2 ? {} : { payment: { amount: 50, account_id: b.cash.id } }) })).data);
    if (i % 4 === 0) await b.api('POST', '/api/khata', { party_id: party.id, kind: i % 8 ? 'got' : 'gave', amount: 300 });
  }
  await b.api('POST', '/api/payments', { kind: 'receipt', party_id: b.parties[1].id, account_id: b.cash.id, amount: 100 });
}

// [screen, max D1 calls, max rows read]
const SCREENS = (a) => {
  const party = a.parties[0].id, sales = a.accounts.find((x) => x.sys === 'sales').id, inv = a.invoices[a.invoices.length - 1].id;
  return [
    ['GET /api/me', 1, 10],
    ['GET /api/reports/dashboard', 2, 220],
    ['GET /api/parties', 3, 30],
    ['GET /api/items', 2, 30],
    ['GET /api/warehouses', 2, 40],
    ['GET /api/accounts', 2, 80],
    ['GET /api/docs?type=INV', 2, 50],
    [`GET /api/docs/${inv}`, 6, 30],
    ['GET /api/payments/open?kind=receipt&party_id=' + party, 2, 25],
    ['GET /api/reports/stock', 3, 50],
    ['GET /api/reports/daybook', 2, 450],
    ['GET /api/reports/pnl', 2, 100],
    ['GET /api/reports/balance-sheet', 2, 100],
    ['GET /api/reports/trial-balance', 2, 100],
    ['GET /api/reports/ageing', 2, 40],
    ['GET /api/reports/gst', 2, 210],
    ['GET /api/khata', 2, 40],
    [`GET /api/khata/${party}`, 4, 20],
    [`GET /api/accounts/${sales}/ledger`, 4, 60],
    [`GET /api/parties/${party}/ledger`, 4, 120],
    ['GET /api/audit', 2, 80],
    ['GET /api/plan', 3, 30],
    ['GET /api/today', 2, 60],
  ];
};
async function reads(a) {
  const out = {};
  for (const [s, maxQ, maxRows] of SCREENS(a)) {
    const [method, path] = s.split(' ');
    const r = await a.api(method, path);
    out[s.replace(/\/\d+(?=\/|$)/g, '/:id')] = { q: r.q, read: r.read, maxQ, maxRows };
  }
  return out;
}
async function writes(a) {
  const out = {};
  const lines = [0, 1].map((k) => ({ item_id: a.items[k].id, qty: 1 }));
  const save = await a.api('POST', '/api/docs', { type: 'INV', party_id: a.parties[0].id, lines });
  out['POST /api/docs'] = { q: save.q, read: save.read, maxQ: 12, maxRows: 150, write: true };
  const cancel = await a.api('POST', `/api/docs/${save.data.id}/cancel`, {});
  out['POST /api/docs/:id/cancel'] = { q: cancel.q, read: cancel.read, maxQ: 14, maxRows: 150, write: true };
  return out;
}

const big = await business('Noisy Wholesale', 30, 10);
await sell(big, 40);
const a = await business('Chhoti Dukaan', 6, 3);
await sell(a, 8);
const w1 = await writes(a);
const r1 = await reads(a);
await sell(big, 40);                       // the other business grows; this one does not
const r2 = await reads(a);
const before = { ...r1, ...w1 }, after = { ...r2, ...(await writes(a)) };

console.table(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, { calls: v.q, rows: v.read, rows_before: before[k].read, max_calls: v.maxQ, max_rows: v.maxRows }])));
for (const [k, v] of Object.entries(after)) {
  check(`${k}: ${v.q} D1 calls (max ${v.maxQ})`, v.q <= v.maxQ);
  check(`${k}: ${v.read} rows read (max ${v.maxRows})`, v.read <= v.maxRows);
  // reads: an index range may touch one neighbouring row; writes: the first save and cancel add a little data
  const slack = v.write ? 15 : 3;
  check(`${k}: rows do not grow with another business (${before[k].read} -> ${v.read})`, v.read <= before[k].read + slack);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
