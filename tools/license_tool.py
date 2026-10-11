"""SmartTrader Pro licensing: plans, prices and license keys.

Seller usage (issue a key after payment):
    python tools/license_tool.py <mobile-no> <M|H|Y> [--start YYYY-MM-DD]
    -> PRO-H270409-4KQ2   (valid for that mobile number until the expiry date in the key)

Key format  PRO-<plan><YYMMDD expiry>-<4-char check>,  plan M = 1 month, H = 6 months, Y = 12 months.
The check binds the key to the buyer's mobile number and expiry date. The same algorithm runs in
the workbook (plain Excel 2007 formulas on a very-hidden sheet) and in the C engine, so one key
unlocks both editions.

SECURITY NOTE: a spreadsheet cannot hide a secret from a determined user - the check formula is
inside the file. This deters casual copying and key sharing; it is not DRM. Set your own secret
before selling:  export ST_LICENSE_KEYS="k1,k2,k3,k4"  (k2 <= 10007, k3 <= 9973) and rebuild the
workbooks and the add-in with the same value. The default below is a public demo secret.
"""
import argparse
import datetime as dt
import os
import sys

FREE_LINES = int(os.environ.get("ST_FREE_LINES", "200"))
K1, K2, K3, K4 = (int(x) for x in os.environ.get("ST_LICENSE_KEYS", "7919,10007,9967,424242").split(","))
assert K2 <= 10007 and K3 <= 9973, "keep k2/k3 small so Excel's MOD stays exact"

PLANS = {  # code: (label, days of validity)
    "M": ("1 month", 30),
    "H": ("6 months", 182),
    "Y": ("12 months", 365),
}
# Selling prices in INR (GST extra if you are registered). Single source for the Plans sheet.
PRICES = {"M": 149, "H": 799, "Y": 1299}
SELLER_CONTACT = os.environ.get("ST_SELLER_CONTACT", "WhatsApp: +91-XXXXXXXXXX  ·  UPI: yourname@upi")

ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MSG_LEN, ID_LEN = 40, 20


def excel_trim(s: str) -> str:
    """Excel TRIM: drop leading/trailing spaces and collapse inner runs of spaces."""
    return " ".join(p for p in s.split(" ") if p)


def check_code(lic_id: str, plan: str, expiry: dt.date) -> str:
    msg = f"{excel_trim(str(lic_id))[:ID_LEN]}|{plan}|{expiry.year * 10000 + expiry.month * 100 + expiry.day}"
    msg = (msg + " " * MSG_LEN)[:MSG_LEN]
    s = sum(ord(c) * ((i * K1) % K2 + 1) for i, c in enumerate(msg, 1))
    v = (s * K3 + K4) % 1679616
    return "".join(ALPHA[(v // 36 ** p) % 36] for p in (3, 2, 1, 0))


def make_key(lic_id: str, plan: str, expiry: dt.date) -> str:
    lic_id = excel_trim(str(lic_id))
    if not lic_id or len(lic_id) > ID_LEN or not lic_id.isascii():
        raise ValueError("license id must be 1-20 plain ASCII characters (use the buyer's mobile number)")
    if plan not in PLANS:
        raise ValueError(f"plan must be one of {', '.join(PLANS)}")
    if not 2000 < expiry.year < 2100:
        raise ValueError("expiry year must be 2001-2099")
    return f"PRO-{plan}{expiry:%y%m%d}-{check_code(lic_id, plan, expiry)}"


def verify(lic_id: str, key: str, today: dt.date):
    """Mirror of the workbook / C logic. Returns (is_pro, expiry or None)."""
    key = excel_trim(key).upper()
    if len(key) != 16 or not key.startswith("PRO-") or key[11] != "-" or key[4] not in PLANS:
        return False, None
    try:
        expiry = dt.date(2000 + int(key[5:7]), int(key[7:9]), int(key[9:11]))
    except ValueError:
        return False, None
    ok = check_code(lic_id, key[4], expiry) == key[12:] and excel_trim(str(lic_id)) != ""
    return ok and today <= expiry, expiry if ok else None


def main():
    ap = argparse.ArgumentParser(description="Issue a SmartTrader Pro license key")
    ap.add_argument("mobile", help="buyer's registered mobile number (they type the same in Settings)")
    ap.add_argument("plan", choices=list(PLANS), help="M = 1 month, H = 6 months, Y = 12 months")
    ap.add_argument("--start", type=dt.date.fromisoformat, default=dt.date.today(), help="start date (default today)")
    a = ap.parse_args()
    label, days = PLANS[a.plan]
    expiry = a.start + dt.timedelta(days=days)
    key = make_key(a.mobile, a.plan, expiry)
    print(f"Plan      : Pro {label}  (Rs {PRICES[a.plan]:,})")
    print(f"Mobile    : {a.mobile}")
    print(f"Valid till: {expiry:%d-%b-%Y}")
    print(f"KEY       : {key}")
    if "ST_LICENSE_KEYS" not in os.environ:
        print("\nWARNING: using the public demo secret - set ST_LICENSE_KEYS before selling.", file=sys.stderr)


if __name__ == "__main__":
    main()
