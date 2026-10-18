/* CSV for the Export buttons. A cell that starts with = + - @ (or a tab or return) is read as a formula by Excel and Sheets,
   so a party or item name like =HYPERLINK(...) typed by a staff member could run when the owner opens the file.
   Such text gets a ' in front. Real numbers (-1500.00, +919876543210) are left alone. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !(typeof v === 'number' || /^[+-]?\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(cols, rows) {
  return [cols.map((c) => csvCell(c.h)).join(','), ...rows.map((r) => cols.map((c) => csvCell(c.csv ? c.csv(r) : r[c.k])).join(','))].join('\n');
}
