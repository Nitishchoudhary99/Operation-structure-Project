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
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "engine.h"

#define TYPE(x) ((x)->xltype & ~(uint32_t)(xlbitXLFree | xlbitDLLFree))

/* ------------------------------------------------------------ column maps */
/* Items!A:K */
enum { IT_NAME, IT_SKU, IT_CAT, IT_UNIT, IT_HSN, IT_GST, IT_PRATE, IT_SRATE, IT_REORDER, IT_OQTY, IT_ORATE };
/* Parties!A:I */
enum { PT_NAME, PT_TYPE, PT_PHONE, PT_GSTIN, PT_STATE, PT_ADDR, PT_LIMIT, PT_DAYS, PT_OPEN };
/* Purchases!A:H and Sales!A:I share the first 8 columns */
enum { TX_DATE, TX_DOC, TX_PARTY, TX_ITEM, TX_QTY, TX_RATE, TX_DISC, TX_MODE, TX_DELIVERY };
/* CashBook!A:H */
enum { CB_DATE, CB_VNO, CB_TYPE, CB_PARTY, CB_HEAD, CB_ACCOUNT, CB_AMOUNT, CB_NOTES };
/* Adjustments!A:E */
enum { AD_DATE, AD_ITEM, AD_QTY, AD_REASON, AD_NOTES };
/* Settings!B4:B13 */
enum { SE_COMPANY, SE_ADDR, SE_GSTIN, SE_STATE, SE_PHONE, SE_FYSTART, SE_ASOF, SE_PREFIX, SE_DEADDAYS, SE_BANK };

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

static long long paise(double x) { return llround(st_round2(x) * 100.0); }
static double rupees(long long p) { return (double)p / 100.0; }
static double snapq(double q) { return round(q * 1e6) / 1e6; }

