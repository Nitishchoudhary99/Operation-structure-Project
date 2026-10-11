#!/usr/bin/env bash
# Full verification matrix for SmartTrader ERP.
#   tools/test_all.sh <recalc.py>        (recalc.py = LibreOffice recalculation script)
# Builds every edition/plan variant, recalculates the formula workbooks, and checks:
#   - zero formula errors and Excel 2007 compatibility
#   - C engine == formulas, cell by cell, on Free / Pro / expired licences
#   - C-engine workbook end to end (dashboard, reports, invoice) == formula edition
#   - the real Windows .xll under Wine == native build
set -euo pipefail
RECALC=${1:?usage: tools/test_all.sh <recalc.py>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$ROOT/xll/build/matrix}
mkdir -p "$WORK"
cd "$ROOT"

echo "== C engine: build, registration, edge cases"
make -s -C xll all build/harness
./xll/build/harness register | tail -1
./xll/build/harness selftest

TODAY=$(date +%F)
PRO_KEY=$(python3 -c "import sys,datetime as d; sys.path.insert(0,'tools'); import license_tool as L; print(L.make_key('9876543210','H',d.date.fromisoformat('$TODAY')+d.timedelta(days=182)))")
OLD_KEY=$(python3 -c "import sys,datetime as d; sys.path.insert(0,'tools'); import license_tool as L; print(L.make_key('9876543210','H',d.date.fromisoformat('$TODAY')-d.timedelta(days=1)))")
echo "   test keys: valid $PRO_KEY   expired $OLD_KEY"

variant() {  # name, expected IsPro, extra build args...
    local name=$1 expect=$2; shift 2
    local f="$WORK/$name.xlsx"
    echo "== formula edition: $name"
    python3 tools/build_erp.py "$f" "$@" >/dev/null
    python3 "$RECALC" "$f" 600 | python3 -c "import json,sys; d=json.load(sys.stdin); print('   recalc:', d['status'], d['total_formulas'], 'formulas,', d['total_errors'], 'errors'); sys.exit(d['total_errors']!=0)"
    python3 tools/check_compat.py "$f" | tail -1 | sed 's/^/   /'
    python3 -c "
from openpyxl import load_workbook
v = load_workbook('$f', data_only=True)['Lic']['A10'].value
print('   licence: IsPro =', v, '(expected $expect)'); assert str(v) == '$expect'"
    python3 tools/verify_engine.py "$f" "$WORK/v-$name" ./xll/build/harness | tail -1 | sed 's/^/   engine vs formulas: /'
}

variant small-free False
variant big-free False --sample big
variant big-pro True --sample big --license-id 9876543210 --license-key "$PRO_KEY"
variant big-expired False --sample big --license-id 9876543210 --license-key "$OLD_KEY"

for v in small-free big-pro; do
    echo "== C-engine edition end to end: $v"
    args=(); [[ $v == big-pro ]] && args=(--sample big --license-id 9876543210 --license-key "$PRO_KEY")
    python3 tools/build_erp.py "$WORK/C-$v.xlsx" --engine c "${args[@]}" >/dev/null
    python3 tools/check_compat.py "$WORK/C-$v.xlsx" --allow-xll | tail -1 | sed 's/^/   /'
    python3 tools/simulate_c_workbook.py "$WORK/C-$v.xlsx" "$WORK/$v.xlsx" ./xll/build/harness "$WORK/sim-$v" "$RECALC" \
        | grep -E "recalc|stock value|cells compared" | sed 's/^/   /'
done

echo "== real Windows add-in under Wine"
rm -rf xll/build/verify && cp -r "$WORK/v-big-pro" xll/build/verify
make -s -C xll wintest 2>&1 | grep -E "identical|DIFFERS" | sed 's/^/   /'
echo "ALL CHECKS PASSED"
