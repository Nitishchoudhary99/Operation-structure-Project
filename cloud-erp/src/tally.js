/* Tally Prime / Tally ERP 9 export: one XML file with the ledger masters and every voucher in a period.
   Import in Tally: Gateway → Import → Masters (or Vouchers) → choose this file. Masters are created first.
   Built from the double-entry journal, so Tally's trial balance matches this ERP's exactly. */
import { period } from './reports.js';

const x = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const amt = (paise) => (paise / 100).toFixed(2);

/* Where each of our accounts sits in Tally's standard groups. */
function groupOf(a) {
  switch (a.sys) {
    case 'cash': return 'Cash-in-Hand';
    case 'bank': case 'upi': return 'Bank Accounts';
    case 'inventory': return 'Current Assets';
    case 'gst_input': case 'gst_output': return 'Duties & Taxes';
    case 'grni': return 'Current Liabilities';
    case 'capital': case 'opening': case 'drawings': return 'Capital Account';
    case 'sales': return 'Sales Accounts';
    case 'other_income': return 'Indirect Incomes';
    case 'cogs': return 'Direct Expenses';
    default: break;
  }
  if (a.is_cash) return 'Bank Accounts';
  return { asset: 'Current Assets', liability: 'Current Liabilities', equity: 'Capital Account', income: 'Indirect Incomes', expense: 'Indirect Expenses' }[a.type];
}
const VCH = { INV: 'Sales', SRET: 'Credit Note', BILL: 'Purchase', PRET: 'Debit Note', receipt: 'Receipt', payment: 'Payment' };

export async function tallyXml(db, org, q) {
  const { from, to } = period(org, q);
  const { results: accts } = await db.prepare(`SELECT * FROM accounts WHERE org_id = ?`).bind(org.id).all();
  const byId = new Map(accts.map((a) => [a.id, a]));
  const { results: rows } = await db.prepare(`
    SELECT j.id, j.date, j.narration, j.ref_type, j.ref_id, jl.account_id, jl.party_id, jl.debit, jl.credit,
           p.name AS party, p.kind AS party_kind, p.gstin, p.state,
           COALESCE(d.number, pay.number, '') AS number
    FROM journals j JOIN journal_lines jl ON jl.journal_id = j.id
    LEFT JOIN parties p ON p.id = jl.party_id
    LEFT JOIN docs d ON d.id = j.ref_id AND j.ref_type IN ('INV','SRET','BILL','PRET','DN','GRN')
    LEFT JOIN payments pay ON pay.id = j.ref_id AND j.ref_type IN ('receipt','payment')
    WHERE j.org_id = ? AND j.date >= ? AND j.date <= ? ORDER BY j.date, j.id, jl.id`).bind(org.id, from, to).all();

  // a party line on Debtors/Creditors posts to the party's own ledger in Tally
  const ledgerName = (r) => {
    const a = byId.get(r.account_id);
    if (r.party && a && (a.sys === 'ar' || a.sys === 'ap')) return r.party;
    return a ? a.name : 'Suspense';
  };
  const usedAccounts = new Set(), parties = new Map();
  const vouchers = new Map();
  for (const r of rows) {
    const a = byId.get(r.account_id);
    if (r.party && a && (a.sys === 'ar' || a.sys === 'ap')) parties.set(r.party, { gstin: r.gstin, state: r.state, group: a.sys === 'ar' ? 'Sundry Debtors' : 'Sundry Creditors' });
    else usedAccounts.add(r.account_id);
    if (!vouchers.has(r.id)) vouchers.set(r.id, { ...r, lines: [] });
    vouchers.get(r.id).lines.push({ ledger: ledgerName(r), amount: r.debit - r.credit });
  }

  const masters = [];
  for (const id of usedAccounts) {
    const a = byId.get(id);
    masters.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${x(a.name)}" ACTION="Create"><NAME.LIST><NAME>${x(a.name)}</NAME></NAME.LIST><PARENT>${x(groupOf(a))}</PARENT>${a.sys === 'gst_input' || a.sys === 'gst_output' ? '<TAXTYPE>GST</TAXTYPE>' : ''}</LEDGER></TALLYMESSAGE>`);
  }
  for (const [name, p] of parties) {
    masters.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${x(name)}" ACTION="Create"><NAME.LIST><NAME>${x(name)}</NAME></NAME.LIST><PARENT>${p.group}</PARENT><ISBILLWISEON>Yes</ISBILLWISEON>${p.gstin ? `<PARTYGSTIN>${x(p.gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>'}${p.state ? `<LEDSTATENAME>${x(p.state)}</LEDSTATENAME>` : ''}</LEDGER></TALLYMESSAGE>`);
  }

  const vch = [];
  for (const v of vouchers.values()) {
    const type = VCH[v.ref_type] || 'Journal';
    const party = v.lines.find((l) => parties.has(l.ledger));
    // Tally convention: debit = ISDEEMEDPOSITIVE Yes with a negative amount; credit = No with a positive amount
    const entries = v.lines.filter((l) => l.amount).map((l) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.amount > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(-l.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('');
    vch.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${v.date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${x(v.number || 'ST-' + v.id)}</VOUCHERNUMBER>${party ? `<PARTYLEDGERNAME>${x(party.ledger)}</PARTYLEDGERNAME>` : ''}<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><NARRATION>${x(v.narration)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`);
  }

  const env = (report, body) => `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return { from, to, vouchers: vch.length, ledgers: masters.length,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n` + env('Vouchers', masters.join('\n') + '\n' + vch.join('\n')) };
}
