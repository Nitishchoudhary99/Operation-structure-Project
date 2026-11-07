/* Taxes cut from a salary that follow the law rather than the person: professional tax by the state's slab, and
   income-tax TDS on salary under the new regime (Income-tax Act, 2025, section 392; the yearly certificate is Form 130,
   the quarterly return Form 138). All amounts here are in rupees; payroll.js works in paise.
   Professional tax slabs: the salary slabs of each state as compiled for FY 2026-27 (state notifications prevail; a fixed
   amount typed on the person always wins). Odisha abolished its professional tax from 1 April 2026. */

const INF = Infinity;
/* kind m: on the month's gross; a: on the year's income (month × 12), cut as 1/12 a month with the rest in March;
   h: on the half-year's income (month × 6), cut as 1/6 a month with the rest in September and March.
   feb: the ₹200 band pays ₹300 in February (so the year comes to ₹2,500). Bands: [up to (₹, inclusive), tax] */
export const PT_SLABS = {
  Maharashtra: { kind: 'm', feb: true, bands: [[7500, 0], [10000, 175], [INF, 200]], women: [[25000, 0], [INF, 200]] },
  Karnataka: { kind: 'm', feb: true, bands: [[24999, 0], [INF, 200]] },
  Telangana: { kind: 'm', bands: [[15000, 0], [20000, 150], [INF, 200]] },
  'Andhra Pradesh': { kind: 'm', bands: [[15000, 0], [20000, 150], [INF, 200]] },
  'West Bengal': { kind: 'm', bands: [[10000, 0], [15000, 110], [25000, 130], [40000, 150], [INF, 200]] },
  Gujarat: { kind: 'm', bands: [[12000, 0], [INF, 200]] },
  Assam: { kind: 'm', bands: [[15000, 0], [25000, 180], [INF, 208]] },
  Tripura: { kind: 'm', bands: [[7500, 0], [15000, 150], [INF, 208]] },
  Sikkim: { kind: 'm', bands: [[20000, 0], [30000, 125], [40000, 150], [INF, 200]] },
  Mizoram: { kind: 'm', bands: [[5000, 0], [8000, 75], [10000, 120], [12000, 150], [15000, 180], [INF, 208]] },
  Nagaland: { kind: 'm', bands: [[4000, 0], [5000, 35], [7000, 75], [9000, 110], [12000, 180], [INF, 208]] },
  'Madhya Pradesh': { kind: 'a', bands: [[225000, 0], [300000, 1500], [400000, 2000], [INF, 2500]] },
  Bihar: { kind: 'a', bands: [[300000, 0], [500000, 1000], [1000000, 2000], [INF, 2500]] },
  Jharkhand: { kind: 'a', bands: [[300000, 0], [500000, 1200], [800000, 1800], [1000000, 2100], [INF, 2500]] },
  Meghalaya: { kind: 'a', bands: [[180000, 0], [300000, 500], [500000, 1000], [750000, 1500], [INF, 2500]] },
  Manipur: { kind: 'a', bands: [[50000, 0], [75000, 1200], [100000, 2000], [125000, 2400], [INF, 2500]] },
  Punjab: { kind: 'a', bands: [[400000, 0], [INF, 2400]] },
  'Tamil Nadu': { kind: 'h', bands: [[21000, 0], [30000, 180], [45000, 425], [60000, 930], [75000, 1025], [INF, 1250]] },
  Kerala: { kind: 'h', bands: [[11999, 0], [17999, 320], [29999, 450], [44999, 600], [99999, 750], [124999, 1000], [INF, 1250]] },
  Puducherry: { kind: 'h', bands: [[99999, 0], [200000, 250], [300000, 500], [400000, 750], [500000, 1000], [INF, 1250]] },
};
const band = (bands, amount) => (bands.find(([upto]) => amount <= upto) || [0, 0])[1];

