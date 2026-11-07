// Bolkar bill: spoken orders as the phone's speech service writes them, read into bill lines.
// The sentences below are in the shape Chrome's speech recognition returns them: Hindi (hi-IN) comes back in Devanagari
// with digits ("2 किलो चीनी"), rupees as "₹50", English brand names written in Devanagari ("मैगी", "सर्फ एक्सेल"),
// a pause as a separate result; English (en-IN) comes back with digits and "kg". Each is checked against the item and the
// quantity a shopkeeper would expect. No browser, no network.
// Run: node test/voice.mjs
import { parseOrder, heardText } from '../public/voice.js';

const items = [
  { id: 1, name: 'Sugar', unit: 'Kg', sale_price: 45 }, { id: 2, name: 'Tata Salt 1kg', unit: 'Pcs', sale_price: 28 },
  { id: 3, name: 'Fortune Soyabean Oil 1L', unit: 'Pcs', sale_price: 150 }, { id: 4, name: 'Lifebuoy Soap', unit: 'Pcs', sale_price: 35 },
  { id: 5, name: 'Aashirvaad Atta 5kg', unit: 'Pcs', sale_price: 280 }, { id: 6, name: 'Jeera 100g', unit: 'Pcs', sale_price: 40 },
  { id: 7, name: 'Red Chilli Powder', unit: 'Kg', sale_price: 200, sale_price_incl: 210 }, { id: 8, name: 'Tata Tea Premium 250g', unit: 'Pcs', sale_price: 140 },
  { id: 9, name: 'Mustard Oil 1L', unit: 'Pcs', sale_price: 170 }, { id: 10, name: 'Toor Dal', unit: 'Kg', sale_price: 160 },
  { id: 11, name: 'Amul Butter 100g', unit: 'Pcs', sale_price: 56 }, { id: 12, name: 'Parle G', unit: 'Pcs', sale_price: 10 },
  { id: 13, name: 'Eggs', unit: 'Dozen', sale_price: 84 }, { id: 14, name: 'Basmati Rice', unit: 'Kg', sale_price: 120 },
  { id: 16, name: 'Maggi Noodles 70g', unit: 'Pcs', sale_price: 14 }, { id: 17, name: 'Surf Excel 1kg', unit: 'Pcs', sale_price: 135 },
  { id: 18, name: 'Dettol Soap 75g', unit: 'Pcs', sale_price: 42 }, { id: 19, name: 'Colgate Toothpaste 100g', unit: 'Pcs', sale_price: 55 },
  { id: 20, name: 'Amul Taaza Milk 500ml', unit: 'Pcs', sale_price: 27 }, { id: 21, name: 'Haldi Powder 100g', unit: 'Pcs', sale_price: 30 },
  { id: 22, name: 'Potato', unit: 'Kg', sale_price: 30 }, { id: 23, name: 'Onion', unit: 'Kg', sale_price: 40 }, { id: 24, name: 'Tomato', unit: 'Kg', sale_price: 35 },
  { id: 25, name: 'Moong Dal', unit: 'Kg', sale_price: 130 }, { id: 26, name: 'Good Day Biscuit', unit: 'Pcs', sale_price: 30 },
  { id: 27, name: 'Bisleri Water 1L', unit: 'Pcs', sale_price: 20 }, { id: 28, name: 'Coca Cola 750ml', unit: 'Pcs', sale_price: 40 },
  { id: 29, name: 'Rin Bar', unit: 'Pcs', sale_price: 18 }, { id: 30, name: 'Vim Bar', unit: 'Pcs', sale_price: 20 },
  { id: 31, name: 'Matchbox', unit: 'Pcs', sale_price: 2 }, { id: 32, name: 'Bread', unit: 'Pcs', sale_price: 45 },
  { id: 33, name: 'Saffola Gold Oil 1L', unit: 'Pcs', sale_price: 210 }, { id: 34, name: 'Kurkure', unit: 'Pcs', sale_price: 20 },
  { id: 35, name: 'Dhaniya Powder 100g', unit: 'Pcs', sale_price: 25 }, { id: 36, name: 'Chana Dal', unit: 'Kg', sale_price: 95 },
  { id: 37, name: 'Besan', unit: 'Kg', sale_price: 90 }, { id: 38, name: 'Poha', unit: 'Kg', sale_price: 60 },
  { id: 39, name: 'Red Label Tea 500g', unit: 'Pcs', sale_price: 260 }, { id: 40, name: 'Lux Soap', unit: 'Pcs', sale_price: 38 },
];
// [what the phone wrote, [[item id, qty], ...]]
const CASES = [
  // Hindi (hi-IN): Devanagari words, digits for numbers
  ['2 किलो चीनी 1 लीटर सरसों का तेल और 5 साबुन', [[1, 2], [9, 1], [4, 5]]],
  ['दो किलो चीनी', [[1, 2]]],
  ['आधा किलो जीरा', [[6, 5]]],
  ['250 ग्राम हल्दी', [[21, 2.5]]],
  ['₹50 की मिर्ची', [[7, 0.238]]],
  ['50 रुपए की लाल मिर्च', [[7, 0.238]]],
  ['टाटा नमक 2 पैकेट', [[2, 2]]],
  ['2 पैकेट मैगी', [[16, 2]]],
  ['5 मैगी', [[16, 5]]],
  ['पारले जी 10', [[12, 10]]],
  ['10 पारले जी बिस्किट', [[12, 10]]],
  ['एक सर्फ एक्सेल', [[17, 1]]],
  ['फॉर्च्यून तेल 1 लीटर', [[3, 1]]],
  ['2 डेटॉल साबुन', [[18, 2]]],
  ['आशीर्वाद आटा 5 किलो', [[5, 1]]],
  ['1 दर्जन अंडे', [[13, 1]]],
  ['अमूल मक्खन 100 ग्राम', [[11, 1]]],
  ['कोलगेट 2', [[19, 2]]],
  ['डेढ़ किलो चावल', [[14, 1.5]]],
  ['3 किलो आलू 2 किलो प्याज 1 किलो टमाटर', [[22, 3], [23, 2], [24, 1]]],
  ['2 लीटर दूध', [[20, 4]]],
  ['आधा किलो मूंग दाल', [[25, 0.5]]],
  ['1 किलो चना दाल और आधा किलो बेसन', [[36, 1], [37, 0.5]]],
  ['भैया 2 गुड डे बिस्किट दे देना', [[26, 2]]],
  ['एक बिसलेरी पानी की बोतल', [[27, 1]]],
  ['दो कोका कोला', [[28, 2]]],
  ['3 रिन साबुन और 2 विम बार', [[29, 3], [30, 2]]],
  ['10 माचिस', [[31, 10]]],
  ['एक ब्रेड', [[32, 1]]],
  ['सफोला तेल 1', [[33, 1]]],
  ['4 कुरकुरे', [[34, 4]]],
  ['100 ग्राम धनिया पाउडर', [[35, 1]]],
  ['1 किलो पोहा', [[38, 1]]],
  ['रेड लेबल चाय 1 पैकेट', [[39, 1]]],
  ['2 लक्स साबुन', [[40, 2]]],
  ['5 kg आटा', [[5, 1]]],
  ['2 kg चीनी', [[1, 2]]],
  ['पाव किलो जीरा', [[6, 2.5]]],
  ['सवा किलो दाल अरहर', [[10, 1.25]]],
  ['डेढ़ सौ ग्राम जीरा', [[6, 1.5]]],
  ['25 अंडे', [[13, 2.083]]],
  ['इक्कीस अंडे', [[13, 1.75]]],
  ['पैंतीस रुपए का धनिया पाउडर', [[35, 1.4]]],
  // a pause between items comes back as two results joined with ", " (as the Bolkar sheet joins them)
  ['2 किलो चीनी, 1 पैकेट टाटा चाय', [[1, 2], [8, 1]]],
  ['मैगी 2, पारले जी 5, लक्स 1', [[16, 2], [12, 5], [40, 1]]],
  // English (en-IN): digits, "kg", brand names in Latin letters
  ['2 kg sugar 1 litre mustard oil and 5 soap', [[1, 2], [9, 1], [4, 5]]],
  ['half kg cumin', [[6, 5]]],
  ['Parle G 10 packets', [[12, 10]]],
  ['Rs 50 chilli', [[7, 0.238]]],
  ['one dozen eggs', [[13, 1]]],
  ['2 Maggi', [[16, 2]]],
  ['Surf Excel one', [[17, 1]]],
  ['3 kg potato 2 kg onion', [[22, 3], [23, 2]]],
  // Hinglish typed in the box
  ['do kilo cheeni, ek litre fortune tel', [[1, 2], [3, 1]]],
  ['paanch maggi aur do parle g', [[16, 5], [12, 2]]],
  ['dhai sau gram jeera', [[6, 2.5]]],
  // second set, written after the fixes and not tuned on
  ['एक किलो चीनी दो किलो आटा', [[1, 1], [5, 0.4]]],
  ['ढाई किलो चावल', [[14, 2.5]]],
  ['चार अंडे', [[13, 0.333]]],
  ['आधा दर्जन अंडे', [[13, 0.5]]],
  ['दो सौ ग्राम मूंग दाल', [[25, 0.2]]],
  ['एक टाटा चाय 250 ग्राम', [[8, 1]]],
  ['मुझे 2 मैगी चाहिए', [[16, 2]]],
  ['दो पैकेट पारले जी और एक गुड डे', [[12, 2], [26, 1]]],
  ['5 लीटर सरसों तेल', [[9, 5]]],
  ['1 kg tomato aur half kg onion', [[24, 1], [23, 0.5]]],
  ['दो कोलगेट टूथपेस्ट', [[19, 2]]],
  ['तीन बिसलेरी', [[27, 3]]],
  ['एक लाइफबॉय', [[4, 1]]],
  ['दो डेटॉल', [[18, 2]]],
  ['सौ ग्राम अमूल बटर', [[11, 1]]],
  ['एक कोक', [[28, 1]]],
  ['20 रुपए का पोहा', [[38, 0.333]]],
  ['₹100 का बेसन', [[37, 1.111]]],
  ['दस रुपए की माचिस', [[31, 5]]],
  ['चना दाल डेढ़ किलो', [[36, 1.5]]],
  ['मूंग की दाल 1 किलो', [[25, 1]]],
  ['2 सफोला गोल्ड', [[33, 2]]],
  ['एक लक्स और एक लाइफबॉय साबुन', [[40, 1], [4, 1]]],
  ['बासमती चावल 5 किलो', [[14, 5]]],
  ['2 किलो प्याज़', [[23, 2]]],
  ['3 पैकेट कुरकुरे', [[34, 3]]],
  ['red label chai ek', [[39, 1]]],
  ['ek dozen ande aur do bread', [[13, 1], [32, 2]]],
  ['भैया जी एक किलो चीनी दे दो', [[1, 1]]],
  ['हमें 3 रिन चाहिए', [[29, 3]]],
];

