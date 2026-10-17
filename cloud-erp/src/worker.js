/* SmartTrader Cloud ERP - Cloudflare Worker.
   /api/*  -> JSON API (this file)
   anything else -> the web app in /public (Workers static assets, single-page app) */
import { migrate, DEFAULT_ACCOUNTS } from './schema.js';
import {
  HttpError, bad, notFound, forbidden, json, readJson, str, reqStr, num, int, date, nowIso, oneOf, toPaise, Router, GST_RATES, today, counterStatements, counterValueSql,
} from './lib.js';
import {
  hashPassword, randomHex, sameText, passwordProblem, issueSession, sessionCookie, clearCookie, sessionFromRequest, sessionValid, USER_SQL, ROLES, can, requireCan, rateLimit,
} from './auth.js';
import {
  DOC_TYPES, NOTE_TYPES, stockCount, loadByIds, SYS_SQL, sysMap, createDoc, cancelDoc, createPayment, voidPayment, stockAdjust, stockTransfer, createExpense, createJournal, partyOpening,
  auditStatement, cashAccount,
} from './engine.js';
import * as rep from './reports.js';
import { PLANS, planOut, usage, checkCount, requireFeature, extendPlan, adminKey, trialUntil } from './saas.js';
import { STATES, einvoiceJson, ewaybillJson } from './gst.js';
import { tallyXml } from './tally.js';
import { printOf, cleanPrint, imageFromDataUrl, shortHash, imageResponse, FILE_KINDS, seriesOf, numberSpec, formatNumber, cleanSeries, fyParts } from './custom.js';
import { billingMode, grossPaise, billingStart, billingVerify, billingWebhook, billingStatus, billingHistory } from './billing.js';

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
  user: publicUser(c.user), org: orgOut(c.org),
  can: Object.fromEntries(['settings', 'users', 'items', 'purchase', 'sales', 'stock', 'finance', 'khata'].map((a) => [a, can(c.user, a)])),
  doc_types: Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [k, { label: v.label, side: v.side, from: v.from, prefix: v.prefix, note: !!v.note, stock: v.stock || '' }])),
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

router.add('PUT', '/api/org/mode', async (c) => {
  requireCan(c.user, 'settings');
  const mode = oneOf(c.body.mode, ['simple', 'advanced'], 'Mode');
  await c.db.batch([c.db.prepare(`UPDATE orgs SET mode = ? WHERE id = ?`).bind(mode, c.org.id), auditStatement(c, 'mode', mode)]);
  return json({ ok: true, mode });
});
/* business row for the app: settings JSON parsed, image URLs ready for <img> */
const orgOut = (o) => ({ ...o, print: printOf(o), series: seriesOf(o) });
const fileUrls = (P, base) => ({ logo_url: P.logo ? `${base}/logo?v=${P.logo}` : '', sign_url: P.signature ? `${base}/signature?v=${P.signature}` : '' });

