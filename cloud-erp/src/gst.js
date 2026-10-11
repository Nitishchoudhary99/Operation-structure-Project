/* GST helpers: state codes, units (UQC), and the government JSON formats for
   e-invoice (NIC IRP schema 1.1) and e-way bill (bulk generation upload). These files are
   uploaded on the portals (or through a GSP); the IRN / e-way bill numbers you get back are saved on the document. */
import { bad } from './lib.js';

export const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'],
];
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const ALIAS = { up: '09', mp: '23', uk: '05', jk: '01', tn: '33', ap: '37', wb: '19', orissa: '21', pondicherry: '34', newdelhi: '07', uttaranchal: '05' };

/* Two-digit GST state code from a GSTIN (first two digits) or a state name. '' if unknown. */
export function stateCode(state, gstin) {
  if (gstin && /^\d{2}/.test(gstin)) return gstin.slice(0, 2);
  const n = norm(state);
  if (!n) return '';
  if (ALIAS[n]) return ALIAS[n];
  const hit = STATES.find(([, name]) => norm(name) === n) || STATES.find(([, name]) => norm(name).startsWith(n) && n.length >= 4);
  return hit ? hit[0] : '';
}

/* Unit Quantity Codes accepted by the portals; anything unknown is OTH. */
const UQC = { pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS', nos: 'NOS', no: 'NOS', number: 'NOS', kg: 'KGS', kgs: 'KGS', kilogram: 'KGS',
  g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', ltr: 'LTR', l: 'LTR', litre: 'LTR', liter: 'LTR', ml: 'MLT', mtr: 'MTR', m: 'MTR', metre: 'MTR',
  bag: 'BAG', bags: 'BAG', box: 'BOX', boxes: 'BOX', btl: 'BTL', bottle: 'BTL', dozen: 'DOZ', doz: 'DOZ', pack: 'PAC', pac: 'PAC', packet: 'PAC',
  set: 'SET', sets: 'SET', pair: 'PRS', prs: 'PRS', roll: 'ROL', tin: 'CAN', can: 'CAN', ton: 'TON', tonne: 'TON', qtl: 'QTL', quintal: 'QTL',
  sqft: 'SQF', sqm: 'SQM', ctn: 'CTN', carton: 'CTN', bundle: 'BDL', bdl: 'BDL', unit: 'UNT', units: 'UNT', tab: 'TBS', strip: 'NOS' };
export const uqc = (unit) => UQC[norm(unit)] || 'OTH';

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
  if (!['INV', 'SRET'].includes(d.type)) throw bad('E-invoices are made for sales invoices and credit notes.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  const { o, p, problems } = sellerAndBuyerProblems(d);
  if (!/^\d{2}[A-Z0-9]{13}$/.test(p.gstin || '')) problems.push(`the customer's GSTIN (e-invoice is only for B2B sales)`);
  if (!pin(p.pincode)) problems.push(`the customer's PIN code`);
  if (problems.length) throw bad('To make the e-invoice, first fill in: ' + problems.join(', ') + '.');
  const sellerSt = stateCode(o.state, o.gstin), buyerSt = stateCode(p.state, p.gstin);
  const items = d.lines.map((l, i) => {
    const gross = r2(l.qty * l.rate);
    return {
      SlNo: String(i + 1), PrdDesc: cut(l.item || l.description, 300) || 'Item', IsServc: l.is_service ? 'Y' : 'N', HsnCd: String(l.hsn || '').replace(/\D/g, '') || '9999',
      Qty: l.qty, Unit: uqc(l.unit), UnitPrice: l.rate, TotAmt: gross, Discount: r2(gross - l.taxable), AssAmt: l.taxable, GstRt: l.gst_rate,
      IgstAmt: l.igst, CgstAmt: l.cgst, SgstAmt: l.sgst, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0,
      OthChrg: 0, TotItemVal: l.total,
    };
  });
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: d.type === 'SRET' ? 'CRN' : 'INV', No: d.number, Dt: dmy(d.date) },
    SellerDtls: { Gstin: o.gstin, LglNm: cut(o.name, 100), Addr1: cut(o.address, 100), Loc: cut(o.city || o.state, 50) || 'NA', Pin: pin(o.pincode), Stcd: sellerSt,
      ...(o.phone ? { Ph: String(o.phone).replace(/\D/g, '').slice(-12) } : {}), ...(o.email ? { Em: o.email } : {}) },
    BuyerDtls: { Gstin: p.gstin, LglNm: cut(p.name, 100), Pos: buyerSt, Addr1: cut(p.address, 100) || cut(p.city, 100) || 'NA', Loc: cut(p.city || p.state, 50) || 'NA',
      Pin: pin(p.pincode), Stcd: buyerSt, ...(p.phone ? { Ph: String(p.phone).replace(/\D/g, '').slice(-12) } : {}), ...(p.email ? { Em: p.email } : {}) },
    ...(d.parent && d.type === 'SRET' ? { RefDtls: { PrecDocDtls: [{ InvNo: d.parent.number, InvDt: dmy(d.parent.date) }] } } : {}),
    ItemList: items,
    ValDtls: { AssVal: d.taxable, CgstVal: d.cgst, SgstVal: d.sgst, IgstVal: d.igst, CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: d.round_off, TotInvVal: d.total },
  };
}