/* the professional tax (₹) on one month's gross pay (₹) in a state; month 'YYYY-MM'; women: Maharashtra's own slab */
export function ptFor(state, grossRupees, month, women = false) {
  const s = PT_SLABS[String(state || '').trim()];
  const g = Math.max(0, Math.round(grossRupees || 0));
  if (!s || !g) return 0;
  const mm = +String(month).slice(5, 7);
  if (s.kind === 'm') {
    const t = band(women && s.women ? s.women : s.bands, g);
    return s.feb && mm === 2 && t === 200 ? 300 : t;
  }
  if (s.kind === 'a') {
    const year = band(s.bands, g * 12), each = Math.floor(year / 12);
    return mm === 3 ? year - each * 11 : each;
  }
  const half = band(s.bands, g * 6), each = Math.floor(half / 6);
  return mm === 3 || mm === 9 ? half - each * 5 : each;
}
export const ptStates = () => Object.keys(PT_SLABS);

/* ---------- income tax on salary, new regime (the default), tax year April–March ----------
   Standard deduction ₹75,000; slabs 0–4 lakh nil, then 5% steps every 4 lakh up to 30% above 24 lakh; rebate (section
   157, the old 87A) makes the tax nil up to ₹12 lakh of taxable income, with marginal relief just above it;
   surcharge 10% above ₹50 lakh, 15% above ₹1 crore, 25% above ₹2 crore (with marginal relief); 4% health and education
   cess. The old regime is not worked out here: for a person who chose it, type the monthly TDS by hand. */
export const NEW_REGIME = { std: 75000, slabs: [[400000, 0], [800000, 5], [1200000, 10], [1600000, 15], [2000000, 20], [2400000, 25], [INF, 30]], rebate_upto: 1200000, cess: 4 };
const slabTax = (inc) => {
  let tax = 0, from = 0;
  for (const [upto, rate] of NEW_REGIME.slabs) {
    if (inc > from) tax += (Math.min(inc, upto) - from) * rate / 100;
    from = upto;
  }
  return tax;
};
const SURCHARGE = [[5e6, 10], [1e7, 15], [2e7, 25]];
/* yearly tax (₹, whole rupees) on a year's gross salary (₹) */
export function yearTax(grossYear) {
  const taxable = Math.max(0, Math.round(grossYear) - NEW_REGIME.std);
  let tax = slabTax(taxable);
  if (taxable <= NEW_REGIME.rebate_upto) tax = 0;
  else tax = Math.min(tax, taxable - NEW_REGIME.rebate_upto);           // marginal relief just above ₹12 lakh
  let sur = 0;
  for (let i = SURCHARGE.length - 1; i >= 0; i--) {
    const [at, rate] = SURCHARGE[i];
    if (taxable > at) {
      sur = tax * rate / 100;
      // marginal relief: tax + surcharge may not pass the tax at the threshold (with the lower surcharge) + income above it
      const below = i ? SURCHARGE[i - 1][1] : 0, atTax = slabTax(at) * (1 + below / 100);
      sur = Math.max(0, Math.min(sur, atTax + (taxable - at) - tax));
      break;
    }
  }
  return { taxable, tax: Math.round(tax), surcharge: Math.round(sur), cess: Math.round((tax + sur) * NEW_REGIME.cess / 100), total: Math.round((tax + sur) * (1 + NEW_REGIME.cess / 100)) };
}
/* the tax year a salary month falls in: '2026-11' → { start: '2026-04', label: '2026-27' } */
export function taxYearOf(month) {
  const y = +month.slice(0, 4), m = +month.slice(5, 7), s = m >= 4 ? y : y - 1;
  return { start: `${s}-04`, end: `${s + 1}-03`, label: `${s}-${String((s + 1) % 100).padStart(2, '0')}` };
}
const monthsLeft = (month) => { const m = +month.slice(5, 7); return m >= 4 ? 16 - m : 4 - m; };   // this month to March
/* this month's TDS (₹): the year's tax on (paid so far + this month × the months left), less what was cut already, spread
   over the months left. before: { gross, tds } of earlier months of the same tax year with this employer. */
export function monthTds(month, grossMonth, before = { gross: 0, tds: 0 }) {
  const left = monthsLeft(month);
  const projected = (before.gross || 0) + grossMonth * left;
  const y = yearTax(projected);
  const due = Math.max(0, y.total - (before.tds || 0));
  return { tds: Math.max(0, Math.round(due / left)), projected, year: y, months_left: left };
}
