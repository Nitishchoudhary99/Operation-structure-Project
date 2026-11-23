/* Dukaan Doctor: a few plain checks over the business's own data. Each finding is one problem, what it is worth
   in rupees, and the one screen that fixes it. Read-only; a check the user's role may not see (money owed, costs)
   is left out for them. Amounts in paise here; the route turns them into rupees. */
import { today, addDays } from './lib.js';

const MIN_PAISE = 50000;      // findings under ₹500 are noise for a shop

export async function diagnose(c, { costs, sales, stock }) {
  const db = c.db, org = c.org.id, t = today();
  const out = [];
  const q = (sql, ...a) => db.prepare(sql).bind(...a).all().then((r) => r.results);

  // 1. money stuck: sale bills unpaid for over 60 days
  if (sales) {
    const [r] = await q(`SELECT COUNT(DISTINCT party_id) AS people, COUNT(*) AS bills, COALESCE(SUM(total - paid), 0) AS amt FROM docs
        WHERE org_id = ? AND type = 'INV' AND status != 'cancelled' AND total > paid AND date < ?`, org, addDays(t, -60));
    if (r.amt >= MIN_PAISE) out.push({ k: 'udhaar', level: r.amt >= 2500000 ? 'high' : 'mid', amount: r.amt,
      title: `₹${rs(r.amt)} stuck with ${r.people} customer${r.people === 1 ? '' : 's'} for over 60 days`,
      detail: `${r.bills} unpaid bill${r.bills === 1 ? '' : 's'}. The longer it waits, the harder it comes back.`, action: 'Send reminders', href: 'reminders' });
  }

  // 2. about to run out: at the last 30 days' pace, gone within 7 days
  if (stock) {
    const rows = await q(`SELECT i.id, i.name, i.unit, i.qty_on_hand AS have, SUM(dl.qty) AS sold FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id JOIN items i ON i.id = dl.item_id
        WHERE d.org_id = ? AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ? AND i.is_service = 0
        GROUP BY i.id HAVING sold > 0 AND i.qty_on_hand * 30.0 / sold < 7 ORDER BY i.qty_on_hand * 30.0 / sold LIMIT 20`, org, addDays(t, -30));
    if (rows.length) {
      const days = (r) => Math.max(0, Math.floor(r.have * 30 / r.sold));
      out.push({ k: 'runout', level: rows.some((r) => r.have <= 0) ? 'high' : 'mid', amount: 0,
        title: `${rows.length} fast-selling item${rows.length === 1 ? '' : 's'} will run out within a week`,
        detail: rows.slice(0, 4).map((r) => `${r.name}: ${r.have <= 0 ? 'out now' : `~${days(r)} day${days(r) === 1 ? '' : 's'} left`}`).join(' · '),
        action: 'Make a purchase order', href: 'new/PO', items: rows.map((r) => ({ id: r.id, name: r.name, have: r.have, sold30: r.sold })) });
    }
  }

  // 3. dead stock: in hand, not sold for 90 days (value at cost: only for roles that see costs)
  if (stock && costs) {
    const [r] = await q(`SELECT COUNT(*) AS n, COALESCE(SUM(i.qty_on_hand * i.avg_cost), 0) AS amt FROM items i
        WHERE i.org_id = ? AND i.is_service = 0 AND i.qty_on_hand > 0 AND i.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id WHERE dl.item_id = i.id AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ?)`,
    org, addDays(t, -90), addDays(t, -90));
    if (r.amt >= MIN_PAISE) out.push({ k: 'dead', level: r.amt >= 5000000 ? 'high' : 'mid', amount: Math.round(r.amt),
      title: `₹${rs(r.amt)} of stock has not sold in 90 days`,
      detail: `${r.n} item${r.n === 1 ? '' : 's'} sitting on the shelf. A small discount or a return to the supplier frees this money.`, action: 'See slow stock', href: 'stock-ageing' });
  }

  // 4. sold below cost in the last 30 days (only for roles that see costs)
  if (sales && costs) {
    const [r] = await q(`SELECT COUNT(*) AS n, COALESCE(SUM(dl.cost - dl.taxable), 0) AS amt FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id
        WHERE d.org_id = ? AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ? AND dl.item_id IS NOT NULL AND dl.cost > dl.taxable`, org, addDays(t, -30));
    if (r.amt >= MIN_PAISE) out.push({ k: 'loss', level: 'high', amount: r.amt,
      title: `₹${rs(r.amt)} lost selling below cost this month`,
      detail: `${r.n} bill line${r.n === 1 ? '' : 's'} sold for less than the item cost you. Check the sale prices.`, action: 'Check prices', href: 'items' });
  }

  // 5. one person giving much more discount than the rest (last 30 days, owners and admins only)
  if (c.user.role === 'owner' || c.user.role === 'admin') {
    const rows = await q(`SELECT d.created_by AS uid, u.name, COUNT(*) AS lines, SUM(dl.qty * dl.rate * dl.discount_pct / 100.0) AS given, SUM(dl.qty * dl.rate) AS gross
        FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id LEFT JOIN users u ON u.id = d.created_by
        WHERE d.org_id = ? AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ? GROUP BY d.created_by HAVING lines >= 10`, org, addDays(t, -30));
    if (rows.length >= 2) {
      const pct = (r) => (r.gross ? r.given * 100 / r.gross : 0);
      for (const r of rows) {
        const others = rows.filter((x) => x !== r), og = others.reduce((s, x) => s + x.given, 0), ogr = others.reduce((s, x) => s + x.gross, 0), op = ogr ? og * 100 / ogr : 0;
        if (pct(r) >= 5 && pct(r) >= op * 2 + 2 && r.given >= MIN_PAISE) {
          out.push({ k: 'discount', level: 'mid', amount: Math.round(r.given - r.gross * op / 100),
            title: `${r.name || 'One user'} gave ${pct(r).toFixed(1)}% discount; others gave ${op.toFixed(1)}%`,
            detail: `₹${rs(r.given)} of discount on ${r.lines} bill lines this month. Set a discount limit for the role if this is not meant.`, action: 'Set role limits', href: 'settings/roles' });
        }
      }
    }
  }
  const rank = { high: 0, mid: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.amount - a.amount);
}
const rs = (paise) => Math.round(paise / 100).toLocaleString('en-IN');
