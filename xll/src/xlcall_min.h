/*
 * xlcall_min.h - minimal declarations of the Excel C API (Excel 2007+ "12" API)
 * needed by the SmartTrader XLL. Written from the public Excel SDK documentation
 * (https://learn.microsoft.com/office/client-developer/excel/excel-xll-sdk-api-function-reference)
 * so the add-in builds with any C compiler without the SDK installed.
 */
#ifndef XLCALL_MIN_H
#define XLCALL_MIN_H

#include <stdint.h>

typedef uint16_t XCHAR;   /* UTF-16 code unit; str[0] holds the length */
typedef int32_t RW;
typedef int32_t COL;
typedef uintptr_t IDSHEET;

typedef struct xlref12 { RW rwFirst, rwLast; COL colFirst, colLast; } XLREF12;
typedef struct xlmref12 { uint16_t count; XLREF12 reftbl[1]; } XLMREF12;

typedef struct xloper12 {
    union {
        double num;
        XCHAR *str;
        int32_t xbool;
        int32_t err;
        int32_t w;
        struct { uint16_t count; XLREF12 ref; } sref;
        struct { XLMREF12 *lpmref; IDSHEET idSheet; } mref;
        struct { struct xloper12 *lparray; RW rows; COL columns; } array;
        struct {
            union { int32_t level; int32_t tbctrl; IDSHEET idSheet; } valflow;
            RW rw;
            COL col;
            uint8_t xlflow;
        } flow;
        struct { union { uint8_t *lpbData; void *hdata; } h; int32_t cbData; } bigdata;
    } val;
    uint32_t xltype;
} XLOPER12, *LPXLOPER12;

/* xltype */
#define xltypeNum     0x0001
#define xltypeStr     0x0002
#define xltypeBool    0x0004
#define xltypeRef     0x0008
#define xltypeErr     0x0010
#define xltypeFlow    0x0020
#define xltypeMulti   0x0040
#define xltypeMissing 0x0080
#define xltypeNil     0x0100
#define xltypeSRef    0x0400
#define xltypeInt     0x0800
#define xlbitXLFree   0x1000
#define xlbitDLLFree  0x4000

/* error values */
#define xlerrNull  0
#define xlerrDiv0  7
#define xlerrValue 15
#define xlerrRef   23
#define xlerrName  29
#define xlerrNum   36
#define xlerrNA    42

/* return codes */
#define xlretSuccess 0
#define xlretFailed  32

/* function numbers */
#define xlSpecial   0x4000
#define xlFree      (0 | xlSpecial)
#define xlGetName   (9 | xlSpecial)
#define xlfRegister 149

#ifdef _WIN32
#define XLCC __stdcall
#define XLEXPORT __declspec(dllexport)
#else
#define XLCC
#define XLEXPORT
#endif

typedef int (XLCC *EXCEL12PROC)(int xlfn, int coper, LPXLOPER12 *rgpxloper12, LPXLOPER12 xloper12Res);

#endif
