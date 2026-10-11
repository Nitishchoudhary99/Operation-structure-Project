"""Builds SmartTrader_ERP.xlsx - a formula-driven mini ERP for small traders.

Run:  python tools/build_erp.py  [output_path] [--engine c]

  default      every calculation is an Excel formula (works everywhere, incl. Mac/web)
  --engine c   heavy blocks are single array formulas calling the SmartTrader C
               engine (xll/dist/SmartTrader64.xll) - Windows Excel, 20k lines/register
"""
import random
from copy import copy
import sys
from datetime import date, timedelta

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.formula import ArrayFormula

def opt(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


C_ENGINE = (opt("--engine", "formula") or "").lower() == "c"
SAMPLE = opt("--sample", "small")          # small: demo fits the Free plan; big: ~940 sales lines (tests)
LIC_ID = opt("--license-id", "")           # test builds only: pre-filled Pro activation
LIC_KEY = opt("--license-key", "")
_flags = {"--engine", "--sample", "--license-id", "--license-key"}
ARGV = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and sys.argv[i - 1] not in _flags]
OUT = ARGV[0] if ARGV else ("SmartTrader_ERP_C.xlsx" if C_ENGINE else "SmartTrader_ERP.xlsx")

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import license_tool as LIC  # noqa: E402  (shared with the key generator and the C engine)

# ---------------------------------------------------------------- capacity
N_TX = 20000 if C_ENGINE else 3000      # transaction rows per register (Sales / Purchases / Cash Book)
N_ADJ = 2000 if C_ENGINE else 500
N_ITEMS = 2000 if C_ENGINE else 500
N_PARTIES = 1000 if C_ENGINE else 300
FIRST = 5        # first data row on every register
FREE_LINES = LIC.FREE_LINES                  # Free plan: first N lines of Sales / Purchases / CashBook
FREE_LAST = FIRST + FREE_LINES - 1

def last(n):
    return FIRST + n - 1

TX_END, ADJ_END, IT_END, PT_END = last(N_TX), last(N_ADJ), last(N_ITEMS), last(N_PARTIES)

# ---------------------------------------------------------------- styles
FONT = "Arial"
NAVY, TEAL, LIGHT, INPUT_FILL, CALC_FILL = "1F3864", "0E7C86", "EEF3FA", "FFF8DC", "F2F2F2"
f_title = Font(name=FONT, size=16, bold=True, color="FFFFFF")
f_sub = Font(name=FONT, size=9, italic=True, color="FFFFFF")
f_head = Font(name=FONT, size=10, bold=True, color="FFFFFF")
f_in = Font(name=FONT, size=10, color="0000FF")
f_calc = Font(name=FONT, size=10, color="000000")
f_link = Font(name=FONT, size=10, color="008000")
f_bold = Font(name=FONT, size=10, bold=True)
fill = lambda c: PatternFill("solid", start_color=c, end_color=c)
thin = Side(style="thin", color="BFBFBF")
box = Border(left=thin, right=thin, top=thin, bottom=thin)
center = Alignment(horizontal="center", vertical="center", wrap_text=True)

INR = '"₹"#,##0.00;[Red]-"₹"#,##0.00;"-"'
INR0 = '"₹"#,##0;[Red]-"₹"#,##0;"-"'
QTY = '#,##0.##;[Red]-#,##0.##;"-"'
PCT = '0.0%;[Red]-0.0%;"-"'
DATE = 'dd-mmm-yy;;"-"'

wb = Workbook()
wb.remove(wb.active)


def banner(ws, title, subtitle, width):
    ws.sheet_view.showGridLines = False
    end = get_column_letter(width)
    ws.merge_cells(f"A1:{end}1")
    ws.merge_cells(f"A2:{end}2")
    ws["A1"] = title
    ws["A1"].font = f_title
    ws["A2"] = subtitle
    ws["A2"].font = f_sub
    for r in (1, 2):
        for c in range(1, width + 1):
            ws.cell(r, c).fill = fill(NAVY)
    ws["A1"].alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 28
    ws.cell(1, width + 2).value = "« Home"
    ws.cell(1, width + 2).hyperlink = "#Dashboard!A1"
    ws.cell(1, width + 2).font = Font(name=FONT, bold=True, color="0563C1", underline="single")


def register(ws, headers, n_rows, input_cols):
    """headers: list of (name, width, fmt). input_cols: number of leading input columns."""
    for i, (name, width, fmt) in enumerate(headers, start=1):
        c = ws.cell(4, i, name)
        c.font = f_head
        c.fill = fill(TEAL if i <= input_cols else "595959")
        c.alignment = center
        c.border = box
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.cell(3, 1, "Blue / cream = type here").font = Font(name=FONT, size=8, color="0000FF")
    ws.cell(3, input_cols + 1, "Grey = automatic (do not type)").font = Font(name=FONT, size=8, color="595959")
    ws.row_dimensions[4].height = 32
    ws.freeze_panes = ws.cell(FIRST, 1)
    ws.auto_filter.ref = f"A4:{get_column_letter(len(headers))}{FIRST + n_rows - 1}"
    if C_ENGINE:
        # column-level styles keep a 20k-row file small; written cells get styled in finish_styles()
        for i, (_, _, fmt) in enumerate(headers, start=1):
            cd = ws.column_dimensions[get_column_letter(i)]
            cd.font = f_in if i <= input_cols else f_calc
            if i <= input_cols:
                cd.fill = fill(INPUT_FILL)
            if fmt:
                cd.number_format = fmt
            if ws.cell(3, i).value is None:
                ws.cell(3, i).fill = fill("FFFFFF")
        return
    for r in range(FIRST, FIRST + n_rows):
        for i, (_, _, fmt) in enumerate(headers, start=1):
            c = ws.cell(r, i)
            if fmt:
                c.number_format = fmt
            if i <= input_cols:
                c.font = f_in
                c.fill = fill(INPUT_FILL)
            else:
                c.font = f_calc


def add_list_dv(ws, rng, source, prompt=None, strict=True):
    dv = DataValidation(type="list", formula1=source, allow_blank=True,
                        showErrorMessage=strict, errorStyle="stop" if strict else "warning")
    dv.error = "Pick a value from the list (add new masters on the master sheet first)."
    if prompt:
        dv.prompt, dv.showInputMessage = prompt, True
    ws.add_data_validation(dv)
    dv.add(rng)


def name(n, ref):
    wb.defined_names[n] = DefinedName(n, attr_text=ref)


# WhatsApp click-to-chat links. Excel 2007 has no ENCODEURL, so the few characters that
# break a URL are replaced by hand; HYPERLINK accepts at most 255 characters.
def url_enc(x):
    for a, b in (("%", "%25"), ("&", "%26"), ("#", "%23"), ("+", "%2B"), ("?", "%3F"), ('""', "%22"), (" ", "%20")):
        x = f'SUBSTITUTE({x},"{a}","{b}")'
    return f'SUBSTITUTE({x},CHAR(10),"%0A")'


def wa_digits(phone):
    """phone cell -> digits only"""
    x = f"{phone}&\"\""
    for ch in (" ", "+", "-", ".", "(", ")"):
        x = f'SUBSTITUTE({x},"{ch}","")'
    return x


def wa_number(d):
    """digits cell -> number with country code (10-digit Indian mobiles get 91)"""
    return f'IF(LEN({d})=10,"91"&{d},IF(AND(LEN({d})=11,LEFT({d},1)="0"),"91"&MID({d},2,10),{d}))'


def wa_link(url, num, label):
    return f'IF({url}="","",HYPERLINK(IF(LEN({url})>255,"https://wa.me/"&{num},{url}),"{label}"))'


def wa_block(ws, phone, text, cells, link_cell, label):
    """four cells: digits, number, url (hidden helpers) and the visible link"""
    d, n, u = cells
    ws[d] = f'=IF({phone}&""="","",{wa_digits(phone)})'
    ws[n] = f'=IF({d}="","",{wa_number(d)})'
    ws[u] = f'=IF({n}="","","https://wa.me/"&{n}&"?text="&{url_enc(text)})'
    ws[link_cell] = "=" + wa_link(u, n, label)
    ws[link_cell].font = Font(name=FONT, size=10, bold=True, color="0563C1", underline="single")
    for c in cells:
        ws[c].font = Font(name=FONT, size=7, color="BFBFBF")


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
         "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]
WORDS99 = [_ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")) for n in range(100)]


def amount_words(ref):
    """Indian amount in words (crore / lakh / thousand), formula only - no macro needed"""
    x = f"ABS(ROUND({ref},0))"
    part = lambda v, unit: f'IF({v}>0,IF({v}<100,INDEX(W99,{v}+1),{v})&" {unit} ","")'
    words = "&".join([part(f"INT({x}/10000000)", "Crore"), part(f"INT(MOD({x},10000000)/100000)", "Lakh"),
                      part(f"INT(MOD({x},100000)/1000)", "Thousand"), part(f"INT(MOD({x},1000)/100)", "Hundred"),
                      f"INDEX(W99,MOD({x},100)+1)"])
    return f'"Rupees "&TRIM({words})&" Only"'


def head_row(ws, r, labels, c0=1, color=None, height=30):
    for j, h in enumerate(labels):
        c = ws.cell(r, c0 + j, h)
        c.font, c.fill, c.alignment, c.border = f_head, fill(color or TEAL), center, box
    ws.row_dimensions[r].height = height


def section(ws, ref, text, size=11):
    ws[ref] = text
    ws[ref].font = Font(name=FONT, size=size, bold=True, color=NAVY)


def home_link(ws, ref):
    ws[ref] = "« Home"
    ws[ref].hyperlink = "#Dashboard!A1"
    ws[ref].font = Font(name=FONT, bold=True, color="0563C1", underline="single")


def in_cell(c, fmt=None):
    c.fill, c.font, c.border = fill(INPUT_FILL), Font(name=FONT, size=11, bold=True, color="0000FF"), box
    if fmt:
        c.number_format = fmt


def calc(ws, ref, f, fmt=None, bold=False):
    ws[ref] = f
    ws[ref].border, ws[ref].font = box, f_bold if bold else f_calc
    if fmt:
        ws[ref].number_format = fmt


# =================================================================== SETTINGS
st = wb.create_sheet("Settings")
banner(st, "SETTINGS & MASTER LISTS", "Set this up once. Every list here feeds the dropdowns across the ERP.", 16)
st.column_dimensions["A"].width = 26
st.column_dimensions["B"].width = 34
settings = [
    ("Company Name", "Your Trading Co.", None),
    ("Address", "Shop 12, Main Market, Jaipur", None),
    ("GSTIN", "08ABCDE1234F1Z5", None),
    ("Home State (for GST)", "Rajasthan", None),
    ("Phone / Email", "+91 98xxxxxx00", None),
    ("Financial Year Start", date(2026, 4, 1), DATE),
    ("Report As-Of Date", "=TODAY()", DATE),
    ("Invoice Prefix", "INV-", None),
    ("Dead-Stock Threshold (days)", 90, "0"),
    ("Bank Details (on invoice)", "SBI A/c 0000000000 · IFSC SBIN0000000", None),
    ("PRO: Registered Mobile No.", LIC_ID, "@"),
    ("PRO: License Key", LIC_KEY, "@"),
]
for i, (k, v, fmt) in enumerate(settings):
    r = 4 + i
    st.cell(r, 1, k).font = f_bold
    c = st.cell(r, 2, v)
    c.font = f_calc if isinstance(v, str) and v.startswith("=") else f_in
    c.fill = fill(INPUT_FILL)
    c.border = box
    if fmt:
        c.number_format = fmt
st["B15"].comment = Comment("Paste the key you received after buying Pro, e.g. PRO-H270415-7QZ4. "
                            "It works only with the mobile number above. See the Plans sheet.", "ERP")
st["B10"].comment = Comment("Leave as =TODAY() for live reports, or type a fixed date to view history. "
                            "This is the ONLY volatile formula in the workbook.", "ERP")
for n, ref in [("CoName", "$B$4"), ("CoAddr", "$B$5"), ("CoGSTIN", "$B$6"), ("HomeState", "$B$7"),
               ("CoPhone", "$B$8"), ("FYStart", "$B$9"), ("AsOf", "$B$10"), ("InvPrefix", "$B$11"),
               ("DeadDays", "$B$12"), ("CoBank", "$B$13"), ("LicId", "$B$14"), ("LicKey", "$B$15")]:
    name(n, f"Settings!{ref}")

# Accounts with opening balances
st["A16"] = "Cash / Bank Accounts"
st["A16"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
for j, h in enumerate(["Account", "Opening Balance (₹)"]):
    c = st.cell(17, 1 + j, h)
    c.font, c.fill, c.border = f_head, fill(TEAL), box
accounts = [("Cash", 50000), ("Bank", 250000), ("UPI", 0)]
for i in range(8):
    for j in range(2):
        c = st.cell(18 + i, 1 + j)
        c.font, c.fill, c.border = f_in, fill(INPUT_FILL), box
        if j == 1:
            c.number_format = INR
    if i < len(accounts):
        st.cell(18 + i, 1, accounts[i][0])
        st.cell(18 + i, 2, accounts[i][1])
st["A27"] = "Opening balances are your figures on FY start - replace the sample values."
st["A27"].font = Font(name=FONT, size=8, italic=True)

# Planning & alerts (B30:B31 also feed the C engine: purchase-order quantities)
st["A29"] = "Planning & Alerts"
st["A29"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
planning = [
    ("Supplier lead time (days)", 7, "0", "LeadDays", "Days a supplier takes to deliver. Used for purchase-order quantities."),
    ("Keep stock for (days of sales)", 30, "0", "CoverDays", "After an order arrives you want this many days of sales in stock."),
    ("Interest on overdue money (% a year)", 0.18, "0%", "IntRate", "Cost of money stuck with customers (Profit Leaks) and the rate printed on statements."),
    ("Overdue dues collected in week 1 (%)", 0.5, "0%", "CollectPct", "Cash-flow forecast: share of already-overdue receivables you expect to collect next week."),
    ("UPI ID (printed on receipts)", "yourshop@upi", "@", "UpiId", "Shown on the thermal receipt and in WhatsApp messages."),
    ("Payment terms on invoices (days)", 15, "0", "TermsDays", "Due date printed on invoices and quotations."),
]
for i, (k, v, fmt, nm, tip) in enumerate(planning):
    r = 30 + i
    st.cell(r, 1, k).font = f_bold
    c = st.cell(r, 2, v)
    c.font, c.fill, c.border, c.number_format = f_in, fill(INPUT_FILL), box, fmt
    c.comment = Comment(tip, "ERP")
    name(nm, f"Settings!$B${r}")

lists = {
    "D": ("Categories", ["Grocery", "FMCG", "Electrical", "Hardware", "Stationery", "Garments", "Other"]),
    "E": ("Units", ["Pcs", "Kg", "Ltr", "Box", "Bag", "Mtr", "Dozen", "Pack"]),
    "F": ("GST Rates", [0, 0.05, 0.12, 0.18, 0.28, 0.40, 0.03, 0.0025]),
    "G": ("Pay Modes", ["Credit", "Cash", "Bank", "UPI"]),
    "H": ("Voucher Types", ["Receipt", "Payment", "Expense", "Other Income", "Capital In",
                             "Drawings", "Transfer In", "Transfer Out", "GST Paid"]),
    "I": ("Expense Heads", ["Rent", "Salary", "Electricity", "Transport / Freight", "Packing",
                             "Telephone / Internet", "Repairs", "Bank Charges", "Misc"]),
    "J": ("Party Types", ["Customer", "Supplier", "Both"]),
    "N": ("MSME Types", ["Micro", "Small", "Medium", "Not MSME"]),
    "O": ("Yes No", ["Yes", "No"]),
    "P": ("Doc Types", ["Quotation", "Estimate", "Proforma Invoice", "Sales Order", "Delivery Challan"]),
    "K": ("Delivery Status", ["Pending", "Packed", "Dispatched", "Delivered", "Returned"]),
    "L": ("Adj. Reasons", ["Damage", "Expiry", "Theft / Loss", "Count Correction", "Sample / Free",
                            "Sales Return", "Purchase Return", "Opening Fix"]),
}
STATES = ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
          "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
          "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan",
          "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
          "Delhi", "Jammu and Kashmir", "Ladakh", "Puducherry", "Chandigarh",
          "Dadra & Nagar Haveli and Daman & Diu", "Lakshadweep", "Andaman & Nicobar"]
lists["M"] = ("States", STATES)
LIST_ROWS = 40
for col, (title, vals) in lists.items():
    st.column_dimensions[col].width = 17 if col != "M" else 30
    h = st[f"{col}4"]
    h.value, h.font, h.fill, h.alignment = title, f_head, fill(TEAL), center
    for i in range(LIST_ROWS):
        c = st[f"{col}{5 + i}"]
        c.font, c.fill, c.border = f_in, fill(INPUT_FILL), box
        if i < len(vals):
            c.value = vals[i]
        if col == "F":
            c.number_format = "0.##%"
    # dynamic name: grows as the user adds entries (contiguous list)
    nm = title.replace(" ", "").replace(".", "")
    name(f"L_{nm}", f"OFFSET(Settings!${col}$5,0,0,MAX(1,COUNTA(Settings!${col}$5:${col}${4 + LIST_ROWS})),1)")
name("L_Accounts", "OFFSET(Settings!$A$18,0,0,MAX(1,COUNTA(Settings!$A$18:$A$25)),1)")
st["F3"] = "GST slabs: 5/18/40% apply post GST-2.0 (Sep-2025); 12/28% kept for legacy items."
st["F3"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== ITEMS
it = wb.create_sheet("Items")
it_headers = [
    ("Item Name *", 28, None), ("SKU / Barcode", 13, None), ("Category", 12, None), ("Unit", 7, None),
    ("HSN", 9, None), ("GST %", 7, "0.##%"), ("Std Purchase Rate (₹)", 11, INR), ("Std Sale Rate (₹)", 11, INR),
    ("Reorder Level", 9, QTY), ("Opening Qty", 9, QTY), ("Opening Rate (₹)", 10, INR),
    # computed from L
    ("Purchased Qty", 10, QTY), ("Sold Qty", 9, QTY), ("Adjust Qty", 9, QTY), ("Closing Stock", 10, QTY),
    ("Avg Cost (₹)", 10, INR), ("Stock Value (₹)", 12, INR), ("Status", 13, None), ("Margin %", 8, PCT),
    ("Suggested Order Qty", 10, QTY), ("Sales Value (₹)", 12, INR), ("Gross Profit (₹)", 12, INR),
    ("Last Sold", 10, DATE), ("Days Since Sale", 8, "0"), ("Days of Cover", 8, "0"), ("rank key", 6, None),
    ("Sold Last 30 Days", 9, QTY), ("Last Supplier", 20, None), ("Last Purchase Rate (₹)", 10, INR),
    ("Stock Runs Out In (days)", 9, "0"), ("Order Now Qty", 9, QTY),
    ("hsnFirst", 6, None), ("lastBuyRow", 6, None),
]
banner(it, "ITEM MASTER & LIVE STOCK",
       "One row per product. Stock, cost, value and reorder alerts update automatically from Purchases, Sales and Adjustments.",
       len(it_headers))
register(it, it_headers, N_ITEMS, 11)
it.column_dimensions["Z"].hidden = True
it.column_dimensions["AF"].hidden = True
it.column_dimensions["AG"].hidden = True
it["AA4"].comment = Comment("Quantity sold in the 30 days up to the report date (Settings B10).", "ERP")
it["AE4"].comment = Comment("Order this much now so stock lasts lead time + cover days (Settings B30:B31) "
                            "and stays above the reorder level. The Purchase Order sheet lists these by supplier.", "ERP")

# Register ranges end at INDEX(..., TxRows): the whole register on Pro, the first FREE_LINES rows
# on Free. INDEX-built ranges are non-volatile and work in every Excel since 2007.
def _reg(sheet, col):
    return f"{sheet}!${col}${FIRST}:INDEX({sheet}!${col}${FIRST}:${col}${TX_END},TxRows)"


S = lambda col: _reg("Sales", col)
P = lambda col: _reg("Purchases", col)
A_ = lambda col: f"Adjustments!${col}${FIRST}:${col}${ADJ_END}"
C_ = lambda col: _reg("CashBook", col)
I_ = lambda col: f"Items!${col}${FIRST}:${col}${IT_END}"
PT = lambda col: f"Parties!${col}${FIRST}:${col}${PT_END}"
CO = lambda col: f"Collections!${col}${FIRST}:${col}${PT_END}"

for r in (range(FIRST, IT_END + 1) if not C_ENGINE else ()):
    g = f'IF($A{r}="","",'
    it[f"L{r}"] = f"={g}SUMIFS({P('E')},{P('D')},$A{r}))"
    it[f"M{r}"] = f"={g}SUMIFS({S('E')},{S('D')},$A{r}))"
    it[f"N{r}"] = f"={g}SUMIFS({A_('C')},{A_('B')},$A{r}))"
    it[f"O{r}"] = f"={g}N($J{r})+L{r}-M{r}+N{r})"
    it[f"P{r}"] = f"={g}IFERROR((N($J{r})*N($K{r})+SUMIFS({P('K')},{P('D')},$A{r}))/(N($J{r})+L{r}),N($G{r})))"
    it[f"Q{r}"] = f"={g}MAX(0,O{r})*P{r})"
    it[f"R{r}"] = f'={g}IF(O{r}<0,"NEGATIVE",IF(O{r}=0,"OUT OF STOCK",IF(O{r}<=N($I{r}),"REORDER",IF(AND(O{r}>0,X{r}>DeadDays),"DEAD STOCK","OK")))))'
    it[f"S{r}"] = f"={g}IF(N($H{r})=0,0,(N($H{r})-P{r})/N($H{r})))"
    it[f"T{r}"] = f"={g}IF(O{r}<=N($I{r}),MAX(0,2*N($I{r})-O{r}),0))"
    it[f"U{r}"] = f"={g}SUMIFS({S('L')},{S('D')},$A{r}))"
    it[f"V{r}"] = f"={g}SUMIFS({S('S')},{S('D')},$A{r}))"
    it[f"W{r}"] = f"={g}IFERROR(SUMPRODUCT(MAX(({S('D')}=$A{r})*{S('A')})),0))"
    it[f"X{r}"] = f"={g}IF(W{r}=0,AsOf-FYStart,AsOf-W{r}))"
    it[f"Y{r}"] = f'={g}IF(M{r}=0,"",O{r}/(M{r}/MAX(1,AsOf-FYStart))))'
    it[f"Z{r}"] = f'={g}U{r}+ROW()/1000000)'
    it[f"AA{r}"] = f'={g}SUMIFS({S("E")},{S("D")},$A{r},{S("A")},">"&(AsOf-30),{S("A")},"<="&AsOf))'
    it[f"AG{r}"] = f"={g}SUMPRODUCT(MAX(({P('D')}=$A{r})*ROW({P('D')}))))"
    it[f"AB{r}"] = f'={g}IF(AG{r}=0,"",INDEX(Purchases!$C$1:$C${TX_END},AG{r})&""))'
    it[f"AC{r}"] = f'={g}IF(AG{r}=0,N($G{r}),INDEX(Purchases!$J$1:$J${TX_END},AG{r})))'
    it[f"AD{r}"] = f'={g}IF(AA{r}=0,"",MAX(0,O{r})/(AA{r}/30)))'
    it[f"AE{r}"] = f'={g}MAX(0,ROUND(AA{r}/30*(LeadDays+CoverDays)+N($I{r})-O{r},0)))'
# first item of each HSN code (both editions): feeds the HSN summary on the GST sheet
for r in range(FIRST, IT_END + 1):
    it[f"AF{r}"] = f'=IF($E{r}&""="","",IF(COUNTIF($E${FIRST}:$E{r},$E{r})=1,ROW(),""))'
name("L_Items", f"OFFSET(Items!$A${FIRST},0,0,MAX(1,COUNTA(Items!$A${FIRST}:$A${IT_END})),1)")
add_list_dv(it, f"C{FIRST}:C{IT_END}", "L_Categories")
add_list_dv(it, f"D{FIRST}:D{IT_END}", "L_Units")
add_list_dv(it, f"F{FIRST}:F{IT_END}", "L_GSTRates")
dv = DataValidation(type="custom", formula1=f"COUNTIF($A${FIRST}:$A${IT_END},A{FIRST})=1", allow_blank=True)
dv.error, dv.showErrorMessage = "This item name already exists. Item names must be unique.", True
it.add_data_validation(dv)
dv.add(f"A{FIRST}:A{IT_END}")
rng = f"R{FIRST}:R{IT_END}"
for txt, color in [("NEGATIVE", "FF7C80"), ("OUT OF STOCK", "FFC7CE"), ("REORDER", "FFEB9C"),
                   ("DEAD STOCK", "D9D2E9"), ("OK", "C6EFCE")]:
    it.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=[f'"{txt}"'], fill=fill(color)))

# =================================================================== PARTIES
pt = wb.create_sheet("Parties")
pt_headers = [
    ("Party Name *", 26, None), ("Type", 10, None), ("Phone", 13, None), ("GSTIN", 17, None),
    ("State", 15, None), ("Address", 24, None), ("Credit Limit (₹)", 11, INR0), ("Credit Days", 8, "0"),
    ("Opening Bal (₹) +recv / -pay", 12, INR), ("MSME (Udyam)", 9, None), ("Written Pay Agreement", 9, None),
    ("Credit Sales (₹)", 12, INR), ("Received (₹)", 12, INR), ("Credit Purchases (₹)", 12, INR),
    ("Paid (₹)", 12, INR), ("Balance (₹)", 13, INR), ("Position", 11, None), ("Last Sale", 10, DATE),
    ("Last Receipt", 10, DATE), ("Days Unpaid", 8, "0"), ("Alert", 14, None),
]
banner(pt, "CUSTOMERS & SUPPLIERS (PARTY LEDGER)",
       "Balance > 0 means the party owes you (receivable); < 0 means you owe them (payable).", len(pt_headers))
register(pt, pt_headers, N_PARTIES, 11)
for r in (range(FIRST, PT_END + 1) if not C_ENGINE else ()):
    g = f'IF($A{r}="","",'
    pt[f"L{r}"] = f"={g}SUMIFS({S('Q')},{S('C')},$A{r})-SUMIFS({S('X')},{S('C')},$A{r}))"
    pt[f"M{r}"] = f'={g}SUMIFS({C_("G")},{C_("D")},$A{r},{C_("C")},"Receipt"))'
    pt[f"N{r}"] = f"={g}SUMIFS({P('P')},{P('C')},$A{r})-SUMIFS({P('S')},{P('C')},$A{r}))"
    pt[f"O{r}"] = f'={g}SUMIFS({C_("G")},{C_("D")},$A{r},{C_("C")},"Payment"))'
    pt[f"P{r}"] = f"={g}N($I{r})+L{r}-M{r}-N{r}+O{r})"
    pt[f"Q{r}"] = f'={g}IF(ROUND(P{r},2)>0,"Receivable",IF(ROUND(P{r},2)<0,"Payable","Settled")))'
    pt[f"R{r}"] = f"={g}IFERROR(SUMPRODUCT(MAX(({S('C')}=$A{r})*{S('A')})),0))"
    pt[f"S{r}"] = f'={g}IFERROR(SUMPRODUCT(MAX(({C_("D")}=$A{r})*({C_("C")}="Receipt")*{C_("A")})),0))'
    pt[f"T{r}"] = f'={g}IF(ROUND(P{r},2)<=0,"",AsOf-IF(N(S{r})>0,S{r},IF(N(R{r})>0,R{r},FYStart))))'
    pt[f"U{r}"] = (f'={g}IF(AND(N($G{r})>0,P{r}>N($G{r})),"OVER LIMIT",'
                   f'IF(AND(P{r}>0,N(T{r})>N($H{r})),"OVERDUE",IF(ROUND(P{r},2)<0,"PAY DUE",""))))')
pt["T4"].comment = Comment("Days since the last receipt from this party (or since the last sale if nothing was ever received). OVERDUE when this exceeds Credit Days.", "ERP")
pt["J4"].comment = Comment("For suppliers registered under the MSMED Act (Udyam). Micro and Small suppliers must be paid within "
                           "15 days, or the agreed days (at most 45) if there is a written agreement - otherwise the purchase "
                           "is not deductible this year under Income-tax section 43B(h). See the Collections sheet.", "ERP")
pt["K4"].comment = Comment("Yes = you have a written agreement with this MSME supplier for Credit Days (max 45 count). "
                           "No / blank = the law allows only 15 days.", "ERP")
name("L_Parties", f"OFFSET(Parties!$A${FIRST},0,0,MAX(1,COUNTA(Parties!$A${FIRST}:$A${PT_END})),1)")
add_list_dv(pt, f"B{FIRST}:B{PT_END}", "L_PartyTypes")
add_list_dv(pt, f"E{FIRST}:E{PT_END}", "L_States")
add_list_dv(pt, f"J{FIRST}:J{PT_END}", "L_MSMETypes")
add_list_dv(pt, f"K{FIRST}:K{PT_END}", "L_YesNo")
dv = DataValidation(type="custom", formula1=f"COUNTIF($A${FIRST}:$A${PT_END},A{FIRST})=1", allow_blank=True)
dv.error, dv.showErrorMessage = "This party already exists. Party names must be unique.", True
pt.add_data_validation(dv)
dv.add(f"A{FIRST}:A{PT_END}")
rng = f"U{FIRST}:U{PT_END}"
for txt, color in [("OVER LIMIT", "FF7C80"), ("OVERDUE", "FFC7CE"), ("PAY DUE", "FFEB9C")]:
    pt.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=[f'"{txt}"'], fill=fill(color)))


