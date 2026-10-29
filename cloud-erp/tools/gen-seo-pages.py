# Generates the public SEO pages in public/ (run: python3 tools/gen-seo-pages.py). Edit the text here, not the HTML.
# Writes: one folder per page (index.html), the landing part of public/index.html (between the landing markers),
# public/404.html, and both sitemaps.
import json, os, html, re
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
SITE = 'https://erp.docbrisk.com'
TODAY = '2026-10-25'
SUPPORT = 'https://wa.me/919068446139'
NAV = [('/gst-billing-software/', 'GST Billing'), ('/khata-book-app/', 'Khata Book'), ('/inventory-management-software/', 'Inventory'),
       ('/pos-billing-software/', 'POS'), ('/pricing/', 'Pricing')]
PRICES = [('Free', '₹0', 'forever', ['50 invoices / month', '1 user, 1 godown', 'Unlimited khata entries', 'POS & barcode billing', 'GST reports, P&L, Balance Sheet']),
          ('Starter', '₹999', '/year + GST', ['Unlimited invoices', '2 users, 1 godown', 'Everything in Free', 'Tally export']),
          ('Growth', '₹2,499', '/year + GST', ['Unlimited invoices', '5 users, 3 godowns', 'E-invoice & e-way bill JSON', 'Orders, GRN, gate entry']),
          ('Business', '₹4,499', '/year + GST', ['Unlimited invoices', '15 users, unlimited godowns', 'Everything in Growth', 'Priority WhatsApp support (+91 90684 46139)'])]
GROUPS = [('core', 'Software'), ('industry', 'By business'), ('feature', 'Features'), ('hi', 'हिंदी में')]
PAGES = []


def page(path, title, desc, h1, lead, sections, faqs, keywords, group='core', short=None, lang='en-IN', alt=None):
    assert len(title) <= 60, (path, len(title))
    assert 110 <= len(desc) <= 160, (path, len(desc))
    PAGES.append(dict(path=path, title=title, desc=desc, h1=h1, lead=lead, sections=sections, faqs=faqs, keywords=keywords,
                      group=group, short=short or h1, lang=lang, alt=alt or {}))


def ul(items): return '<ul class="ticks">' + ''.join(f'<li>{i}</li>' for i in items) + '</ul>'
def grid(cards): return '<div class="cards">' + ''.join(f'<div class="card"><h3>{t}</h3><p>{d}</p></div>' for t, d in cards) + '</div>'
def steps(items): return '<ol class="steps">' + ''.join(f'<li>{i}</li>' for i in items) + '</ol>'
def links(items): return '<div class="cards">' + ''.join(f'<a class="card link" href="{h}"><h3>{t}</h3><p>{d}</p></a>' for h, t, d in items) + '</div>'


pricing_html = '<div class="cards prices">' + ''.join(
    f'<div class="card{" pop" if n == "Growth" else ""}"><h3>{n}</h3><div class="price">{p}<span> {per}</span></div>{ul(f)}<a class="btn primary" href="/#signup">Start free</a></div>'
    for n, p, per, f in PRICES) + '</div>'

APP_LD = {"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "SmartTrader ERP", "url": SITE + "/",
          "applicationCategory": "BusinessApplication", "applicationSubCategory": "Billing, inventory and accounting software",
          "operatingSystem": "Web, Android, iOS, Windows", "inLanguage": ["en-IN", "hi-IN"],
          "offers": {"@type": "AggregateOffer", "priceCurrency": "INR", "lowPrice": "0", "highPrice": "4499", "offerCount": "4"},
          "publisher": {"@type": "Organization", "name": "DocBrisk", "url": "https://docbrisk.com"}}
ORG_LD = {"@context": "https://schema.org", "@type": "Organization", "name": "DocBrisk", "url": "https://docbrisk.com",
          "logo": SITE + "/icons/icon-512.png", "sameAs": [SITE + "/"],
          "contactPoint": {"@type": "ContactPoint", "contactType": "customer support", "url": SUPPORT, "areaServed": "IN", "availableLanguage": ["en", "hi"]}}


def footer(current, lang):
    cols = []
    for g, label in GROUPS:
        items = [p for p in PAGES if p['group'] == g]
        cols.append(f'<div><h4>{label}</h4><ul>' + ''.join(
            f'<li><a href="{p["path"]}"{" class=on" if p["path"] == current else ""}>{html.escape(p["short"])}</a></li>' for p in items) + '</ul></div>')
    cols.append('<div><h4>SmartTrader</h4><ul><li><a href="/pricing/">Pricing</a></li><li><a href="/#signup">Create a free account</a></li><li><a href="/#login">Sign in</a></li>'
                f'<li><a href="{SUPPORT}" rel="noopener">WhatsApp support</a></li><li><a href="/privacy/">Privacy</a></li>'
                '<li><a href="https://docbrisk.com/">DocBrisk free tools</a></li></ul></div>')
    return ('<footer><div class="fgrid">' + ''.join(cols) + '</div>'
            '<p>© 2026 SmartTrader ERP by DocBrisk. GST billing, inventory, accounts and khata for Indian businesses.</p></footer>')


def topbar(current, lang):
    nav = ''.join(f'<a href="{h}"{" class=on" if h == current else ""}>{t}</a>' for h, t in NAV)
    login, start = ('लॉग इन', 'मुफ़्त शुरू करें') if lang.startswith('hi') else ('Login', 'Start free')
    return (f'<header class="top"><a class="logo" href="/"><img src="/icons/icon-192.png" alt="" width="32" height="32">SmartTrader ERP</a><nav aria-label="Main">{nav}</nav>'
            f'<a class="btn" href="/#login">{login}</a><a class="btn primary" href="/#signup">{start}</a></header>')


def related(p):
    same = [x for x in PAGES if x is not p and x['group'] == p['group'] and x['lang'][:2] == p['lang'][:2]]
    other = [x for x in PAGES if x is not p and x['group'] != p['group'] and x['lang'][:2] == p['lang'][:2] and x['path'] != '/pricing/']
    picks = (same[:3] + other[:6])[:6] if p['group'] != 'hi' else [x for x in PAGES if x is not p and x['group'] == 'hi'] + [PAGES[0]]
    head = 'और जानें' if p['lang'].startswith('hi') else 'Also useful'
    return f'<section><h2>{head}</h2>' + links([(x['path'], html.escape(x['short']), html.escape(x['desc'][:110].rsplit(' ', 1)[0] + '…')) for x in picks]) + '</section>'


