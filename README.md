# Operation-structure-Project

## SmartTrader ERP: a complete ERP for small traders that runs in Excel

**File:** [`excel/SmartTrader_ERP.xlsx`](excel/SmartTrader_ERP.xlsx). It needs no install, no internet and no licence beyond Excel 2019 / 2021 / Microsoft 365.
**Optional macros:** [`excel/ERP_Macros.bas`](excel/ERP_Macros.bas) add fast mode, one-click invoices, PDF export, backup and year-end rollover.
**Rebuild from source:** `python tools/build_erp.py excel/SmartTrader_ERP.xlsx`

The workbook covers the full cycle: **Procure → Stock → Sell → Deliver → Collect → Report**. Inventory, sales, purchases, cash and bank, receivables and payables, GST and profit all sit in one workbook and are linked by formulas. You record each transaction once, and every report updates.

---

## 1. Pain-point analysis: why small traders struggle

| # | Pain point | Root cause | How SmartTrader ERP removes it |
|---|---|---|---|
| 1 | **Stock in the register never matches the shelf** | Stock is kept by hand in a separate register, so entries get missed | Stock is never typed. It is always calculated: `Opening + Purchases − Sales ± Adjustments`. Damage, expiry and count corrections are recorded as Adjustments, which leave an audit trail |
| 2 | **"Am I really making money?"** | Profit is guessed from cash in hand | Every sale line records its **COGS at weighted-average cost**. Gross and net profit are exact per line, per item and per month |
| 3 | **Money stuck with customers** | No ledger, no follow-up, unlimited credit | Party ledger with **credit limit, credit days, Days Unpaid** and automatic **OVERDUE / OVER LIMIT** flags. Totals show on the Dashboard |
| 4 | **Running out of fast movers / stuck with slow movers** | No reorder discipline | Per item: **reorder level, suggested order qty, days of cover, and DEAD STOCK** detection (no sale in N days) |
| 5 | **GST compliance headache** | Manual tax splits, wrong IGST/CGST | **CGST+SGST vs IGST** is chosen automatically from customer state vs. home state. **Rate-wise output/input summary** feeds GSTR-1 / 3B. Net GST payable is on the Dashboard |
| 6 | **Double work for cash sales** | Bill book plus cash book entries | A **"Paid Via"** column on the bill posts Cash/Bank/UPI instantly. Leave it blank for credit |
| 7 | **Typing mistakes corrupt reports** | Free-text entry | **Dropdowns everywhere**, unique-name enforcement, date/qty validation, and row-level **Check / Stock Check** columns (negative stock, selling below cost, unknown item) |
| 8 | **Invoices take time** | Manual bill writing | Invoice sheet auto-shows the latest bill, can **reprint any invoice** by number, fits one A4 page and doubles as a **delivery challan** |
| 9 | **Delivery follow-up gets lost** | No dispatch tracking | **Delivery status** per line (Pending → Packed → Dispatched → Delivered / Returned). Pending lines are counted on the Dashboard |
| 10 | **Excel files become slow and crash** | Volatile formulas, whole-column refs, array formulas | Speed-first architecture (section 3) |
| 11 | **Cash vs bank confusion** | No account-wise book | Account-wise **Cash / Bank / UPI** balances with opening balances and transfers between accounts |
| 12 | **Year-end chaos** | No carry-forward | The `CarryForwardToNewYear` macro rolls closing stock, average cost and party balances into the new year |

---

## 2. Module map

```
             ┌──────────── Settings (company, GST state, FY, lists, opening cash/bank)
             │
 Items ◄─────┼────── Parties
 (stock,     │       (ledger, credit control)
  cost,      │            ▲
  alerts)    │            │
   ▲  ▲  ▲   │            │
   │  │  └── Adjustments  │
   │  └───── Purchases ───┤  (procure: stock ↑, payable ↑, GST input)
   └──────── Sales ───────┤  (deliver: stock ↓, receivable ↑, GST output, COGS, profit)
                 │        │
                 ▼        │
              Invoice     CashBook (receipts, payments, expenses, capital, drawings, transfers)
                                  │
                 Reports ◄────────┴──► Dashboard (KPIs, balances, top items, charts)
```

