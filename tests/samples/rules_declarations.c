/* Coding rules, batch 4: declarations.
 * Markers: RULE(rule-id) = this rule must be reported on the line; SAFE(rule-id) = it must not be. */

#include <stdlib.h>

typedef unsigned int u32;

#define LINE_MAX 24U

static u32 ticks; /* RULE(sca-own:missing-volatile) */
static volatile u32 events; /* SAFE(sca-own:missing-volatile) */
static u32 only_main; /* SAFE(sca-own:missing-volatile): not used by the handler */

void timer_isr(void) /* SAFE(sca-own:internal-linkage): interrupt handlers are linked by the vector table */
{
    ticks++;
    events++;
}

static u32 now(void)
{
    only_main++;
    return ticks + events + only_main;
}

static int unused_local(const char *s)
{
    int checksum = 0; /* RULE(sca-own:unused-variable) */
    int n = 0; /* SAFE(sca-own:unused-variable) */
    while (s[n] != 0) {
        n++;
    }
    return n;
}

static int only_in_debug(int x)
{
    int dbg = x; /* SAFE(sca-own:unused-variable): used in an inactive #if branch */
#if 0
    x = dbg;
#endif
    return x;
}

static void reset(int reason) /* RULE(sca-own:unused-parameter) */
{
}

static void reset_ok(int reason) /* SAFE(sca-own:unused-parameter) */
{
    (void)reason;
}

static int shadow(int len)
{
    int s = 0;
    {
        int len = 3; /* RULE(sca-own:shadowing): hides the parameter */
        s = len;
    }
    return s + len;
}

static int shadow_global(void)
{
    u32 ticks = 0U; /* RULE(sca-own:shadowing): hides the file-level ticks */
    return (int)ticks;
}

static int no_shadow(int n)
{
    int i; /* SAFE(sca-own:shadowing) */
    int s = 0;
    for (i = 0; i < n; i++) {
        int t = i; /* SAFE(sca-own:shadowing): a new name */
        s += t;
    }
    {
        int t = 2; /* SAFE(sca-own:shadowing): the earlier t is out of scope */
        s += t;
    }
    return s;
}

static int *heap(void)
{
    return (int *)malloc(sizeof(int)); /* RULE(sca-own:dynamic-memory) */
}

static void heap_free(int *p)
{
    free(p); /* RULE(sca-own:dynamic-memory) */
}

static int answer() /* RULE(sca-own:empty-parameter-list) */
{
    return 42;
}

static int answer_ok(void) /* SAFE(sca-own:empty-parameter-list) */
{
    return 42;
}

int helper(int x) /* RULE(sca-own:internal-linkage) */
{
    return x + 1;
}

static int helper_ok(int x) /* SAFE(sca-own:internal-linkage) */
{
    return x + 1;
}

static int long_line(u32 len)
{
    return len > 24U; /* RULE(sca-own:magic-number) */
}

static int long_line_ok(u32 len)
{
    const u32 limit = 30U; /* SAFE(sca-own:magic-number): named by a const */
    return (len > LINE_MAX) || (len > limit) || (len == 0U); /* SAFE(sca-own:magic-number) */
}

int use_all(void) /* RULE(sca-own:internal-linkage): no header declares it */
{
    reset(0);
    reset_ok(0);
    heap_free(heap());
    return (int)now() + unused_local("a") + only_in_debug(1) + shadow(1) + shadow_global() + no_shadow(2) + answer() + answer_ok() + helper_ok(1) + long_line(3U) + long_line_ok(4U);
}
