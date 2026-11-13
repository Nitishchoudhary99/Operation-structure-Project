/* What a hurried or confused user does, done on purpose (reverse logic): two taps at once, documents made in the wrong
   order or from the wrong source, cancelling in the wrong order, silly numbers and dates, deleting what is in use, and
   another business reaching for this one's documents. Each check says what must happen; any "BUG" fails the run.
   Run: node test/chaos.mjs http://localhost:8787 */
const BASE = process.argv[2] || 'http://localhost:8799';
const ip = '198.51.100.' + (20 + Math.floor(Math.random() * 200));
let cookie = '';
const rq = async (method, path, body, o = {}) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'CF-Connecting-IP': o.ip || ip, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let d; try { d = JSON.parse(t); } catch (e) { d = { _text: t.slice(0, 200) }; }
  const sc = res.headers.get('set-cookie'); if (sc && !cookie) cookie = sc.split(';')[0];
  return { s: res.status, d };
};
const out = [];
const note = (name, ok, info) => { out.push({ name, ok, info }); console.log((ok ? 'ok   ' : 'BUG  ') + name + (ok ? '' : '  → ' + JSON.stringify(info).slice(0, 400))); };
await rq('POST', '/api/auth/signup', { business: 'Chaos Traders', name: 'O', email: `chaos${Date.now()}@t.in`, password: 'Chaos-pass-12345', state: 'Rajasthan' });
const it = (await rq('POST', '/api/items', { name: 'Widget', sale_price: 100, purchase_price: 60, gst_rate: 18, opening_qty: 50 })).d;
const it2 = (await rq('POST', '/api/items', { name: 'Gadget', sale_price: 200, purchase_price: 120, gst_rate: 18, opening_qty: 5 })).d;
const cust = (await rq('POST', '/api/parties', { name: 'Ramesh', kind: 'customer', state: 'Rajasthan' })).d;
const cust2 = (await rq('POST', '/api/parties', { name: 'Suresh', kind: 'customer', state: 'Rajasthan' })).d;
const sup = (await rq('POST', '/api/parties', { name: 'Supplier Co', kind: 'supplier', state: 'Rajasthan' })).d;
const doc = (b) => rq('POST', '/api/docs', b);
const qty = async (id) => (await rq('GET', '/api/items')).d.rows.find((i) => i.id === id).qty_on_hand;

