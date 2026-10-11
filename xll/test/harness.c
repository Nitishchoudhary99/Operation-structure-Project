/*
 * harness.c - drives the XLL exactly like Excel does, without Excel.
 *
 *   harness verify <dir>   load <dir>/in_*.tsv, run all 6 UDFs, write <dir>/out_*.tsv
 *   harness register       run xlAutoOpen against a mock Excel callback
 *   harness bench <lines>  synthetic workload timing
 *
 * TSV cell encoding: empty = blank, "n:<number>", "s:<text>" (\t \n \\ escaped).
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../src/engine.h"

void st_set_callback(EXCEL12PROC p);
int xlAutoOpen(void);
void xlAutoFree12(LPXLOPER12 x);
LPXLOPER12 ST_VERSION(void);
#define DECL(N) LPXLOPER12 N(LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12);
DECL(ST_ITEMS) DECL(ST_PURCHASES) DECL(ST_SALES) DECL(ST_PARTIES) DECL(ST_CASHBOOK) DECL(ST_ADJUST)

typedef LPXLOPER12 (*udf)(LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12);
static const struct { const char *name; udf fn; } UDFS[] = {
    { "items", ST_ITEMS }, { "purchases", ST_PURCHASES }, { "sales", ST_SALES },
    { "parties", ST_PARTIES }, { "cashbook", ST_CASHBOOK }, { "adjust", ST_ADJUST },
};
static const char *IN_FILES[IN_COUNT] = { "items", "parties", "purchases", "sales", "cashbook", "adjust", "settings" };

/* ---------------------------------------------------------------- UTF-8 <-> UTF-16 */
static XCHAR *utf16_counted(const char *s)
{
    size_t len = strlen(s);
    XCHAR *w = malloc(sizeof(XCHAR) * (len + 2) * 2);
    int n = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p;) {
        unsigned cp;
        if (*p < 0x80) cp = *p++;
        else if ((*p & 0xE0) == 0xC0) { cp = (*p++ & 0x1F) << 6; cp |= *p++ & 0x3F; }
        else if ((*p & 0xF0) == 0xE0) { cp = (*p++ & 0x0F) << 12; cp |= (*p++ & 0x3F) << 6; cp |= *p++ & 0x3F; }
        else { cp = (*p++ & 0x07) << 18; cp |= (*p++ & 0x3F) << 12; cp |= (*p++ & 0x3F) << 6; cp |= *p++ & 0x3F; }
        if (cp >= 0x10000) { cp -= 0x10000; w[1 + n++] = (XCHAR)(0xD800 + (cp >> 10)); w[1 + n++] = (XCHAR)(0xDC00 + (cp & 0x3FF)); }
        else w[1 + n++] = (XCHAR)cp;
    }
    w[0] = (XCHAR)n;
    return w;
}

static void put_utf8(FILE *f, const XCHAR *w, int n)
{
    for (int i = 0; i < n; i++) {
        unsigned cp = w[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < n) cp = 0x10000 + ((cp - 0xD800) << 10) + (w[++i] - 0xDC00);
        if (cp == '\t') fputs("\\t", f);
        else if (cp == '\n') fputs("\\n", f);
        else if (cp == '\\') fputs("\\\\", f);
        else if (cp < 0x80) fputc((int)cp, f);
        else if (cp < 0x800) { fputc(0xC0 | (cp >> 6), f); fputc(0x80 | (cp & 0x3F), f); }
        else if (cp < 0x10000) { fputc(0xE0 | (cp >> 12), f); fputc(0x80 | ((cp >> 6) & 0x3F), f); fputc(0x80 | (cp & 0x3F), f); }
        else { fputc(0xF0 | (cp >> 18), f); fputc(0x80 | ((cp >> 12) & 0x3F), f); fputc(0x80 | ((cp >> 6) & 0x3F), f); fputc(0x80 | (cp & 0x3F), f); }
    }
}

/* ---------------------------------------------------------------- TSV -> xltypeMulti */
static void unescape(char *s)
{
    char *o = s;
    for (char *p = s; *p; p++) {
        if (*p == '\\' && p[1]) { p++; *o++ = *p == 't' ? '\t' : *p == 'n' ? '\n' : *p; }
        else *o++ = *p;
    }
    *o = 0;
}