| Sheet | Purpose | You type |
|---|---|---|
| **Dashboard** | KPI cockpit for any date range: sales, GP, net profit, purchases, expenses, receivables, payables, stock value, GST, reorder count, overdue customers, pending deliveries, next invoice no., cash/bank/UPI balances, top 10 items, charts | From/To dates only |
| **Sales** | One line per item sold; GST split, COGS, profit, stock checks | Date, Invoice, Customer, Item, Qty, [Rate], [Disc], [Paid Via], Delivery |
| **Purchases** | Goods received; stock, cost, GST input, payables | Date, Bill, Supplier, Item, Qty, [Rate], [Disc], [Paid Via] |
| **CashBook** | Finance: Receipt, Payment, Expense, Other Income, Capital In, Drawings, Transfer In/Out | Date, Type, Party/Head, Account, Amount |
| **Items** | Item master and live stock: closing qty, avg cost, value, margin, status, suggested order, last sold, days of cover | Master fields + opening stock |
| **Parties** | Customer/supplier master and ledger: balance, position, days unpaid, alerts | Master fields + opening balance |
| **Adjustments** | Damage, expiry, count corrections, returns (+/− qty) | Date, Item, Qty, Reason |
| **Invoice** | Printable A4 tax invoice / delivery challan | Invoice number (optional) |
| **Reports** | Monthly P&L for 12 months, GST rate-wise summary, expenses by head | Nothing |
| **Settings** | Company profile, home state, FY start, as-of date, invoice prefix, accounts, all dropdown lists | Once |
| **Guide** | In-file user manual | Nothing |

**Colour code:** blue text on cream = input. Black/grey = formula (do not overwrite). Green = linked from another sheet. The demo data shows a realistic 6-month trading history (about 940 sale lines). Clear it with the `ClearDemoData` macro, or by clearing the cream cells.

---

## 3. Speed architecture ("superfast" by design)

1. **No volatile cell formulas.** There is no `OFFSET`, `INDIRECT`, `NOW` or `RAND` in cells. `TODAY()` appears exactly once (`Settings!B10`). Dynamic `OFFSET` names are used only as dropdown sources, which Excel does not recalculate.
2. **Bounded ranges.** Every lookup uses fixed ranges: 3,000 lines per register, 500 items, 300 parties. There are no whole-column (`A:A`) references.
3. **Match once, reuse many times.** Each transaction row does a single `MATCH` into a hidden helper column (`itemRow`, `partyRow`). The unit, rate, GST %, cost and state are then cheap `INDEX` reads.
4. **SUMIFS / COUNTIFS / MAXIFS only.** These are Excel's fastest multi-threaded aggregators. There are no `SUMPRODUCT`, array or spill formulas.
5. **Invoice reprint without scanning.** One `MATCH` finds the invoice's first row, and its lines are read by offset. Lines of one invoice are kept together.
6. **Fast Mode macro.** Manual calculation during bulk entry, then one refresh.

Measured: about 99,000 formulas recalculate with **0 errors**. A full recalculation in headless LibreOffice takes a few seconds, and Excel's multi-threaded engine is faster.

---

## 4. Daily workflow

1. **Morning:** open the Dashboard and check *Items to Reorder*, *Overdue Customers* and *Pending Deliveries*.
2. **Goods arrive:** add Purchases lines (leave Rate blank to use the standard rate).
3. **Customer buys:** add Sales lines (Alt+F8 → `NewInvoice` / `AddInvoiceLine`), then go to the Invoice sheet and print, or run `InvoiceToPDF`.
4. **Dispatch:** update the Delivery column.
5. **Money moves:** add CashBook entries for receipts, supplier payments and expenses.
6. **Month end:** use Reports for the P&L and GST summary, then run `BackupNow`.

## 5. Assumptions and limits

* Currency is ₹ with the Indian GST structure. GST slabs live in `Settings` and can be edited. The defaults include post-Sep-2025 slabs (5/18/40%) and legacy 12/28%. Confirm rates with your CA.
* Costing uses the **weighted average over the financial year**.
* Capacity is 3,000 lines per register per year. For larger volumes, extend `N_TX` in `tools/build_erp.py` and rebuild, or start a new file each year with `CarryForwardToNewYear`.
* Returns are posted through Adjustments (qty) plus CashBook (money), as described in the Guide sheet.
* The project diagram link is in [`Link of Project`](Link%20of%20Project).
