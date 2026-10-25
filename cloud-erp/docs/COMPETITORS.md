# Competitive Landscape: Indian SME ERP / Billing / Inventory / Khata (as of Oct 2026)

> Research compiled 2026-10-11 from web search. Vendor sites (zoho.com, vyaparapp.in) could not be
> fetched directly, so most prices come from official help pages, aggregators (Capterra, GetApp,
> Techjockey) and partner blogs. **"~" = approximate / not verified against the vendor's own price page.**
> All prices exclude 18% GST unless stated. Confirm with vendors before publishing externally.

## 1. Market overview

| Metric | Figure | Source |
|---|---|---|
| Registered MSMEs (Udyam + Udyam Assist) | **9.16 crore** as of 31 Jul 2026 (~9.11 cr micro, 5.4 L small, ~42k medium) | Rajya Sabha reply via [Kashmir Life](https://kashmirlife.net/jammu-kashmir-records-over-9-64-lakh-msme-registrations-since-2020-447368/) |
| Earlier data points | 7.83 cr (Feb 2026), 8.84 cr (Jun 2026) | [IBEF](https://www.ibef.org/news/over-7-83-crore-enterprises-registered-on-udyam-platforms-indicating-strong-msme-formalisation-growth), [KNN](https://knnindia.co.in/news/newsdetails/msme/over-884-crore-msmes-registered-on-udyam-platforms-mos-karandlaje) |
| India accounting software market | USD 3.38 B (2024) to USD 5.75 B (2030), **~9.1% CAGR** (TechSci, via blog repost) | [TechSci repost](https://connect.usama.dev/blogs/67195/Indian-Accounting-Software-Market-2030-Share-Size-Analysis-Enterprise-Trends) |
| Same, alternative estimate | USD 699 M (2025) to USD 1.16 B (2031), 8.83% CAGR | [Ken Research](https://www.kenresearch.com/industry-reports/india-accounting-software-market.md) |
| India ERP software market | USD 1.78 B (2025) to 2.73 B (2031), 7.4% CAGR (TechSci); USD 1.93 B (2025) to 3.65 B (2034), 7.1% CAGR (IMARC) | [TechSci repost](https://connect.usama.dev/blogs/39558/India-ERP-Market-2030-Size-Share-Outlook-Report-Competitive-Landscape), [IMARC](https://www.imarcgroup.com/india-enterprise-resource-planning-market) |
| Cloud trend | Market moving from customised on-prem installs to cloud-native, API-led suites; SMEs favour cloud/subscription | [Ken Research ERP](https://www.kenresearch.com/industry-reports/india-enterprise-resource-planning-software-market.md), [ARC](https://www.arcweb.com/node/21131) |
| Software penetration | Only **29%** of *tech-savvy* retail MSMEs use accounting software (PayNearby MSME Digital Index 2024, n=10k+) | [PayNearby](https://paynearby.in/media/68-msmes-witness-growth-in-business-post-adoption-of-digital-tech-report) |
| UPI | Record **24.51 B** transactions / Rs 29.8 L cr in Aug 2026 (~22% YoY) | [Outlook Business](https://www.outlookbusiness.com/news/upi-transactions-near-record-level-of-298-lakh-cr-in-aug-volume-at-all-time-high-of-2451-bn) |
| GST e-invoicing | Mandatory at AATO >= Rs 5 cr (since Aug 2023); 30-day IRP reporting limit for AATO >= Rs 10 cr from 1 Apr 2025; cut to Rs 2 cr *proposed*, not confirmed | [Tally](https://tallysolutions.com/gst/e-invoicing-limit-india/), [Sovos](https://sovos.com/regulatory-updates/vat/india-lower-threshold-for-e-invoices-to-be-sent-to-irp-within-30-days/) |

**Takeaways.** Market-size estimates disagree by up to 5x (definitions differ), but all agree on
~7-9% CAGR. The real opportunity is penetration: ~9 crore registered units, overwhelmingly micro, with
low software adoption. Udyam counts registrations, not active businesses, so they overstate the active base.

Scale signals for incumbents (approximate): Tally claims "millions" of users (~7M+ in India per a
[2026 blog](https://ecosire.com/blog/odoo-accounting-vs-tally-2026-comparison), unverified);
myBillBook ~1M+ MAU, company-stated ([YourStory](https://yourstory.com/smbstory/fintech-msmes-technology-digitisation-automation/amp));
OkCredit 100M+ downloads, FY25 revenue Rs 23.3 cr, loss Rs 23.2 cr ([Inc42](https://inc42.com/buzz/tiger-global-backed-okcredit-narrows-fy25-loss-by-34-to-inr-23-cr/));
Khatabook 8M+ merchants (older TechCrunch figure, approximate).

## 2. Competitor segments

1. **Desktop incumbents:** Tally Prime, Marg ERP 9+, Busy. Strong GST/inventory depth and CA ecosystem; weak cloud/mobile.
2. **Mobile-first billing apps:** Vyapar, myBillBook (FloBiz), Swipe, Refrens. Cheap, fast GST invoicing; shallow procurement, weak multi-warehouse and controls.
3. **Khata / credit-ledger apps:** Khatabook, OkCredit, Lio, Bahi-style apps. Free, WhatsApp/SMS reminders; no real accounting or inventory.
4. **Cloud SMB suites:** Zoho Books + Inventory, Giddh, ERPNext, Odoo. Full double-entry; complex or pricey for micro traders, needs setup.
5. **Mid-market ERP:** SAP Business One, Dynamics 365 Business Central, Oracle NetSuite. Rs lakhs-crores TCO, partner-led; out of reach for most SMEs.

## 3. Feature comparison

Legend: Y = strong/native, P = partial/basic or higher plan only, N = absent/needs add-on. Ratings are a
synthesis from vendor marketing and reviews (approximate).

| Product | Segment | Deploy | Inventory | Procure (PO→GRN→Bill) | Sales (SO→DN→Inv) | GST / e-inv / e-way | Double-entry acctg | Khata + reminders | Multi-warehouse | Mobile | Roles |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tally Prime | Small to mid traders/mfg, CA-led | Desktop (+rental/remote) | Y | Y | Y | Y | Y | P | Y (godowns) | P (view apps) | Y |
| Marg ERP 9+ | Pharma, FMCG distribution, retail | Desktop | Y | Y | Y | Y | Y | P | Y | P | Y |
| Busy | Traders, distributors, mfg | Desktop (+SQL/cloud hosting) | Y | Y | Y | Y | Y | P | Y | P | Y |
| Vyapar | Micro retail/traders | Mobile + desktop | Y | P | P | Y | P | Y | P (godowns) | Y | P |
| myBillBook | Micro/small traders | Mobile + web | Y | P | P | Y | P | Y | P (higher plans) | Y | P |
| Swipe | Micro/small, invoicing-first | Web + mobile | P | P | P | Y | P | P | P | Y | P |
| Refrens | Freelancers, services, small biz | Cloud | P | P | P | Y | Y | P | N | P | P |
| Giddh | Small biz, CA-assisted | Cloud | P | P | P | Y | Y | N | P | P | P |
| Khatabook | Kirana, micro merchants | Mobile | N | N | N | P (via add-on billing) | N | Y | N | Y | N |
| OkCredit | Micro merchants | Mobile | N | N | N | P (paid tiers) | N | Y | N | Y | N |
| Lio | Micro biz, general data | Mobile | N | N | N | N | N | P | N | Y | P |
| Zoho Books | Small to mid, services/trading | Cloud | P (basic) | Y | Y | Y | Y | P | P | Y | Y |
| Zoho Inventory | Trading, D2C, e-com | Cloud | Y | Y | Y | Y (with Books) | P (needs Books) | N | Y | Y | Y |
| ERPNext (Frappe) | Small to mid, mfg/trading | Self-host or Frappe Cloud | Y | Y | Y | Y (India Compliance app) | Y | N | Y | P | Y |
| Odoo | Small to mid, multi-module | Cloud / Odoo.sh / on-prem | Y | Y | Y | Y (India localisation) | Y | N | Y | P | Y |
| SAP Business One | Mid-market | On-prem / partner cloud | Y | Y | Y | Y (partner add-on) | Y | N | Y | P | Y |
| Dynamics 365 BC | Mid-market | Cloud (Azure) | Y | Y | Y | Y (India localisation) | Y | N | Y | P | Y |
| Oracle NetSuite | Upper-mid, multi-entity | Cloud | Y | Y | Y | Y | Y | N | Y | P | Y |

### Notable weaknesses (summary)

- **Tally Prime:** desktop/LAN-centric; multi-branch needs Tally Server (Rs 2.7 L+) or third-party hosting; dated UI; weak native mobile and WhatsApp workflows.
- **Marg / Busy:** desktop-first, dealer-driven pricing (Marg list price varies by dealer); cloud access mostly via hosted/remote desktop; steep learning curve.
- **Vyapar / myBillBook / Swipe:** billing-first; procurement chain (PO→GRN→3-way match) and true double-entry are shallow; limited approvals/roles; multi-warehouse only on higher tiers; outgrown at ~Rs 5-10 cr turnover.
- **Khatabook / OkCredit / Lio:** ledger only; no stock, no GST returns, monetisation struggles (OkCredit still loss-making FY25).
- **Zoho Books / Inventory:** two products to buy and integrate for full trading flow; per-user and per-order caps push cost up quickly; no khata-style collections UX for kirana/wholesale.
- **Giddh / Refrens:** small ecosystems; inventory and warehouse depth limited; transaction caps (Giddh charges Rs 0.10/txn above cap).
- **ERPNext / Odoo:** powerful but need implementation partner (Odoo small rollout ~Rs 2-5 L, approximate); configuration heavy for a 3-person shop; Odoo Custom price rose ~21% in Sep 2026 (unverified).
- **SAP B1 / BC / NetSuite:** licence alone Rs 66k-1.5 L per user per year; first-year TCO Rs 8 L (SAP B1, <=5 users) to Rs 50 L+ (NetSuite) per partner estimates.

## 4. Pricing (INR, ex-GST)

| Product | Model | Entry price | Top published tier | Notes / source |
|---|---|---|---|---|
| Tally Prime | Perpetual + TSS, or rental | Silver Rs 22,500 one-time + TSS Rs 4,500/yr | Gold Rs 67,500 + TSS Rs 13,500/yr; Gold rental Rs 24,300/yr; Server Rs 2.7 L+ | [Tally TCO guide](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/) (older pages show Rs 18k/54k) |
| Marg ERP 9+ | Perpetual + ARC | Basic ~Rs 8,100 (ARC ~Rs 3,000/yr) | Gold ~Rs 25,200 (ARC ~Rs 7,200/yr) | ~ dealer-dependent; [erpresearch](https://www.erpresearch.com/pricing/marg-erp), [itforsme](https://itforsme.in/pricing/marg-erp-india) |
| Busy | Annual subscription (or perpetual) | Basic Rs 5,000/yr (1 user) | Enterprise Rs 10,000/yr (1 user); multi-user/SQL extra | [busy.in pricing](https://busy.in/pricing.md) |
| Vyapar | Annual | Mobile free tier; Desktop Gold Rs 3,399/yr | ~Rs 4,010/yr desktop+mobile; 3-yr Gold Rs 8,848 | [Capterra](https://www.capterra.com/p/180579/Vyapar/pricing/), [itforsme](https://www.itforsme.in/pricing/vyapar-india) (~bundle) |
| myBillBook | Annual | Silver Rs 399/yr (Android, 1 device) | Diamond ~Rs 2,599, Platinum ~Rs 2,999, Enterprise ~Rs 4,999/yr | [Official Silver page](https://freetrial.mybillbook.in/silver-plan-for-android.html), [Techjockey](https://www.techjockey.com/compare/mybillbook-accounting-software-vs-silverbills) |
| Swipe | Per user / yr | Pro Rs 2,999/user/yr | Jet Rs 4,199/user/yr (higher tiers unpublished) | [GetApp](https://www.getapp.com/finance-accounting-software/a/swipe/), [Capterra](https://www.capterra.com/p/10008988/Swipe/) |
| Refrens | Annual | Free plan; paid ~Rs 3,900/yr | ~Rs 5,900+/yr (conflicting sources) | ~ [Refrens](https://www.refrens.com/grow/top-accounting-software) |
| Giddh | Annual | Birch Rs 1,500/yr | Sequoia Rs 15,000/yr (Oak 4k, Vine 10k) | [Giddh docs](https://giddh.com/help/what-are-the-different-pricing-plans-of-giddh) |
| Khatabook | Freemium | Free | Paid add-ons not published | [G2](https://www.g2.com/products/khatabook/pricing) |
| OkCredit | Freemium | Free (unlimited customers, reminders) | Premium/Ads-free tiers, price not published | [OkCredit FAQ](https://okcredit.in/faq) |
| Lio | Freemium | Free | ~ not published | [GetApp](https://www.getapp.com/all-software/a/lio/) |
| Zoho Books | Monthly/annual per org | Free (<Rs 25-50 L revenue, ~); Standard ~Rs 749/mo annual (~Rs 9k/yr) | Ultimate Rs 9,999/mo (~Rs 1.0-1.2 L/yr); extra user Rs 150/mo | ~ [Patron](https://www.patronaccounting.com/blog/zoho-books-pricing-india-2026) |
| Zoho Inventory | Monthly per org | Free (50 orders/mo); Standard ~Rs 1,499/mo (~Rs 18k/yr) | Enterprise ~Rs 10,999/mo (~Rs 1.3 L/yr) | ~ unverified reseller: [itforsme](https://itforsme.in/pricing/zoho-inventory-india) |
| ERPNext | Open source; hosted | Self-host free; Frappe Cloud ~USD 5-10/mo (~Rs 5-10k/yr) | Dedicated ~USD 40/mo (~Rs 43k/yr) + implementation | ~ [Auriga](https://aurigait.com/blog/erpnext-implementation-cost-india/) |
| Odoo | Per user / month | Standard ~Rs 580-725/user/mo (~Rs 7-9k/user/yr); 1 app free | Custom ~Rs 1,080/user/mo (~Rs 13k/user/yr) | ~ [oec.sh](https://oec.sh/odoo-pricing/india) |
| SAP Business One | Subscription or perpetual | ~Rs 3,600-7,500/user/mo | Perpetual ~Rs 1.36 L/user + 20% AMC; TCO Rs 8-12 L (<=5 users) | ~ [Praxis](https://praxisinfosolutions.com/blog/sap-business-one-price-in-india-a-detailed-breakdown-of-sap-b1-cost/) |
| Dynamics 365 BC | Per user / month | Essentials ~Rs 5,500-6,500/user/mo (~Rs 66-78k/user/yr) | Premium ~40% higher | ~ [Cloudfy](https://cloudfysystems.com/blog/microsoft-dynamics-365-pricing-india) |
| Oracle NetSuite | Annual quote | Base ~USD 999/mo (~Rs 10 L/yr) + ~USD 99-199/user/mo | Indian estimates Rs 15-25 L/yr base; first-year 20-user TCO Rs 50 L-1.5 cr | ~ [Aaxonix](https://www.aaxonix.com/resources/netsuite-erp-india-guide/) |

**Price bands (annual, small 1-3 user business):** khata apps Rs 0; mobile billing Rs 400-5,000;
desktop incumbents Rs 5,000-27,000 (year 1); cloud suites Rs 9,000-1.3 L; mid-market Rs 1 L+ per user.

## 5. Gaps and opportunities

1. **The "missing middle".** Mobile billing apps (Rs 3-5k) stop at invoicing; real ERPs (Zoho Books+Inventory, Odoo, ERPNext) cost Rs 20k-1 L+ or need implementation. A trader with 2-10 staff and 2-3 godowns has no affordable, cloud-native, full PO→GRN→Bill / SO→DN→Invoice product.
2. **Khata is disconnected from accounting.** Khatabook/OkCredit own the credit-collection habit but have no stock or GST books; ERPs have receivables but no kirana-style WhatsApp/UPI collection UX. Merging them is a clear wedge, especially with UPI at 24.5 B txns/month.
3. **Tally's cloud gap.** Tally's multi-location answer is LAN/Server/remote hosting. Its users (and their CAs) want browser + mobile access without RDP hosting fees, but need Tally-grade vouchers and Tally export.
4. **Controls for growing teams.** Billing apps offer weak roles/approvals; owners fear staff fraud on discounts, stock adjustments and cash. Granular roles and audit trails are under-served below Rs 20k/yr.
5. **Compliance creep.** e-invoice (Rs 5 cr AATO, possible Rs 2 cr), the 30-day IRP limit and e-way bills force micro apps' users to upgrade; a clean upgrade path is valuable.
6. **Infra cost advantage.** An edge-hosted (Cloudflare Workers/D1/R2) stack has near-zero idle cost per tenant, enabling a generous free tier and sub-Rs 10k pricing that VM-based ERPs cannot match.
7. **Vernacular + low-bandwidth.** Edge latency and offline-tolerant PWA matter in Tier-2/3 India where most of the 9 crore MSMEs are.

## 6. Recommended positioning: SmartTrader Cloud ERP

**One-liner:** "Tally-grade books and stock, Khatabook-simple collections, in your browser and phone, priced like a billing app."

**Ideal customer profile (ICP):** wholesale/distribution and multi-outlet retail traders, Rs 50 L-25 cr turnover, 2-15 users, 1-5 godowns,
heavy credit sales; currently on Tally/Busy/Marg desktop + Khatabook, or outgrowing Vyapar/myBillBook.

**Differentiators to lead with:**
- Full **double-entry** with auto-posting from **PO→GRN→Purchase Bill** (3-way match) and **SO→Delivery Note→Invoice**; nothing posted outside the ledger.
- **Multi-warehouse** stock with inter-godown transfers, batch/serial and valuation on mid tier (competitors gate this at top tiers).
- **Khata built into receivables**: party ledger = AR; automatic WhatsApp reminders with **UPI deep-link / dynamic QR**, auto-reconcile on payment.
- **GST native:** GSTR-1/3B data, e-invoice IRN + e-way bill (with 30-day IRP guard), HSN summaries.
- **Roles & approvals:** owner / accountant / godown keeper / salesman; approval on discounts, credit-limit overrides, stock adjustments; full audit log.
- **Cloudflare-hosted:** fast everywhere, no server to buy, daily backups, works on low-end Android via PWA.
- **Tally bridge:** import masters/opening balances from Tally, export vouchers for CAs.

**Avoid (for now):** manufacturing/MRP, payroll, POS hardware depth; compete with Odoo/ERPNext on simplicity, not breadth.

### Recommended pricing (INR/yr, ex-GST, billed annually)

| Plan | Price | Users | Warehouses | Includes |
|---|---|---|---|---|
| **Free (Khata)** | Rs 0 | 1 | 1 | Khata ledger, WhatsApp/UPI reminders (manual send), 50 GST invoices/mo |
| **Starter** | **Rs 999** | 2 | 1 | Unlimited GST invoicing, inventory, double-entry books, automated reminders, mobile |
| **Growth** (target plan) | **Rs 2,499** | 5 | 3 | PO→GRN→Bill, SO→DN→Invoice, e-invoice + e-way bill, roles, credit limits, Tally import/export |
| **Business** | **Rs 4,499** | 15 | Unlimited | Approvals workflow, batch/serial, multi-GSTIN branches, audit log, API/webhooks, priority support |
| Add-ons | Rs 1,200/user/yr; WhatsApp messages at cost + margin (~Rs 0.5-1/msg, approx) | | | |

**Pricing as launched (Oct 2026): set below every comparable product.**
- Starter Rs 999 is less than a third of Vyapar desktop (Rs 3,399) and Swipe Pro (Rs 2,999 per user). It is above only myBillBook Silver (Rs 399), which runs on 1 Android device without purchase orders, godowns or double-entry books.
- Growth Rs 2,499 (5 users, 3 godowns, e-invoice/e-way bill, Tally export) is below myBillBook Diamond (~Rs 2,599) and Platinum (~Rs 2,999), Swipe Pro for a single user, and Zoho Books Standard (~Rs 9k).
- Business Rs 4,499 (15 users, unlimited godowns) is below myBillBook Enterprise (~Rs 4,999), Busy (Rs 5-10k) and Tally Silver renewal alone (Rs 4,500 + Rs 22,500 licence).
- Cloudflare hosting costs only a few rupees per business a month, so these prices still leave a healthy margin.

**Earlier rationale (first draft at Rs 2,999 / 7,999 / 17,999):**
- Starter sits at Swipe Pro / myBillBook Platinum (~Rs 3k) to win the upgrade-from-billing-app segment.
- Growth at ~Rs 8k is below Zoho Books Standard alone (~Rs 9k) and far below Books+Inventory (~Rs 27k+), Tally Silver year-1 (Rs 22.5k) or Busy Enterprise + multi-user, while bundling procurement, multi-warehouse and khata.
- Business at ~Rs 18k undercuts Tally Gold (Rs 67.5k + Rs 13.5k TSS) and Zoho Premium tiers (~Rs 36k/yr, approx), and stays below Odoo for 5+ users (~Rs 35-65k/yr).
- Edge-hosting economics support a free khata tier as the acquisition funnel (the Khatabook/OkCredit playbook), with
  monetisation triggered by GST invoicing volume, second user, second godown or e-invoice need.
- Offer a 3-year prepay discount (~20%) and a CA/partner channel (20-30% rev-share) to mirror how Tally and Marg are sold.

## 7. Caveats

- Market-size reports vary widely; cite as ranges. Udyam figures are registrations, not active firms.
- Zoho, Odoo, ERPNext, SAP, BC and NetSuite INR figures come from partner/aggregator sites, not vendor list prices.
- Khatabook, OkCredit and Lio do not publish premium pricing; "Bahi"-style ledger apps had no reliable public data.
- Re-verify all prices before external use; several vendors revised prices in 2026 (e.g. Tally, Odoo).

## 8. Feature gap analysis vs Vinculum, Khatabook and others (Oct 2026)

> Research compiled 2026-10-12 from web search. Vendor sites (vinculumgroup.com, khatabook.com) could not be fetched
> directly, so features come from search snippets of vendor pages, help docs, Capterra/G2/Techjockey and press.
> "~" = approximate or unverified. Ratings are a synthesis, not hands-on testing.

### 8.1 Profiles

**Vinculum (Vin eRetail OMS/WMS, Noida, founded 2007, ~370 staff).** SaaS omnichannel stack for brands, D2C and
3PLs. The OMS ("Market in a Box") pulls orders from webstores and marketplaces (listings in ~20+ countries), syncs inventory
and routes fulfilment to own warehouses, 3PLs, stores and franchisees. The WMS covers B2B warehousing and B2C fulfilment:
handheld (HHT) inward/outward, putaway rules, batch and wave picking, combined picklists, cycle counts, SKU-level batch
attributes (expiry captured at inward only where needed), warehouse-wide serialisation, barcode printing and automated
replenishment from daily orders. Gartner WMS Magic Quadrant 2017-2020; QKS SPARK Matrix OMS "Technology Leader" 2025.
In 2026 it is publishing on "agentic commerce" (AI agents) and VinCode.ai, but no shipped AI product was confirmed.
Pricing is quote-based (Techjockey shows a placeholder ~Rs 1,220; real deals are enterprise-sized). Capterra 4.6/5
(58 reviews); a common complaint is slow support (>48 h).
Not an SME tool: no khata, no SME double-entry books, implementation-led.
Sources: [Vinculum WMS use cases](https://www.vinculumgroup.com/use-cases/b2b-warehousing-b2c-fulfillment/brands/),
[Gartner MQ page](https://www.vinculumgroup.com/gartner-magic-quadrant-for-wms/),
[OMS category](https://www.vinculumgroup.com/category/order-management/),
[AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-zon3ljjghcjic),
[Techjockey](https://techjockey.com/detail/vin-eretail), [Capterra](https://www.capterra.in/software/152554/vin-eretail-wms).

**Khatabook (Bengaluru, Sequoia/Surge-backed).** Digital udhaar ledger for kirana and micro merchants (~8M+ active
merchants, older figure). It offers customer/supplier ledgers, SMS/WhatsApp payment reminders with payment links,
UPI/QR collection ("Khatabook QR"), simple sales/purchase invoices and multilingual UI. Staff management was spun out
as the separate Pagarkhata app (attendance, leave, wages, payslips; launched Dec 2020, current status unclear).
Revenue was ~Rs 114 cr in FY24, with a net loss of ~Rs 116 cr (Inc42). Its FY25 figure on Inc42 looks erroneous.
The core ledger is free; myBillBook's comparison page lists Khatabook billing at ~Rs 156/month (competitor marketing,
unverified). Weaknesses: no e-invoice/e-way bill, no stock, no double-entry, and reviewers report limits on in-app
reminder sending.
Sources: [Inc42 financials](https://inc42.com/company/khatabook/financials/),
[Pagarkhata launch](https://www.ap7am.com/pn/3530/whatsapp:/send), [Capterra](https://www.capterra.in/software/197475/khatabook),
[G2](https://www.g2.com/products/khatabook/discuss), [myBillBook vs Khatabook](https://freetrial.mybillbook.in/billing-alternative-khatabook.html).

**Others, briefly.**
- **Unicommerce:** WMS/OMS with ~290+ integrations, HHT inbound/outbound/cycle count, from ~$5k per install ([blog](https://unicommerce.com/blog/best-warehouse-management-software-in-india/), [Gartner](https://www.gartner.com/reviews/product/unicommerce-wms)).
- **EasyEcom:** 2026 release notes added a pending GRN/return/cancellation putaway dashboard and partial returns ([what's new](https://easyecom.io/whatsnew-category/warehouse-management)).
- **Zoho Inventory:** batch/serial tracking, zones and bin locations, barcode-scanned picklists ([help](https://www.zoho.com/en-ng/inventory/help/bin-locations/)).
- **Vyapar:** batch/expiry/serial (IMEI) on Premium, true offline invoicing, WhatsApp reminders with payment links ([guide](https://vyaparapp.in/guides/how-to-add-item-batches-serial-numbers-in-vyapar), [reminders](https://api1.vyaparapp.in/guides/how-to-send-payment-reminders-in-vyapar)).
- **myBillBook:** AI/OCR purchase-bill scanning, and staff attendance + payroll on Platinum and above ([scan](https://mybillbook.in/free/invoicing-software/invoice-scanning-software/)).
- **TallyPrime 7.0** (Dec 2025): cloud backup to TallyDrive, PrimeBanking vendor payments and connected banking. 7.1 is the latest (Jun 2026) ([Tally](https://tallysolutions.com/darpan/product-update-tallyprime-7-0/)).
- **Marg ERP:** pharma batch/expiry, rack management, Schedule H tracking, eOrder app. WhatsApp needs a third-party BSP ([guide](https://richautomate.in/blog/marg-erp-whatsapp-integration-india-2026-setup-guide)).
- **OkCredit:** freemium ledger with SMS/WhatsApp reminders and online collection; no public paid tiers ([Techjockey](https://www.techjockey.com/reviews/okcredit)).

### 8.2 Feature matrix

Y = native, P = partial / higher plan / add-on, N = absent. "Yes"/"No" for SmartTrader is our current shipped status.

| Feature | Vinculum | Khatabook | Vyapar/myBillBook | Zoho Inventory | Tally | SmartTrader (ours) |
|---|---|---|---|---|---|---|
| PO → GRN → Bill | Y | N | P | Y | Y | Yes |
| SO → Delivery Note → Invoice | Y (OMS) | N | P | Y | Y | Yes |
| Quotations | P | N | Y | Y | Y | Yes |
| Return credit notes & debit notes | Y (returns) | N | Y | Y | Y | Yes |
| Value credit/debit notes (rate difference) | N | N | P | P | Y | Yes |
| Gate entry inward + GRN from gate entry, outward gate pass | P (~) | N | N | N | P (TDL/add-on) | Yes |
| Barcode/HHT GRN, QC, putaway rules | Y | N | N | P | N | No (putaway) |
| Multi-godown / warehouse | Y | N | P | Y | Y | Yes |
| Average cost valuation | P | N | P | Y (FIFO/WAC) | Y | Yes |
| Reorder alerts + one-click / auto PO | Y (auto replen.) | N | P (alerts) | P (reorder pts) | P | Yes |
| Cycle count / stock count + bulk adjust | Y (HHT) | N | P | P | P | Yes |
| Bin/rack location + pick list | Y | N | N | Y | N | Yes |
| Wave/batch picking, WMS putaway | Y | N | N | P | N | Yes (wave pick list, guided put-away; no HHT app) |
| Batch / expiry tracking | Y | N | Y (Premium) | Y | Y | Yes (FEFO, expiry report) |
| Serial / IMEI numbers | Y | N | Y (Premium) | Y | P | Yes (+ warranty lookup) |
| Stock ageing (age buckets, dead / slow, ABC) | P (~) | N | N (~) | P (~) | Y | Yes |
| Manufacturing (BOM + production) | N | N | P (~) | Y (assemblies) | Y | Yes |
| Purchase order approval above a limit | P (~) | N | N (~) | P (~) | N (~) | Yes |
| Pending orders/deliveries/receipts report | Y | N | P | Y | Y | Yes |
| Double-entry books, TB/P&L/BS | N | N | P | P (needs Books) | Y | Yes |
| GST summary, e-invoice & e-way bill JSON | P | N | Y | Y (with Books) | Y | Yes |
| Tally export | P (postings) | N | P | P | n/a | Yes |
| Marketplace integrations (Amazon/Flipkart) | Y (core) | N | N | Y | N | P (order reports + stock file; live Shopify / WooCommerce orders) |
| Khata ledger, send-before-save, customer confirm/dispute link | N | Y (no confirm flow) | P (shared ledger link) | N | N | Yes |
| WhatsApp/SMS reminders with UPI link | N | Y | Y | P | N | Yes |
| Bulk reminders screen | N | P | P | N | N | Yes |
| Automatic scheduled WhatsApp (Business API) | N | P (~) | P (scheduled) | N | N | Yes (opt-in, Growth+) |
| Customer invoice links with UPI pay | N | P | Y | Y (payment gateway) | N | Yes |
| POS with barcode / camera scan | P | N | Y | P | P | Yes |
| Barcode label printing | Y | N | Y | Y | P | Yes |
| Staff attendance / payroll | N | P (Pagarkhata app) | P (myBillBook Platinum+) | N | Y (payroll) | Yes (attendance, advances, salary, payslip; no PF/ESI) |
| AI features (OCR bill scan, assistants) | P (~, agentic R&D) | N | P (myBillBook OCR) | P (Zia) | N | Yes (supplier bill photo / PDF → purchase bill, read on the phone, free) |
| Offline data entry | N | Y (app) | Y (Vyapar) | N | Y (desktop) | Yes (bills, POS, receipts, expenses; sync later) |
| Mobile app / PWA install | Y (Android HHT) | Y | Y | Y | P | Yes (PWA) |
| Roles + audit trail | Y | N | P | Y | Y (edit log) | Yes |
| Today action list (what needs doing, one tap each) | N | N | N (~) | N (~) | N | Yes |
| Bill as a PDF on WhatsApp, in English / Hindi / Hinglish | N | P | P (~) | N | N | Yes |
| Customer balance confirmation link + MSMED interest recovery file | N | N | N | N | N | Yes |
| Free daily Google Drive backup | n/a | N (~) | P (~) | n/a | P (TallyDrive) | Yes |

**Read-out.** SmartTrader already covers more of the trader workflow than any single SME product: Tally-grade
procurement and accounting, plus khata collections and light WMS (gate entry, bins, pick list, cycle count). The
real gaps are item-level traceability (batch/expiry/serial), channel integrations, offline use and AI convenience.
Full WMS (wave picking, putaway rules) is Vinculum/Unicommerce territory and matters less for SME traders.

### 8.3 Top 8 next features to build (ranked by impact for Indian SME traders)

1. ✅ *Built (PR #5).* **Batch + expiry tracking (FEFO pick, near-expiry alerts):** required by pharma, FMCG, food and agro-input distributors, a large segment where Marg/Vyapar win today.
2. ✅ *Built.* **Serial / IMEI tracking:** mobile, electronics and appliance dealers need it for warranty and returns. It shares the same lot-tracking data model as #1, so it is cheap to add after it.
3. ✅ *Built.* **Automatic scheduled WhatsApp (Business API) reminders + payment-received receipts:** collections are the top daily pain. Auto-nudges on due dates beat manual sends and justify a paid add-on (per-message pass-through).
4. ✅ *Built.* **AI purchase-bill OCR → draft GRN/purchase bill:** suppliers send paper or PDF bills, and myBillBook already markets this. It cuts the slowest data-entry task and is visible "AI" in demos.
5. ✅ *Built.* **Offline data entry (PWA queue + sync) for POS, khata and GRN:** patchy connectivity in tier-2/3 markets is the main reason traders stay on Vyapar or desktop Tally.
6. ✅ *Built.* **Staff attendance + simple payroll/advances (salesman, helpers):** bundled by myBillBook and Khatabook (Pagarkhata), it raises daily active use, and the data feeds expense entries.
7. 🟡 *Order import and stock file built; live API sync not yet.* **Marketplace + webstore sync (Amazon, Flipkart, Meesho, Shopify) for stock and orders:** a growing share of traders sell online. Start with inventory sync and order import rather than a full OMS.
8. 🟡 *Guided put-away and wave picking built; QC hold not yet.* **Barcode GRN with QC hold/accept/reject and guided putaway to bins:** builds on the existing gate entry and bins, closes the inward-quality loop for distributors, and moves us towards Vinculum-lite WMS.

### 8.4 Where SmartTrader stands (25 Oct 2026)

Built since the gap analysis: batch and expiry with FEFO, bins and racks, stock ageing with ABC, serial / IMEI with
warranty lookup, manufacturing (recipe + production runs), purchase order approval, marketplace order import and stock
file, a Today action list, bills as PDF on WhatsApp in the customer's language, and the Vasooli collections suite.

**Why a trader picks us over each alternative**

| They use today | What they miss there | What we give instead |
|---|---|---|
| Khatabook / OkCredit | Only a ledger: no stock, no GST books, no e-invoice | The same khata and reminders, plus full billing, stock, GST and double-entry books, and a customer confirm / dispute link |
| Vyapar / myBillBook | Batch and serial sit in higher plans; no customer confirm / dispute flow or recovery file; no Tally-grade procurement chain | Batch, serial, bins, ageing, BOM and approvals in one app, PO → GRN → Bill, gate entry, MSMED recovery file |
| Tally | Desktop-first, no customer links or WhatsApp PDF, no khata | Works on any phone, bill PDF on WhatsApp with UPI, khata and vasooli, free daily Drive backup, and a Tally export when the CA still wants Tally |
| Zoho Inventory | Books and inventory are separate subscriptions; no khata, no udhaar culture features | One app: books, stock, khata, promises, collections in Hindi / Hinglish |
| Vinculum / Unicommerce | Built for brands and 3PLs: quote-based price, implementation projects, no SME books | The parts an SME trader needs (bins, FEFO, serials, order import, stock file) at a small yearly price, set up in minutes |

**Built since (25 Oct 2026, second round):** staff attendance and salary with advances and payslips, offline billing
with an outbox, supplier bill scanning on the phone (free OCR, no outside service), automatic WhatsApp reminders, live Shopify / WooCommerce orders,
guided put-away and wave picking.

**Still behind (honest list):** live Amazon / Flipkart API sync (needs developer registration with each marketplace),
statutory payroll (PF / ESI / TDS), a handheld (HHT) warehouse app with put-away rules per zone, and QC hold at GRN.
