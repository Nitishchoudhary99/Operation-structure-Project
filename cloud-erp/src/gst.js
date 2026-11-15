/* GST helpers: state codes, units (UQC), and the government JSON formats for
   e-invoice (NIC IRP schema 1.1) and e-way bill (bulk generation upload). These files are
   uploaded on the portals (or through a GSP); the IRN / e-way bill numbers you get back are saved on the document. */
import { bad, own } from './lib.js';

export const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Other Country'],
];
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const ALIAS = { up: '09', mp: '23', uk: '05', jk: '01', tn: '33', ap: '37', wb: '19', orissa: '21', pondicherry: '34', newdelhi: '07', uttaranchal: '05',
  outsideindia: '96', foreign: '96', foreigncountry: '96', abroad: '96', overseas: '96', export: '96' };
/* currencies an export invoice can be made in (ISO codes); the rate is rupees for one unit */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD', 'AUD', 'CAD', 'NZD', 'SGD', 'MYR', 'THB', 'HKD', 'JPY', 'CNY', 'CHF', 'ZAR',
  'NPR', 'BDT', 'LKR', 'RUB', 'KES', 'NGN'];
/* an export: a sale to a customer whose state is "Other Country" */
export const isExportParty = (p) => !!p && stateCode(p.state, p.gstin) === '96';

/* Two-digit GST state code from a GSTIN (first two digits) or a state name. '' if unknown. */
export function stateCode(state, gstin) {
  if (gstin && /^\d{2}/.test(gstin)) return gstin.slice(0, 2);
  const n = norm(state);
  if (!n) return '';
  const alias = own(ALIAS, n);
  if (alias) return alias;
  const hit = STATES.find(([, name]) => norm(name) === n) || STATES.find(([, name]) => norm(name).startsWith(n) && n.length >= 4);
  return hit ? hit[0] : '';
}

/* Unit Quantity Codes accepted by the portals; anything unknown is OTH. */
const UQC = { pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS', nos: 'NOS', no: 'NOS', number: 'NOS', kg: 'KGS', kgs: 'KGS', kilogram: 'KGS',
  g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', ltr: 'LTR', l: 'LTR', litre: 'LTR', liter: 'LTR', ml: 'MLT', mtr: 'MTR', m: 'MTR', metre: 'MTR',
  bag: 'BAG', bags: 'BAG', box: 'BOX', boxes: 'BOX', btl: 'BTL', bottle: 'BTL', dozen: 'DOZ', doz: 'DOZ', pack: 'PAC', pac: 'PAC', packet: 'PAC',
  set: 'SET', sets: 'SET', pair: 'PRS', prs: 'PRS', roll: 'ROL', tin: 'CAN', can: 'CAN', ton: 'TON', tonne: 'TON', qtl: 'QTL', quintal: 'QTL',
  sqft: 'SQF', sqm: 'SQM', ctn: 'CTN', carton: 'CTN', bundle: 'BDL', bdl: 'BDL', unit: 'UNT', units: 'UNT', tab: 'TBS', strip: 'NOS' };
export const uqc = (unit) => own(UQC, norm(unit)) || 'OTH';

const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pin = (p) => { const n = +String(p || '').replace(/\D/g, ''); return n >= 100000 && n <= 999999 ? n : null; };
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function sellerAndBuyerProblems(d) {
  const o = d.org, p = d.party || {}, problems = [];
  if (!/^\d{2}[A-Z0-9]{13}$/.test(o.gstin || '')) problems.push('your GSTIN (Settings)');
  if (!pin(o.pincode)) problems.push('your PIN code (Settings)');
  if (!cut(o.address, 100)) problems.push('your address (Settings)');
  return { o, p, problems };
}

