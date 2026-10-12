# Generates the public SEO pages in public/ (run: python3 tools/gen-seo-pages.py). Edit the text here, not the HTML.
import json, os, html
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
SITE = 'https://erp.docbrisk.com'
TODAY = '2026-10-12'
NAV = [('/gst-billing-software/', 'GST Billing'), ('/khata-book-app/', 'Khata Book'), ('/inventory-management-software/', 'Inventory'), ('/pricing/', 'Pricing')]
PRICES = [('Free', '₹0', 'forever', ['50 invoices / month', '1 user, 1 godown', 'Unlimited khata entries', 'POS & barcode billing', 'GST reports, P&L, Balance Sheet']),
          ('Starter', '₹999', '/year + GST', ['Unlimited invoices', '2 users, 1 godown', 'Everything in Free', 'Tally export']),
          ('Growth', '₹2,499', '/year + GST', ['Unlimited invoices', '5 users, 3 godowns', 'E-invoice & e-way bill JSON', 'Orders, GRN, gate entry']),
          ('Business', '₹4,499', '/year + GST', ['Unlimited invoices', '15 users, unlimited godowns', 'Everything in Growth', 'Priority support'])]

def page(path, title, desc, h1, lead, sections, faqs, keywords):
    url = SITE + path
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}
    app_ld = {"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "SmartTrader ERP", "url": SITE + "/",
              "applicationCategory": "BusinessApplication", "operatingSystem": "Web, Android, iOS, Windows",
              "description": desc, "inLanguage": ["en-IN", "hi-IN"],
              "offers": {"@type": "AggregateOffer", "priceCurrency": "INR", "lowPrice": "0", "highPrice": "4499", "offerCount": "4"},
              "publisher": {"@type": "Organization", "name": "DocBrisk", "url": "https://docbrisk.com"}}
    crumbs = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "SmartTrader ERP", "item": SITE + "/"},
        {"@type": "ListItem", "position": 2, "name": h1, "item": url}]}
    nav = ''.join(f'<a href="{h}"{" class=on" if h == path else ""}>{t}</a>' for h, t in NAV)
    body = ''.join(f'<section><h2>{html.escape(t)}</h2>{c}</section>' for t, c in sections)
    faq = ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in faqs)
    doc = f'''<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="keywords" content="{html.escape(keywords)}">
<link rel="canonical" href="{url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0f766e">
<meta property="og:type" content="website"><meta property="og:site_name" content="SmartTrader ERP">
<meta property="og:title" content="{html.escape(title)}"><meta property="og:description" content="{html.escape(desc)}">
<meta property="og:url" content="{url}"><meta property="og:image" content="{SITE}/og-invoice.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="/site.css">
<script type="application/ld+json">{json.dumps(app_ld, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(faq_ld, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(crumbs, ensure_ascii=False)}</script>
</head>
<body>
<header class="top"><a class="logo" href="/"><img src="/icons/icon-192.png" alt="" width="32" height="32">SmartTrader ERP</a><nav>{nav}</nav>
<a class="btn" href="/#login">Login</a><a class="btn primary" href="/#signup">Start free</a></header>
<main>
<section class="hero"><h1>{html.escape(h1)}</h1><p class="lead">{lead}</p>
<p><a class="btn primary big" href="/#signup">Start free, no card needed</a> <a class="btn big" href="/pricing/">See pricing</a></p>
<p class="small">Works on mobile, tablet and computer · Install as an app · Made for Indian businesses</p></section>
{body}
<section><h2>Frequently asked questions</h2>{faq}</section>
<section class="cta"><h2>Shuru karein aaj hi</h2><p>Free plan me 50 invoices har mahine aur unlimited khata. Card ki zaroorat nahi.</p><a class="btn primary big" href="/#signup">Create your free account</a></section>
</main>
<footer><nav>{nav}<a href="https://docbrisk.com/">DocBrisk</a></nav><p>© 2026 SmartTrader ERP by DocBrisk. GST billing, inventory, accounts and khata for Indian businesses.</p></footer>
</body>
</html>
'''
    d = OUT + path
    os.makedirs(d, exist_ok=True)
    open(d + 'index.html', 'w').write(doc)

def ul(items): return '<ul class="ticks">' + ''.join(f'<li>{i}</li>' for i in items) + '</ul>'
def grid(cards): return '<div class="cards">' + ''.join(f'<div class="card"><h3>{t}</h3><p>{d}</p></div>' for t, d in cards) + '</div>'
pricing_html = '<div class="cards prices">' + ''.join(
    f'<div class="card{" pop" if n == "Growth" else ""}"><h3>{n}</h3><div class="price">{p}<span> {per}</span></div>{ul(f)}<a class="btn primary" href="/#signup">Start free</a></div>'
    for n, p, per, f in PRICES) + '</div>'

