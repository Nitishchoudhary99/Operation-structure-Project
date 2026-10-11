# SmartTrader XLL build
#   make            -> dist/SmartTrader64.xll + dist/SmartTrader32.xll (cross-compiled with mingw-w64)
#   make test       -> native test harness + registration check + accuracy check vs the formula workbook
#   make bench      -> synthetic speed test
SRC      = src/engine.c src/smarttrader.c
HDR      = src/engine.h src/xlcall_min.h
CFLAGS   = -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter
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
	cc $(CFLAGS) -DST_TEST -fsanitize=address,undefined -g -o $@ $(SRC) test/harness.c -lm

build/harness-fast: $(SRC) $(HDR) test/harness.c
	@mkdir -p build
	cc $(CFLAGS) -DST_TEST -march=native -o $@ $(SRC) test/harness.c -lm

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