# ======================================================= PURCHASES / SALES helpers
def gst_cols(ws, r, party_row, taxable, rate, cgst, sgst, igst):
    inter = f'AND({party_row}<>"",INDEX({PT("E")},{party_row})<>"",INDEX({PT("E")},{party_row})<>HomeState)'
    ws[f"{cgst}{r}"] = f'=IF($D{r}="","",IF({inter},0,ROUND({taxable}{r}*{rate}{r}/2,2)))'
    ws[f"{sgst}{r}"] = f'=IF($D{r}="","",{cgst}{r})'
    ws[f"{igst}{r}"] = f'=IF($D{r}="","",IF({inter},ROUND({taxable}{r}*{rate}{r},2),0))'


# =================================================================== PURCHASES
pu = wb.create_sheet("Purchases")
pu_headers = [
    ("Date *", 10, DATE), ("Bill No *", 11, None), ("Supplier *", 22, None), ("Item *", 24, None),
    ("Qty *", 8, QTY), ("Rate (₹) blank=std", 10, INR), ("Disc %", 7, PCT), ("Paid Via (blank=Credit)", 10, None),
    ("Unit", 6, None), ("Rate Used (₹)", 10, INR), ("Taxable (₹)", 12, INR), ("GST %", 7, "0.##%"),
    ("CGST (₹)", 10, INR), ("SGST (₹)", 10, INR), ("IGST (₹)", 10, INR), ("Bill Total (₹)", 12, INR),
    ("itemRow", 6, None), ("partyRow", 6, None), ("Paid Now (₹)", 11, INR),
]
banner(pu, "PURCHASES / GOODS RECEIVED (PROCURE)",
       "One line per item received. Stock, average cost, payable and GST credit update instantly. Minus qty = purchase return (debit note).",
       len(pu_headers))
register(pu, pu_headers, N_TX, 8)
for r in (range(FIRST, TX_END + 1) if not C_ENGINE else ()):
    g = f'IF($D{r}="","",'
    pu[f"Q{r}"] = f'={g}IFERROR(MATCH($D{r},{I_("A")},0),""))'
    pu[f"R{r}"] = f'=IF($C{r}="","",IFERROR(MATCH($C{r},{PT("A")},0),""))'
    pu[f"I{r}"] = f'={g}IFERROR(INDEX({I_("D")},Q{r}),""))'
    pu[f"J{r}"] = f'={g}IF($F{r}="",IFERROR(INDEX({I_("G")},Q{r}),0),$F{r}))'
    pu[f"K{r}"] = f"={g}ROUND(N($E{r})*J{r}*(1-N($G{r})),2))"
    pu[f"L{r}"] = f'={g}IFERROR(INDEX({I_("F")},Q{r}),0))'
    gst_cols(pu, r, f"R{r}", "K", "L", "M", "N", "O")
    pu[f"P{r}"] = f"={g}K{r}+M{r}+N{r}+O{r})"
    pu[f"S{r}"] = f'={g}IF(OR($H{r}="",$H{r}="Credit"),0,P{r}))'
pu.column_dimensions["Q"].hidden = True
pu.column_dimensions["R"].hidden = True

# =================================================================== SALES
sa = wb.create_sheet("Sales")
sa_headers = [
    ("Date *", 10, DATE), ("Invoice No *", 11, None), ("Customer *", 22, None), ("Item *", 24, None),
    ("Qty *", 8, QTY), ("Rate (₹) blank=std", 10, INR), ("Disc %", 7, PCT), ("Paid Via (blank=Credit)", 10, None),
    ("Delivery", 10, None),
    ("Unit", 6, None), ("Rate Used (₹)", 10, INR), ("Taxable (₹)", 12, INR), ("GST %", 7, "0.##%"),
    ("CGST (₹)", 10, INR), ("SGST (₹)", 10, INR), ("IGST (₹)", 10, INR), ("Line Total (₹)", 12, INR),
    ("COGS (₹)", 11, INR), ("Profit (₹)", 11, INR), ("Stock Check", 12, None),
    ("itemRow", 6, None), ("partyRow", 6, None), ("invNum", 6, None), ("Paid Now (₹)", 11, INR),
    ("B2B / B2C", 7, None), ("HSN", 9, None),
]
banner(sa, "SALES / INVOICES (DELIVER)",
       "One line per item sold. Keep all lines of an invoice together. Rate blank = standard rate. Minus qty = sales return (credit note).",
       len(sa_headers))
register(sa, sa_headers, N_TX, 9)
for r in (range(FIRST, TX_END + 1) if not C_ENGINE else ()):
    g = f'IF($D{r}="","",'
    sa[f"U{r}"] = f'={g}IFERROR(MATCH($D{r},{I_("A")},0),""))'
    sa[f"V{r}"] = f'=IF($C{r}="","",IFERROR(MATCH($C{r},{PT("A")},0),""))'
    sa[f"W{r}"] = f'=IF($B{r}="","",IFERROR(VALUE(SUBSTITUTE($B{r},InvPrefix,"")),0))'
    sa[f"J{r}"] = f'={g}IFERROR(INDEX({I_("D")},U{r}),""))'
    sa[f"K{r}"] = f'={g}IF($F{r}="",IFERROR(INDEX({I_("H")},U{r}),0),$F{r}))'
    sa[f"L{r}"] = f"={g}ROUND(N($E{r})*K{r}*(1-N($G{r})),2))"
    sa[f"M{r}"] = f'={g}IFERROR(INDEX({I_("F")},U{r}),0))'
    gst_cols(sa, r, f"V{r}", "L", "M", "N", "O", "P")
    sa[f"Q{r}"] = f"={g}L{r}+N{r}+O{r}+P{r})"
    sa[f"R{r}"] = f'={g}ROUND(N($E{r})*IFERROR(INDEX({I_("P")},U{r}),0),2))'
    sa[f"S{r}"] = f"={g}L{r}-R{r})"
    sa[f"T{r}"] = (f'={g}IF(U{r}="","UNKNOWN ITEM",IF(N($E{r})<0,"RETURN",IF(INDEX({I_("O")},U{r})<0,"NEG STOCK",'
                   f'IF(K{r}<INDEX({I_("P")},U{r}),"BELOW COST","OK")))))')
    sa[f"X{r}"] = f'={g}IF(OR($H{r}="",$H{r}="Credit"),0,Q{r}))'
    sa[f"Y{r}"] = f'={g}IF(V{r}="","B2C",IF(INDEX({PT("D")},V{r})&""="","B2C","B2B")))'
    sa[f"Z{r}"] = f'={g}IFERROR(INDEX({I_("E")},U{r})&"",""))'
for col in "UVW":
    sa.column_dimensions[col].hidden = True
rng = f"T{FIRST}:T{TX_END}"
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"NEG STOCK"'], fill=fill("FFC7CE")))
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"BELOW COST"'], fill=fill("FFEB9C")))
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"UNKNOWN ITEM"'], fill=fill("FF7C80")))
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"RETURN"'], fill=fill("DDEBF7")))
sa.conditional_formatting.add(f"I{FIRST}:I{TX_END}", CellIsRule(operator="equal", formula=['"Pending"'], fill=fill("FFEB9C")))
# band alternate invoices for readability
sa.conditional_formatting.add(f"A{FIRST}:I{TX_END}",
                              FormulaRule(formula=[f'AND($B{FIRST}<>"",ISODD(N($W{FIRST})))'], fill=fill("FFF1C1")))

for ws in (pu, sa):
    add_list_dv(ws, f"C{FIRST}:C{TX_END}", "L_Parties", "Pick a party (add new ones on the Parties sheet)")
    add_list_dv(ws, f"D{FIRST}:D{TX_END}", "L_Items", "Pick an item (add new ones on the Items sheet)")
    add_list_dv(ws, f"H{FIRST}:H{TX_END}", "L_PayModes")
    dv = DataValidation(type="decimal", operator="notEqual", formula1="0", allow_blank=True)
    dv.error, dv.showErrorMessage = "Quantity cannot be 0. Type a minus quantity for a return (credit / debit note).", True
    ws.add_data_validation(dv)
    dv.add(f"E{FIRST}:E{TX_END}")
    dv = DataValidation(type="date", operator="greaterThan", formula1="36526", allow_blank=True)
    dv.error, dv.showErrorMessage = "Enter a valid date, e.g. 15-Apr-2026 or Ctrl+; for today.", True
    ws.add_data_validation(dv)
    dv.add(f"A{FIRST}:A{TX_END}")
add_list_dv(sa, f"I{FIRST}:I{TX_END}", "L_DeliveryStatus")

# =================================================================== CASH BOOK
cb = wb.create_sheet("CashBook")
cb_headers = [
    ("Date *", 10, DATE), ("Voucher No", 10, None), ("Type *", 13, None), ("Party (Receipt/Payment)", 22, None),
    ("Expense / Income Head", 18, None), ("Account *", 9, None), ("Amount (₹) *", 12, INR),
    ("Reference / Notes", 26, None), ("Money In (₹)", 12, INR), ("Money Out (₹)", 12, INR),
    ("Check", 18, None),
]
banner(cb, "CASH & BANK BOOK (FINANCE)",
       "Customer receipts, supplier payments, expenses, owner capital/drawings and transfers between accounts.",
       len(cb_headers))
register(cb, cb_headers, N_TX, 8)
IN_TYPES = '{"Receipt","Other Income","Capital In","Transfer In"}'
for r in (range(FIRST, TX_END + 1) if not C_ENGINE else ()):
    g = f'IF(OR($C{r}="",N($G{r})=0),"",'
    cb[f"I{r}"] = f'={g}IF(OR($C{r}="Receipt",$C{r}="Other Income",$C{r}="Capital In",$C{r}="Transfer In"),$G{r},0))'
    cb[f"J{r}"] = f'={g}IF(I{r}=0,$G{r},0))'
    cb[f"K{r}"] = (f'=IF($C{r}="","",IF(AND(OR($C{r}="Receipt",$C{r}="Payment"),$D{r}=""),"Party needed",'
                   f'IF(AND(OR($C{r}="Expense",$C{r}="Other Income"),$E{r}=""),"Head needed",'
                   f'IF($F{r}="","Account needed","OK"))))')
add_list_dv(cb, f"C{FIRST}:C{TX_END}", "L_VoucherTypes")
add_list_dv(cb, f"D{FIRST}:D{TX_END}", "L_Parties")
add_list_dv(cb, f"E{FIRST}:E{TX_END}", "L_ExpenseHeads", strict=False)
add_list_dv(cb, f"F{FIRST}:F{TX_END}", "L_Accounts")
cb.conditional_formatting.add(f"K{FIRST}:K{TX_END}",
                              FormulaRule(formula=[f'AND(K{FIRST}<>"",K{FIRST}<>"OK")'], fill=fill("FFC7CE")))

# =================================================================== ADJUSTMENTS
ad = wb.create_sheet("Adjustments")
ad_headers = [("Date *", 10, DATE), ("Item *", 26, None), ("Qty (+in / -out) *", 11, QTY), ("Reason *", 16, None),
              ("Notes", 28, None), ("Avg Cost (₹)", 11, INR), ("Value Impact (₹)", 13, INR)]
banner(ad, "STOCK ADJUSTMENTS",
       "Damage, expiry, physical-count corrections, returns. Negative qty reduces stock and is booked as a loss.",
       len(ad_headers))
register(ad, ad_headers, N_ADJ, 5)
for r in (range(FIRST, ADJ_END + 1) if not C_ENGINE else ()):
    ad[f"F{r}"] = f'=IF($B{r}="","",IFERROR(INDEX({I_("P")},MATCH($B{r},{I_("A")},0)),0))'
    ad[f"G{r}"] = f'=IF($B{r}="","",ROUND(N($C{r})*F{r},2))'
add_list_dv(ad, f"B{FIRST}:B{ADJ_END}", "L_Items")
add_list_dv(ad, f"D{FIRST}:D{ADJ_END}", "L_AdjReasons")

# =================================================================== PLAN GATING
def lock_rows(ws, first_col, last_col, key_col, marker_col):
    """Rows past the Free limit compute only on Pro; on Free they show a 'PRO PLAN' marker."""
    if C_ENGINE:
        return   # the C engine applies the same rule internally
    a, b = column_index_from_string(first_col), column_index_from_string(last_col)
    for r in range(FREE_LAST + 1, TX_END + 1):
        for ci in range(a, b + 1):
            c = ws.cell(r, ci)
            f = c.value
            if isinstance(f, str) and f.startswith("="):
                locked = f'IF(${key_col}{r}="","","PRO PLAN")' if get_column_letter(ci) == marker_col else '""'
                c.value = f"=IF(IsPro,{f[1:]},{locked})"


lock_rows(sa, "J", "Z", "D", "T")
lock_rows(pu, "I", "S", "D", "I")
lock_rows(cb, "I", "K", "C", "K")
for ws, col in ((sa, "T"), (pu, "I"), (cb, "K")):
    ws.conditional_formatting.add(f"{col}{FIRST}:{col}{TX_END}", CellIsRule(
        operator="equal", formula=['"PRO PLAN"'], fill=fill("D9D2E9"), font=Font(bold=True, color="5E35B1")))

# Very-hidden licence check: plain Excel 2007 functions, mirrored in tools/license_tool.py and xll/src/engine.c
lic = wb.create_sheet("Lic")
lic.sheet_state = "veryHidden"
alpha = LIC.ALPHA
lic_rows = [
    ("key", '=UPPER(TRIM(LicKey&""))'),
    ("id", f'=LEFT(TRIM(LicId&""),{LIC.ID_LEN})'),
    ("plan", "=MID(A1,5,1)"),
    ("expiry", "=IFERROR(DATE(2000+VALUE(MID(A1,6,2)),VALUE(MID(A1,8,2)),VALUE(MID(A1,10,2))),0)"),
    ("message", f'=LEFT(A2&"|"&A3&"|"&(YEAR(A4)*10000+MONTH(A4)*100+DAY(A4))&REPT(" ",{LIC.MSG_LEN}),{LIC.MSG_LEN})'),
    ("sum", f"=SUMPRODUCT(CODE(MID(A5,ROW($A$1:$A${LIC.MSG_LEN}),1))*(MOD(ROW($A$1:$A${LIC.MSG_LEN})*{LIC.K1},{LIC.K2})+1))"),
    ("check", f"=MOD(A6*{LIC.K3}+{LIC.K4},1679616)"),
    ("check36", f'=MID("{alpha}",INT(A7/46656)+1,1)&MID("{alpha}",MOD(INT(A7/1296),36)+1,1)'
                f'&MID("{alpha}",MOD(INT(A7/36),36)+1,1)&MID("{alpha}",MOD(A7,36)+1,1)'),
    ("valid", '=AND(LEN(A1)=16,LEFT(A1,4)="PRO-",MID(A1,12,1)="-",ISNUMBER(FIND(A3,"MHY")),A4>0,LEN(A2)>0,RIGHT(A1,4)=A8)'),
    ("is pro", "=AND(A9,TODAY()<=A4)"),
    ("tx rows", f"=IF(A10,{N_TX},{FREE_LINES})"),
    ("plan label", '=IF(A3="M","1 month",IF(A3="H","6 months","12 months"))'),
    ("status", '=IF(A10,"PRO PLAN ("&A12&")  -  active till "&DAY(A4)&"/"&MONTH(A4)&"/"&YEAR(A4),'
               'IF(A9,"PRO EXPIRED on "&DAY(A4)&"/"&MONTH(A4)&"/"&YEAR(A4)&"  -  renew on the Plans sheet",'
               'IF(LEN(A1)>0,"LICENSE KEY NOT VALID for this mobile number  -  check Settings B14:B15","FREE PLAN")))'),
]
for i, (label, f) in enumerate(lic_rows, start=1):
    lic.cell(i, 1, f)
    lic.cell(i, 2, label)
