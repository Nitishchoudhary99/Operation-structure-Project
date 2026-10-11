/*
 * engine.h - SmartTrader ERP posting engine.
 *
 * Every entry point receives the RAW input blocks of the workbook and posts the
 * whole ledger in one O(n) pass (hash-indexed masters, integer-paise money), then
 * returns the requested output block. Inputs never depend on outputs, so Excel's
 * dependency graph stays acyclic and each call is independent and thread-safe.
 */
#ifndef ST_ENGINE_H
#define ST_ENGINE_H

#include "xlcall_min.h"

enum {
    ST_OUT_ITEMS,      /* Items!L:Z      15 cols */
    ST_OUT_PURCHASES,  /* Purchases!I:S  11 cols */
    ST_OUT_SALES,      /* Sales!J:X      15 cols */
    ST_OUT_PARTIES,    /* Parties!J:S    10 cols */
    ST_OUT_CASHBOOK,   /* CashBook!I:K    3 cols */
    ST_OUT_ADJUST      /* Adjustments!F:G 2 cols */
};

/* Input block indices (order of the UDF arguments). */
enum { IN_ITEMS, IN_PARTIES, IN_PURCHASES, IN_SALES, IN_CASHBOOK, IN_ADJUST, IN_SETTINGS, IN_COUNT };

/* Returns a DLL-owned XLOPER12 (xlbitDLLFree set); release with st_free_result. */
XLOPER12 *st_compute(int which, const XLOPER12 *const in[IN_COUNT]);
void st_free_result(XLOPER12 *x);

/* Excel-compatible ROUND(x, 2): exact halves (after binary noise) round away from zero. */
double st_round2(double x);

#endif
