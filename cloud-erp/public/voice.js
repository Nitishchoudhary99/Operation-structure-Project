/* Bolkar bill: what the shopkeeper says, turned into bill lines.
     "do kilo cheeni, ek litre tel aur paanch sabun"   "दो किलो चीनी एक लीटर तेल और पांच साबुन"
     "dhai sau gram jeera"   "50 rupaye ki mirchi"   "Tata namak 2"   "साढ़े तीन किलो आटा"
   The phone's own speech service turns the voice into text; this file only reads that text, so it runs the same
   on the phone and in the tests (no screen, no network). Hindi words and Hinglish spellings are brought to one
   sound key ("चीनी" = "cheeni" = "chini"), common shop words in Hindi find items named in English ("namak" finds
   "Tata Salt") and the other way round, and a near miss still finds the item. */

/* ---------- sound key ---------- */
const VOWEL = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const SIGN = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const CONS = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh',
  'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'f', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l' };
const NUKTA = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f' };
const DIGITS = '०१२३४५६७८९';

/* Devanagari to plain Latin letters (Latin text passes through) */
export function latin(w) {
  const s = String(w || '').normalize('NFD').replace(/[क़-य़]/g, (c) => c.normalize('NFD'));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (DIGITS.includes(ch)) { out += DIGITS.indexOf(ch); continue; }
    if (VOWEL[ch]) { out += VOWEL[ch]; continue; }
    if (CONS[ch]) {
      let c = CONS[ch];
      if (s[i + 1] === '़') { c = NUKTA[ch] || c; i++; }
      const nx = s[i + 1];
      if (SIGN[nx]) { out += c + SIGN[nx]; i++; } else if (nx === '्') { out += c; i++; } else out += c + 'a';   // inherent "a"
      continue;
    }
    if (ch === 'ं' || ch === 'ँ') { out += 'n'; continue; }
    if (ch === 'ः') { out += 'h'; continue; }
    if (SIGN[ch]) { out += SIGN[ch]; continue; }
    out += ch;
  }
  return out;
}
/* one key for the ways a word is written: "चीनी" "cheeni" "chini" -> "cini"; "नमक" "namak" -> "namak"; "आटा" "atta" "aata" -> "ata" */
export function soundKey(w) {
  let s = latin(String(w || '').toLowerCase()).toLowerCase().replace(/[^a-z0-9]/g, '');
  // an English c sounds k ("Coca Cola" = "कोका कोला") or s before e, i, y ("Excel"); "ch" stays ch
  s = s.replace(/ck/g, 'k').replace(/c(?!h)(?=[eiy])/g, 's').replace(/c(?!h)/g, 'k');
  // English "ay" is the Hindi "े": "Good Day" = "गुड डे", "Spray" = "स्प्रे"
  s = s.replace(/ay(?![aeiou])/g, 'e');
  s = s.replace(/ph/g, 'f').replace(/chh/g, 'c').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/([kgtdbjrc])h/g, '$1')
    .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks');
  s = s.replace(/ee|ii|ey/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a').replace(/([b-df-hj-np-tv-z])\1+/g, '$1');
  if (s.length > 3) s = s.replace(/([b-df-hj-np-tv-z])a$/, '$1');            // the "a" Hindi does not say at the end of a word
  return s.replace(/y$/, 'i').replace(/ii/g, 'i');
}

