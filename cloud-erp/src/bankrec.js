/* Bank reconciliation: the bank's statement (CSV or Excel from net banking: SBI, HDFC, ICICI, Axis, Kotak ...) next to
   the books of that bank account. Each statement line is matched to an entry in the books by amount and direction,
   within a week of its date, a cheque / UTR number in the narration winning a tie. Matched entries are marked cleared
   with the bank's date (bank_clear), so they never come up again; what the bank shows and the books do not (charges,
   interest, a customer's direct transfer) is added in one tap, and the Bank Reconciliation Statement says why the
   two balances differ: deposits not yet credited and cheques not yet presented. */
import { bad, str, today, nowIso, date as isoDate, loadByIds } from './lib.js';
import { requireCan } from './auth.js';
import { parseCsv } from './channels.js';

/* ---------- reading a statement ---------- */
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function bankDate(v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(+t) * 864e5).toISOString().slice(0, 10);   // an Excel date number
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const yy = (y) => (y.length === 2 ? (+y > 70 ? '19' : '20') + y : y);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  if (m) return `${yy(m[3])}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[a-z]*[\s/,-]+(\d{2}|\d{4})\b/);
  if (m && MON.includes(m[2].toLowerCase())) return `${yy(m[3])}-${String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
const amt = (v) => {
  const t = String(v ?? '').replace(/[₹,\s]|inr|rs\.?/gi, '');
  const x = parseFloat(t.replace(/(cr|dr)$/i, ''));
  return Number.isFinite(x) ? x : NaN;
};
const H = (h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
const FIND = {
  date: [/^(txn|tran|transaction|posting) ?date$/, /^date$/, /^value ?(date|dt)$/],
  desc: [/narration|description|particulars|remarks|details/],
  ref: [/chq|cheque|ref|utr/],
  debit: [/withdraw/, /^debit/, /^dr( amount)?$/],
  credit: [/deposit/, /^credit/, /^cr( amount)?$/],
  amount: [/^amount/, /^(txn|transaction) amount/],
  drcr: [/dr ?\/ ?cr|cr ?\/ ?dr|^type$|debit ?\/ ?credit/],
  balance: [/balance/, /^bal$/],
};
function header(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i].map(H), at = {};
    for (const [k, res] of Object.entries(FIND)) {
      for (const re of res) { const j = h.findIndex((x, n) => re.test(x) && !Object.values(at).includes(n) && !(k === 'ref' && /date/.test(x))); if (j >= 0) { at[k] = j; break; } }
    }
    if (at.date !== undefined && ((at.debit !== undefined && at.credit !== undefined) || at.amount !== undefined)) return { row: i, at };
  }
  return null;
}
/* the statement's lines: [{ i, date, desc, ref, amount (+ money in, - money out), balance }] */
export function readStatement(csv) {
  const rows = parseCsv(csv);
  const hd = header(rows);
  if (!hd) throw bad('Could not find the columns in this statement: it needs a Date column and Withdrawal / Deposit (or Debit / Credit, or Amount) columns. Download it from net banking as Excel or CSV.');
  const { at } = hd, get = (r, k) => (at[k] === undefined ? '' : String(r[at[k]] ?? '').trim());
  const out = [];
  for (const r of rows.slice(hd.row + 1)) {
    const d = bankDate(get(r, 'date'));
    if (!d) continue;                                                     // totals, blank lines, the bank's footer
    let a;
    if (at.debit !== undefined && at.credit !== undefined) {
      const dr = amt(get(r, 'debit')), cr = amt(get(r, 'credit'));
      a = (Number.isFinite(cr) ? Math.abs(cr) : 0) - (Number.isFinite(dr) ? Math.abs(dr) : 0);
    } else {
      a = amt(get(r, 'amount'));
      const t = get(r, 'drcr').toLowerCase();
      if (/^d|debit|withdraw/.test(t)) a = -Math.abs(a); else if (/^c|credit|deposit/.test(t)) a = Math.abs(a);
    }
    if (!Number.isFinite(a) || Math.abs(a) < 0.005) continue;
    const bal = amt(get(r, 'balance'));
    out.push({ i: out.length, date: d, desc: str(get(r, 'desc'), 200), ref: str(get(r, 'ref'), 60), amount: Math.round(a * 100) / 100,
      balance: Number.isFinite(bal) ? (/dr$/i.test(get(r, 'balance')) ? -bal : bal) : null });
  }
  if (!out.length) throw bad('No transactions found in this statement.');
  if (out.length > 5000) throw bad('At most 5000 lines at a time: download one month.');
  return out;
}
/* the same statement line read again is the same key */
const keyOf = (s) => `${s.date}|${Math.round(s.amount * 100)}|${s.ref || ''}|${(s.desc || '').slice(0, 40)}`.slice(0, 200);

