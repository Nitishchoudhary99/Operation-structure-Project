/* SmartTrader Cloud ERP - Cloudflare Worker.
   /api/*  -> JSON API (this file)
   anything else -> the web app in /public (Workers static assets, single-page app) */
import { migrate, DEFAULT_ACCOUNTS } from './schema.js';
import {
  HttpError, bad, notFound, forbidden, json, readJson, str, reqStr, num, int, date, nowIso, oneOf, toPaise, Router, GST_RATES, today,
} from './lib.js';
import {
  hashPassword, randomHex, sameText, passwordProblem, issueSession, sessionCookie, clearCookie, currentUser, ROLES, can, requireCan, rateLimit,
} from './auth.js';
import {
  DOC_TYPES, loadSys, createDoc, cancelDoc, createPayment, voidPayment, stockAdjust, stockTransfer, createExpense, createJournal, partyOpening,
  auditStatement, cashAccount,
} from './engine.js';
import * as rep from './reports.js';
import { PLANS, planOut, usage, checkCount, requireFeature, redeemCode, makeCode, extendPlan, adminKey, trialUntil } from './saas.js';
import { STATES, einvoiceJson, ewaybillJson } from './gst.js';
import { tallyXml } from './tally.js';

const R = (p) => Math.round(p) / 100;
const router = new Router();
let migrated = false;

/* ======================================================================= auth */
router.add('POST', '/api/auth/signup', async (c) => {
  const b = c.body;
  const ip = c.request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(c.env, 'signup:' + ip, 5, 3600);
  const business = reqStr(b.business, 'Business name', 120);
  const name = reqStr(b.name, 'Your name', 80);
  const email = reqStr(b.email, 'Email', 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('Please enter a valid email address.');
  const prob = passwordProblem(b.password);
  if (prob) throw bad(prob);
  if (await c.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()) throw bad('An account with this email already exists. Sign in instead.');
  const salt = randomHex(16), hash = await hashPassword(b.password, salt), now = nowIso(), otx = crypto.randomUUID();
  const db = c.db;
  const st = [
    db.prepare(`INSERT INTO orgs (name, gstin, state, phone, address, email, plan, plan_until, created_at) VALUES (?, ?, ?, ?, ?, ?, 'growth', ?, ?)`)
      .bind(business, str(b.gstin, 15).toUpperCase(), str(b.state, 60), str(b.phone, 20), str(b.address, 300), email, trialUntil(), otx),
    db.prepare(`INSERT INTO users (org_id, email, name, role, pw_hash, salt, pw_changed_at, created_at)
                VALUES ((SELECT id FROM orgs WHERE created_at = ?), ?, ?, 'owner', ?, ?, ?, ?)`).bind(otx, email, name, hash, salt, Date.now(), now),
    ...DEFAULT_ACCOUNTS.map(([code, nm, type, sys, isCash]) => db.prepare(`INSERT INTO accounts (org_id, code, name, type, sys, is_cash)
                VALUES ((SELECT id FROM orgs WHERE created_at = ?), ?, ?, ?, ?, ?)`).bind(otx, code, nm, type, sys, isCash)),
    db.prepare(`INSERT INTO warehouses (org_id, name) VALUES ((SELECT id FROM orgs WHERE created_at = ?), 'Main Store')`).bind(otx),
    db.prepare(`INSERT INTO parties (org_id, name, kind, state, created_at) VALUES ((SELECT id FROM orgs WHERE created_at = ?), 'Walk-in Customer', 'customer', ?, ?)`)
      .bind(otx, str(b.state, 60), now),
    db.prepare(`UPDATE orgs SET created_at = ? WHERE created_at = ?`).bind(now, otx),
  ];
  await db.batch(st);
  const user = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
  const token = await issueSession(c.env, user);
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
}, { public: true });

router.add('POST', '/api/auth/login', async (c) => {
  const email = str(c.body.email, 120).toLowerCase();
  await rateLimit(c.env, 'login:' + email, 10, 900);
  const user = await c.db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
  const hash = await hashPassword(c.body.password || '', user ? user.salt : 'no-such-user-salt');
  if (!user || !user.active || !sameText(hash, user.pw_hash)) throw new HttpError(401, 'Incorrect email or password.');
  const token = await issueSession(c.env, user);
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
}, { public: true });

router.add('POST', '/api/auth/logout', async () => json({ ok: true }, 200, { 'Set-Cookie': clearCookie() }), { public: true });

router.add('GET', '/api/me', async (c) => json({
  user: publicUser(c.user), org: c.org,
  can: Object.fromEntries(['settings', 'users', 'items', 'purchase', 'sales', 'stock', 'finance', 'khata'].map((a) => [a, can(c.user, a)])),
  doc_types: Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [k, { label: v.label, side: v.side, from: v.from, prefix: v.prefix }])),
  gst_rates: GST_RATES, today: today(), states: STATES.map(([, n]) => n), plan: planOut(c.org),
}));

router.add('POST', '/api/me/password', async (c) => {
  const u = await c.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(c.user.id).first();
  if (!sameText(await hashPassword(c.body.current || '', u.salt), u.pw_hash)) throw bad('Your current password is not correct.');
  const prob = passwordProblem(c.body.password);
  if (prob) throw bad(prob);
  const salt = randomHex(16), now = Date.now();
  await c.db.prepare(`UPDATE users SET pw_hash = ?, salt = ?, pw_changed_at = ? WHERE id = ?`).bind(await hashPassword(c.body.password, salt), salt, now, u.id).run();
  const token = await issueSession(c.env, { ...u, pw_changed_at: now });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
});

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