page('/gst-billing-software/', 'Free GST Billing Software for Small Business in India | SmartTrader ERP',
     'Make GST invoices in seconds: CGST/SGST/IGST auto, HSN, UPI QR on bill, WhatsApp share, e-invoice & e-way bill JSON, GSTR summary. Free plan for small shops.',
     'GST billing software for small businesses',
     'Bill banaiye 10 second me. CGST, SGST ya IGST apne aap lagta hai, bill par UPI QR chhapta hai, aur customer ko WhatsApp par link jata hai jahan wo bill dekh kar pay kar sakta hai.',
     [('Everything a GST bill needs', grid([
         ('Correct GST, every time', 'Intra-state CGST + SGST or inter-state IGST is picked from the GSTIN / state. HSN codes, all GST slabs, round-off to the rupee.'),
         ('Bill with UPI QR', 'Every invoice prints a UPI QR for the exact amount due, so customers pay on the spot with GPay, PhonePe or Paytm.'),
         ('Share on WhatsApp', 'Send the bill as a link with a preview card. The customer can view it, download the PDF and pay.'),
         ('Quick bill / POS', 'Scan barcodes with a scanner or the phone camera, take cash, UPI or card, and print an 80 mm receipt.'),
         ('Returns & credit notes', 'Sales returns, purchase returns and rate-difference credit/debit notes that settle the original bill.'),
         ('E-invoice & e-way bill', 'Download e-invoice (IRN) and e-way bill JSON in the government format and save the IRN back on the bill.')])),
      ('GST reports for your CA', ul(['GST summary by rate, B2B / B2C, output tax, input credit and net payable',
                                       'Sales and purchase registers, exportable to CSV', 'Tally XML export with a matching trial balance',
                                       'Profit & Loss, Balance Sheet and Trial Balance from real double-entry accounts']))],
     [('Is SmartTrader GST billing software free?', 'Yes. The Free plan includes 50 GST invoices a month, unlimited khata entries, POS billing and all reports. Paid plans start at Rs 999 a year.'),
      ('Does it calculate CGST, SGST and IGST automatically?', 'Yes. It compares the state of your business and your customer (from the GSTIN or state name) and applies CGST + SGST or IGST on every line.'),
      ('Can I send GST bills on WhatsApp?', 'Yes. Each bill has a WhatsApp button that sends a link with the amount, a preview card and a page where the customer can download the PDF and pay by UPI.'),
      ('Does it support e-invoice and e-way bill?', 'It creates the e-invoice and e-way bill JSON files in the government format for upload on the portals, and stores the IRN and e-way bill number on the invoice.'),
      ('Can my accountant use the data in Tally?', 'Yes. Export a Tally XML file for any period and import it into Tally Prime; the trial balance matches.')],
     'GST billing software, free GST billing software, GST invoice software India, billing software for small business, bill banane wala app, GST bill app')

page('/khata-book-app/', 'Digital Khata Book App with WhatsApp Reminders & UPI | SmartTrader ERP',
     'Free digital khata (udhaar) book: record you gave / you got, send every entry to the customer on WhatsApp/SMS, customer confirms online, payment reminders with UPI pay link.',
     'Digital khata book that customers trust',
     'Udhaar ka hisaab ab saaf. Har entry customer ko WhatsApp ya SMS par jaati hai, customer link khol kar apna poora khata dekhta hai, entry confirm karta hai aur UPI se pay karta hai.',
     [('Why shops switch to SmartTrader Khata', grid([
         ('Entry counts only after it is sent', 'A new entry is saved only when you send it to the customer, so nobody can say "yeh entry kab likhi?"'),
         ('Customer confirms each entry', 'The customer opens a private link, sees every entry and the balance, and taps Yes or No. Disputes show up for you at once.'),
         ('No silent edits', 'Sent entries cannot be deleted. A mistake is corrected with a reverse entry that the customer also receives.'),
         ('WhatsApp & SMS reminders', 'One tap sends a reminder with the balance and your UPI. The Payment Reminders screen lists everyone who owes you.'),
         ('Pay by UPI from the link', 'The customer gets a Pay button, a QR and your UPI ID, so collection is faster.'),
         ('Khata + billing + stock', 'Unlike a plain khata app, the same account also does GST bills, stock and full accounts when you need them.')])),
      ('How it works', '<ol class="steps"><li>Tap <b>You gave</b> or <b>You got</b> and enter the amount.</li><li>Send it on WhatsApp or SMS. The entry is saved.</li><li>The customer opens the link, confirms the entry and pays by UPI.</li></ol>')],
     [('Is the khata free?', 'Yes. Khata entries, reminders and customer links are free and unlimited on every plan.'),
      ('Can the customer see their khata?', 'Yes. Every message carries a private link where the customer sees all entries, the balance, and can confirm or dispute each entry.'),
      ('Can I delete a wrong entry?', 'An entry that has not been sent can be discarded. A sent entry stays on record; you reverse it with a correction entry that is also sent to the customer.'),
      ('Does it send payment reminders?', 'Yes. Send a reminder with the balance and your UPI ID on WhatsApp or SMS from the contact or from the Payment Reminders screen.'),
      ('Is it a Khatabook alternative?', 'Yes. It covers udhaar tracking and reminders, and adds customer confirmation, GST billing, stock and accounts in the same app.')],
     'khata book app, digital khata, udhaar app, Khatabook alternative, credit book app, payment reminder app, udhaar khata online')

