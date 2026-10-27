/* Fixed assets and depreciation: machines, furniture, computers, vehicles, a shop's fit-out. An asset goes into the
   Fixed Assets account when it is bought (paid from cash / bank, owed to a supplier, or already owned: opening), and
   once a year its depreciation is worked out and booked in one journal (Depreciation, an expense, against Accumulated
   Depreciation), never twice for one year, and can be undone. Two ways, as the owner's CA prefers:
   - WDV (income-tax style, written-down value): the year's rate on what is left; an asset used for less than 180 days
     in the year it was bought gets half the rate (Income-tax Act, section 32). None in the year it is sold.
   - SLM (Companies Act, straight line): (cost - residual value) / useful life a year, by days in the first and last year.
   Selling or scrapping an asset takes it out of the books, with the gain or loss on it. */
import { bad, notFound, str, num, today, nowIso, date as isoDate, oneOf } from './lib.js';
import { requireCan, checkBackdate } from './auth.js';
import { journalStatements, auditStatement, cashAccount, ensureSysAccounts } from './engine.js';
import { fyStart } from './reports.js';

/* income-tax block rates and Schedule II lives, as the starting values of a new asset (both can be changed) */
export const CATEGORIES = {
  plant: { name: 'Plant & machinery', rate: 15, life: 15 }, furniture: { name: 'Furniture & fittings', rate: 10, life: 10 },
  computer: { name: 'Computers & software', rate: 40, life: 3 }, vehicle: { name: 'Vehicles', rate: 15, life: 8 },
  office: { name: 'Office equipment', rate: 15, life: 5 }, building: { name: 'Building', rate: 10, life: 30 }, other: { name: 'Other', rate: 15, life: 10 },
};
const ACCOUNTS = [['fixed_assets', ['1500', '1501', '1509'], 'Fixed Assets', 'asset'], ['acc_dep', ['1510', '1511', '1519'], 'Accumulated Depreciation', 'asset'],
  ['depreciation', ['6080', '6081', '6089'], 'Depreciation', 'expense'], ['asset_loss', ['6085', '6086', '6088'], 'Loss on Sale of Assets', 'expense']];