/* ======================================================================= business settings & users */
router.add('PUT', '/api/org', async (c) => {
  requireCan(c.user, 'settings');
  const b = c.body;
  await c.db.prepare(`UPDATE orgs SET name = ?, gstin = ?, state = ?, address = ?, phone = ?, upi_id = ?, fy_start = ?, city = ?, pincode = ?, email = ? WHERE id = ?`)
    .bind(reqStr(b.name, 'Business name', 120), str(b.gstin, 15).toUpperCase(), str(b.state, 60), str(b.address, 300), str(b.phone, 20),
      str(b.upi_id, 60), /^\d{2}-\d{2}$/.test(b.fy_start || '') ? b.fy_start : c.org.fy_start, str(b.city, 60), str(b.pincode, 6).replace(/\D/g, ''),
      str(b.email, 120), c.org.id).run();
  return json({ ok: true });
});

router.add('GET', '/api/users', async (c) => {
  requireCan(c.user, 'users');
  const { results } = await c.db.prepare(`SELECT id, email, name, role, active, created_at FROM users WHERE org_id = ? ORDER BY id`).bind(c.org.id).all();
  return json({ rows: results, roles: ROLES });
});
router.add('POST', '/api/users', async (c) => {
  requireCan(c.user, 'users');
  const email = reqStr(c.body.email, 'Email', 120).toLowerCase();
  const role = oneOf(c.body.role, ROLES.filter((r) => r !== 'owner'), 'Role');
  const prob = passwordProblem(c.body.password);
  if (prob) throw bad(prob);
  if (await c.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()) throw bad('This email is already in use.');
  await checkCount(c.db, c.org, 'users');
  const salt = randomHex(16);
  await c.db.batch([c.db.prepare(`INSERT INTO users (org_id, email, name, role, pw_hash, salt, pw_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.org.id, email, reqStr(c.body.name, 'Name', 80), role, await hashPassword(c.body.password, salt), salt, Date.now(), nowIso()),
  auditStatement(c, 'add user', `${email} ${role}`)]);
  return json({ ok: true });
});
router.add('PUT', '/api/users/:id', async (c) => {
  requireCan(c.user, 'users');
  const u = await c.db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!u) throw notFound('User not found.');
  if (u.role === 'owner') throw bad('The owner cannot be changed here.');
  const role = c.body.role ? oneOf(c.body.role, ROLES.filter((r) => r !== 'owner'), 'Role') : u.role;
  const active = c.body.active === undefined ? u.active : (c.body.active ? 1 : 0);
  if (active && !u.active) await checkCount(c.db, c.org, 'users');
  await c.db.prepare(`UPDATE users SET role = ?, active = ?, pw_changed_at = CASE WHEN ? != active THEN ? ELSE pw_changed_at END WHERE id = ?`)
    .bind(role, active, active, Date.now(), u.id).run();
  return json({ ok: true });
});

/* ======================================================================= parties */
const partyFields = (b) => ({
  name: reqStr(b.name, 'Name', 120), kind: oneOf(b.kind || 'customer', ['customer', 'supplier', 'both'], 'Type'),
  phone: str(b.phone, 20), email: str(b.email, 120), gstin: str(b.gstin, 15).toUpperCase(), state: str(b.state, 60), address: str(b.address, 300),
  credit_limit: toPaise(num(b.credit_limit, 'Credit limit', { min: 0, def: 0 })), credit_days: int(b.credit_days, 'Credit days', { min: 0, max: 365, def: 0 }),
  city: str(b.city, 60), pincode: str(b.pincode, 6).replace(/\D/g, ''),
});
router.add('GET', '/api/parties', async (c) => {
  const q = c.url.searchParams;
  const kind = q.get('kind');
  const { results } = await c.db.prepare(`SELECT * FROM parties WHERE org_id = ? ${kind === 'customer' ? "AND kind IN ('customer','both')" : kind === 'supplier' ? "AND kind IN ('supplier','both')" : ''}
      AND (? = '' OR name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 1000`).bind(c.org.id, q.get('q') || '', `%${q.get('q') || ''}%`, `%${q.get('q') || ''}%`).all();
  const bal = await rep.partyBalances(c.db, c.org.id);
  return json({ rows: results.map((p) => {
    const b = bal[p.id] || 0;
    return { ...p, credit_limit: R(p.credit_limit), balance: R(b), over_limit: p.credit_limit > 0 && b > p.credit_limit };
  }) });
});
router.add('POST', '/api/parties', async (c) => {
  requireCan(c.user, 'masters');
  const f = partyFields(c.body);
  if (await c.db.prepare(`SELECT 1 FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, f.name).first()) throw bad(`A party called ${f.name} already exists.`);
  const r = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, email, gstin, state, address, credit_limit, credit_days, city, pincode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(c.org.id, f.name, f.kind, f.phone, f.email, f.gstin, f.state, f.address, f.credit_limit, f.credit_days, f.city, f.pincode, nowIso()).first();
  return json({ ...r, credit_limit: R(r.credit_limit) });
});
router.add('PUT', '/api/parties/:id', async (c) => {
  requireCan(c.user, 'masters');
  const f = partyFields(c.body);
  const dup = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ? AND id != ?`).bind(c.org.id, f.name, +c.params.id).first();
  if (dup) throw bad(`A party called ${f.name} already exists.`);
  const r = await c.db.prepare(`UPDATE parties SET name = ?, kind = ?, phone = ?, email = ?, gstin = ?, state = ?, address = ?, credit_limit = ?, credit_days = ?, city = ?, pincode = ?
      WHERE id = ? AND org_id = ?`).bind(f.name, f.kind, f.phone, f.email, f.gstin, f.state, f.address, f.credit_limit, f.credit_days, f.city, f.pincode, +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Party not found.');
  return json({ ok: true });
});
router.add('DELETE', '/api/parties/:id', async (c) => {
  requireCan(c.user, 'masters');
  const id = +c.params.id;
  const used = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM docs WHERE party_id = ?) + (SELECT COUNT(*) FROM journal_lines WHERE party_id = ?)
      + (SELECT COUNT(*) FROM khata WHERE party_id = ?) + (SELECT COUNT(*) FROM payments WHERE party_id = ?) AS n`).bind(id, id, id, id).first();
  if (used.n) throw bad('This party has transactions and cannot be deleted.');
  await c.db.prepare(`DELETE FROM parties WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
  return json({ ok: true });
});
router.add('POST', '/api/parties/:id/opening', async (c) => json(await partyOpening(c, +c.params.id, c.body)));
router.add('GET', '/api/parties/:id/ledger', async (c) => json(await rep.partyLedger(c.db, c.org, +c.params.id, c.url.searchParams)));

/* ======================================================================= items & warehouses */
const itemFields = (b) => ({
  name: reqStr(b.name, 'Item name', 120), sku: str(b.sku, 40), category: str(b.category, 60), unit: str(b.unit, 12) || 'Pcs', hsn: str(b.hsn, 10),
  gst_rate: num(b.gst_rate, 'GST rate', { min: 0, max: 100, def: 0 }),
  purchase_price: toPaise(num(b.purchase_price, 'Purchase price', { min: 0, def: 0 })), sale_price: toPaise(num(b.sale_price, 'Sale price', { min: 0, def: 0 })),
  reorder_level: num(b.reorder_level, 'Reorder level', { min: 0, def: 0 }), is_service: b.is_service ? 1 : 0,
  barcode: str(b.barcode, 48).replace(/\s+/g, ''),
});
async function barcodeTaken(c, code, exceptId = 0) {
  if (!code) return;
  const hit = await c.db.prepare(`SELECT name FROM items WHERE org_id = ? AND id != ? AND (barcode = ? OR (sku != '' AND sku = ?))`).bind(c.org.id, exceptId, code, code).first();
  if (hit) throw bad(`Barcode ${code} is already used by ${hit.name}.`);
}
const itemOut = (i) => ({ ...i, purchase_price: R(i.purchase_price), sale_price: R(i.sale_price), avg_cost: R(i.avg_cost), stock_value: R(Math.max(0, i.qty_on_hand) * i.avg_cost) });
router.add('GET', '/api/items', async (c) => {
  const q = c.url.searchParams.get('q') || '';
  const { results } = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND (? = '' OR name LIKE ? OR sku LIKE ?) ORDER BY name LIMIT 2000`)
    .bind(c.org.id, q, `%${q}%`, `%${q}%`).all();
  return json({ rows: results.map(itemOut) });
});
router.add('POST', '/api/items', async (c) => {
  requireCan(c.user, 'items');
  const f = itemFields(c.body);
  if (await c.db.prepare(`SELECT 1 FROM items WHERE org_id = ? AND name = ?`).bind(c.org.id, f.name).first()) throw bad(`An item called ${f.name} already exists.`);
  await barcodeTaken(c, f.barcode);
  const r = await c.db.prepare(`INSERT INTO items (org_id, sku, name, category, unit, hsn, gst_rate, purchase_price, sale_price, reorder_level, is_service, avg_cost, barcode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price, f.sale_price, f.reorder_level, f.is_service, f.purchase_price, f.barcode, nowIso()).first();
  if (c.body.opening_qty && +c.body.opening_qty > 0 && !f.is_service) {
    await stockAdjust(c, { item_id: r.id, qty: c.body.opening_qty, rate: c.body.opening_rate ?? R(f.purchase_price), reason: 'opening', warehouse_id: c.body.warehouse_id });
  }
  return json(itemOut(await c.db.prepare(`SELECT * FROM items WHERE id = ?`).bind(r.id).first()));
});
router.add('PUT', '/api/items/:id', async (c) => {
  requireCan(c.user, 'items');
  const f = itemFields(c.body);
  const dup = await c.db.prepare(`SELECT id FROM items WHERE org_id = ? AND name = ? AND id != ?`).bind(c.org.id, f.name, +c.params.id).first();
  if (dup) throw bad(`An item called ${f.name} already exists.`);
  await barcodeTaken(c, f.barcode, +c.params.id);
  const r = await c.db.prepare(`UPDATE items SET sku = ?, name = ?, category = ?, unit = ?, hsn = ?, gst_rate = ?, purchase_price = ?, sale_price = ?, reorder_level = ?, barcode = ?
      WHERE id = ? AND org_id = ?`).bind(f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price, f.sale_price, f.reorder_level, f.barcode, +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Item not found.');
  return json({ ok: true });
});
router.add('DELETE', '/api/items/:id', async (c) => {
  requireCan(c.user, 'items');
  const id = +c.params.id;
  const used = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM doc_lines WHERE item_id = ?) + (SELECT COUNT(*) FROM stock_moves WHERE item_id = ?) AS n`).bind(id, id).first();
  if (used.n) throw bad('This item has transactions and cannot be deleted.');
  await c.db.prepare(`DELETE FROM items WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
  return json({ ok: true });
});
/* Scanner lookup: barcode, SKU, or the printed label code ST<id> */
router.add('GET', '/api/items/lookup', async (c) => {
  const code = str(c.url.searchParams.get('code'), 60).replace(/\s+/g, '');
  if (!code) throw bad('Scan or type a code.');
  const m = code.toUpperCase().match(/^ST(\d+)$/);
  const it = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND (barcode = ? OR (sku != '' AND sku = ?) OR id = ?) ORDER BY barcode = ? DESC LIMIT 1`)
    .bind(c.org.id, code, code, m ? +m[1] : -1, code).first();
  if (!it) throw notFound(`No item with code ${code}.`);
  return json(itemOut(it));
});
router.add('GET', '/api/items/:id/moves', async (c) => json({ rows: await rep.itemMoves(c.db, c.org, +c.params.id) }));

router.add('GET', '/api/warehouses', async (c) => {
  const { results } = await c.db.prepare(`SELECT w.*, COALESCE((SELECT SUM(s.qty * i.avg_cost) FROM stock s JOIN items i ON i.id = s.item_id WHERE s.warehouse_id = w.id AND s.qty > 0), 0) AS value
      FROM warehouses w WHERE w.org_id = ? ORDER BY w.id`).bind(c.org.id).all();
  return json({ rows: results.map((w) => ({ ...w, value: R(w.value) })) });
});
router.add('POST', '/api/warehouses', async (c) => {
  requireCan(c.user, 'stock');
  const name = reqStr(c.body.name, 'Warehouse name', 80);
  if (await c.db.prepare(`SELECT 1 FROM warehouses WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first()) throw bad('That warehouse already exists.');
  await checkCount(c.db, c.org, 'warehouses');
  return json(await c.db.prepare(`INSERT INTO warehouses (org_id, name) VALUES (?, ?) RETURNING *`).bind(c.org.id, name).first());
});

/* ======================================================================= accounts */
router.add('GET', '/api/accounts', async (c) => {
  const { results } = await c.db.prepare(`SELECT a.*, COALESCE(SUM(jl.debit - jl.credit), 0) AS bal FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id WHERE a.org_id = ? GROUP BY a.id ORDER BY a.code`).bind(c.org.id).all();
  return json({ rows: results.map((a) => ({ ...a, balance: R(['asset', 'expense'].includes(a.type) ? a.bal : -a.bal) })) });
});
router.add('POST', '/api/accounts', async (c) => {
  requireCan(c.user, 'finance');
  const code = reqStr(c.body.code, 'Code', 10), name = reqStr(c.body.name, 'Name', 80);
  const type = oneOf(c.body.type, ['asset', 'liability', 'equity', 'income', 'expense'], 'Type');
  if (await c.db.prepare(`SELECT 1 FROM accounts WHERE org_id = ? AND code = ?`).bind(c.org.id, code).first()) throw bad('That account code is in use.');
  return json(await c.db.prepare(`INSERT INTO accounts (org_id, code, name, type, is_cash) VALUES (?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, code, name, type, type === 'asset' && c.body.is_cash ? 1 : 0).first());
});
router.add('GET', '/api/accounts/:id/ledger', async (c) => json(await rep.accountLedger(c.db, c.org, +c.params.id, c.url.searchParams)));

/* ======================================================================= documents */
router.add('GET', '/api/docs', async (c) => {
  const q = c.url.searchParams;
  const where = ['d.org_id = ?'], args = [c.org.id];
  if (q.get('type')) { where.push('d.type = ?'); args.push(q.get('type').toUpperCase()); }
  if (q.get('status')) { where.push('d.status = ?'); args.push(q.get('status')); }
  if (q.get('party_id')) { where.push('d.party_id = ?'); args.push(+q.get('party_id')); }
  if (q.get('from')) { where.push('d.date >= ?'); args.push(date(q.get('from'))); }
  if (q.get('to')) { where.push('d.date <= ?'); args.push(date(q.get('to'))); }
  if (q.get('q')) { where.push('(d.number LIKE ? OR p.name LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  const limit = Math.min(500, +q.get('limit') || 100), offset = Math.max(0, +q.get('offset') || 0);
  const { results } = await c.db.prepare(`SELECT d.id, d.type, d.number, d.date, d.due_date, d.status, d.total, d.paid, d.taxable, d.ref_id, p.name AS party
      FROM docs d LEFT JOIN parties p ON p.id = d.party_id WHERE ${where.join(' AND ')} ORDER BY d.date DESC, d.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset).all();
  return json({ rows: results.map((r) => ({ ...r, total: R(r.total), paid: R(r.paid), taxable: R(r.taxable), balance: R(r.total - r.paid) })) });
});

async function docDetail(c, id) {
  const d = await c.db.prepare(`SELECT d.*, w.name AS warehouse FROM docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id WHERE d.id = ? AND d.org_id = ?`).bind(id, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  const [lines, party, children, parent, pays] = await Promise.all([
    c.db.prepare(`SELECT l.*, i.name AS item, i.unit, i.hsn, i.is_service FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ? ORDER BY l.id`).bind(id).all(),
    c.db.prepare(`SELECT * FROM parties WHERE id = ?`).bind(d.party_id).first(),
    c.db.prepare(`SELECT id, type, number, date, status, total FROM docs WHERE ref_id = ? ORDER BY id`).bind(id).all(),
    d.ref_id ? c.db.prepare(`SELECT id, type, number, date, status FROM docs WHERE id = ?`).bind(d.ref_id).first() : null,
    c.db.prepare(`SELECT pa.amount, pa.note_id, p.id, p.number, p.date, p.kind, n.number AS note_number FROM payment_allocs pa
        LEFT JOIN payments p ON p.id = pa.payment_id LEFT JOIN docs n ON n.id = pa.note_id WHERE pa.doc_id = ?`).bind(id).all(),
  ]);
  const money = (x) => R(x);
  return {
    ...d, taxable: money(d.taxable), cgst: money(d.cgst), sgst: money(d.sgst), igst: money(d.igst), round_off: money(d.round_off),
    total: money(d.total), paid: money(d.paid), balance: money(d.total - d.paid), label: DOC_TYPES[d.type].label,
    party, parent, children: children.results.map((x) => ({ ...x, total: money(x.total) })),
    settlements: pays.results.map((p) => ({ ...p, amount: money(p.amount), number: p.number || p.note_number })),
    lines: lines.results.map((l) => ({ ...l, rate: money(l.rate), taxable: money(l.taxable), cgst: money(l.cgst), sgst: money(l.sgst), igst: money(l.igst),
      total: money(l.total), cost: money(l.cost), remaining: Math.round((l.qty - l.done_qty) * 1000) / 1000 })),
    org: c.org,
  };
}
router.add('GET', '/api/docs/:id', async (c) => json(await docDetail(c, +c.params.id)));
router.add('POST', '/api/docs', async (c) => json(await docDetail(c, (await createDoc(c, c.body)).id)));
router.add('POST', '/api/docs/:id/cancel', async (c) => { await cancelDoc(c, +c.params.id); return json(await docDetail(c, +c.params.id)); });

/* A ready-to-post draft of the next document in the chain, with the quantities still open. */
router.add('GET', '/api/docs/:id/convert', async (c) => {
  const src = await docDetail(c, +c.params.id);
  const to = (c.url.searchParams.get('to') || '').toUpperCase();
  const T = DOC_TYPES[to];
  if (!T || !T.from.includes(src.type)) throw bad(`Cannot make a ${to} from a ${src.type}.`);
  const lines = src.lines.filter((l) => l.remaining > 0.0005).map((l) => ({
    item_id: l.item_id, item: l.item, unit: l.unit, description: l.description, qty: l.remaining, rate: l.rate,
    discount_pct: l.discount_pct, gst_rate: l.gst_rate, src_line_id: l.id,
  }));
  if (!lines.length) throw bad(`Nothing left to ${['SRET', 'PRET'].includes(to) ? 'return' : 'process'} on ${src.number}.`);
  return json({ type: to, party_id: src.party_id, ref_id: src.id, ref_number: src.number, warehouse_id: src.warehouse_id, date: today(), lines });
});

/* GST portal files: e-invoice (IRP) and e-way bill JSON, and the numbers the portal gives back */
const download = (name, body, type = 'application/json') => new Response(body, { headers: {
  'Content-Type': type + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
router.add('GET', '/api/docs/:id/einvoice', async (c) => {
  requireFeature(c.org, 'einvoice');
  const d = await docDetail(c, +c.params.id);
  return download(`einvoice-${d.number}.json`, JSON.stringify([einvoiceJson(d)], null, 2));
});
router.add('GET', '/api/docs/:id/ewaybill', async (c) => {
  requireFeature(c.org, 'einvoice');
  const d = await docDetail(c, +c.params.id);
  return download(`ewaybill-${d.number}.json`, JSON.stringify(ewaybillJson(d, Object.fromEntries(c.url.searchParams)), null, 2));
});
router.add('PUT', '/api/docs/:id/gst-refs', async (c) => {
  requireCan(c.user, 'sales');
  const b = c.body;
  const r = await c.db.prepare(`UPDATE docs SET irn = ?, ack_no = ?, ack_date = ?, ewb_no = ?, ewb_date = ? WHERE id = ? AND org_id = ?`)
    .bind(str(b.irn, 64), str(b.ack_no, 20), str(b.ack_date, 30), str(b.ewb_no, 20), str(b.ewb_date, 30), +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Document not found.');
  return json({ ok: true });
});
router.add('GET', '/api/export/tally', async (c) => {
  requireFeature(c.org, 'tally');
  const t = await tallyXml(c.db, c.org, c.url.searchParams);
  return download(`tally-${t.from}-to-${t.to}.xml`, t.xml, 'application/xml');
});

/* ======================================================================= plan & billing (SaaS) */
router.add('GET', '/api/plan', async (c) => json({
  plan: planOut(c.org), usage: await usage(c.db, c.org),
  plans: Object.entries(PLANS).map(([k, p]) => ({ key: k, ...p, invoices_per_month: p.invoices_per_month === Infinity ? null : p.invoices_per_month,
    users: p.users === Infinity ? null : p.users, warehouses: p.warehouses === Infinity ? null : p.warehouses })),
  pay_upi: c.env.PAY_UPI || '', pay_name: c.env.PAY_NAME || 'SmartTrader', support_whatsapp: c.env.SUPPORT_WHATSAPP || '',
}));
router.add('POST', '/api/plan/activate', async (c) => {
  requireCan(c.user, 'settings');
  await rateLimit(c.env, 'code:' + c.org.id, 10, 3600);
  const r = await redeemCode(c.env, c.db, c.org, c.body.code);
  await c.db.batch([auditStatement(c, 'activate plan', `${r.plan} ${r.months} months`)]);
  return json({ ok: true, ...r });
});

/* Admin (the person who runs this deployment): header X-Admin-Key must equal the ADMIN_KEY secret. */
async function requireAdmin(c) {
  const key = adminKey(c.env);
  if (!key) throw new HttpError(404, 'Admin is switched off. Add an ADMIN_KEY secret (16+ characters) to the worker to use it.');
  await rateLimit(c.env, 'admin:' + (c.request.headers.get('CF-Connecting-IP') || 'local'), 60, 600);
  if (!sameText(c.request.headers.get('X-Admin-Key') || '', key)) throw new HttpError(401, 'Wrong admin key.');
}
router.add('GET', '/api/admin/orgs', async (c) => {
  await requireAdmin(c);
  const { results } = await c.db.prepare(`SELECT o.id, o.name, o.gstin, o.state, o.phone, o.plan, o.plan_until, o.created_at,
      (SELECT email FROM users WHERE org_id = o.id AND role = 'owner' LIMIT 1) AS owner,
      (SELECT COUNT(*) FROM users WHERE org_id = o.id AND active = 1) AS users,
      (SELECT COUNT(*) FROM docs WHERE org_id = o.id AND type = 'INV') AS invoices,
      (SELECT MAX(at) FROM audit WHERE org_id = o.id) AS last_active
    FROM orgs o ORDER BY o.id DESC LIMIT 1000`).all();
  return json({ rows: results.map((o) => ({ ...o, effective: planOut(o).key })), plans: Object.keys(PLANS) });
}, { public: true });
router.add('POST', '/api/admin/orgs/:id/plan', async (c) => {
  await requireAdmin(c);
  const org = await c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(+c.params.id).first();
  if (!org) throw notFound('Business not found.');
  const plan = oneOf(c.body.plan, Object.keys(PLANS), 'Plan');
  const until = await extendPlan(c.db, org, plan, int(c.body.months, 'Months', { min: 1, max: 1200, def: 12 }));
  return json({ ok: true, plan, until });
}, { public: true });
router.add('POST', '/api/admin/codes', async (c) => {
  await requireAdmin(c);
  const plan = oneOf(c.body.plan, Object.keys(PLANS).filter((k) => k !== 'free'), 'Plan');
  const months = int(c.body.months, 'Months', { min: 1, max: 120, def: 12 }), count = int(c.body.count, 'Count', { min: 1, max: 50, def: 1 });
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(await makeCode(c.env, plan, months));
  return json({ codes, plan, months });
}, { public: true });

/* ======================================================================= payments, expenses, journals */
router.add('GET', '/api/payments', async (c) => {
  const q = c.url.searchParams;
  const { results } = await c.db.prepare(`SELECT p.*, pt.name AS party, a.name AS account FROM payments p JOIN parties pt ON pt.id = p.party_id
      JOIN accounts a ON a.id = p.account_id WHERE p.org_id = ? AND (? = '' OR p.kind = ?) ORDER BY p.date DESC, p.id DESC LIMIT 300`)
    .bind(c.org.id, q.get('kind') || '', q.get('kind') || '').all();
  return json({ rows: results.map((p) => ({ ...p, amount: R(p.amount), void: (p.notes || '').startsWith('[void]') })) });
});
router.add('GET', '/api/payments/open', async (c) => {
  const q = c.url.searchParams;
  const { results } = await c.db.prepare(`SELECT id, number, date, due_date, total, paid FROM docs WHERE org_id = ? AND party_id = ? AND type = ?
      AND status IN ('unpaid','partial') ORDER BY due_date, id`).bind(c.org.id, +q.get('party_id') || 0, q.get('kind') === 'payment' ? 'BILL' : 'INV').all();
  return json({ rows: results.map((d) => ({ ...d, total: R(d.total), balance: R(d.total - d.paid) })) });
});
router.add('POST', '/api/payments', async (c) => json(await createPayment(c, c.body)));
router.add('POST', '/api/payments/:id/void', async (c) => { await voidPayment(c, +c.params.id); return json({ ok: true }); });
router.add('POST', '/api/expenses', async (c) => json(await createExpense(c, c.body)));
router.add('POST', '/api/journals', async (c) => json(await createJournal(c, c.body)));
router.add('POST', '/api/stock/adjust', async (c) => json(await stockAdjust(c, c.body)));
router.add('POST', '/api/stock/transfer', async (c) => json(await stockTransfer(c, c.body)));

/* ======================================================================= khata (Khatabook-style credit book)
   Trust rules: a new entry stays PENDING and does not count until it has been sent to the customer on
   WhatsApp or SMS. Sent entries can never be edited or deleted, only reversed by a new (also sent) entry.
   Every message carries a private link where the customer sees their full khata and can confirm or dispute
   each entry, so neither side can quietly change the record. */
const KHATA_BAL = `COALESCE(SUM(CASE WHEN k.status = 'sent' THEN (CASE WHEN k.kind = 'gave' THEN k.amount ELSE -k.amount END) ELSE 0 END), 0)`;
const rs = (p) => 'Rs ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fd = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

async function khataToken(c, partyId) {
  const p = await c.db.prepare(`SELECT khata_token FROM parties WHERE id = ?`).bind(partyId).first();
  if (p && p.khata_token) return p.khata_token;
  const t = randomHex(12);
  await c.db.prepare(`UPDATE parties SET khata_token = ? WHERE id = ? AND (khata_token IS NULL OR khata_token = '')`).bind(t, partyId).run();
  return (await c.db.prepare(`SELECT khata_token FROM parties WHERE id = ?`).bind(partyId).first()).khata_token;
}
async function khataBalance(c, partyId) {
  return (await c.db.prepare(`SELECT ${KHATA_BAL} AS b FROM khata k WHERE k.party_id = ?`).bind(partyId).first()).b;
}
function sendLinks(phoneRaw, text) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  const wa = phone.length === 10 ? '91' + phone : phone;
  return { text, whatsapp_url: `https://wa.me/${wa}?text=${encodeURIComponent(text)}`, sms_url: phone ? `sms:${phone}?body=${encodeURIComponent(text)}` : '' };
}
/* The message for one entry, with the balance it will make once sent. */
async function entryMessage(c, e, p) {
  const after = (await khataBalance(c, p.id)) + (e.status === 'sent' ? 0 : (e.kind === 'gave' ? e.amount : -e.amount));
  const link = `${c.url.origin}/#/k/${await khataToken(c, p.id)}`;
  const what = e.kind === 'gave' ? `${rs(e.amount)} aapke khate me likha gaya (udhaar)` : `${rs(e.amount)} payment mila, dhanyavaad`;
  const bal = after > 0 ? `Total baaki: ${rs(after)}` : after < 0 ? `Aapka advance: ${rs(-after)}` : 'Khata clear hai';
  return `${c.org.name}: ${what} on ${fd(e.date)}${e.note ? ` (${e.note})` : ''}. ${bal}.\nApna khata dekhein aur confirm karein: ${link}`;
}

router.add('GET', '/api/khata', async (c) => {
  const { results } = await c.db.prepare(`SELECT p.id, p.name, p.phone, p.kind, ${KHATA_BAL} AS balance,
        MAX(CASE WHEN k.status = 'sent' THEN k.date END) AS last_date, SUM(k.status = 'sent') AS entries, SUM(k.status = 'pending') AS pending,
        SUM(k.ack = 'disputed') AS disputed
      FROM parties p LEFT JOIN khata k ON k.party_id = p.id WHERE p.org_id = ? GROUP BY p.id
      HAVING COUNT(k.id) > 0 OR ? = '1' ORDER BY pending DESC, last_date DESC, p.name`).bind(c.org.id, c.url.searchParams.get('all') ? '1' : '0').all();
  const get = results.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0);
  const give = results.filter((r) => r.balance < 0).reduce((s, r) => s - r.balance, 0);
  return json({ rows: results.map((r) => ({ ...r, balance: R(r.balance) })), you_will_get: R(get), you_will_give: R(give) });
});
/* Creates a PENDING entry and returns the message to send. It counts only after /send. */
router.add('POST', '/api/khata', async (c) => {
  requireCan(c.user, 'khata');
  const b = c.body;
  let partyId = +b.party_id || 0;
  if (!partyId) {                                     // quick add a new contact from the khata screen
    const name = reqStr(b.name, 'Name', 120);
    const ex = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first();
    partyId = ex ? ex.id : (await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, created_at) VALUES (?, ?, 'customer', ?, ?) RETURNING id`)
      .bind(c.org.id, name, str(b.phone, 20), nowIso()).first()).id;
    if (ex && b.phone) await c.db.prepare(`UPDATE parties SET phone = ? WHERE id = ? AND phone = ''`).bind(str(b.phone, 20), ex.id).run();
  }
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw bad('Unknown contact.');
  const kind = oneOf(b.kind, ['gave', 'got'], 'Entry type');
  const amount = toPaise(num(b.amount, 'Amount', { min: 0.01 }));
  const e = await c.db.prepare(`INSERT INTO khata (org_id, party_id, date, kind, amount, note, created_by, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING *`)
    .bind(c.org.id, partyId, date(b.date), kind, amount, str(b.note, 200), c.user.id, nowIso()).first();
  return json({ ok: true, party_id: partyId, entry_id: e.id, phone: p.phone, ...sendLinks(p.phone, await entryMessage(c, e, p)) });
});
router.add('GET', '/api/khata/entries/:id/message', async (c) => {
  const e = await c.db.prepare(`SELECT * FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ?`).bind(e.party_id).first();
  return json({ entry_id: e.id, status: e.status, phone: p.phone, ...sendLinks(p.phone, await entryMessage(c, e, p)) });
});
/* Called when the user taps Send on WhatsApp / SMS: from now on the entry is part of the khata. */
router.add('POST', '/api/khata/entries/:id/send', async (c) => {
  requireCan(c.user, 'khata');
  const via = oneOf(c.body.via, ['whatsapp', 'sms'], 'Sent via');
  const r = await c.db.prepare(`UPDATE khata SET status = 'sent', sent_at = ?, sent_via = ? WHERE id = ? AND org_id = ? AND status = 'pending'`)
    .bind(nowIso(), via, +c.params.id, c.org.id).run();
  if (!r.meta.changes) {
    const e = await c.db.prepare(`SELECT status FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
    if (!e) throw notFound('Entry not found.');
  }
  return json({ ok: true });
});
router.add('GET', '/api/khata/:party', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  const { results } = await c.db.prepare(`SELECT id, date, kind, amount, note, status, sent_at, sent_via, ack, ack_at, ack_note, reverses
      FROM khata WHERE org_id = ? AND party_id = ? ORDER BY date, id`).bind(c.org.id, p.id).all();
  let bal = 0;
  const rows = results.map((r) => ({ ...r, amount: R(r.amount), balance: R(r.status === 'sent' ? (bal += r.kind === 'gave' ? r.amount : -r.amount) : bal) }));
  return json({ party: p, rows: rows.reverse(), balance: R(bal), statement_url: `${c.url.origin}/#/k/${await khataToken(c, p.id)}` });
});
/* Pending (never sent) entries can be discarded. Sent entries are permanent: reverse them instead. */
router.add('DELETE', '/api/khata/entries/:id', async (c) => {
  requireCan(c.user, 'khata');
  const e = await c.db.prepare(`SELECT status FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  if (e.status !== 'pending') throw bad('This entry was already sent to the customer, so it cannot be deleted. Use Reverse to cancel it with a new entry.');
  await c.db.prepare(`DELETE FROM khata WHERE id = ? AND status = 'pending'`).bind(+c.params.id).run();
  return json({ ok: true });
});
router.add('POST', '/api/khata/entries/:id/reverse', async (c) => {
  requireCan(c.user, 'khata');
  const e = await c.db.prepare(`SELECT * FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  if (e.status !== 'sent') throw bad('Only sent entries can be reversed. A pending entry can simply be discarded.');
  if (await c.db.prepare(`SELECT 1 FROM khata WHERE reverses = ?`).bind(e.id).first()) throw bad('This entry has already been reversed.');
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ?`).bind(e.party_id).first();
  const r = await c.db.prepare(`INSERT INTO khata (org_id, party_id, date, kind, amount, note, created_by, created_at, status, reverses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`)
    .bind(c.org.id, e.party_id, today(), e.kind === 'gave' ? 'got' : 'gave', e.amount, `Correction of entry dated ${fd(e.date)}${c.body.reason ? ': ' + str(c.body.reason, 120) : ''}`,
      c.user.id, nowIso(), e.id).first();
  return json({ ok: true, entry_id: r.id, ...sendLinks(p.phone, await entryMessage(c, r, p)) });
});
router.add('GET', '/api/khata/:party/reminder', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  const amt = R(await khataBalance(c, p.id));
  const link = `${c.url.origin}/#/k/${await khataToken(c, p.id)}`;
  const upi = c.org.upi_id && amt > 0 ? `upi://pay?pa=${encodeURIComponent(c.org.upi_id)}&pn=${encodeURIComponent(c.org.name)}&am=${amt.toFixed(2)}&cu=INR` : '';
  const text = amt > 0
    ? `Namaste ${p.name}, ${c.org.name} me aapka baaki ${rs(amt * 100)} hai. Kripya jaldi bhugtan karein.${upi ? '\nUPI se pay karein: ' + upi : ''}\nPoora khata: ${link}`
    : `Namaste ${p.name}, ${c.org.name} me aapka khata clear hai. Dhanyavaad!\nPoora khata: ${link}`;
  return json({ ...sendLinks(p.phone, text), upi_url: upi });
});

/* ---------- the customer's side: a private, read-only statement link (no login) ---------- */
async function khataByToken(c) {
  const t = String(c.params.token || '');
  if (!/^[0-9a-f]{24}$/.test(t)) throw notFound('This khata link is not valid.');
  const p = await c.db.prepare(`SELECT p.id, p.name, p.org_id, o.name AS org_name, o.phone AS org_phone, o.upi_id, o.address AS org_address
      FROM parties p JOIN orgs o ON o.id = p.org_id WHERE p.khata_token = ?`).bind(t).first();
  if (!p) throw notFound('This khata link is not valid.');
  return p;
}
router.add('GET', '/api/public/khata/:token', async (c) => {
  await rateLimit(c.env, 'kview:' + (c.request.headers.get('CF-Connecting-IP') || 'local'), 120, 600);
  const p = await khataByToken(c);
  const { results } = await c.db.prepare(`SELECT id, date, kind, amount, note, sent_at, ack, ack_at FROM khata
      WHERE party_id = ? AND status = 'sent' ORDER BY date, id`).bind(p.id).all();
  let bal = 0;
  const rows = results.map((r) => ({ ...r, amount: R(r.amount), balance: R(bal += r.kind === 'gave' ? r.amount : -r.amount) })).reverse();
  return json({ shop: { name: p.org_name, phone: p.org_phone, upi_id: p.upi_id, address: p.org_address }, customer: p.name, balance: R(bal), rows });
}, { public: true });
router.add('POST', '/api/public/khata/:token/ack', async (c) => {
  await rateLimit(c.env, 'kack:' + (c.request.headers.get('CF-Connecting-IP') || 'local'), 60, 600);
  const p = await khataByToken(c);
  const ack = oneOf(c.body.ack, ['confirmed', 'disputed'], 'Answer');
  const r = await c.db.prepare(`UPDATE khata SET ack = ?, ack_at = ?, ack_note = ? WHERE id = ? AND party_id = ? AND status = 'sent'`)
    .bind(ack, nowIso(), str(c.body.note, 200), +c.body.entry_id || 0, p.id).run();
  if (!r.meta.changes) throw notFound('Entry not found.');
  return json({ ok: true });
}, { public: true });

/* ======================================================================= reports */
const REPORTS = {
  dashboard: (c) => rep.dashboard(c.db, c.org),
  'trial-balance': (c) => rep.trialBalance(c.db, c.org, c.url.searchParams),
  pnl: (c) => rep.profitLoss(c.db, c.org, c.url.searchParams),
  'balance-sheet': (c) => rep.balanceSheet(c.db, c.org, c.url.searchParams),
  gst: (c) => rep.gstSummary(c.db, c.org, c.url.searchParams),
  ageing: (c) => rep.ageing(c.db, c.org, c.url.searchParams),
  stock: (c) => rep.stockReport(c.db, c.org),
  daybook: (c) => rep.dayBook(c.db, c.org, c.url.searchParams),
  register: (c) => rep.register(c.db, c.org, c.url.searchParams),
};
router.add('GET', '/api/reports/:name', async (c) => {
  const fn = REPORTS[c.params.name];
  if (!fn) throw notFound('Unknown report.');
  return json(await fn(c));
});
router.add('GET', '/api/audit', async (c) => {
  requireCan(c.user, 'users');
  const { results } = await c.db.prepare(`SELECT a.at, a.action, a.detail, u.name AS user FROM audit a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 300`).bind(c.org.id).all();
  return json({ rows: results });
});
router.add('GET', '/api/health', async (c) => json({ ok: true, db: !!c.env.DB, time: nowIso() }), { public: true });

/* ======================================================================= entry point */
async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!env.DB) throw new HttpError(500, 'Database not connected: bind a D1 database as DB in wrangler.toml.');
  if (!migrated) { await migrate(env.DB); migrated = true; }
  const m = router.match(request.method, url.pathname);
  if (!m) throw notFound('Unknown API route.');
  if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
  if (request.method !== 'GET') {
    // custom header + same origin: a page on another site cannot make these requests with your cookie
    if (request.headers.get('X-Requested-With') !== 'SmartTrader') throw forbidden('Missing request header.');
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw forbidden('Cross-site request blocked.');
  }
  const c = { env, db: env.DB, request, url, params: m.params, body: request.method === 'GET' ? {} : await readJson(request) };
  if (!m.route.opts.public) {
    c.user = await currentUser(env, request);
    if (!c.user) throw new HttpError(401, 'Please sign in.');
    c.org = await env.DB.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(c.user.org_id).first();
    c.sys = await loadSys(env.DB, c.org.id);
  }
  return m.route.handler(c);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      const res = await handleApi(request, env);
      res.headers.set('X-Content-Type-Options', 'nosniff');
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e && e.stack || e);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  },
};