/* edit distance where a missing "a" (Hindi spelling) or another vowel costs little */
const VOW = new Set(['a', 'e', 'i', 'o', 'u']);
function distance(a, b) {
  const short = Math.max(a.length, b.length) <= 3;
  const del = (c) => (short ? 1 : c === 'a' ? 0.3 : VOW.has(c) ? 0.6 : 1);
  const sub = (x, y) => (x === y ? 0 : !short && VOW.has(x) && VOW.has(y) ? 0.4 : 1);
  let prev = [0];
  for (let j = 1; j <= b.length; j++) prev[j] = prev[j - 1] + del(b[j - 1]);
  for (let i = 1; i <= a.length; i++) {
    const cur = [prev[0] + del(a[i - 1])];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + del(a[i - 1]), cur[j - 1] + del(b[j - 1]), prev[j - 1] + sub(a[i - 1], b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}
export const likeness = (a, b) => (!a || !b ? 0 : a === b ? 1 : Math.max(0, 1 - distance(a, b) / Math.max(a.length, b.length)));

/* ---------- shop words: each group is one thing, in Hindi, Hinglish and English ---------- */
const GROUPS = [
  'cheeni chini shakkar sugar शक्कर चीनी', 'namak salt loon नमक', 'tel oil तेल', 'sarson sarso mustard सरसों', 'aata atta flour आटा', 'gehun gehu wheat गेहूं गेहूँ',
  'chawal chaawal rice चावल', 'dal daal lentil दाल', 'arhar toor tur tuar अरहर', 'moong mung मूंग', 'masoor masur मसूर', 'chana chane chickpea चना चने', 'urad उड़द',
  'rajma राजमा', 'besan बेसन', 'maida मैदा', 'suji sooji rava rawa semolina सूजी', 'poha पोहा', 'ghee ghi घी', 'doodh dudh milk दूध', 'dahi curd yogurt दही',
  'makhan makkhan butter मक्खन', 'paneer panir पनीर', 'chai chay tea chaipatti patti चाय चायपत्ती', 'coffee kafi कॉफी कॉफ़ी', 'biscuit biskut बिस्कुट', 'bread ब्रेड',
  'anda ande egg eggs अंडा अंडे', 'haldi turmeric हल्दी', 'mirch mirchi chilli chili मिर्च मिर्ची', 'dhaniya dhania coriander धनिया', 'jeera jira cumin जीरा',
  'masala मसाला', 'laung clove लौंग', 'elaichi ilaichi cardamom इलायची', 'gud gur jaggery गुड़', 'sabun saabun soap साबुन', 'surf sarf detergent सर्फ',
  'shampoo शैम्पू शेम्पू', 'toothpaste manjan टूथपेस्ट मंजन', 'machis matchbox माचिस', 'mombatti candle मोमबत्ती', 'agarbatti incense अगरबत्ती',
  'pyaz pyaj onion प्याज', 'aloo alu potato आलू', 'tamatar tomato टमाटर', 'lahsun lehsun garlic लहसुन', 'adrak ginger अदरक', 'moongfali mungfali peanut groundnut मूंगफली',
  'badam almond बादाम', 'kaju cashew काजू', 'kishmish raisin किशमिश', 'til sesame तिल', 'pani paani water पानी', 'namkeen bhujia नमकीन भुजिया', 'mithai sweet sweets मिठाई',
  'bulb बल्ब', 'taar wire तार', 'keel kil nail nails कील', 'pench screw पेंच', 'dawai dawa medicine दवा दवाई', 'goli tablet tablets गोली', 'copy kapi notebook कॉपी',
  'kalam pen पेन', 'pencil पेंसिल', 'kapda cloth कपड़ा', 'sirka vinegar सिरका', 'saunf fennel सौंफ', 'rai राई', 'methi fenugreek मेथी', 'ajwain carom अजवाइन',
  'dalchini cinnamon दालचीनी', 'kali kaali black काली', 'lal laal red लाल', 'hara green हरा', 'chota small छोटा', 'bada big large बड़ा',
].map((g) => [...new Set(g.split(' ').map(soundKey))]);
const GROUP_OF = new Map();
GROUPS.forEach((g, i) => g.forEach((k) => { if (!GROUP_OF.has(k)) GROUP_OF.set(k, i); }));

function wordLikeness(q, t) {
  const gq = GROUP_OF.get(q), gt = GROUP_OF.get(t);
  if (gq !== undefined && gt !== undefined) return gq === gt ? 1 : 0;
  const qs = gq !== undefined ? GROUPS[gq] : [q], ts = gt !== undefined ? GROUPS[gt] : [t];
  let best = 0;
  for (const a of qs) for (const b of ts) best = Math.max(best, likeness(a, b));
  return best;
}

/* ---------- numbers, units and filler words ---------- */
const N = {};
const nums = (n, words) => words.split(' ').forEach((w) => { N[w] = n; });
nums(1, 'ek एक one'); nums(2, 'do दो two'); nums(3, 'teen तीन three'); nums(4, 'char chaar चार four'); nums(5, 'paanch panch paach पांच पाँच five');
nums(6, 'chhah chhe che chah chheh छह छः छे six'); nums(7, 'saat sat सात seven'); nums(8, 'aath आठ eight'); nums(9, 'nau नौ nine'); nums(10, 'das दस ten');
nums(11, 'gyarah gyaarah ग्यारह eleven'); nums(12, 'barah baarah बारह twelve'); nums(13, 'terah तेरह'); nums(14, 'chaudah चौदह'); nums(15, 'pandrah pandrah पंद्रह पन्द्रह fifteen');
nums(16, 'solah सोलह'); nums(17, 'satrah सत्रह'); nums(18, 'atharah athaarah अठारह'); nums(19, 'unnis उन्नीस'); nums(20, 'bees bis बीस twenty'); nums(25, 'pachchis pachis पच्चीस');
nums(30, 'tees tis तीस thirty'); nums(40, 'chalis chaalis चालीस forty'); nums(50, 'pachas pachaas पचास fifty'); nums(60, 'saath साठ sixty'); nums(70, 'sattar सत्तर');
nums(80, 'assi अस्सी'); nums(90, 'nabbe नब्बे'); nums(100, 'sau सौ hundred'); nums(1000, 'hazar hazaar हज़ार हजार thousand');
// 21 to 99: every one has its own word in Hindi ("पैंतीस" is 35); the phone usually writes digits, a typed or Hinglish order may not
['इक्कीस ikkis', 'बाईस bais', 'तेईस teis', 'चौबीस chaubis', 'पच्चीस', 'छब्बीस chhabbis', 'सत्ताईस sattais', 'अट्ठाईस atthais', 'उनतीस untis', 'तीस',
  'इकतीस iktis', 'बत्तीस battis', 'तैंतीस taintis', 'चौंतीस chauntis', 'पैंतीस paintis', 'छत्तीस chhattis', 'सैंतीस saintis', 'अड़तीस adtis', 'उनतालीस untalis', 'चालीस',
  'इकतालीस iktalis', 'बयालीस bayalis', 'तैंतालीस taintalis', 'चवालीस chavalis', 'पैंतालीस paintalis', 'छियालीस chhiyalis', 'सैंतालीस saintalis', 'अड़तालीस adtalis', 'उनचास unchas', 'पचास',
  'इक्यावन ikyavan', 'बावन bavan', 'तिरेपन tirepan', 'चौवन chauvan', 'पचपन pachpan', 'छप्पन chhappan', 'सत्तावन sattavan', 'अट्ठावन atthavan', 'उनसठ unsath', 'साठ',
  'इकसठ iksath', 'बासठ basath', 'तिरसठ tirsath', 'चौंसठ chaunsath', 'पैंसठ painsath', 'छियासठ chhiyasath', 'सड़सठ sadsath', 'अड़सठ adsath', 'उनहत्तर unhattar', 'सत्तर',
  'इकहत्तर ikhattar', 'बहत्तर bahattar', 'तिहत्तर tihattar', 'चौहत्तर chauhattar', 'पचहत्तर pachhattar', 'छिहत्तर chhihattar', 'सतहत्तर sathattar', 'अठहत्तर athhattar', 'उन्यासी unyasi', 'अस्सी',
  'इक्यासी ikyasi', 'बयासी bayasi', 'तिरासी tirasi', 'चौरासी chaurasi', 'पचासी pachasi', 'छियासी chhiyasi', 'सत्तासी sattasi', 'अट्ठासी atthasi', 'नवासी navasi', 'नब्बे',
  'इक्यानवे ikyanve', 'बानवे banve', 'तिरानवे tiranve', 'चौरानवे chauranve', 'पंचानवे panchanve', 'छियानवे chhiyanve', 'सत्तानवे sattanve', 'अट्ठानवे atthanve', 'निन्यानवे ninyanve']
  .forEach((w, k) => { if (N[w.split(' ')[0]] === undefined) nums(21 + k, w); });
// the same number written with another nasal or nukta ("पैतीस", "अडतीस"): found by its sound, for Devanagari words only
const NUM_SOUND = new Map();
Object.entries(N).forEach(([w, n]) => { if (/[\u0900-\u097F]/.test(w) && n > 20 && n < 100) { const k = soundKey(w).replace(/n/g, ''); if (!NUM_SOUND.has(k)) NUM_SOUND.set(k, n); } });
const numOf = (w) => (N[w] !== undefined ? N[w] : /[\u0900-\u097F]/.test(w) ? NUM_SOUND.get(soundKey(w).replace(/n/g, '')) : undefined);
const FRACTION = {};
[[0.5, 'aadha adha aadhi adhi आधा आधी half'], [0.25, 'paav pav pao पाव quarter'], [1.5, 'dedh derh डेढ़ डेढ'], [2.5, 'dhai dhaai ढाई']]
  .forEach(([n, w]) => w.split(' ').forEach((x) => { FRACTION[x] = n; }));
const PLUS = {};
[[0.5, 'saadhe sadhe साढ़े साढे'], [0.25, 'sawa sava सवा'], [-0.25, 'paune pone पौने']].forEach(([n, w]) => w.split(' ').forEach((x) => { PLUS[x] = n; }));
const UNIT = {};
[['kg', 'kilo kilos kg kgs kilogram kilograms killo किलो केजी'], ['g', 'gram grams gm gms g ग्राम'], ['l', 'litre litres liter liters ltr l लीटर लिटर'], ['ml', 'ml मिली mili'],
  ['dozen', 'dozen dozens darjan दर्जन'], ['pack', 'packet packets pack packs pkt paket पैकेट पैकिट पॉकेट'], ['pc', 'piece pieces pcs pc peace nag पीस नग'], ['box', 'box boxes dibba dabba डिब्बा डब्बा'],
  ['bag', 'bori bag bags katta बोरी कट्टा'], ['bottle', 'bottle bottles botal बोतल']].forEach(([u, w]) => w.split(' ').forEach((x) => { UNIT[x] = u; }));
const RUPEES = new Set('rupaye rupay rupee rupees rupaiya rs ₹ रुपये रुपए रूपये रुपया'.split(' '));
const SEP = new Set('aur और and or tatha तथा phir फिर plus then comma कॉमा'.split(' '));
const LETTER_AFTER_NAME = new Set(['ji', 'जी', 'g']);
const FILLER = new Set(('de dedo dena dijiye dijie bhai bhaiya bhaiyya ji please wala wali vala vali ka ki ke ko mein me se hai hain chahiye '
  + 'mujhe mujhko hame hamein humein hamko humko mere mera meri liye lijiye zara jara bas bhi '
  + 'दे देना दीजिए दीजिये भाई भैया जी वाला वाली का की के को में से है हैं चाहिए लेना मुझे मुझको हमें हमको मेरे मेरा मेरी लिए लीजिए ज़रा जरा बस भी').split(' '));

/* the words of what was said; "de do" / "दे दो" at the end of an order is "give", not "two" */
function words(text) {
  return String(text || '').normalize('NFC').toLowerCase()
    .replace(/[०-९]/g, (d) => DIGITS.indexOf(d))
    .replace(/(^|\s)(de|दे)\s+(do|दो)(?=\s|$)/g, ' ')
    .replace(/(\d)\s*(kg|g|gm|ml|l|ltr)\b/g, '$1 $2')
    .replace(/(\d)([^\d\s.,])/g, '$1 $2')
    .replace(/(?:₹|\brs\.?)\s*(\d[\d,]*(?:\.\d+)?)/g, ' $1 rupaye ')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[,;।|!?]+/g, ' , ')
    .replace(/(^|\s)\.(\s|$)/g, ' , ')
    .split(/\s+/).filter(Boolean);
}
const kindOf = (w) => (w === ',' || SEP.has(w) ? 'sep' : /^\d+(\.\d+)?$/.test(w) || numOf(w) !== undefined || FRACTION[w] !== undefined || PLUS[w] !== undefined ? 'num'
  : UNIT[w] ? 'unit' : RUPEES.has(w) ? 'rs' : FILLER.has(w) ? 'fill' : 'name');

function amountOf(tokens) {
  let cur = null, plus = 0;
  for (const w of tokens) {
    if (PLUS[w] !== undefined) { plus = PLUS[w]; continue; }
    const n = /^\d/.test(w) ? +w : FRACTION[w] !== undefined ? FRACTION[w] : numOf(w);
    if (n === undefined) continue;
    if ((n === 100 || n === 1000) && cur !== null) cur *= n;
    else { cur = n + plus; plus = 0; }
  }
  if (cur === null && plus) cur = 1 + plus;
  return cur;
}

/* what was said, cut into one piece per item: "do kilo cheeni ek litre tel" and "cheeni do kilo tel ek litre" both give two */
export function pieces(text) {
  const out = [];
  let cur = null, last = '';
  let sep = false;
  const start = () => { cur = { nums: [], unit: '', rupees: false, name: [], numAfterName: false, raw: [], afterSep: sep }; sep = false; };
  const flush = () => { if (cur && (cur.name.length || cur.nums.length)) out.push(cur); start(); };
  start();
  for (const w of words(text)) {
    let k = kindOf(w);
    // "Parle G", "पारले जी", "7 Up L": a single letter (or जी) right after a name belongs to the name; "250 g" is grams
    if (last === 'name' && (LETTER_AFTER_NAME.has(w) || (k === 'unit' && /^[a-z]$/.test(w)))) k = 'name';
    if (k === 'sep') { flush(); cur.afterSep = true; last = ''; continue; }
    if (k === 'fill') continue;
    if (k === 'num') {
      if (last !== 'num' && cur.name.length && cur.nums.length) flush();
      if (last !== 'num' && cur.nums.length && !cur.name.length) flush();     // "2 kilo 3 kilo": a second amount before any item
      cur.nums.push(w); if (cur.name.length) cur.numAfterName = true;
    } else if (k === 'unit') {
      if (cur.unit && cur.name.length) flush();
      cur.unit = UNIT[w];
    } else if (k === 'rs') cur.rupees = true;
    else {
      if (cur.numAfterName || (cur.unit && cur.name.length && last !== 'name')) flush();
      cur.name.push(w);
    }
    cur.raw.push(w); last = k;
  }
  flush();
  // "ek Tata chai 250 gram": a count before the name, then an amount with a unit and no name of its own, is the pack size
  for (let i = out.length - 1; i > 0; i--) {
    const p = out[i], q = out[i - 1];
    if (!p.name.length && p.unit && !p.rupees && !p.afterSep && q.name.length && q.nums.length && !q.numAfterName && !q.unit) {
      q.size = { amount: amountOf(p.nums), unit: p.unit }; q.raw.push(...p.raw); out.splice(i, 1);
    }
  }
  return out.map((p) => ({ heard: p.raw.join(' '), name: p.name.join(' '), amount: amountOf(p.nums), unit: p.unit, rupees: p.rupees, size: p.size || null }));
}

/* ---------- items ---------- */
const UNIT_OF_ITEM = (u) => { const x = String(u || '').toLowerCase().replace(/[^a-z]/g, ''); return /^(kg|kgs|kilo|kilogram)$/.test(x) ? 'kg' : /^(g|gm|gms|gram|grams)$/.test(x) ? 'g'
  : /^(l|ltr|litre|liter|lt)$/.test(x) ? 'l' : /^ml$/.test(x) ? 'ml' : /^(dozen|dz|doz)$/.test(x) ? 'dozen' : 'pc'; };
const BASE = { kg: ['w', 1000], g: ['w', 1], l: ['v', 1000], ml: ['v', 1], dozen: ['n', 12], pc: ['n', 1], pack: ['n', 1], box: ['n', 1], bag: ['n', 1], bottle: ['n', 1] };
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ltr|litre|liter|ml)\b/i;
// a letter in an item name is spoken by its name: "Parle G" is "parle ji", "Kurkure Masala Munch X" is "eks"
const LETTER = Object.fromEntries('a:e b:bi c:si d:di e:i f:ef g:ji h:ech i:ai j:je k:ke l:el m:em n:en o:o p:pi q:kyu r:ar s:es t:ti u:yu v:vi w:dablyu x:eks y:vai z:zed'
  .split(' ').map((x) => { const [l, w] = x.split(':'); return [l, soundKey(w)]; }));
