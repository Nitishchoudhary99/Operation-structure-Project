# SmartTrader C Engine (Excel XLL add-in)

This is a native Excel add-in written in C11. It posts the whole ERP ledger in one pass:
- stock and weighted-average cost
- GST split
- COGS and profit
- party ledgers
- cash book

`SmartTrader_ERP_C.xlsx` calls it through six array formulas, which replace about 100,000 cell formulas.

| File | |
|---|---|
| `dist/SmartTrader64.xll` | 64-bit Excel for Windows (default for Microsoft 365) |
| `dist/SmartTrader32.xll` | 32-bit Excel for Windows |
| `src/engine.c` | Posting engine (pure C, no Windows dependency) |
| `src/smarttrader.c` | Excel glue: registration, exports, memory handback |
| `src/xlcall_min.h` | Minimal Excel C API declarations (no SDK needed to build) |
| `test/harness.c` | Native test driver (accuracy, edge cases, benchmark) |
| `test/winhost.c` | Fake `Excel.exe` used to load the real `.xll` under Wine |

## Install (end users)

1. Copy `SmartTrader64.xll` to a permanent folder, for example `Documents\SmartTrader`. If your Excel is 32-bit, use `SmartTrader32.xll` instead. To check, go to *File ▸ Account ▸ About Excel*.
2. Right-click the file ▸ **Properties** ▸ tick **Unblock** ▸ OK. Windows blocks add-ins downloaded from the internet until you do this.
3. In Excel go to **File ▸ Options ▸ Add-ins ▸ Manage: Excel Add-ins ▸ Go ▸ Browse**, select the `.xll` and click OK.
4. Open `excel/SmartTrader_ERP_C.xlsx`. The Dashboard's top-right corner should show **✔ SmartTrader C Engine 1.0 (64-bit)**.

Excel then loads the add-in automatically every time it starts.

## Worksheet functions

All six take the same seven input blocks, which are defined names in the workbook:
`IN_Items, IN_Parties, IN_Purchases, IN_Sales, IN_CashBook, IN_Adjust, IN_Settings`.

| Function | Output block | Columns returned |
|---|---|---|
| `ST_ITEMS` | `Items!L:Z` | purchased, sold, adjusted, closing, avg cost, value, status, margin, suggested qty, sales, profit, last sold, days since sale, days of cover, rank key |
| `ST_PURCHASES` | `Purchases!I:S` | unit, rate used, taxable, GST %, CGST, SGST, IGST, total, item row, party row, paid now |
| `ST_SALES` | `Sales!J:X` | unit, rate used, taxable, GST %, CGST, SGST, IGST, total, COGS, profit, stock check, item row, party row, invoice no, paid now |
| `ST_PARTIES` | `Parties!J:S` | credit sales, received, credit purchases, paid, balance, position, last sale, last receipt, days unpaid, alert |
| `ST_CASHBOOK` | `CashBook!I:K` | money in, money out, check |
| `ST_ADJUST` | `Adjustments!F:G` | avg cost, value impact |
| `ST_VERSION()` | any cell | engine version and bitness, which also confirms the add-in is loaded |

## Design

**Single pass, O(n).**
- Item and party masters are indexed once in open-addressing hash tables (case-insensitive, matching `MATCH`/`SUMIFS` semantics).
- Each register is scanned once.
- The formula edition's equivalent cost is O(items × lines), because every item row runs several `SUMIFS` over every transaction line.

**Exact money.**
- Every amount is rounded with Excel's `ROUND(x,2)` rule; `2.675 → 2.68`, so binary noise is handled.
- Amounts are then carried as **int64 paise**, so ledger totals never drift.
- Quantity totals are snapped to 6 decimals, so "stock = 0" tests are exact.

**Native and thread-safe.**
- Functions are registered as `Q…$`: values in, thread-safe, so they take part in Excel's multithreaded recalculation.
- Results are returned as a single `malloc` block (header, cells and string pool together) flagged `xlbitDLLFree`, and Excel hands it back to `xlAutoFree12`, which releases it with a single `free()`.
- Each function runs only the passes it needs. The cash book runs no stock passes, for example.

**Acyclic.** Every function reads only raw input columns, never another function's output, so Excel's dependency graph stays clean and recalculation order doesn't matter.

**No runtime dependencies.** The binaries are statically linked and import only `KERNEL32.dll` and `msvcrt.dll`.

## Build and test

```bash
make            # cross-compile dist/SmartTrader64.xll + dist/SmartTrader32.xll (mingw-w64)
make test       # registration check + 29 edge-case checks + cell-by-cell check vs formula edition
make wintest    # load the real 64-bit .xll in a fake Excel host under Wine; outputs must be byte-identical
make bench      # synthetic workloads: 3k / 100k / 1M sales lines
```

The native tests build with AddressSanitizer and UndefinedBehaviorSanitizer.

## Verified results

| Check | Result |
|---|---|
| Engine vs formula edition, every output cell (Items, Purchases, Sales, Parties, CashBook, Adjustments) | **98,500 cells, 0 mismatches** |
| Edge cases: Excel half-rounding, case-insensitive names, inter-state IGST, unknown item, negative stock, invoice parsing, error inputs | **29/29 pass** |
| Real `SmartTrader64.xll` under Windows ABI (Wine): `xlAutoOpen` registration + all 6 functions | **byte-identical to the native build** |
| Full C workbook (20k-row capacity) with engine output, then Dashboard / Reports / Invoice recalculated | **843 cells match the formula edition, 0 formula errors** |
| Memory: ASan + UBSan over all of the above | **no errors, no leaks** |

The only intentional difference is **Stock Value**. The engine values each item to the paisa before totalling (₹74,918.06), while the formula edition keeps unrounded fractions (₹74,918.0555…).

### Speed

The full recalculation runs all six functions, with 5,000 items and 2,000 parties:

| Sales lines (+¼ purchases, ⅓ cash entries) | Full recalculation |
|---|---|
| 3,000 (a typical small shop's year) | **~6 ms** |
| 100,000 | **~150 ms** |
| 1,000,000 | ~2.3 s |

The formula edition needs about 99,000 cell formulas to cover just 3,000 lines.