async function bankAccount(c, id) {
  const a = await c.db.prepare(`SELECT id, name, code FROM accounts WHERE id = ? AND org_id = ? AND is_cash = 1`).bind(+id || 0, c.org.id).first();
  if (!a) throw bad('Choose the bank account this statement is for.');
  return a;
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

/* POST /api/bank/check { account_id, csv }: the statement matched to the books */
export async function checkStatement(c, body) {
  requireCan(c.user, 'finance');
  const acct = await bankAccount(c, body.account_id);
  const stmt = readStatement(body.csv);
  const from = stmt.reduce((m, s) => (s.date < m ? s.date : m), stmt[0].date), to = stmt.reduce((m, s) => (s.date > m ? s.date : m), stmt[0].date);
  // the books of this account a week either side, with what each entry was (party, bill, UTR)
  const { results: book } = await c.db.prepare(`SELECT l.id, l.date, l.debit, l.credit, j.narration, j.ref_type, p.number AS pay_no, p.reference, pt.name AS party,
      bc.bank_date, bc.stmt_key FROM journal_lines l JOIN journals j ON j.id = l.journal_id
      LEFT JOIN payments p ON j.ref_type IN ('receipt', 'payment') AND p.id = j.ref_id AND p.org_id = l.org_id
      LEFT JOIN parties pt ON pt.id = COALESCE(l.party_id, p.party_id)
      LEFT JOIN bank_clear bc ON bc.line_id = l.id
      WHERE l.org_id = ? AND l.account_id = ? AND l.date BETWEEN ? AND ? ORDER BY l.date, l.id`).bind(c.org.id, acct.id, addDays(from, -10), addDays(to, 10)).all();
  // the other side of each entry (who paid, what for), for lines whose own party is empty
  const used = new Set(), keysDone = new Set(book.filter((b) => b.stmt_key).map((b) => b.stmt_key));
  const lines = stmt.map((s) => {
    const k = keyOf(s), o = { ...s, key: k, status: 'none' };
    if (keysDone.has(k)) { o.status = 'done'; o.line = book.find((b) => b.stmt_key === k).id; return o; }
    const want = Math.round(s.amount * 100), text = `${s.desc} ${s.ref}`.toLowerCase();
    const cand = book.filter((b) => !b.bank_date && !used.has(b.id) && (want > 0 ? b.debit === want : b.credit === -want) && daysApart(b.date, s.date) <= 7)
      .map((b) => ({ b, score: (b.reference && b.reference.length >= 4 && text.includes(b.reference.toLowerCase()) ? 100 : 0) + (b.pay_no && text.includes(b.pay_no.toLowerCase()) ? 50 : 0)
        + (b.party && b.party.length >= 4 && text.includes(b.party.toLowerCase().slice(0, 12)) ? 20 : 0) - daysApart(b.date, s.date) }))
      .sort((x, y) => y.score - x.score);
    if (cand.length) {
      const b = cand[0].b;
      used.add(b.id);
      Object.assign(o, { status: 'match', line: b.id, book: { date: b.date, narration: b.narration, party: b.party, ref: b.reference || b.pay_no || '' } });
    }
    return o;
  });
  const bookOpen = book.filter((b) => !b.bank_date && !used.has(b.id) && b.date >= from && b.date <= to)
    .map((b) => ({ id: b.id, date: b.date, amount: (b.debit - b.credit) / 100, narration: b.narration, party: b.party, ref: b.reference || b.pay_no || '' }));
  const last = [...stmt].reverse().find((s) => s.balance !== null);
  return { account: acct, from, to, lines, book_open: bookOpen, closing: last ? last.balance : null,
    counts: { lines: lines.length, matched: lines.filter((l) => l.status === 'match').length, done: lines.filter((l) => l.status === 'done').length, none: lines.filter((l) => l.status === 'none').length } };
}

/* POST /api/bank/clear { account_id, items: [{ line, date, key }] }: the matches the owner accepted */
export async function clearLines(c, body) {
  requireCan(c.user, 'finance');
  const acct = await bankAccount(c, body.account_id);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 5000);
  if (!items.length) return { cleared: 0 };
  const mine = new Set((await loadByIds(c.db, `SELECT id FROM journal_lines WHERE org_id = ? AND account_id = ? AND id IN (?ids)`, [c.org.id, acct.id], items.map((x) => +x.line))).map((x) => x.id));
  const now = nowIso(), st = [];
  for (const x of items) {
    if (!mine.has(+x.line)) continue;
    st.push(c.db.prepare(`INSERT INTO bank_clear (line_id, org_id, account_id, bank_date, stmt_key, cleared_by, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(line_id) DO NOTHING`).bind(+x.line, c.org.id, acct.id, isoDate(x.date, 'Bank date'), str(x.key, 200), c.user.id, now));
  }
  if (st.length) await c.db.batch(st);
  return { cleared: st.length };
}

