/* What the customer reads, in the language the shop picks for them: English, Hindi (Devanagari) or Hinglish.
   One table of phrases, so every WhatsApp / SMS message (bills, reminders, khata, promises, receipts, balance
   confirmations) and the link preview speak the same language. The choice is remembered per contact
   (parties.lang); the business default is orgs.msg_lang. */
export const LANGS = ['en', 'hi', 'hl'];
export const LANG_NAMES = { en: 'English', hi: 'हिंदी', hl: 'Hinglish' };
export const cleanLang = (v, def = 'hl') => (LANGS.includes(v) ? v : def);

const DOC_HI = { INV: 'बिल', SRET: 'बिक्री वापसी', CNOTE: 'क्रेडिट नोट', QUOTE: 'कोटेशन', SO: 'सेल्स ऑर्डर', DN: 'डिलीवरी चालान' };

const P = {
  en: {
    hello: (n) => `Dear ${n},`, docLabel: (t, label) => label,
    amount: 'Amount', due: 'Balance due', paid: 'Paid ✅', totalDue: 'Total due', viaUpi: 'UPI',
    viewDocPay: 'View and download the bill, or pay by UPI ⬇', viewDoc: 'View and download the document ⬇',
    smsDoc: (o, l, n, d, a, due, url) => `${o}: ${l} ${n} dated ${d}, amount ${a}${due ? `, due ${due}` : ''}. View: ${url}`,
    remTitle: '⏰ Payment reminder', more: (n) => `…and ${n} more`,
    tone: { soon: 'A friendly reminder: these bills fall due soon.', today: 'These bills are due today.', late: 'These bills are still unpaid:',
      gentle: 'A gentle reminder about these bills:', late30: 'These bills are unpaid for more than 30 days:', final: 'Final reminder. These bills are long overdue:' },
    msme: (u) => `As an MSME (Udyam ${u}), we are entitled to interest on payments delayed beyond 45 days (MSMED Act, Section 16).`,
    finalAsk: 'Please clear the dues within 7 days, or we will have to take the matter forward.',
    payPlease: 'Please pay at the earliest.',
    viewBillPay: 'View the bill and pay by UPI ⬇', viewBill: 'View the bill here ⬇',
    smsRem: (o, n, k, due, url) => `${o}: Dear ${n}, ${k} bill(s) due, total ${due}. Please pay: ${url}`,
    khEntry: '✍ Khata entry', gave: 'Credit given', got: 'Payment received', note: 'Note', advance: 'Your advance', clear: 'Account settled ✅',
    khSee: 'See your khata and confirm ⬇', khSeePay: 'See your khata and pay by UPI ⬇', khSeeAll: 'See your full khata here ⬇',
    yourDue: 'Your balance due', clearHello: (n) => `Dear ${n}, your account is settled ✅`, thanks: 'Thank you!',
    smsKhEntry: (o, what, amt, note, d, bal, url) => `${o}: ${what} ${amt}${note ? ` (${note})` : ''} on ${d}. ${bal}. See/confirm: ${url}`,
    smsKhRem: (o, n, due, url) => `${o}: Dear ${n}, your balance due is ${due}. Please pay at the earliest. Khata/pay: ${url}`,
    smsKhClear: (o, n, url) => `${o}: Dear ${n}, your account is settled. Thank you! ${url}`,
    vPick: 'When can you pay? Pick a date on the link ⬇', vFirm: (d, a) => `You promised to pay *${a}* by *${d}*. Please pay today.`,
    vStop: 'New credit only after the old dues are cleared.', vSmsBroken: (d) => `Promise missed (${d}).`, vToday: (a) => `Today is your promised date: *${a}*`,
    vSms: (d, a) => `Promise: ${d} ${a}.`, vUp: (d, a) => `Your promise: *${a}* by *${d}* 🙏`,
    vNoted: '✍ Your promise is noted', vBy: (d, a) => `*${a}* by *${d}*`, vSee: (book) => `See your ${book === 'inv' ? 'bill' : 'khata'} ⬇`,
    smsVNoted: (o, n, d, a, url) => `${o}: Dear ${n}, your promise is noted: ${a} by ${d}. ${url}`,
    rcTitle: '✅ Payment received', rcGot: (a, d, no) => `We received *${a}* on ${d} (receipt ${no}).`, rcBy: 'Collected by', rcBal: 'Balance now',
    rcClear: 'All bills paid ✅', rcAdv: 'Advance with us', smsRc: (o, a, d, no, bal) => `${o}: Received ${a} on ${d}, receipt ${no}. ${bal}. Thank you!`,
    cfTitle: (d) => `📒 Balance confirmation · as on ${d}`, cfBody: (a, n) => `As per our books, your balance due is *${a}* (${n} bill${n === 1 ? '' : 's'}).`,
    cfAsk: 'Please check and confirm with one tap ⬇', smsCf: (o, a, d, url) => `${o}: Your balance due as on ${d} is ${a}. Please confirm: ${url}`,
    sentVia: (b) => `_Sent via ${b}_`,
  },
  hi: {
    hello: (n) => `नमस्ते ${n} जी,`, docLabel: (t, label) => DOC_HI[t] || label,
    amount: 'राशि', due: 'बकाया', paid: 'भुगतान हो गया ✅', totalDue: 'कुल बकाया', viaUpi: 'UPI',
    viewDocPay: 'बिल देखें, डाउनलोड करें या UPI से भुगतान करें ⬇', viewDoc: 'दस्तावेज़ देखें और डाउनलोड करें ⬇',
    smsDoc: (o, l, n, d, a, due, url) => `${o}: ${l} ${n} दि. ${d}, राशि ${a}${due ? `, बकाया ${due}` : ''}. देखें: ${url}`,
    remTitle: '⏰ भुगतान याद-दिहानी', more: (n) => `…और ${n} बिल`,
    tone: { soon: 'याद दिला दें: ये बिल जल्द देय हैं।', today: 'ये बिल आज देय हैं।', late: 'इन बिलों का भुगतान बाकी है:',
      gentle: 'विनम्र याद-दिहानी, ये बिल बाकी हैं:', late30: 'ये बिल 30 दिन से अधिक समय से बाकी हैं:', final: 'अंतिम याद-दिहानी। ये बिल बहुत समय से बाकी हैं:' },
    msme: (u) => `MSME (उद्यम ${u}) होने के नाते, 45 दिन से अधिक देरी पर हमें ब्याज का अधिकार है (MSMED अधिनियम, धारा 16)।`,
    finalAsk: 'कृपया 7 दिनों में बकाया चुका दें, अन्यथा हमें आगे की कार्रवाई करनी पड़ेगी।',
    payPlease: 'कृपया जल्द भुगतान करें।',
    viewBillPay: 'बिल देखें और UPI से भुगतान करें ⬇', viewBill: 'बिल यहाँ देखें ⬇',
    smsRem: (o, n, k, due, url) => `${o}: नमस्ते ${n} जी, ${k} बिल बाकी, कुल ${due}. कृपया भुगतान करें: ${url}`,
    khEntry: '✍ खाता एंट्री', gave: 'उधार लिखा गया', got: 'भुगतान मिला', note: 'नोट', advance: 'आपका एडवांस', clear: 'खाता साफ़ है ✅',
    khSee: 'अपना खाता देखें और पुष्टि करें ⬇', khSeePay: 'खाता देखें और UPI से भुगतान करें ⬇', khSeeAll: 'पूरा खाता यहाँ देखें ⬇',
    yourDue: 'आपका बकाया', clearHello: (n) => `नमस्ते ${n} जी, आपका खाता साफ़ है ✅`, thanks: 'धन्यवाद!',
    smsKhEntry: (o, what, amt, note, d, bal, url) => `${o}: ${amt} ${what}${note ? ` (${note})` : ''} दि. ${d}. ${bal}. देखें/पुष्टि करें: ${url}`,
    smsKhRem: (o, n, due, url) => `${o}: नमस्ते ${n} जी, आपका बकाया ${due} है। कृपया जल्द भुगतान करें। खाता: ${url}`,
    smsKhClear: (o, n, url) => `${o}: नमस्ते ${n} जी, आपका खाता साफ़ है। धन्यवाद! ${url}`,
    vPick: 'कब तक देंगे? लिंक पर खुद तारीख चुनें ⬇', vFirm: (d, a) => `आपने *${d}* तक *${a}* देने का वादा किया था। कृपया आज भुगतान करें।`,
    vStop: 'नया उधार पुराना बकाया चुकाने के बाद ही मिलेगा।', vSmsBroken: (d) => `वादा टूटा (${d}).`, vToday: (a) => `आज आपके वादे का दिन है: *${a}*`,
    vSms: (d, a) => `वादा: ${d} ${a}.`, vUp: (d, a) => `आपका वादा: *${d}* तक *${a}* 🙏`,
    vNoted: '✍ आपका वादा लिख लिया', vBy: (d, a) => `*${d}* तक *${a}*`, vSee: (book) => `अपना ${book === 'inv' ? 'बिल' : 'खाता'} देखें ⬇`,
    smsVNoted: (o, n, d, a, url) => `${o}: नमस्ते ${n} जी, आपका वादा लिख लिया: ${d} तक ${a}. ${url}`,
    rcTitle: '✅ भुगतान प्राप्त', rcGot: (a, d, no) => `हमें ${d} को *${a}* मिले (रसीद ${no})।`, rcBy: 'प्राप्तकर्ता', rcBal: 'अब बकाया',
    rcClear: 'सभी बिल चुकता ✅', rcAdv: 'हमारे पास आपका एडवांस', smsRc: (o, a, d, no, bal) => `${o}: ${d} को ${a} प्राप्त, रसीद ${no}. ${bal}. धन्यवाद!`,
    cfTitle: (d) => `📒 बकाया पुष्टि · ${d} तक`, cfBody: (a, n) => `हमारे खाते के अनुसार आपका बकाया *${a}* है (${n} बिल)।`,
    cfAsk: 'कृपया जाँच कर एक टैप में पुष्टि करें ⬇', smsCf: (o, a, d, url) => `${o}: ${d} तक आपका बकाया ${a} है। कृपया पुष्टि करें: ${url}`,
    sentVia: (b) => `_${b} से भेजा गया_`,
  },
  hl: {
    hello: (n) => `Namaste ${n} ji,`, docLabel: (t, label) => label,
    amount: 'Amount', due: 'Baaki', paid: 'Paid ✅', totalDue: 'Total baaki', viaUpi: 'UPI',
    viewDocPay: 'Bill dekhein, download karein ya UPI se pay karein ⬇', viewDoc: 'Document dekhein aur download karein ⬇',
    smsDoc: (o, l, n, d, a, due, url) => `${o}: ${l} ${n} dt ${d}, amount ${a}${due ? `, baaki ${due}` : ''}. Dekhein: ${url}`,
    remTitle: '⏰ Payment reminder', more: (n) => `…aur ${n} bills`,
    tone: { soon: 'Yaad dila dein: ye bills jaldi due hain.', today: 'Ye bills aaj due hain.', late: 'Ye bills baaki hain:',
      gentle: 'Ek chhota sa reminder, ye bills baaki hain:', late30: 'Ye bills 30 din se zyada se baaki hain:', final: 'Aakhri reminder. Ye bills bahut time se baaki hain:' },
    msme: (u) => `MSME (Udyam ${u}) hone ke naate, 45 din se zyada deri par byaaj lagta hai (MSMED Act, Section 16).`,
    finalAsk: 'Kripya 7 din mein baaki chuka dein, warna humein aage kadam uthana padega.',
    payPlease: 'Kripya jaldi bhugtan karein.',
    viewBillPay: 'Bill dekhein aur UPI se pay karein ⬇', viewBill: 'Bill yahan dekhein ⬇',
    smsRem: (o, n, k, due, url) => `${o}: Namaste ${n}, ${k} bill(s) baaki, total ${due}. Kripya bhugtan karein: ${url}`,
    khEntry: '✍ Khata entry', gave: 'Udhaar likha gaya', got: 'Payment mila', note: 'Note', advance: 'Aapka advance', clear: 'Khata clear hai ✅',
    khSee: 'Apna khata dekhein aur confirm karein ⬇', khSeePay: 'Khata dekhein aur UPI se pay karein ⬇', khSeeAll: 'Poora khata yahan dekhein ⬇',
    yourDue: 'Aapka baaki', clearHello: (n) => `Namaste ${n} ji, aapka khata clear hai ✅`, thanks: 'Dhanyavaad!',
    smsKhEntry: (o, what, amt, note, d, bal, url) => `${o}: ${amt} ${what.toLowerCase()}${note ? ` (${note})` : ''} ${d}. ${bal}. Khata dekhein/confirm karein: ${url}`,
    smsKhRem: (o, n, due, url) => `${o}: Namaste ${n}, aapka baaki ${due} hai. Kripya jaldi bhugtan karein. Khata/pay: ${url}`,
    smsKhClear: (o, n, url) => `${o}: Namaste ${n}, aapka khata clear hai. Dhanyavaad! ${url}`,
    vPick: 'Kab tak denge? Link par khud tareekh chunein ⬇', vFirm: (d, a) => `Aapne *${d}* tak *${a}* dene ka vaada kiya tha. Kripya aaj bhugtan karein.`,
    vStop: 'Agla udhaar tabhi milega jab purana baaki clear ho.', vSmsBroken: (d) => `Vaada toota (${d}).`, vToday: (a) => `Aaj aapke vaade ka din hai: *${a}*`,
    vSms: (d, a) => `Vaada: ${d} ${a}.`, vUp: (d, a) => `Aapka vaada: *${d}* tak *${a}* 🙏`,
    vNoted: '✍ Aapka vaada likh liya', vBy: (d, a) => `*${d}* tak *${a}*`, vSee: (book) => `Apna ${book === 'inv' ? 'bill' : 'khata'} dekhein ⬇`,
    smsVNoted: (o, n, d, a, url) => `${o}: Namaste ${n}, aapka vaada likh liya: ${d} tak ${a}. ${url}`,
    rcTitle: '✅ Payment mila', rcGot: (a, d, no) => `Humein ${d} ko *${a}* mile (receipt ${no}).`, rcBy: 'Collected by', rcBal: 'Ab baaki',
    rcClear: 'Saare bills clear ✅', rcAdv: 'Aapka advance', smsRc: (o, a, d, no, bal) => `${o}: ${d} ko ${a} mile, receipt ${no}. ${bal}. Dhanyavaad!`,
    cfTitle: (d) => `📒 Balance confirmation · ${d} tak`, cfBody: (a, n) => `Hamare hisaab se aapka baaki *${a}* hai (${n} bill${n === 1 ? '' : 's'}).`,
    cfAsk: 'Kripya check karke ek tap mein confirm karein ⬇', smsCf: (o, a, d, url) => `${o}: ${d} tak aapka baaki ${a} hai. Kripya confirm karein: ${url}`,
    sentVia: (b) => `_Sent via ${b}_`,
  },
};
export const phrases = (lang) => P[cleanLang(lang)];

