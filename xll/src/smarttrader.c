/*
 * smarttrader.c - Excel XLL add-in exposing the SmartTrader posting engine as
 * native, thread-safe worksheet functions.
 *
 *   =_xll.ST_ITEMS(IN_Items,IN_Parties,IN_Purchases,IN_Sales,IN_CashBook,IN_Adjust,IN_Settings)
 *   ...ST_PURCHASES / ST_SALES / ST_PARTIES / ST_CASHBOOK / ST_ADJUST (same 7 arguments)
 *   =ST_VERSION()
 *
 * Each function is entered once as an array formula over its output block.
 */
#include <string.h>

#include "engine.h"

#ifdef _WIN32
#include <windows.h>
#endif

#define ST_VERSION_TEXT "SmartTrader C Engine 1.0"
#if defined(_WIN64) || defined(__x86_64__) || defined(__aarch64__)
#define ST_ARCH " (64-bit)"
#else
#define ST_ARCH " (32-bit)"
#endif

/* ------------------------------------------------------------ Excel callback */
static EXCEL12PROC g_excel12;

#ifdef ST_TEST
void st_set_callback(EXCEL12PROC p) { g_excel12 = p; }
#endif

static int Excel12v(int fn, LPXLOPER12 res, int count, LPXLOPER12 *args)
{
#ifdef _WIN32
    if (!g_excel12) g_excel12 = (EXCEL12PROC)(void *)GetProcAddress(GetModuleHandleW(NULL), "MdCallBack12");
#endif
    return g_excel12 ? g_excel12(fn, count, args, res) : xlretFailed;
}

/* ------------------------------------------------------------ registration */
#define NARGS 7
static const char ARG_NAMES[] = "Items,Parties,Purchases,Sales,CashBook,Adjustments,Settings";
static const char *const ARG_HELP[NARGS] = {
    "Items!A5:K (IN_Items)", "Parties!A5:I (IN_Parties)", "Purchases!A5:H (IN_Purchases)",
    "Sales!A5:I (IN_Sales)", "CashBook!A5:H (IN_CashBook)", "Adjustments!A5:E (IN_Adjust)",
    "Settings!B4:B13 (IN_Settings)",
};

static const struct { const char *proc, *help; } FUNCS[] = {
    { "ST_ITEMS",     "Live stock per item: purchased, sold, adjusted, closing, avg cost, value, status, margin, reorder qty, sales, profit, last sale, cover." },
    { "ST_PURCHASES", "Posts purchase lines: unit, rate, taxable, GST %, CGST, SGST, IGST, total, item row, party row, paid now." },
    { "ST_SALES",     "Posts sales lines: unit, rate, taxable, GST %, CGST, SGST, IGST, total, COGS, profit, stock check, rows, invoice no, paid now." },
    { "ST_PARTIES",   "Party ledger: credit sales, receipts, credit purchases, payments, balance, position, last sale/receipt, days unpaid, alert." },
    { "ST_CASHBOOK",  "Cash book: money in, money out, entry check." },
    { "ST_ADJUST",    "Stock adjustments: average cost and value impact." },
};
#define NFUNCS (int)(sizeof FUNCS / sizeof FUNCS[0])

typedef struct { XCHAR buf[256]; XLOPER12 x; } xstr;

static LPXLOPER12 mkstr(xstr *s, const char *a)
{
    size_t n = strlen(a);
    if (n > 255) n = 255;
    s->buf[0] = (XCHAR)n;
    for (size_t i = 0; i < n; i++) s->buf[i + 1] = (unsigned char)a[i];
    s->x.xltype = xltypeStr;
    s->x.val.str = s->buf;
    return &s->x;
}