const index = new WeakMap();
function prepared(items) {
  if (index.has(items)) return index.get(items);
  const out = items.map((it) => {
    const name = String(it.name || '');
    const size = name.match(SIZE_RE);
    const tokens = name.replace(SIZE_RE, ' ').split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t && !/^\d+$/.test(t))
      .map((t) => (/^[a-z]$/i.test(t) ? LETTER[t.toLowerCase()] : soundKey(t))).filter(Boolean);
    return { it, tokens, size: size ? { n: +size[1], unit: UNIT_OF_ITEM(size[2]) } : null, unit: UNIT_OF_ITEM(it.unit) };
  });
  index.set(items, out);
  return out;
}
const GENERIC = new Set(['sabun soap', 'tel oil', 'chai tea', 'biscuit biskit biskut', 'powder pauder', 'bar', 'pani water', 'noodles', 'masala', 'dal daal', 'aata atta',
  'chawal rice', 'doodh milk', 'namkeen', 'packet', 'bottle', 'cold drink'].flatMap((g) => g.split(' ').map(soundKey)));
const weightOf = (q) => (GENERIC.has(q) || (GROUP_OF.has(q) && GROUPS[GROUP_OF.get(q)].some((k) => GENERIC.has(k))) ? 0.4 : 1);
function score(qTokens, p) {
  if (!qTokens.length || !p.tokens.length) return 0;
  const used = new Set();
  let sum = 0, all = 0;
  for (const q of qTokens) {
    let best = 0, at = -1;
    p.tokens.forEach((t, i) => { const s = wordLikeness(q, t); if (s > best) { best = s; at = i; } });
    const w = weightOf(q);
    all += w;
    sum += best >= 0.6 ? best * w : 0;
    if (best >= 0.6) used.add(at);
  }
  return 0.8 * (sum / all) + 0.2 * (used.size / p.tokens.length);
}
/* how many of the item's own unit: "2 kilo" of a 1 kg pack is 2 packs; "250 gram" of an item sold by the kg is 0.25 */
function qtyFor(piece, p) {
  const price = +(p.it.sale_price_incl || p.it.sale_price || 0);
  // three decimals, as the bill keeps them; the bill's round-off brings ₹49.98 back to the ₹50 asked for
  if (piece.rupees && piece.amount && price > 0) return { qty: Math.round(piece.amount / price * 1000) / 1000, note: `₹${piece.amount}` };
  const amt = piece.amount === null || piece.amount === undefined ? 1 : piece.amount;
  const said = piece.unit ? BASE[piece.unit] : null;
  // an item sold by the dozen, with no unit said: "25 अंडे" is 25 eggs, not 25 dozen
  if (!said && p.unit === 'dozen' && piece.amount != null) return { qty: Math.round(amt / 12 * 1000) / 1000, note: `${amt} pcs` };
  if (!said) return { qty: amt };
  const target = p.unit !== 'pc' ? p.unit : p.size ? p.size.unit : 'pc';
  const tb = BASE[target];
  if (said[0] === 'n') return { qty: piece.unit === 'dozen' && target !== 'dozen' ? amt * 12 : amt };
  if (!tb || tb[0] !== said[0]) return { qty: amt };
  const inBase = amt * said[1];
  const per = p.unit === 'pc' && p.size ? p.size.n * tb[1] : tb[1];
  return { qty: Math.round(inBase / per * 1000) / 1000 };
}