let pass = 0;
const fails = [];
for (const [text, want] of CASES) {
  const got = parseOrder(text, items).map((l) => [l.item_id, l.qty]);
  const ok = got.length === want.length && got.every((g, k) => g[0] === want[k][0] && Math.abs(g[1] - want[k][1]) < 0.002);
  if (ok) pass++; else fails.push(`  "${text}"\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
}
/* what the speech service gave, as Chrome gives it on a computer and on Android */
const F = (transcript) => ({ transcript, isFinal: true }), I = (transcript) => ({ transcript, isFinal: false });
const HEARD = [
  ['computer: one result per pause', [F('2 किलो चीनी'), F('1 लीटर तेल')], { done: '2 किलो चीनी, 1 लीटर तेल', now: '' }],
  ['computer: still speaking', [F('2 किलो चीनी'), I('1 लीटर')], { done: '2 किलो चीनी', now: '1 लीटर' }],
  ['Android: each result repeats the earlier ones', [F('2 किलो चीनी'), F('2 किलो चीनी 1 लीटर तेल'), F('2 किलो चीनी 1 लीटर तेल 5 साबुन')], { done: '2 किलो चीनी, 1 लीटर तेल, 5 साबुन', now: '' }],
  ['Android: the same result twice', [F('2 मैगी'), F('2 मैगी')], { done: '2 मैगी', now: '' }],
  ['Android: the words being heard repeat the final ones', [F('2 मैगी'), I('2 मैगी 1 ब्रेड')], { done: '2 मैगी', now: '1 ब्रेड' }],
  ['Android: a shorter repeat after the full one', [F('2 मैगी 1 ब्रेड'), F('1 ब्रेड')], { done: '2 मैगी 1 ब्रेड', now: '' }],
  ['Android: the end of the earlier words repeated, then new ones', [F('2 मैगी 1 ब्रेड'), F('1 ब्रेड 3 साबुन')], { done: '2 मैगी 1 ब्रेड, 3 साबुन', now: '' }],
  ['Android: a repeat of an earlier piece, not the last', [F('2 मैगी'), F('1 ब्रेड'), F('2 मैगी')], { done: '2 मैगी, 1 ब्रेड', now: '' }],
  ['Android: all again after separate pieces, with one new', [F('2 मैगी'), F('1 ब्रेड'), F('2 मैगी 1 ब्रेड 3 साबुन')], { done: '2 मैगी, 1 ब्रेड, 3 साबुन', now: '' }],
  ['Android: a number as a word, then as a digit', [F('do kilo chini'), F('2 kilo chini ek litre tel')], { done: 'do kilo chini, ek litre tel', now: '' }],
  ['Android: Hindi number word, then digit', [F('दो किलो चीनी'), F('2 किलो चीनी')], { done: 'दो किलो चीनी', now: '' }],
  ['Android: words being heard repeat an earlier piece', [F('2 मैगी'), F('1 ब्रेड'), I('2 मैगी')], { done: '2 मैगी, 1 ब्रेड', now: '' }],
];
for (const [name, res, want] of HEARD) {
  const got = heardText(res);
  if (got.done === want.done && got.now === want.now) pass++; else fails.push(`  heard (${name})\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
}
// the Android case read into a bill: three lines, no item twice
const android = parseOrder(heardText([F('2 किलो चीनी'), F('2 किलो चीनी 1 लीटर सरसों तेल'), F('2 किलो चीनी 1 लीटर सरसों तेल 5 साबुन')]).done, items).map((l) => [l.item_id, l.qty]);
if (JSON.stringify(android) === JSON.stringify([[1, 2], [9, 1], [4, 5]])) pass++; else fails.push(`  Android order read twice: ${JSON.stringify(android)}`);
// the same order heard many ways on Android: never an item twice
for (const res of [[F('2 मैगी 1 ब्रेड'), F('1 ब्रेड 3 साबुन'), F('2 मैगी 1 ब्रेड 3 साबुन')], [F('दो किलो चीनी'), F('2 किलो चीनी'), F('2 किलो चीनी 1 लीटर सरसों तेल')]]) {
  const ids = parseOrder(heardText(res).done, items).map((l) => l.item_id);
  if (new Set(ids).size === ids.length) pass++; else fails.push(`  item twice: ${JSON.stringify(res.map((r) => r.transcript))} -> ${ids}`);
}
const total = CASES.length + HEARD.length + 3;
console.log(fails.length ? 'FAILED:\n' + fails.join('\n') : '');
console.log(`${pass}/${total} checks pass: ${CASES.length} spoken orders, ${HEARD.length} ways the phone gives what it heard, and the Android order.`);
process.exitCode = fails.length ? 1 : 0;