export async function unclearLine(c, lineId) {
  requireCan(c.user, 'finance');
  await c.db.prepare(`DELETE FROM bank_clear WHERE line_id = ? AND org_id = ?`).bind(lineId, c.org.id).run();
  return { ok: true };
}

/* GET /api/bank/brs?account_id&date: Bank Reconciliation Statement on a date */
export async function brs(c, q) {
  requireCan(c.user, 'finance');
  const acct = await bankAccount(c, q.get('account_id'));
  const on = q.get('date') ? isoDate(q.get('date')) : today();
  const [bal, open] = await c.db.batch([
    c.db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ? AND account_id = ? AND date <= ?`).bind(c.org.id, acct.id, on),
    c.db.prepare(`SELECT l.id, l.date, l.debit, l.credit, j.narration, pt.name AS party, p.reference FROM journal_lines l JOIN journals j ON j.id = l.journal_id
      LEFT JOIN payments p ON j.ref_type IN ('receipt', 'payment') AND p.id = j.ref_id AND p.org_id = l.org_id LEFT JOIN parties pt ON pt.id = COALESCE(l.party_id, p.party_id)
      LEFT JOIN bank_clear bc ON bc.line_id = l.id
      WHERE l.org_id = ? AND l.account_id = ? AND l.date <= ? AND (bc.line_id IS NULL OR bc.bank_date > ?) ORDER BY l.date, l.id LIMIT 1000`).bind(c.org.id, acct.id, on, on),
  ]);
  const books = bal.results[0].b / 100;
  const row = (x) => ({ id: x.id, date: x.date, amount: (x.debit - x.credit) / 100, narration: x.narration, party: x.party, ref: x.reference || '' });
  const notCredited = open.results.filter((x) => x.debit > 0).map(row), notPresented = open.results.filter((x) => x.credit > 0).map(row);
  const sum = (a) => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  return { account: acct, date: on, books, not_credited: notCredited, not_presented: notPresented,
    bank: Math.round((books - sum(notCredited) - sum(notPresented)) * 100) / 100 };
}