page('/inventory-management-software/', 'Inventory & Stock Management Software for Traders | SmartTrader ERP',
     'Multi-godown stock, barcode billing, purchase orders, GRN, gate entry, stock count, reorder alerts and average cost. Cloud inventory software for Indian traders and distributors.',
     'Inventory software for traders and distributors',
     'Har godown ka stock live. Purchase order se goods receipt, barcode se billing, reorder alert aur physical stock count, sab ek jagah, phone ya computer par.',
     [('Stock control without the spreadsheet', grid([
         ('Multi-godown stock', 'Stock per godown, transfers between godowns, adjustments, and moving-average cost valued in your books.'),
         ('Purchase to stock', 'Purchase order, gate entry, goods receipt (GRN) with partial deliveries, purchase bill and payment.'),
         ('Barcode labels & scanning', 'Print Code-128 labels, scan with a USB scanner or the phone camera to bill or count.'),
         ('Reorder alerts', 'Items below their reorder level are flagged, and one click makes a purchase order for all of them.'),
         ('Stock count', 'Type the counted quantity for each item; differences are adjusted in stock and accounts in one go.'),
         ('Pick lists by rack', 'Bin / rack locations per item and printable pick lists sorted by rack for faster dispatch.')])),
      ('Sales side', ul(['Quotation, sales order, delivery note and invoice, with pending quantities tracked',
                         'Pending orders report: vehicles at the gate, orders not received or delivered, GRNs not billed',
                         'Stock can never go negative, and every movement has a document behind it']))],
     [('Does it support multiple godowns?', 'Yes. Stock is kept per godown, with transfers between them and per-godown stock values.'),
      ('Can I scan barcodes?', 'Yes. Use a USB/Bluetooth scanner or the phone camera on the Quick Bill screen, and print barcode labels for items.'),
      ('Is there a GRN and gate entry?', 'Yes, in Advanced mode: log the vehicle at the gate, then make the GRN from the gate entry against the purchase order.'),
      ('How is stock valued?', 'At moving-average cost, posted to the inventory account, so the stock report always matches the balance sheet.')],
     'inventory management software, stock management software India, godown management software, barcode billing software, GRN software, distributor software')

page('/pricing/', 'Pricing: Free GST Billing, Khata & Inventory | SmartTrader ERP',
     'Free plan with 50 invoices/month and unlimited khata. Starter Rs 999, Growth Rs 2,499, Business Rs 4,499 per year + GST. Lower than most billing and ERP apps in India.',
     'Simple pricing, lower than the market',
     'Free se shuru karein. Jab business badhe tab upgrade karein. Saal ka plan, koi chhupa charge nahi.',
     [('Plans', pricing_html),
      ('Every plan includes', ul(['GST invoices with UPI QR and WhatsApp sharing', 'Unlimited khata with customer confirmation and reminders',
                                  'POS billing with barcode and camera scanning', 'Stock, purchase bills, returns, credit and debit notes',
                                  'Double-entry accounts: Profit & Loss, Balance Sheet, Trial Balance, GST summary', 'Install as an app on Android, iPhone and computer']))],
     [('Is there really a free plan?', 'Yes. 50 invoices a month, 1 user, unlimited khata, POS and all reports, free forever.'),
      ('Are prices per month or per year?', 'Per year. Starter is Rs 999, Growth Rs 2,499 and Business Rs 4,499 a year, plus 18% GST.'),
      ('How do I upgrade?', 'Open Plan & Billing in the app, pay by UPI and enter the activation code you receive.'),
      ('Is my data safe?', 'Data is stored on Cloudflare, every business is kept separate, passwords are hashed, and staff get role-based access with an audit trail.')],
     'billing software price, GST software price India, cheap billing software, ERP for small business price, khata app free')
print('ok')