for n_, ref in [("IsPro", "$A$10"), ("TxRows", "$A$11"), ("LicStatus", "$A$13"), ("LicExpiry", "$A$4")]:
    name(n_, f"Lic!{ref}")
for i, w in enumerate(WORDS99):          # number words for amounts in words (Invoice, Quotation)
    if w:
        lic.cell(1 + i, 4, w)
name("W99", "Lic!$D$1:$D$100")

# =================================================================== INVOICE (print)
iv = wb.create_sheet("Invoice")
iv.sheet_view.showGridLines = False
widths = {"A": 5, "B": 30, "C": 9, "D": 7, "E": 7, "F": 11, "G": 8, "H": 13, "I": 7, "J": 12, "K": 14}
for k, v in widths.items():
    iv.column_dimensions[k].width = v
iv.merge_cells("A1:K1")
iv["A1"] = "=CoName"
iv["A1"].font = Font(name=FONT, size=18, bold=True, color=NAVY)
iv.merge_cells("A2:K2")
iv["A2"] = '=CoAddr&"  ·  "&CoPhone'
iv.merge_cells("A3:K3")
iv["A3"] = '="GSTIN: "&CoGSTIN&"  ·  State: "&HomeState'
for c in ("A2", "A3"):
    iv[c].font = Font(name=FONT, size=9)
iv.merge_cells("A5:K5")
iv["A5"] = f'=IF(N(K{12 + 20 + 2 + 5})<0,"CREDIT NOTE (SALES RETURN)","TAX INVOICE / DELIVERY CHALLAN")'
iv["A5"].font = Font(name=FONT, size=13, bold=True, color="FFFFFF")
iv["A5"].fill = fill(NAVY)
iv["A5"].alignment = Alignment(horizontal="center")
iv["M3"] = "« Home"
iv["M3"].hyperlink = "#Dashboard!A1"
iv["M3"].font = Font(name=FONT, bold=True, color="0563C1", underline="single")

FR = f"MATCH($C$7,{S('B')},0)"  # first row of the invoice inside the Sales register
iv["B7"], iv["B8"], iv["B9"] = "Invoice No > (type to reprint)", "Invoice Date", "Payment"
iv["C7"] = f"=IF(COUNTA({S('B')})=0,\"\",INDEX({S('B')},COUNTA({S('B')})))"
iv["C7"].fill, iv["C7"].font = fill(INPUT_FILL), Font(name=FONT, size=11, bold=True, color="0000FF")
iv["C7"].comment = Comment("Defaults to the latest invoice. Overwrite with any invoice number to reprint it.", "ERP")
iv["C8"] = f'=IFERROR(INDEX({S("A")},{FR}),"")'
iv["C8"].number_format = DATE
iv["C9"] = f'=IFERROR(IF(INDEX({S("H")},{FR})="","Credit",INDEX({S("H")},{FR})),"")'
iv["G7"], iv["G8"], iv["G9"], iv["G10"] = "Bill To", "GSTIN", "State", "Address"
iv["H7"] = f'=IFERROR(INDEX({S("C")},{FR}),"")'
PR = f'MATCH($H$7,{PT("A")},0)'
iv["H8"] = f'=IFERROR(INDEX({PT("D")},{PR})&"","")'
iv["H9"] = f'=IFERROR(INDEX({PT("E")},{PR})&"","")'
iv["H10"] = f'=IFERROR(INDEX({PT("F")},{PR})&"","")'
iv["B10"] = "Due Date"
iv["C10"] = (f'=IF(C9="","",IF(C9<>"Credit","Paid",IF(N(C8)=0,"",C8+IF(N(INDEX({PT("H")},{PR}))>0,'
             f'N(INDEX({PT("H")},{PR})),TermsDays))))')
iv["C10"].number_format = DATE
for c in ("B7", "B8", "B9", "B10", "G7", "G8", "G9", "G10"):
    iv[c].font = f_bold
iv["H7"].font = Font(name=FONT, size=11, bold=True)