/* e-invoice JSON for one invoice (INV) or credit note (SRET). Only for B2B: the buyer needs a GSTIN. */
export function einvoiceJson(d) {
  if (!['INV', 'SRET', 'CNOTE'].includes(d.type)) throw bad('E-invoices are made for sales invoices and credit notes.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  const { o, p, problems } = sellerAndBuyerProblems(d);
  const exp = d.export_type ? (d.export_type === 'WPAY' ? 'EXPWP' : 'EXPWOP') : '';
  if (!exp && !/^\d{2}[A-Z0-9]{13}$/.test(p.gstin || '')) problems.push(`the customer's GSTIN (e-invoice is only for B2B sales and exports)`);
  if (!exp && !pin(p.pincode)) problems.push(`the customer's PIN code`);
  if (problems.length) throw bad('To make the e-invoice, first fill in: ' + problems.join(', ') + '.');
  const sellerSt = stateCode(o.state, o.gstin), buyerSt = stateCode(p.state, p.gstin);
  const items = d.lines.map((l, i) => {
    // NIC takes a unit price with at most 3 decimals; an MRP line's rate has more (lib.js ratePaise)
    const unit = Math.round(l.rate * 1000) / 1000, gross = r2(l.qty * unit);
    return {
      SlNo: String(i + 1), PrdDesc: cut(l.item || l.description, 300) || 'Item', IsServc: l.is_service ? 'Y' : 'N', HsnCd: String(l.hsn || '').replace(/\D/g, '') || '9999',
      Qty: l.qty, Unit: uqc(l.unit), UnitPrice: unit, TotAmt: gross, Discount: Math.max(0, r2(gross - l.taxable)), AssAmt: l.taxable, GstRt: l.gst_rate,
      IgstAmt: l.igst, CgstAmt: l.cgst, SgstAmt: l.sgst, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0,
      OthChrg: 0, TotItemVal: l.total,
    };
  });
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: exp || 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: d.type === 'INV' ? 'INV' : 'CRN', No: d.number, Dt: dmy(d.date) },
    SellerDtls: { Gstin: o.gstin, LglNm: cut(o.name, 100), Addr1: cut(o.address, 100), Loc: cut(o.city || o.state, 50) || 'NA', Pin: pin(o.pincode), Stcd: sellerSt,
      ...(o.phone ? { Ph: String(o.phone).replace(/\D/g, '').slice(-12) } : {}), ...(o.email ? { Em: o.email } : {}) },
    BuyerDtls: { Gstin: exp ? 'URP' : p.gstin, LglNm: cut(p.name, 100), Pos: exp ? '96' : buyerSt, Addr1: cut(p.address, 100) || cut(p.city, 100) || 'NA', Loc: cut(p.city || p.country || p.state, 50) || 'NA',
      Pin: exp ? 999999 : pin(p.pincode), Stcd: exp ? '96' : buyerSt, ...(p.phone ? { Ph: String(p.phone).replace(/\D/g, '').slice(-12) } : {}), ...(p.email ? { Em: p.email } : {}) },
    ...(d.parent && d.type !== 'INV' ? { RefDtls: { PrecDocDtls: [{ InvNo: d.parent.number, InvDt: dmy(d.parent.date) }] } } : {}),
    ItemList: items,
    // exports: shipping bill, port and the invoice's currency (the portal also wants the country code when known)
    ...(exp ? { ExpDtls: { ...(d.sb_no ? { ShipBNo: d.sb_no } : {}), ...(d.sb_date ? { ShipBDt: dmy(d.sb_date) } : {}), ...(d.port_code ? { Port: d.port_code } : {}),
      ...(d.currency ? { ForCur: d.currency } : {}), ...(/^[A-Z]{2}$/.test(String(p.country || '').toUpperCase()) ? { CntCode: String(p.country).toUpperCase() } : {}) } } : {}),
    ValDtls: { AssVal: d.taxable, CgstVal: d.cgst, SgstVal: d.sgst, IgstVal: d.igst, CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: d.round_off, TotInvVal: d.total },
  };
}

/* e-way bill bulk-upload JSON for an outward invoice or delivery challan. t = transport details from the user. */
/* E-way bill kinds by document. Outward: our sale, delivery note, goods returned to a supplier. Inward: a purchase bill,
   goods a customer sends back. For inward documents the goods move from the other party to us. */
