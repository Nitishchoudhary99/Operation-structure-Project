/*
 * engine.c - SmartTrader ERP posting engine (pure C99, no Excel dependency
 * beyond the XLOPER12 data layout).
 *
 * Accuracy rules
 *   - Every money amount is rounded with Excel's ROUND(x,2) rule and then carried
 *     as int64 paise, so ledger totals are exact (no floating-point drift).
 *   - Quantity totals are snapped to 6 decimals so "stock = 0" tests are exact.
 *   - Text matching is case-insensitive, like SUMIFS / MATCH.
 *
 * Speed rules
 *   - Masters are indexed once in open-addressing hash tables.
 *   - Each register is scanned exactly once: O(items + parties + lines).
 *   - All scratch memory comes from one arena and is released in one go.
 */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L   /* localtime_r */
#endif
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "engine.h"

#ifdef _WIN32
#include <windows.h>
#endif

/* Plan rules - must match tools/license_tool.py (ST_FREE_LINES / ST_LICENSE_KEYS) */
#ifndef ST_FREE_LINES
#define ST_FREE_LINES 200
#endif
#ifndef ST_LIC_K
#define ST_LIC_K 7919, 10007, 9967, 424242
#endif
static const long long LIC_K[4] = { ST_LIC_K };
#define LIC_MSG_LEN 40
#define LIC_ID_LEN 20

#define TYPE(x) ((x)->xltype & ~(uint32_t)(xlbitXLFree | xlbitDLLFree))

/* ------------------------------------------------------------ column maps */
/* Items!A:K */
enum { IT_NAME, IT_SKU, IT_CAT, IT_UNIT, IT_HSN, IT_GST, IT_PRATE, IT_SRATE, IT_REORDER, IT_OQTY, IT_ORATE };
/* Parties!A:K */
enum { PT_NAME, PT_TYPE, PT_PHONE, PT_GSTIN, PT_STATE, PT_ADDR, PT_LIMIT, PT_DAYS, PT_OPEN, PT_MSME, PT_AGREE };
/* Purchases!A:H and Sales!A:I share the first 8 columns */
enum { TX_DATE, TX_DOC, TX_PARTY, TX_ITEM, TX_QTY, TX_RATE, TX_DISC, TX_MODE, TX_DELIVERY };
/* CashBook!A:H */
enum { CB_DATE, CB_VNO, CB_TYPE, CB_PARTY, CB_HEAD, CB_ACCOUNT, CB_AMOUNT, CB_NOTES };
/* Adjustments!A:E */
enum { AD_DATE, AD_ITEM, AD_QTY, AD_REASON, AD_NOTES };
/* Settings!B4:B35 */
enum { SE_COMPANY, SE_ADDR, SE_GSTIN, SE_STATE, SE_PHONE, SE_FYSTART, SE_ASOF, SE_PREFIX, SE_DEADDAYS, SE_BANK,
       SE_LICID, SE_LICKEY, SE_LEAD = 26, SE_COVER = 27 };

static const XLOPER12 NIL = { { 0 }, xltypeNil };

/* ------------------------------------------------------------ arena */
typedef struct chunk { struct chunk *next; size_t used, cap; double data[]; } chunk;
typedef struct { chunk *head; int oom; } arena;

static void *arena_alloc(arena *a, size_t n)
{
    n = (n + 15) & ~(size_t)15;
    if (!a->head || a->head->used + n > a->head->cap) {
        size_t cap = n > (1u << 20) ? n : (1u << 20);
        chunk *c = (chunk *)malloc(sizeof(chunk) + cap);
        if (!c) { a->oom = 1; return NULL; }
        c->next = a->head; c->used = 0; c->cap = cap;
        a->head = c;
    }
    void *p = (char *)a->head->data + a->head->used;
    a->head->used += n;
    return p;
}

static void *arena_zalloc(arena *a, size_t n)
{
    void *p = arena_alloc(a, n);
    if (p) memset(p, 0, n);
    return p;
}

static void arena_free(arena *a)
{
    while (a->head) { chunk *n = a->head->next; free(a->head); a->head = n; }
}

/* ------------------------------------------------------------ cell access */
typedef struct { const XLOPER12 *c; int rows, cols; } grid;

static int grid_init(grid *g, const XLOPER12 *x)
{
    g->c = NULL; g->rows = g->cols = 0;
    if (!x) return 0;
    switch (TYPE(x)) {
    case xltypeMulti:
        g->c = x->val.array.lparray; g->rows = x->val.array.rows; g->cols = x->val.array.columns;
        return 0;
    case xltypeMissing: case xltypeNil:
        return 0;
    case xltypeErr:
        return -1;
    default:
        g->c = x; g->rows = g->cols = 1;
        return 0;
    }
}

static const XLOPER12 *at(const grid *g, int r, int c)
{
    return (r < g->rows && c < g->cols) ? &g->c[(size_t)r * g->cols + c] : &NIL;
}

typedef struct { const XCHAR *p; int n; } sv;

static sv sv_of(const XLOPER12 *x)
{
    sv s = { NULL, 0 };
    if (TYPE(x) == xltypeStr && x->val.str) { s.p = x->val.str + 1; s.n = x->val.str[0]; }
    return s;
}

/* text view of any cell, used for master keys (numbers become "%.15g") */
static sv key_of(const XLOPER12 *x, arena *a)
{
    sv s = { NULL, 0 };
    char buf[40];
    int n = 0;
    switch (TYPE(x)) {
    case xltypeStr: return sv_of(x);
    case xltypeNum: n = snprintf(buf, sizeof buf, "%.15g", x->val.num); break;
    case xltypeInt: n = snprintf(buf, sizeof buf, "%d", (int)x->val.w); break;
    case xltypeBool: n = snprintf(buf, sizeof buf, "%s", x->val.xbool ? "TRUE" : "FALSE"); break;
    default: return s;
    }
    XCHAR *w = (XCHAR *)arena_alloc(a, (size_t)n * sizeof(XCHAR));
    if (!w) return s;
    for (int i = 0; i < n; i++) w[i] = (unsigned char)buf[i];
    s.p = w; s.n = n;
    return s;
}

