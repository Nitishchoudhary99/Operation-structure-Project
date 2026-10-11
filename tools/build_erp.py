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
DATE = "dd-mmm-yy"

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


# =================================================================== SETTINGS
st = wb.create_sheet("Settings")
banner(st, "SETTINGS & MASTER LISTS", "Set this up once. Every list here feeds the dropdowns across the ERP.", 12)
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

lists = {
    "D": ("Categories", ["Grocery", "FMCG", "Electrical", "Hardware", "Stationery", "Garments", "Other"]),
    "E": ("Units", ["Pcs", "Kg", "Ltr", "Box", "Bag", "Mtr", "Dozen", "Pack"]),
    "F": ("GST Rates", [0, 0.05, 0.12, 0.18, 0.28, 0.40, 0.03, 0.0025]),
    "G": ("Pay Modes", ["Credit", "Cash", "Bank", "UPI"]),
    "H": ("Voucher Types", ["Receipt", "Payment", "Expense", "Other Income", "Capital In",
                             "Drawings", "Transfer In", "Transfer Out"]),
    "I": ("Expense Heads", ["Rent", "Salary", "Electricity", "Transport / Freight", "Packing",
                             "Telephone / Internet", "Repairs", "Bank Charges", "Misc"]),
    "J": ("Party Types", ["Customer", "Supplier", "Both"]),
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
]
banner(it, "ITEM MASTER & LIVE STOCK",
       "One row per product. Stock, cost, value and reorder alerts update automatically from Purchases, Sales and Adjustments.",
       len(it_headers))
register(it, it_headers, N_ITEMS, 11)
it.column_dimensions["Z"].hidden = True

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
    ("Opening Bal (₹) +recv / -pay", 12, INR),
    ("Credit Sales (₹)", 12, INR), ("Received (₹)", 12, INR), ("Credit Purchases (₹)", 12, INR),
    ("Paid (₹)", 12, INR), ("Balance (₹)", 13, INR), ("Position", 11, None), ("Last Sale", 10, DATE),
    ("Last Receipt", 10, DATE), ("Days Unpaid", 8, "0"), ("Alert", 14, None),
]
banner(pt, "CUSTOMERS & SUPPLIERS (PARTY LEDGER)",
       "Balance > 0 means the party owes you (receivable); < 0 means you owe them (payable).", len(pt_headers))
register(pt, pt_headers, N_PARTIES, 9)
for r in (range(FIRST, PT_END + 1) if not C_ENGINE else ()):
    g = f'IF($A{r}="","",'
    pt[f"J{r}"] = f"={g}SUMIFS({S('Q')},{S('C')},$A{r})-SUMIFS({S('X')},{S('C')},$A{r}))"
    pt[f"K{r}"] = f'={g}SUMIFS({C_("G")},{C_("D")},$A{r},{C_("C")},"Receipt"))'
    pt[f"L{r}"] = f"={g}SUMIFS({P('P')},{P('C')},$A{r})-SUMIFS({P('S')},{P('C')},$A{r}))"
    pt[f"M{r}"] = f'={g}SUMIFS({C_("G")},{C_("D")},$A{r},{C_("C")},"Payment"))'
    pt[f"N{r}"] = f"={g}N($I{r})+J{r}-K{r}-L{r}+M{r})"
    pt[f"O{r}"] = f'={g}IF(ROUND(N{r},2)>0,"Receivable",IF(ROUND(N{r},2)<0,"Payable","Settled")))'
    pt[f"P{r}"] = f"={g}IFERROR(SUMPRODUCT(MAX(({S('C')}=$A{r})*{S('A')})),0))"
    pt[f"Q{r}"] = f'={g}IFERROR(SUMPRODUCT(MAX(({C_("D")}=$A{r})*({C_("C")}="Receipt")*{C_("A")})),0))'
    pt[f"R{r}"] = f'={g}IF(ROUND(N{r},2)<=0,"",AsOf-IF(N(Q{r})>0,Q{r},IF(N(P{r})>0,P{r},FYStart))))'
    pt[f"S{r}"] = (f'={g}IF(AND(N($G{r})>0,N{r}>N($G{r})),"OVER LIMIT",'
                   f'IF(AND(N{r}>0,N(R{r})>N($H{r})),"OVERDUE",IF(ROUND(N{r},2)<0,"PAY DUE",""))))')