/* Branding & print: layout, colour, title, terms, bank, UPI on bill, signatory, footer */
router.add('GET', '/api/settings/print', async (c) => { const P = printOf(c.org); return json({ print: P, ...fileUrls(P, '/api/org/files') }); });
router.add('PUT', '/api/settings/print', async (c) => {
  requireCan(c.user, 'settings');
  const P = cleanPrint(c.body, printOf(c.org));
  await c.db.batch([c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id), auditStatement(c, 'print settings', P.layout)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
/* logo / signature: the browser shrinks the image first; at most 64 KB */
router.add('PUT', '/api/org/files/:kind', async (c) => {
  requireCan(c.user, 'settings');
  const kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const img = imageFromDataUrl(c.body.data);
  const hash = await shortHash(img.b64);
  const P = { ...printOf(c.org), [kind]: hash };
  await c.db.batch([
    c.db.prepare(`INSERT INTO org_files (org_id, kind, mime, data, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, hash = excluded.hash, updated_at = excluded.updated_at`)
      .bind(c.org.id, kind, img.mime, img.b64, hash, nowIso()),
    c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id),
    auditStatement(c, 'upload ' + kind, `${Math.round(img.size / 1024)} KB`)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
router.add('DELETE', '/api/org/files/:kind', async (c) => {
  requireCan(c.user, 'settings');
  const kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const P = { ...printOf(c.org), [kind]: '' };
  await c.db.batch([c.db.prepare(`DELETE FROM org_files WHERE org_id = ? AND kind = ?`).bind(c.org.id, kind),
    c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id), auditStatement(c, 'remove ' + kind)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
router.add('GET', '/api/org/files/:kind', async (c) => {
  const row = await c.db.prepare(`SELECT mime, data FROM org_files WHERE org_id = ? AND kind = ?`).bind(c.org.id, oneOf(c.params.kind, FILE_KINDS, 'File')).first();
  if (!row) throw notFound('No image.');
  return imageResponse(row);
});

/* Numbering: prefix, digits, next number and yearly reset for each document type, receipts and payments */
const SERIES = () => [...Object.entries(DOC_TYPES).map(([k, v]) => [k, v.label, v.prefix]), ['receipt', 'Receipt', 'RCT'], ['payment', 'Payment', 'PAY']];
async function seriesRows(c, only) {
  const { results } = await c.db.prepare(`SELECT key, next FROM counters WHERE org_id = ?`).bind(c.org.id).all();
  const next = Object.fromEntries(results.map((r) => [r.key, r.next])), S = seriesOf(c.org), d = today();
  return SERIES().filter(([k]) => !only || k === only).map(([k, label, prefix]) => {
    const spec = numberSpec(c.org, k, prefix, d), n = next[spec.key] || 1, s = S[k];
    return { type: k, label, custom: !!s, prefix: s ? s.prefix : prefix + '-', pad: s ? s.pad : 5, fy_reset: s ? s.fy_reset : 0, next: n, preview: formatNumber(spec, n) };
  });
}
router.add('GET', '/api/settings/series', async (c) => json({ rows: await seriesRows(c), fy: fyParts(c.org, today()).fy }));
router.add('PUT', '/api/settings/series/:type', async (c) => {
  requireCan(c.user, 'settings');
  const def = SERIES().find(([k]) => k === c.params.type);
  if (!def) throw bad('Unknown document type.');
  const d = today(), S = seriesOf(c.org);
  const v = cleanSeries(c.body, c.org, d);
  const org = { ...c.org, series: JSON.stringify({ ...S, [def[0]]: { prefix: v.prefix, pad: v.pad, fy_reset: v.fy_reset } }) };
  const spec = numberSpec(org, def[0], def[2], d);
  const st = [c.db.prepare(`UPDATE orgs SET series = ? WHERE id = ?`).bind(org.series, c.org.id), auditStatement(c, 'numbering', `${def[0]} ${v.prefix} ${v.pad}${v.fy_reset ? ' yearly' : ''}${v.next ? ' next ' + v.next : ''}`)];
  if (v.next) {
    const cur = await c.db.prepare(`SELECT next FROM counters WHERE org_id = ? AND key = ?`).bind(c.org.id, spec.key).first();
    if (cur && v.next < cur.next) throw bad(`Next number cannot go back. It must be ${cur.next} or more.`);
    st.push(c.db.prepare(`INSERT INTO counters (org_id, key, next) VALUES (?, ?, ?) ON CONFLICT (org_id, key) DO UPDATE SET next = MAX(next, excluded.next)`).bind(c.org.id, spec.key, v.next));
  }
  await c.db.batch(st);
  c.org = org;
  return json((await seriesRows(c, def[0]))[0]);
});
router.add('DELETE', '/api/settings/series/:type', async (c) => {
  requireCan(c.user, 'settings');
  const S = seriesOf(c.org);
  delete S[c.params.type];
  c.org = { ...c.org, series: JSON.stringify(S) };
  await c.db.batch([c.db.prepare(`UPDATE orgs SET series = ? WHERE id = ?`).bind(c.org.series, c.org.id), auditStatement(c, 'numbering', `${c.params.type} default`)]);
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
  const used = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM docs WHERE org_id = ?1 AND party_id = ?2) + EXISTS (SELECT 1 FROM journal_lines WHERE org_id = ?1 AND party_id = ?2)
      + EXISTS (SELECT 1 FROM khata WHERE party_id = ?2) + EXISTS (SELECT 1 FROM payments WHERE org_id = ?1 AND party_id = ?2) AS n`).bind(c.org.id, id).first();
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
  barcode: str(b.barcode, 48).replace(/\s+/g, ''), location: str(b.location, 30),
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
  const r = await c.db.prepare(`INSERT INTO items (org_id, sku, name, category, unit, hsn, gst_rate, purchase_price, sale_price, reorder_level, is_service, avg_cost, barcode, location, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price, f.sale_price, f.reorder_level, f.is_service, f.purchase_price, f.barcode, f.location, nowIso()).first();
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
  const r = await c.db.prepare(`UPDATE items SET sku = ?, name = ?, category = ?, unit = ?, hsn = ?, gst_rate = ?, purchase_price = ?, sale_price = ?, reorder_level = ?, barcode = ?, location = ?
      WHERE id = ? AND org_id = ?`).bind(f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price, f.sale_price, f.reorder_level, f.barcode, f.location, +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Item not found.');
  return json({ ok: true });
});
router.add('DELETE', '/api/items/:id', async (c) => {
  requireCan(c.user, 'items');
  const id = +c.params.id;
  const used = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM doc_lines WHERE item_id = ?) + EXISTS (SELECT 1 FROM stock_moves WHERE org_id = ? AND item_id = ?) AS n`).bind(id, c.org.id, id).first();
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
  const { results } = await c.db.prepare(`SELECT w.*, COALESCE((SELECT SUM(s.qty * i.avg_cost) FROM stock s JOIN items i ON i.id = s.item_id WHERE s.org_id = w.org_id AND s.warehouse_id = w.id AND s.qty > 0), 0) AS value
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
  const rows = await rep.accountBalances(c.db, c.org.id, '0001-01-01', '9999-12-31');
  return json({ rows: rows.map((a) => ({ ...a, bal: a.dr - a.cr, balance: R(['asset', 'expense'].includes(a.type) ? a.dr - a.cr : a.cr - a.dr) })) });
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
    c.db.prepare(`SELECT l.*, i.name AS item, i.unit, i.hsn, i.is_service, i.location FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ? ORDER BY l.id`).bind(id).all(),
    c.db.prepare(`SELECT * FROM parties WHERE id = ?`).bind(d.party_id).first(),
    c.db.prepare(`SELECT id, type, number, date, status, total FROM docs WHERE ref_id = ? AND org_id = ? ORDER BY id`).bind(id, c.org.id).all(),
    d.ref_id ? c.db.prepare(`SELECT id, type, number, date, status FROM docs WHERE id = ?`).bind(d.ref_id).first() : null,
    c.db.prepare(`SELECT pa.amount, pa.note_id, p.id, p.number, p.date, p.kind, n.number AS note_number FROM payment_allocs pa
        LEFT JOIN payments p ON p.id = pa.payment_id LEFT JOIN docs n ON n.id = pa.note_id WHERE pa.doc_id = ?`).bind(id).all(),
  ]);
  const money = (x) => R(x);
  return {
    ...d, taxable: money(d.taxable), cgst: money(d.cgst), sgst: money(d.sgst), igst: money(d.igst), round_off: money(d.round_off),
    total: money(d.total), paid: money(d.paid), balance: money(d.total - d.paid), label: DOC_TYPES[d.type].label, side: DOC_TYPES[d.type].side,
    party, parent, children: children.results.map((x) => ({ ...x, total: money(x.total) })),
    settlements: pays.results.map((p) => ({ ...p, amount: money(p.amount), number: p.number || p.note_number })),
    lines: lines.results.map((l) => ({ ...l, rate: money(l.rate), taxable: money(l.taxable), cgst: money(l.cgst), sgst: money(l.sgst), igst: money(l.igst),
      total: money(l.total), cost: money(l.cost), remaining: Math.round((l.qty - l.done_qty) * 1000) / 1000 })),
    org: orgOut(c.org), ...fileUrls(printOf(c.org), '/api/org/files'),
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
  if (T.note) {     // value note: every line of the bill/invoice, the user types the rate difference per unit
    return json({ type: to, party_id: src.party_id, ref_id: src.id, ref_number: src.number, warehouse_id: src.warehouse_id, date: today(),
      lines: src.lines.map((l) => ({ item_id: l.item_id, item: l.item, unit: l.unit, description: l.description || l.item, qty: l.qty, rate: '', discount_pct: 0, gst_rate: l.gst_rate, orig_rate: l.rate })) });
  }
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
/* Customer link for a document: view, print/download and pay by UPI. Shared on WhatsApp with a banner card. */
async function shareToken(c, docId) {
  const d = await c.db.prepare(`SELECT share_token FROM docs WHERE id = ? AND org_id = ?`).bind(docId, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  if (d.share_token) return d.share_token;
  await c.db.prepare(`UPDATE docs SET share_token = ? WHERE id = ? AND share_token IS NULL`).bind(randomHex(12), docId).run();
  return (await c.db.prepare(`SELECT share_token FROM docs WHERE id = ?`).bind(docId).first()).share_token;
}
router.add('GET', '/api/docs/:id/share', async (c) => {
  const d = await docDetail(c, +c.params.id);
  const url = `${c.url.origin}/i/${await shareToken(c, d.id)}`;
  const p = d.party || {}, paise = (x) => Math.round(x * 100);
  const money = ['INV', 'SRET', 'CNOTE'].includes(d.type);
  const status = d.type === 'INV' ? (d.balance <= 0 ? 'Paid ✅' : `Balance due: *${inrW(paise(d.balance))}*`) : '';
  const wa = [`*${c.org.name}*`, `${d.label} *${d.number}* · ${fd(d.date)}`, '', `Namaste ${p.name || ''} ji,`, `Amount: *${inrW(paise(d.total))}*`,
    ...(status ? [status] : []), ...(d.type === 'INV' && d.balance > 0 && c.org.upi_id ? [`UPI: ${c.org.upi_id}`] : []),
    '', money ? `Invoice dekhein aur download karein${d.type === 'INV' && d.balance > 0 && c.org.upi_id ? ', UPI se pay karein' : ''} ⬇` : 'Document dekhein aur download karein ⬇', url, '', `_Sent via ${BRAND}_`].join('\n');
  const sms = `${c.org.name}: ${d.label} ${d.number} dt ${fd(d.date)}, amount ${rs(paise(d.total))}${d.type === 'INV' && d.balance > 0 ? `, due ${rs(paise(d.balance))}` : ''}. View/download: ${url} -${BRAND}`;
  return json({ url, ...sendLinks(p.phone, wa, sms) });
});
const PUBLIC_DOCS = ['INV', 'SRET', 'CNOTE', 'QUOTE', 'SO', 'DN'];
router.add('GET', '/api/public/doc/:token', async (c) => {
  await rateLimit(c.env, 'dview:' + (c.request.headers.get('CF-Connecting-IP') || 'local'), 120, 600);
  const t = String(c.params.token || '');
  const row = /^[0-9a-f]{24}$/.test(t) ? await c.db.prepare(`SELECT id, org_id FROM docs WHERE share_token = ?`).bind(t).first() : null;
  if (!row) throw notFound('This link is not valid.');
  c.org = await c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(row.org_id).first();
  const d = await docDetail(c, row.id);
  if (!PUBLIC_DOCS.includes(d.type)) throw notFound('This link is not valid.');
  const o = d.org, p = d.party || {};
  return json({   // only what is printed on the document: no costs, margins, links to other records or internal ids
    type: d.type, label: d.label, side: d.side, number: d.number, date: d.date, due_date: d.due_date, status: d.status, place_of_supply: d.place_of_supply,
    inter_state: d.inter_state, taxable: d.taxable, cgst: d.cgst, sgst: d.sgst, igst: d.igst, round_off: d.round_off, total: d.total, paid: d.paid, balance: d.balance,
    notes: d.notes, irn: d.irn, ack_no: d.ack_no, ack_date: d.ack_date, ewb_no: d.ewb_no, ewb_date: d.ewb_date, warehouse: '',
    parent: d.parent && ['SRET', 'CNOTE'].includes(d.type) ? { number: d.parent.number, date: d.parent.date } : null,
    org: { name: o.name, gstin: o.gstin, state: o.state, address: o.address, phone: o.phone, upi_id: o.upi_id, email: o.email, print: o.print },
    ...fileUrls(o.print, `/api/public/doc/${t}/file`),
    party: { name: p.name, gstin: p.gstin, address: p.address, phone: p.phone, state: p.state },
    lines: d.lines.map((l) => ({ item: l.item, description: l.description, hsn: l.hsn, unit: l.unit, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct,
      gst_rate: l.gst_rate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total })),
  });
}, { public: true });

/* logo / signature on the customer's link: only for a business that has a shared document with this token */
router.add('GET', '/api/public/doc/:token/file/:kind', async (c) => {
  const t = String(c.params.token || ''), kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const row = /^[0-9a-f]{24}$/.test(t) ? await c.db.prepare(`SELECT f.mime, f.data FROM docs d JOIN org_files f ON f.org_id = d.org_id AND f.kind = ?
      WHERE d.share_token = ? AND d.type IN ('${PUBLIC_DOCS.join("','")}')`).bind(kind, t).first() : null;
  if (!row) throw notFound('No image.');
  return imageResponse(row);
}, { public: true });

router.add('GET', '/api/export/tally', async (c) => {
  requireFeature(c.org, 'tally');
  const t = await tallyXml(c.db, c.org, c.url.searchParams);
  return download(`tally-${t.from}-to-${t.to}.xml`, t.xml, 'application/xml');
});

/* ======================================================================= plan & billing (SaaS) */
router.add('GET', '/api/plan', async (c) => json({
  plan: planOut(c.org), usage: await usage(c.db, c.org),
  plans: Object.entries(PLANS).map(([k, p]) => ({ key: k, ...p, invoices_per_month: p.invoices_per_month === Infinity ? null : p.invoices_per_month,
    users: p.users === Infinity ? null : p.users, warehouses: p.warehouses === Infinity ? null : p.warehouses, pay: p.price ? grossPaise(k) / 100 : 0 })),
  billing: billingMode(c.env), history: await billingHistory(c), support_whatsapp: c.env.SUPPORT_WHATSAPP || '',
}));
/* Online payment (Razorpay): see src/billing.js */
router.add('POST', '/api/billing/start', async (c) => { requireCan(c.user, 'settings'); await rateLimit(c.env, 'pay:' + c.org.id, 20, 3600); return json(await billingStart(c)); });
router.add('POST', '/api/billing/verify', async (c) => json(await billingVerify(c)));
router.add('GET', '/api/billing/status', async (c) => json(await billingStatus(c)));
router.add('POST', '/api/billing/webhook', async (c) => json(await billingWebhook(c)), { public: true, webhook: true });

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
router.add('GET', '/api/admin/payments', async (c) => {
  await requireAdmin(c);
  const { results } = await c.db.prepare(`SELECT b.ref, b.plan, b.paise, b.status, b.payment_id, b.created_at, b.paid_at, b.plan_until, o.name AS business,
      (SELECT email FROM users WHERE id = b.user_id) AS email FROM billing_orders b JOIN orgs o ON o.id = b.org_id
      WHERE b.status != 'created' ORDER BY b.id DESC LIMIT 300`).all();
  return json({ rows: results.map((r) => ({ ...r, amount: r.paise / 100 })), mode: billingMode(c.env) });
}, { public: true });

/* ======================================================================= gate entry (security gate register)
   Inward (GE): every vehicle that arrives is logged before unloading: supplier, vehicle, driver, challan/invoice,
   packages. The goods receipt (GRN) is then made from the gate entry, and the entry closes.
   Outward (GP, gate pass): goods leaving against a delivery note / invoice, with vehicle and exit time. */
const nowTime = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(11, 16);
const geOut = (g) => g;
router.add('GET', '/api/gate', async (c) => {
  const q = c.url.searchParams, kind = q.get('kind') === 'out' ? 'out' : 'in';
  const { results } = await c.db.prepare(`SELECT g.*, p.name AS party, r.number AS ref_number, r.type AS ref_type, n.number AS grn_number
      FROM gate_entries g LEFT JOIN parties p ON p.id = g.party_id LEFT JOIN docs r ON r.id = g.ref_doc_id LEFT JOIN docs n ON n.id = g.grn_id
      WHERE g.org_id = ? AND g.kind = ? AND (? = '' OR g.status = ?) ORDER BY g.date DESC, g.id DESC LIMIT 300`)
    .bind(c.org.id, kind, q.get('status') || '', q.get('status') || '').all();
  return json({ rows: results.map(geOut) });
});
router.add('GET', '/api/gate/:id', async (c) => {
  const g = await c.db.prepare(`SELECT g.*, p.name AS party, r.number AS ref_number, r.type AS ref_type, n.number AS grn_number FROM gate_entries g
      LEFT JOIN parties p ON p.id = g.party_id LEFT JOIN docs r ON r.id = g.ref_doc_id LEFT JOIN docs n ON n.id = g.grn_id WHERE g.id = ? AND g.org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!g) throw notFound('Gate entry not found.');
  return json(g);
});
router.add('POST', '/api/gate', async (c) => {
  if (!can(c.user, 'stock') && !can(c.user, 'purchase') && !can(c.user, 'sales')) throw forbidden();
  const b = c.body, kind = b.kind === 'out' ? 'out' : 'in';
  const partyId = +b.party_id || null;
  if (partyId && !(await c.db.prepare(`SELECT 1 FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first())) throw bad('Unknown party.');
  let refId = +b.ref_doc_id || null;
  if (refId) {
    const r = await c.db.prepare(`SELECT type, party_id, status FROM docs WHERE id = ? AND org_id = ?`).bind(refId, c.org.id).first();
    const ok = kind === 'in' ? ['PO'] : ['DN', 'INV', 'PRET'];
    if (!r || !ok.includes(r.type)) throw bad(kind === 'in' ? 'Link a purchase order (optional).' : 'Link a delivery note, invoice or purchase return.');
    if (r.status === 'cancelled') throw bad('That document is cancelled.');
    if (partyId && r.party_id !== partyId) throw bad('The linked document belongs to another party.');
  }
  const vehicle = str(b.vehicle_no, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!vehicle && !b.by_hand) throw bad('Enter the vehicle number (or tick "By hand / courier").');
  const key = kind === 'in' ? 'GE' : 'GP';
  await c.db.batch([
    counterStatements(c.db, c.org.id, key),
    c.db.prepare(`INSERT INTO gate_entries (org_id, number, kind, date, time_in, time_out, party_id, ref_doc_id, vehicle_no, driver_name, driver_phone, transporter, lr_no,
        challan_no, challan_date, packages, weight_kg, remarks, status, created_by, created_at)
      VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .bind(c.org.id, key + '-%05d', c.org.id, key, kind, date(b.date), str(b.time_in, 5) || nowTime(), kind === 'out' && b.exited ? nowTime() : '', partyId, refId, vehicle || 'BY HAND',
        str(b.driver_name, 60), str(b.driver_phone, 15), str(b.transporter, 80), str(b.lr_no, 30), str(b.challan_no, 40), b.challan_date ? date(b.challan_date) : '',
        int(b.packages, 'Packages', { min: 0, max: 100000, def: 0 }), num(b.weight_kg, 'Weight', { min: 0, max: 1e7, def: 0 }), str(b.remarks, 300),
        c.user.id, nowIso()),
  ]);
  const g = await c.db.prepare(`SELECT * FROM gate_entries WHERE org_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).bind(c.org.id, kind).first();
  if (kind === 'out' && b.exited) await c.db.prepare(`UPDATE gate_entries SET status = 'closed' WHERE id = ?`).bind(g.id).run();
  await c.db.batch([auditStatement(c, `gate ${kind}`, `${g.number} ${g.vehicle_no}`)]);
  return json(g);
});
/* exit time, reject at gate (goods sent back unloaded), or close */
router.add('POST', '/api/gate/:id/:action', async (c) => {
  if (!can(c.user, 'stock') && !can(c.user, 'purchase') && !can(c.user, 'sales')) throw forbidden();
  const action = oneOf(c.params.action, ['exit', 'reject', 'close'], 'Action');
  const g = await c.db.prepare(`SELECT * FROM gate_entries WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!g) throw notFound('Gate entry not found.');
  if (action === 'exit') {
    await c.db.prepare(`UPDATE gate_entries SET time_out = ?, status = CASE WHEN status = 'open' AND kind = 'out' THEN 'closed' ELSE status END WHERE id = ?`).bind(str(c.body.time, 5) || nowTime(), g.id).run();
  } else {
    if (g.status !== 'open') throw bad(`${g.number} is already ${g.status === 'grn_done' ? 'received' : g.status}.`);
    await c.db.prepare(`UPDATE gate_entries SET status = ?, remarks = TRIM(remarks || ' ' || ?), time_out = CASE WHEN time_out = '' THEN ? ELSE time_out END WHERE id = ?`)
      .bind(action === 'reject' ? 'rejected' : 'closed', str(c.body.reason, 200), nowTime(), g.id).run();
  }
  await c.db.batch([auditStatement(c, `gate ${action}`, g.number)]);
  return json({ ok: true });
});

/* ======================================================================= pending work (what is stuck where) */
router.add('GET', '/api/reports/pending', async (c) => {
  const lines = async (type) => (await c.db.prepare(`SELECT d.id, d.number, d.date, d.due_date, p.name AS party, i.name AS item, i.unit, l.qty, l.done_qty, ROUND(l.qty - l.done_qty, 3) AS pending
      FROM docs d JOIN doc_lines l ON l.doc_id = d.id LEFT JOIN items i ON i.id = l.item_id LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = ? AND d.status IN ('open','partial') AND l.qty - l.done_qty > 0.0005 ORDER BY d.date, d.id LIMIT 500`).bind(c.org.id, type).all()).results;
  const docs = async (type) => (await c.db.prepare(`SELECT d.id, d.number, d.date, d.total, p.name AS party FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = ? AND d.status IN ('open','partial') ORDER BY d.date LIMIT 300`).bind(c.org.id, type).all()).results
    .map((r) => ({ ...r, total: R(r.total) }));
  const [so, po, dn, grn, quotes, gate] = await Promise.all([lines('SO'), lines('PO'), docs('DN'), docs('GRN'), docs('QUOTE'),
    c.db.prepare(`SELECT g.id, g.number, g.date, g.time_in, g.vehicle_no, g.challan_no, p.name AS party FROM gate_entries g LEFT JOIN parties p ON p.id = g.party_id
      WHERE g.org_id = ? AND g.kind = 'in' AND g.status = 'open' ORDER BY g.date, g.id`).bind(c.org.id).all()]);
  return json({ to_deliver: so, to_receive: po, to_invoice: dn, to_bill: grn, open_quotes: quotes, at_gate: gate.results });
});

/* Payment reminder for invoice dues (the khata has its own): overdue invoices, total and UPI, for WhatsApp/SMS. */
router.add('GET', '/api/parties/:id/reminder', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!p) throw notFound('Party not found.');
  const { results } = await c.db.prepare(`SELECT id, number, date, due_date, total - paid AS bal FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV'
      AND status IN ('unpaid','partial') ORDER BY due_date, id`).bind(c.org.id, p.id).all();
  const due = results.reduce((t, r) => t + r.bal, 0);
  if (!due) throw bad(`${p.name} has no unpaid invoices.`);
  const link = `${c.url.origin}/i/${await shareToken(c, results[0].id)}`;
  const listW = results.slice(0, 8).map((r) => `• ${r.number} (${fd(r.date)}): ${inrW(r.bal)}`).join('\n') + (results.length > 8 ? `\n• …and ${results.length - 8} more` : '');
  const wa = [`*${c.org.name}*`, '⏰ Payment reminder', '', `Namaste ${p.name} ji,`, 'Ye bills baaki hain:', listW, '', `Total baaki: *${inrW(due)}*`,
    ...(c.org.upi_id ? [`UPI: ${c.org.upi_id}`] : []), '', c.org.upi_id ? 'Bill dekhein aur UPI se pay karein ⬇' : 'Bill yahan dekhein ⬇', link, '', `_Sent via ${BRAND}_`].join('\n');
  const sms = `${c.org.name}: Namaste ${p.name}, ${results.length} bill(s) baaki, total ${rs(due)}. Kripya bhugtan karein: ${link} -${BRAND}`;
  return json({ party: p.name, due: R(due), invoices: results.length, ...sendLinks(p.phone, wa, sms) });
});

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
router.add('POST', '/api/stock/count', async (c) => json(await stockCount(c, c.body)));
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
/* WhatsApp gets a formatted message (bold, sections, the link on its own line so WhatsApp shows the banner card);
   SMS gets one short plain line. Both are signed with the ERP's name. */
const BRAND = 'SmartTrader ERP';
function sendLinks(phoneRaw, wa, sms = wa) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  const to = phone.length === 10 ? '91' + phone : phone;
  return { text: wa, sms_text: sms, whatsapp_url: `https://api.whatsapp.com/send?${to ? `phone=${to}&` : ''}text=${encodeURIComponent(wa)}`, sms_url: phone ? `sms:${phone}?body=${encodeURIComponent(sms)}` : '' };
}
const inrW = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const khataLink = async (c, partyId) => `${c.url.origin}/k/${await khataToken(c, partyId)}`;
/* The messages for one entry, with the balance it makes once sent. */
async function entryMessage(c, e, p) {
  const after = (await khataBalance(c, p.id)) + (e.status === 'sent' ? 0 : (e.kind === 'gave' ? e.amount : -e.amount));
  const link = await khataLink(c, p.id);
  const balW = after > 0 ? `Total baaki: *${inrW(after)}*` : after < 0 ? `Aapka advance: *${inrW(-after)}*` : 'Khata clear hai ✅';
  const wa = [
    `*${c.org.name}*`,
    `✍ Khata entry · ${fd(e.date)}`,
    '',
    e.kind === 'gave' ? `Udhaar likha gaya: *${inrW(e.amount)}*` : `Payment mila: *${inrW(e.amount)}* ✅`,
    ...(e.note ? [`Note: ${e.note}`] : []),
    balW,
    '',
    'Apna khata dekhein aur confirm karein ⬇',
    link,
    '',
    `_Sent via ${BRAND}_`,
  ].join('\n');
  const balS = after > 0 ? `Total baaki ${rs(after)}` : after < 0 ? `Advance ${rs(-after)}` : 'Khata clear';
  const sms = `${c.org.name}: ${e.kind === 'gave' ? `${rs(e.amount)} udhaar likha gaya` : `${rs(e.amount)} payment mila`}${e.note ? ` (${e.note})` : ''} ${fd(e.date)}. ${balS}. Khata dekhein/confirm karein: ${link} -${BRAND}`;
  return [wa, sms];
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
  return json({ ok: true, party_id: partyId, entry_id: e.id, phone: p.phone, ...sendLinks(p.phone, ...(await entryMessage(c, e, p))) });
});
router.add('GET', '/api/khata/entries/:id/message', async (c) => {
  const e = await c.db.prepare(`SELECT * FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ?`).bind(e.party_id).first();
  return json({ entry_id: e.id, status: e.status, phone: p.phone, ...sendLinks(p.phone, ...(await entryMessage(c, e, p))) });
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
  return json({ party: p, rows: rows.reverse(), balance: R(bal), statement_url: await khataLink(c, p.id) });
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
  return json({ ok: true, entry_id: r.id, phone: p.phone, ...sendLinks(p.phone, ...(await entryMessage(c, r, p))) });
});
router.add('GET', '/api/khata/:party/reminder', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  const bal = await khataBalance(c, p.id), amt = R(bal);
  const link = await khataLink(c, p.id);
  const upi = c.org.upi_id && amt > 0 ? `upi://pay?pa=${encodeURIComponent(c.org.upi_id)}&pn=${encodeURIComponent(c.org.name)}&am=${amt.toFixed(2)}&cu=INR` : '';
  const wa = bal > 0
    ? [`*${c.org.name}*`, '⏰ Payment reminder', '', `Namaste ${p.name} ji,`, `Aapka baaki: *${inrW(bal)}*`, 'Kripya jaldi bhugtan karein.', ...(c.org.upi_id ? [`UPI: ${c.org.upi_id}`] : []),
      '', c.org.upi_id ? 'Khata dekhein aur UPI se pay karein ⬇' : 'Poora khata yahan dekhein ⬇', link, '', `_Sent via ${BRAND}_`].join('\n')
    : [`*${c.org.name}*`, '', `Namaste ${p.name} ji, aapka khata clear hai ✅`, 'Dhanyavaad!', '', link, '', `_Sent via ${BRAND}_`].join('\n');
  const sms = bal > 0 ? `${c.org.name}: Namaste ${p.name}, aapka baaki ${rs(bal)} hai. Kripya jaldi bhugtan karein. Khata/pay: ${link} -${BRAND}`
    : `${c.org.name}: Namaste ${p.name}, aapka khata clear hai. Dhanyavaad! ${link} -${BRAND}`;
  return json({ ...sendLinks(p.phone, wa, sms), upi_url: upi });
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
/* Local testing only (QUERY_COUNT=1 in .dev.vars): counts D1 calls per request, as Cloudflare does for its
   limit of 50 per request on the free plan (a batch is one call), and reports it in the X-Query-Count header. */
function countingDb(db, counter) {
  const meta = (r) => { if (r && r.meta) { counter.read = (counter.read || 0) + (r.meta.rows_read || 0); counter.written = (counter.written || 0) + (r.meta.rows_written || 0); } return r; };
  const wrap = (st) => ({ __raw: st, bind: (...a) => wrap(st.bind(...a)),
    first: (col) => { counter.n++; return st.all().then((r) => { meta(r); const row = r.results[0] ?? null; return col && row ? row[col] : row; }); },
    all: () => { counter.n++; return st.all().then(meta); },
    run: () => { counter.n++; return st.run().then(meta); }, raw: (...a) => { counter.n++; return st.raw(...a); } });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => { counter.n++; return db.batch(list.map((x) => x.__raw || x)).then((rs) => { rs.forEach(meta); return rs; }); }, exec: (q) => db.exec(q) };
}

async function handleApi(request, env, counter) {
  const url = new URL(request.url);
  if (!env.DB) throw new HttpError(500, 'Database not connected: bind a D1 database as DB in wrangler.toml.');
  if (!migrated) { await migrate(env.DB); migrated = true; }
  if (counter) env = { ...env, DB: countingDb(env.DB, counter) };
  const m = router.match(request.method, url.pathname);
  if (!m) throw notFound('Unknown API route.');
  if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
  if (request.method !== 'GET' && !m.route.opts.webhook) {
    // custom header + same origin: a page on another site cannot make these requests with your cookie
    if (request.headers.get('X-Requested-With') !== 'SmartTrader') throw forbidden('Missing request header.');
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw forbidden('Cross-site request blocked.');
  }
  const c = { env, db: env.DB, request, url, params: m.params, body: {} };
  if (m.route.opts.webhook) {       // a server calling us (Razorpay): signed raw body, no cookie, no custom header
    c.raw = await request.text();
    if (c.raw.length > 200000) throw new HttpError(413, 'Request too large.');
    try { c.body = JSON.parse(c.raw || '{}'); } catch (e) { throw bad('Bad body.'); }
  } else if (request.method !== 'GET') c.body = await readJson(request);
  if (!m.route.opts.public) {
    const p = await sessionFromRequest(env, request);
    if (!p) throw new HttpError(401, 'Please sign in.');
    // user, business and (only for writes) the posting accounts, in one D1 call
    const db = env.DB, st = [db.prepare(USER_SQL).bind(p.u), db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(p.o)];
    if (request.method !== 'GET') st.push(db.prepare(SYS_SQL).bind(p.o));
    const [u, o, s] = await db.batch(st);
    c.user = u.results[0];
    c.org = o.results[0];
    if (!sessionValid(c.user, p) || !c.org) throw new HttpError(401, 'Please sign in.');
    c.sys = s ? sysMap(s.results) : null;
  }
  return m.route.handler(c);
}

/* /k/<token> (khata) and /i/<token> (invoice): the web app, with Open Graph tags so WhatsApp shows a banner card
   (title, amount, image) for the link. The page itself loads the data through the public API. */
const attr = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
async function sharePage(request, env, kind, token) {
  if (!migrated) { await migrate(env.DB); migrated = true; }
  const url = new URL(request.url);
  let title = 'SmartTrader ERP', desc = 'Billing, stock, GST, accounts and khata for Indian businesses.', image = '/og-invoice.png';
  if (kind === 'k') {
    const p = await env.DB.prepare(`SELECT p.id, p.name, o.name AS org, o.upi_id FROM parties p JOIN orgs o ON o.id = p.org_id WHERE p.khata_token = ?`).bind(token).first();
    if (p) {
      const b = (await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN (CASE WHEN kind = 'gave' THEN amount ELSE -amount END) ELSE 0 END), 0) AS b FROM khata WHERE party_id = ?`).bind(p.id).first()).b;
      title = `${p.name} ka khata · ${p.org}`;
      desc = b > 0 ? `Baaki: ${inrW(b)}. Entries dekhein, confirm karein${p.upi_id ? ' aur UPI se pay karein' : ''}.` : b < 0 ? `Advance: ${inrW(-b)}. Poora khata dekhein.` : 'Khata clear hai. Poora hisaab dekhein.';
      image = '/og-khata.png';
    }
  } else {
    const d = await env.DB.prepare(`SELECT d.type, d.number, d.date, d.total, d.paid, o.name AS org FROM docs d JOIN orgs o ON o.id = d.org_id WHERE d.share_token = ?`).bind(token).first();
    if (d) {
      title = `${DOC_TYPES[d.type].label} ${d.number} · ${d.org}`;
      desc = `Amount ${inrW(d.total)}${d.type === 'INV' ? (d.total - d.paid > 0 ? ` · Due ${inrW(d.total - d.paid)}` : ' · Paid') : ''}. Dekhein, download karein${d.type === 'INV' ? ' aur pay karein' : ''}.`;
    }
  }
  const page = await env.ASSETS.fetch(new Request(url.origin + '/', request));
  let html = await page.text();
  const tags = `<title>${attr(title)}</title>
<meta name="description" content="${attr(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="SmartTrader ERP">
<meta property="og:title" content="${attr(title)}"><meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(url.origin + url.pathname)}">
<meta property="og:image" content="${attr(url.origin + image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="robots" content="noindex">`;
  html = html.replace(/<title>[\s\S]*?<\/title>/, '').replace(/<meta (name|property)="(description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>/g, '')
    .replace(/<link rel="canonical"[^>]*>/, '').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '').replace('</head>', tags + '\n</head>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const share = url.pathname.match(/^\/(k|i)\/([0-9a-f]{24})\/?$/);
    if (share && env.ASSETS) return sharePage(request, env, share[1], share[2]).catch(() => env.ASSETS.fetch(new Request(url.origin + '/', request)));
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      const counter = env.QUERY_COUNT === '1' ? { n: 0 } : null;
      const res = await handleApi(request, env, counter);
      res.headers.set('X-Content-Type-Options', 'nosniff');
      if (counter) res.headers.set('X-Query-Count', String(counter.n));
      if (counter) res.headers.set('X-Rows', `${counter.read || 0}/${counter.written || 0}`);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e && e.stack || e);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  },
};