static int is_blank(const XLOPER12 *x)
{
    switch (TYPE(x)) {
    case xltypeNil: case xltypeMissing: case xltypeErr: return 1;
    case xltypeStr: return !x->val.str || x->val.str[0] == 0;
    default: return 0;
    }
}

/* Excel N(): numbers as-is, booleans 1/0, everything else 0 */
static double num(const XLOPER12 *x)
{
    switch (TYPE(x)) {
    case xltypeNum: return x->val.num;
    case xltypeInt: return x->val.w;
    case xltypeBool: return x->val.xbool ? 1.0 : 0.0;
    default: return 0.0;
    }
}

static int is_num(const XLOPER12 *x) { return TYPE(x) == xltypeNum || TYPE(x) == xltypeInt; }

static inline XCHAR fold(XCHAR c) { return (c >= 'a' && c <= 'z') ? (XCHAR)(c - 32) : c; }

static int sv_eq(sv a, sv b)
{
    if (a.n != b.n) return 0;
    for (int i = 0; i < a.n; i++)
        if (fold(a.p[i]) != fold(b.p[i])) return 0;
    return 1;
}

static int sv_is(sv a, const char *lit)
{
    int i = 0;
    for (; lit[i]; i++)
        if (i >= a.n || fold(a.p[i]) != fold((XCHAR)(unsigned char)lit[i])) return 0;
    return i == a.n;
}

static int cell_is(const XLOPER12 *x, const char *lit) { return sv_is(sv_of(x), lit); }

/* ------------------------------------------------------------ hash index */
typedef struct { sv *k; int *v; unsigned mask; } index_t;

static unsigned sv_hash(sv s)
{
    unsigned h = 2166136261u;
    for (int i = 0; i < s.n; i++) { h ^= fold(s.p[i]); h *= 16777619u; }
    return h;
}

static int index_init(index_t *m, int n, arena *a)
{
    unsigned cap = 16;
    while (cap < (unsigned)n * 2u + 1u) cap <<= 1;
    m->k = (sv *)arena_alloc(a, cap * sizeof(sv));
    m->v = (int *)arena_alloc(a, cap * sizeof(int));
    if (!m->k || !m->v) return -1;
    for (unsigned i = 0; i < cap; i++) m->v[i] = -1;
    m->mask = cap - 1;
    return 0;
}

static int index_get(const index_t *m, sv key)
{
    if (key.n == 0) return -1;
    for (unsigned h = sv_hash(key) & m->mask;; h = (h + 1) & m->mask) {
        if (m->v[h] < 0) return -1;
        if (sv_eq(m->k[h], key)) return m->v[h];
    }
}

/* inserts if absent; returns the index of the FIRST row carrying this key (MATCH semantics) */
static int index_add(index_t *m, sv key, int val)
{
    if (key.n == 0) return -1;
    for (unsigned h = sv_hash(key) & m->mask;; h = (h + 1) & m->mask) {
        if (m->v[h] < 0) { m->k[h] = key; m->v[h] = val; return val; }
        if (sv_eq(m->k[h], key)) return m->v[h];
    }
}

/* ------------------------------------------------------------ numerics */
double st_round2(double x)
{
    double y = x * 100.0, t = trunc(y), f = fabs(y - t);
    double tol = 1e-9 * (fabs(y) > 1.0 ? fabs(y) : 1.0);
    double r = (fabs(f - 0.5) <= tol) ? t + (y < 0 ? -1.0 : 1.0) : round(y);
    return r / 100.0;
}

/* Excel ROUND(x, 0) */
static double st_round0(double x)
{
    double t = trunc(x), f = fabs(x - t);
    double tol = 1e-9 * (fabs(x) > 1.0 ? fabs(x) : 1.0);
    return (fabs(f - 0.5) <= tol) ? t + (x < 0 ? -1.0 : 1.0) : round(x);
}

static long long paise(double x) { return llround(st_round2(x) * 100.0); }
static double rupees(long long p) { return (double)p / 100.0; }
static double snapq(double q) { return round(q * 1e6) / 1e6; }

/* ------------------------------------------------------------ licence */
static long long days_from_civil(long long y, int m, int d)
{
    y -= m <= 2;
    long long era = (y >= 0 ? y : y - 399) / 400;
    long long yoe = y - era * 400;
    long long doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static void civil_from_days(long long z, int *y, int *m, int *d)
{
    z += 719468;
    long long era = (z >= 0 ? z : z - 146096) / 146097;
    long long doe = z - era * 146097;
    long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    long long mp = (5 * doy + 2) / 153;
    *d = (int)(doy - (153 * mp + 2) / 5 + 1);
    *m = (int)(mp < 10 ? mp + 3 : mp - 9);
    *y = (int)(yoe + era * 400 + (*m <= 2));
}

#define EXCEL_EPOCH days_from_civil(1899, 12, 30)

/* Excel DATE(y, m, d): months and days roll over like Excel does */
static double excel_date(int y, int m, int d)
{
    int m0 = m - 1;
    y += m0 >= 0 ? m0 / 12 : -((11 - m0) / 12);
    m0 = ((m0 % 12) + 12) % 12;
    return (double)(days_from_civil(y, m0 + 1, 1) + d - 1 - EXCEL_EPOCH);
}

#ifdef ST_TEST
double st_test_today;   /* harness can pin "today" */
#endif

static double today_serial(void)
{
#ifdef ST_TEST
    if (st_test_today > 0) return st_test_today;
#endif
#ifdef _WIN32
    SYSTEMTIME t;
    GetLocalTime(&t);
    return (double)(days_from_civil(t.wYear, t.wMonth, t.wDay) - EXCEL_EPOCH);
#else
    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);
    return (double)(days_from_civil(tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday) - EXCEL_EPOCH);
#endif
}