pt["R4"].comment = Comment("Days since the last receipt from this party (or since the last sale if nothing was ever received). OVERDUE when this exceeds Credit Days.", "ERP")
name("L_Parties", f"OFFSET(Parties!$A${FIRST},0,0,MAX(1,COUNTA(Parties!$A${FIRST}:$A${PT_END})),1)")
add_list_dv(pt, f"B{FIRST}:B{PT_END}", "L_PartyTypes")
add_list_dv(pt, f"E{FIRST}:E{PT_END}", "L_States")
dv = DataValidation(type="custom", formula1=f"COUNTIF($A${FIRST}:$A${PT_END},A{FIRST})=1", allow_blank=True)
dv.error, dv.showErrorMessage = "This party already exists. Party names must be unique.", True
pt.add_data_validation(dv)
dv.add(f"A{FIRST}:A{PT_END}")
rng = f"S{FIRST}:S{PT_END}"
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
       "One line per item received. Stock, average cost, supplier payable and GST input credit update instantly.",
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
]
banner(sa, "SALES / INVOICES (DELIVER)",
       "One line per item sold. Keep all lines of an invoice together. Leave Rate blank to use the standard sale rate.",
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
    sa[f"T{r}"] = (f'={g}IF(U{r}="","UNKNOWN ITEM",IF(INDEX({I_("O")},U{r})<0,"NEG STOCK",'
                   f'IF(K{r}<INDEX({I_("P")},U{r}),"BELOW COST","OK"))))')
    sa[f"X{r}"] = f'={g}IF(OR($H{r}="",$H{r}="Credit"),0,Q{r}))'
for col in "UVW":
    sa.column_dimensions[col].hidden = True
rng = f"T{FIRST}:T{TX_END}"
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"NEG STOCK"'], fill=fill("FFC7CE")))
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"BELOW COST"'], fill=fill("FFEB9C")))
sa.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"UNKNOWN ITEM"'], fill=fill("FF7C80")))
sa.conditional_formatting.add(f"I{FIRST}:I{TX_END}", CellIsRule(operator="equal", formula=['"Pending"'], fill=fill("FFEB9C")))
# band alternate invoices for readability
sa.conditional_formatting.add(f"A{FIRST}:I{TX_END}",
                              FormulaRule(formula=[f'AND($B{FIRST}<>"",ISODD(N($W{FIRST})))'], fill=fill("FFF1C1")))

for ws in (pu, sa):
    add_list_dv(ws, f"C{FIRST}:C{TX_END}", "L_Parties", "Pick a party (add new ones on the Parties sheet)")
    add_list_dv(ws, f"D{FIRST}:D{TX_END}", "L_Items", "Pick an item (add new ones on the Items sheet)")
    add_list_dv(ws, f"H{FIRST}:H{TX_END}", "L_PayModes")
    dv = DataValidation(type="decimal", operator="greaterThan", formula1="0", allow_blank=True)
    dv.error, dv.showErrorMessage = "Quantity must be greater than 0 (use Adjustments for returns/losses).", True
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


lock_rows(sa, "J", "X", "D", "T")
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
iv["A5"] = "TAX INVOICE / DELIVERY CHALLAN"
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
for c in ("B7", "B8", "B9", "G7", "G8", "G9", "G10"):
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
iv[f"B{TR}"].font = Font(name=FONT, size=9, color="C00000")
iv[f"B{TR + 1}"] = '="Bank: "&CoBank'
iv[f"B{TR + 2}"] = "Goods once sold will be taken back only as per store policy."
iv[f"B{TR + 4}"] = "Receiver's Signature"
iv[f"H{TR + 7}"] = '="For "&CoName'
iv[f"H{TR + 9}"] = "Authorised Signatory"
for c in (f"B{TR + 1}", f"B{TR + 2}", f"B{TR + 4}", f"H{TR + 7}", f"H{TR + 9}"):
    iv[c].font = Font(name=FONT, size=9)
iv.print_area = f"A1:K{TR + 9}"
iv.page_setup.orientation = "portrait"
iv.page_setup.paperSize = iv.PAPERSIZE_A4
iv.page_setup.fitToWidth = 1
iv.page_setup.fitToHeight = 1
iv.sheet_properties.pageSetUpPr.fitToPage = True

# =================================================================== REPORTS
rp = wb.create_sheet("Reports")
banner(rp, "REPORTS: MONTHLY P&L, GST, EXPENSES", "Financial-year view built from all registers. Nothing to type here.", 12)
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
name("DFrom", "Dashboard!$D$4")
name("DTo", "Dashboard!$G$4")

nav = [("New Sale", "Sales"), ("Purchase", "Purchases"), ("Cash Book", "CashBook"),
       ("Items", "Items"), ("Parties", "Parties"), ("Invoice", "Invoice"),
       ("Adjust", "Adjustments"), ("Reports", "Reports"), ("Settings", "Settings"), ("Guide", "Guide"),
       ("PRO Plans", "Plans")]
for i, (lbl, target) in enumerate(nav):
    c = db.cell(6, 2 + i, lbl)
    c.hyperlink = f"#{target}!A1"
    c.font = Font(name=FONT, size=9, bold=True, color="FFFFFF")
    c.fill = fill(TEAL)
    c.alignment = center
    c.border = Border(left=Side(style="thick", color="FFFFFF"), right=Side(style="thick", color="FFFFFF"))
db.row_dimensions[6].height = 24

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
    ("RECEIVABLES (owed to you)", f"=SUMIF({PT('N')},\">0\")", INR0, "EF6C00"),
    ("PAYABLES (you owe)", f"=-SUMIF({PT('N')},\"<0\")", INR0, "AD1457"),
    ("STOCK VALUE (at cost)", f"=SUM({I_('Q')})", INR0, "283593"),
    ("NET GST PAYABLE", f"=SUMIFS({S('N')},{win_s})+SUMIFS({S('O')},{win_s})+SUMIFS({S('P')},{win_s})-SUMIFS({P('M')},{win_p})-SUMIFS({P('N')},{win_p})-SUMIFS({P('O')},{win_p})", INR0, "455A64"),
    ("ITEMS TO REORDER", f"=COUNTIF({I_('R')},\"REORDER\")+COUNTIF({I_('R')},\"OUT OF STOCK\")+COUNTIF({I_('R')},\"NEGATIVE\")", "0", "F9A825"),
    ("DEAD-STOCK ITEMS", f"=COUNTIF({I_('R')},\"DEAD STOCK\")", "0", "6D4C41"),
    ("OVERDUE CUSTOMERS", f"=COUNTIF({PT('S')},\"OVERDUE\")+COUNTIF({PT('S')},\"OVER LIMIT\")", "0", "D84315"),
    ("PENDING DELIVERIES (lines)", f"=COUNTIFS({S('I')},\"Pending\")+COUNTIFS({S('I')},\"Packed\")", "0", "0277BD"),
    ("NEXT INVOICE No.", f'=InvPrefix&TEXT(MAX({S("W")})+1,"0000")', None, "37474F"),
]
# 5 cards per row, each card spans 2 cols at cols B,D,F,H,J ... use B..K? layout: 3 rows x 5 cards
pos = []
for row_i in range(3):
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