/* The link preview (WhatsApp's card under the link) for /i/, /k/ and /c/ links */
export const PREVIEW = {
  en: { doc: (l, n, o) => `${l} ${n} · ${o}`, docDesc: (a, due) => `Amount ${a}${due === null ? '' : due ? ` · Due ${due}` : ' · Paid'}. View, download${due ? ' and pay' : ''}.`,
    kh: (n, o) => `${n}'s khata · ${o}`, khDue: (b, upi) => `Balance due: ${b}. See entries, confirm${upi ? ' and pay by UPI' : ''}.`, khAdv: (b) => `Advance: ${b}. See the full khata.`,
    khClear: 'Account settled. See the full statement.', cf: (o) => `Balance confirmation · ${o}`, cfDesc: (a) => `Balance due ${a}. Check and confirm with one tap.` },
  hi: { doc: (l, n, o) => `${l} ${n} · ${o}`, docDesc: (a, due) => `राशि ${a}${due === null ? '' : due ? ` · बकाया ${due}` : ' · भुगतान हो गया'}। देखें, डाउनलोड करें${due ? ' और भुगतान करें' : ''}।`,
    kh: (n, o) => `${n} का खाता · ${o}`, khDue: (b, upi) => `बकाया: ${b}। एंट्री देखें, पुष्टि करें${upi ? ' और UPI से भुगतान करें' : ''}।`, khAdv: (b) => `एडवांस: ${b}। पूरा खाता देखें।`,
    khClear: 'खाता साफ़ है। पूरा हिसाब देखें।', cf: (o) => `बकाया पुष्टि · ${o}`, cfDesc: (a) => `बकाया ${a}। जाँचें और एक टैप में पुष्टि करें।` },
  hl: { doc: (l, n, o) => `${l} ${n} · ${o}`, docDesc: (a, due) => `Amount ${a}${due === null ? '' : due ? ` · Due ${due}` : ' · Paid'}. Dekhein, download karein${due ? ' aur pay karein' : ''}.`,
    kh: (n, o) => `${n} ka khata · ${o}`, khDue: (b, upi) => `Baaki: ${b}. Entries dekhein, confirm karein${upi ? ' aur UPI se pay karein' : ''}.`, khAdv: (b) => `Advance: ${b}. Poora khata dekhein.`,
    khClear: 'Khata clear hai. Poora hisaab dekhein.', cf: (o) => `Balance confirmation · ${o}`, cfDesc: (a) => `Baaki ${a}. Check karke ek tap mein confirm karein.` },
};

/* a customer link that opens (and previews) in the chosen language; Hinglish is the original, unmarked link */
export const withLang = (url, lang) => (url && lang && lang !== 'hl' ? `${url}?l=${lang}` : url);

/* WhatsApp gets a formatted message (bold, sections, the link on its own line so WhatsApp shows the banner card);
   SMS gets one short plain line. Both are signed with the ERP's name. */
export const BRAND = 'SmartTrader ERP';
export function sendLinks(phoneRaw, wa, sms = wa) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  const to = phone.length === 10 ? '91' + phone : phone;
  return { text: wa, sms_text: sms, whatsapp_url: `https://api.whatsapp.com/send?${to ? `phone=${to}&` : ''}text=${encodeURIComponent(wa)}`, sms_url: phone ? `sms:${phone}?body=${encodeURIComponent(sms)}` : '' };
}
export const inrW = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rs = (p) => 'Rs ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fd = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
