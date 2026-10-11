/*
 * winhost.c - a stand-in for Excel.exe used to test the compiled .xll on Windows/Wine.
 * Exports MdCallBack12 like Excel, LoadLibrary()s the add-in, runs xlAutoOpen,
 * calls every UDF through GetProcAddress with the same TSV inputs as the native
 * harness and writes the results, so they can be diffed byte-for-byte.
 *
 *   winhost.exe SmartTrader64.xll <in-dir> <out-dir>
 */
#define __USE_MINGW_ANSI_STDIO 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

#include "../src/xlcall_min.h"

static int g_registered;

__declspec(dllexport) int __stdcall MdCallBack12(int fn, int count, LPXLOPER12 *args, LPXLOPER12 res)
{
    static XCHAR dll[] = { 15, 'S','m','a','r','t','T','r','a','d','e','r','.','x','l','l' };
    if (fn == xlGetName) { res->xltype = xltypeStr; res->val.str = dll; return xlretSuccess; }
    if (fn == xlFree) return xlretSuccess;
    if (fn == xlfRegister) {
        char name[64] = { 0 };
        for (int i = 0; i < args[3]->val.str[0] && i < 63; i++) name[i] = (char)args[3]->val.str[i + 1];
        printf("  registered %-13s (%d args)\n", name, count);
        res->xltype = xltypeNum;
        res->val.num = ++g_registered;
        return xlretSuccess;
    }
    return xlretFailed;
}

typedef LPXLOPER12 (__stdcall *udf7)(LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12, LPXLOPER12);
typedef LPXLOPER12 (__stdcall *udf0)(void);
typedef int (__stdcall *autoopen)(void);
typedef void (__stdcall *autofree)(LPXLOPER12);

static XCHAR *utf16(const char *s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    XCHAR *w = malloc(sizeof(XCHAR) * (n + 1));
    MultiByteToWideChar(CP_UTF8, 0, s, -1, (wchar_t *)(w + 1), n);
    w[0] = (XCHAR)(n - 1);
    return w;
}

static void unescape(char *s)
{
    char *o = s;
    for (char *p = s; *p; p++) {
        if (*p == '\\' && p[1]) { p++; *o++ = *p == 't' ? '\t' : *p == 'n' ? '\n' : *p; }
        else *o++ = *p;
    }
    *o = 0;
}

static LPXLOPER12 load(const char *path)
{
    static char line[1 << 20];
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(1); }
    int rows, cols;
    if (!fgets(line, sizeof line, f) || sscanf(line, "%d %d", &rows, &cols) != 2) exit(1);
    LPXLOPER12 x = calloc(1, sizeof *x), cells = calloc((size_t)rows * cols, sizeof *cells);
    x->xltype = xltypeMulti; x->val.array.lparray = cells; x->val.array.rows = rows; x->val.array.columns = cols;
    for (int r = 0; r < rows; r++) {
        if (!fgets(line, sizeof line, f)) exit(1);
        line[strcspn(line, "\r\n")] = 0;
        char *p = line;
        for (int c = 0; c < cols; c++) {
            char *tab = strchr(p, '\t');
            if (tab) *tab = 0;
            LPXLOPER12 cell = &cells[(size_t)r * cols + c];
            if (p[0] == 'n' && p[1] == ':') { cell->xltype = xltypeNum; cell->val.num = strtod(p + 2, NULL); }
            else if (p[0] == 's' && p[1] == ':') { unescape(p + 2); cell->xltype = xltypeStr; cell->val.str = utf16(p + 2); }
            else cell->xltype = xltypeNil;
            p = tab ? tab + 1 : p + strlen(p);
        }
    }
    fclose(f);
    return x;
}

static void save(const char *path, LPXLOPER12 x)
{
    FILE *f = fopen(path, "wb");
    if ((x->xltype & 0xFFF) != xltypeMulti) { fprintf(f, "ERROR %d\n", x->val.err); fclose(f); return; }
    int rows = x->val.array.rows, cols = x->val.array.columns;
    fprintf(f, "%d %d\n", rows, cols);
    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            LPXLOPER12 v = &x->val.array.lparray[(size_t)r * cols + c];
            if (c) fputc('\t', f);
            if ((v->xltype & 0xFFF) == xltypeNum) fprintf(f, "n:%.17g", v->val.num);
            else if ((v->xltype & 0xFFF) == xltypeStr && v->val.str[0]) {
                char buf[1024];
                int n = WideCharToMultiByte(CP_UTF8, 0, (wchar_t *)(v->val.str + 1), v->val.str[0], buf, sizeof buf - 1, NULL, NULL);
                buf[n] = 0;
                fputs("s:", f);
                for (char *p = buf; *p; p++) {
                    if (*p == '\t') fputs("\\t", f); else if (*p == '\n') fputs("\\n", f);
                    else if (*p == '\\') fputs("\\\\", f); else fputc(*p, f);
                }
            }
        }
        fputc('\n', f);
    }
    fclose(f);
}

int main(int argc, char **argv)
{
    if (argc < 4) { fprintf(stderr, "usage: winhost <xll> <in-dir> <out-dir>\n"); return 2; }
    HMODULE h = LoadLibraryA(argv[1]);
    if (!h) { printf("LoadLibrary failed: %lu\n", GetLastError()); return 1; }
    autoopen open = (autoopen)(void *)GetProcAddress(h, "xlAutoOpen");
    autofree xfree = (autofree)(void *)GetProcAddress(h, "xlAutoFree12");
    printf("xlAutoOpen -> %d\n", open ? open() : -1);
    if (g_registered != 7) { printf("expected 7 registrations, got %d\n", g_registered); return 1; }

    udf0 ver = (udf0)(void *)GetProcAddress(h, "ST_VERSION");
    LPXLOPER12 v = ver();
    printf("ST_VERSION -> ");
    for (int i = 0; i < v->val.str[0]; i++) putchar((char)v->val.str[i + 1]);
    printf("\n");

    static const char *in_names[] = { "items", "parties", "purchases", "sales", "cashbook", "adjust", "settings" };
    static const char *fn_names[] = { "items", "purchases", "sales", "parties", "cashbook", "adjust" };
    static const char *procs[] = { "ST_ITEMS", "ST_PURCHASES", "ST_SALES", "ST_PARTIES", "ST_CASHBOOK", "ST_ADJUST" };
    LPXLOPER12 in[7];
    char path[MAX_PATH];
    for (int i = 0; i < 7; i++) { snprintf(path, sizeof path, "%s/in_%s.tsv", argv[2], in_names[i]); in[i] = load(path); }

    LARGE_INTEGER fq, t0, t1;
    QueryPerformanceFrequency(&fq);
    for (int k = 0; k < 6; k++) {
        udf7 fn = (udf7)(void *)GetProcAddress(h, procs[k]);
        QueryPerformanceCounter(&t0);
        LPXLOPER12 r = fn(in[0], in[1], in[2], in[3], in[4], in[5], in[6]);
        QueryPerformanceCounter(&t1);
        snprintf(path, sizeof path, "%s/out_%s.tsv", argv[3], fn_names[k]);
        save(path, r);
        printf("%-13s %dx%d  %.3f ms\n", procs[k], r->val.array.rows, r->val.array.columns,
               (t1.QuadPart - t0.QuadPart) * 1000.0 / fq.QuadPart);
        if (r->xltype & xlbitDLLFree) xfree(r);
    }
    FreeLibrary(h);
    return 0;
}