def render(p):
    url = SITE + p['path']
    hi = p['lang'].startswith('hi')
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in p['faqs']]} if p['faqs'] else None
    page_ld = {"@context": "https://schema.org", "@type": "WebPage", "name": p['title'], "url": url, "description": p['desc'],
               "inLanguage": p['lang'], "isPartOf": {"@type": "WebSite", "name": "SmartTrader ERP", "url": SITE + "/"},
               "about": {"@type": "SoftwareApplication", "name": "SmartTrader ERP", "url": SITE + "/"}, "dateModified": TODAY}
    crumbs = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "SmartTrader ERP", "item": SITE + "/"},
        {"@type": "ListItem", "position": 2, "name": p['short'], "item": url}]}
    lds = [APP_LD, page_ld, crumbs] + ([faq_ld] if faq_ld else [])
    alts = ''.join(f'<link rel="alternate" hreflang="{l}" href="{SITE}{h}">' for l, h in p['alt'].items())
    body = ''.join(f'<section><h2>{html.escape(t)}</h2>{c}</section>' for t, c in p['sections'])
    faq = ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in p['faqs'])
    faq_h = 'अक्सर पूछे जाने वाले सवाल' if hi else 'Frequently asked questions'
    cta = (('आज ही शुरू करें', 'फ़्री प्लान में हर महीने 50 बिल और अनलिमिटेड खाता। कार्ड की ज़रूरत नहीं।', 'मुफ़्त अकाउंट बनाएं') if hi else
           ('Shuru karein aaj hi', 'Free plan me 50 invoices har mahine aur unlimited khata. Card ki zaroorat nahi.', 'Create your free account'))
    hero_btn = (('मुफ़्त शुरू करें, कार्ड नहीं चाहिए', 'कीमत देखें', 'मोबाइल, टैबलेट और कंप्यूटर पर चलता है · ऐप की तरह इंस्टॉल करें · भारत के कारोबार के लिए') if hi else
                ('Start free, no card needed', 'See pricing', 'Works on mobile, tablet and computer · Install as an app · Made for Indian businesses'))
    doc = f'''<!doctype html>
<html lang="{'hi' if hi else 'en-IN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(p['title'])}</title>
<meta name="description" content="{html.escape(p['desc'])}">
<meta name="keywords" content="{html.escape(p['keywords'])}">
<link rel="canonical" href="{url}">{alts}
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0f766e">
<meta property="og:type" content="website"><meta property="og:site_name" content="SmartTrader ERP">
<meta property="og:title" content="{html.escape(p['title'])}"><meta property="og:description" content="{html.escape(p['desc'])}">
<meta property="og:url" content="{url}"><meta property="og:image" content="{SITE}/og-invoice{'-hi' if hi else ''}.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:locale" content="{'hi_IN' if hi else 'en_IN'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/site.css">
''' + ''.join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>\n' for x in lds) + f'''</head>
<body>
{topbar(p['path'], p['lang'])}
<main>
<nav class="crumb" aria-label="Breadcrumb"><a href="/">SmartTrader ERP</a> › <span>{html.escape(p['short'])}</span></nav>
<section class="hero"><h1>{html.escape(p['h1'])}</h1><p class="lead">{p['lead']}</p>
<p><a class="btn primary big" href="/#signup">{hero_btn[0]}</a> <a class="btn big" href="/pricing/">{hero_btn[1]}</a></p>
<p class="small">{hero_btn[2]}</p></section>
{body}
{f'<section><h2>{faq_h}</h2>{faq}</section>' if faq else ''}
{related(p)}
<section class="cta"><h2>{cta[0]}</h2><p>{cta[1]}</p><a class="btn primary big" href="/#signup">{cta[2]}</a></section>
</main>
{footer(p['path'], p['lang'])}
</body>
</html>
'''
    d = OUT + p['path']
    os.makedirs(d, exist_ok=True)
    open(d + 'index.html', 'w').write(doc)


# ============================================================ the core pages
page('/gst-billing-software/', 'Free GST Billing Software for Small Business | SmartTrader',
     'Make GST invoices in seconds: CGST/SGST/IGST auto, HSN, UPI QR on the bill, WhatsApp share, e-invoice & e-way bill JSON, GST reports. Free plan.',
     'GST billing software for small businesses',
     'Bill banaiye 10 second me. CGST, SGST ya IGST apne aap lagta hai, bill par UPI QR chhapta hai, aur customer ko WhatsApp par link jata hai jahan wo bill dekh kar pay kar sakta hai.',
     [('Everything a GST bill needs', grid([
         ('Correct GST, every time', 'Intra-state CGST + SGST or inter-state IGST is picked from the GSTIN / state. HSN codes, all GST slabs, round-off to the rupee.'),
         ('Bill with UPI QR', 'Every invoice prints a UPI QR for the exact amount due, so customers pay on the spot with GPay, PhonePe or Paytm.'),
         ('Share on WhatsApp', 'Send the bill as a link with a preview card, or as a real PDF from the phone. The customer can view it, download it and pay.'),
         ('Quick bill / POS', 'Scan barcodes with a scanner or the phone camera, take cash, UPI or card, and print an 80 mm receipt.'),
         ('MRP billing', 'Type prices with GST in them: Rs 10 MRP stays Rs 10 on the bill, and the GST is taken out of it to the paisa.'),
         ('Returns & credit notes', 'Sales returns, purchase returns and rate-difference credit/debit notes that settle the original bill.'),
         ('E-invoice & e-way bill', 'Download e-invoice (IRN) and e-way bill JSON in the government format and save the IRN back on the bill.')])),
      ('GST reports for your CA', ul(['GST summary by rate, B2B / B2C, output tax, input credit and net payable',
                                       'Sales and purchase registers, exportable to CSV', 'Tally XML export with a matching trial balance',
                                       'Profit & Loss, Balance Sheet and Trial Balance from real double-entry accounts'])),
      ('Bill designs and languages', ul(['Several invoice designs with a live preview; pick one per bill',
                                          'Messages to customers in English, Hindi or Hinglish',
                                          'Your logo, UPI ID, bank details and terms on every bill']))],
     [('Is SmartTrader GST billing software free?', 'Yes. The Free plan includes 50 GST invoices a month, unlimited khata entries, POS billing and all reports. Paid plans start at Rs 999 a year.'),
      ('Does it calculate CGST, SGST and IGST automatically?', 'Yes. It compares the state of your business and your customer (from the GSTIN or state name) and applies CGST + SGST or IGST on every line.'),
      ('Can I send GST bills on WhatsApp?', 'Yes. Each bill has a WhatsApp button that sends a link with the amount, a preview card and a page where the customer can download the PDF and pay by UPI.'),
      ('Does it support e-invoice and e-way bill?', 'It creates the e-invoice and e-way bill JSON files in the government format for upload on the portals, and stores the IRN and e-way bill number on the invoice.'),
      ('Can my accountant use the data in Tally?', 'Yes. Export a Tally XML file for any period and import it into Tally Prime; the trial balance matches.')],
     'GST billing software, free GST billing software, GST invoice software India, billing software for small business, bill banane wala app, GST bill app',
     short='GST billing software', alt={'en-IN': '/gst-billing-software/', 'hi-IN': '/hi/gst-billing-software/', 'x-default': '/gst-billing-software/'})

page('/khata-book-app/', 'Khata Book App with WhatsApp Reminders & UPI | SmartTrader',
     'Free digital khata (udhaar) book: every entry goes to the customer on WhatsApp/SMS, the customer confirms it online and pays by UPI. Reminders included.',
     'Digital khata book that customers trust',
     'Udhaar ka hisaab ab saaf. Har entry customer ko WhatsApp ya SMS par jaati hai, customer link khol kar apna poora khata dekhta hai, entry confirm karta hai aur UPI se pay karta hai.',
     [('Why shops switch to SmartTrader Khata', grid([
         ('Entry counts only after it is sent', 'A new entry is saved only when you send it to the customer, so nobody can say "yeh entry kab likhi?"'),
         ('Customer confirms each entry', 'The customer opens a private link, sees every entry and the balance, and taps Yes or No. Disputes show up for you at once.'),
         ('No silent edits', 'Sent entries cannot be deleted. A mistake is corrected with a reverse entry that the customer also receives.'),
         ('WhatsApp & SMS reminders', 'One tap sends a reminder with the balance and your UPI. The Payment Reminders screen lists everyone who owes you.'),
         ('Pay by UPI from the link', 'The customer gets a Pay button, a QR and your UPI ID, so collection is faster.'),
         ('Khata + billing + stock', 'Unlike a plain khata app, the same account also does GST bills, stock and full accounts when you need them.')])),
      ('How it works', steps(['Tap <b>You gave</b> or <b>You got</b> and enter the amount.', 'Send it on WhatsApp or SMS. The entry is saved.',
                              'The customer opens the link, confirms the entry and pays by UPI.'])),
      ('Payment promises that are kept', ul(['The customer picks a pay date on their link (“Kab tak denge?”), or pays in instalments',
                                             'The Today card shows whose promise falls due today',
                                             'A monthly balance confirmation the customer answers with one tap']))],
     [('Is the khata free?', 'Yes. Khata entries, reminders and customer links are free and unlimited on every plan.'),
      ('Can the customer see their khata?', 'Yes. Every message carries a private link where the customer sees all entries, the balance, and can confirm or dispute each entry.'),
      ('Can I delete a wrong entry?', 'An entry that has not been sent can be discarded. A sent entry stays on record; you reverse it with a correction entry that is also sent to the customer.'),
      ('Does it send payment reminders?', 'Yes. Send a reminder with the balance and your UPI ID on WhatsApp or SMS from the contact or from the Payment Reminders screen.'),
      ('Is it a Khatabook alternative?', 'Yes. It covers udhaar tracking and reminders, and adds customer confirmation, GST billing, stock and accounts in the same app.')],
     'khata book app, digital khata, udhaar app, Khatabook alternative, credit book app, payment reminder app, udhaar khata online',
     short='Khata book app', alt={'en-IN': '/khata-book-app/', 'hi-IN': '/hi/khata-book-app/', 'x-default': '/khata-book-app/'})

page('/inventory-management-software/', 'Inventory & Stock Management Software | SmartTrader',
     'Multi-godown stock, barcode billing, purchase orders, GRN, gate entry, stock count, reorder alerts and average cost. Cloud inventory for Indian traders.',
     'Inventory software for traders and distributors',
     'Har godown ka stock live. Purchase order se goods receipt, barcode se billing, reorder alert aur physical stock count, sab ek jagah, phone ya computer par.',
     [('Stock control without the spreadsheet', grid([
         ('Multi-godown stock', 'Stock per godown, transfers between godowns, adjustments, and moving-average cost valued in your books.'),
         ('Purchase to stock', 'Purchase order, gate entry, goods receipt (GRN) with partial deliveries, purchase bill and payment.'),
         ('Barcode labels & scanning', 'Print Code-128 labels, scan with a USB scanner or the phone camera to bill or count.'),
         ('Reorder alerts', 'Items below their reorder level are flagged, and one click makes a purchase order for all of them.'),
         ('Stock count', 'Type the counted quantity for each item; differences are adjusted in stock and accounts in one go.'),
         ('Racks, batches and serials', 'Bin / rack locations, batches with expiry picked first-expiry-first, and serial / IMEI numbers with warranty.')])),
      ('Sales side', ul(['Quotation, sales order, delivery note and invoice, with pending quantities tracked',
                         'Pending orders report: vehicles at the gate, orders not received or delivered, GRNs not billed',
                         'Stock can never go negative, and every movement has a document behind it'])),
      ('Know what is not selling', ul(['Stock ageing in 0-30, 31-60, 61-90 and 90+ day buckets (first in, first out)',
                                        'Dead and slow stock lists, and ABC by value', 'Stock value per godown that matches the balance sheet']))],
     [('Does it support multiple godowns?', 'Yes. Stock is kept per godown, with transfers between them and per-godown stock values.'),
      ('Can I scan barcodes?', 'Yes. Use a USB/Bluetooth scanner or the phone camera on the Quick Bill screen, and print barcode labels for items.'),
      ('Is there a GRN and gate entry?', 'Yes, in Advanced mode: log the vehicle at the gate, then make the GRN from the gate entry against the purchase order.'),
      ('How is stock valued?', 'At moving-average cost, posted to the inventory account, so the stock report always matches the balance sheet.')],
     'inventory management software, stock management software India, godown management software, barcode billing software, GRN software, distributor software',
     short='Inventory software')

page('/pricing/', 'Pricing: Free GST Billing, Khata & Inventory | SmartTrader',
     'Free plan with 50 invoices a month and unlimited khata. Starter ₹999, Growth ₹2,499 and Business ₹4,499 a year + GST. No hidden charges.',
     'Simple pricing, lower than the market',
     'Free se shuru karein. Jab business badhe tab upgrade karein. Saal ka plan, koi chhupa charge nahi.',
     [('Plans', pricing_html),
      ('Every plan includes', ul(['GST invoices with UPI QR and WhatsApp sharing', 'Unlimited khata with customer confirmation and reminders',
                                  'POS billing with barcode and camera scanning', 'Stock, purchase bills, returns, credit and debit notes',
                                  'Double-entry accounts: Profit & Loss, Balance Sheet, Trial Balance, GST summary', 'Install as an app on Android, iPhone and computer',
                                  'Your data is yours: download a full backup (file or Excel) any time']))],
     [('Is there really a free plan?', 'Yes. 50 invoices a month, 1 user, unlimited khata, POS and all reports, free forever.'),
      ('Are prices per month or per year?', 'Per year. Starter is Rs 999, Growth Rs 2,499 and Business Rs 4,499 a year, plus 18% GST.'),
      ('How do I upgrade?', 'Open Plan & Billing in the app and pay by UPI; the plan turns on as soon as the payment is confirmed.'),
      ('Is my data safe?', 'Data is stored on Cloudflare, every business is kept separate, passwords are hashed, and staff get role-based access with an audit trail.')],
     'billing software price, GST software price India, cheap billing software, ERP for small business price, khata app free',
     short='Pricing')

# ============================================================ by business
page('/kirana-store-billing-software/', 'Kirana Store Billing Software with Khata | SmartTrader',
     'Billing software for kirana and general stores: barcode POS, UPI QR on bills, udhaar khata with WhatsApp reminders, low-stock alerts. Works offline.',
     'Billing software for kirana and general stores',
     'Counter par bill jaldi, udhaar ka hisaab saaf, aur maal khatam hone se pehle alert. Kirana dukaan ki har roz ki zaroorat, ek hi app me, mobile ya computer par.',
     [('Built for a busy counter', grid([
         ('Scan and bill', 'Scan the barcode with a USB scanner or the phone camera; the item, rate and GST fill in. A carton code can count 12 pieces in one scan.'),
         ('Cash, UPI, card or udhaar', 'Take any payment. For UPI the bill shows a QR for the exact amount; udhaar goes straight to the customer’s khata.'),
         ('Udhaar khata customers trust', 'Every entry is sent to the customer on WhatsApp or SMS, and the customer confirms it on their own link.'),
         ('Reminders without awkward calls', 'One tap sends the balance and your UPI. The reminder list says who to remind today and who is a VIP customer.'),
         ('Low stock before it runs out', 'Set a reorder level per item; the Today card lists what is running low and makes one purchase order for all of it.'),
         ('No internet? Keep billing', 'Bills made offline wait in the Outbox and go to the cloud by themselves when the internet returns.')])),
      ('A day at the shop', steps(['Open the app: the Today card shows overdue customers, promises due today and low stock.',
                                   'Bill at the counter with the scanner; the customer pays by UPI from the QR.',
                                   'Note udhaar in the khata; the customer gets the entry on WhatsApp.',
                                   'In the evening, see the day’s sales, cash in hand and profit.'])),
      ('Reports a shop owner needs', ul(['Today’s sales, cash and UPI collected', 'Who owes how much, and since when',
                                         'Profit & Loss and stock value', 'GST summary to send to your CA']))],
     [('Can I use a barcode scanner?', 'Yes. Any USB or Bluetooth scanner works like a keyboard, and the phone camera can scan too. A code the app has not seen is taught once and works from then on.'),
      ('Does it work without internet?', 'Yes. Bills and receipts made offline are kept on the device and sent to the cloud automatically when you are back online.'),
      ('Is the khata part of the billing app?', 'Yes. Udhaar from a bill goes to the same customer’s khata, so billing and khata always match.'),
      ('Is it free for a small kirana shop?', 'The Free plan gives 50 GST invoices a month and unlimited khata. Unlimited bills start at Rs 999 a year.'),
      ('Can I print a receipt?', 'Yes. Print an 80 mm thermal receipt or an A4 bill, or send the bill on WhatsApp.')],
     'kirana store billing software, grocery billing software, general store billing app, kirana shop software, retail billing software with khata',
     group='industry', short='Kirana store billing')

page('/medical-store-billing-software/', 'Medical Store Billing Software: Batch & Expiry | SmartTrader',
     'Pharmacy billing with batch and expiry on every bill, first-expiry-first-out picking, expiry alerts, GST and supplier bill scanning. Free plan to start.',
     'Medical store billing software with batch and expiry',
     'Dawai ka batch aur expiry har bill par apne aap. Jo pehle expire hoga wahi pehle bikega, aur expire hone wale maal ka alert pehle se.',
     [('Batch and expiry, handled for you', grid([
         ('Batch on every bill', 'Each batch keeps its own expiry and stock. Selling picks the batch that expires first (FEFO), and you can choose another.'),
         ('Expiry alerts', 'The Today card shows expired stock and what expires in the next 30 days, with its value, so you can return or sell it in time.'),
         ('Expiry report', 'All batches by expiry date and godown, with quantities and value, ready to send back to the supplier.'),
         ('Returns put the batch back', 'A sales return or a cancelled bill restores the same batch and expiry, so stock stays right.'),
         ('Supplier bills in seconds', 'Scan a supplier bill photo or PDF on the phone; the items, quantities, rates and GST fill in for you to check.'),
         ('GST by item', 'Set 5%, 12% or 18% GST and the HSN per item; CGST + SGST or IGST is applied automatically.')])),
      ('Also in the app', ul(['Credit customers (clinics, regular patients) with khata and reminders',
                              'Barcode billing at the counter and UPI QR on every bill',
                              'Purchase orders, purchase returns and debit notes', 'Profit & Loss, stock value and GST summary'])),
      ('How a sale works', steps(['Scan or type the medicine.', 'The batch with the nearest expiry is picked; change it if needed.',
                                  'Take cash or UPI and print or WhatsApp the bill.']))],
     [('Does it track batch and expiry?', 'Yes. Every batch has its own expiry and stock, and bills, returns and stock reports all work by batch.'),
      ('Does it sell the earliest expiry first?', 'Yes. Billing picks the batch that expires first (FEFO) by default; you can pick a different batch on the line.'),
      ('Will it warn me before medicines expire?', 'Yes. The Today card and the expiry report list expired stock and stock expiring within 30 days, with its value.'),
      ('Can I enter supplier bills quickly?', 'Yes. Take a photo or open the PDF of the supplier bill; it is read on your phone and the purchase bill is filled in for you to check.'),
      ('Is there a free plan?', 'Yes. 50 invoices a month free; unlimited bills from Rs 999 a year.')],
     'medical store billing software, pharmacy billing software, chemist software with batch and expiry, medical shop software India, expiry tracking software',
     group='industry', short='Medical store billing')

page('/wholesale-distributor-software/', 'Wholesale Distributor Software & Collections | SmartTrader',
     'Software for wholesalers and distributors: sales orders to delivery and invoice, multi-godown stock, credit limits, field collections and e-way bill JSON.',
     'Software for wholesalers and distributors',
     'Order se delivery aur bill tak, godown ka stock, aur market me phansa paisa wapas laane ka poora system. Salesman ko utna hi dikhe jitna zaroori hai.',
     [('From order to money in the bank', grid([
         ('Orders that do not slip', 'Quotation → sales order → delivery note → invoice, with pending quantities tracked until everything is delivered and billed.'),
         ('Stock across godowns', 'Stock per godown, transfers, and one combined pick list for many orders walked rack by rack.'),
         ('Credit limits', 'Set a credit limit per customer; billing above it asks before saving.'),
         ('Collections on a schedule', 'Reminders go 3 days before the due date, on it, and 7, 15, 30 and 45 days late, gently for VIP customers.'),
         ('Who collected what', 'Field staff record cash they collect; the customer gets a receipt on WhatsApp, so collections cannot quietly go missing.'),
         ('E-way bill and e-invoice', 'Make the e-way bill and e-invoice JSON for the government portals from the invoice (Growth plan).')])),
      ('Control for the owner', ul(['Roles made to measure: a salesman can bill but not see cost, give more than a set discount or date bills back',
                                    'Purchase orders above a limit wait for your approval', 'Full audit trail of who changed what',
                                    'Monthly balance confirmations customers answer with one tap'])),
      ('When a buyer pays late', ul(['Late-payment report by age (0-30, 31-60, 61-90, 90+ days)',
                                     'A recovery file with the bills, reminders sent and promises, ready for a notice',
                                     'MSMED Act interest worked out for registered micro and small enterprises']))],
     [('Can salesmen use it with limited access?', 'Yes. Each role decides what a user may see and change, and limits like the biggest discount, no credit sales or no back-dated bills are enforced on the server.'),
      ('Does it handle sales orders and partial deliveries?', 'Yes. Orders track what is delivered and billed, and the pending orders report shows what is still open.'),
      ('Can I generate e-way bills?', 'It creates the e-way bill JSON for upload on the e-way bill portal and saves the e-way bill number on the invoice (Growth plan and above).'),
      ('How do collections from field staff work?', 'Staff record the cash collected against the customer; a receipt goes to the customer on WhatsApp and the owner sees who collected what.'),
      ('Can I export to Tally?', 'Yes. Export a Tally XML for any period; the trial balance matches.')],
     'distributor software, wholesale billing software, FMCG distributor software India, distribution management software, wholesale ERP',
     group='industry', short='Wholesale & distributors')

page('/mobile-shop-billing-software/', 'Mobile Shop Billing Software, IMEI Tracking | SmartTrader',
     'Billing for mobile and electronics shops: IMEI / serial number on every sale, warranty lookup, GST invoices with UPI QR, accessories by barcode.',
     'Mobile and electronics shop billing with IMEI tracking',
     'Har phone ka IMEI bill par. Kaunsa phone kisko kab bika, warranty kab tak hai, ek search me pata. Accessories barcode se, bill WhatsApp par.',
     [('Every serial number accounted for', grid([
         ('IMEI on purchase and sale', 'Scan IMEI or serial numbers when the stock comes in; billing asks for the serial, so the right handset goes out.'),
         ('Warranty lookup', 'Search an IMEI to see who bought it, on which bill and when, and until when the warranty runs.'),
         ('Returns and replacements', 'A return puts the same serial back in stock; the history of each serial is kept.'),
         ('Accessories by barcode', 'Covers, chargers and earphones are billed by scanning, with stock and reorder alerts.'),
         ('GST invoices', 'GST at the item’s rate with HSN, CGST + SGST or IGST, and a UPI QR on the bill.'),
         ('Receive by scan', 'Receive a supplier’s bill by scanning each box; anything not on the bill or more than billed is refused.')])),
      ('At the counter', steps(['Scan the handset’s IMEI.', 'Add accessories by barcode.', 'Take UPI from the QR on the bill and send the bill on WhatsApp.'])),
      ('Also useful', ul(['Khata for regular customers and dealers', 'Profit by item and stock value', 'Staff logins with roles']))],
     [('Can I track IMEI numbers?', 'Yes. Serial-tracked items take an IMEI or serial on purchase and on sale, and each serial’s history is kept.'),
      ('How do I find who bought a phone?', 'Search the IMEI in Serial / IMEI; it shows the bill, the customer, the date and the warranty end.'),
      ('Can I bill accessories with a barcode?', 'Yes. Scan with a USB scanner or the phone camera on the Quick Bill screen.'),
      ('Does a return update the stock?', 'Yes. Returning a handset puts the same serial back in stock.')],
     'mobile shop billing software, IMEI tracking software, electronics shop billing software, serial number tracking billing, mobile store software India',
     group='industry', short='Mobile & electronics shops')

page('/hardware-shop-billing-software/', 'Hardware Shop Billing Software: Stock by Rack | SmartTrader',
     'Billing and stock for hardware, sanitary and building material shops: racks and bins, quotations for contractors, credit khata, GST invoices.',
     'Billing and stock software for hardware shops',
     'Hazaron item, har ek ki jagah rack par. Contractor ko quotation, phir bill, aur udhaar ka hisaab, sab ek app me.',
     [('Find any item, bill it fast', grid([
         ('Racks and bins', 'Each item has its rack / bin; pick lists are sorted by rack, and labels can be printed for the bins.'),
         ('Quotation to bill', 'Give contractors a quotation, turn it into an order or a bill in one tap, and track what is still to deliver.'),
         ('Credit for contractors', 'Udhaar goes to the contractor’s khata with reminders and a monthly balance confirmation.'),
         ('Goods on the way', 'Book the supplier’s bill before the truck arrives; receive it by scan when it comes, and write off anything broken in transit.'),
         ('Units you sell in', 'Pieces, kg, metre, box or bag, with the HSN and GST rate set per item.'),
         ('Delivery notes', 'Send goods with a delivery note and bill it later; pending deliveries are tracked.')])),
      ('Stock that matches the shelf', ul(['Stock count: type what is on the shelf, differences are adjusted in one go',
                                           'Reorder alerts for fast-moving items', 'Stock ageing shows what has not moved for 90 days'])),
      ('Broken in transit?', ul(['Write off damaged pieces as a loss or as a claim on the transporter', 'Follow the claim until the money comes, with reminders',
                                 'GST on lost goods reversed correctly']))],
     [('Can I keep track of where items are kept?', 'Yes. Set a rack / bin per item; pick lists are sorted by rack and new bins can be made as goods come in.'),
      ('Can I make quotations?', 'Yes. Quotations convert to sales orders or invoices, and pending quantities are tracked.'),
      ('Can contractors buy on credit?', 'Yes. Credit sales go to the customer’s khata, with reminders and balance confirmations.'),
      ('What if goods arrive broken?', 'Write the broken pieces off as a loss or a claim on the transporter or insurer, and track the claim until it is paid.')],
     'hardware shop billing software, building material software, sanitary shop billing, hardware store inventory software, plumbing electrical shop software',
     group='industry', short='Hardware shops')

# ============================================================ features
page('/pos-billing-software/', 'POS Billing Software with Barcode & UPI QR | SmartTrader',
     'Fast POS billing on phone or computer: barcode or camera scanning, cash, UPI, card or credit, UPI QR for the exact amount, 80 mm receipts, offline mode.',
     'POS billing software for the counter',
     'Scan karo, bill tayyar. Cash, UPI, card ya udhaar, aur bill par UPI QR. Internet na ho to bhi bill bante rehte hain.',
     [('Made for speed', grid([
         ('Scan with anything', 'USB or Bluetooth scanner, or the phone camera. Codes not seen before are taught once.'),
         ('Every payment mode', 'Cash with change worked out, UPI, card / bank, or credit to the customer’s khata.'),
         ('UPI QR for the exact amount', 'The customer scans and pays the right amount with any UPI app.'),
         ('Receipt or WhatsApp', 'Print an 80 mm receipt, or send the bill as a link or PDF on WhatsApp.'),
         ('Keyboard friendly', 'Enter adds the scanned item; F9 completes the sale.'),
         ('Offline outbox', 'Without internet the sale is saved on the device and sent when you are online again.')])),
      ('Behind the counter', ul(['Stock goes down with every sale, per godown', 'Credit limit check for credit customers',
                                 'End-of-day sales, cash and UPI totals', 'Barcode labels for items without one'])),
      ('How it works', steps(['Scan the items or type a name.', 'Choose cash, UPI, card or credit.', 'Complete the sale and print or share the bill.']))],
     [('Does it work on a phone?', 'Yes. It runs in the browser on Android, iPhone and computers, and can be installed as an app.'),
      ('Can I use the phone camera as a scanner?', 'Yes, on phones whose browser supports barcode detection; a USB or Bluetooth scanner works everywhere.'),
      ('Can I sell on credit from the POS?', 'Yes. Choose Credit (udhaar); the amount goes to the customer’s khata.'),
      ('What happens if the internet goes off?', 'Sales are kept in the Outbox on the device and sent automatically when the connection returns.')],
     'POS billing software, barcode billing software, retail POS India, POS software for shop, billing machine software, POS with UPI QR',
     group='feature', short='POS billing')

page('/e-invoice-software/', 'E-Invoice & E-Way Bill JSON Software | SmartTrader',
     'Create e-invoice (IRN) and e-way bill JSON from your GST invoices in one tap, save the IRN and EWB number on the bill, and keep GST reports ready.',
     'E-invoice and e-way bill from your GST bills',
     'Bill banaya, e-invoice aur e-way bill ki JSON file ek tap me tayyar. Portal par upload kijiye aur IRN wapas bill par save kijiye.',
     [('From bill to portal', grid([
         ('E-invoice JSON', 'The invoice is turned into the e-invoice schema (seller, buyer, items, HSN, tax) for upload on the IRP.'),
         ('E-way bill JSON', 'Make the e-way bill JSON for the invoice, with vehicle and transport details, for the e-way bill portal.'),
         ('IRN and EWB on the bill', 'Save the IRN, acknowledgement and e-way bill number back on the invoice; they print on the bill.'),
         ('Supplier e-invoices at the gate', 'Scan the e-invoice QR on a supplier’s bill at the gate; the supplier and the bill are found by GSTIN and number.'),
         ('GST summary', 'Output tax, input credit and net payable by rate, B2B and B2C, for GSTR filing.'),
         ('Checks before you upload', 'GSTIN format, state codes and HSN on every line are checked while billing.')])),
      ('Good to know', ul(['E-invoice and e-way bill JSON are in the Growth and Business plans',
                           'Upload is done on the government portals; the app prepares the files', 'Tally export for your CA']))],
     [('Does it generate the IRN itself?', 'It prepares the e-invoice JSON in the official format; you upload it on the IRP and save the IRN on the bill. Direct generation through a GSP is not offered yet.'),
      ('Can it make e-way bills?', 'It makes the e-way bill JSON for upload on the e-way bill portal and stores the e-way bill number on the invoice.'),
      ('Which plan has e-invoice?', 'The Growth plan (Rs 2,499 a year) and the Business plan.'),
      ('Does it read e-invoice QR codes of suppliers?', 'Yes. At the gate or on the Receive screen, scanning the QR fills in the supplier, bill number, value and IRN.')],
     'e-invoice software, e-way bill software, e-invoice JSON generator, IRN generation software, GST e-invoicing for small business',
     group='feature', short='E-invoice & e-way bill')

page('/whatsapp-payment-reminder-app/', 'WhatsApp Payment Reminder App for Shops | SmartTrader',
     'Send payment reminders on WhatsApp with the amount due, bill link and UPI QR, on a smart schedule. Customers pick a pay date and pay by UPI from the link.',
     'Payment reminders on WhatsApp that get paid',
     'Udhaar maangna ab awkward nahi. Sahi din par, sahi bhasha me reminder, bill ka link aur UPI, sab ek message me.',
     [('Reminders that work', grid([
         ('Smart schedule', 'Who to remind today: 3 days before the due date, on it, then 7, 15, 30 and 45 days late. VIP customers get gentler words.'),
         ('Bill link with UPI', 'Every reminder carries a link to the customer’s bills with a Pay button and QR for the amount due.'),
         ('In their language', 'Messages in English, Hindi or Hinglish, chosen per customer.'),
         ('Pay date from the customer', 'On the link the customer picks when they will pay, or splits it into instalments; you see it on the Today card.'),
         ('Balance confirmation', 'Once a month, customers confirm their balance with one tap; a wrong bill shows up now, not months later.'),
         ('Weekly report', 'A short weekly summary: collected, promised and still overdue.')])),
      ('When reminders are not enough', ul(['A recovery file with every bill, reminder and promise, ready for a notice',
                                            'MSMED Act interest for registered micro and small enterprises',
                                            'Late-payment report by age'])),
      ('How it works', steps(['Open Payment Reminders: today’s list is ready.', 'Tap Send: WhatsApp opens with the message, link and UPI.',
                              'The customer pays from the link or picks a date.']))],
     [('Does it send WhatsApp messages from my number?', 'Yes. Reminders open in your own WhatsApp with the message ready; you tap send.'),
      ('What does the customer receive?', 'The amount due, a link to their bills with a UPI Pay button and QR, and your shop name.'),
      ('Can customers say when they will pay?', 'Yes. The link has “When will you pay?” where they pick a date or instalments, and you see it in the app.'),
      ('Is it free?', 'Reminders and customer links are free on every plan.')],
     'WhatsApp payment reminder, payment reminder app, udhaar reminder on WhatsApp, payment collection app India, outstanding reminder software',
     group='feature', short='WhatsApp payment reminders')

page('/accounting-software-for-small-business/', 'Accounting Software for Small Business India | SmartTrader',
     'Double-entry accounting that runs itself from your bills: P&L, Balance Sheet, Trial Balance, cash and bank, expenses, GST summary and Tally export.',
     'Accounting software that keeps itself',
     'Bill banao, payment lo, kharcha likho. Hisaab-kitaab apne aap double-entry me ban jata hai, aur P&L, Balance Sheet hamesha tayyar.',
     [('Books without a bookkeeper', grid([
         ('Every bill posts itself', 'Sales, purchases, returns, payments and expenses post the right journal entries automatically.'),
         ('Reports that tally', 'Profit & Loss, Balance Sheet and Trial Balance always balance; stock value matches the inventory.'),
         ('Cash and bank', 'Cash, bank and UPI accounts with a day book and ledgers for every account and party.'),
         ('Expenses and journals', 'Record shop expenses and adjustments; staff salaries and advances post on their own.'),
         ('GST summary', 'Output tax, input credit and net payable by rate, B2B and B2C.'),
         ('Tally export', 'Send your CA a Tally XML for any period; the trial balance matches.')])),
      ('Your data is safe', ul(['Download a full backup (file or Excel) any time', 'Automatic backups to your own Google Drive',
                                'Staff logins with roles and a full audit trail'])),
      ('Who uses it', ul(['Shops and traders who want books without hiring an accountant', 'Distributors who need party ledgers and ageing',
                          'CAs who receive clean Tally data']))],
     [('Is it real double-entry accounting?', 'Yes. Every document posts balanced debits and credits to a chart of accounts; reports come from the ledger.'),
      ('Can my CA use Tally?', 'Yes. Export a Tally XML for any period and import it into Tally Prime.'),
      ('Can I take my data out?', 'Yes. Download a full backup as a file or a readable Excel workbook any time.'),
      ('Does it handle GST input credit?', 'Yes. Input credit from purchase bills is tracked and set against output tax in the GST summary.')],
     'accounting software for small business, accounting software India, double entry accounting software, P&L balance sheet software, Tally alternative',
     group='feature', short='Accounting software')

page('/warehouse-management-software/', 'Warehouse Management Software: Racks & Picking | SmartTrader',
     'Simple warehouse software: receive by scan, racks and bins, guided put-away, pick lists by rack, wave picking, batches, serials and stock ageing.',
     'Warehouse management without the complexity',
     'Maal aaya to scan se receive, rack khud chuna jaye, aur dispatch ke liye rack ke hisaab se pick list. Godown aapki ungli par.',
     [('From the truck to the shelf', grid([
         ('Receive by scan', 'Scan each piece against the supplier’s bill or order; anything not on it, or more than billed, is refused.'),
         ('Racks chosen for you', 'Each item goes to its default bin, a bin that holds it already, or an empty one; new bins are made when needed.'),
         ('Guided put-away', 'A list of what is waiting and where it should go; scan the bin label and it is done.'),
         ('Pick by rack', 'Pick lists sorted by rack, and one combined wave pick list for many orders.'),
         ('Batches and serials', 'Batches with expiry picked first-expiry-first, and serial / IMEI numbers with warranty.'),
         ('Gate register', 'Log vehicles at the gate, read the e-invoice QR of the supplier’s bill, and receive against it.')])),
      ('Control', ul(['Stock count with differences adjusted in one go', 'Transfers between godowns', 'Stock ageing, dead and slow stock, ABC by value',
                      'Transit damage written off as a loss or a claim on the transporter'])),
      ('Who it is for', ul(['Distributors and wholesalers with one or more godowns', 'Shops with a back store', 'Small manufacturers (recipes and production runs)']))],
     [('Do I need special hardware?', 'No. A phone camera or any USB / Bluetooth scanner works; labels print on a normal or label printer.'),
      ('Can it make bins automatically?', 'Yes. When goods are received and no bin fits, a new bin is made next to the last one (A-01 → A-02).'),
      ('Does it support FEFO for batches?', 'Yes. Picking and billing take the batch that expires first.'),
      ('Is there a gate entry?', 'Yes. The gate register logs vehicles and can read the e-invoice QR of supplier bills.')],
     'warehouse management software, WMS for small business, godown management software, bin location software, pick list software India',
     group='feature', short='Warehouse management')

page('/purchase-management-software/', 'Purchase Order & Purchase Bill Software | SmartTrader',
     'Purchase orders with approval, gate entry, goods receipt by scan, bills in transit, supplier bill scanning, debit notes and payments due in one place.',
     'Purchase management from order to payment',
     'Order do, maal receive karo, bill milao aur payment yaad rakho. Supplier ka bill photo se bhar jata hai, aur kam ya toota maal turant pakda jata hai.',
     [('Buy right, pay right', grid([
         ('Purchase orders with approval', 'Orders above a limit made by staff wait for the owner’s approval.'),
         ('Bill first, goods later', 'Book the supplier’s bill while the goods are on the way; it is received against the bill when the truck comes.'),
         ('Scan a supplier bill', 'A photo or PDF of the supplier’s bill is read on your phone and fills the purchase bill for you to check.'),
         ('Shortage and damage', 'Close a shortage with a debit note, or write off transit damage as a loss or a claim on the transporter.'),
         ('No duplicate bills', 'The same supplier bill number cannot be entered twice.'),
         ('Payments due', 'The Today card lists supplier bills due within 7 days.')])),
      ('Also included', ul(['Gate entry and goods receipt (GRN) with partial deliveries', 'Purchase returns and rate-difference debit notes',
                            'Input GST credit in the GST summary'])),
      ('How it works', steps(['Raise a purchase order (approved if above your limit).', 'Receive the goods by scan at the gate or godown.',
                              'Match the supplier’s bill and pay it when due.']))],
     [('Can purchase orders need approval?', 'Yes. Set a limit; orders above it made by anyone but the owner or an admin wait for approval.'),
      ('Can I enter a bill before the goods arrive?', 'Yes. Mark it as goods on the way; stock comes in only when the goods are received.'),
      ('How does supplier bill scanning work?', 'The photo or PDF is read on your own phone (nothing is uploaded) and the lines are matched to your items for you to check.'),
      ('What if fewer goods arrive?', 'Close the shortage on the bill; a debit note is made for what never came.')],
     'purchase order software, purchase management software, GRN software, purchase bill entry software, procurement software for small business',
     group='feature', short='Purchase management')

# ============================================================ Hindi
page('/hi/gst-billing-software/', 'जीएसटी बिलिंग सॉफ्टवेयर: फ़्री GST बिल ऐप | SmartTrader',
     'सेकंडों में GST बिल बनाएं: CGST/SGST/IGST अपने आप, HSN, बिल पर UPI QR, WhatsApp पर बिल, e-invoice और e-way bill JSON। छोटे कारोबार के लिए फ़्री प्लान।',
     'छोटे कारोबार के लिए जीएसटी बिलिंग सॉफ्टवेयर',
     '10 सेकंड में बिल बनाइए। CGST, SGST या IGST अपने आप लगता है, बिल पर UPI QR छपता है, और ग्राहक को WhatsApp पर लिंक जाता है जहाँ वह बिल देखकर भुगतान कर सकता है।',
     [('GST बिल की हर ज़रूरत', grid([
         ('हर बार सही GST', 'GSTIN या राज्य से तय होता है कि CGST + SGST लगेगा या IGST। HSN कोड, सभी GST दरें और रुपये तक राउंड-ऑफ़।'),
         ('बिल पर UPI QR', 'हर बिल पर बकाया रकम का UPI QR, ताकि ग्राहक GPay, PhonePe या Paytm से तुरंत भुगतान करे।'),
         ('WhatsApp पर बिल', 'बिल का लिंक या PDF सीधे WhatsApp पर भेजें। ग्राहक बिल देख, डाउनलोड और भुगतान कर सकता है।'),
         ('क्विक बिल / POS', 'बारकोड स्कैनर या फ़ोन कैमरा से स्कैन करें, नकद, UPI या कार्ड लें और 80 mm रसीद छापें।'),
         ('रिटर्न और क्रेडिट नोट', 'सेल्स रिटर्न, परचेज़ रिटर्न और रेट-अंतर के क्रेडिट/डेबिट नोट, जो मूल बिल से जुड़ जाते हैं।'),
         ('e-invoice और e-way bill', 'सरकारी फ़ॉर्मेट में e-invoice और e-way bill की JSON फ़ाइल बनाएं और IRN बिल पर सेव करें।')])),
      ('आपके CA के लिए GST रिपोर्ट', ul(['दर के हिसाब से GST सारांश, B2B / B2C, आउटपुट टैक्स, इनपुट क्रेडिट और कुल देय',
                                       'सेल्स और परचेज़ रजिस्टर, CSV में', 'Tally XML एक्सपोर्ट, मिलती हुई ट्रायल बैलेंस के साथ',
                                       'असली डबल-एंट्री से लाभ-हानि (P&L), बैलेंस शीट और ट्रायल बैलेंस'])),
      ('भाषा आपकी', ul(['ग्राहकों को संदेश हिंदी, अंग्रेज़ी या हिंग्लिश में', 'बिल पर आपका लोगो, UPI ID, बैंक विवरण और शर्तें',
                         'मोबाइल, टैबलेट और कंप्यूटर पर, ऐप की तरह इंस्टॉल करें']))],
     [('क्या SmartTrader का GST बिलिंग सॉफ्टवेयर फ़्री है?', 'हाँ। फ़्री प्लान में हर महीने 50 GST बिल, अनलिमिटेड खाता, POS बिलिंग और सारी रिपोर्ट मिलती हैं। पेड प्लान ₹999 प्रति वर्ष से।'),
      ('क्या CGST, SGST और IGST अपने आप लगते हैं?', 'हाँ। आपके और ग्राहक के राज्य (GSTIN या राज्य के नाम से) की तुलना करके हर लाइन पर सही टैक्स लगता है।'),
      ('क्या GST बिल WhatsApp पर भेज सकते हैं?', 'हाँ। हर बिल पर WhatsApp बटन है, जो रकम, प्रीव्यू और भुगतान वाले पेज का लिंक भेजता है।'),
      ('क्या e-invoice और e-way bill बनते हैं?', 'यह पोर्टल पर अपलोड के लिए सरकारी फ़ॉर्मेट में JSON फ़ाइल बनाता है और IRN व e-way bill नंबर बिल पर सेव करता है।'),
      ('क्या मेरा CA Tally में डेटा ले सकता है?', 'हाँ। किसी भी अवधि का Tally XML एक्सपोर्ट करें और Tally Prime में इम्पोर्ट करें।')],
     'जीएसटी बिलिंग सॉफ्टवेयर, GST बिल बनाने वाला ऐप, फ़्री बिलिंग सॉफ्टवेयर, हिंदी बिलिंग सॉफ्टवेयर, दुकान के लिए बिलिंग ऐप',
     group='hi', short='GST बिलिंग (हिंदी)', lang='hi-IN', alt={'en-IN': '/gst-billing-software/', 'hi-IN': '/hi/gst-billing-software/', 'x-default': '/gst-billing-software/'})

page('/hi/khata-book-app/', 'डिजिटल खाता बुक ऐप: उधार का हिसाब | SmartTrader',
     'फ़्री डिजिटल खाता बुक: हर एंट्री ग्राहक को WhatsApp/SMS पर जाती है, ग्राहक ऑनलाइन पुष्टि करता है और UPI से भुगतान करता है। रिमाइंडर भी शामिल।',
     'डिजिटल खाता बुक, जिस पर ग्राहक भी भरोसा करें',
     'उधार का हिसाब अब साफ़। हर एंट्री ग्राहक को WhatsApp या SMS पर जाती है, ग्राहक लिंक खोलकर अपना पूरा खाता देखता है, एंट्री की पुष्टि करता है और UPI से भुगतान करता है।',
     [('दुकानदार SmartTrader खाता क्यों चुनते हैं', grid([
         ('भेजने पर ही एंट्री गिनी जाती है', 'नई एंट्री तभी सेव होती है जब वह ग्राहक को भेजी जाए, ताकि कोई न कह सके "यह एंट्री कब लिखी?"'),
         ('ग्राहक हर एंट्री की पुष्टि करता है', 'ग्राहक अपने निजी लिंक पर हर एंट्री और बकाया देखता है और हाँ या ना दबाता है। विवाद तुरंत दिखता है।'),
         ('चुपचाप बदलाव नहीं', 'भेजी गई एंट्री मिटाई नहीं जा सकती। गलती उल्टी एंट्री से सुधरती है, जो ग्राहक को भी जाती है।'),
         ('WhatsApp और SMS रिमाइंडर', 'एक टैप में बकाया और आपकी UPI के साथ रिमाइंडर। रिमाइंडर स्क्रीन पर पूरी सूची कि किससे कितना लेना है।'),
         ('लिंक से UPI भुगतान', 'ग्राहक को Pay बटन, QR और आपकी UPI ID मिलती है, वसूली जल्दी होती है।'),
         ('खाता + बिलिंग + स्टॉक', 'सादे खाता ऐप से अलग, इसी अकाउंट में GST बिल, स्टॉक और पूरा हिसाब-किताब भी है।')])),
      ('कैसे काम करता है', steps(['<b>आपने दिए</b> या <b>आपको मिले</b> दबाएं और रकम लिखें।', 'WhatsApp या SMS पर भेजें, एंट्री सेव हो जाती है।',
                                 'ग्राहक लिंक खोलकर एंट्री की पुष्टि करता है और UPI से भुगतान करता है।'])),
      ('वादे जो निभाए जाते हैं', ul(['ग्राहक अपने लिंक पर भुगतान की तारीख चुनता है (“कब तक देंगे?”) या किस्तों में देता है',
                                    'Today कार्ड बताता है किसका वादा आज है', 'हर महीने बकाया की पुष्टि, ग्राहक एक टैप में जवाब देता है']))],
     [('क्या खाता फ़्री है?', 'हाँ। खाता एंट्री, रिमाइंडर और ग्राहक लिंक हर प्लान में फ़्री और अनलिमिटेड हैं।'),
      ('क्या ग्राहक अपना खाता देख सकता है?', 'हाँ। हर संदेश में एक निजी लिंक होता है जहाँ ग्राहक सारी एंट्री और बकाया देखता है और हर एंट्री की पुष्टि कर सकता है।'),
      ('गलत एंट्री कैसे हटाएं?', 'जो एंट्री भेजी नहीं गई, उसे हटा सकते हैं। भेजी गई एंट्री रिकॉर्ड में रहती है; उसे सुधार एंट्री से उलटा जाता है।'),
      ('क्या यह पेमेंट रिमाइंडर भेजता है?', 'हाँ। ग्राहक या रिमाइंडर स्क्रीन से WhatsApp या SMS पर बकाया और UPI के साथ रिमाइंडर भेजें।')],
     'खाता बुक ऐप, डिजिटल खाता, उधार का हिसाब ऐप, उधार खाता ऑनलाइन, पेमेंट रिमाइंडर ऐप',
     group='hi', short='खाता बुक (हिंदी)', lang='hi-IN', alt={'en-IN': '/khata-book-app/', 'hi-IN': '/hi/khata-book-app/', 'x-default': '/khata-book-app/'})

for p in PAGES:
    render(p)

# ============================================================ the home page's landing part (public/index.html)
HOME_FAQ = [
    ('What is SmartTrader ERP?', 'A cloud app for Indian shops, traders and distributors that does GST billing, POS, khata, stock, purchase and double-entry accounts in one place, on mobile and computer.'),
    ('Is it really free?', 'Yes. The Free plan gives 50 GST invoices a month, 1 user, unlimited khata, POS and all reports, with no card needed. Paid plans start at Rs 999 a year.'),
    ('Does it work in Hindi?', 'Messages to customers go in English, Hindi or Hinglish, and the help pages are in Hindi too.'),
    ('Does it work without internet?', 'Yes. Bills, receipts and expenses made offline are kept on the device and sent to the cloud when you are back online.'),
    ('Is my data safe?', 'Each business is kept separate, passwords are hashed, staff get role-based access with an audit trail, and you can download a full backup or back up to your own Google Drive.'),
    ('Can I move my data to Tally?', 'Yes. Export a Tally XML for any period; the trial balance matches.')]
cards = lambda group: links([(p['path'], html.escape(p['short']), html.escape(p['desc'][:105].rsplit(' ', 1)[0] + '…')) for p in PAGES if p['group'] == group])
landing = f'''<div class="landing">
{topbar('/', 'en-IN')}
<main>
<section class="hero"><h1>Free GST billing, khata and stock software for Indian businesses</h1>
<p class="lead">SmartTrader ERP: GST bills with UPI QR, a digital khata your customers confirm, stock across godowns, purchase and full accounts. Mobile ya computer, ek hi app me; bills and reminders reach your customers in English, Hindi or Hinglish.</p>
<p><a class="btn primary big" href="/#signup">Start free, no card needed</a> <a class="btn big" href="/#login">Sign in</a></p>
{ul(['Free plan forever: 50 bills a month, unlimited khata', 'Works on Android, iPhone and computer, even offline', 'Bills and reminders on WhatsApp with UPI', 'Bring your items and customers from Excel, Vyapar, myBillBook or Tally in one go', 'Your data is yours: full backup any time'])}
</section>
<section><h2>Everything your business runs on</h2>{cards('core')}{cards('feature')}</section>
<section><h2>Made for your kind of business</h2>{cards('industry')}</section>
<section><h2>Start in three steps</h2>{steps(['Create a free account with your business name and state.', 'Add items (or scan them) and your customers.', 'Make your first GST bill and send it on WhatsApp.'])}</section>
<section><h2>Pricing</h2>{pricing_html}</section>
<section><h2>Frequently asked questions</h2>{''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in HOME_FAQ)}</section>
<section><h2>हिंदी में पढ़ें</h2>{cards('hi')}</section>
<section class="cta"><h2>Shuru karein aaj hi</h2><p>Free plan me 50 invoices har mahine aur unlimited khata. Card ki zaroorat nahi.</p><a class="btn primary big" href="/#signup">Create your free account</a></section>
</main>
{footer('/', 'en-IN')}
</div>'''
home_ld = [APP_LD, ORG_LD, {"@context": "https://schema.org", "@type": "WebSite", "name": "SmartTrader ERP", "url": SITE + "/", "inLanguage": "en-IN",
                            "publisher": {"@type": "Organization", "name": "DocBrisk"}},
           {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in HOME_FAQ]}]
idx_path = os.path.join(OUT, 'index.html')
idx = open(idx_path).read()
idx = re.sub(r'<!-- landing:start -->[\s\S]*?<!-- landing:end -->', lambda m: '<!-- landing:start -->\n' + landing + '\n<!-- landing:end -->', idx)
idx = re.sub(r'<!-- ld:start -->[\s\S]*?<!-- ld:end -->', lambda m: '<!-- ld:start -->' + ''.join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in home_ld) + '<!-- ld:end -->', idx)
open(idx_path, 'w').write(idx)

# ============================================================ the privacy policy (Meta asks for it before the WhatsApp app goes live)
PRIVACY_DATE = '27 October 2026'
def privacy():
    path, title = '/privacy/', 'Privacy Policy | SmartTrader ERP'
    desc = 'What SmartTrader ERP keeps, why, for how long, and how to get it or have it deleted. Includes the WhatsApp bot and reminders.'
    secs = [
        ('who', 'Who we are', '<p>SmartTrader ERP (erp.docbrisk.com) is run by DocBrisk, India. Questions, data requests and complaints: <a href="https://wa.me/919068446139" rel="noopener">WhatsApp support, +91 90684 46139</a>.</p>'),
        ('business', 'What a business keeps in SmartTrader', '<p>A business enters its own records: its profile, customers and suppliers (names, phone numbers, GSTIN, addresses), items and stock, bills, payments, khata, staff and attendance. The business owns these records and decides what goes in; we keep and process them only to run SmartTrader for that business. Each business is kept separate, and its people see only what their role allows. Changes are kept in an audit trail.</p>'),
        ('account', 'Your account', '<ul><li>Name, e-mail and the business you sign up for.</li><li>Your password is stored only as a salted hash; nobody, including us, can read it.</li><li>One cookie keeps you signed in. There are no advertising or tracking cookies, and no third-party analytics scripts.</li><li>Sign-up and password e-mails are sent through an e-mail delivery service.</li></ul>'),
        ('whatsapp', 'WhatsApp bot and reminders', '<p>SmartTrader has its own WhatsApp Business number on Meta\'s official WhatsApp Business Platform (Cloud API). Only shops that turn these on use them.</p><ul><li><b>Reminders</b>: a shop\'s customers who have a payment due get a reminder with the amount and a link to their bills, sent to the mobile number the shop saved.</li><li><b>When you write to our number</b>, we receive your WhatsApp number, your message and its time. The bot answers from the shop\'s records: bills, amounts due and payment links are sent only to the mobile number that the shop saved for that customer (Indian +91 numbers). A message the bot cannot answer is shown to that shop so it can reply.</li><li>Messages to and from our number are kept for up to <b>6 months</b>, visible only to the shop they are about, and then deleted.</li><li>Reply <b>STOP</b> to stop automatic reminders from a shop, and <b>START</b> to turn them on again.</li><li>Messages travel through WhatsApp, which Meta runs under its own terms and privacy policy.</li></ul>'),
        ('links', 'Bill and khata links', '<p>A bill or khata link that a shop sends opens for anyone who has the link, so it can be opened without an account. The shop can turn a link off at any time.</p>'),
        ('scan', 'Scanning a supplier\'s bill', '<p>A bill photo or PDF is read on your own phone or computer. The picture is not uploaded to us.</p>'),
        ('drive', 'Google Drive backup (optional)', '<p>If the owner connects Google Drive, a backup file and a readable Excel copy go to a SmartTrader folder in their own Drive. The app asks only for access to the files it makes itself (<code>drive.file</code>), and reads the account\'s e-mail from Drive to show which account is connected. The access is kept encrypted and can be disconnected at any time in Settings.</p>'),
        ('pay', 'Paying for a plan', '<p>Plans are paid through a payment provider (Razorpay) or UPI. We receive the payment status and amount, never your card or bank login.</p>'),
        ('where', 'Where it is kept and who else processes it', '<p>Data is stored with Cloudflare, our hosting provider, and is sent only over encrypted connections (HTTPS). Other services process data only for the parts above: Meta (WhatsApp messages), Google (Drive backup, if connected), the payment provider and the e-mail delivery service. We do not sell data, show ads or share it for advertising.</p>'),
        ('delete', 'Getting your data, and deleting it', '<ul><li>The owner can download a full backup at any time (Settings → Backup), as a file or a readable Excel sheet.</li><li>To close a business and delete its data, the owner writes to WhatsApp support from the business\'s registered mobile or e-mail. We delete it within 30 days, except records the law requires us to keep (such as our own GST invoices for plans).</li><li>A shop\'s customer who wants a record changed or deleted should ask the shop, which controls its records. For messages to our WhatsApp number, write to WhatsApp support.</li></ul>'),
        ('other', 'Children and changes', '<p>SmartTrader is for businesses and is not meant for anyone under 18. If this policy changes, the date below changes; a big change is also shown in the app.</p>'),
    ]
    body = ''.join(f'<section id="{i}"><h2>{html.escape(t)}</h2>{c}</section>' for i, t, c in secs)
    ld = {"@context": "https://schema.org", "@type": "WebPage", "name": title, "url": SITE + path, "description": desc, "inLanguage": "en-IN", "dateModified": TODAY,
          "isPartOf": {"@type": "WebSite", "name": "SmartTrader ERP", "url": SITE + "/"}}
    doc = f'''<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{SITE}{path}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#0f766e">