const EWB_KIND = {
  INV: { supplyType: 'O', sub: 1, desc: '', docType: 'INV' },
  DN: { supplyType: 'O', sub: 1, desc: '', docType: 'CHL' },
  PRET: { supplyType: 'O', sub: 8, desc: 'Purchase return', docType: 'CHL' },
  BILL: { supplyType: 'I', sub: 1, desc: '', docType: 'INV' },
  SRET: { supplyType: 'I', sub: 7, desc: '', docType: 'CHL' },
};
export const EWB_TYPES = Object.keys(EWB_KIND);
/* The law asks for an e-way bill when goods worth more than Rs 50,000 move (some states set other limits inside the state). */
export const EWB_LIMIT = 50000;
export const needsEwb = (d) => EWB_TYPES.includes(d.type) && d.status !== 'cancelled' && !d.ewb_no && (+d.total || 0) > EWB_LIMIT;
/* Validity (rule 138(10)): 1 day for each 200 km or part of it (20 km for over-dimensional cargo). A day ends at midnight,
   so a bill made on the 5th for 350 km is valid to the end of the 7th. Returns YYYY-MM-DD, or '' if the inputs are not usable. */
export function ewbValidUntil(dateText, km, odc) {
  const iso = isoOf(dateText), n = Math.round(+km || 0);
  if (!iso || !(n > 0)) return '';
  const days = Math.max(1, Math.ceil(n / (odc ? 20 : 200)));
  const dt = new Date(iso + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
/* YYYY-MM-DD from "2026-11-15", "15/11/2026" or "15/11/2026 10:30 AM" (as the portal prints it) */
export function isoOf(t) {
  const s = String(t || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}
const GSTIN_RE = /^\d{2}[A-Z0-9]{13}$/;

export function ewaybillJson(d, t = {}) {
  const kind = EWB_KIND[d.type];
  if (!kind) throw bad('E-way bills are made from sales invoices, delivery notes, purchase bills and returns.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  const { o, p, problems } = sellerAndBuyerProblems(d);
  const who = kind.supplyType === 'I' ? (d.type === 'BILL' ? 'supplier' : 'customer') : (d.type === 'PRET' ? 'supplier' : 'customer');
  if (!pin(p.pincode)) problems.push(`the ${who}'s PIN code`);
  // a different place the goods go to / leave from (bill to - ship to, bill from - dispatch from)
  const ship = { name: cut(t.ship_name, 100), addr: cut(t.ship_addr, 120), place: cut(t.ship_place, 50), pin: pin(t.ship_pin), state: t.ship_state || '', gstin: String(t.ship_gstin || '').toUpperCase().trim() };
  const disp = { name: cut(t.disp_name, 100), addr: cut(t.disp_addr, 120), place: cut(t.disp_place, 50), pin: pin(t.disp_pin), state: t.disp_state || '', gstin: String(t.disp_gstin || '').toUpperCase().trim() };
  const hasShip = !!(t.ship_pin || t.ship_addr || t.ship_name), hasDisp = !!(t.disp_pin || t.disp_addr || t.disp_name);
  if (hasShip && (!ship.pin || !ship.addr || !+stateCode(ship.state, ship.gstin))) problems.push('the ship-to address, PIN code and state');
  if (hasDisp && (!disp.pin || !disp.addr || !+stateCode(disp.state, disp.gstin))) problems.push('the dispatch-from address, PIN code and state');
  if (problems.length) throw bad('To make the e-way bill, first fill in: ' + problems.join(', ') + '.');
  const distance = Math.round(+t.distance || 0);
  if (!(distance > 0 && distance <= 4000)) throw bad('Enter the approximate distance in km (1 to 4000).');
  const vehicle = String(t.vehicle_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const transporterId = String(t.transporter_id || '').toUpperCase().trim();
  if (!vehicle && !transporterId) throw bad('Enter the vehicle number, or the transporter ID if the transporter will add the vehicle.');
  const ourSt = +stateCode(o.state, o.gstin), theirSt = +stateCode(p.state, p.gstin) || ourSt;
  const us = { gstin: o.gstin, name: cut(o.name, 100), addr: cut(o.address, 120), place: cut(o.city || o.state, 50), pin: pin(o.pincode), st: ourSt };
  const them = { gstin: GSTIN_RE.test(p.gstin || '') ? p.gstin : 'URP', name: cut(p.name, 100), addr: cut(p.address, 120), place: cut(p.city || p.state, 50), pin: pin(p.pincode), st: theirSt };
  const inward = kind.supplyType === 'I';
  const from = inward ? them : us, to = inward ? us : them;
  // where the goods really leave from / arrive at, when not the billing address
  const actFrom = hasDisp ? { addr: disp.addr, place: disp.place, pin: disp.pin, st: +stateCode(disp.state, disp.gstin) } : from;
  const actTo = hasShip ? { addr: ship.addr, place: ship.place, pin: ship.pin, st: +stateCode(ship.state, ship.gstin) } : to;
  const top = d.lines.slice().sort((a, b) => b.taxable - a.taxable)[0] || {};
  const inter = !!d.inter_state;
  return {
    version: '1.0.0621',
    billLists: [{
      userGstin: o.gstin, supplyType: kind.supplyType, subSupplyType: kind.sub, subSupplyDesc: kind.desc, docType: kind.docType,
      docNo: d.type === 'BILL' && d.party_ref ? cut(d.party_ref, 16) : d.number, docDate: dmy(d.date),
      fromGstin: from.gstin, fromTrdName: from.name, fromAddr1: actFrom.addr, fromAddr2: '', fromPlace: actFrom.place, fromPincode: actFrom.pin,
      actFromStateCode: actFrom.st, fromStateCode: from.st,
      toGstin: to.gstin, toTrdName: to.name, toAddr1: actTo.addr, toAddr2: '',
      toPlace: actTo.place, toPincode: actTo.pin, actToStateCode: actTo.st, toStateCode: to.st,
      // 1 regular, 2 bill to - ship to, 3 bill from - dispatch from, 4 both
      transactionType: hasShip && hasDisp ? 4 : hasShip ? 2 : hasDisp ? 3 : 1,
      dispatchFromGSTIN: hasDisp ? (GSTIN_RE.test(disp.gstin) ? disp.gstin : '') : '', dispatchFromTradeName: hasDisp ? disp.name : '',
      shipToGSTIN: hasShip ? (GSTIN_RE.test(ship.gstin) ? ship.gstin : '') : '', shipToTradeName: hasShip ? ship.name : '',
      otherValue: d.round_off || 0, totalValue: d.taxable, cgstValue: d.cgst, sgstValue: d.sgst, igstValue: d.igst, cessValue: 0, cessNonAdvolValue: 0, totInvValue: d.total,
      transporterId, transporterName: cut(t.transporter_name, 100), transDocNo: cut(t.trans_doc_no, 15), transMode: String(t.mode || '1'), transDistance: String(distance),
      transDocDate: t.trans_doc_date ? dmy(t.trans_doc_date) : '', vehicleNo: vehicle, vehicleType: vehicle ? (t.odc ? 'O' : 'R') : '',
      mainHsnCode: +String(top.hsn || '').replace(/\D/g, '') || 0,
      itemList: d.lines.map((l, i) => ({
        itemNo: i + 1, productName: cut(l.item || l.description, 100), productDesc: cut(l.description || l.item, 100), hsnCode: +String(l.hsn || '').replace(/\D/g, '') || 0,
        quantity: l.qty, qtyUnit: uqc(l.unit), taxableAmount: l.taxable,
        sgstRate: inter ? 0 : l.gst_rate / 2, cgstRate: inter ? 0 : l.gst_rate / 2, igstRate: inter ? l.gst_rate : 0, cessRate: 0, cessNonAdvol: 0,
      })),
    }],
  };
}