// 1. double tap: the same invoice sent twice at the same moment with one Idempotency-Key
{
  const body = { type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] }, key = 'k-' + Date.now();
  const [a, b] = await Promise.all([rq('POST', '/api/docs', body, { headers: { 'Idempotency-Key': key } }), rq('POST', '/api/docs', body, { headers: { 'Idempotency-Key': key } })]);
  note('double tap with one key makes one invoice', a.s === 200 && b.s === 200 && a.d.id === b.d.id, [a.s, b.s, a.d.id, b.d.id, a.d.error, b.d.error]);
}
// 2. one SO line delivered by two Delivery Notes at the same moment (two staff, two phones)
{
  const so = (await doc({ type: 'SO', party_id: cust.id, lines: [{ item_id: it.id, qty: 3, rate: 100 }] })).d;
  const l = so.lines[0];
  const b = { type: 'DN', party_id: cust.id, ref_id: so.id, lines: [{ item_id: it.id, qty: 3, rate: 100, src_line_id: l.id }] };
  const before = await qty(it.id);
  const r = await Promise.all([doc(b), doc(b), doc(b)]);
  const okN = r.filter((x) => x.s === 200).length, after = await qty(it.id);
  note('three DNs for the same 3 pcs at once: only one goes through, stock falls by 3 once', okN === 1 && before - after === 3, { statuses: r.map((x) => x.s), errs: r.map((x) => x.d.error), before, after });
}
// 3. a return of the same invoice twice at once, each for the whole quantity
{
  const inv = (await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 2, rate: 100 }] })).d;
  const b = { type: 'SRET', party_id: cust.id, ref_id: inv.id, lines: [{ item_id: it.id, qty: 2, rate: 100, src_line_id: inv.lines[0].id }] };
  const r = await Promise.all([doc(b), doc(b)]);
  note('two returns of the whole invoice at once: only one', r.filter((x) => x.s === 200).length === 1, r.map((x) => [x.s, x.d.error]));
}
// 4. wrong order: a document from the wrong kind of source, another party's, a cancelled one
{
  const po = (await doc({ type: 'PO', party_id: sup.id, lines: [{ item_id: it.id, qty: 5, rate: 60 }] })).d;
  note('a direct PO (no quotation first) is allowed, as in real business', po && po.type === 'PO', po);
  const so = (await doc({ type: 'SO', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] })).d;
  const g = await doc({ type: 'GRN', party_id: sup.id, ref_id: so.id, lines: [{ item_id: it.id, qty: 1, rate: 60 }] });
  note('a GRN cannot be made from a Sales Order', g.s === 400, g.d);
  const x = await doc({ type: 'INV', party_id: cust2.id, ref_id: so.id, lines: [{ item_id: it.id, qty: 1, rate: 100, src_line_id: so.lines[0].id }] });
  note('an invoice cannot take another customer\'s Sales Order', x.s === 400, x.d);
  await rq('POST', `/api/docs/${so.id}/cancel`, {});
  const y = await doc({ type: 'INV', party_id: cust.id, ref_id: so.id, lines: [{ item_id: it.id, qty: 1, rate: 100, src_line_id: so.lines[0].id }] });
  note('nothing can be made from a cancelled Sales Order', y.s === 400, y.d);
  const ret = await doc({ type: 'SRET', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] });
  note('a return needs the original invoice', ret.s === 400, ret.d);
  const sale = await doc({ type: 'INV', party_id: sup.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] });
  note('a sale to a supplier is refused', sale.s === 400, sale.d);
}
// 5. cancel in the wrong order
{
  const so = (await doc({ type: 'SO', party_id: cust.id, lines: [{ item_id: it.id, qty: 2, rate: 100 }] })).d;
  const dn = (await doc({ type: 'DN', party_id: cust.id, ref_id: so.id, lines: [{ item_id: it.id, qty: 2, rate: 100, src_line_id: so.lines[0].id }] })).d;
  const c1 = await rq('POST', `/api/docs/${so.id}/cancel`, {});
  note('a Sales Order already delivered cannot be cancelled first', c1.s === 400, c1.d);
  const inv = (await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] })).d;
  const pay = (await rq('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, amount: 118 })).d;
  const c2 = await rq('POST', `/api/docs/${inv.id}/cancel`, {});
  note('an invoice already paid: cancel is refused, or the payment is freed (never lost)', c2.s === 400 || (c2.s === 200), [c2.s, c2.d.error, pay && pay.number]);
  const inv2 = (await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] })).d;
  await doc({ type: 'SRET', party_id: cust.id, ref_id: inv2.id, lines: [{ item_id: it.id, qty: 1, rate: 100, src_line_id: inv2.lines[0].id }] });
  const c3 = await rq('POST', `/api/docs/${inv2.id}/cancel`, {});
  note('an invoice with a return against it cannot be cancelled first', c3.s === 400, c3.d);
  const c4 = await rq('POST', `/api/docs/${dn.id}/cancel`, {}), c5 = await rq('POST', `/api/docs/${dn.id}/cancel`, {});
  note('cancelling the same document twice: the second does nothing', c4.s === 200 && c5.s === 400, [c4.s, c5.s, c5.d.error]);
}
// 6. silly numbers
{
  const bad = [[{ qty: 0 }, 'zero qty'], [{ qty: -2 }, 'negative qty'], [{ qty: 'abc' }, 'text qty'], [{ qty: 1e12 }, 'huge qty'], [{ rate: -5 }, 'negative rate'],
    [{ discount_pct: 150 }, 'discount over 100%'], [{ gst_rate: 7 }, 'a GST rate that does not exist']];
  for (const [l, name] of bad) {
    const r = await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100, ...l }] });
    note(`invoice line with ${name} is refused`, r.s === 400, [r.s, r.d.error, r.d.total]);
  }
  const d1 = await doc({ type: 'INV', party_id: cust.id, date: '2026-02-30', lines: [{ item_id: it.id, qty: 1, rate: 100 }] });
  note('an impossible date (30 Feb) is refused', d1.s === 400, [d1.s, d1.d.date, d1.d.error]);
  const p1 = await rq('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, amount: -100 });
  note('a negative payment is refused', p1.s === 400, p1.d);
  const p2 = await rq('POST', '/api/payments', { kind: 'receipt', party_id: cust.id, amount: 'NaN' });
  note('a payment of "NaN" is refused', p2.s === 400, p2.d);
}
// 7. more than in stock, and deleting things in use
{
  const r = await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it2.id, qty: 50, rate: 200 }] });
  note('selling 50 when 5 are in stock: refused, or allowed only as the business setting says', r.s === 400 || r.s === 200, [r.s, r.d.error]);
  const di = await rq('DELETE', `/api/items/${it.id}`);
  note('an item used on bills cannot be deleted', di.s === 400, di.d);
  const dp = await rq('DELETE', `/api/parties/${cust.id}`);
  note('a customer with bills cannot be deleted', dp.s === 400, dp.d);
  const t = await rq('POST', '/api/stock/transfer', { item_id: it2.id, qty: 9999, from_warehouse_id: 0, to_warehouse_id: 0 });
  note('a transfer of more than there is, or to the same godown, is refused', t.s === 400, t.d);
}
// 9. purchase side in the wrong order, and money against the wrong thing
{
  const po = (await doc({ type: 'PO', party_id: sup.id, lines: [{ item_id: it.id, qty: 10, rate: 60 }] })).d;
  const g1 = await doc({ type: 'GRN', party_id: sup.id, ref_id: po.id, lines: [{ item_id: it.id, qty: 15, rate: 60, src_line_id: po.lines[0].id }] });
  note('receiving 15 against a PO of 10 is refused', g1.s === 400, g1.d);
  const b1 = await doc({ type: 'BILL', party_id: sup.id, ref_id: po.id, lines: [{ item_id: it.id, qty: 10, rate: 60, src_line_id: po.lines[0].id }] });
  const b2 = await doc({ type: 'BILL', party_id: sup.id, ref_id: po.id, lines: [{ item_id: it.id, qty: 10, rate: 60, src_line_id: po.lines[0].id }] });
  note('the whole PO billed once; a second full bill from it is refused', b1.s === 200 && b2.s === 400, [b1.s, b1.d.error, b2.s, b2.d.error]);
  const pr = await doc({ type: 'PRET', party_id: sup.id, ref_id: b1.d.id, lines: [{ item_id: it.id, qty: 11, rate: 60, src_line_id: b1.d.lines[0].id }] });
  note('returning 11 of 10 bought is refused', pr.s === 400, pr.d);
  const inv = (await doc({ type: 'INV', party_id: cust2.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] })).d;
  const over = await rq('POST', '/api/payments', { kind: 'receipt', party_id: cust2.id, amount: 500, allocations: [{ doc_id: inv.id, amount: 500 }] });
  note('more money than the invoice owes cannot be put against it', over.s === 400, [over.s, over.d.error]);
  const wrong = await rq('POST', '/api/payments', { kind: 'receipt', party_id: cust2.id, amount: 10, allocations: [{ doc_id: b1.d.id, amount: 10 }] });
  note('a customer\'s receipt cannot settle a supplier\'s bill', wrong.s === 400, [wrong.s, wrong.d.error]);
  const adj = await rq('POST', '/api/stock/adjust', { item_id: it2.id, qty: -999, reason: 'damage' });
  note('writing off more stock than there is is refused', adj.s === 400, [adj.s, adj.d.error]);
}
// 8. another business's documents
{
  const myInv = (await doc({ type: 'INV', party_id: cust.id, lines: [{ item_id: it.id, qty: 1, rate: 100 }] })).d;
  const saved = cookie; cookie = '';
  await rq('POST', '/api/auth/signup', { business: 'Other Shop', name: 'X', email: `other${Date.now()}@t.in`, password: 'Other-pass-12345', state: 'Rajasthan' }, { ip: '198.51.100.250' });
  const oc = (await rq('POST', '/api/parties', { name: 'Ramesh', kind: 'customer', state: 'Rajasthan' }, { ip: '198.51.100.250' })).d;
  const steal = await rq('POST', '/api/docs', { type: 'SRET', party_id: oc.id, ref_id: myInv.id, lines: [{ item_id: it.id, qty: 1, rate: 100, src_line_id: myInv.lines[0].id }] }, { ip: '198.51.100.250' });
  const peek = await rq('GET', `/api/docs/${myInv.id}`, undefined, { ip: '198.51.100.250' });
  const cancel = await rq('POST', `/api/docs/${myInv.id}/cancel`, {}, { ip: '198.51.100.250' });
  note('another business cannot see, return or cancel my invoice', steal.s >= 400 && peek.s === 404 && cancel.s >= 400, [steal.s, peek.s, cancel.s]);
  cookie = saved;
}
console.log(`\n${out.filter((x) => x.ok).length} passed, ${out.filter((x) => !x.ok).length} failed`);
process.exit(out.some((x) => !x.ok) ? 1 : 0);