<meta property="og:type" content="website"><meta property="og:site_name" content="SmartTrader ERP">
<meta property="og:title" content="{title}"><meta property="og:description" content="{html.escape(desc)}">
<meta property="og:url" content="{SITE}{path}"><meta property="og:image" content="{SITE}/og-invoice.png">
<link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/site.css">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
</head>
<body>
{topbar(path, 'en-IN')}
<main>
<section class="hero"><h1>Privacy Policy</h1><p class="lead">Saar: aapka data aapka hai. Hum use sirf SmartTrader chalane ke liye rakhte hain, bechte nahi, ads nahi dikhate, aur aap jab chahein backup le sakte hain ya delete karwa sakte hain.</p>
<p class="small">Last updated: {PRIVACY_DATE}</p></section>
{body}
</main>
{footer(path, 'en-IN')}
</body>
</html>
'''
    os.makedirs(OUT + path, exist_ok=True)
    open(OUT + path + 'index.html', 'w').write(doc)
privacy()

# ============================================================ 404 and sitemaps
nf = f'''<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found | SmartTrader ERP</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/site.css">
</head>
<body>
{topbar('', 'en-IN')}
<main>
<section class="hero"><h1>This page does not exist</h1><p class="lead">The link may be old or mistyped. Yeh page nahi mila.</p>
<p><a class="btn primary big" href="/">Go to the home page</a> <a class="btn big" href="/#login">Sign in</a></p></section>
<section><h2>Popular pages</h2>{cards('core')}</section>
</main>
{footer('', 'en-IN')}
</body>
</html>
'''
open(os.path.join(OUT, '404.html'), 'w').write(nf)
urls = [('/', '1.0')] + [(p['path'], '0.9' if p['group'] in ('core', 'industry') else '0.8') for p in PAGES] + [('/privacy/', '0.3')]
sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
for u, pr in urls:
    p = next((x for x in PAGES if x['path'] == u), None)
    alts = ''.join(f'<xhtml:link rel="alternate" hreflang="{l}" href="{SITE}{h}"/>' for l, h in (p['alt'].items() if p else []))
    sm += f'  <url><loc>{SITE}{u}</loc><lastmod>{TODAY}</lastmod>{alts}<priority>{pr}</priority></url>\n'
sm += '</urlset>\n'
for name in ('sitemap.xml', 'sitemap-erp.xml'):
    open(os.path.join(OUT, name), 'w').write(sm)
print('ok', len(PAGES), 'pages')