const assetAccounts = (c) => ensureSysAccounts(c, ACCOUNTS);
const P = (r) => Math.round(r * 100);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;     // a to b, both days counted
const fyEnd = (s) => { const d = new Date(Date.parse(s + 'T00:00:00Z')); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
export const fyLabel = (s) => `${s.slice(0, 4)}-${String(+s.slice(2, 4) + 1).padStart(2, '0')}`;

/* one asset's depreciation for the year [from, to], in paise, given what was charged on it before */
export function depFor(a, from, to, before) {
  const left = a.cost - a.salvage - before;
  if (left <= 0 || a.bought_on > to) return 0;
  if (a.method === 'wdv') {
    if (a.sold_on && a.sold_on <= to) return 0;                          // the year of sale: none (the block rule)
    const first = a.bought_on >= from, rate = first && days(a.bought_on, to) < 180 ? a.rate / 2 : a.rate;
    return Math.max(0, Math.min(left, Math.round((a.cost - before) * rate / 100)));
  }
  const start = a.bought_on > from ? a.bought_on : from, end = a.sold_on && a.sold_on < to ? a.sold_on : to;
  if (end < start) return 0;
  const yearly = (a.cost - a.salvage) / (a.life_years || 1);
  return Math.max(0, Math.min(left, Math.round(yearly * Math.min(days(start, end), 365) / 365)));
}

async function rows(c) {
  const { results } = await c.db.prepare(`SELECT a.*, COALESCE((SELECT SUM(amount) FROM asset_dep d WHERE d.asset_id = a.id), 0) AS dep_booked
    FROM fixed_assets a WHERE a.org_id = ? ORDER BY a.sold_on IS NOT NULL, a.bought_on, a.id`).bind(c.org.id).all();
  return results;
}
const out = (a) => ({ id: a.id, name: a.name, category: a.category, bought_on: a.bought_on, cost: a.cost / 100, method: a.method, rate: a.rate, life_years: a.life_years,
  salvage: a.salvage / 100, sold_on: a.sold_on, sold_for: a.sold_for == null ? null : a.sold_for / 100, notes: a.notes,
  depreciation: (a.opening_dep + a.dep_booked) / 100, book_value: (a.cost - a.opening_dep - a.dep_booked) / 100 });

export async function listAssets(c) {
  requireCan(c.user, 'finance');
  const fy = fyStart(c.org), list = await rows(c);
  const { results: runs } = await c.db.prepare(`SELECT fy, total, created_at FROM dep_runs WHERE org_id = ? ORDER BY fy DESC LIMIT 20`).bind(c.org.id).all();
  return { rows: list.map(out), runs: runs.map((r) => ({ fy: r.fy, label: fyLabel(r.fy), total: r.total / 100, created_at: r.created_at })), fy_now: fy, categories: CATEGORIES };
}

/* POST /api/assets { name, category, bought_on, cost, gst?, method, rate | life_years, salvage?, paid: 'cash' | 'supplier' | 'opening',
   account_id (cash), party_id (supplier), opening_dep (opening: depreciation already charged before) } */
export async function addAsset(c, b) {
  requireCan(c.user, 'finance');
  const name = str(b.name, 120);
  if (!name) throw bad('Name the asset (e.g. "Delivery van MH12 AB 1234").');
  const category = Object.hasOwn(CATEGORIES, b.category) ? b.category : 'other';
  const bought = isoDate(b.bought_on, 'Bought on');
  const cost = P(num(b.cost, 'Cost', { min: 1, max: 1e11 })), gst = P(num(b.gst, 'GST paid', { min: 0, max: 1e10, def: 0 }));
  const method = oneOf(String(b.method || 'wdv'), ['wdv', 'slm'], 'Method');
  const rate = method === 'wdv' ? num(b.rate, 'Rate', { min: 0.1, max: 100, def: CATEGORIES[category].rate }) : null;
  const life = method === 'slm' ? num(b.life_years, 'Useful life', { min: 0.5, max: 100, def: CATEGORIES[category].life }) : null;
  const salvage = P(num(b.salvage, 'Residual value', { min: 0, max: cost / 100, def: 0 }));
  const paid = oneOf(String(b.paid || 'cash'), ['cash', 'supplier', 'opening'], 'Paid');
  const sys = await assetAccounts(c);
  let opening = 0, credit;
  if (paid === 'cash') { credit = [{ account: (await cashAccount(c.db, c.org.id, +b.account_id)).id, amount: -(cost + gst) }]; checkBackdate(c.user, bought, today(), 'an asset'); }
  else if (paid === 'supplier') {
    const p = await c.db.prepare(`SELECT id FROM parties WHERE id = ? AND org_id = ? AND kind IN ('supplier', 'both')`).bind(+b.party_id || 0, c.org.id).first();
    if (!p) throw bad('Choose the supplier you owe for it.');
    credit = [{ account: sys.ap, amount: -(cost + gst), party: p.id }];
    checkBackdate(c.user, bought, today(), 'an asset');
  } else {
    opening = P(num(b.opening_dep, 'Depreciation charged before', { min: 0, max: (cost - salvage) / 100, def: 0 }));
    credit = [{ account: sys.acc_dep, amount: -opening }, { account: sys.opening, amount: -(cost + gst - opening) }];
  }
  const lines = [{ account: sys.fixed_assets, amount: cost }, { account: sys.gst_input, amount: gst }, ...credit];
  const r = await c.db.prepare(`INSERT INTO fixed_assets (org_id, name, category, bought_on, cost, method, rate, life_years, salvage, opening_dep, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(c.org.id, name, category, bought, cost, method, rate, life, salvage, opening, str(b.notes, 300), c.user.id, nowIso()).first();
  await c.db.batch([...journalStatements(c.db, c, { date: bought, narration: `Fixed asset: ${name}${paid === 'opening' ? ' (already owned)' : ''}`, refType: 'ASSET', refId: r.id, lines }),
    auditStatement(c, 'asset added', `${name} ${cost / 100}`)]);
  return out({ ...(await c.db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).bind(r.id).first()), dep_booked: 0 });
}

/* the year's depreciation of every asset, before booking it (fy = the first day of the financial year) */
export async function previewDep(c, fy) {
  requireCan(c.user, 'finance');
  const from = isoDate(fy, 'Year'), to = fyEnd(from);
  if (from !== fyStart(c.org, from)) throw bad('Choose a financial year.');
  const done = await c.db.prepare(`SELECT total, created_at FROM dep_runs WHERE org_id = ? AND fy = ?`).bind(c.org.id, from).first();
  const { results: before } = await c.db.prepare(`SELECT asset_id, SUM(amount) AS s FROM asset_dep WHERE org_id = ? AND fy < ? GROUP BY asset_id`).bind(c.org.id, from).all();
  const prior = new Map(before.map((x) => [x.asset_id, x.s]));
  const lines = (await rows(c)).filter((a) => a.bought_on <= to && (!a.sold_on || a.sold_on >= from)).map((a) => {
    const b = a.opening_dep + (prior.get(a.id) || 0), amount = depFor(a, from, to, b);
    return { id: a.id, name: a.name, method: a.method, rate: a.rate, life_years: a.life_years, opening: (a.cost - b) / 100, amount: amount / 100, closing: (a.cost - b - amount) / 100 };
  });
  return { fy: from, label: fyLabel(from), to, lines, total: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100, booked: done ? { total: done.total / 100, at: done.created_at } : null,
    can_book: !done && to <= addDaysIso(today(), 31) };
}
const addDaysIso = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/* book the year's depreciation, once, dated the last day of the year */
export async function bookDep(c, fy) {
  const p = await previewDep(c, fy);
  if (p.booked) throw bad(`Depreciation for ${p.label} is already booked.`);
  if (!p.can_book) throw bad(`${p.label} has not ended yet. Book its depreciation at the year end.`);
  const items = p.lines.filter((l) => l.amount > 0);
  if (!items.length) throw bad('No depreciation for this year.');
  const sys = await assetAccounts(c), total = items.reduce((s, l) => s + P(l.amount), 0), now = nowIso();
  await c.db.batch([
    ...items.map((l) => c.db.prepare(`INSERT INTO asset_dep (org_id, asset_id, fy, amount, created_at) VALUES (?, ?, ?, ?, ?)`).bind(c.org.id, l.id, p.fy, P(l.amount), now)),
    c.db.prepare(`INSERT INTO dep_runs (org_id, fy, total, created_by, created_at) VALUES (?, ?, ?, ?, ?)`).bind(c.org.id, p.fy, total, c.user.id, now),
    ...journalStatements(c.db, c, { date: p.to, narration: `Depreciation ${p.label} (${items.length} asset${items.length > 1 ? 's' : ''})`, refType: 'DEP', refId: null,
      lines: [{ account: sys.depreciation, amount: total }, { account: sys.acc_dep, amount: -total }] }),
    auditStatement(c, 'depreciation', `${p.label}: ${total / 100}`),
  ]);
  return { fy: p.fy, label: p.label, total: total / 100, assets: items.length };
}

/* take a year's depreciation back (a mistake, an asset added late): the same journal the other way */
export async function undoDep(c, fy) {
  requireCan(c.user, 'finance');
  const from = isoDate(fy, 'Year');
  const run = await c.db.prepare(`SELECT * FROM dep_runs WHERE org_id = ? AND fy = ?`).bind(c.org.id, from).first();
  if (!run) throw bad('Nothing is booked for that year.');
  const later = await c.db.prepare(`SELECT fy FROM dep_runs WHERE org_id = ? AND fy > ? LIMIT 1`).bind(c.org.id, from).first();
  if (later) throw bad(`Undo ${fyLabel(later.fy)} first: each year starts from the one before.`);
  const sys = await assetAccounts(c);
  await c.db.batch([
    c.db.prepare(`DELETE FROM asset_dep WHERE org_id = ? AND fy = ?`).bind(c.org.id, from),
    c.db.prepare(`DELETE FROM dep_runs WHERE id = ?`).bind(run.id),
    ...journalStatements(c.db, c, { date: fyEnd(from), narration: `Depreciation ${fyLabel(from)} taken back`, refType: 'DEP', refId: null,
      lines: [{ account: sys.acc_dep, amount: run.total }, { account: sys.depreciation, amount: -run.total }] }),
    auditStatement(c, 'depreciation undone', fyLabel(from)),
  ]);
  return { ok: true };
}

/* sold or scrapped: out of the books at cost less its depreciation, the difference a gain or a loss */
export async function disposeAsset(c, id, b) {
  requireCan(c.user, 'finance');
  const a = (await rows(c)).find((x) => x.id === id);
  if (!a) throw notFound('Asset not found.');
  if (a.sold_on) throw bad('This asset is already sold or scrapped.');
  const on = isoDate(b.date, 'Date');
  if (on < a.bought_on) throw bad('It cannot go before it was bought.');
  checkBackdate(c.user, on, today(), 'a sale');
  const amount = P(num(b.amount, 'Sold for', { min: 0, max: 1e11, def: 0 }));
  const sys = await assetAccounts(c), dep = a.opening_dep + a.dep_booked, gain = amount + dep - a.cost;
  const lines = [{ account: sys.acc_dep, amount: dep }, { account: sys.fixed_assets, amount: -a.cost }];
  if (amount) lines.push({ account: (await cashAccount(c.db, c.org.id, +b.account_id)).id, amount });
  if (gain > 0) lines.push({ account: sys.other_income, amount: -gain }); else if (gain < 0) lines.push({ account: sys.asset_loss, amount: -gain });
  await c.db.batch([c.db.prepare(`UPDATE fixed_assets SET sold_on = ?, sold_for = ? WHERE id = ?`).bind(on, amount, id),
    ...journalStatements(c.db, c, { date: on, narration: `${amount ? 'Sold' : 'Scrapped'}: ${a.name}`, refType: 'ASSET', refId: id, lines }),
    auditStatement(c, amount ? 'asset sold' : 'asset scrapped', `${a.name} ${amount / 100}`)]);
  return { gain: gain / 100 };
}