/* The bill lines for what was said: each with the best item (null when nothing is close), up to 4 other likely items to
   choose from, the quantity in the item's own unit, and the words it came from. */
export function parseOrder(text, items) {
  const list = prepared(items || []);
  return pieces(text).map((pc) => {
    const q = pc.name.split(/\s+/).filter(Boolean).map((t) => (/^[a-z]$/.test(t) ? LETTER[t] : soundKey(t))).filter(Boolean);
    // "Tata chai 250 gram": a pack of that size is a little closer than the 1 kg pack
    const sameSize = (p) => pc.size && p.size && BASE[pc.size.unit] && BASE[p.size.unit] && BASE[pc.size.unit][0] === BASE[p.size.unit][0]
      && Math.abs(pc.size.amount * BASE[pc.size.unit][1] - p.size.n * BASE[p.size.unit][1]) < 1e-6;
    const ranked = list.map((p) => { const s0 = score(q, p); return { p, s: s0 > 0 && sameSize(p) ? s0 + 0.1 : s0 }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
    const top = ranked[0] && ranked[0].s >= 0.55 ? ranked[0] : null;
    const qn = top ? qtyFor(pc, top.p) : { qty: pc.amount === null || pc.amount === undefined ? 1 : pc.amount };
    return { heard: pc.heard, words: pc.name, qty: qn.qty, note: qn.note || '', item_id: top ? top.p.it.id : null, name: top ? top.p.it.name : '',
      score: top ? Math.round(top.s * 100) / 100 : 0, options: ranked.map((x) => ({ id: x.p.it.id, name: x.p.it.name, score: Math.round(x.s * 100) / 100 })) };
  });
}

/* What the speech service has heard so far, from its list of results. Chrome on a computer gives one result per pause; Chrome
   on Android repeats what it already gave in each new result ("2 किलो चीनी", then "2 किलो चीनी 1 लीटर तेल"), and can give the
   same result twice. Each final piece is kept once: one that starts with the previous piece replaces it, one already
   contained in it is dropped. results: [{ transcript, isFinal }]. Returns the final text (pieces joined by ", ") and the
   words still being heard. */
export function heardText(results) {
  const done = [];
  let now = '';
  const norm = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/[\s,.।]+/g, ' ').trim();
  for (const r of results) {
    const t = String(r.transcript || '').trim();
    if (!t) continue;
    if (!r.isFinal) { now = t; continue; }
    const last = done.length ? norm(done[done.length - 1]) : '', n = norm(t);
    if (last && n.startsWith(last)) done[done.length - 1] = t;
    else if (last && last.includes(n)) continue;
    else done.push(t);
  }
  // an unfinished piece that only repeats what is already final adds nothing
  const all = norm(done.join(' '));
  if (now && all && all.endsWith(norm(now))) now = '';
  else if (now && done.length && norm(now).startsWith(norm(done[done.length - 1]))) now = now.slice(done[done.length - 1].length).trim();
  return { done: done.join(', '), now };
}