/* e-way bill bulk-upload JSON for an outward invoice or delivery challan. t = transport details from the user. */
export function ewaybillJson(d, t = {}) {
  if (!['INV', 'DN'].includes(d.type)) throw bad('E-way bills are made from sales invoices or delivery notes.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  const { o, p, problems } = sellerAndBuyerProblems(d);
  if (!pin(p.pincode)) problems.push(`the customer's PIN code`);
  if (problems.length) throw bad('To make the e-way bill, first fill in: ' + problems.join(', ') + '.');
  const distance = Math.round(+t.distance || 0);
  if (!(distance > 0 && distance <= 4000)) throw bad('Enter the approximate distance in km (1 to 4000).');
  const vehicle = String(t.vehicle_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const transporterId = String(t.transporter_id || '').toUpperCase().trim();
  if (!vehicle && !transporterId) throw bad('Enter the vehicle number, or the transporter ID if the transporter will add the vehicle.');
  const fromSt = +stateCode(o.state, o.gstin), toSt = +stateCode(p.state, p.gstin) || fromSt;
  const top = d.lines.slice().sort((a, b) => b.taxable - a.taxable)[0] || {};
  const inter = !!d.inter_state;
  return {
    version: '1.0.0621',
    billLists: [{
      userGstin: o.gstin, supplyType: 'O', subSupplyType: 1, subSupplyDesc: '', docType: d.type === 'DN' ? 'CHL' : 'INV', docNo: d.number, docDate: dmy(d.date),
      fromGstin: o.gstin, fromTrdName: cut(o.name, 100), fromAddr1: cut(o.address, 120), fromAddr2: '', fromPlace: cut(o.city || o.state, 50), fromPincode: pin(o.pincode),
      actFromStateCode: fromSt, fromStateCode: fromSt,
      toGstin: /^\d{2}[A-Z0-9]{13}$/.test(p.gstin || '') ? p.gstin : 'URP', toTrdName: cut(p.name, 100), toAddr1: cut(p.address, 120), toAddr2: '',
      toPlace: cut(p.city || p.state, 50), toPincode: pin(p.pincode), actToStateCode: toSt, toStateCode: toSt,
      transactionType: 1, dispatchFromGSTIN: '', dispatchFromTradeName: '', shipToGSTIN: '', shipToTradeName: '',
      otherValue: d.round_off || 0, totalValue: d.taxable, cgstValue: d.cgst, sgstValue: d.sgst, igstValue: d.igst, cessValue: 0, cessNonAdvolValue: 0, totInvValue: d.total,
      transporterId, transporterName: cut(t.transporter_name, 100), transDocNo: cut(t.trans_doc_no, 15), transMode: String(t.mode || '1'), transDistance: String(distance),
      transDocDate: t.trans_doc_date ? dmy(t.trans_doc_date) : '', vehicleNo: vehicle, vehicleType: vehicle ? 'R' : '',
      mainHsnCode: +String(top.hsn || '').replace(/\D/g, '') || 0,
      itemList: d.lines.map((l, i) => ({
        itemNo: i + 1, productName: cut(l.item || l.description, 100), productDesc: cut(l.description || l.item, 100), hsnCode: +String(l.hsn || '').replace(/\D/g, '') || 0,
        quantity: l.qty, qtyUnit: uqc(l.unit), taxableAmount: l.taxable,
        sgstRate: inter ? 0 : l.gst_rate / 2, cgstRate: inter ? 0 : l.gst_rate / 2, igstRate: inter ? l.gst_rate : 0, cessRate: 0, cessNonAdvol: 0,
      })),
    }],
  };
}
