"""Excel-version compatibility audit for the SmartTrader workbooks.

usage: python tools/check_compat.py <workbook.xlsx> [--allow-xll]

Scans every cell formula, array formula, data-validation rule, conditional-format
rule and defined name, and fails if anything needs a newer Excel than 2007:
  * functions outside the Excel 2007 function set (MAXIFS, IFS, XLOOKUP, FILTER, ...)
  * any _xlfn. prefix (that is how newer functions are stored in the file)
  * conditional formatting / validation formulas that point at other sheets
    directly (Excel 2007 rejects that; named ranges are fine)
  * characters outside the fonts every Windows/Mac Office ships (emoji etc.)
--allow-xll accepts _xll.ST_* add-in calls (C engine edition).
"""
import re
import sys

from openpyxl import load_workbook
from openpyxl.worksheet.formula import ArrayFormula

# Excel 2007 worksheet functions (incl. former Analysis ToolPak, built in since 2007)
EXCEL2007 = set("""
ABS ACCRINT ACCRINTM ACOS ACOSH ADDRESS AMORDEGRC AMORLINC AND AREAS ASC ASIN ASINH ATAN ATAN2 ATANH
AVEDEV AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS BAHTTEXT BESSELI BESSELJ BESSELK BESSELY BETADIST BETAINV
BIN2DEC BIN2HEX BIN2OCT BINOMDIST CEILING CELL CHAR CHIDIST CHIINV CHITEST CHOOSE CLEAN CODE COLUMN
COLUMNS COMBIN COMPLEX CONCATENATE CONFIDENCE CONVERT CORREL COS COSH COUNT COUNTA COUNTBLANK COUNTIF
COUNTIFS COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD COVAR CRITBINOM CUBEKPIMEMBER CUBEMEMBER
CUBEMEMBERPROPERTY CUBERANKEDMEMBER CUBESET CUBESETCOUNT CUBEVALUE CUMIPMT CUMPRINC DATE DATEDIF DATEVALUE
DAVERAGE DAY DAYS360 DB DCOUNT DCOUNTA DDB DEC2BIN DEC2HEX DEC2OCT DEGREES DELTA DEVSQ DGET DISC DMAX DMIN
DOLLAR DOLLARDE DOLLARFR DPRODUCT DSTDEV DSTDEVP DSUM DURATION DVAR DVARP EDATE EFFECT EOMONTH ERF ERFC
ERROR.TYPE EVEN EXACT EXP EXPONDIST FACT FACTDOUBLE FALSE FDIST FIND FINDB FINV FISHER FISHERINV FIXED
FLOOR FORECAST FREQUENCY FTEST FV FVSCHEDULE GAMMADIST GAMMAINV GAMMALN GCD GEOMEAN GESTEP GETPIVOTDATA
GROWTH HARMEAN HEX2BIN HEX2DEC HEX2OCT HLOOKUP HOUR HYPERLINK HYPGEOMDIST IF IFERROR IMABS IMAGINARY
IMARGUMENT IMCONJUGATE IMCOS IMDIV IMEXP IMLN IMLOG10 IMLOG2 IMPOWER IMPRODUCT IMREAL IMSIN IMSQRT IMSUB
IMSUM INDEX INDIRECT INFO INT INTERCEPT INTRATE IPMT IRR ISBLANK ISERR ISERROR ISEVEN ISLOGICAL ISNA
ISNONTEXT ISNUMBER ISODD ISPMT ISREF ISTEXT JIS KURT LARGE LCM LEFT LEFTB LEN LENB LINEST LN LOG LOG10
LOGEST LOGINV LOGNORMDIST LOOKUP LOWER MATCH MAX MAXA MDETERM MDURATION MEDIAN MID MIDB MIN MINA MINUTE
MINVERSE MIRR MMULT MOD MODE MONTH MROUND MULTINOMIAL N NA NEGBINOMDIST NETWORKDAYS NOMINAL NORMDIST
NORMINV NORMSDIST NORMSINV NOT NOW NPER NPV OCT2BIN OCT2DEC OCT2HEX ODD ODDFPRICE ODDFYIELD ODDLPRICE
ODDLYIELD OFFSET OR PEARSON PERCENTILE PERCENTRANK PERMUT PHONETIC PI PMT POISSON POWER PPMT PRICE
PRICEDISC PRICEMAT PROB PRODUCT PROPER PV QUARTILE QUOTIENT RADIANS RAND RANDBETWEEN RANK RATE RECEIVED
REPLACE REPLACEB REPT RIGHT RIGHTB ROMAN ROUND ROUNDDOWN ROUNDUP ROW ROWS RSQ RTD SEARCH SEARCHB SECOND
SERIESSUM SIGN SIN SINH SKEW SLN SLOPE SMALL SQRT SQRTPI STANDARDIZE STDEV STDEVA STDEVP STDEVPA STEYX
SUBSTITUTE SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ SUMX2MY2 SUMX2PY2 SUMXMY2 SYD T TAN TANH TBILLEQ
TBILLPRICE TBILLYIELD TDIST TEXT TIME TIMEVALUE TINV TODAY TRANSPOSE TREND TRIM TRIMMEAN TRUE TRUNC TTEST
TYPE UPPER USDOLLAR VALUE VAR VARA VARP VARPA VDB VLOOKUP WEEKDAY WEEKNUM WEIBULL WORKDAY XIRR XNPV YEAR
YEARFRAC YIELD YIELDDISC YIELDMAT ZTEST
""".split())