hdr = ["#", "Item", "HSN", "Qty", "Unit", "Rate (₹)", "Disc %", "Taxable (₹)", "GST %", "Tax (₹)", "Amount (₹)"]
HR = 12
for j, h in enumerate(hdr, start=1):
    c = iv.cell(HR, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill(TEAL), center, box
LINES = 20
for i in range(LINES):
    r = HR + 1 + i
    row = f"({FR}+{i})"
    ok = f'IFERROR(INDEX({S("B")},{row})=$C$7,FALSE)'
    pick = lambda col: f'INDEX({S(col)},{row})'
    iv[f"A{r}"] = f'=IF({ok},{i + 1},"")'
    iv[f"B{r}"] = f'=IF($A{r}="","",{pick("D")})'
    iv[f"C{r}"] = f'=IF($A{r}="","",IFERROR(INDEX({I_("E")},{pick("U")})&"",""))'
    iv[f"D{r}"] = f'=IF($A{r}="","",{pick("E")})'
    iv[f"E{r}"] = f'=IF($A{r}="","",{pick("J")})'
    iv[f"F{r}"] = f'=IF($A{r}="","",{pick("K")})'
    iv[f"G{r}"] = f'=IF($A{r}="","",N({pick("G")}))'
    iv[f"H{r}"] = f'=IF($A{r}="","",{pick("L")})'
    iv[f"I{r}"] = f'=IF($A{r}="","",{pick("M")})'
    iv[f"J{r}"] = f'=IF($A{r}="","",{pick("N")}+{pick("O")}+{pick("P")})'
    iv[f"K{r}"] = f'=IF($A{r}="","",{pick("Q")})'
    for j, fmt in enumerate([None, None, None, QTY, None, INR, PCT, INR, "0.##%", INR, INR], start=1):
        c = iv.cell(r, j)
        c.border, c.font = box, f_calc
        if fmt:
            c.number_format = fmt
TR = HR + LINES + 2
tot = [("Taxable Value", f"=SUMIFS({S('L')},{S('B')},$C$7)"),
       ("CGST", f"=SUMIFS({S('N')},{S('B')},$C$7)"),
       ("SGST", f"=SUMIFS({S('O')},{S('B')},$C$7)"),
       ("IGST", f"=SUMIFS({S('P')},{S('B')},$C$7)"),
       ("Round Off", f"=ROUND(K{TR + 5},0)-K{TR + 5}"),
       ("INVOICE TOTAL", f"=SUM(K{TR}:K{TR + 3})")]
# put round-off after total computation: total row = sum + roundoff
for i, (lbl, f) in enumerate(tot):
    iv[f"H{TR + i}"] = lbl
    iv[f"H{TR + i}"].font = f_bold
    iv.merge_cells(f"H{TR + i}:J{TR + i}")
    iv[f"K{TR + i}"] = f
    iv[f"K{TR + i}"].number_format = INR
    iv[f"K{TR + i}"].border = box
iv[f"K{TR + 4}"] = f"=ROUND(SUM(K{TR}:K{TR + 3}),0)-SUM(K{TR}:K{TR + 3})"
iv[f"K{TR + 5}"] = f"=SUM(K{TR}:K{TR + 4})"
iv[f"K{TR + 5}"].font = Font(name=FONT, size=12, bold=True, color=NAVY)
iv[f"K{TR + 5}"].fill = fill(LIGHT)
iv[f"B{TR}"] = '=IF(COUNTIF(A13:A32,">0")>=20,"!! More than 20 lines: split the invoice","")'
iv[f"B{TR - 1}"] = (f'=IF(K{TR + 5}>50000,"E-way bill needed before the goods move: value over Rs 50,000 '
                    f'(some states allow more inside the state)","")')
iv[f"B{TR - 1}"].font = Font(name=FONT, size=9, bold=True, color="C00000")
iv.merge_cells(f"B{TR + 3}:G{TR + 3}")
iv[f"B{TR + 3}"] = f'=IF(N(K{TR + 5})=0,"",{amount_words(f"K{TR + 5}")})'
iv[f"B{TR + 3}"].font = Font(name=FONT, size=9, bold=True)
iv[f"B{TR + 3}"].alignment = Alignment(wrap_text=True, vertical="top")
iv[f"B{TR}"].font = Font(name=FONT, size=9, color="C00000")
iv[f"B{TR + 1}"] = '="Bank: "&CoBank'
iv[f"B{TR + 2}"] = "Goods once sold will be taken back only as per store policy."
iv[f"B{TR + 4}"] = "Receiver's Signature"
iv[f"H{TR + 7}"] = '="For "&CoName'
iv[f"H{TR + 9}"] = "Authorised Signatory"
for c in (f"B{TR + 1}", f"B{TR + 2}", f"B{TR + 4}", f"H{TR + 7}", f"H{TR + 9}"):
    iv[c].font = Font(name=FONT, size=9)
iv.print_area = f"A1:K{TR + 9}"
wa_block(iv, f'IFERROR(INDEX({PT("C")},{PR}),"")',
         f'"Invoice "&$C$7&" dated "&TEXT($C$8,"dd-mm-yyyy")&" from "&LEFT(CoName,40)&": Rs "&TEXT($K${TR + 5},"#,##0")'
         f'&IF($C$9="Credit",", due by "&TEXT($C$10,"dd-mm-yyyy"),", paid")&". Thank you!"',
         ("N5", "O5", "P5"), "M5", "Send on WhatsApp")
iv["M6"] = "Opens WhatsApp with the invoice summary for this customer. Attach the PDF (macro InvoiceToPDF)."
iv["M6"].font = Font(name=FONT, size=8, italic=True)
iv.page_setup.orientation = "portrait"
iv.page_setup.paperSize = iv.PAPERSIZE_A4
iv.page_setup.fitToWidth = 1
iv.page_setup.fitToHeight = 1
iv.sheet_properties.pageSetUpPr.fitToPage = True

# =================================================================== REPORTS
rp = wb.create_sheet("Reports")
banner(rp, "REPORTS: MONTHLY P&L, GST, EXPENSES, TARGETS", "Financial-year view built from all registers. Type only the monthly targets (column N).", 15)
rp_head = ["Month", "Sales (₹)", "COGS (₹)", "Gross Profit (₹)", "GP %", "Expenses (₹)", "Other Income (₹)",
           "Stock Loss/Gain (₹)", "Net Profit (₹)", "Purchases (₹)", "GST Output (₹)", "GST Input (₹)", "Net GST Payable (₹)"]
for j, h in enumerate(rp_head, start=1):
    c = rp.cell(4, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill(TEAL), center, box
    rp.column_dimensions[get_column_letter(j)].width = 13
rp.column_dimensions["A"].width = 12
rp.row_dimensions[4].height = 32
gst_s = lambda a, b: "+".join(f"SUMIFS({S(c)},{S('A')},\">=\"&{a},{S('A')},\"<\"&{b})" for c in "NOP")
gst_p = lambda a, b: "+".join(f"SUMIFS({P(c)},{P('A')},\">=\"&{a},{P('A')},\"<\"&{b})" for c in "MNO")
for i in range(12):
    r = 5 + i
    a, b = f"$A{r}", f"EDATE($A{r},1)"
    win = lambda col, d: f'{col},">="&{a},{d},"<"&{b}'
    rp[f"A{r}"] = f"=EDATE(FYStart,{i})"
    rp[f"A{r}"].number_format = "mmm-yy"
    rp[f"B{r}"] = f"=SUMIFS({S('L')},{S('A')},\">=\"&{a},{S('A')},\"<\"&{b})"
    rp[f"C{r}"] = f"=SUMIFS({S('R')},{S('A')},\">=\"&{a},{S('A')},\"<\"&{b})"
    rp[f"D{r}"] = f"=B{r}-C{r}"
    rp[f"E{r}"] = f"=IF(B{r}=0,0,D{r}/B{r})"
    rp[f"F{r}"] = f"=SUMIFS({C_('G')},{C_('C')},\"Expense\",{C_('A')},\">=\"&{a},{C_('A')},\"<\"&{b})"
    rp[f"G{r}"] = f"=SUMIFS({C_('G')},{C_('C')},\"Other Income\",{C_('A')},\">=\"&{a},{C_('A')},\"<\"&{b})"
    rp[f"H{r}"] = f"=SUMIFS({A_('G')},{A_('A')},\">=\"&{a},{A_('A')},\"<\"&{b})"
    rp[f"I{r}"] = f"=D{r}-F{r}+G{r}+H{r}"
    rp[f"J{r}"] = f"=SUMIFS({P('K')},{P('A')},\">=\"&{a},{P('A')},\"<\"&{b})"
    rp[f"K{r}"] = f"={gst_s(a, b)}"
    rp[f"L{r}"] = f"={gst_p(a, b)}"
    rp[f"M{r}"] = f"=K{r}-L{r}"
r = 17
rp[f"A{r}"] = "FY TOTAL"
for j in range(2, 14):
    col = get_column_letter(j)
    rp[f"{col}{r}"] = f"=IF(B{r}=0,0,D{r}/B{r})" if col == "E" else f"=SUM({col}5:{col}16)"
for rr in range(5, 18):
    for j in range(1, 14):
        c = rp.cell(rr, j)
        c.border = box
        c.font = f_bold if rr == 17 else f_calc
        if j > 1:
            c.number_format = PCT if j == 5 else INR0
        if rr == 17:
            c.fill = fill(LIGHT)
# monthly sales targets (typed) vs actual
for j, h in ((14, "Sales Target (₹)"), (15, "Target Achieved")):
    c = rp.cell(4, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill("5E35B1"), center, box
    rp.column_dimensions[get_column_letter(j)].width = 13
for rr in range(5, 17):
    c = rp[f"N{rr}"]
    c.fill, c.font, c.border, c.number_format = fill(INPUT_FILL), f_in, box, INR0
    calc(rp, f"O{rr}", f'=IF(N(N{rr})=0,"",B{rr}/N{rr})', PCT)
calc(rp, "N17", "=SUM(N5:N16)", INR0, True)
calc(rp, "O17", '=IF(N17=0,"",B17/N17)', PCT, True)
for col in "NO":
    rp[f"{col}17"].fill = fill(LIGHT)
rp.conditional_formatting.add("O5:O17", CellIsRule(operator="greaterThanOrEqual", formula=["1"], fill=fill("C6EFCE")))
rp.conditional_formatting.add("O5:O17", CellIsRule(operator="lessThan", formula=["0.75"], fill=fill("FFC7CE")))
rp["N3"] = "Type your monthly targets in the cream cells"
rp["N3"].font = Font(name=FONT, size=8, color="0000FF")
rp["A18"] = "Net Profit = Gross Profit − Expenses + Other Income + Stock Adjustment value (losses are negative). Purchases are capitalised into stock; only COGS hits profit."
rp["A18"].font = Font(name=FONT, size=8, italic=True)

# GST rate-wise
rp["A21"] = "GST RATE-WISE SUMMARY (FY)  — ready for GSTR-1 / GSTR-3B"
rp["A21"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
gh = ["GST Rate", "Sales Taxable (₹)", "Output Tax (₹)", "Purch. Taxable (₹)", "Input Tax (₹)", "Net (₹)"]
for j, h in enumerate(gh, start=1):
    c = rp.cell(22, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill(TEAL), center, box
fy = '">="&FYStart'
fy2 = '"<"&EDATE(FYStart,12)'
for i in range(8):
    r = 23 + i
    rp[f"A{r}"] = f"=IF(Settings!F{5 + i}=\"\",\"\",Settings!F{5 + i})"
    rp[f"A{r}"].number_format = "0.##%"
    rp[f"A{r}"].font = f_link
    cond_s = f"{S('M')},$A{r},{S('A')},{fy},{S('A')},{fy2}"
    cond_p = f"{P('L')},$A{r},{P('A')},{fy},{P('A')},{fy2}"
    rp[f"B{r}"] = f'=IF($A{r}="","",SUMIFS({S("L")},{cond_s}))'
    rp[f"C{r}"] = f'=IF($A{r}="","",' + "+".join(f"SUMIFS({S(c)},{cond_s})" for c in "NOP") + ")"
    rp[f"D{r}"] = f'=IF($A{r}="","",SUMIFS({P("K")},{cond_p}))'
    rp[f"E{r}"] = f'=IF($A{r}="","",' + "+".join(f"SUMIFS({P(c)},{cond_p})" for c in "MNO") + ")"
    rp[f"F{r}"] = f'=IF($A{r}="","",C{r}-E{r})'
    for j in range(1, 7):
        rp.cell(r, j).border = box
        if j > 1:
            rp.cell(r, j).number_format = INR0

# Expense heads
rp["H21"] = "EXPENSES BY HEAD (FY)"
rp["H21"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
for j, h in enumerate(["Head", "Amount (₹)", "Share"], start=8):
    c = rp.cell(22, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill(TEAL), center, box
for i in range(12):
    r = 23 + i
    rp[f"H{r}"] = f'=IF(Settings!I{5 + i}="","",Settings!I{5 + i})'
    rp[f"H{r}"].font = f_link
    rp[f"I{r}"] = f'=IF(H{r}="","",SUMIFS({C_("G")},{C_("C")},"Expense",{C_("E")},H{r},{C_("A")},{fy},{C_("A")},{fy2}))'
    rp[f"J{r}"] = f'=IF(H{r}="","",IF(SUM($I$23:$I$34)=0,0,I{r}/SUM($I$23:$I$34)))'
    rp[f"I{r}"].number_format, rp[f"J{r}"].number_format = INR0, PCT
    for j in (8, 9, 10):
        rp.cell(r, j).border = box

# =================================================================== DASHBOARD
db = wb.create_sheet("Dashboard", 0)
db.sheet_view.showGridLines = False
for col in "ABCDEFGHIJKLMN":
    db.column_dimensions[col].width = 12.5
db.column_dimensions["A"].width = 2
db.merge_cells("B1:N1")
db["B1"] = '=CoName&"  ·  SmartTrader ERP' + (" (C Engine)" if C_ENGINE else "") + '"'
db["B1"].font = Font(name=FONT, size=20, bold=True, color="FFFFFF")
db.merge_cells("B2:N2")
db["B2"] = ('="Live business cockpit  ·  Period: "&DAY(D4)&"/"&MONTH(D4)&"/"&YEAR(D4)'
            '&" to "&DAY(G4)&"/"&MONTH(G4)&"/"&YEAR(G4)')
db["B2"].font = f_sub
for rr in (1, 2):
    for c in range(1, 15):
        db.cell(rr, c).fill = fill(NAVY)
db.row_dimensions[1].height = 34
db.merge_cells("B3:N3")
_used = (f'"Sales "&COUNTA(Sales!$D${FIRST}:$D${TX_END})&"  ·  Purchases "&COUNTA(Purchases!$D${FIRST}:$D${TX_END})'
         f'&"  ·  Cash Book "&COUNTA(CashBook!$C${FIRST}:$C${TX_END})')
_over = (f'MAX(COUNTA(Sales!$D${FIRST}:$D${TX_END}),COUNTA(Purchases!$D${FIRST}:$D${TX_END}),'
         f'COUNTA(CashBook!$C${FIRST}:$C${TX_END}))>{FREE_LINES}')
name("OverFreeLimit", _over)
_over = "OverFreeLimit"
db["B3"] = (f'=IF(IsPro,LicStatus&"   ·   lines used: "&{_used},'
            f'LicStatus&"  ·  first {FREE_LINES} lines per register  ·  used: "&{_used}'
            f'&IF({_over},"   >>  LIMIT REACHED: newer lines are not counted - upgrade on the Plans sheet",""))')
db["B3"].font = Font(name=FONT, size=9, bold=True, color="FFFFFF")
db["B3"].alignment = Alignment(horizontal="center", vertical="center")
db["B3"].fill = fill("F9A825")
db.conditional_formatting.add("B3", FormulaRule(formula=["IsPro"], fill=fill("2E7D32")))
db.conditional_formatting.add("B3", FormulaRule(formula=[f"AND(NOT(IsPro),{_over})"], fill=fill("C62828")))
db.row_dimensions[3].height = 20
db["B4"], db["E4"] = "From", "To"
db["D4"], db["G4"] = "=FYStart", "=AsOf"
for c in ("D4", "G4"):
    db[c].number_format = DATE
    db[c].fill = fill(INPUT_FILL)
    db[c].font = Font(name=FONT, size=10, bold=True, color="0000FF")
    db[c].border = box
db["B4"].font = db["E4"].font = f_bold
db["H4"] = "← overwrite these dates to analyse any period"
db["H4"].font = Font(name=FONT, size=8, italic=True)
if C_ENGINE:
    db.merge_cells("K4:N4")
    db["K4"] = '=IFERROR("Engine: "&_xll.ST_VERSION(),"!! C engine not loaded - see Guide")'
    db["K4"].font = Font(name=FONT, size=9, bold=True, color="2E7D32")
    db["K4"].alignment = Alignment(horizontal="right")
    db.conditional_formatting.add("K4", FormulaRule(formula=['LEFT($K$4,2)="!!"'],
                                                    font=Font(color="FFFFFF", bold=True), fill=fill("C62828")))
db.merge_cells("B5:N5")
db["B5"] = "Start: Settings > Items > Parties > Sales / Purchases / CashBook. Type only in cream cells - every other sheet fills itself."
db["B5"].font = Font(name=FONT, size=9, italic=True, color="595959")
name("DFrom", "Dashboard!$D$4")
name("DTo", "Dashboard!$G$4")

nav = [("New Sale", "Sales"), ("Purchase", "Purchases"), ("Cash Book", "CashBook"),
       ("Items", "Items"), ("Parties", "Parties"), ("Invoice", "Invoice"), ("Quotation", "Quotation"),
       ("Receipt 80mm", "Receipt"), ("Adjust", "Adjustments"), ("Reports", "Reports"), ("Settings", "Settings"),
       ("Guide", "Guide"), ("PRO Plans", "Plans")]
nav2 = [("Money Due", "Collections"), ("Statement", "Statement"), ("Cash Flow", "CashFlow"),
        ("Purchase Order", "PurchaseOrder"), ("GST Returns", "GST"), ("Balance Sheet", "BalanceSheet"),
        ("Profit Leaks", "ProfitLeaks"), ("Cash Tally", "CashTally")]
for row_, items_, color in ((6, nav, TEAL), (7, nav2, "5E35B1")):
    for i, (lbl, target) in enumerate(items_):
        c = db.cell(row_, 2 + i, lbl)
        c.hyperlink = f"#{target}!A1"
        c.font = Font(name=FONT, size=9, bold=True, color="FFFFFF")
        c.fill = fill(color)
        c.alignment = center
        c.border = Border(left=Side(style="thick", color="FFFFFF"), right=Side(style="thick", color="FFFFFF"),
                          bottom=Side(style="thin", color="FFFFFF"))
    db.row_dimensions[row_].height = 24

win_s = f'{S("A")},">="&DFrom,{S("A")},"<="&DTo'
win_p = f'{P("A")},">="&DFrom,{P("A")},"<="&DTo'
win_c = f'{C_("A")},">="&DFrom,{C_("A")},"<="&DTo'
win_a = f'{A_("A")},">="&DFrom,{A_("A")},"<="&DTo'
cards = [
    ("SALES (excl. GST)", f"=SUMIFS({S('L')},{win_s})", INR0, "0E7C86"),
    ("GROSS PROFIT", f"=SUMIFS({S('S')},{win_s})", INR0, "2E7D32"),
    ("NET PROFIT", f"=C9-SUMIFS({C_('G')},{C_('C')},\"Expense\",{win_c})+SUMIFS({C_('G')},{C_('C')},\"Other Income\",{win_c})+SUMIFS({A_('G')},{win_a})", INR0, "1B5E20"),
    ("PURCHASES (excl. GST)", f"=SUMIFS({P('K')},{win_p})", INR0, "6A1B9A"),
    ("EXPENSES", f"=SUMIFS({C_('G')},{C_('C')},\"Expense\",{win_c})", INR0, "C62828"),
    ("GP MARGIN", "=IF(B9=0,0,C9/B9)", PCT, "00838F"),
    ("RECEIVABLES (owed to you)", f"=SUMIF({PT('P')},\">0\")", INR0, "EF6C00"),
    ("PAYABLES (you owe)", f"=-SUMIF({PT('P')},\"<0\")", INR0, "AD1457"),
    ("STOCK VALUE (at cost)", f"=SUM({I_('Q')})", INR0, "283593"),
    ("NET GST PAYABLE", f"=SUMIFS({S('N')},{win_s})+SUMIFS({S('O')},{win_s})+SUMIFS({S('P')},{win_s})-SUMIFS({P('M')},{win_p})-SUMIFS({P('N')},{win_p})-SUMIFS({P('O')},{win_p})", INR0, "455A64"),
    ("ITEMS TO REORDER", f"=COUNTIF({I_('R')},\"REORDER\")+COUNTIF({I_('R')},\"OUT OF STOCK\")+COUNTIF({I_('R')},\"NEGATIVE\")", "0", "F9A825"),
    ("DEAD-STOCK ITEMS", f"=COUNTIF({I_('R')},\"DEAD STOCK\")", "0", "6D4C41"),
    ("OVERDUE CUSTOMERS", f"=COUNTIF({PT('U')},\"OVERDUE\")+COUNTIF({PT('U')},\"OVER LIMIT\")", "0", "D84315"),
    ("PENDING DELIVERIES (lines)", f"=COUNTIFS({S('I')},\"Pending\")+COUNTIFS({S('I')},\"Packed\")", "0", "0277BD"),
    ("NEXT INVOICE No.", f'=InvPrefix&TEXT(MAX({S("W")})+1,"0000")', None, "37474F"),
    ("SALES TARGET (this month)", '=IFERROR(IF(INDEX(Reports!$O$5:$O$16,MATCH(AsOf,Reports!$A$5:$A$16,1))="",'
                                  '"set in Reports",INDEX(Reports!$O$5:$O$16,MATCH(AsOf,Reports!$A$5:$A$16,1))),"-")', PCT, "5E35B1"),
    ("TO COLLECT (overdue + 7 days)", f'=SUMIFS({CO("I")},{CO("C")},"Receivable")+SUMIF({CO("O")},">0")', INR0, "E65100"),
    ("MSME TO PAY NOW (43B(h))", f'=SUM({CO("L")})+SUM({CO("M")})', INR0, "B71C1C"),
    ("GST CREDIT AT RISK (180 d)", f'=SUM({CO("N")})', INR0, "880E4F"),
    ("LOWEST CASH IN 8 WEEKS", "=CashFlow!$E$16", INR0, "0D47A1"),
]
# 5 cards per row, each card spans 2 cols at cols B,D,F,H,J ... use B..K? layout: 3 rows x 5 cards
pos = []
for row_i in range(4):
    for k in range(5):
        pos.append((8 + row_i * 3, 2 + k * 2 + (1 if k > 0 else 0) * 0))
# remap so card values land in predictable cells: row 9 values at B,D,F,H,J -> adjust NET PROFIT ref
card_cells = {}
for idx, ((label, formula, fmt, color), (r, c)) in enumerate(zip(cards, pos)):
    c1, c2 = get_column_letter(c), get_column_letter(c + 1)
    db.merge_cells(f"{c1}{r}:{c2}{r}")
    db.merge_cells(f"{c1}{r + 1}:{c2}{r + 1}")
    card_cells[label] = f"{c1}{r + 1}"
    db[f"{c1}{r}"] = label
    db[f"{c1}{r}"].font = Font(name=FONT, size=8, bold=True, color="FFFFFF")
    db[f"{c1}{r + 1}"].font = Font(name=FONT, size=16, bold=True, color="FFFFFF")
    for rr in (r, r + 1):
        for cc in (c, c + 1):
            db.cell(rr, cc).fill = fill(color)
            db.cell(rr, cc).alignment = Alignment(horizontal="center", vertical="center")
    db.row_dimensions[r + 1].height = 30
    if fmt:
        db[f"{c1}{r + 1}"].number_format = fmt
# fix intra-card references (formulas were authored assuming B9=sales, C9=GP)
sales_c, gp_c = card_cells["SALES (excl. GST)"], card_cells["GROSS PROFIT"]
for idx, ((label, formula, fmt, color), (r, c)) in enumerate(zip(cards, pos)):
    f = formula.replace("C9", "§GP§").replace("B9", sales_c).replace("§GP§", gp_c)
    db[card_cells[label]] = f

for c_ in ("B18", "D18", "F18", "H18", "J18"):
    db[c_].font = Font(name=FONT, size=14, bold=True, color="FFFFFF")
for target, ref in (("Reports", "B17"), ("Collections", "D17"), ("Collections", "F17"), ("Collections", "H17"), ("CashFlow", "J17")):
    db[ref].hyperlink = f"#{target}!A1"
# Cash & bank balances
r0 = 21
db[f"B{r0}"] = "CASH & BANK BALANCES (as of 'To' date)"
db[f"B{r0}"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
for j, h in enumerate(["Account", "", "Opening", "In", "Out", "Balance"]):
    if h:
        c = db.cell(r0 + 1, 2 + j, h)
        c.font, c.fill, c.alignment = f_head, fill(TEAL), center
db.cell(r0 + 1, 3).fill = fill(TEAL)
for i in range(4):
    r = r0 + 2 + i
    acc = f"Settings!$A${18 + i}"
    db[f"B{r}"] = f'=IF({acc}="","",{acc})'
    db[f"B{r}"].font = f_link
    upto = '"<="&DTo'
    db[f"D{r}"] = f'=IF(B{r}="","",N(Settings!$B${18 + i}))'
    db[f"E{r}"] = (f'=IF(B{r}="","",SUMIFS({C_("I")},{C_("F")},B{r},{C_("A")},{upto})'
                   f'+SUMIFS({S("X")},{S("H")},B{r},{S("A")},{upto}))')
    db[f"F{r}"] = (f'=IF(B{r}="","",SUMIFS({C_("J")},{C_("F")},B{r},{C_("A")},{upto})'
                   f'+SUMIFS({P("S")},{P("H")},B{r},{P("A")},{upto}))')
    db[f"G{r}"] = f'=IF(B{r}="","",D{r}+E{r}-F{r})'
    for col in "DEFG":
        db[f"{col}{r}"].number_format = INR0
    db[f"G{r}"].font = f_bold
r = r0 + 6
db[f"B{r}"] = "TOTAL LIQUIDITY"
db[f"B{r}"].font = f_bold
db[f"G{r}"] = f"=SUM(G{r0 + 2}:G{r0 + 5})"
db[f"G{r}"].number_format = INR0
db[f"G{r}"].font = Font(name=FONT, size=12, bold=True, color=NAVY)
db[f"G{r}"].fill = fill(LIGHT)

# Top 10 items
db["I21"] = "TOP 10 ITEMS BY SALES (all time)"
db["I21"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
for j, h in enumerate(["#", "Item", "", "Sales (₹)", "Stock", "Status"]):
    c = db.cell(22, 9 + j, h)
    c.font, c.fill, c.alignment = f_head, fill(TEAL), center
for k in range(10):
    r = 23 + k
    key = f"IFERROR(LARGE({I_('Z')},{k + 1}),\"\")"
    mrow = f"MATCH(LARGE({I_('Z')},{k + 1}),{I_('Z')},0)"
    db[f"I{r}"] = k + 1
    db.merge_cells(f"J{r}:K{r}")
    db[f"J{r}"] = f'=IFERROR(IF(INDEX({I_("U")},{mrow})=0,"",INDEX({I_("A")},{mrow})),"")'
    db[f"L{r}"] = f'=IF(J{r}="","",INDEX({I_("U")},{mrow}))'
    db[f"M{r}"] = f'=IF(J{r}="","",INDEX({I_("O")},{mrow}))'
    db[f"N{r}"] = f'=IF(J{r}="","",INDEX({I_("R")},{mrow}))'
    db[f"L{r}"].number_format, db[f"M{r}"].number_format = INR0, QTY
    for cc in range(9, 15):
        db.cell(r, cc).border = Border(bottom=thin)
for txt, color in [("OUT OF STOCK", "FFC7CE"), ("REORDER", "FFEB9C"), ("NEGATIVE", "FF7C80"), ("DEAD STOCK", "D9D2E9")]:
    db.conditional_formatting.add("N23:N32", CellIsRule(operator="equal", formula=[f'"{txt}"'], fill=fill(color)))

# Charts from the Reports month table
ch = BarChart()
ch.type = "col"
ch.title = "Monthly Sales vs Purchases (FY)"
ch.add_data(Reference(rp, min_col=2, min_row=4, max_row=16), titles_from_data=True)
ch.add_data(Reference(rp, min_col=10, min_row=4, max_row=16), titles_from_data=True)
ch.set_categories(Reference(rp, min_col=1, min_row=5, max_row=16))
ch.height, ch.width = 7.5, 15
ch.y_axis.scaling.min = 0
ch.y_axis.numFmt = '#,##0'
for ax in (ch.x_axis, ch.y_axis):
    ax.delete = False
db.add_chart(ch, "B35")
lc = LineChart()
lc.title = "Monthly Gross & Net Profit (FY)"
lc.add_data(Reference(rp, min_col=4, min_row=4, max_row=16), titles_from_data=True)
lc.add_data(Reference(rp, min_col=9, min_row=4, max_row=16), titles_from_data=True)
lc.set_categories(Reference(rp, min_col=1, min_row=5, max_row=16))
lc.height, lc.width = 7.5, 13
lc.y_axis.numFmt = '#,##0'
for ax in (lc.x_axis, lc.y_axis):
    ax.delete = False
db.add_chart(lc, "I35")

# =================================================================== COLLECTIONS (ageing, MSME 43B(h), ITC 180 days)
co = wb.create_sheet("Collections")
co_headers = [
    ("Party", 24, None), ("Phone", 12, None), ("Position", 10, None), ("Balance (₹)", 12, INR0),
    # E:V - computed in one pass (formulas below, or the C engine's ST_AGEING)
    ("0-30 days (₹)", 11, INR0), ("31-60 days (₹)", 11, INR0), ("61-90 days (₹)", 11, INR0), ("Over 90 days (₹)", 11, INR0),
    ("Overdue (₹)", 11, INR0), ("Falls due in 7 days (₹)", 11, INR0), ("MSME: pay within (days)", 9, "0"),
    ("MSME 43B(h) overdue (₹)", 11, INR0), ("MSME due in 7 days (₹)", 11, INR0), ("GST credit at risk: unpaid 180+ days (₹)", 12, INR0),
    ("Week 1 (₹)", 10, INR0), ("Week 2 (₹)", 10, INR0), ("Week 3 (₹)", 10, INR0), ("Week 4 (₹)", 10, INR0),
    ("Week 5 (₹)", 10, INR0), ("Week 6 (₹)", 10, INR0), ("Week 7 (₹)", 10, INR0), ("Week 8 (₹)", 10, INR0),
    ("Credit Score", 8, "0"), ("Grade", 6, None), ("Suggested Credit Limit (₹)", 12, INR0), ("Next Action", 24, None),
    ("WhatsApp", 15, None), ("digits", 4, None), ("wa", 4, None), ("url", 4, None),
]
banner(co, "MONEY DUE: AGEING, MSME 43B(h), GST CREDIT (180 DAYS), CASH FORECAST",
       "Automatic from every bill and payment. Payments clear the oldest bills first. Weeks: + money to collect, - money to pay.",
       len(co_headers) - 3)
for i, (h, w, fmt) in enumerate(co_headers, start=1):
    c = co.cell(4, i, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill("595959" if 5 <= i <= 22 else TEAL), center, box
    co.column_dimensions[get_column_letter(i)].width = w
    if fmt:
        co.column_dimensions[get_column_letter(i)].number_format = fmt
for col in ("AB", "AC", "AD"):
    co.column_dimensions[col].hidden = True
co.row_dimensions[4].height = 54
co.freeze_panes = "B5"
co.auto_filter.ref = f"A4:AA{PT_END}"
co["A3"] = "Nothing to type here: fill Parties (Credit Days, MSME, Written Pay Agreement) and keep entering bills and payments."
co["A3"].font = Font(name=FONT, size=8, color="595959")
co["D3"] = "TOTAL"
co["D3"].font = f_bold
for j in range(5, 23):
    col = get_column_letter(j)
    if col == "K":
        continue
    calc(co, f"{col}3", f"=SUM({col}{FIRST}:{col}{PT_END})", INR0, True)
    co[f"{col}3"].fill = fill(LIGHT)

PTR = lambda col, r: f"Parties!${col}{r}"
if not C_ENGINE:
    # helpers (formula edition): sign, amount, MSME flag, legal days, due days, unpaid-older-than(t), old GST credit
    HELP = ["sgn", "amt", "mse", "d43", "due"] + [f"O{t}" for t in ("30", "60", "90", "180", "d", "d7", "d14", "d21",
                                                                      "d28", "d35", "d42", "d49", "d56")] + ["gstOld", "totOld"]
    HC = {h: get_column_letter(32 + k) for k, h in enumerate(HELP)}   # AF onwards, hidden
    for h, col in HC.items():
        co[f"{col}4"] = h
        co[f"{col}4"].font = Font(name=FONT, size=7, color="BFBFBF")
        co.column_dimensions[col].hidden = True
for r in range(FIRST, PT_END + 1):
    g = f'IF($A{r}="","",'
    co[f"A{r}"] = f'=IF({PTR("A", r)}="","",{PTR("A", r)})'
    co[f"B{r}"] = f'={g}{PTR("C", r)}&"")'
    co[f"C{r}"] = f'={g}{PTR("Q", r)})'
    co[f"D{r}"] = f'={g}ABS({PTR("P", r)}))'
    if not C_ENGINE:
        h = lambda k: f"${HC[k]}{r}"
        co[f"{HC['sgn']}{r}"] = f'={g}SIGN(ROUND({PTR("P", r)},2)))'
        co[f"{HC['amt']}{r}"] = f'={g}ABS({PTR("P", r)}))'
        co[f"{HC['mse']}{r}"] = f'={g}OR({PTR("J", r)}="Micro",{PTR("J", r)}="Small"))'
        co[f"{HC['d43']}{r}"] = f'={g}IF({PTR("K", r)}="Yes",MIN(IF(N({PTR("H", r)})>0,N({PTR("H", r)}),45),45),15))'
        co[f"{HC['due']}{r}"] = f'={g}IF(AND({h("sgn")}<0,{h("mse")}),{h("d43")},N({PTR("H", r)})))'

        def credit_since(t):   # credit bills of this party dated within the last t days (sales if they owe us)
            d = f'">="&(AsOf-({t}))'
            sale = f"SUMIFS({S('Q')},{S('C')},$A{r},{S('A')},{d})-SUMIFS({S('X')},{S('C')},$A{r},{S('A')},{d})"
            buy = f"SUMIFS({P('P')},{P('C')},$A{r},{P('A')},{d})-SUMIFS({P('S')},{P('C')},$A{r},{P('A')},{d})"
            return f"IF({h('sgn')}>0,{sale},{buy})"
        for k, t in (("30", "30"), ("60", "60"), ("90", "90"), ("180", "180"), ("d", h("due")),
                     *[(f"d{7 * w}", f"{h('due')}-{7 * w}") for w in range(1, 9)]):
            co[f"{HC['O' + k]}{r}"] = f'={g}IF({h("sgn")}=0,0,MIN({h("amt")},MAX(0,{h("amt")}-({credit_since(t)})))))'
        old = f'{P("C")},$A{r},{P("A")},"<"&(AsOf-180),{P("S")},0'
        co[f"{HC['gstOld']}{r}"] = f'={g}IF({h("sgn")}<0,SUMIFS({P("M")},{old})+SUMIFS({P("N")},{old})+SUMIFS({P("O")},{old}),0))'
        co[f"{HC['totOld']}{r}"] = f'={g}IF({h("sgn")}<0,SUMIFS({P("P")},{old}),0))'
        O = lambda k: h("O" + k)
        co[f"E{r}"] = f"={g}{h('amt')}-{O('30')})"
        co[f"F{r}"] = f"={g}{O('30')}-{O('60')})"
        co[f"G{r}"] = f"={g}{O('60')}-{O('90')})"
        co[f"H{r}"] = f"={g}{O('90')})"
        co[f"I{r}"] = f"={g}{O('d')})"
        co[f"J{r}"] = f"={g}{O('d7')}-{O('d')})"
        co[f"K{r}"] = f'={g}IF({h("mse")},{h("d43")},""))'
        co[f"L{r}"] = f'={g}IF({h("mse")},IF({h("sgn")}<0,I{r},0),""))'
        co[f"M{r}"] = f'={g}IF({h("mse")},IF({h("sgn")}<0,J{r},0),""))'
        co[f"N{r}"] = f'={g}IF(AND({h("sgn")}<0,{h("totOld")}<>0),ROUND({O("180")}*{h("gstOld")}/{h("totOld")},2),0))'
        for w in range(1, 9):
            prev = "d" if w == 1 else f"d{7 * (w - 1)}"
            co[f"{get_column_letter(14 + w)}{r}"] = f"={g}{h('sgn')}*({O(f'd{7 * w}')}-{O(prev)}))"
    # credit score, grade, suggested limit, next action, WhatsApp (both editions)
    base = f'({PTR("L", r)}+MAX(0,N({PTR("I", r)})))'
    bal = PTR("P", r)
    co[f"W{r}"] = (f'={g}IF({base}<=0,"",MAX(0,ROUND(100*(0.5*MIN(1,{PTR("M", r)}/{base})'
                   f'+0.3*(1-IF(ROUND({bal},2)>0,I{r}/{bal},0))+0.2*(1-IF(ROUND({bal},2)>0,H{r}/{bal},0))),0)'
                   f'-IF({PTR("U", r)}="OVER LIMIT",10,0))))')
    co[f"X{r}"] = f'=IF(N(W{r})+0=0,IF(W{r}="","","D"),IF(W{r}>=80,"A",IF(W{r}>=60,"B",IF(W{r}>=40,"C","D"))))'
    co[f"Y{r}"] = (f'=IF(X{r}="","",ROUND({PTR("L", r)}/MAX(1,(AsOf-FYStart)/30.4)*MAX(1,N({PTR("H", r)})/30)'
                   f'*IF(X{r}="A",1.5,IF(X{r}="B",1,IF(X{r}="C",0.5,0))),-3))')
    co[f"Z{r}"] = (f'={g}IF(N(N{r})>0,"Pay now: GST credit lapses",IF(N(L{r})>0,"Pay now: MSME 43B(h)",'
                   f'IF(N(M{r})>0,"Pay this MSME within 7 days",IF(AND(C{r}="Receivable",N(I{r})>0),"Send payment reminder",'
                   f'IF({PTR("U", r)}="OVER LIMIT","Stop credit sales",IF(X{r}="D","Sell for cash only","")))))))')
    msg = (f'"Dear "&LEFT($A{r},30)&", your balance with "&LEFT(CoName,30)&" is Rs "&TEXT($D{r},"#,##0")'
           f'&IF(N($I{r})>0," (Rs "&TEXT($I{r},"#,##0")&" overdue)","")&". Kindly pay"&IF(UpiId&""<>""," to UPI "&UpiId,"")&". Thank you."')
    co[f"AB{r}"] = f'=IF(OR($A{r}="",$B{r}=""),"",{wa_digits(f"$B{r}")})'
    co[f"AC{r}"] = f'=IF(AB{r}="","",{wa_number(f"AB{r}")})'
    co[f"AD{r}"] = f'=IF(OR(AC{r}="",$C{r}<>"Receivable"),"","https://wa.me/"&AC{r}&"?text="&{url_enc(msg)})'
    co[f"AA{r}"] = "=" + wa_link(f"AD{r}", f"AC{r}", "Send reminder")
    co[f"AA{r}"].font = Font(name=FONT, size=10, color="0563C1", underline="single")
    if r == FIRST or not C_ENGINE:
        for col in "ABCD":
            co[f"{col}{r}"].border = box
f_wa = Font(name=FONT, size=10, color="0563C1", underline="single")
for r in range(FIRST, PT_END + 1):
    for i, (_, _, fmt) in enumerate(co_headers, start=1):
        c = co.cell(r, i)
        if c.value is not None:
            c.font = f_wa if i == 27 else f_calc
            if fmt:
                c.number_format = fmt
for col, color in (("I", "FFC7CE"), ("L", "FF7C80"), ("M", "FFEB9C"), ("N", "FF7C80")):
    co.conditional_formatting.add(f"{col}{FIRST}:{col}{PT_END}",
                                  CellIsRule(operator="greaterThan", formula=["0"], fill=fill(color)))
for txt, color in (("A", "C6EFCE"), ("B", "DDEBF7"), ("C", "FFEB9C"), ("D", "FFC7CE")):
    co.conditional_formatting.add(f"X{FIRST}:X{PT_END}", CellIsRule(operator="equal", formula=[f'"{txt}"'], fill=fill(color)))
co["W4"].comment = Comment("0-100: half from how much of the billed amount was paid, the rest from overdue and 90+ day dues. "
                           "Minus 10 when over the credit limit. A 80+, B 60+, C 40+, D below.", "ERP")
co["Y4"].comment = Comment("Average monthly credit sales x credit period, times 1.5 (A), 1 (B), 0.5 (C) or 0 (D), rounded to Rs 1,000.", "ERP")
co["K4"].comment = Comment("Micro and Small suppliers (Parties column J): 15 days, or the agreed Credit Days up to 45 when "
                           "there is a written agreement (column K). Unpaid beyond this at the year end is not deductible "
                           "under Income-tax section 43B(h) until you pay.", "ERP")
co["N4"].comment = Comment("GST law (section 16(2)): input credit must be paid back if you have not paid the supplier "
                           "within 180 days of the bill. This is the GST inside bills still unpaid after 180 days.", "ERP")

# =================================================================== STATEMENT (party ledger to print / share)
sm = wb.create_sheet("Statement")
sm.sheet_view.showGridLines = False
for col, w in zip("ABCDEFGH", (16, 15, 15, 15, 15, 14, 15, 3)):
    sm.column_dimensions[col].width = w
sm.merge_cells("A1:G1")
sm["A1"] = "=CoName"
sm["A1"].font = Font(name=FONT, size=16, bold=True, color=NAVY)
sm.merge_cells("A2:G2")
sm["A2"] = '=CoAddr&"  ·  "&CoPhone&"  ·  GSTIN "&CoGSTIN'
sm["A2"].font = Font(name=FONT, size=9)
sm.merge_cells("A3:G3")
sm["A3"] = '="STATEMENT OF ACCOUNT  ·  as on "&TEXT(AsOf,"dd-mmm-yyyy")'
sm["A3"].font = Font(name=FONT, size=12, bold=True, color="FFFFFF")
sm["A3"].fill = fill(NAVY)
sm["A3"].alignment = Alignment(horizontal="center")
home_link(sm, "J1")
SPR = f"MATCH($B$5,{PT('A')},0)"
spick = lambda col: f'IFERROR(INDEX({PT(col)},{SPR}),"")'
cpick = lambda col: f'IFERROR(INDEX({CO(col)},{SPR}),"")'
sm["A5"] = "Party >"
sm["B5"] = f'=IFERROR(INDEX({PT("A")},MATCH(MAX({PT("P")}),{PT("P")},0)),"")'
sm.merge_cells("B5:C5")
in_cell(sm["B5"])
sm["B5"].comment = Comment("Shows the customer who owes you the most. Type or pick any party to see their statement.", "ERP")
add_list_dv(sm, "B5", "L_Parties", strict=False)
for i, (lbl, f) in enumerate([("Phone", f'={spick("C")}&""'), ("GSTIN", f'={spick("D")}&""'),
                              ("Address", f'={spick("F")}&""'), ("State", f'={spick("E")}&""')]):
    sm[f"A{6 + i}"] = lbl
    sm[f"A{6 + i}"].font = f_bold
    sm[f"B{6 + i}"] = f
for i, (lbl, f, fmt) in enumerate([("Balance", f'=IFERROR(ABS(INDEX({PT("P")},{SPR})),"")', INR),
                                   ("Position", f'={spick("Q")}&""', None),
                                   ("Credit limit / days", f'=IFERROR(TEXT(INDEX({PT("G")},{SPR}),"#,##0")&" / "&N(INDEX({PT("H")},{SPR}))&" days","")', None),
                                   ("Credit score", f'=IFERROR(INDEX({CO("W")},{SPR})&"  "&INDEX({CO("X")},{SPR}),"")', None)]):
    sm[f"E{5 + i}"] = lbl
    sm[f"E{5 + i}"].font = f_bold
    calc(sm, f"F{5 + i}", f, fmt, i == 0)
    sm.merge_cells(f"F{5 + i}:G{5 + i}")
head_row(sm, 11, ["0-30 days", "31-60 days", "61-90 days", "Over 90 days", "Overdue", "Due in 7 days"], 1, "5E35B1", 20)
for j, col in enumerate("EFGHIJ"):
    calc(sm, f"{get_column_letter(1 + j)}12", f"={cpick(col)}", INR0)
head_row(sm, 14, ["Month", "Sales billed (₹)", "Received (₹)", "Purchases billed (₹)", "Paid to them (₹)",
                  "Change (₹)", "Balance (₹)"], 1, TEAL, 30)
sm["A15"] = "Opening"
calc(sm, "G15", f'=IFERROR(N(INDEX({PT("I")},{SPR})),0)', INR, True)
for i in range(12):
    r = 16 + i
    a, b = f"$A{r}", f"EDATE($A{r},1)"
    sw = f'{S("C")},$B$5,{S("A")},">="&{a},{S("A")},"<"&{b}'
    pw = f'{P("C")},$B$5,{P("A")},">="&{a},{P("A")},"<"&{b}'
    cw = lambda t: f'{C_("D")},$B$5,{C_("C")},"{t}",{C_("A")},">="&{a},{C_("A")},"<"&{b}'
    calc(sm, f"A{r}", f"=EDATE(FYStart,{i})", "mmm-yy")
    calc(sm, f"B{r}", f"=SUMIFS({S('Q')},{sw})-SUMIFS({S('X')},{sw})", INR0)
    calc(sm, f"C{r}", f"=SUMIFS({C_('G')},{cw('Receipt')})", INR0)
    calc(sm, f"D{r}", f"=SUMIFS({P('P')},{pw})-SUMIFS({P('S')},{pw})", INR0)
    calc(sm, f"E{r}", f"=SUMIFS({C_('G')},{cw('Payment')})", INR0)
    calc(sm, f"F{r}", f"=B{r}-C{r}-D{r}+E{r}", INR0)
    calc(sm, f"G{r}", f"=G{r - 1}+F{r}", INR0)
calc(sm, "A28", "Other dates")
for j, col in enumerate("BCDE"):
    calc(sm, f"{col}28", f'=IFERROR(INDEX({PT("LMNO"[j])},{SPR})-SUM({col}16:{col}27),0)', INR0)
calc(sm, "F28", "=B28-C28-D28+E28", INR0)
calc(sm, "G28", "=G27+F28", INR0)
calc(sm, "A29", "Closing", None, True)
calc(sm, "G29", '=G28', INR, True)
calc(sm, "F29", '=IF(G29>0,"they owe you",IF(G29<0,"you owe them","settled"))', None, True)
sm["G29"].fill = fill(LIGHT)
sm["A28"].font = Font(name=FONT, size=9, italic=True)
sm["A31"] = '="Please pay within your credit period. Interest at "&TEXT(IntRate,"0%")&" a year may apply on overdue bills."'
sm["A32"] = '="Bank: "&CoBank&IF(UpiId&""<>"","  ·  UPI: "&UpiId,"")'
sm["A34"] = '="For "&CoName'
for c in ("A31", "A32", "A34"):
    sm[c].font = Font(name=FONT, size=9)
sm.print_area = "A1:G35"
sm.page_setup.paperSize = sm.PAPERSIZE_A4
sm.page_setup.fitToWidth = 1
sm.page_setup.fitToHeight = 1
sm.sheet_properties.pageSetUpPr.fitToPage = True
wa_block(sm, "$B$6", '"Statement from "&LEFT(CoName,40)&": your balance is Rs "&TEXT($F$5,"#,##0")&" ("&$F$6&") as on "'
         '&TEXT(AsOf,"dd-mm-yyyy")&IF(N($E$12)>0,", overdue Rs "&TEXT($E$12,"#,##0"),"")&". Thank you."',
         ("K5", "L5", "M5"), "J5", "Send on WhatsApp")
sm["J6"] = "Ctrl+P prints this statement on one A4 page."
sm["J6"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== PURCHASE ORDER (smart reorder by supplier)
po = wb.create_sheet("PurchaseOrder")
po.sheet_view.showGridLines = False
for col, w in zip("ABCDEFGHIJKL", (4, 26, 20, 6, 9, 9, 10, 11, 12, 7, 13, 5)):
    po.column_dimensions[col].width = w
po.merge_cells("A1:K1")
po["A1"] = "=CoName"
po["A1"].font = Font(name=FONT, size=16, bold=True, color=NAVY)
po.merge_cells("A2:K2")
po["A2"] = '=CoAddr&"  ·  "&CoPhone&"  ·  GSTIN "&CoGSTIN'
po["A2"].font = Font(name=FONT, size=9)
po.merge_cells("A3:K3")
po["A3"] = "PURCHASE ORDER"
po["A3"].font = Font(name=FONT, size=13, bold=True, color="FFFFFF")
po["A3"].fill = fill("6A1B9A")
po["A3"].alignment = Alignment(horizontal="center")
home_link(po, "N1")
for i, (lbl, f, fmt) in enumerate([("Supplier >", None, None), ("PO No", '="PO-"&TEXT(AsOf,"yymmdd")', None),
                                   ("Date", "=AsOf", DATE), ("Deliver by", "=AsOf+LeadDays", DATE)]):
    po[f"B{5 + i}"] = lbl
    po[f"B{5 + i}"].font = f_bold
    po[f"C{5 + i}"] = f
    in_cell(po[f"C{5 + i}"], fmt)
add_list_dv(po, "C5", "L_Parties", "Leave blank to see every item that needs ordering", strict=False)
po["C5"].comment = Comment("Pick a supplier to make their order, or leave blank to list every item that needs ordering. "
                           "Items are matched to the supplier you bought them from last.", "ERP")
SUPR = f"MATCH($C$5,{PT('A')},0)"
for i, (lbl, col) in enumerate([("Phone", "C"), ("GSTIN", "D"), ("State", "E"), ("Address", "F")]):
    po[f"F{5 + i}"] = lbl
    po[f"F{5 + i}"].font = f_bold
    po.merge_cells(f"G{5 + i}:K{5 + i}")
    po[f"G{5 + i}"] = f'=IF($C$5="","",IFERROR(INDEX({PT(col)},{SUPR})&"",""))'
head_row(po, 10, ["#", "Item", "Supplier (last bought)", "Unit", "In stock", "Sold 30 days", "Order Qty", "Rate (₹)",
                  "Taxable (₹)", "GST %", "Amount (₹)"], 1, "6A1B9A", 30)
PO_LINES = 30
it_rng = lambda col: f"Items!${col}${FIRST}:${col}${IT_END}"
cond = (f"ISNUMBER({it_rng('AE')})*({it_rng('AE')}>0)*((($C$5=\"\")+({it_rng('AB')}=$C$5))>0)")
for k in range(PO_LINES):
    r = 11 + k
    po[f"L{r}"] = ArrayFormula(f"L{r}", f'=IFERROR(SMALL(IF({cond},ROW({it_rng("AE")})),{k + 1}),"")')
    pick = lambda col: f"INDEX(Items!${col}$1:${col}${IT_END},$L{r})"
    g = f'IF($L{r}="","",'
    po[f"A{r}"] = f'={g}{k + 1})'
    po[f"B{r}"] = f'={g}{pick("A")}&"")'
    po[f"C{r}"] = f'={g}{pick("AB")}&"")'
    po[f"D{r}"] = f'={g}{pick("D")}&"")'
    po[f"E{r}"] = f"={g}{pick('O')})"
    po[f"F{r}"] = f"={g}{pick('AA')})"
    po[f"G{r}"] = f"={g}{pick('AE')})"
    po[f"H{r}"] = f"={g}{pick('AC')})"
    po[f"I{r}"] = f"={g}ROUND(G{r}*H{r},2))"
    po[f"J{r}"] = f"={g}N({pick('F')}))"
    po[f"K{r}"] = f"={g}I{r}+ROUND(I{r}*J{r},2))"
    for j, fmt in enumerate([None, None, None, None, QTY, QTY, QTY, INR, INR, "0.##%", INR], start=1):
        c = po.cell(r, j)
        c.border, c.font = box, f_bold if j == 7 else f_calc
        if fmt:
            c.number_format = fmt
po.column_dimensions["L"].hidden = True
TPO = 11 + PO_LINES + 1
for i, (lbl, f) in enumerate([("Taxable", f"=SUM(I11:I{TPO - 2})"), ("GST", f"=SUM(K11:K{TPO - 2})-SUM(I11:I{TPO - 2})"),
                              ("ORDER TOTAL", f"=SUM(K11:K{TPO - 2})")]):
    po.merge_cells(f"H{TPO + i}:J{TPO + i}")
    po[f"H{TPO + i}"] = lbl
    po[f"H{TPO + i}"].font = f_bold
    calc(po, f"K{TPO + i}", f, INR, i == 2)
po[f"K{TPO + 2}"].fill = fill(LIGHT)
po[f"B{TPO}"] = f'=IF(COUNT(L11:L{TPO - 2})>={PO_LINES},"!! More items need ordering: pick one supplier at a time","")'
po[f"B{TPO}"].font = Font(name=FONT, size=9, color="C00000")
po[f"B{TPO + 1}"] = ('="Order Qty = sales of the last 30 days x ("&LeadDays&" lead days + "&CoverDays&" cover days) / 30 '
                     '+ reorder level - stock (Settings B30:B31)."')
po[f"B{TPO + 2}"] = '="Please deliver by "&TEXT($C$8,"dd-mmm-yyyy")&" and quote this PO number on your bill."'
po[f"B{TPO + 5}"] = '="For "&CoName'
for c in (f"B{TPO + 1}", f"B{TPO + 2}", f"B{TPO + 5}"):
    po[c].font = Font(name=FONT, size=9)
po.print_area = f"A1:K{TPO + 6}"
po.page_setup.paperSize = po.PAPERSIZE_A4
po.page_setup.fitToWidth = 1
po.page_setup.fitToHeight = 1
po.sheet_properties.pageSetUpPr.fitToPage = True
wa_block(po, "IF($C$5=\"\",\"\",$G$5)",
         f'"Purchase order "&$C$6&" from "&LEFT(CoName,40)&": "&COUNT($L$11:$L${TPO - 2})&" items, value Rs "'
         f'&TEXT($K${TPO + 2},"#,##0")&". Please deliver by "&TEXT($C$8,"dd-mm-yyyy")&". Item list follows."',
         ("O5", "P5", "Q5"), "N5", "Send to supplier on WhatsApp")
po["N6"] = "Pick a supplier first. Ctrl+P prints the order."
po["N6"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== CASH FLOW (8-week forecast)
cf = wb.create_sheet("CashFlow")
banner(cf, "CASH-FLOW FORECAST: NEXT 8 WEEKS",
       "From the due dates of every unpaid bill (Collections), your average expenses and the GST due on the 20th.", 10)
for col, w in zip("ABCDEFGHIJ", (8, 11, 11, 14, 14, 14, 13, 12, 14, 16)):
    cf.column_dimensions[col].width = w
head_row(cf, 4, ["Week", "From", "To", "Opening (₹)", "Money in: collections (₹)", "Money out: suppliers (₹)",
                 "Expenses (avg) (₹)", "GST due (₹)", "Closing (₹)", "Status"], 1, TEAL, 32)
LIQ = (f'SUM(Settings!$B$18:$B$25)+SUMIFS({C_("I")},{C_("A")},"<="&AsOf)-SUMIFS({C_("J")},{C_("A")},"<="&AsOf)'
       f'+SUMIFS({S("X")},{S("A")},"<="&AsOf)-SUMIFS({P("S")},{P("A")},"<="&AsOf)')
WEEKLY_EXP = (f'SUMIFS({C_("G")},{C_("C")},"Expense",{C_("A")},">="&FYStart,{C_("A")},"<="&AsOf)'
              f'/MAX(1,(AsOf-FYStart+1)/7)')
for w in range(1, 9):
    r = 4 + w
    wc = get_column_letter(14 + w)          # Collections week column
    calc(cf, f"A{r}", w, "0")
    calc(cf, f"B{r}", f"=AsOf+{7 * (w - 1) + 1}", DATE)
    calc(cf, f"C{r}", f"=AsOf+{7 * w}", DATE)
    calc(cf, f"D{r}", f"={LIQ}" if w == 1 else f"=I{r - 1}", INR0)
    extra_in = f'+CollectPct*SUMIFS({CO("I")},{CO("C")},"Receivable")' if w == 1 else ""
    extra_out = f'+SUMIFS({CO("I")},{CO("C")},"Payable")' if w == 1 else ""
    calc(cf, f"E{r}", f'=SUMIF({CO(wc)},">0"){extra_in}', INR0)
    calc(cf, f"F{r}", f'=-SUMIF({CO(wc)},"<0"){extra_out}', INR0)
    calc(cf, f"G{r}", f"=ROUND({WEEKLY_EXP},0)", INR0)
    # the 20th of a month falling in this week -> net GST of the month before it
    d20 = f"IF(DAY(B{r})<=20,DATE(YEAR(B{r}),MONTH(B{r}),20),DATE(YEAR(B{r}),MONTH(B{r})+1,20))"
    m0 = f"DATE(YEAR({d20}),MONTH({d20})-1,1)"
    m1 = f"DATE(YEAR({d20}),MONTH({d20}),1)"
    wn = lambda R, col: f'SUMIFS({R(col)},{R("A")},">="&{m0},{R("A")},"<"&{m1})'
    net = "+".join(wn(S, c) for c in "NOP") + "-" + "-".join(wn(P, c) for c in "MNO")
    paid = f'SUMIFS({C_("G")},{C_("C")},"GST Paid",{C_("A")},">="&{m1},{C_("A")},"<="&AsOf)'
    calc(cf, f"H{r}", f"=IF({d20}<=C{r},MAX(0,ROUND({net}-{paid},0)),0)", INR0)
    calc(cf, f"I{r}", f"=D{r}+E{r}-F{r}-G{r}-H{r}", INR0, True)
    calc(cf, f"J{r}", f'=IF(I{r}<0,"SHORTFALL",IF(I{r}<G{r},"Tight","OK"))', None, True)
cf.conditional_formatting.add("J5:J12", CellIsRule(operator="equal", formula=['"SHORTFALL"'], fill=fill("FF7C80")))
cf.conditional_formatting.add("J5:J12", CellIsRule(operator="equal", formula=['"Tight"'], fill=fill("FFEB9C")))
cf.conditional_formatting.add("J5:J12", CellIsRule(operator="equal", formula=['"OK"'], fill=fill("C6EFCE")))
cf.conditional_formatting.add("I5:I12", CellIsRule(operator="lessThan", formula=["0"], font=Font(color="C00000", bold=True)))
for i, (lbl, f, fmt) in enumerate([
        ("Cash + bank today", "=D5", INR0),
        ("Lowest balance in 8 weeks", "=MIN(I5:I12)", INR0),
        ("Week of the lowest balance", "=MATCH(MIN(I5:I12),I5:I12,0)", "0"),
        ("Money to arrange (loan / faster collection)", "=MAX(0,-MIN(I5:I12))", INR0),
        ("Overdue from customers today", f'=SUMIFS({CO("I")},{CO("C")},"Receivable")', INR0),
        ("Overdue to suppliers today", f'=SUMIFS({CO("I")},{CO("C")},"Payable")', INR0)]):
    r = 15 + i
    cf[f"A{r}"] = lbl
    cf[f"A{r}"].font = f_bold
    cf.merge_cells(f"A{r}:D{r}")
    calc(cf, f"E{r}", f, fmt, True)
section(cf, "A14", "SUMMARY")
cf["A22"] = ("How it works: unpaid bills fall due Credit Days after the bill date (MSME suppliers: their legal limit). "
             "Week 1 also collects the share of overdue dues set in Settings B33 and pays all overdue suppliers.")
cf["A22"].font = Font(name=FONT, size=8, italic=True)
cf_chart = BarChart()
cf_chart.type = "col"
cf_chart.title = "Closing cash + bank by week"
cf_chart.add_data(Reference(cf, min_col=9, min_row=4, max_row=12), titles_from_data=True)
cf_chart.set_categories(Reference(cf, min_col=1, min_row=5, max_row=12))
cf_chart.height, cf_chart.width = 7, 16
cf_chart.y_axis.numFmt = "#,##0"
cf_chart.legend = None
for ax in (cf_chart.x_axis, cf_chart.y_axis):
    ax.delete = False
cf.add_chart(cf_chart, "F14")

# =================================================================== GST RETURNS (GSTR-1 & GSTR-3B summary)
gs = wb.create_sheet("GST")
banner(gs, "GST RETURNS: GSTR-1 AND GSTR-3B FOR A MONTH",
       "Pick the month in C4. Every figure comes from the Sales and Purchases registers. Check with your CA before filing.", 9)
for col, w in zip("ABCDEFGHI", (40, 14, 14, 14, 14, 14, 10, 14, 14)):
    gs.column_dimensions[col].width = w
gs["A4"] = "Return month (any date in it) >"
gs["A4"].font = f_bold
gs["C4"] = "=DATE(YEAR(AsOf),MONTH(AsOf)-1,1)"
in_cell(gs["C4"], "mmm-yyyy")
gs["C4"].comment = Comment("Defaults to last month (returns are filed for the month gone by). Type any date to change.", "ERP")
gs["D4"] = "From"
gs["E4"] = "=DATE(YEAR(C4),MONTH(C4),1)"
gs["F4"] = "To"
gs["G4"] = "=EDATE(E4,1)-1"
for c in ("E4", "G4"):
    gs[c].number_format = DATE
    gs[c].font = f_bold
gwin = lambda R: f'{R("A")},">="&$E$4,{R("A")},"<="&$G$4'
section(gs, "A6", "GSTR-1  (outward supplies)")
head_row(gs, 7, ["Table", "Taxable (₹)", "IGST (₹)", "CGST (₹)", "SGST (₹)", "Total tax (₹)", "Lines"], 1, TEAL, 30)
g1 = [("4A  B2B: sales to registered buyers (GSTIN)", '"B2B"', '">0"', None),
      ("5/7  B2C inter-state (B2CL if one invoice > Rs 1 lakh)", '"B2C"', '">0"', '">0"'),
      ("7  B2CS: B2C within the state", '"B2C"', '">0"', "0"),
      ("9B  Credit notes to registered buyers (CDNR)", '"B2B"', '"<0"', None),
      ("9B  Credit notes to unregistered buyers", '"B2C"', '"<0"', None)]
for i, (lbl, typ, qty, igst) in enumerate(g1):
    r = 8 + i
    cr = f'{gwin(S)},{S("Y")},{typ},{S("E")},{qty},{S("M")},">0"' + (f',{S("P")},{igst}' if igst else "")
    gs[f"A{r}"] = lbl
    gs[f"A{r}"].border = box
    for j, col in enumerate("LPNO"):
        calc(gs, f"{'BCDE'[j]}{r}", f"=SUMIFS({S(col)},{cr})", INR0)
    calc(gs, f"F{r}", f"=C{r}+D{r}+E{r}", INR0)
    calc(gs, f"G{r}", f"=COUNTIFS({cr})", "0")
r = 13
gs[f"A{r}"] = "8  Nil-rated / exempt (0% GST)"
gs[f"A{r}"].border = box
calc(gs, f"B{r}", f'=SUMIFS({S("L")},{gwin(S)},{S("M")},0)', INR0)
calc(gs, f"G{r}", f'=COUNTIFS({gwin(S)},{S("M")},0,{S("D")},"<>")', "0")
gs["A14"] = "TOTAL taxable outward supplies (should equal GSTR-3B 3.1(a))"
gs["A14"].font = f_bold
for col in "BCDEF":
    calc(gs, f"{col}14", f"=SUM({col}8:{col}12)", INR0, True)
    gs[f"{col}14"].fill = fill(LIGHT)

section(gs, "A16", "GSTR-1 Table 12: HSN-wise summary")
head_row(gs, 17, ["HSN  (first item with this code)", "Taxable B2B (₹)", "Taxable B2C (₹)", "IGST (₹)", "CGST (₹)",
                  "SGST (₹)", "Unit", "Total qty", "GST rate"], 1, TEAL, 30)
HSN_ROWS = 25
for k in range(HSN_ROWS):
    r = 18 + k
    row_ = f"SMALL(Items!$AF${FIRST}:$AF${IT_END},{k + 1})"
    gs[f"J{r}"] = f'=IFERROR({row_},"")'
    gs[f"A{r}"] = f'=IF($J{r}="","",INDEX(Items!$E$1:$E${IT_END},$J{r})&"  "&LEFT(INDEX(Items!$A$1:$A${IT_END},$J{r}),26))'
    hs = f'INDEX(Items!$E$1:$E${IT_END},$J{r})&""'
    sp = lambda col, extra="": (f'SUMPRODUCT(--({S("Z")}={hs}),--({S("A")}>=$E$4),--({S("A")}<=$G$4){extra},{S(col)})')
    g = f'IF($J{r}="","",'
    b2b, b2c = f',--({S("Y")}="B2B")', f',--({S("Y")}="B2C")'
    calc(gs, f"B{r}", f"={g}{sp('L', b2b)})", INR0)
    calc(gs, f"C{r}", f"={g}{sp('L', b2c)})", INR0)
    calc(gs, f"D{r}", f"={g}{sp('P')})", INR0)
    calc(gs, f"E{r}", f"={g}{sp('N')})", INR0)
    calc(gs, f"F{r}", f"={g}{sp('O')})", INR0)
    calc(gs, f"G{r}", f'={g}INDEX(Items!$D$1:$D${IT_END},$J{r})&"")')
    calc(gs, f"H{r}", f"={g}{sp('E')})", QTY)
    calc(gs, f"I{r}", f"={g}INDEX(Items!$F$1:$F${IT_END},$J{r}))", "0.##%")
    gs[f"A{r}"].border = box
gs.column_dimensions["J"].hidden = True
r = 18 + HSN_ROWS
gs[f"A{r}"] = '=IF(COUNT(Items!$AF$5:$AF$' + str(IT_END) + f')>{HSN_ROWS},"!! More than {HSN_ROWS} HSN codes: add the rest from the Sales sheet filter","TOTAL")'
gs[f"A{r}"].font = f_bold
for col in "BCDEFH":
    calc(gs, f"{col}{r}", f"=SUM({col}18:{col}{r - 1})", QTY if col == "H" else INR0, True)
G3 = r + 2
section(gs, f"A{G3}", "GSTR-3B  (summary return)")
head_row(gs, G3 + 1, ["Table", "Taxable (₹)", "IGST (₹)", "CGST (₹)", "SGST (₹)", "Total (₹)"], 1, "6A1B9A", 30)
rows3b = [
    ("3.1(a)  Outward taxable supplies", f'{gwin(S)},{S("M")},">0"', S, "LPNO"),
    ("3.1(c)  Nil-rated / exempt supplies", f'{gwin(S)},{S("M")},0', S, "L"),
    ("4(A)(5)  Input tax credit: all other ITC (purchases)", gwin(P), P, "KOMN"),
]
for i, (lbl, crit, R, cols) in enumerate(rows3b):
    r = G3 + 2 + i
    gs[f"A{r}"] = lbl
    gs[f"A{r}"].border = box
    for j, col in enumerate(cols):
        calc(gs, f"{'BCDE'[j]}{r}", f"=SUMIFS({R(col)},{crit})", INR0)
    calc(gs, f"F{r}", f"=SUM(C{r}:E{r})", INR0)
R31, R4A = G3 + 2, G3 + 4
r = G3 + 5
gs[f"A{r}"] = "4(B)(2)  ITC to reverse (type it; see the hint below)"
gs[f"A{r}"].border = box
for col in "CDE":
    gs[f"{col}{r}"] = 0
    in_cell(gs[f"{col}{r}"], INR0)
calc(gs, f"F{r}", f"=SUM(C{r}:E{r})", INR0)
R4B = r
gs[f"A{r + 1}"] = (f'="Hint: GST inside supplier bills unpaid for 180+ days today = Rs "&TEXT(SUM({CO("N")}),"#,##0")'
                   f'&" (Collections column N). Reverse it, then claim again after you pay."')
gs[f"A{r + 1}"].font = Font(name=FONT, size=8, italic=True, color="C00000")
r = R4B + 2
gs[f"A{r}"] = "Net ITC available  (4A - 4B)"
gs[f"A{r}"].font = f_bold
for col in "CDE":
    calc(gs, f"{col}{r}", f"=MAX(0,{col}{R4A}-{col}{R4B})", INR0, True)
calc(gs, f"F{r}", f"=SUM(C{r}:E{r})", INR0, True)
RNET = r
# set-off: IGST credit first (IGST, then CGST / SGST shortfalls), then CGST and SGST credit, the rest is paid in cash
r = RNET + 2
section(gs, f"A{r}", "Tax payment: credit set-off (IGST credit used first, as section 49A requires)")
head_row(gs, r + 1, ["", "", "IGST (₹)", "CGST (₹)", "SGST (₹)", "Total (₹)"], 1, "6A1B9A", 20)
oI, oC, oS = f"C{R31}", f"D{R31}", f"E{R31}"
iI, iC, iS = f"C{RNET}", f"D{RNET}", f"E{RNET}"
rI = f"MAX(0,{iI}-{oI})"                                   # IGST credit left after IGST
dC, dS = f"MAX(0,{oC}-{iC})", f"MAX(0,{oS}-{iS})"         # CGST / SGST not covered by their own credit
xC = f"MIN({rI},{dC})"
xS = f"MIN({rI}-{xC},{dS})"
remI = f"MAX(0,{oI}-{iI})"
sC, sS = f"MAX(0,{iC}-{oC})", f"MAX(0,{iS}-{oS})"
uC = f"MIN({sC},{remI})"
uS = f"MIN({sS},{remI}-{uC})"
lines3b = [
    ("Tax due (3.1(a))", oI, oC, oS),
    ("Cash to pay (challan PMT-06)", f"MAX(0,{remI}-{sC}-{sS})", f"{dC}-{xC}", f"{dS}-{xS}"),
    ("Credit carried forward", f"{rI}-{xC}-{xS}", f"{sC}-{uC}", f"{sS}-{uS}"),
]
for i, (lbl, a, b, c_) in enumerate(lines3b):
    rr = r + 2 + i
    gs[f"A{rr}"] = lbl
    gs[f"A{rr}"].font = f_bold if i == 1 else f_calc
    for col, f in zip("CDE", (a, b, c_)):
        calc(gs, f"{col}{rr}", f"={f}", INR0, i == 1)
    calc(gs, f"F{rr}", f"=SUM(C{rr}:E{rr})", INR0, i == 1)
RCASH = r + 3
for col in "CDEF":
    gs[f"{col}{RCASH}"].fill = fill("FFF2CC")
rr = r + 6
gs[f"A{rr}"] = '="Due date: "&TEXT(DATE(YEAR($E$4),MONTH($E$4)+1,20),"dd-mmm-yyyy")&" (monthly filers; quarterly QRMP filers: 22nd/24th after the quarter)"'
gs[f"A{rr + 1}"] = "GST already paid for this month (CashBook type 'GST Paid', dated after the month)"
calc(gs, f"F{rr + 1}", f'=SUMIFS({C_("G")},{C_("C")},"GST Paid",{C_("A")},">"&$G$4)', INR0)
gs[f"A{rr + 2}"] = "Still to pay"
gs[f"A{rr + 2}"].font = f_bold
calc(gs, f"F{rr + 2}", f"=MAX(0,F{RCASH}-F{rr + 1})", INR0, True)
gs[f"F{rr + 2}"].fill = fill("FFC7CE")
for c in (f"A{rr}", f"A{rr + 1}"):
    gs[c].font = Font(name=FONT, size=9)
GST_CASH = f"GST!$F${rr + 2}"

# =================================================================== BALANCE SHEET
bs = wb.create_sheet("BalanceSheet")
banner(bs, "BALANCE SHEET AND PROFIT & LOSS", "Everything entered in this file (all dates). Nothing to type here.", 7)
for col, w in zip("ABCDEFG", (44, 16, 4, 40, 16, 4, 4)):
    bs.column_dimensions[col].width = w
GST_NET = (f"(SUM({S('N')})+SUM({S('O')})+SUM({S('P')})-SUM({P('M')})-SUM({P('N')})-SUM({P('O')})"
           f"-SUMIFS({C_('G')},{C_('C')},\"GST Paid\"))")
NP_ALL = (f"(SUM({S('L')})-SUM({S('R')})-SUMIFS({C_('G')},{C_('C')},\"Expense\")"
          f"+SUMIFS({C_('G')},{C_('C')},\"Other Income\")+SUM({A_('G')}))")
UNLINKED = (f"(SUM({S('Q')})-SUM({S('X')})-SUM({PT('L')}))-(SUMIFS({C_('G')},{C_('C')},\"Receipt\")-SUM({PT('M')}))"
            f"-(SUM({P('P')})-SUM({P('S')})-SUM({PT('N')}))+(SUMIFS({C_('G')},{C_('C')},\"Payment\")-SUM({PT('O')}))")
bs_rows = [
    ("H", "WHAT THE BUSINESS OWNS"),
    ("Cash, bank and UPI", f"=SUM(Settings!$B$18:$B$25)+SUM({C_('I')})-SUM({C_('J')})+SUM({S('X')})-SUM({P('S')})"),
    ("Customers owe you (receivables)", f'=SUMIF({PT("P")},">0")'),
    ("Stock at cost", f"=SUM({I_('Q')})"),
    ("Less: negative stock (items sold but never bought - fix them)", f"=SUMPRODUCT({I_('O')},{I_('P')})-SUM({I_('Q')})"),
    ("GST credit to carry forward", f"=MAX(0,-{GST_NET})"),
    ("Entries whose party is not on the Parties sheet", f"={UNLINKED}"),
    ("T", "TOTAL ASSETS"),
    ("H", "WHAT THE BUSINESS OWES"),
    ("Suppliers you owe (payables)", f'=-SUMIF({PT("P")},"<0")'),
    ("GST payable to the government", f"=MAX(0,{GST_NET})"),
    ("T", "TOTAL LIABILITIES"),
    ("H", "OWNER'S CAPITAL"),
    ("Opening capital (cash + bank + stock + party balances at FY start)",
     f"=SUM(Settings!$B$18:$B$25)+SUMPRODUCT({I_('J')},{I_('K')})+SUM({PT('I')})"),
    ("Add: capital brought in", f'=SUMIFS({C_("G")},{C_("C")},"Capital In")'),
    ("Add: net profit", f"={NP_ALL}"),
    ("Less: drawings", f'=-SUMIFS({C_("G")},{C_("C")},"Drawings")'),
    ("T", "CLOSING CAPITAL"),
]
r = 4
tot_rows, start = {}, None
for k, v in bs_rows:
    if k == "H":
        section(bs, f"A{r}", v)
        start = r + 1
    elif k == "T":
        bs[f"A{r}"] = v
        bs[f"A{r}"].font = f_bold
        calc(bs, f"B{r}", f"=SUM(B{start}:B{r - 1})", INR, True)
        bs[f"B{r}"].fill = fill(LIGHT)
        tot_rows[v] = r
        r += 1
    else:
        bs[f"A{r}"] = k
        calc(bs, f"B{r}", v, INR)
    r += 1
TA, TL, TC = tot_rows["TOTAL ASSETS"], tot_rows["TOTAL LIABILITIES"], tot_rows["CLOSING CAPITAL"]
bs[f"A{r}"] = "Check: assets - liabilities - capital"
bs[f"A{r}"].font = f_bold
calc(bs, f"B{r}", f"=B{TA}-B{TL}-B{TC}", INR, True)
n_lines = f"(COUNT({S('R')})+COUNT({A_('G')}))"
calc(bs, f"A{r + 1}", f'=IF(ABS(B{r})<=1+0.005*{n_lines},"BALANCED (difference is paisa rounding of cost per line)",'
                      f'"NOT BALANCED: check entries with unknown items or voucher types not in Settings")', None, True)
bs.conditional_formatting.add(f"A{r + 1}", FormulaRule(formula=[f'LEFT($A${r + 1},3)="BAL"'], fill=fill("C6EFCE")))
bs.conditional_formatting.add(f"A{r + 1}", FormulaRule(formula=[f'LEFT($A${r + 1},3)="NOT"'], fill=fill("FFC7CE")))
BS_CHECK = r
pl_rows = [
    ("H", "PROFIT & LOSS (all entries)"),
    ("Sales (excl. GST, net of returns)", f"=SUM({S('L')})"),
    ("Less: cost of goods sold", f"=-SUM({S('R')})"),
    ("T", "GROSS PROFIT"),
    ("Less: expenses", f'=-SUMIFS({C_("G")},{C_("C")},"Expense")'),
    ("Add: other income", f'=SUMIFS({C_("G")},{C_("C")},"Other Income")'),
    ("Stock adjustments (damage, count, returns)", f"=SUM({A_('G')})"),
]
r = 4
for k, v in pl_rows:
    if k == "H":
        section(bs, f"D{r}", v)
    elif k == "T":
        bs[f"D{r}"] = v
        bs[f"D{r}"].font = f_bold
        calc(bs, f"E{r}", f"=SUM(E{r - 2}:E{r - 1})", INR, True)
        bs[f"E{r}"].fill = fill(LIGHT)
        GP_ROW = r
    else:
        bs[f"D{r}"] = k
        calc(bs, f"E{r}", v, INR)
    r += 1
bs[f"D{r}"] = "NET PROFIT"
bs[f"D{r}"].font = f_bold
calc(bs, f"E{r}", f"=E{GP_ROW}+SUM(E{GP_ROW + 1}:E{r - 1})", INR, True)
bs[f"E{r}"].fill = fill("C6EFCE")
bs[f"D{r + 2}"] = "Net profit here equals 'Add: net profit' in the capital account."
bs[f"D{r + 2}"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== PROFIT LEAKS
pk = wb.create_sheet("ProfitLeaks")
banner(pk, "PROFIT LEAK FINDER", "Where money quietly leaves the business, for the Dashboard period (D4 to G4 there).", 5)
for col, w in zip("ABCDE", (46, 16, 22, 60, 4)):
    pk.column_dimensions[col].width = w
head_row(pk, 4, ["Leak", "Amount (₹)", "Size", "What to do"], 1, "C62828", 24)
win_ps = f'{S("A")},">="&DFrom,{S("A")},"<="&DTo'
win_pa = f'{A_("A")},">="&DFrom,{A_("A")},"<="&DTo'
leaks = [
    ("Discounts given", f'=SUMPRODUCT(--({S("A")}>=DFrom),--({S("A")}<=DTo),{S("E")},{S("K")},{S("G")})',
     "Set a maximum discount per customer grade (Collections column X). Discounts above 5% need a reason."),
    ("Loss on lines sold below cost", f'=-SUMIFS({S("S")},{S("S")},"<0",{win_ps})',
     "Sales sheet: filter Stock Check = BELOW COST. Raise the sale rate or renegotiate the purchase rate."),
    ("Stock lost: damage, expiry, theft, short count", f'=-SUMIFS({A_("G")},{A_("G")},"<0",{win_pa})',
     "Adjustments sheet: see which items and reasons repeat. Count fast movers every week."),
    ("Sales returns (credit notes)", f'=-SUMIFS({S("L")},{S("E")},"<0",{win_ps})',
     "Check quality and packing of the items returned most."),
    ("Interest lost on overdue customer dues (1 month)", f'=ROUND(SUMIFS({CO("I")},{CO("C")},"Receivable")*IntRate/12,0)',
     "Collections sheet: send WhatsApp reminders, stop credit for grade D customers."),
    ("Capital stuck in dead stock (holding cost, 1 year)", f'=ROUND(SUMIFS({I_("Q")},{I_("R")},"DEAD STOCK")*IntRate,0)',
     "Items sheet: filter DEAD STOCK. Clear with a scheme or return to the supplier, and stop reordering."),
    ("GST credit at risk: suppliers unpaid 180+ days", f'=SUM({CO("N")})',
     "Pay these suppliers (Collections column N). Otherwise the credit must be paid back with interest."),
    ("MSME dues past the 43B(h) limit (deduction at risk)", f'=SUM({CO("L")})',
     "Pay before 31 March, or this purchase is not deductible this year - extra income tax on it."),
]
for i, (lbl, f, tip) in enumerate(leaks):
    r = 5 + i
    pk[f"A{r}"] = lbl
    pk[f"A{r}"].font = f_bold
    pk[f"A{r}"].border = box
    calc(pk, f"B{r}", f, INR0, True)
    calc(pk, f"C{r}", f'=REPT("■",IF(MAX($B$5:$B${4 + len(leaks)})<=0,0,ROUND(12*MAX(0,B{r})/MAX($B$5:$B${4 + len(leaks)}),0)))')
    pk[f"C{r}"].font = Font(name=FONT, size=10, color="C62828")
    pk[f"D{r}"] = tip
    pk[f"D{r}"].alignment = Alignment(wrap_text=True, vertical="top")
    pk[f"D{r}"].border = box
    pk.row_dimensions[r].height = 30
r = 5 + len(leaks)
pk[f"A{r}"] = "TOTAL"
pk[f"A{r}"].font = f_bold
calc(pk, f"B{r}", f"=SUM(B5:B{r - 1})", INR0, True)
pk[f"B{r}"].fill = fill("FFC7CE")
PK_TOTAL = f"ProfitLeaks!$B${r}"
pk[f"A{r + 2}"] = '="Items selling at under 5% margin: "&COUNTIFS(' + I_("S") + ',"<0.05",' + I_("A") + ',"<>")&"   ·   Lines below cost: "&COUNTIFS(' + S("T") + ',"BELOW COST",' + win_ps + ')'
pk[f"A{r + 2}"].font = f_bold

# =================================================================== CASH TALLY (count the drawer)
ct = wb.create_sheet("CashTally")
banner(ct, "DAILY CASH TALLY", "Count the notes in the drawer. The sheet compares them with the books and shows any shortage.", 5)
for col, w in zip("ABCDE", (30, 14, 12, 16, 30)):
    ct.column_dimensions[col].width = w
ct["A4"], ct["A5"] = "Date >", "Account >"
ct["B4"], ct["B5"] = "=AsOf", "Cash"
in_cell(ct["B4"], DATE)
in_cell(ct["B5"])
add_list_dv(ct, "B5", "L_Accounts")
for c in ("A4", "A5"):
    ct[c].font = f_bold
acc_win = lambda R, colv, colacc: f'SUMIFS({R(colv)},{R(colacc)},$B$5,{R("A")},"<="&$B$4)'
book = (f"SUMIF(Settings!$A$18:$A$25,$B$5,Settings!$B$18:$B$25)+{acc_win(C_, 'I', 'F')}-{acc_win(C_, 'J', 'F')}"
        f"+{acc_win(S, 'X', 'H')}-{acc_win(P, 'S', 'H')}")
day = lambda R, colv, colacc: f'SUMIFS({R(colv)},{R(colacc)},$B$5,{R("A")},$B$4)'
ct["A7"], ct["A8"], ct["A9"] = "Money in today (books)", "Money out today (books)", "Balance as per books"
calc(ct, "B7", f"={day(C_, 'I', 'F')}+{day(S, 'X', 'H')}", INR)
calc(ct, "B8", f"={day(C_, 'J', 'F')}+{day(P, 'S', 'H')}", INR)
calc(ct, "B9", f"={book}", INR, True)
for c in ("A7", "A8", "A9"):
    ct[c].font = f_bold
head_row(ct, 11, ["Note / coin (₹)", "Count", "", "Amount (₹)"], 1, TEAL, 20)
for i, d in enumerate((500, 200, 100, 50, 20, 10, 5, 2, 1)):
    r = 12 + i
    calc(ct, f"A{r}", d, '"₹"#,##0')
    in_cell(ct[f"B{r}"], "0")
    calc(ct, f"D{r}", f"=A{r}*N(B{r})", INR0)
calc(ct, "A21", "Counted total", None, True)
calc(ct, "D21", "=SUM(D12:D20)", INR, True)
calc(ct, "A22", "Difference (counted - books)", None, True)
calc(ct, "D22", "=D21-B9", INR, True)
ct.merge_cells("A24:D24")
ct["A24"] = ('=IF(COUNT(B12:B20)=0,"Type how many of each note you counted",IF(ABS(D22)<0.5,"TALLY: cash matches the books",'
             'IF(D22<0,"SHORT by Rs "&TEXT(-D22,"#,##0")&": look for a missing expense or payment entry",'
             '"EXCESS of Rs "&TEXT(D22,"#,##0")&": look for a sale or receipt not entered")))')
ct["A24"].font = Font(name=FONT, size=13, bold=True)
ct.conditional_formatting.add("A24", FormulaRule(formula=['LEFT($A$24,5)="TALLY"'], fill=fill("C6EFCE")))
ct.conditional_formatting.add("A24", FormulaRule(formula=['OR(LEFT($A$24,5)="SHORT",LEFT($A$24,6)="EXCESS")'], fill=fill("FFC7CE")))
ct["A26"] = "Clear the counts before the next count (select B12:B20, press Delete). Rs 2,000 notes are withdrawn, so they are not listed."
ct["A26"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== QUOTATION / ESTIMATE / PROFORMA
qt = wb.create_sheet("Quotation")
qt.sheet_view.showGridLines = False
for k, v in widths.items():
    qt.column_dimensions[k].width = v
qt.merge_cells("A1:K1")
qt["A1"] = "=CoName"
qt["A1"].font = Font(name=FONT, size=18, bold=True, color=NAVY)
qt.merge_cells("A2:K2")
qt["A2"] = '=CoAddr&"  ·  "&CoPhone'
qt.merge_cells("A3:K3")
qt["A3"] = '="GSTIN: "&CoGSTIN&"  ·  State: "&HomeState'
for c in ("A2", "A3"):
    qt[c].font = Font(name=FONT, size=9)
qt.merge_cells("A5:K5")
qt["A5"] = "=UPPER(C7)"
qt["A5"].font = Font(name=FONT, size=13, bold=True, color="FFFFFF")
qt["A5"].fill = fill("00838F")
qt["A5"].alignment = Alignment(horizontal="center")
home_link(qt, "M3")
for i, (lbl, v, fmt) in enumerate([("Document >", "Quotation", None), ("Number", "QT-0001", None),
                                   ("Date", "=AsOf", DATE), ("Valid till", "=C9+15", DATE)]):
    qt[f"B{7 + i}"] = lbl
    qt[f"B{7 + i}"].font = f_bold
    qt[f"C{7 + i}"] = v
    in_cell(qt[f"C{7 + i}"], fmt)
add_list_dv(qt, "C7", "L_DocTypes")
qt["G7"], qt["G8"], qt["G9"], qt["G10"] = "To >", "GSTIN", "State", "Address"
for c in ("G7", "G8", "G9", "G10"):
    qt[c].font = f_bold
in_cell(qt["H7"])
qt.merge_cells("H7:K7")
add_list_dv(qt, "H7", "L_Parties", "Pick the customer (new customers: add them on Parties first)", strict=False)
QPR = f'MATCH($H$7,{PT("A")},0)'
for c, col in (("H8", "D"), ("H9", "E"), ("H10", "F")):
    qt[c] = f'=IFERROR(INDEX({PT(col)},{QPR})&"","")'
    qt.merge_cells(f"{c}:K{c[1:]}")
QINTER = f'AND($H$9<>"",$H$9<>HomeState)'
for j, h in enumerate(hdr, start=1):
    c = qt.cell(HR, j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill("00838F"), center, box
qt.cell(HR, 2, "Item > (pick)")
qt.cell(HR, 4, "Qty >")
qt.cell(HR, 6, "Rate (₹) >")
qt.cell(HR, 7, "Disc % >")
Q_LINES = 15
for i in range(Q_LINES):
    r = HR + 1 + i
    irow = f"MATCH($B{r},{I_('A')},0)"
    g = f'IF($B{r}="","",'
    qt[f"A{r}"] = f'={g}{i + 1})'
    qt[f"C{r}"] = f'={g}IFERROR(INDEX({I_("E")},{irow})&"",""))'
    qt[f"E{r}"] = f'={g}IFERROR(INDEX({I_("D")},{irow})&"",""))'
    qt[f"F{r}"] = f'={g}IFERROR(INDEX({I_("H")},{irow}),0))'
    qt[f"H{r}"] = f'={g}ROUND(N($D{r})*N($F{r})*(1-N($G{r})),2))'
    qt[f"I{r}"] = f'={g}IFERROR(INDEX({I_("F")},{irow}),0))'
    qt[f"J{r}"] = f'={g}IF({QINTER},ROUND(H{r}*I{r},2),2*ROUND(H{r}*I{r}/2,2)))'
    qt[f"K{r}"] = f'={g}H{r}+J{r})'
    for j, fmt in enumerate([None, None, None, QTY, None, INR, PCT, INR, "0.##%", INR, INR], start=1):
        c = qt.cell(r, j)
        c.border, c.font = box, f_calc
        if fmt:
            c.number_format = fmt
        if j in (2, 4, 6, 7):
            c.fill, c.font = fill(INPUT_FILL), f_in
add_list_dv(qt, f"B{HR + 1}:B{HR + Q_LINES}", "L_Items", "Pick an item; the rate fills itself (type over it to change)")
qt["F4"] = "Cream cells: type here. Rate fills from the Items sheet; type over it for a special price."
qt["F4"].font = Font(name=FONT, size=8, color="0000FF")
QT = HR + Q_LINES + 2
qtot = [("Taxable Value", f"=SUM(H{HR + 1}:H{HR + Q_LINES})"),
        ("CGST", f"=IF({QINTER},0,SUM(J{HR + 1}:J{HR + Q_LINES})/2)"),
        ("SGST", f"=IF({QINTER},0,SUM(J{HR + 1}:J{HR + Q_LINES})/2)"),
        ("IGST", f"=IF({QINTER},SUM(J{HR + 1}:J{HR + Q_LINES}),0)"),
        ("Round Off", f"=ROUND(SUM(K{QT}:K{QT + 3}),0)-SUM(K{QT}:K{QT + 3})"),
        ("TOTAL", f"=SUM(K{QT}:K{QT + 4})")]
for i, (lbl, f) in enumerate(qtot):
    qt[f"H{QT + i}"] = lbl
    qt[f"H{QT + i}"].font = f_bold
    qt.merge_cells(f"H{QT + i}:J{QT + i}")
    calc(qt, f"K{QT + i}", f, INR, i == 5)
qt[f"K{QT + 5}"].fill = fill(LIGHT)
qt.merge_cells(f"B{QT}:G{QT}")
qt[f"B{QT}"] = f'=IF(N(K{QT + 5})=0,"",{amount_words(f"K{QT + 5}")})'
qt[f"B{QT}"].font = Font(name=FONT, size=9, bold=True)
terms = ['="Prices valid till "&TEXT(C10,"dd-mmm-yyyy")&". GST as shown."',
         '="Payment: within "&TermsDays&" days of the invoice. Delivery: within "&LeadDays&" days of your order."',
         '="Bank: "&CoBank&IF(UpiId&""<>"","  ·  UPI: "&UpiId,"")']
for i, t in enumerate(terms):
    qt[f"B{QT + 2 + i}"] = t
    qt[f"B{QT + 2 + i}"].font = Font(name=FONT, size=9)
qt[f"H{QT + 7}"] = '="For "&CoName'
qt[f"H{QT + 9}"] = "Authorised Signatory"
for c in (f"H{QT + 7}", f"H{QT + 9}"):
    qt[c].font = Font(name=FONT, size=9)
qt.print_area = f"A1:K{QT + 9}"
qt.page_setup.paperSize = qt.PAPERSIZE_A4
qt.page_setup.fitToWidth = 1
qt.page_setup.fitToHeight = 1
qt.sheet_properties.pageSetUpPr.fitToPage = True
wa_block(qt, f'IFERROR(INDEX({PT("C")},{QPR}),"")',
         f'$C$7&" "&$C$8&" from "&LEFT(CoName,40)&": Rs "&TEXT($K${QT + 5},"#,##0")&" incl. GST, valid till "'
         f'&TEXT($C$10,"dd-mm-yyyy")&". Reply YES to confirm the order."',
         ("N5", "O5", "P5"), "M5", "Send on WhatsApp")
qt["M6"] = "Macro QuoteToInvoice turns this into a sales invoice in one click."
qt["M6"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== RECEIPT (3-inch / 80 mm thermal printer)
rc = wb.create_sheet("Receipt")
rc.sheet_view.showGridLines = False
for col, w in zip("ABC", (22, 7, 11)):
    rc.column_dimensions[col].width = w
for i, f in enumerate(["=CoName", "=CoAddr", '="GSTIN "&CoGSTIN', '="Ph "&CoPhone']):
    rc.merge_cells(f"A{1 + i}:C{1 + i}")
    rc[f"A{1 + i}"] = f
    rc[f"A{1 + i}"].font = Font(name=FONT, size=12 if i == 0 else 8, bold=i == 0)
    rc[f"A{1 + i}"].alignment = Alignment(horizontal="center", wrap_text=True)
rc["A6"] = "Bill No >"
rc["B6"] = "=Invoice!$C$7"
rc.merge_cells("B6:C6")
in_cell(rc["B6"])
rc["B6"].comment = Comment("Shows the invoice open on the Invoice sheet. Type any invoice number to print its receipt.", "ERP")
RFR = f"MATCH($B$6,{S('B')},0)"
rc["A7"] = f'=IFERROR(TEXT(INDEX({S("A")},{RFR}),"dd-mm-yyyy")&"  "&INDEX({S("C")},{RFR}),"")'
rc.merge_cells("A7:C7")
for c in ("A6", "A7"):
    rc[c].font = Font(name=FONT, size=8, bold=c == "A6")
for j, h in enumerate(["Item", "Qty", "Amount"]):
    c = rc.cell(8, 1 + j, h)
    c.font = Font(name=FONT, size=8, bold=True)
    c.border = Border(top=thin, bottom=thin)
R_LINES = 20
for i in range(R_LINES):
    r = 9 + i
    row_ = f"({RFR}+{i})"
    ok = f'IFERROR(INDEX({S("B")},{row_})=$B$6,FALSE)'
    rc[f"A{r}"] = f'=IF({ok},LEFT(INDEX({S("D")},{row_}),24),"")'
    rc[f"B{r}"] = f'=IF(A{r}="","",INDEX({S("E")},{row_}))'
    rc[f"C{r}"] = f'=IF(A{r}="","",INDEX({S("Q")},{row_}))'
    for col, fmt in (("A", None), ("B", QTY), ("C", "#,##0.00")):
        rc[f"{col}{r}"].font = Font(name=FONT, size=8)
        if fmt:
            rc[f"{col}{r}"].number_format = fmt
RT = 9 + R_LINES
rtot = [("Taxable", f"=SUMIFS({S('L')},{S('B')},$B$6)"),
        ("GST", f"=SUMIFS({S('N')},{S('B')},$B$6)+SUMIFS({S('O')},{S('B')},$B$6)+SUMIFS({S('P')},{S('B')},$B$6)"),
        ("TOTAL", f"=ROUND(C{RT}+C{RT + 1},0)")]
for i, (lbl, f) in enumerate(rtot):
    rc[f"A{RT + i}"] = lbl
    rc[f"C{RT + i}"] = f
    rc[f"C{RT + i}"].number_format = "#,##0.00"
    for col in "AC":
        rc[f"{col}{RT + i}"].font = Font(name=FONT, size=11 if i == 2 else 8, bold=i == 2)
rc[f"A{RT}"].border = rc[f"C{RT}"].border = Border(top=thin)
rc[f"A{RT + 3}"] = f'=IFERROR("Paid: "&IF(INDEX({S("H")},{RFR})="","Credit",INDEX({S("H")},{RFR})),"")'
rc[f"A{RT + 4}"] = '=IF(UpiId&""="","","UPI: "&UpiId)'
rc[f"A{RT + 5}"] = "Thank you! Visit again."
for i in range(3, 6):
    rc.merge_cells(f"A{RT + i}:C{RT + i}")
    rc[f"A{RT + i}"].font = Font(name=FONT, size=8, bold=i == 5)
    rc[f"A{RT + i}"].alignment = Alignment(horizontal="center")
rc.print_area = f"A1:C{RT + 5}"
rc.page_setup.fitToWidth = 1
rc.page_setup.fitToHeight = 0
rc.sheet_properties.pageSetUpPr.fitToPage = True
rc.page_margins.left = rc.page_margins.right = 0.1
rc.page_margins.top = rc.page_margins.bottom = 0.2
home_link(rc, "E1")
rc["E3"] = "For a 3-inch (80 mm) thermal printer: Ctrl+P, pick the printer, paper 80 mm. Width fits automatically."
rc["E3"].font = Font(name=FONT, size=8, italic=True)

# =================================================================== GUIDE
gd = wb.create_sheet("Guide")
gd.sheet_view.showGridLines = False
gd.column_dimensions["A"].width = 3
gd.column_dimensions["B"].width = 34
gd.column_dimensions["C"].width = 95
gd.merge_cells("B1:C1")
gd["B1"] = "HOW SMARTTRADER ERP WORKS"
gd["B1"].font = f_title
for c in ("A1", "B1", "C1"):
    gd[c].fill = fill(NAVY)
gd.row_dimensions[1].height = 30
guide = [
    ("H", "START HERE: 5 STEPS, EVERYTHING ELSE FILLS ITSELF"),
    ("1. Settings", "Your shop name, GSTIN, state and opening cash / bank."),
    ("2. Items and Parties", "Your products (with opening stock) and your customers / suppliers."),
    ("3. Every day", "Type bills on Sales and Purchases, money in / out on CashBook. Only cream cells are for typing."),
    ("4. Look", "Dashboard for the day's picture. Money Due for who owes what. GST Returns at month end."),
    ("5. Print / share", "Invoice, Quotation, Receipt, Statement and Purchase Order print on one page and have a WhatsApp button."),
    ("H", "DAILY FLOW: PROCURE → STOCK → SELL → DELIVER → COLLECT"),
    ("1. Set up once", "Settings: company, GSTIN, home state, FY start, opening cash/bank. Items: product list with opening stock. Parties: customers & suppliers with state and credit limit."),
    ("2. Buy (Purchases)", "Pick supplier and item from dropdowns, type qty. Rate blank = standard purchase rate. 'Paid Via' blank = on credit (creates payable)."),
    ("3. Stock updates itself", "Items sheet instantly shows closing stock, weighted-average cost, stock value and REORDER / OUT OF STOCK / DEAD STOCK alerts."),
    ("4. Sell (Sales)", "One line per item; keep all lines of an invoice together. CGST+SGST or IGST is chosen automatically from customer state vs. your home state. 'Stock Check' warns on negative stock or selling below cost."),
    ("5. Print invoice", "Invoice sheet shows the latest invoice automatically. Type any invoice number in the cream cell to reprint. Ctrl+P (fits one A4 page). Doubles as delivery challan."),
    ("6. Deliver", "Set the Delivery column (Pending / Packed / Dispatched / Delivered). Dashboard counts what is still pending."),
    ("7. Collect & pay (CashBook)", "Receipt = money from customer; Payment = money to supplier; Expense = shop costs; Transfer In/Out moves money between Cash/Bank/UPI (enter both legs)."),
    ("8. Review", "Dashboard for the live picture, Reports for monthly P&L, GST rate-wise summary and expense analysis."),
    ("H", "PAIN POINTS THIS SOLVES"),
    ("Stock never matches", "Single source of truth: stock = opening + purchases − sales ± adjustments. No manual stock register."),
    ("Don't know real profit", "Every sale line carries COGS at weighted-average cost, so gross and net profit are exact per line, item, month."),
    ("Money stuck with customers", "Party ledger with credit limit, credit days, OVERDUE / OVER LIMIT flags and Days Unpaid."),
    ("Running out / overstock", "Reorder level + suggested order qty, days-of-cover, and dead-stock detection (no sale in N days)."),
    ("GST headache", "Automatic CGST/SGST vs IGST split, rate-wise output vs input summary per FY, net payable on dashboard."),
    ("Double entry for cash sales", "'Paid Via' on the bill itself books cash/bank/UPI immediately - no separate receipt needed."),
    ("Typing errors", "Dropdowns everywhere, unique-name checks, qty/date validation, row-level 'Check' columns."),
    ("Slow, crashing Excel files", "See SPEED DESIGN below."),
    ("H", "MONEY, GST AND COMPLIANCE TOOLS"),
    ("Money Due (Collections)", "Every customer and supplier with 0-30 / 31-60 / 61-90 / 90+ day ageing, overdue amount, an 8-week due schedule, a credit score with a suggested credit limit, the next action, and a one-click WhatsApp payment reminder."),
    ("MSME 43B(h) tracker", "Mark Micro / Small suppliers on Parties (column J) and whether you have a written agreement (K). The sheet shows the legal pay-by limit (15 days, or up to 45 with an agreement), what is already late and what falls due in 7 days. Unpaid MSME dues at the year end are not deductible under Income-tax section 43B(h) until you pay."),
    ("GST credit 180-day alert", "GST input credit must be paid back if a supplier bill stays unpaid for 180 days (section 16(2)). Collections column N shows the GST at risk per supplier; the GST sheet reminds you to reverse it in GSTR-3B."),
    ("GST Returns", "Pick a month: GSTR-1 tables (B2B, B2C, credit notes, nil-rated, HSN summary split B2B / B2C) and GSTR-3B (3.1, 4A, 4B) with the credit set-off in the legal order and the cash to pay. Record the payment in CashBook as type 'GST Paid'."),
    ("Cash Flow", "An 8-week forecast from the due dates of every unpaid bill, your average weekly expenses and the GST due on the 20th. Shows the week money runs short before it happens."),
    ("Purchase Order", "Items whose stock will not last the supplier's lead time + your cover days (Settings B30:B31), grouped by the supplier you last bought from. Print it or send it on WhatsApp."),
    ("Statement", "A one-page statement of account for any party: ageing, month-by-month bills and payments with a running balance. Print or share on WhatsApp."),
    ("Quotation / Receipt", "Quotation, estimate, proforma invoice, sales order or delivery challan with GST, and a 3-inch (80 mm) thermal receipt for counter sales."),
    ("Balance Sheet", "Assets, liabilities and owner's capital with a self-check that tells you when an entry is missing. Profit & loss for all entries next to it."),
    ("Profit Leaks / Cash Tally", "Profit Leaks: discounts, below-cost sales, stock losses, returns, interest on overdue money, dead stock, GST credit and MSME deductions at risk - each with what to do. Cash Tally: count the notes in the drawer and see any shortage at once."),
    ("Targets", "Reports column N: type a sales target per month; the Dashboard shows how much of this month's target is done."),
    ("H", "SPEED DESIGN (why it stays fast)"),
    ("No volatile functions", "No OFFSET/INDIRECT in cell formulas; TODAY() appears once (Settings!B10). Volatile names are used only by dropdowns, which are not recalculated."),
    ("Bounded ranges", f"All lookups use fixed ranges ({N_TX:,} transaction rows, {N_ITEMS} items, {N_PARTIES} parties) - never whole-column A:A references."),
    ("Match once, reuse", "Each transaction row runs one MATCH into a hidden helper column, then several cheap INDEX calls reuse it."),
    ("SUMIFS engine", "All aggregation uses SUMIFS/COUNTIFS - Excel's fastest multi-threaded aggregation functions. No SUMPRODUCT or array formulas."),
    ("Extra boost (optional)", "Import ERP_Macros.bas (File > Save As .xlsm, Alt+F11 > File > Import) for one-click Fast Mode, new invoice, PDF invoice, backup and archive."),
    ("H", "RULES & LIMITS"),
    ("Colour code", "Blue text on cream = you type. Black/grey = formula, never overwrite. Green = linked from another sheet."),
    ("Sample data", "Rows already filled are DEMO data. Clear only the cream input cells (or run ClearDemoData macro) before going live."),
    ("Capacity", f"{N_TX:,} lines per register per year. At year end: Save As a new file, set new FY start, carry forward closing stock as Opening Qty/Rate and party balances as Opening Bal."),
    ("Returns (credit / debit notes)", "Sales return: a Sales line with a MINUS qty and its own number (e.g. CN-0001). Stock comes back, GST and the customer's balance go down, and the Invoice sheet prints it as a CREDIT NOTE. Purchase return: a minus qty on Purchases (debit note). Use Adjustments only for damage, expiry and count corrections."),
    ("Costing method", "Weighted-average cost over the year (opening + all purchases). COGS uses the current average, the standard method for traders."),
    ("Assumption", "Currency ₹ and Indian GST structure. Rates in Settings are editable; verify slabs with your CA."),
]
if C_ENGINE:
    guide += [
        ("H", "C ENGINE EDITION (SmartTrader64.xll)"),
        ("What it is", "A native Excel add-in written in C. Stock, cost, GST, party ledgers and the cash book are posted in one pass by compiled code - six formulas instead of ~100,000. Results are identical to the formula edition, cell for cell."),
        ("Install once", "1) Copy SmartTrader64.xll (or SmartTrader32.xll for 32-bit Office) to a folder, e.g. Documents\\SmartTrader. 2) Right-click it > Properties > tick 'Unblock' > OK (Windows blocks add-ins downloaded from the internet). 3) Excel > File > Options > Add-ins > Manage: Excel Add-ins > Go > Browse > pick the .xll > OK."),
        ("Check it works", "Dashboard top-right shows 'Engine: SmartTrader C Engine 1.0'. A red '!! C engine not loaded' means step 3 was skipped and the grey columns show NAME errors until the add-in is loaded. Your typed data is never affected."),
        ("Which .xll?", "Excel > File > Account > About Excel shows '64-bit' or '32-bit'. Use the matching file."),
        ("Capacity", f"{N_TX:,} lines per register, {N_ITEMS:,} items, {N_PARTIES:,} parties. A full recalculation of the sample data takes about 5 ms."),
        ("Do not", "Sort the register sheets (the grey output blocks are single array formulas; use the filter arrows instead) or type inside grey columns."),
        ("Platforms", "Excel for Windows (2010 and later, 32- or 64-bit). On Mac / Excel Online use the formula edition (SmartTrader_ERP.xlsx), which has the same layout."),
    ]
r = 3
for k, v in guide:
    if k == "H":
        r += 1
        gd.merge_cells(f"B{r}:C{r}")
        gd[f"B{r}"] = v
        gd[f"B{r}"].font = Font(name=FONT, size=11, bold=True, color="FFFFFF")
        gd[f"B{r}"].fill = fill(TEAL)
        gd[f"C{r}"].fill = fill(TEAL)
    else:
        gd[f"B{r}"], gd[f"C{r}"] = k, v
        gd[f"B{r}"].font = f_bold
        gd[f"C{r}"].font = f_calc
        gd[f"C{r}"].alignment = Alignment(wrap_text=True, vertical="top")
        gd[f"B{r}"].alignment = Alignment(vertical="top")
        gd.row_dimensions[r].height = 28
    r += 1
gd.cell(1, 5, "« Home").hyperlink = "#Dashboard!A1"

# =================================================================== SAMPLE DATA
random.seed(7)
BIG = SAMPLE == "big"
items = [
    ("Basmati Rice 25kg", "8901001", "Grocery", "Bag", "1006", 0.05, 1650, 1950, 10, 40, 1620),
    ("Sugar 50kg", "8901002", "Grocery", "Bag", "1701", 0.05, 2050, 2280, 8, 25, 2000),
    ("Refined Oil 15L", "8901003", "Grocery", "Box", "1512", 0.05, 1880, 2120, 10, 30, 1850),
    ("Tea Premium 1kg", "8901004", "FMCG", "Pack", "0902", 0.05, 380, 470, 20, 60, 375),
    ("Detergent 5kg", "8901005", "FMCG", "Pack", "3402", 0.18, 520, 640, 15, 50, 510),
    ("Toothpaste 150g x12", "8901006", "FMCG", "Box", "3306", 0.05, 900, 1080, 10, 25, 880),
    ("LED Bulb 9W", "8901007", "Electrical", "Pcs", "8539", 0.18, 62, 99, 100, 300, 60),
    ("Copper Wire 90m", "8901008", "Electrical", "Pcs", "8544", 0.18, 2450, 2900, 5, 12, 2400),
    ("PVC Pipe 1in 6m", "8901009", "Hardware", "Pcs", "3917", 0.18, 210, 275, 40, 120, 205),
    ("Cement 50kg", "8901010", "Hardware", "Bag", "2523", 0.18, 340, 395, 50, 200, 335),
    ("A4 Paper Ream", "8901011", "Stationery", "Pack", "4802", 0.12, 245, 310, 30, 80, 240),
    ("Ceiling Fan 1200mm", "8901012", "Electrical", "Pcs", "8414", 0.18, 1650, 2150, 5, 4, 1600),
    ("Plastic Bucket 20L", "8901013", "Hardware", "Pcs", "3924", 0.18, 175, 230, 10, 0, 0),
]
for i, row in enumerate(items):
    for j, v in enumerate(row):
        it.cell(FIRST + i, 1 + j, v)

parties = [
    ("Sharma Kirana Store", "Customer", "9810000001", "08AAAPS1111A1Z1", "Rajasthan", "Jaipur", 50000, 15, 12000),
    ("Gupta Electricals", "Customer", "9810000002", "08AAAPG2222B1Z2", "Rajasthan", "Ajmer", 80000, 30, 0),
    ("Delhi Hardware Mart", "Customer", "9810000003", "07AAAPD3333C1Z3", "Delhi", "Karol Bagh, Delhi", 100000, 30, 0),
    ("Walk-in Customer", "Customer", "", "", "Rajasthan", "", 0, 0, 0),
    ("Mehta Constructions", "Customer", "9810000005", "08AAAPM5555E1Z5", "Rajasthan", "Jodhpur", 60000, 21, 8000),
    ("Agro Foods Pvt Ltd", "Supplier", "9810000006", "08AABCA6666F1Z6", "Rajasthan", "Kota", 0, 30, -25000),
    ("Bharat Electric Co", "Supplier", "9810000007", "27AABCB7777G1Z7", "Maharashtra", "Mumbai", 0, 45, 0),
    ("National Hardware Supply", "Supplier", "9810000008", "08AABCN8888H1Z8", "Rajasthan", "Jaipur", 0, 30, 0),
    ("FMCG Distributors", "Both", "9810000009", "08AABCF9999J1Z9", "Rajasthan", "Jaipur", 40000, 15, 0),
    ("Shree Plastics Udyog", "Supplier", "9810000010", "08AAKFS1010K1Z0", "Rajasthan", "Sanganer, Jaipur", 0, 30, 0),
]
msme = {"Agro Foods Pvt Ltd": ("Micro", "Yes"), "National Hardware Supply": ("Small", "No"),
        "Shree Plastics Udyog": ("Micro", "No"), "Bharat Electric Co": ("Medium", "")}
for i, row in enumerate(parties):
    for j, v in enumerate(row + msme.get(row[0], ("", ""))):
        if v != "":
            pt.cell(FIRST + i, 1 + j, v)

supplier_of = {"Grocery": "Agro Foods Pvt Ltd", "FMCG": "FMCG Distributors", "Electrical": "Bharat Electric Co",
               "Hardware": "National Hardware Supply", "Stationery": "FMCG Distributors"}
start = date(2026, 4, 1)
today = date(2026, 10, 10)
items = [x[:7] + (round(x[7] * 1.08),) + x[8:] for x in items]  # demo margins ~20%
by_name = {x[0]: x for x in items}
for i, row in enumerate(items):
    it.cell(FIRST + i, 8, row[7])
stock = {x[0]: x[9] for x in items}
customers = [p_[0] for p_ in parties if p_[1] in ("Customer", "Both")]
opening = {p_[0]: p_[8] for p_ in parties}
owed = {c: max(0, opening[c]) for c in customers}             # what customers owe us
due = {s_: -min(0, opening[s_]) for s_ in set(supplier_of.values())}  # what we owe suppliers
purch_rows, sale_rows, cash_rows = [], [], []
bill = inv = vno = 0
slow_movers = {"A4 Paper Ream"}  # demo: no restock -> shows REORDER


def gross(itm, qty, rate, disc=0.0):
    return qty * rate * (1 - disc) * (1 + itm[5])


def restock(day):
    global bill
    for sup in sorted(set(supplier_of.values())):
        lines = [x for x in items if supplier_of[x[2]] == sup and x[0] not in slow_movers
                 and stock[x[0]] < 3 * x[8]]
        if not lines:
            continue
        bill += 1
        mode = random.choice(["", "", "", "Bank"])
        for itm in lines:
            q = 5 * itm[8] - stock[itm[0]]
            rate = round(itm[6] * random.uniform(0.98, 1.03), 0)
            purch_rows.append((day, f"B-{bill:04d}", sup, itm[0], q, rate, None, mode))
            stock[itm[0]] += q
            if not mode:
                due[sup] += gross(itm, q, rate)


d = start
while d <= today:
    if d.day == 1 or d == start:
        restock(d + timedelta(days=1) if d != start else d)
    if d.weekday() != 6:  # shop closed on Sunday
        for _ in range(random.choice([2, 3, 3, 4] if BIG else [0, 1, 1, 1])):
            inv += 1
            cust = random.choice(customers + ["Walk-in Customer"] * 2)
            mode = "Cash" if cust == "Walk-in Customer" else random.choice(["", "", "", "UPI", "Bank"])
            for itm in random.sample(items, random.choice([1, 2, 2, 3] if BIG else [1, 1, 2])):
                if itm[0] in slow_movers and d > date(2026, 7, 15):
                    continue
                q = max(1, int(itm[8] * (random.uniform(0.05, 0.25) if BIG else random.uniform(0.35, 0.9))))
                if stock[itm[0]] - q < 0:
                    continue
                stock[itm[0]] -= q
                disc = random.choice([None, None, None, 0.02, 0.05])
                deliv = "Delivered" if (today - d).days > 4 else random.choice(["Pending", "Packed", "Dispatched"])
                sale_rows.append((d, f"INV-{inv:04d}", cust, itm[0], q, None, disc, mode, deliv))
                if not mode:
                    owed[cust] += gross(itm, q, itm[7], disc or 0)
    if d.day in ((10, 25) if BIG else (10,)):  # collection & payment runs
        for cust in customers:
            share = 0.25 if cust == "FMCG Distributors" else random.uniform(0.55, 0.9)
            amt = int(owed[cust] * share / 100) * 100
            if amt > 0:
                vno += 1
                owed[cust] -= amt
                cash_rows.append((d, f"V-{vno:04d}", "Receipt", cust, None, random.choice(["Bank", "UPI"]), amt, "NEFT/UPI"))
        for sup in sorted(due):
            amt = int(due[sup] * random.uniform(0.6, 0.85) / 1000) * 1000
            if amt > 0:
                vno += 1
                due[sup] -= amt
                cash_rows.append((d, f"V-{vno:04d}", "Payment", sup, None, "Bank", amt, "RTGS"))
    if d.day == 5:
        for head, amt, acc in [("Rent", 18000 if BIG else 9000, "Bank"), ("Salary", 26000 if BIG else 12000, "Bank"),
                               ("Electricity", random.randint(3200, 5200), "UPI"),
                               ("Transport / Freight", random.randint(4500, 9000), "Cash"),
                               ("Telephone / Internet", 1199, "UPI")]:
            vno += 1
            cash_rows.append((d, f"V-{vno:04d}", "Expense", None, head, acc, amt, ""))
    if d.day == 26:  # sweep surplus cash & UPI into the bank
        for acc, keep in (("Cash", 25000), ("UPI", 10000)):
            bal = (50000 if acc == "Cash" else 0) + sum(
                r_[6] * (1 if r_[2] in ("Receipt", "Other Income", "Capital In", "Transfer In") else -1)
                for r_ in cash_rows if r_[5] == acc) + sum(
                gross(by_name[r_[3]], r_[4], by_name[r_[3]][7], r_[6] or 0) for r_ in sale_rows if r_[7] == acc) - sum(
                gross(by_name[r_[3]], r_[4], r_[5]) for r_ in purch_rows if r_[7] == acc)
            amt = int((bal - keep) / 1000) * 1000
            if amt > 0:
                vno += 1
                cash_rows.append((d, f"V-{vno:04d}", "Transfer Out", None, None, acc, amt, f"{acc} deposited to Bank"))
                cash_rows.append((d, f"V-{vno:04d}", "Transfer In", None, None, "Bank", amt, f"{acc} deposited to Bank"))
    d += timedelta(days=1)
cash_rows += [(date(2026, 8, 1), "V-9002", "Other Income", None, "Misc", "Bank", 1500, "Scheme incentive"),
              (date(2026, 9, 1), "V-9003", "Drawings", None, None, "Bank", 30000, "Owner withdrawal")]
# an MSME supplier bill left unpaid for 190 days: shows the 43B(h) and GST 180-day alerts
purch_rows.append((date(2026, 4, 2), "SP-118", "Shree Plastics Udyog", "Plastic Bucket 20L", 40, 172, None, None))
# returns: credit notes (minus qty on Sales) and a debit note (minus qty on Purchases)
sale_rows += [(date(2026, 8, 20), "CN-0001", "Mehta Constructions", "Cement 50kg", -5, None, None, None, "Returned"),
              (date(2026, 9, 15), "CN-0002", "Gupta Electricals", "Ceiling Fan 1200mm", -1, None, None, None, "Returned")]
purch_rows.append((date(2026, 7, 12), "DN-0001", "Bharat Electric Co", "LED Bulb 9W", -20, None, None, None))
purch_rows.sort(key=lambda x: x[0])
sale_rows.sort(key=lambda x: x[0])
# GST of each month paid on the 20th of the next (September's is still due on 20 October)
net_gst = {}
for r_ in sale_rows:
    itm = by_name[r_[3]]
    net_gst[r_[0].month] = net_gst.get(r_[0].month, 0) + r_[4] * itm[7] * (1 - (r_[6] or 0)) * itm[5]
for r_ in purch_rows:
    itm = by_name[r_[3]]
    net_gst[r_[0].month] = net_gst.get(r_[0].month, 0) - r_[4] * (r_[5] or itm[6]) * itm[5]
for m_, v_ in sorted(net_gst.items()):
    if v_ > 0 and date(2026, m_ + 1, 20) <= today:
        vno += 1
        cash_rows.append((date(2026, m_ + 1, 20), f"V-{vno:04d}", "GST Paid", None, None, "Bank", round(v_),
                          f"GSTR-3B {date(2026, m_, 1):%b-%Y}"))
cash_rows.sort(key=lambda x: x[0])
for ws, rows in ((pu, purch_rows), (sa, sale_rows), (cb, cash_rows)):
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            if v not in (None, ""):
                ws.cell(FIRST + i, 1 + j, v)

adj_rows = [(date(2026, 5, 20), "Refined Oil 15L", -2, "Damage", "Leaking tins"),
            (date(2026, 7, 2), "LED Bulb 9W", -6, "Count Correction", "Physical count"),
            (date(2026, 9, 10), "Basmati Rice 25kg", 1, "Count Correction", "Found in the godown")]
for i, row in enumerate(adj_rows):
    for j, v in enumerate(row):
        ad.cell(FIRST + i, 1 + j, v)

# sample quotation and monthly targets
qt["H7"] = "Delhi Hardware Mart"
for i, (itm_, q_, d_) in enumerate((("Ceiling Fan 1200mm", 10, None), ("Copper Wire 90m", 5, None), ("LED Bulb 9W", 200, 0.05))):
    qt[f"B{HR + 1 + i}"], qt[f"D{HR + 1 + i}"] = itm_, q_
    if d_:
        qt[f"G{HR + 1 + i}"] = d_
monthly = {}
for r_ in sale_rows:
    monthly[r_[0].month] = monthly.get(r_[0].month, 0) + r_[4] * by_name[r_[3]][7] * (1 - (r_[6] or 0))
target = round(1.1 * sum(monthly.values()) / max(1, len(monthly)), -4)
for rr in range(5, 17):
    rp[f"N{rr}"] = target

# =================================================================== PLANS
pl = wb.create_sheet("Plans")
pl.sheet_view.showGridLines = False
for col, w in zip("ABCDE", (3, 40, 22, 22, 22)):
    pl.column_dimensions[col].width = w
pl.merge_cells("B1:E1")
pl["B1"] = "SMARTTRADER ERP  -  FREE vs PRO"
pl["B1"].font = f_title
for c in "ABCDE":
    pl[f"{c}1"].fill = fill(NAVY)
pl.row_dimensions[1].height = 30
pl.merge_cells("B2:E2")
pl["B2"] = "=LicStatus"
pl["B2"].font = Font(name=FONT, size=11, bold=True, color="FFFFFF")
pl["B2"].fill = fill("F9A825")
pl["B2"].alignment = Alignment(horizontal="center")
pl.conditional_formatting.add("B2", FormulaRule(formula=["IsPro"], fill=fill("2E7D32")))
pl["G1"] = "« Home"
pl["G1"].hyperlink = "#Dashboard!A1"
pl["G1"].font = Font(name=FONT, bold=True, color="0563C1", underline="single")

head = ["Feature", "FREE", "PRO", ""]
rows_ = [
    ("Sales, Purchases, Cash Book lines counted", f"First {FREE_LINES} each", f"All ({N_TX:,} each)"),
    ("Items & parties", "Unlimited", "Unlimited"),
    ("Live stock, avg cost, reorder & dead-stock alerts", "Yes", "Yes"),
    ("GST: CGST/SGST/IGST split, GSTR-1 tables + HSN summary, GSTR-3B with set-off", "Yes", "Yes"),
    ("Customer / supplier ledgers, ageing, statements, WhatsApp reminders", "Yes", "Yes"),
    ("Tax invoice, credit / debit notes, quotation, 80 mm receipt", "Yes", "Yes"),
    ("MSME 43B(h) pay-by tracker and GST 180-day credit alert", "Yes", "Yes"),
    ("8-week cash-flow forecast, purchase orders by supplier", "Yes", "Yes"),
    ("Credit score + suggested limit, profit leak finder, cash tally", "Yes", "Yes"),
    ("Dashboard, monthly P&L + targets, balance sheet", "Yes", "Yes"),
    ("C Engine add-in (Windows, 20k lines, ~6 ms recalculation)", f"First {FREE_LINES} lines", "Full"),
    ("Macros: PDF invoices, backup, year-end rollover", "Yes", "Yes"),
    ("Updates & WhatsApp support", "-", "Yes"),
]
for j, h in enumerate(head[:3]):
    c = pl.cell(4, 2 + j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill(TEAL if j < 2 else "5E35B1"), center, box
for i, (f_, free_, pro_) in enumerate(rows_):
    r = 5 + i
    for j, v in enumerate((f_, free_, pro_)):
        c = pl.cell(r, 2 + j, v)
        c.border, c.font = box, f_bold if j == 0 else f_calc
        c.alignment = Alignment(horizontal="left" if j == 0 else "center", vertical="center", wrap_text=True)
    pl.row_dimensions[r].height = 22

r0 = 5 + len(rows_) + 1
pl[f"B{r0}"] = "PRO PRICING"
pl[f"B{r0}"].font = Font(name=FONT, size=12, bold=True, color=NAVY)
for j, h in enumerate(["Plan", "Price", "Per month", "You save"]):
    c = pl.cell(r0 + 1, 2 + j, h)
    c.font, c.fill, c.alignment, c.border = f_head, fill("5E35B1"), center, box
monthly = LIC.PRICES["M"]
for i, code in enumerate(("M", "H", "Y")):
    r = r0 + 2 + i
    label, days = LIC.PLANS[code]
    months = round(days / 30.4)
    pl[f"B{r}"] = f"Pro - {label}" + ("   (best value)" if code == "Y" else "")
    pl[f"C{r}"] = LIC.PRICES[code]
    pl[f"D{r}"] = f"=C{r}/{months}"
    pl[f"E{r}"] = f"=IF({monthly}*{months}-C{r}<=0,\"-\",{monthly}*{months}-C{r})"
    for col in "BCDE":
        c = pl[f"{col}{r}"]
        c.border, c.font = box, f_bold if col == "B" else f_calc
        c.alignment = Alignment(horizontal="left" if col == "B" else "center")
    pl[f"C{r}"].number_format = pl[f"D{r}"].number_format = pl[f"E{r}"].number_format = INR0
pl[f"B{r0 + 5}"] = "Prices in Indian Rupees. GST extra where applicable."
pl[f"B{r0 + 5}"].font = Font(name=FONT, size=8, italic=True)

r1 = r0 + 7
steps = [
    "HOW TO UPGRADE",
    f"1.  Buy online at  {LIC.SELLER_CONTACT}",
    "2.  You receive a license key like  PRO-H270411-1HEK",
    "3.  Settings sheet: type the same mobile number in B14 and paste the key in B15",
    "4.  This page and the Dashboard turn green: every line now counts. Your data is never lost - lines",
    "     entered beyond the Free limit were kept and are counted the moment Pro is active.",
]
for i, t in enumerate(steps):
    pl[f"B{r1 + i}"] = t
    pl[f"B{r1 + i}"].font = Font(name=FONT, size=12 if i == 0 else 10, bold=i == 0, color=NAVY if i == 0 else "000000")

r2 = r1 + len(steps) + 1
pl[f"B{r2}"] = "HOW PRO COMPARES (yearly price, Oct 2026 listings)"
pl[f"B{r2}"].font = Font(name=FONT, size=12, bold=True, color=NAVY)
comp = [("Product", "Price / year", "Per month", "Works offline, your data stays in your file"),
        ("SmartTrader Pro (this file)", f"Rs {LIC.PRICES['Y']:,}", f"Rs {round(LIC.PRICES['Y'] / 12)}", "Yes - plain Excel, no login"),
        ("myBillBook Plus / Pro", "Rs 3,490 - 3,990", "Rs 291 - 333", "Cloud account"),
        ("Vyapar Desktop", "Rs 3,399 - 4,099", "Rs 283 - 342", "Desktop app"),
        ("TallyPrime Silver (rental)", "Rs 8,100", "Rs 675", "Desktop app")]
for i, row in enumerate(comp):
    for j, v in enumerate(row):
        c = pl.cell(r2 + 1 + i, 2 + j, v)
        c.border = box
        c.font = f_head if i == 0 else (f_bold if i == 1 else f_calc)
        c.alignment = Alignment(horizontal="left" if j in (0, 3) else "center", wrap_text=True)
        if i == 0:
            c.fill = fill(TEAL)
        elif i == 1:
            c.fill = fill("E8F5E9")
pl.column_dimensions["E"].width = 34
pl[f"B{r2 + 7}"] = "Competitor prices are public listings and change often; they include cloud/mobile features this file does not."
pl[f"B{r2 + 7}"].font = Font(name=FONT, size=8, italic=True)

# sheet order & tab colours
order = ["Dashboard", "Sales", "Purchases", "CashBook", "Items", "Parties", "Adjustments", "Invoice", "Quotation",
         "Receipt", "Collections", "Statement", "CashFlow", "PurchaseOrder", "GST", "Reports", "BalanceSheet",
         "ProfitLeaks", "CashTally", "Settings", "Plans", "Guide", "Lic"]
assert sorted(order) == sorted(wb.sheetnames), set(wb.sheetnames) ^ set(order)
wb._sheets = [wb[n] for n in order]
for n, color in zip(order, [NAVY, "0E7C86", "6A1B9A", "2E7D32", "283593", "EF6C00", "6D4C41", "37474F", "00838F",
                            "37474F", "E65100", "E65100", "0D47A1", "6A1B9A", "455A64", "00838F", "1B5E20",
                            "C62828", "2E7D32", "757575", "5E35B1", "9E9E9E"]):
    wb[n].sheet_properties.tabColor = color
wb.active = 0
if C_ENGINE:
    inputs = [("IN_Items", f"Items!$A${FIRST}:$K${IT_END}"), ("IN_Parties", f"Parties!$A${FIRST}:$K${PT_END}"),
              ("IN_Purchases", f"Purchases!$A${FIRST}:$H${TX_END}"), ("IN_Sales", f"Sales!$A${FIRST}:$I${TX_END}"),
              ("IN_CashBook", f"CashBook!$A${FIRST}:$H${TX_END}"), ("IN_Adjust", f"Adjustments!$A${FIRST}:$E${ADJ_END}"),
              ("IN_Settings", "Settings!$B$4:$B$35")]
    for n_, ref in inputs:
        name(n_, ref)
    args = ",".join(n_ for n_, _ in inputs)
    for ws, fn, c1, c2, end in [(it, "ST_ITEMS", "L", "AE", IT_END), (pu, "ST_PURCHASES", "I", "S", TX_END),
                                (sa, "ST_SALES", "J", "Z", TX_END), (pt, "ST_PARTIES", "L", "U", PT_END),
                                (cb, "ST_CASHBOOK", "I", "K", TX_END), (ad, "ST_ADJUST", "F", "G", ADJ_END),
                                (co, "ST_AGEING", "E", "V", PT_END)]:
        ws[f"{c1}{FIRST}"] = ArrayFormula(f"{c1}{FIRST}:{c2}{end}", f"=_xll.{fn}({args})")
        note = "A3" if ws is co else f"{c1}3"
        ws[note] = f"C engine: {{=_xll.{fn}(...)}} fills {c1}:{c2}"
        ws[note].font = Font(name=FONT, size=8, italic=True, color="595959")
    co["E5"].font, co["E5"].number_format = f_calc, INR0
    # cells written above (sample data, array anchors) need the column style explicitly
    for ws in (it, pt, pu, sa, cb, ad):
        for row in ws.iter_rows(min_row=FIRST, max_row=ws.max_row):
            for c in row:
                if c.value is not None:
                    cd = ws.column_dimensions[c.column_letter]
                    c.font, c.fill, c.number_format = copy(cd.font), copy(cd.fill), cd.number_format
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print(f"saved {OUT}: {len(purch_rows)} purchase lines, {len(sale_rows)} sale lines, {len(cash_rows)} cash entries")
