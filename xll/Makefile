# SmartTrader XLL build
#   make            -> dist/SmartTrader64.xll + dist/SmartTrader32.xll (cross-compiled with mingw-w64)
#   make test       -> native test harness + registration check + accuracy check vs the formula workbook
#   make bench      -> synthetic speed test
SRC      = src/engine.c src/smarttrader.c
HDR      = src/engine.h src/xlcall_min.h
# Plan rules: keep in sync with tools/license_tool.py (same environment variables)
ST_LICENSE_KEYS ?= 7919,10007,9967,424242
ST_FREE_LINES   ?= 200
CFLAGS   = -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -DST_FREE_LINES=$(ST_FREE_LINES) '-DST_LIC_K=$(ST_LICENSE_KEYS)'
# Key for the harness licence tests, made with the same secret (see test/harness.c)
TEST_KEY := $(shell cd .. && ST_LICENSE_KEYS='$(ST_LICENSE_KEYS)' python3 -c "import sys,datetime as d; sys.path.insert(0,'tools'); import license_tool as L; print(L.make_key('9876543210','H',d.date(2027,4,11)))" 2>/dev/null)
TESTDEFS = $(if $(TEST_KEY),'-DST_TEST_KEY="$(TEST_KEY)"',)
WINE     ?= $(firstword $(wildcard /usr/lib/wine/wine64 /usr/bin/wine64 /usr/bin/wine))
WINFLAGS = $(CFLAGS) -shared -static -static-libgcc -s -Wl,--kill-at

all: dist/SmartTrader64.xll dist/SmartTrader32.xll

dist/SmartTrader64.xll: $(SRC) $(HDR)
	@mkdir -p dist
	x86_64-w64-mingw32-gcc $(WINFLAGS) -o $@ $(SRC)

dist/SmartTrader32.xll: $(SRC) $(HDR)
	@mkdir -p dist
	i686-w64-mingw32-gcc $(WINFLAGS) -o $@ $(SRC)

build/harness: $(SRC) $(HDR) test/harness.c
	@mkdir -p build
	cc $(CFLAGS) $(TESTDEFS) -DST_TEST -fsanitize=address,undefined -g -o $@ $(SRC) test/harness.c -lm

build/harness-fast: $(SRC) $(HDR) test/harness.c
	@mkdir -p build
	cc $(CFLAGS) $(TESTDEFS) -DST_TEST -march=native -o $@ $(SRC) test/harness.c -lm

test: build/harness
	./build/harness register
	./build/harness selftest
	python3 ../tools/verify_engine.py ../excel/SmartTrader_ERP.xlsx build/verify ./build/harness

bench: build/harness-fast
	./build/harness-fast bench 3000
	./build/harness-fast bench 100000
	./build/harness-fast bench 1000000

clean:
	rm -rf build

.PHONY: all test bench clean wintest

# Windows-ABI test: run the real .xll inside a fake Excel host under Wine
build/winhost64.exe: test/winhost.c src/xlcall_min.h
	@mkdir -p build
	x86_64-w64-mingw32-gcc -std=c11 -O2 -Wall -o $@ test/winhost.c

wintest: dist/SmartTrader64.xll build/winhost64.exe build/harness
	@mkdir -p build/win-out
	WINEDEBUG=-all $(WINE) build/winhost64.exe dist/SmartTrader64.xll build/verify build/win-out
	@for f in items purchases sales parties cashbook adjust; do \
	  cmp -s build/verify/out_$$f.tsv build/win-out/out_$$f.tsv && echo "  $$f: identical to native build" \
	  || { echo "  $$f: DIFFERS"; exit 1; }; done

.PHONY: wintest