FUNC = re.compile(r"(_xll\.|_xlfn\.)?([A-Z_][A-Z0-9._]*)\s*\(", re.I)
STRING = re.compile(r'"(?:[^"]|"")*"')
SHEETREF = re.compile(r"(?:'[^']+'|[A-Za-z_][\w.]*)!")
# Arial / Calibri / Segoe UI cover Latin, Latin-1, General Punctuation, arrows, ₹, box drawing
SAFE = re.compile(r"[\x09\x0a\x0d\x20-\x7e -ɏ -⁯₠-₿←-↕−■-●]")

allow_xll = "--allow-xll" in sys.argv
path = [a for a in sys.argv[1:] if not a.startswith("--")][0]
wb = load_workbook(path)
problems = []
counts = {"formulas": 0, "validations": 0, "conditional formats": 0, "names": 0}


def audit(where, formula, kind):
    body = STRING.sub('""', formula)            # ignore text inside string literals
    for prefix, fn in FUNC.findall(body):
        fn_u = fn.upper()
        if prefix.lower() == "_xll.":
            if not (allow_xll and fn_u.startswith("ST_")):
                problems.append(f"{where}: add-in function _xll.{fn} ({kind})")
        elif prefix.lower() == "_xlfn.":
            problems.append(f"{where}: needs newer Excel: _xlfn.{fn} ({kind})")
        elif fn_u not in EXCEL2007 and fn_u not in wb.defined_names:
            problems.append(f"{where}: function {fn} is not in Excel 2007 ({kind})")
    if kind in ("validation", "conditional format") and SHEETREF.search(body):
        problems.append(f"{where}: {kind} refers to another sheet directly (Excel 2007 needs a named range)")
    for ch in set(formula):
        if not SAFE.match(ch):
            problems.append(f"{where}: character {ch!r} U+{ord(ch):04X} may not render in older Office fonts")


for ws in wb.worksheets:
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if isinstance(v, ArrayFormula):
                v = v.text
            if isinstance(v, str):
                if v.startswith("="):
                    counts["formulas"] += 1
                    audit(f"{ws.title}!{c.coordinate}", v, "cell")
                else:
                    for ch in set(v):
                        if not SAFE.match(ch):
                            problems.append(f"{ws.title}!{c.coordinate}: character {ch!r} U+{ord(ch):04X} "
                                            "may not render in older Office fonts")
            fmt = c.number_format or ""
            for ch in set(fmt):
                if not SAFE.match(ch):
                    problems.append(f"{ws.title}!{c.coordinate}: number-format character {ch!r}")
    for dv in ws.data_validations.dataValidation:
        for f in (dv.formula1, dv.formula2):
            if f:
                counts["validations"] += 1
                audit(f"{ws.title} validation {dv.sqref}", f, "validation")
    for cf in ws.conditional_formatting:
        for rule in cf.rules:
            for f in rule.formula or []:
                counts["conditional formats"] += 1
                audit(f"{ws.title} CF {cf.sqref}", f, "conditional format")
for n, dn in wb.defined_names.items():
    counts["names"] += 1
    audit(f"name {n}", dn.attr_text, "name")

uniq = sorted(set(problems))
print(f"{path}: scanned " + ", ".join(f"{v:,} {k}" for k, v in counts.items()))
for p in uniq[:40]:
    print("  " + p)
if len(uniq) > 40:
    print(f"  ... {len(uniq) - 40} more")
print("RESULT: " + ("compatible with Excel 2007 and every later version" if not uniq else f"{len(uniq)} problems"))
sys.exit(1 if uniq else 0)