static XLOPER12 *load_tsv(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); exit(1); }
    int rows, cols;
    if (fscanf(f, "%d %d\n", &rows, &cols) != 2) { fprintf(stderr, "bad header %s\n", path); exit(1); }
    XLOPER12 *x = calloc(1, sizeof *x), *cells = calloc((size_t)rows * cols, sizeof *cells);
    x->xltype = xltypeMulti; x->val.array.lparray = cells; x->val.array.rows = rows; x->val.array.columns = cols;
    char *line = NULL; size_t cap = 0;
    for (int r = 0; r < rows; r++) {
        ssize_t n = getline(&line, &cap, f);
        if (n < 0) { fprintf(stderr, "short file %s\n", path); exit(1); }
        if (n && line[n - 1] == '\n') line[--n] = 0;
        char *p = line;
        for (int c = 0; c < cols; c++) {
            char *tab = strchr(p, '\t');
            if (tab) *tab = 0;
            XLOPER12 *cell = &cells[(size_t)r * cols + c];
            if (p[0] == 'n' && p[1] == ':') { cell->xltype = xltypeNum; cell->val.num = strtod(p + 2, NULL); }
            else if (p[0] == 's' && p[1] == ':') { unescape(p + 2); cell->xltype = xltypeStr; cell->val.str = utf16_counted(p + 2); }
            else cell->xltype = xltypeNil;
            p = tab ? tab + 1 : p + strlen(p);
        }
    }
    free(line);
    fclose(f);
    return x;
}

static void write_tsv(const char *path, const XLOPER12 *x)
{
    FILE *f = fopen(path, "w");
    if ((x->xltype & 0xFFF) != xltypeMulti) { fprintf(f, "ERROR %d\n", x->val.err); fclose(f); return; }
    int rows = x->val.array.rows, cols = x->val.array.columns;
    fprintf(f, "%d %d\n", rows, cols);
    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            const XLOPER12 *v = &x->val.array.lparray[(size_t)r * cols + c];
            if (c) fputc('\t', f);
            if ((v->xltype & 0xFFF) == xltypeNum) fprintf(f, "n:%.17g", v->val.num);
            else if ((v->xltype & 0xFFF) == xltypeStr && v->val.str[0]) { fputs("s:", f); put_utf8(f, v->val.str + 1, v->val.str[0]); }
        }
        fputc('\n', f);
    }
    fclose(f);
}

static void free_grid(XLOPER12 *x)
{
    size_t n = (size_t)x->val.array.rows * x->val.array.columns;
    for (size_t i = 0; i < n; i++)
        if (x->val.array.lparray[i].xltype == xltypeStr) free(x->val.array.lparray[i].val.str);
    free(x->val.array.lparray);
    free(x);
}