/* ------------------------------------------------------------ model */
enum { CHK_NONE, CHK_OK, CHK_UNKNOWN, CHK_NEG, CHK_BELOW };

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
    double fy, asof, dead;
    index_t imap, pmap;
    int *ifirst, *pfirst;
    /* item accumulators, stored on the first row of each name */
    double *pq, *sq, *aq, *last_sold, *avg, *close;
    long long *ptax, *sval, *gp;
    /* party accumulators */
    long long *csales, *recv, *cpurch, *paid;
    double *last_sale, *last_rec;
    line_t *pl, *sl;
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
#undef SET

    int ni = it->rows, np = pt->rows;
    if (index_init(&m->imap, ni, &m->a) || index_init(&m->pmap, np, &m->a)) return xlerrNum;
    ALLOC(m, m->ifirst, ni); ALLOC(m, m->pq, ni); ALLOC(m, m->sq, ni); ALLOC(m, m->aq, ni);
    ALLOC(m, m->last_sold, ni); ALLOC(m, m->avg, ni); ALLOC(m, m->close, ni);
    ALLOC(m, m->ptax, ni); ALLOC(m, m->sval, ni); ALLOC(m, m->gp, ni);
    ALLOC(m, m->pfirst, np); ALLOC(m, m->csales, np); ALLOC(m, m->recv, np); ALLOC(m, m->cpurch, np);
    ALLOC(m, m->paid, np); ALLOC(m, m->last_sale, np); ALLOC(m, m->last_rec, np);
    ALLOC(m, m->pl, pu->rows); ALLOC(m, m->sl, sa->rows);
    if (m->a.oom) return xlerrNum;

    /* 1. index masters */
    for (int r = 0; r < ni; r++) {
        const XLOPER12 *k = at(it, r, IT_NAME);
        m->ifirst[r] = is_blank(k) ? -1 : index_add(&m->imap, key_of(k, &m->a), r);
    }
    for (int r = 0; r < np; r++) {
        const XLOPER12 *k = at(pt, r, PT_NAME);
        m->pfirst[r] = is_blank(k) ? -1 : index_add(&m->pmap, key_of(k, &m->a), r);
    }

    /* 2. purchases (always needed by the passes below) */
    for (int r = 0; r < pu->rows && need; r++) {
        line_t *L = &m->pl[r];
        post_line(m, pu, r, L, IT_PRATE);
        if (!L->has_item) continue;
        if (L->item >= 0) {
            m->pq[L->item] += num(at(pu, r, TX_QTY));
            m->ptax[L->item] += L->tax;
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
    for (int r = 0; r < sa->rows && (need & NEED_SALES); r++) {
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
    for (int r = 0; r < sa->rows && (need & NEED_ADJ); r++) {
        line_t *L = &m->sl[r];
        if (!L->has_item) continue;
        if (L->item < 0) L->check = CHK_UNKNOWN;
        else if (m->close[L->item] < 0) L->check = CHK_NEG;
        else if (L->rate < m->avg[L->item]) L->check = CHK_BELOW;
        else L->check = CHK_OK;
    }

    /* 7. cash book -> party receipts / payments */
    for (int r = 0; r < cb->rows && (need & NEED_CASH); r++) {
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
            static const char *chk[] = { "", "OK", "UNKNOWN ITEM", "NEG STOCK", "BELOW COST" };
            ob_lit(o, r, 10, chk[L->check]);
            ob_num(o, r, 14, rupees(L->paid));
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

static void out_cashbook(model *m, outb *o)
{
    const grid *cb = &m->g[IN_CASHBOOK];
    for (int r = 0; r < cb->rows; r++) {
        const XLOPER12 *t = at(cb, r, CB_TYPE);
        if (is_blank(t)) continue;
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

static int max_unit_len(const model *m)
{
    int n = 0;
    for (int r = 0; r < m->g[IN_ITEMS].rows; r++) {
        sv u = sv_of(at(&m->g[IN_ITEMS], r, IT_UNIT));
        if (u.n > n) n = u.n;
    }
    return n;
}

XLOPER12 *st_compute(int which, const XLOPER12 *const in[IN_COUNT])
{
    static const int src[] = { IN_ITEMS, IN_PURCHASES, IN_SALES, IN_PARTIES, IN_CASHBOOK, IN_ADJUST };
    static const int ncol[] = { 15, 11, 15, 10, 3, 2 };
    static const int need[] = {
        NEED_PURCH | NEED_SALES | NEED_ADJ,   /* items: stock needs every movement     */
        NEED_PURCH,                           /* purchases                              */
        NEED_PURCH | NEED_SALES | NEED_ADJ,   /* sales: COGS + closing-stock check      */
        NEED_PURCH | NEED_SALES | NEED_CASH,  /* parties: credit bills and cash         */
        0,                                    /* cash book: self-contained              */
        NEED_PURCH,                           /* adjustments: average cost              */
    };
    if (which < 0 || which > ST_OUT_ADJUST) return err_result(xlerrValue);

    model m;
    int e = model_build(&m, in, need[which]);
    if (e >= 0) { arena_free(&m.a); return err_result(e); }

    /* text budget per row: unit + up to two status literals (e.g. "Receivable" + "OVER LIMIT") */
    size_t per_row = (size_t)max_unit_len(&m) + 1 + 32;
    outb o;
    if (ob_init(&o, m.g[src[which]].rows, ncol[which], per_row) != 0) { arena_free(&m.a); return err_result(xlerrNum); }
    switch (which) {
    case ST_OUT_ITEMS: out_items(&m, &o); break;
    case ST_OUT_PURCHASES: out_lines(&m, &o, 0); break;
    case ST_OUT_SALES: out_lines(&m, &o, 1); break;
    case ST_OUT_PARTIES: out_parties(&m, &o); break;
    case ST_OUT_CASHBOOK: out_cashbook(&m, &o); break;
    case ST_OUT_ADJUST: out_adjust(&m, &o); break;
    }
    XLOPER12 *res = ob_finish(&o);
    arena_free(&m.a);
    return res;
}

void st_free_result(XLOPER12 *x) { free(x); }
