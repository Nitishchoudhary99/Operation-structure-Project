/* "Download as Excel": the whole business as a readable workbook, one sheet per kind of record, amounts in rupees
   (the database keeps paise), names instead of ids. For reading and for an accountant; the JSON backup is the one
   that can be restored. */
import { workbook } from './xlsx.js';
import { DOC_TYPES } from './engine.js';

const R = (p) => (p === null || p === undefined ? null : Math.round(p) / 100);

export async function excelBackup(db, org) {
  const id = org.id, all = async (sql) => (await db.prepare(sql).bind(id).all()).results;
  const [docs, lines, parties, items, stock, pays, khata, jl, accts] = await Promise.all([
    all(`SELECT d.type, d.number, d.date, d.due_date, p.name AS party, d.status, d.taxable, d.cgst, d.sgst, d.igst, d.round_off, d.total, d.paid,
           d.place_of_supply, d.notes FROM docs d LEFT JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? ORDER BY d.date, d.id`),
    all(`SELECT d.type, d.number, d.date, p.name AS party, i.name AS item, i.hsn, l.description, l.qty, i.unit, l.rate, l.discount_pct, l.gst_rate,
           l.taxable, l.cgst, l.sgst, l.igst, l.total FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN parties p ON p.id = d.party_id
           LEFT JOIN items i ON i.id = l.item_id WHERE d.org_id = ? ORDER BY d.date, d.id, l.id`),
    all(`SELECT p.name, p.kind, p.phone, p.email, p.gstin, p.state, p.city, p.pincode, p.address, p.credit_limit, p.credit_days, COALESCE(b.bal, 0) AS bal
           FROM parties p LEFT JOIN party_bal b ON b.org_id = p.org_id AND b.party_id = p.id WHERE p.org_id = ? ORDER BY p.name`),
    all(`SELECT name, sku, barcode, category, unit, hsn, gst_rate, sale_price, purchase_price, qty_on_hand, avg_cost, reorder_level, is_service
           FROM items WHERE org_id = ? ORDER BY name`),
    all(`SELECT i.name AS item, w.name AS godown, s.qty FROM stock s JOIN items i ON i.id = s.item_id JOIN warehouses w ON w.id = s.warehouse_id
           WHERE s.org_id = ? AND ABS(s.qty) > 0.0005 ORDER BY i.name, w.name`),
    all(`SELECT y.number, y.kind, y.date, p.name AS party, a.name AS account, y.amount, y.reference, y.notes FROM payments y
           LEFT JOIN parties p ON p.id = y.party_id LEFT JOIN accounts a ON a.id = y.account_id WHERE y.org_id = ? ORDER BY y.date, y.id`),
    all(`SELECT k.date, p.name AS party, k.kind, k.amount, k.note, k.status FROM khata k LEFT JOIN parties p ON p.id = k.party_id
           WHERE k.org_id = ? ORDER BY k.date, k.id`),
    all(`SELECT j.date, j.ref_type, j.narration, a.code, a.name AS account, p.name AS party, l.debit, l.credit FROM journal_lines l
           JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id LEFT JOIN parties p ON p.id = l.party_id
           WHERE l.org_id = ? ORDER BY j.date, j.id, l.id`),
    all(`SELECT a.code, a.name, a.type, COALESCE(SUM(m.dr), 0) - COALESCE(SUM(m.cr), 0) AS bal FROM accounts a
           LEFT JOIN acct_month m ON m.org_id = a.org_id AND m.account_id = a.id WHERE a.org_id = ? GROUP BY a.id ORDER BY a.code`),
  ]);
  const label = (t) => (Object.hasOwn(DOC_TYPES, t) ? DOC_TYPES[t].label : t);
  const money = (h) => ({ h, money: 1 }), num = (h) => ({ h, num: 1, w: 10 }), text = (h, w) => ({ h, w });
  const sheets = [
    { name: 'Business', cols: [text('Field', 22), text('Value', 50)], rows: [
      ['Business name', org.name], ['GSTIN', org.gstin], ['State', org.state], ['Address', org.address], ['City', org.city], ['Pincode', org.pincode],
      ['Phone', org.phone], ['E-mail', org.email], ['UPI ID', org.upi_id], ['Financial year starts', org.fy_start],
      ['Exported on', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'], ['Note', 'Amounts are in rupees. The .json backup is the file that can be restored.']] },
    { name: 'Bills', cols: [text('Type', 16), text('Number', 14), text('Date', 12), text('Due date', 12), text('Party', 28), text('Status', 12),
        money('Taxable'), money('CGST'), money('SGST'), money('IGST'), money('Round off'), money('Total'), money('Paid'), money('Balance'), text('Place of supply'), text('Notes', 30)],
      rows: docs.map((d) => [label(d.type), d.number, d.date, d.due_date, d.party, d.status, R(d.taxable), R(d.cgst), R(d.sgst), R(d.igst), R(d.round_off), R(d.total),
        ['INV', 'BILL'].includes(d.type) ? R(d.paid) : null, ['INV', 'BILL'].includes(d.type) && d.status !== 'cancelled' ? R(d.total - d.paid) : null, d.place_of_supply, d.notes]) },
    { name: 'Bill items', cols: [text('Type', 16), text('Number', 14), text('Date', 12), text('Party', 24), text('Item', 26), text('HSN/SAC', 10), text('Description', 24),
        num('Qty'), text('Unit', 8), money('Rate'), num('Disc %'), num('GST %'), money('Taxable'), money('CGST'), money('SGST'), money('IGST'), money('Total')],
      rows: lines.map((l) => [label(l.type), l.number, l.date, l.party, l.item, l.hsn, l.description && l.description !== l.item ? l.description : '', l.qty, l.unit,
        R(l.rate), l.discount_pct || null, l.gst_rate, R(l.taxable), R(l.cgst), R(l.sgst), R(l.igst), R(l.total)]) },
    { name: 'Customers & suppliers', cols: [text('Name', 28), text('Type', 10), text('Phone', 14), text('E-mail', 24), text('GSTIN', 17), text('State', 16), text('City', 14),
        text('Pincode', 9), text('Address', 30), money('Credit limit'), num('Credit days'), money('Balance (+ they owe, - you owe)')],
      rows: parties.map((p) => [p.name, p.kind, p.phone, p.email, p.gstin, p.state, p.city, p.pincode, p.address, R(p.credit_limit), p.credit_days, R(p.bal)]) },
    { name: 'Items', cols: [text('Name', 28), text('SKU', 12), text('Barcode', 14), text('Category', 14), text('Unit', 8), text('HSN/SAC', 10), num('GST %'), money('Sale price'),
        money('Purchase price'), num('Stock qty'), money('Average cost'), money('Stock value'), num('Reorder level'), text('Service', 8)],
      rows: items.map((i) => [i.name, i.sku, i.barcode, i.category, i.unit, i.hsn, i.gst_rate, R(i.sale_price), R(i.purchase_price), i.is_service ? null : i.qty_on_hand,
        i.is_service ? null : R(i.avg_cost), i.is_service ? null : R(Math.max(0, i.qty_on_hand) * i.avg_cost), i.reorder_level, i.is_service ? 'Yes' : '']) },
    { name: 'Stock by godown', cols: [text('Item', 28), text('Godown', 18), num('Qty')], rows: stock.map((s) => [s.item, s.godown, s.qty]) },
    { name: 'Payments', cols: [text('Number', 14), text('Kind', 10), text('Date', 12), text('Party', 26), text('Account', 18), money('Amount'), text('Reference', 18), text('Notes', 26)],
      rows: pays.map((y) => [y.number, y.kind === 'receipt' ? 'Received' : 'Paid', y.date, y.party, y.account, R(y.amount), y.reference, y.notes]) },
    { name: 'Khata', cols: [text('Date', 12), text('Party', 26), text('Entry', 14), money('Amount'), text('Note', 28), text('Status', 10)],
      rows: khata.map((k) => [k.date, k.party, k.kind === 'gave' ? 'You gave' : 'You got', R(k.amount), k.note, k.status]) },
    { name: 'Journal', cols: [text('Date', 12), text('Source', 10), text('Narration', 34), text('Code', 8), text('Account', 24), text('Party', 22), money('Debit'), money('Credit')],
      rows: jl.map((l) => [l.date, l.ref_type, l.narration, l.code, l.account, l.party, R(l.debit) || null, R(l.credit) || null]) },
    { name: 'Accounts', cols: [text('Code', 8), text('Account', 28), text('Type', 12), money('Balance (debit +)')], rows: accts.map((a) => [a.code, a.name, a.type, R(a.bal)]) },
  ];
  return { bytes: await workbook(sheets), counts: { bills: docs.length, lines: lines.length, parties: parties.length, items: items.length } };
}