# Cash & bank balances
r0 = 18
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
db["I18"] = "TOP 10 ITEMS BY SALES (all time)"
db["I18"].font = Font(name=FONT, size=11, bold=True, color=NAVY)
for j, h in enumerate(["#", "Item", "", "Sales (₹)", "Stock", "Status"]):
    c = db.cell(19, 9 + j, h)
    c.font, c.fill, c.alignment = f_head, fill(TEAL), center
for k in range(10):
    r = 20 + k
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
    db.conditional_formatting.add("N20:N29", CellIsRule(operator="equal", formula=[f'"{txt}"'], fill=fill(color)))

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
db.add_chart(ch, "B32")
lc = LineChart()
lc.title = "Monthly Gross & Net Profit (FY)"
lc.add_data(Reference(rp, min_col=4, min_row=4, max_row=16), titles_from_data=True)
lc.add_data(Reference(rp, min_col=9, min_row=4, max_row=16), titles_from_data=True)
lc.set_categories(Reference(rp, min_col=1, min_row=5, max_row=16))
lc.height, lc.width = 7.5, 13
lc.y_axis.numFmt = '#,##0'
for ax in (lc.x_axis, lc.y_axis):
    ax.delete = False
db.add_chart(lc, "I32")

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
    ("Returns", "Sales return: Adjustments with +qty, reason 'Sales Return', plus a Payment / credit in CashBook. Purchase return: −qty and a Receipt from supplier."),
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
]
for i, row in enumerate(parties):
    for j, v in enumerate(row):
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
purch_rows.sort(key=lambda x: x[0])
cash_rows.sort(key=lambda x: x[0])
for ws, rows in ((pu, purch_rows), (sa, sale_rows), (cb, cash_rows)):
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            if v not in (None, ""):
                ws.cell(FIRST + i, 1 + j, v)

