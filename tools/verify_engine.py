"""Cell-by-cell accuracy check: C engine vs. the formula edition of the ERP.

usage: python tools/verify_engine.py <formula-workbook.xlsx> <work-dir> <harness-binary>

The formula workbook must carry calculated values (it is recalculated by
LibreOffice before shipping). Its input blocks are fed to the C engine through
the test harness, and every engine output cell is compared with the value the
spreadsheet formulas produced for the same cell.
"""
import math
import os
import subprocess
import sys

from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_engine_io import read_out, serial, write_block  # noqa: E402

src, work, harness = sys.argv[1:4]
os.makedirs(work, exist_ok=True)
wb = load_workbook(src, data_only=True)

def last_row(ws):
    return ws.max_row


def block(ws, c1, c2, r1, r2):
    a, b = column_index_from_string(c1), column_index_from_string(c2)
    return [[ws.cell(r, c).value for c in range(a, b + 1)] for r in range(r1, r2 + 1)]


# (input name, sheet, first col, last col) and (output name, sheet, first col, last col)
INPUTS = [("items", "Items", "A", "K"), ("parties", "Parties", "A", "I"), ("purchases", "Purchases", "A", "H"),
          ("sales", "Sales", "A", "I"), ("cashbook", "CashBook", "A", "H"), ("adjust", "Adjustments", "A", "E")]
OUTPUTS = [("items", "Items", "L", "Z"), ("purchases", "Purchases", "I", "S"), ("sales", "Sales", "J", "X"),
           ("parties", "Parties", "J", "S"), ("cashbook", "CashBook", "I", "K"), ("adjust", "Adjustments", "F", "G")]
ends = {}
for name, sheet, c1, c2 in INPUTS:
    ws = wb[sheet]
    ends[sheet] = last_row(ws)
    write_block(work, name, block(ws, c1, c2, 5, ends[sheet]))
write_block(work, "settings", block(wb["Settings"], "B", "B", 4, 15))

res = subprocess.run([harness, "verify", work], capture_output=True, text=True)
print(res.stdout, res.stderr, sep="")
if res.returncode:
    sys.exit("harness failed")


def same(exp, got):
    exp = serial(exp)
    if exp is None or exp == "":
        return got == ""
    if isinstance(exp, str):
        return exp == got
    if got == "":
        return False
    return math.isclose(float(exp), got, rel_tol=1e-9, abs_tol=0.0051)


total = bad = 0
for name, sheet, c1, c2 in OUTPUTS:
    ws = wb[sheet]
    exp = block(ws, c1, c2, 5, ends[sheet])
    got = read_out(work, name)
    base = column_index_from_string(c1)
    misses = 0
    for r, (er, gr) in enumerate(zip(exp, got)):
        for c, (e, g) in enumerate(zip(er, gr)):
            # unit of an item whose Unit cell is blank: formula shows 0, engine shows "" (intended)
            total += 1
            if not same(e, g):
                misses += 1
                if misses <= 5:
                    print(f"  MISMATCH {sheet}!{ws.cell(5 + r, base + c).coordinate}: formula={e!r} engine={g!r}")
    bad += misses
    print(f"{sheet:<12} {len(exp):>5} rows x {len(exp[0]):>2} cols  mismatches: {misses}")
print(f"\nchecked {total:,} cells, mismatches: {bad}")
sys.exit(1 if bad else 0)