static int register_fn(LPXLOPER12 dll, const char *proc, const char *type, const char *args,
                       const char *help, int nhelp, const char *const *arghelp)
{
    xstr s[9 + NARGS];
    LPXLOPER12 p[10 + NARGS];
    XLOPER12 macro_type, res;
    int n = 0;
    macro_type.xltype = xltypeNum;
    macro_type.val.num = 1;                 /* worksheet function */
    p[n++] = dll;
    p[n++] = mkstr(&s[0], proc);            /* exported procedure */
    p[n++] = mkstr(&s[1], type);            /* type text */
    p[n++] = mkstr(&s[2], proc);            /* name shown in Excel */
    p[n++] = mkstr(&s[3], args);            /* argument names */
    p[n++] = &macro_type;
    p[n++] = mkstr(&s[4], "SmartTrader ERP");
    p[n++] = mkstr(&s[5], "");              /* shortcut */
    p[n++] = mkstr(&s[6], "");              /* help topic */
    p[n++] = mkstr(&s[7], help);
    for (int i = 0; i < nhelp; i++) p[n++] = mkstr(&s[8 + i], arghelp[i]);
    int rc = Excel12v(xlfRegister, &res, n, p);
    return rc == xlretSuccess && res.xltype != xltypeErr;
}

static XCHAR g_version_buf[64];
static XLOPER12 g_version;

XLEXPORT int XLCC xlAutoOpen(void)
{
    xstr v;
    mkstr(&v, ST_VERSION_TEXT ST_ARCH);
    memcpy(g_version_buf, v.buf, sizeof(XCHAR) * (v.buf[0] + 1u));
    g_version.xltype = xltypeStr;
    g_version.val.str = g_version_buf;

    XLOPER12 dll;
    if (Excel12v(xlGetName, &dll, 0, NULL) != xlretSuccess) return 0;

    /* Q = values (ranges arrive as arrays), $ = thread-safe for multithreaded recalc */
    for (int i = 0; i < NFUNCS; i++)
        register_fn(&dll, FUNCS[i].proc, "QQQQQQQQ$", ARG_NAMES, FUNCS[i].help, NARGS, ARG_HELP);
    register_fn(&dll, "ST_VERSION", "Q$", "", "Version of the SmartTrader C engine (shows the add-in is loaded).", 0, NULL);

    LPXLOPER12 f[1] = { &dll };
    Excel12v(xlFree, NULL, 1, f);
    return 1;
}

XLEXPORT int XLCC xlAutoClose(void) { return 1; }

XLEXPORT void XLCC xlAutoFree12(LPXLOPER12 x)
{
    if (x && (x->xltype & xlbitDLLFree)) st_free_result(x);
}

XLEXPORT LPXLOPER12 XLCC xlAddInManagerInfo12(LPXLOPER12 action)
{
    static XCHAR name[] = { 22, 'S','m','a','r','t','T','r','a','d','e','r',' ','E','R','P',' ','E','n','g','i','n','e' };
    static XLOPER12 res;
    if (action && (action->xltype & 0xFFF) == xltypeNum && action->val.num == 1) {
        res.xltype = xltypeStr;
        res.val.str = name;
    } else {
        res.xltype = xltypeErr;
        res.val.err = xlerrValue;
    }
    return &res;
}

/* ------------------------------------------------------------ worksheet functions */
#define ST_UDF(NAME, WHICH)                                                                        \
    XLEXPORT LPXLOPER12 XLCC NAME(LPXLOPER12 a, LPXLOPER12 b, LPXLOPER12 c, LPXLOPER12 d,         \
                                  LPXLOPER12 e, LPXLOPER12 f, LPXLOPER12 g)                       \
    {                                                                                             \
        const XLOPER12 *const in[IN_COUNT] = { a, b, c, d, e, f, g };                             \
        return st_compute(WHICH, in);                                                             \
    }

ST_UDF(ST_ITEMS, ST_OUT_ITEMS)
ST_UDF(ST_PURCHASES, ST_OUT_PURCHASES)
ST_UDF(ST_SALES, ST_OUT_SALES)
ST_UDF(ST_PARTIES, ST_OUT_PARTIES)
ST_UDF(ST_CASHBOOK, ST_OUT_CASHBOOK)
ST_UDF(ST_ADJUST, ST_OUT_ADJUST)

XLEXPORT LPXLOPER12 XLCC ST_VERSION(void) { return &g_version; }