static double now_ms(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* ---------------------------------------------------------------- mock Excel */
static int g_registered;
static int mock_excel(int fn, int count, LPXLOPER12 *args, LPXLOPER12 res)
{
    static XCHAR dll[] = { 15, 'S','m','a','r','t','T','r','a','d','e','r','.','x','l','l' };
    if (fn == xlGetName) { res->xltype = xltypeStr; res->val.str = dll; return xlretSuccess; }
    if (fn == xlFree) return xlretSuccess;
    if (fn == xlfRegister) {
        printf("  xlfRegister(%d args): ", count);
        put_utf8(stdout, args[3]->val.str + 1, args[3]->val.str[0]);
        printf("  type=");
        put_utf8(stdout, args[2]->val.str + 1, args[2]->val.str[0]);
        printf("\n");
        res->xltype = xltypeNum; res->val.num = ++g_registered;
        return xlretSuccess;
    }
    return xlretFailed;
}

/* ---------------------------------------------------------------- synthetic workload */
static XLOPER12 *grid_new(int rows, int cols)
{
    XLOPER12 *x = calloc(1, sizeof *x), *c = calloc((size_t)rows * cols, sizeof *c);
    for (size_t i = 0; i < (size_t)rows * cols; i++) c[i].xltype = xltypeNil;
    x->xltype = xltypeMulti; x->val.array.lparray = c; x->val.array.rows = rows; x->val.array.columns = cols;
    return x;
}
static void setn(XLOPER12 *g, int r, int c, double v) { XLOPER12 *x = &g->val.array.lparray[(size_t)r * g->val.array.columns + c]; x->xltype = xltypeNum; x->val.num = v; }
static void sets(XLOPER12 *g, int r, int c, const char *s) { XLOPER12 *x = &g->val.array.lparray[(size_t)r * g->val.array.columns + c]; x->xltype = xltypeStr; x->val.str = utf16_counted(s); }

static void bench(int lines)
{
    int ni = 5000, np = 2000;
    char b[64];
    XLOPER12 *in[IN_COUNT];
    in[IN_ITEMS] = grid_new(ni, 11);
    for (int i = 0; i < ni; i++) {
        snprintf(b, sizeof b, "Item %05d", i); sets(in[IN_ITEMS], i, 0, b);
        sets(in[IN_ITEMS], i, 3, "Pcs"); setn(in[IN_ITEMS], i, 5, (i % 4) ? 0.18 : 0.05);
        setn(in[IN_ITEMS], i, 6, 100 + i % 50); setn(in[IN_ITEMS], i, 7, 125 + i % 60);
        setn(in[IN_ITEMS], i, 8, 10); setn(in[IN_ITEMS], i, 9, 50); setn(in[IN_ITEMS], i, 10, 98);
    }
    in[IN_PARTIES] = grid_new(np, 9);
    for (int i = 0; i < np; i++) {
        snprintf(b, sizeof b, "Party %04d", i); sets(in[IN_PARTIES], i, 0, b);
        sets(in[IN_PARTIES], i, 4, (i % 5) ? "Rajasthan" : "Delhi");
        setn(in[IN_PARTIES], i, 6, 50000); setn(in[IN_PARTIES], i, 7, 30);
    }
    XLOPER12 *tx[2] = { grid_new(lines / 4, 8), grid_new(lines, 9) };
    for (int k = 0; k < 2; k++) {
        int n = tx[k]->val.array.rows;
        for (int r = 0; r < n; r++) {
            setn(tx[k], r, 0, 46113 + r % 365);
            snprintf(b, sizeof b, "INV-%06d", r / 3); sets(tx[k], r, 1, b);
            snprintf(b, sizeof b, "Party %04d", (r * 7) % np); sets(tx[k], r, 2, b);
            snprintf(b, sizeof b, "Item %05d", (r * 13) % ni); sets(tx[k], r, 3, b);
            setn(tx[k], r, 4, 1 + r % 9);
            if (r % 3 == 0) sets(tx[k], r, 7, "Cash");
        }
    }
    in[IN_PURCHASES] = tx[0];
    in[IN_SALES] = tx[1];
    in[IN_CASHBOOK] = grid_new(lines / 3, 8);
    for (int r = 0; r < lines / 3; r++) {
        setn(in[IN_CASHBOOK], r, 0, 46113 + r % 365);
        sets(in[IN_CASHBOOK], r, 2, r % 2 ? "Receipt" : "Expense");
        if (r % 2) { snprintf(b, sizeof b, "Party %04d", r % np); sets(in[IN_CASHBOOK], r, 3, b); }
        else sets(in[IN_CASHBOOK], r, 4, "Rent");
        sets(in[IN_CASHBOOK], r, 5, "Bank"); setn(in[IN_CASHBOOK], r, 6, 1000 + r);
    }
    in[IN_ADJUST] = grid_new(2000, 5);
    in[IN_SETTINGS] = grid_new(10, 1);
    sets(in[IN_SETTINGS], 3, 0, "Rajasthan"); setn(in[IN_SETTINGS], 5, 0, 46113);
    setn(in[IN_SETTINGS], 6, 0, 46400); sets(in[IN_SETTINGS], 7, 0, "INV-"); setn(in[IN_SETTINGS], 8, 0, 90);

    printf("workload: %d sales lines, %d purchase lines, %d cash entries, %d items, %d parties\n",
           lines, lines / 4, lines / 3, ni, np);
    double total = 0;
    for (size_t k = 0; k < sizeof UDFS / sizeof UDFS[0]; k++) {
        int reps = 5;
        double t0 = now_ms();
        for (int i = 0; i < reps; i++) {
            LPXLOPER12 r = UDFS[k].fn(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
            xlAutoFree12(r);
        }
        double ms = (now_ms() - t0) / reps;
        total += ms;
        printf("  ST_%-10s %8.2f ms\n", UDFS[k].name, ms);
    }
    printf("  full recalculation (all 6) %.2f ms\n", total);
}

/* ---------------------------------------------------------------- edge cases */
static int g_fail;
#define CHECK(cond, ...) do { if (!(cond)) { g_fail++; printf("  FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static const XLOPER12 *cellp(const XLOPER12 *g, int r, int c) { return &g->val.array.lparray[(size_t)r * g->val.array.columns + c]; }
static double cnum(const XLOPER12 *g, int r, int c) { return cellp(g, r, c)->val.num; }
static int cis(const XLOPER12 *g, int r, int c, const char *lit)
{
    const XLOPER12 *x = cellp(g, r, c);
    if ((x->xltype & 0xFFF) != xltypeStr) return 0;
    int n = x->val.str[0];
    if ((int)strlen(lit) != n) return 0;
    for (int i = 0; i < n; i++) if (x->val.str[i + 1] != (unsigned char)lit[i]) return 0;
    return 1;
}

static void selftest(void)
{
    /* Excel ROUND(x,2) semantics */
    struct { double in, out; } rc[] = { { 2.675, 2.68 }, { 1.005, 1.01 }, { -2.675, -2.68 }, { 0.125, 0.13 },
                                        { 1.0049999, 1.0 }, { 1234567.885, 1234567.89 }, { 0.0, 0.0 } };
    for (size_t i = 0; i < sizeof rc / sizeof rc[0]; i++)
        CHECK(st_round2(rc[i].in) == rc[i].out, "ROUND(%.10g) = %.10g, want %.10g", rc[i].in, st_round2(rc[i].in), rc[i].out);

    XLOPER12 *in[IN_COUNT];
    in[IN_ITEMS] = grid_new(3, 11);
    sets(in[IN_ITEMS], 0, 0, "Sugar 50kg"); sets(in[IN_ITEMS], 0, 3, "Bag"); setn(in[IN_ITEMS], 0, 5, 0.05);
    setn(in[IN_ITEMS], 0, 6, 2000); setn(in[IN_ITEMS], 0, 7, 2300); setn(in[IN_ITEMS], 0, 8, 5);
    setn(in[IN_ITEMS], 0, 9, 10); setn(in[IN_ITEMS], 0, 10, 1950);
    sets(in[IN_ITEMS], 1, 0, "LED Bulb"); setn(in[IN_ITEMS], 1, 5, 0.18); setn(in[IN_ITEMS], 1, 6, 0.1); setn(in[IN_ITEMS], 1, 7, 0.335);
    in[IN_PARTIES] = grid_new(3, 9);
    sets(in[IN_PARTIES], 0, 0, "Local Shop"); sets(in[IN_PARTIES], 0, 4, "rajasthan");   /* case differs from home */
    sets(in[IN_PARTIES], 1, 0, "Delhi Mart"); sets(in[IN_PARTIES], 1, 4, "Delhi"); setn(in[IN_PARTIES], 1, 6, 1000); setn(in[IN_PARTIES], 1, 7, 10);
    in[IN_PURCHASES] = grid_new(2, 8);
    setn(in[IN_PURCHASES], 0, 0, 46200); sets(in[IN_PURCHASES], 0, 2, "LOCAL SHOP"); sets(in[IN_PURCHASES], 0, 3, "sugar 50KG");
    setn(in[IN_PURCHASES], 0, 4, 10);   /* rate blank -> std 2000 */
    in[IN_SALES] = grid_new(5, 9);
    /* r0: inter-state, case-insensitive item, 2-decimal rate that exposes binary rounding */
    setn(in[IN_SALES], 0, 0, 46210); sets(in[IN_SALES], 0, 1, "INV-0042"); sets(in[IN_SALES], 0, 2, "delhi mart");
    sets(in[IN_SALES], 0, 3, "LED BULB"); setn(in[IN_SALES], 0, 4, 1); setn(in[IN_SALES], 0, 5, 2.675);
    /* r1: intra-state cash sale at std rate with 5% discount */
    setn(in[IN_SALES], 1, 0, 46211); sets(in[IN_SALES], 1, 1, "INV-0043"); sets(in[IN_SALES], 1, 2, "Local Shop");
    sets(in[IN_SALES], 1, 3, "Sugar 50kg"); setn(in[IN_SALES], 1, 4, 3); setn(in[IN_SALES], 1, 6, 0.05); sets(in[IN_SALES], 1, 7, "cash");
    /* r2: unknown item; r3: oversell -> NEG STOCK; r4: invoice number without prefix */
    sets(in[IN_SALES], 2, 1, "X-9"); sets(in[IN_SALES], 2, 2, "Nobody"); sets(in[IN_SALES], 2, 3, "Ghost item"); setn(in[IN_SALES], 2, 4, 1);
    sets(in[IN_SALES], 3, 1, "INV-0044"); sets(in[IN_SALES], 3, 3, "Sugar 50kg"); setn(in[IN_SALES], 3, 4, 20); setn(in[IN_SALES], 3, 5, 1900);
    setn(in[IN_SALES], 4, 1, 77);
    in[IN_CASHBOOK] = grid_new(3, 8);
    sets(in[IN_CASHBOOK], 0, 2, "receipt"); sets(in[IN_CASHBOOK], 0, 3, "Delhi Mart"); sets(in[IN_CASHBOOK], 0, 5, "Bank"); setn(in[IN_CASHBOOK], 0, 6, 0.1);
    sets(in[IN_CASHBOOK], 1, 2, "Expense"); sets(in[IN_CASHBOOK], 1, 5, "Cash"); setn(in[IN_CASHBOOK], 1, 6, 50);
    in[IN_ADJUST] = grid_new(1, 5);
    sets(in[IN_ADJUST], 0, 1, "Sugar 50kg"); setn(in[IN_ADJUST], 0, 2, -1);
    in[IN_SETTINGS] = grid_new(10, 1);
    sets(in[IN_SETTINGS], 3, 0, "Rajasthan"); setn(in[IN_SETTINGS], 5, 0, 46113); setn(in[IN_SETTINGS], 6, 0, 46300);
    sets(in[IN_SETTINGS], 7, 0, "INV-"); setn(in[IN_SETTINGS], 8, 0, 90);

    LPXLOPER12 s = ST_SALES(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
    CHECK(cnum(s, 0, 2) == 2.68, "taxable 2.675 -> %.10g", cnum(s, 0, 2));
    CHECK(cnum(s, 0, 4) == 0 && cnum(s, 0, 6) == 0.48, "inter-state IGST %.10g", cnum(s, 0, 6));
    CHECK(cnum(s, 0, 13) == 42, "invoice number %.10g", cnum(s, 0, 13));
    CHECK(cnum(s, 1, 1) == 2300 && cnum(s, 1, 2) == 6555, "std rate & discount: %.10g", cnum(s, 1, 2));
    CHECK(cnum(s, 1, 4) == 163.88 && cnum(s, 1, 5) == 163.88 && cnum(s, 1, 6) == 0, "CGST/SGST split %.10g", cnum(s, 1, 4));
    CHECK(cnum(s, 1, 7) == 6882.76 && cnum(s, 1, 14) == 6882.76, "total / paid now (mode 'cash')");
    CHECK(cnum(s, 1, 8) == 5925 && cnum(s, 1, 9) == 630, "COGS at avg cost 1975: %.10g", cnum(s, 1, 8));
    CHECK(cis(s, 1, 0, "Bag") && cnum(s, 1, 11) == 1 && cnum(s, 1, 12) == 1, "unit / item row / party row");
    CHECK(cis(s, 2, 10, "UNKNOWN ITEM") && cis(s, 2, 11, "") && cis(s, 2, 12, ""), "unknown item / party");
    CHECK(cnum(s, 2, 13) == 0, "unparseable invoice -> 0");
    CHECK(cis(s, 3, 10, "NEG STOCK"), "negative stock flag");
    CHECK(cnum(s, 4, 13) == 77 && cis(s, 4, 2, ""), "numeric invoice, blank item row");
    xlAutoFree12(s);

    LPXLOPER12 it = ST_ITEMS(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
    CHECK(cnum(it, 0, 3) == -4 && cis(it, 0, 6, "NEGATIVE"), "closing 10+10-23-1 = %.10g", cnum(it, 0, 3));
    CHECK(cnum(it, 0, 4) == 1975, "weighted avg cost %.10g", cnum(it, 0, 4));
    CHECK(cnum(it, 1, 4) == 0.1 && cis(it, 1, 6, "NEGATIVE"), "LED: no purchases -> std cost");
    CHECK(cis(it, 2, 0, "") && cis(it, 2, 6, ""), "blank item row stays blank");
    xlAutoFree12(it);

    LPXLOPER12 p = ST_PARTIES(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
    CHECK(cnum(p, 1, 0) == 3.16 && cnum(p, 1, 1) == 0.1 && cnum(p, 1, 4) == 3.06, "Delhi Mart ledger bal %.10g", cnum(p, 1, 4));
    CHECK(cis(p, 1, 5, "Receivable") && cnum(p, 1, 7) == 0, "receipt w/o date keeps last receipt 0");
    CHECK(cis(p, 1, 9, "OVERDUE"), "overdue after credit days");
    CHECK(cnum(p, 0, 2) == 21000 && cis(p, 0, 5, "Payable") && cis(p, 0, 9, "PAY DUE"), "supplier payable %.10g", cnum(p, 0, 2));
    xlAutoFree12(p);

    LPXLOPER12 c = ST_CASHBOOK(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
    CHECK(cnum(c, 0, 0) == 0.1 && cnum(c, 1, 1) == 50 && cis(c, 1, 2, "Head needed") && cis(c, 2, 2, ""), "cash book");
    xlAutoFree12(c);

    /* a #REF! argument must give #VALUE!, not a crash */
    XLOPER12 bad = { { 0 }, xltypeErr };
    bad.val.err = xlerrRef;
    LPXLOPER12 e = ST_SALES(&bad, in[1], in[2], in[3], in[4], in[5], in[6]);
    CHECK((e->xltype & 0xFFF) == xltypeErr && e->val.err == xlerrValue, "error input -> #VALUE!");
    xlAutoFree12(e);

    for (int i = 0; i < IN_COUNT; i++) free_grid(in[i]);
    printf("selftest: %s (%d failures)\n", g_fail ? "FAILED" : "all edge cases pass", g_fail);
}

int main(int argc, char **argv)
{
    st_set_callback(mock_excel);
    if (argc >= 3 && !strcmp(argv[1], "verify")) {
        char path[1024];
        XLOPER12 *in[IN_COUNT];
        for (int i = 0; i < IN_COUNT; i++) {
            snprintf(path, sizeof path, "%s/in_%s.tsv", argv[2], IN_FILES[i]);
            in[i] = load_tsv(path);
        }
        xlAutoOpen();
        for (size_t k = 0; k < sizeof UDFS / sizeof UDFS[0]; k++) {
            double t0 = now_ms();
            LPXLOPER12 r = UDFS[k].fn(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
            double ms = now_ms() - t0;
            snprintf(path, sizeof path, "%s/out_%s.tsv", argv[2], UDFS[k].name);
            write_tsv(path, r);
            printf("ST_%-10s -> %dx%d in %.3f ms\n", UDFS[k].name, r->val.array.rows, r->val.array.columns, ms);
            xlAutoFree12(r);
        }
        LPXLOPER12 v = ST_VERSION();
        printf("ST_VERSION -> ");
        put_utf8(stdout, v->val.str + 1, v->val.str[0]);
        printf("\n");
        for (int i = 0; i < IN_COUNT; i++) free_grid(in[i]);
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "register")) {
        int ok = xlAutoOpen();
        printf("xlAutoOpen -> %d, %d functions registered\n", ok, g_registered);
        return !(ok && g_registered == 7);
    }
    if (argc >= 2 && !strcmp(argv[1], "selftest")) { selftest(); return g_fail != 0; }
    if (argc >= 3 && !strcmp(argv[1], "bench")) { bench(atoi(argv[2])); return 0; }
    fprintf(stderr, "usage: harness verify <dir> | register | bench <lines>\n");
    return 2;
}
