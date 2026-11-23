/* Dukaan Doctor (src/doctor.js) on a small in-memory shop with one known problem of each kind. node test/doctor.mjs */
import { DatabaseSync } from 'node:sqlite';
import { diagnose } from '../src/doctor.js';
import { today, addDays } from '../src/lib.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (info ? '  ' + info : '')); } };
const sq = new DatabaseSync(':memory:');
const db = { prepare: (sql) => ({ bind: (...a) => ({ all: async () => ({ results: sq.prepare(sql).all(...a) }) }) }) };
sq.exec(`CREATE TABLE docs (id INTEGER PRIMARY KEY, org_id INT, type TEXT, status TEXT DEFAULT 'open', party_id INT, date TEXT, total INT, paid INT, created_by INT);
  CREATE TABLE doc_lines (id INTEGER PRIMARY KEY, doc_id INT, item_id INT, qty REAL, rate INT, discount_pct REAL DEFAULT 0, taxable INT, cost INT DEFAULT 0);
  CREATE TABLE items (id INTEGER PRIMARY KEY, org_id INT, name TEXT, unit TEXT, qty_on_hand REAL, avg_cost INT, is_service INT DEFAULT 0, created_at TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);`);
const t = today(), old = addDays(t, -120);
sq.exec(`INSERT INTO users VALUES (1, 'Owner'), (2, 'Ramesh')`);
// items: 1 sells fast with 2 left, 2 dead (50 pcs x ₹200 = ₹10,000), 3 sold below cost
sq.prepare(`INSERT INTO items VALUES (1, 1, 'Sugar 1kg', 'Pcs', 2, 4000, 0, ?), (2, 1, 'Old Lamp', 'Pcs', 50, 20000, 0, ?), (3, 1, 'Oil 1L', 'Pcs', 100, 15000, 0, ?)`).run(old, old, old);
let id = 0;
const bill = (date, party, total, paid, user, lines) => {
  id++; sq.prepare(`INSERT INTO docs (id, org_id, type, party_id, date, total, paid, created_by) VALUES (?, 1, 'INV', ?, ?, ?, ?, ?)`).run(id, party, date, total, paid, user);
  for (const [item, qty, rate, disc, cost] of lines) sq.prepare(`INSERT INTO doc_lines (doc_id, item_id, qty, rate, discount_pct, taxable, cost) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, item, qty, rate, disc, Math.round(qty * rate * (1 - disc / 100)), cost);
};
// udhaar: two old unpaid bills from two customers, ₹30,000 owed in all; one paid old bill; one recent unpaid
bill(addDays(t, -80), 10, 2000000, 0, 1, []); bill(addDays(t, -70), 11, 1500000, 500000, 1, []); bill(addDays(t, -90), 12, 900000, 900000, 1, []); bill(addDays(t, -5), 13, 800000, 0, 1, []);
// sugar: 60 sold in 30 days (2/day), 2 left -> 1 day; Ramesh gives 20% off, the owner 0%; oil sold at ₹100 that cost ₹150
for (let i = 0; i < 12; i++) bill(addDays(t, -i - 1), 1, 0, 0, 1, [[1, 3, 50000, 0, 12000]]);
for (let i = 0; i < 12; i++) bill(addDays(t, -i - 1), 1, 0, 0, 2, [[1, 2, 50000, 20, 8000]]);
bill(addDays(t, -3), 1, 0, 0, 1, [[3, 10, 10000, 0, 150000]]);
const run = (role, opt) => diagnose({ db, org: { id: 1 }, user: { role } }, opt);
const all = await run('owner', { costs: true, sales: true, stock: true });
const f = (k) => all.find((x) => x.k === k) || {};
check('udhaar: ₹30,000 stuck with 2 customers over 60 days (paid and recent bills left out)', f('udhaar').amount === 3000000 && /2 customers/.test(f('udhaar').title), JSON.stringify(f('udhaar')));
check('run-out: sugar has about a day left, oil and the lamp are fine', f('runout').items && f('runout').items.length === 1 && f('runout').items[0].name === 'Sugar 1kg' && /~1 day left/.test(f('runout').detail), JSON.stringify(f('runout')));
check('dead stock: the lamp, ₹10,000 at cost', f('dead').amount === 1000000, JSON.stringify(f('dead')));
check('below cost: oil sold ₹500 under cost', f('loss').amount === 50000 && f('loss').level === 'high', JSON.stringify(f('loss')));
check('discount: Ramesh 20% against the owner 0%', /Ramesh gave 20\.0%/.test(f('discount').title || ''), JSON.stringify(f('discount')));
check('most serious first', all[0].level === 'high' && all.every((x, i) => !i || !(x.level === 'high' && all[i - 1].level === 'mid')));
const cashier = await run('sales', { costs: false, sales: true, stock: true });
check('a role that cannot see costs gets no cost-based findings', !cashier.some((x) => ['dead', 'loss'].includes(x.k)) && cashier.some((x) => x.k === 'udhaar'));
check('only owners and admins see who gave discounts', !cashier.some((x) => x.k === 'discount'));
const store = await run('store', { costs: false, sales: false, stock: true });
check('a stock-only role does not see money owed', !store.some((x) => x.k === 'udhaar') && store.some((x) => x.k === 'runout'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