/* Excel TRIM (spaces only) into buf; returns length */
static int excel_trim(sv s, char *buf, int cap)
{
    int n = 0, pending = 0;
    for (int i = 0; i < s.n; i++) {
        XCHAR c = s.p[i];
        if (c == ' ') { pending = n > 0; continue; }
        if (pending && n < cap) buf[n++] = ' ';
        pending = 0;
        if (n < cap) buf[n++] = c < 128 ? (char)c : '?';
    }
    return n;
}

/* Same algorithm as the hidden Lic sheet and tools/license_tool.py */
static int licence_is_pro(const XLOPER12 *id_cell, const XLOPER12 *key_cell, arena *a)
{
    char key[64], id[64], msg[LIC_MSG_LEN + 1];
    int kn = excel_trim(key_of(key_cell, a), key, (int)sizeof key);
    int idn = excel_trim(key_of(id_cell, a), id, (int)sizeof id);
    if (idn > LIC_ID_LEN) idn = LIC_ID_LEN;
    for (int i = 0; i < kn; i++)
        if (key[i] >= 'a' && key[i] <= 'z') key[i] -= 32;
    if (kn != 16 || memcmp(key, "PRO-", 4) != 0 || key[11] != '-' || idn == 0) return 0;
    char plan = key[4];
    if (plan != 'M' && plan != 'H' && plan != 'Y') return 0;
    for (int i = 5; i < 11; i++)
        if (key[i] < '0' || key[i] > '9') return 0;
    double expiry = excel_date(2000 + (key[5] - '0') * 10 + key[6] - '0', (key[7] - '0') * 10 + key[8] - '0',
                               (key[9] - '0') * 10 + key[10] - '0');
    if (expiry <= 0) return 0;
    int y, m, d;
    civil_from_days((long long)expiry + EXCEL_EPOCH, &y, &m, &d);
    memset(msg, ' ', LIC_MSG_LEN);
    msg[LIC_MSG_LEN] = 0;
    char tail[32];
    int tn = snprintf(tail, sizeof tail, "|%c|%d", plan, y * 10000 + m * 100 + d);
    memcpy(msg, id, (size_t)idn);
    memcpy(msg + idn, tail, (size_t)(idn + tn <= LIC_MSG_LEN ? tn : LIC_MSG_LEN - idn));
    long long sum = 0;
    for (int i = 1; i <= LIC_MSG_LEN; i++)
        sum += (long long)(unsigned char)msg[i - 1] * ((i * LIC_K[0]) % LIC_K[1] + 1);
    long long v = (sum * LIC_K[2] + LIC_K[3]) % 1679616;
    static const char ALPHA[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    char chk[4] = { ALPHA[(v / 46656) % 36], ALPHA[(v / 1296) % 36], ALPHA[(v / 36) % 36], ALPHA[v % 36] };
    if (memcmp(chk, key + 12, 4) != 0) return 0;
    return today_serial() <= expiry;
}

/* ------------------------------------------------------------ model */
enum { CHK_NONE, CHK_OK, CHK_UNKNOWN, CHK_NEG, CHK_BELOW, CHK_RETURN };

typedef struct {
    int has_item;           /* item column non-blank */
    int item;               /* master row (first match) or -1 */
    int party_given, party; /* party column non-blank / master row or -1 */
    double rate, gst;
    long long tax, cgst, sgst, igst, total, paid, cogs;
    int check;
    int inv_kind;           /* 0 = blank, 1 = number */
    double inv;
} line_t;

typedef struct {
    arena a;
    grid g[IN_COUNT];
    sv home, prefix;
    double fy, asof, dead, lead, cover;
    index_t imap, pmap;
    int *ifirst, *pfirst;
    /* item accumulators, stored on the first row of each name */
    double *pq, *sq, *aq, *last_sold, *avg, *close, *sold30;
    int *last_buy;          /* last purchase row of each item (register order), -1 = never bought */
    long long *ptax, *sval, *gp;
    /* party accumulators */
    long long *csales, *recv, *cpurch, *paid;
    double *last_sale, *last_rec;
    line_t *pl, *sl;
    int pro;
    int eff[IN_COUNT];      /* rows that count: whole register on Pro, first ST_FREE_LINES on Free */
} model;

static void post_gst(line_t *L, const model *m)
{
    int inter = 0;
    if (L->party >= 0) {
        sv st = sv_of(at(&m->g[IN_PARTIES], L->party, PT_STATE));
        inter = st.n > 0 && !sv_eq(st, m->home);
    }
    if (inter) {
        L->cgst = L->sgst = 0;
        L->igst = paise(rupees(L->tax) * L->gst);
    } else {
        L->cgst = L->sgst = paise(rupees(L->tax) * L->gst / 2.0);
        L->igst = 0;
    }
    L->total = L->tax + L->cgst + L->sgst + L->igst;
}

/* common part of a purchase / sales line */
static void post_line(model *m, const grid *g, int r, line_t *L, int std_rate_col)
{
    const XLOPER12 *party = at(g, r, TX_PARTY), *item = at(g, r, TX_ITEM);
    L->party_given = !is_blank(party);
    L->party = L->party_given ? index_get(&m->pmap, key_of(party, &m->a)) : -1;
    L->has_item = !is_blank(item);
    L->item = -1;
    L->check = CHK_NONE;
    if (!L->has_item) return;
    L->item = index_get(&m->imap, key_of(item, &m->a));
    const grid *it = &m->g[IN_ITEMS];
    const XLOPER12 *rate = at(g, r, TX_RATE);
    L->rate = is_blank(rate) ? (L->item >= 0 ? num(at(it, L->item, std_rate_col)) : 0.0) : num(rate);
    L->tax = paise(num(at(g, r, TX_QTY)) * L->rate * (1.0 - num(at(g, r, TX_DISC))));
    L->gst = L->item >= 0 ? num(at(it, L->item, IT_GST)) : 0.0;
    post_gst(L, m);
    const XLOPER12 *mode = at(g, r, TX_MODE);
    L->paid = (is_blank(mode) || cell_is(mode, "Credit")) ? 0 : L->total;
}

static int parse_invoice(const XLOPER12 *x, sv prefix, double *out)
{
    if (is_blank(x)) return 0;
    if (is_num(x)) { *out = num(x); return 1; }
    sv s = sv_of(x);
    char buf[64];
    int n = 0, ok = 1;
    for (int i = 0; i < s.n;) {
        if (prefix.n > 0 && i + prefix.n <= s.n && memcmp(s.p + i, prefix.p, (size_t)prefix.n * sizeof(XCHAR)) == 0) {
            i += prefix.n;   /* SUBSTITUTE is case-sensitive */
            continue;
        }
        if (s.p[i] > 127 || n >= (int)sizeof buf - 1) { ok = 0; break; }
        buf[n++] = (char)s.p[i++];
    }
    *out = 0.0;   /* VALUE() failure -> 0 (IFERROR) */
    if (!ok) return 1;
    buf[n] = 0;
    char *p = buf, *end;
    while (*p == ' ') p++;
    if (!*p) return 1;
    double v = strtod(p, &end);
    while (*end == ' ') end++;
    if (*end == 0) *out = v;
    return 1;
}

#define ALLOC(m, ptr, n) ((ptr) = arena_zalloc(&(m)->a, sizeof(*(ptr)) * (size_t)((n) > 0 ? (n) : 1)))

enum { NEED_PURCH = 1, NEED_SALES = 2, NEED_ADJ = 4, NEED_CASH = 8 };

static int model_build(model *m, const XLOPER12 *const in[IN_COUNT], int need)
{
    memset(m, 0, sizeof *m);
    for (int i = 0; i < IN_COUNT; i++)
        if (grid_init(&m->g[i], in[i]) != 0) return xlerrValue;
    const grid *it = &m->g[IN_ITEMS], *pt = &m->g[IN_PARTIES], *pu = &m->g[IN_PURCHASES],
               *sa = &m->g[IN_SALES], *cb = &m->g[IN_CASHBOOK], *ad = &m->g[IN_ADJUST], *st = &m->g[IN_SETTINGS];

    /* settings: a single column (or row) */
#define SET(i) (st->rows >= st->cols ? at(st, (i), 0) : at(st, 0, (i)))
    m->home = key_of(SET(SE_STATE), &m->a);
    m->prefix = sv_of(SET(SE_PREFIX));
    m->fy = num(SET(SE_FYSTART));
    m->asof = num(SET(SE_ASOF));
    m->dead = num(SET(SE_DEADDAYS));
    m->lead = num(SET(SE_LEAD));
    m->cover = num(SET(SE_COVER));
    m->pro = licence_is_pro(SET(SE_LICID), SET(SE_LICKEY), &m->a);
#undef SET
    for (int i = 0; i < IN_COUNT; i++) m->eff[i] = m->g[i].rows;
    if (!m->pro) {
        static const int gated[] = { IN_PURCHASES, IN_SALES, IN_CASHBOOK };
        for (int k = 0; k < 3; k++)
            if (m->eff[gated[k]] > ST_FREE_LINES) m->eff[gated[k]] = ST_FREE_LINES;
    }

    int ni = it->rows, np = pt->rows;
    if (index_init(&m->imap, ni, &m->a) || index_init(&m->pmap, np, &m->a)) return xlerrNum;
    ALLOC(m, m->ifirst, ni); ALLOC(m, m->pq, ni); ALLOC(m, m->sq, ni); ALLOC(m, m->aq, ni);
    ALLOC(m, m->last_sold, ni); ALLOC(m, m->avg, ni); ALLOC(m, m->close, ni);
    ALLOC(m, m->ptax, ni); ALLOC(m, m->sval, ni); ALLOC(m, m->gp, ni);
    ALLOC(m, m->sold30, ni); ALLOC(m, m->last_buy, ni);
    ALLOC(m, m->pfirst, np); ALLOC(m, m->csales, np); ALLOC(m, m->recv, np); ALLOC(m, m->cpurch, np);
    ALLOC(m, m->paid, np); ALLOC(m, m->last_sale, np); ALLOC(m, m->last_rec, np);
    ALLOC(m, m->pl, pu->rows); ALLOC(m, m->sl, sa->rows);
    if (m->a.oom) return xlerrNum;

    /* 1. index masters */
    for (int r = 0; r < ni; r++) {
        const XLOPER12 *k = at(it, r, IT_NAME);
        m->ifirst[r] = is_blank(k) ? -1 : index_add(&m->imap, key_of(k, &m->a), r);
        m->last_buy[r] = -1;
    }
    for (int r = 0; r < np; r++) {
        const XLOPER12 *k = at(pt, r, PT_NAME);
        m->pfirst[r] = is_blank(k) ? -1 : index_add(&m->pmap, key_of(k, &m->a), r);
    }

    /* 2. purchases (always needed by the passes below) */
    for (int r = 0; r < m->eff[IN_PURCHASES] && need; r++) {
        line_t *L = &m->pl[r];
        post_line(m, pu, r, L, IT_PRATE);
        if (!L->has_item) continue;
        if (L->item >= 0) {
            m->pq[L->item] += num(at(pu, r, TX_QTY));
            m->ptax[L->item] += L->tax;
            m->last_buy[L->item] = r;
        }
        if (L->party >= 0) m->cpurch[L->party] += L->total - L->paid;
    }

    /* 3. weighted-average cost (per first row) */
    for (int r = 0; r < ni; r++) {
        if (m->ifirst[r] != r) continue;
        m->pq[r] = snapq(m->pq[r]);
        double oq = num(at(it, r, IT_OQTY)), den = oq + m->pq[r];
        m->avg[r] = den == 0.0 ? num(at(it, r, IT_PRATE))
                               : (oq * num(at(it, r, IT_ORATE)) + rupees(m->ptax[r])) / den;
    }

    /* 4. sales */
    for (int r = 0; r < m->eff[IN_SALES] && (need & NEED_SALES); r++) {
        line_t *L = &m->sl[r];
        post_line(m, sa, r, L, IT_SRATE);
        L->inv_kind = parse_invoice(at(sa, r, TX_DOC), m->prefix, &L->inv);
        const XLOPER12 *d = at(sa, r, TX_DATE);
        if (L->party >= 0 && is_num(d) && num(d) > m->last_sale[L->party]) m->last_sale[L->party] = num(d);
        if (!L->has_item) continue;
        if (L->item >= 0) {
            L->cogs = paise(num(at(sa, r, TX_QTY)) * m->avg[L->item]);
            m->sq[L->item] += num(at(sa, r, TX_QTY));
            m->sval[L->item] += L->tax;
            m->gp[L->item] += L->tax - L->cogs;
            if (is_num(d) && num(d) > m->last_sold[L->item]) m->last_sold[L->item] = num(d);
            if (is_num(d) && num(d) > m->asof - 30 && num(d) <= m->asof) m->sold30[L->item] += num(at(sa, r, TX_QTY));
        }
        if (L->party >= 0) m->csales[L->party] += L->total - L->paid;
    }

    /* 5. adjustments */
    for (int r = 0; r < ad->rows && (need & NEED_ADJ); r++) {
        const XLOPER12 *k = at(ad, r, AD_ITEM);
        if (is_blank(k)) continue;
        int i = index_get(&m->imap, key_of(k, &m->a));
        if (i >= 0) m->aq[i] += num(at(ad, r, AD_QTY));
    }

    /* 6. closing stock of each first row (used by sales stock checks) */
    for (int r = 0; r < ni; r++) {
        if (m->ifirst[r] != r) continue;
        m->sq[r] = snapq(m->sq[r]);
        m->aq[r] = snapq(m->aq[r]);
        m->close[r] = snapq(num(at(it, r, IT_OQTY)) + m->pq[r] - m->sq[r] + m->aq[r]);
    }
    for (int r = 0; r < m->eff[IN_SALES] && (need & NEED_ADJ); r++) {
        line_t *L = &m->sl[r];
        if (!L->has_item) continue;
        if (L->item < 0) L->check = CHK_UNKNOWN;
        else if (num(at(sa, r, TX_QTY)) < 0) L->check = CHK_RETURN;
        else if (m->close[L->item] < 0) L->check = CHK_NEG;
        else if (L->rate < m->avg[L->item]) L->check = CHK_BELOW;
        else L->check = CHK_OK;
    }

    /* 7. cash book -> party receipts / payments */
    for (int r = 0; r < m->eff[IN_CASHBOOK] && (need & NEED_CASH); r++) {
        const XLOPER12 *t = at(cb, r, CB_TYPE), *p = at(cb, r, CB_PARTY);
        int rec = cell_is(t, "Receipt"), pay = cell_is(t, "Payment");
        if ((!rec && !pay) || is_blank(p)) continue;
        int i = index_get(&m->pmap, key_of(p, &m->a));
        if (i < 0) continue;
        long long amt = paise(num(at(cb, r, CB_AMOUNT)));
        if (rec) {
            m->recv[i] += amt;
            const XLOPER12 *d = at(cb, r, CB_DATE);
            if (is_num(d) && num(d) > m->last_rec[i]) m->last_rec[i] = num(d);
        } else {
            m->paid[i] += amt;
        }
    }
    return m->a.oom ? xlerrNum : -1;
}

/* ------------------------------------------------------------ output */
/* One malloc holds [header][cells][string pool], sized up front, so results are
   written in place and xlAutoFree12 releases everything with a single free(). */
typedef struct {
    XLOPER12 *blk, *cells;
    XCHAR *pool, *empty;
    size_t pool_left;
    int rows, cols, oom;
} outb;

static XLOPER12 *err_result(int e)
{
    XLOPER12 *x = (XLOPER12 *)malloc(sizeof *x);
    if (x) { x->xltype = xltypeErr | xlbitDLLFree; x->val.err = e; }
    return x;
}

static int ob_init(outb *o, int rows, int cols, size_t max_chars_per_row)
{
    memset(o, 0, sizeof *o);
    o->rows = rows > 0 ? rows : 1;
    o->cols = cols;
    size_t ncell = (size_t)o->rows * cols;
    size_t chars = 1 + (size_t)o->rows * max_chars_per_row;
    o->blk = (XLOPER12 *)malloc(sizeof(XLOPER12) * (1 + ncell) + sizeof(XCHAR) * chars);
    if (!o->blk) return -1;
    o->cells = o->blk + 1;
    o->empty = (XCHAR *)(o->cells + ncell);
    o->empty[0] = 0;
    o->pool = o->empty + 1;
    o->pool_left = chars - 1;
    for (size_t i = 0; i < ncell; i++) { o->cells[i].xltype = xltypeStr; o->cells[i].val.str = o->empty; }
    return 0;
}

static void ob_num(outb *o, int r, int c, double v)
{
    XLOPER12 *x = &o->cells[(size_t)r * o->cols + c];
    x->xltype = xltypeNum;
    x->val.num = v;
}

static void ob_text(outb *o, int r, int c, const XCHAR *w, const char *a, int n)
{
    if (n <= 0) return;   /* cells start as "" */
    if ((size_t)n + 1 > o->pool_left) { o->oom = 1; return; }
    XCHAR *s = o->pool;
    s[0] = (XCHAR)n;
    for (int j = 0; j < n; j++) s[j + 1] = w ? w[j] : (XCHAR)(unsigned char)a[j];
    o->pool += n + 1;
    o->pool_left -= (size_t)n + 1;
    o->cells[(size_t)r * o->cols + c].val.str = s;
}

static void ob_lit(outb *o, int r, int c, const char *a) { ob_text(o, r, c, NULL, a, (int)strlen(a)); }
static void ob_sv(outb *o, int r, int c, sv s) { ob_text(o, r, c, s.p, NULL, s.n); }

static XLOPER12 *ob_finish(outb *o)
{
    if (o->oom) { free(o->blk); return err_result(xlerrNum); }
    o->blk->xltype = xltypeMulti | xlbitDLLFree;
    o->blk->val.array.lparray = o->cells;
    o->blk->val.array.rows = o->rows;
    o->blk->val.array.columns = o->cols;
    return o->blk;
}

/* ------------------------------------------------------------ output blocks */
static void out_items(model *m, outb *o)
{
    const grid *it = &m->g[IN_ITEMS];
    double span = m->asof - m->fy;
    for (int r = 0; r < it->rows; r++) {
        int f = m->ifirst[r];
        if (f < 0) continue;
        double oq = num(at(it, r, IT_OQTY)), reorder = num(at(it, r, IT_REORDER)), srate = num(at(it, r, IT_SRATE));
        double close = snapq(oq + m->pq[f] - m->sq[f] + m->aq[f]);
        double avg = (f == r) ? m->avg[r]
                     : ((oq + m->pq[f]) == 0.0 ? num(at(it, r, IT_PRATE))
                                               : (oq * num(at(it, r, IT_ORATE)) + rupees(m->ptax[f])) / (oq + m->pq[f]));
        double days = m->last_sold[f] == 0.0 ? span : m->asof - m->last_sold[f];
        ob_num(o, r, 0, m->pq[f]);
        ob_num(o, r, 1, m->sq[f]);
        ob_num(o, r, 2, m->aq[f]);
        ob_num(o, r, 3, close);
        ob_num(o, r, 4, avg);
        ob_num(o, r, 5, st_round2((close > 0 ? close : 0) * avg));
        ob_lit(o, r, 6, close < 0 ? "NEGATIVE" : close == 0 ? "OUT OF STOCK" : close <= reorder ? "REORDER"
                        : days > m->dead ? "DEAD STOCK" : "OK");
        ob_num(o, r, 7, srate == 0 ? 0.0 : (srate - avg) / srate);
        ob_num(o, r, 8, close <= reorder ? (2 * reorder - close > 0 ? 2 * reorder - close : 0) : 0);
        ob_num(o, r, 9, rupees(m->sval[f]));
        ob_num(o, r, 10, rupees(m->gp[f]));
        ob_num(o, r, 11, m->last_sold[f]);
        ob_num(o, r, 12, days);
        if (m->sq[f] != 0) ob_num(o, r, 13, close / (m->sq[f] / (span > 1 ? span : 1)));
        ob_num(o, r, 14, rupees(m->sval[f]) + (r + 1) / 1e6);   /* unique rank key for LARGE() */
        /* purchase planning: Items!AA:AE */
        double s30 = m->sold30[f];
        ob_num(o, r, 15, s30);
        int lb = m->last_buy[f];
        if (lb >= 0) {
            ob_sv(o, r, 16, key_of(at(&m->g[IN_PURCHASES], lb, TX_PARTY), &m->a));
            ob_num(o, r, 17, m->pl[lb].rate);
        } else {
            ob_num(o, r, 17, num(at(it, r, IT_PRATE)));
        }
        if (s30 != 0) ob_num(o, r, 18, (close > 0 ? close : 0) / (s30 / 30));
        double want = st_round0(s30 / 30 * (m->lead + m->cover) + reorder - close);
        ob_num(o, r, 19, want > 0 ? want : 0);
    }
}

static void out_lines(model *m, outb *o, int sales)
{
    const grid *g = &m->g[sales ? IN_SALES : IN_PURCHASES];
    const grid *it = &m->g[IN_ITEMS];
    line_t *lines = sales ? m->sl : m->pl;
    int c_item = sales ? 11 : 8, c_party = sales ? 12 : 9;
    for (int r = 0; r < g->rows; r++) {
        line_t *L = &lines[r];
        if (r >= m->eff[sales ? IN_SALES : IN_PURCHASES]) {   /* beyond the Free plan */
            if (!is_blank(at(g, r, TX_ITEM))) ob_lit(o, r, sales ? 10 : 0, "PRO PLAN");
            continue;
        }
        if (L->party_given && L->party >= 0) ob_num(o, r, c_party, L->party + 1);
        if (sales && L->inv_kind) ob_num(o, r, 13, L->inv);
        if (!L->has_item) continue;
        if (L->item >= 0) {
            ob_sv(o, r, 0, sv_of(at(it, L->item, IT_UNIT)));
            ob_num(o, r, c_item, L->item + 1);
        }
        ob_num(o, r, 1, L->rate);
        ob_num(o, r, 2, rupees(L->tax));
        ob_num(o, r, 3, L->gst);
        ob_num(o, r, 4, rupees(L->cgst));
        ob_num(o, r, 5, rupees(L->sgst));
        ob_num(o, r, 6, rupees(L->igst));
        ob_num(o, r, 7, rupees(L->total));
        if (sales) {
            ob_num(o, r, 8, rupees(L->cogs));
            ob_num(o, r, 9, rupees(L->tax - L->cogs));
            static const char *chk[] = { "", "OK", "UNKNOWN ITEM", "NEG STOCK", "BELOW COST", "RETURN" };
            ob_lit(o, r, 10, chk[L->check]);
            ob_num(o, r, 14, rupees(L->paid));
            /* GSTR-1 helpers: buyer registered (GSTIN on Parties) and the item's HSN */
            ob_lit(o, r, 15, (L->party >= 0 && !is_blank(at(&m->g[IN_PARTIES], L->party, PT_GSTIN))) ? "B2B" : "B2C");
            if (L->item >= 0) ob_sv(o, r, 16, key_of(at(it, L->item, IT_HSN), &m->a));
        } else {
            ob_num(o, r, 10, rupees(L->paid));
        }
    }
}

static void out_parties(model *m, outb *o)
{
    const grid *pt = &m->g[IN_PARTIES];
    for (int r = 0; r < pt->rows; r++) {
        int f = m->pfirst[r];
        if (f < 0) continue;
        long long bal = paise(num(at(pt, r, PT_OPEN))) + m->csales[f] - m->recv[f] - m->cpurch[f] + m->paid[f];
        double limit = num(at(pt, r, PT_LIMIT)), cdays = num(at(pt, r, PT_DAYS));
        ob_num(o, r, 0, rupees(m->csales[f]));
        ob_num(o, r, 1, rupees(m->recv[f]));
        ob_num(o, r, 2, rupees(m->cpurch[f]));
        ob_num(o, r, 3, rupees(m->paid[f]));
        ob_num(o, r, 4, rupees(bal));
        ob_lit(o, r, 5, bal > 0 ? "Receivable" : bal < 0 ? "Payable" : "Settled");
        ob_num(o, r, 6, m->last_sale[f]);
        ob_num(o, r, 7, m->last_rec[f]);
        double days = 0;
        if (bal > 0) {
            days = m->asof - (m->last_rec[f] > 0 ? m->last_rec[f] : m->last_sale[f] > 0 ? m->last_sale[f] : m->fy);
            ob_num(o, r, 8, days);
        }
        ob_lit(o, r, 9, (limit > 0 && rupees(bal) > limit) ? "OVER LIMIT"
                        : (bal > 0 && days > cdays) ? "OVERDUE" : bal < 0 ? "PAY DUE" : "");
    }
}

/* Collections!E:V - ageing, MSME 43B(h), GST credit at risk (180 days), 8-week due schedule.
   Payments clear the oldest bills first, so what is unpaid is the newest credit bills: the part older
   than t days is clamp(balance - credit billed in the last t days, 0, balance). */
enum { AG_T30, AG_T60, AG_T90, AG_T180, AG_TDUE, AG_TW1 };          /* AG_TW1 + w - 1 = due - 7w, w = 1..8 */
#define AG_NT (AG_TW1 + 8)

typedef struct { double date; int dated; long long amt, gst; int credit; } bill_t;

/* group the posted lines of one register by party (counting sort): start[p]..start[p+1] */
static bill_t *group_bills(model *m, int sales, int **start_out)
{
    const grid *g = &m->g[sales ? IN_SALES : IN_PURCHASES];
    line_t *lines = sales ? m->sl : m->pl;
    int np = m->g[IN_PARTIES].rows, n = m->eff[sales ? IN_SALES : IN_PURCHASES];
    int *start = (int *)arena_zalloc(&m->a, sizeof(int) * (size_t)(np + 1));
    int *fill_ = (int *)arena_zalloc(&m->a, sizeof(int) * (size_t)(np + 1));
    if (!start || !fill_) return NULL;
    for (int r = 0; r < n; r++)
        if (lines[r].has_item && lines[r].party >= 0) start[lines[r].party + 1]++;
    for (int p = 0; p < np; p++) start[p + 1] += start[p];
    bill_t *b = (bill_t *)arena_alloc(&m->a, sizeof(bill_t) * (size_t)(start[np] > 0 ? start[np] : 1));
    if (!b) return NULL;
    for (int r = 0; r < n; r++) {
        line_t *L = &lines[r];
        if (!L->has_item || L->party < 0) continue;
        bill_t *x = &b[start[L->party] + fill_[L->party]++];
        const XLOPER12 *d = at(g, r, TX_DATE);
        x->dated = is_num(d);
        x->date = num(d);
        x->amt = L->total - L->paid;
        x->gst = L->cgst + L->sgst + L->igst;
        x->credit = L->paid == 0;
    }
    *start_out = start;
    return b;
}

static void out_ageing(model *m, outb *o)
{
    const grid *pt = &m->g[IN_PARTIES];
    int *ss = NULL, *ps = NULL;
    bill_t *sb = group_bills(m, 1, &ss), *pb = group_bills(m, 0, &ps);
    if (!sb || !pb) { o->oom = 1; return; }
    for (int r = 0; r < pt->rows; r++) {
        int f = m->pfirst[r];
        if (f < 0) continue;
        long long bal = paise(num(at(pt, r, PT_OPEN))) + m->csales[f] - m->recv[f] - m->cpurch[f] + m->paid[f];
        int sgn = bal > 0 ? 1 : bal < 0 ? -1 : 0;
        long long amt = bal < 0 ? -bal : bal;
        const XLOPER12 *ms = at(pt, r, PT_MSME);
        int mse = cell_is(ms, "Micro") || cell_is(ms, "Small");
        double days = num(at(pt, r, PT_DAYS));
        double d43 = cell_is(at(pt, r, PT_AGREE), "Yes") ? ((days > 0 ? days : 45) < 45 ? (days > 0 ? days : 45) : 45) : 15;
        double due = (sgn < 0 && mse) ? d43 : days;
        double t[AG_NT] = { 30, 60, 90, 180, due };
        for (int w = 1; w <= 8; w++) t[AG_TW1 + w - 1] = due - 7 * w;
        long long S[AG_NT] = { 0 }, gst_old = 0, tot_old = 0;
        if (sgn != 0) {
            bill_t *b = sgn > 0 ? sb : pb;
            int *st = sgn > 0 ? ss : ps;
            for (int i = st[f]; i < st[f + 1]; i++) {
                if (!b[i].dated) continue;
                for (int k = 0; k < AG_NT; k++)
                    if (b[i].date >= m->asof - t[k]) S[k] += b[i].amt;
                if (sgn < 0 && b[i].credit && b[i].date < m->asof - 180) { gst_old += b[i].gst; tot_old += b[i].amt; }
            }
        }
        long long O[AG_NT];
        for (int k = 0; k < AG_NT; k++) {
            long long v = amt - S[k];
            O[k] = v < 0 ? 0 : v > amt ? amt : v;
        }
        ob_num(o, r, 0, rupees(amt - O[AG_T30]));
        ob_num(o, r, 1, rupees(O[AG_T30] - O[AG_T60]));
        ob_num(o, r, 2, rupees(O[AG_T60] - O[AG_T90]));
        ob_num(o, r, 3, rupees(O[AG_T90]));
        ob_num(o, r, 4, rupees(O[AG_TDUE]));
        ob_num(o, r, 5, rupees(O[AG_TW1] - O[AG_TDUE]));
        if (mse) {
            ob_num(o, r, 6, d43);
            ob_num(o, r, 7, sgn < 0 ? rupees(O[AG_TDUE]) : 0);
            ob_num(o, r, 8, sgn < 0 ? rupees(O[AG_TW1] - O[AG_TDUE]) : 0);
        }
        ob_num(o, r, 9, (sgn < 0 && tot_old != 0)
                            ? st_round2(rupees(O[AG_T180]) * rupees(gst_old) / rupees(tot_old)) : 0);
        for (int w = 1; w <= 8; w++) {
            long long prev = w == 1 ? O[AG_TDUE] : O[AG_TW1 + w - 2];
            ob_num(o, r, 9 + w, sgn * rupees(O[AG_TW1 + w - 1] - prev));
        }
    }
}

static void out_cashbook(model *m, outb *o)
{
    const grid *cb = &m->g[IN_CASHBOOK];
    for (int r = 0; r < cb->rows; r++) {
        const XLOPER12 *t = at(cb, r, CB_TYPE);
        if (is_blank(t)) continue;
        if (r >= m->eff[IN_CASHBOOK]) { ob_lit(o, r, 2, "PRO PLAN"); continue; }
        double amt = num(at(cb, r, CB_AMOUNT));
        if (amt != 0) {
            int in = cell_is(t, "Receipt") || cell_is(t, "Other Income") || cell_is(t, "Capital In") || cell_is(t, "Transfer In");
            ob_num(o, r, 0, in ? amt : 0);
            ob_num(o, r, 1, in ? 0 : amt);
        }
        const char *chk = "OK";
        if ((cell_is(t, "Receipt") || cell_is(t, "Payment")) && is_blank(at(cb, r, CB_PARTY))) chk = "Party needed";
        else if ((cell_is(t, "Expense") || cell_is(t, "Other Income")) && is_blank(at(cb, r, CB_HEAD))) chk = "Head needed";
        else if (is_blank(at(cb, r, CB_ACCOUNT))) chk = "Account needed";
        ob_lit(o, r, 2, chk);
    }
}

static void out_adjust(model *m, outb *o)
{
    const grid *ad = &m->g[IN_ADJUST];
    for (int r = 0; r < ad->rows; r++) {
        const XLOPER12 *k = at(ad, r, AD_ITEM);
        if (is_blank(k)) continue;
        int i = index_get(&m->imap, key_of(k, &m->a));
        double avg = i >= 0 ? m->avg[i] : 0.0;
        ob_num(o, r, 0, avg);
        ob_num(o, r, 1, st_round2(num(at(ad, r, AD_QTY)) * avg));
    }
}

/* longest text copied into an output row: unit + HSN (sales) or the supplier name (items) */
static int max_text_len(model *m)
{
    int n = 0, h = 0, p = 0;
    for (int r = 0; r < m->g[IN_ITEMS].rows; r++) {
        sv u = sv_of(at(&m->g[IN_ITEMS], r, IT_UNIT)), x = key_of(at(&m->g[IN_ITEMS], r, IT_HSN), &m->a);
        if (u.n > n) n = u.n;
        if (x.n > h) h = x.n;
    }
    for (int r = 0; r < m->g[IN_PURCHASES].rows; r++) {
        sv x = key_of(at(&m->g[IN_PURCHASES], r, TX_PARTY), &m->a);
        if (x.n > p) p = x.n;
    }
    return n + h + p;
}

XLOPER12 *st_compute(int which, const XLOPER12 *const in[IN_COUNT])
{
    static const int src[] = { IN_ITEMS, IN_PURCHASES, IN_SALES, IN_PARTIES, IN_CASHBOOK, IN_ADJUST, IN_PARTIES };
    static const int ncol[] = { 20, 11, 17, 10, 3, 2, 18 };
    static const int need[] = {
        NEED_PURCH | NEED_SALES | NEED_ADJ,   /* items: stock needs every movement     */
        NEED_PURCH,                           /* purchases                              */
        NEED_PURCH | NEED_SALES | NEED_ADJ,   /* sales: COGS + closing-stock check      */
        NEED_PURCH | NEED_SALES | NEED_CASH,  /* parties: credit bills and cash         */
        0,                                    /* cash book: self-contained              */
        NEED_PURCH,                           /* adjustments: average cost              */
        NEED_PURCH | NEED_SALES | NEED_CASH,  /* ageing: balances and dated credit bills */
    };
    if (which < 0 || which > ST_OUT_AGEING) return err_result(xlerrValue);

    model m;
    int e = model_build(&m, in, need[which]);
    if (e >= 0) { arena_free(&m.a); return err_result(e); }

    /* text budget per row: copied texts + up to three status literals (e.g. "Receivable" + "OVER LIMIT") */
    size_t per_row = (size_t)max_text_len(&m) + 3 + 40;
    outb o;
    if (ob_init(&o, m.g[src[which]].rows, ncol[which], per_row) != 0) { arena_free(&m.a); return err_result(xlerrNum); }
    switch (which) {
    case ST_OUT_ITEMS: out_items(&m, &o); break;
    case ST_OUT_PURCHASES: out_lines(&m, &o, 0); break;
    case ST_OUT_SALES: out_lines(&m, &o, 1); break;
    case ST_OUT_PARTIES: out_parties(&m, &o); break;
    case ST_OUT_CASHBOOK: out_cashbook(&m, &o); break;
    case ST_OUT_ADJUST: out_adjust(&m, &o); break;
    case ST_OUT_AGEING: out_ageing(&m, &o); break;
    }
    XLOPER12 *res = ob_finish(&o);
    arena_free(&m.a);
    return res;
}

void st_free_result(XLOPER12 *x) { free(x); }