adj_rows = [(date(2026, 5, 20), "Refined Oil 15L", -2, "Damage", "Leaking tins"),
            (date(2026, 7, 2), "LED Bulb 9W", -6, "Count Correction", "Physical count"),
            (date(2026, 9, 10), "Basmati Rice 25kg", 1, "Sales Return", "Returned by Sharma Kirana")]
for i, row in enumerate(adj_rows):
    for j, v in enumerate(row):
        ad.cell(FIRST + i, 1 + j, v)

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
    ("GST: CGST/SGST/IGST split, rate-wise GSTR summary", "Yes", "Yes"),
    ("Customer / supplier ledgers, credit-limit & overdue alerts", "Yes", "Yes"),
    ("A4 tax invoice / delivery challan", "Yes", "Yes"),
    ("Dashboard, monthly P&L, expense analysis", "Yes", "Yes"),
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
order = ["Dashboard", "Sales", "Purchases", "CashBook", "Items", "Parties", "Adjustments", "Invoice", "Reports",
         "Settings", "Plans", "Guide", "Lic"]
wb._sheets = [wb[n] for n in order]
for n, color in zip(order, [NAVY, "0E7C86", "6A1B9A", "2E7D32", "283593", "EF6C00", "6D4C41", "37474F", "00838F", "757575", "5E35B1", "9E9E9E"]):
    wb[n].sheet_properties.tabColor = color
wb.active = 0
if C_ENGINE:
    inputs = [("IN_Items", f"Items!$A${FIRST}:$K${IT_END}"), ("IN_Parties", f"Parties!$A${FIRST}:$I${PT_END}"),
              ("IN_Purchases", f"Purchases!$A${FIRST}:$H${TX_END}"), ("IN_Sales", f"Sales!$A${FIRST}:$I${TX_END}"),
              ("IN_CashBook", f"CashBook!$A${FIRST}:$H${TX_END}"), ("IN_Adjust", f"Adjustments!$A${FIRST}:$E${ADJ_END}"),
              ("IN_Settings", "Settings!$B$4:$B$15")]
    for n_, ref in inputs:
        name(n_, ref)
    args = ",".join(n_ for n_, _ in inputs)
    for ws, fn, c1, c2, end in [(it, "ST_ITEMS", "L", "Z", IT_END), (pu, "ST_PURCHASES", "I", "S", TX_END),
                                (sa, "ST_SALES", "J", "X", TX_END), (pt, "ST_PARTIES", "J", "S", PT_END),
                                (cb, "ST_CASHBOOK", "I", "K", TX_END), (ad, "ST_ADJUST", "F", "G", ADJ_END)]:
        ws[f"{c1}{FIRST}"] = ArrayFormula(f"{c1}{FIRST}:{c2}{end}", f"=_xll.{fn}({args})")
        ws[f"{c1}3"] = f"C engine: {{=_xll.{fn}(...)}} fills {c1}:{c2}"
        ws[f"{c1}3"].font = Font(name=FONT, size=8, italic=True, color="595959")
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
