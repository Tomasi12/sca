/* Division by zero with the value engine: values tracked through assignments, loops, static objects and
 * same-file function results. Markers as in div_by_zero_cases.c: DEFECT(div_zero) = finding expected,
 * SAFE(div_zero) = no finding allowed; lines without a marker must stay quiet too. */

#include <string.h>

typedef unsigned int u32;

/* ---- reported ------------------------------------------------------------------------------- */

u32 zero_on_one_path(u32 a, u32 m)
{
    u32 d = 0U;
    if (m > 3U) {
        d = m;
    }
    return a / d; /* DEFECT(div_zero): d is still 0 when m <= 3 */
}

u32 counter_from_zero(u32 a, u32 n)
{
    u32 s = 0U;
    u32 i;
    for (i = 0U; i < n; i++) {
        s += a / i; /* DEFECT(div_zero): i is 0 in the first round */
    }
    return s;
}

u32 always_zero_here(u32 a, u32 n)
{
    if (n == 0U) {
        return a / n; /* DEFECT(div_zero): n is always 0 in this branch */
    }
    return a;
}

u32 switch_leaves_zero(u32 a, u32 mode)
{
    u32 d = 0U;
    switch (mode) {
    case 1U:
        d = 2U;
        break;
    case 2U:
        d = 4U;
        break;
    default:
        break;
    }
    return a / d; /* DEFECT(div_zero): default keeps d == 0 */
}

static u32 tab[4];

void tab_init(void)
{
    (void)memset(tab, 0, sizeof(tab));
}

u32 tab_div(u32 a, u32 i)
{
    return a / tab[i & 3U]; /* DEFECT(div_zero): tab_init() sets every element to 0 */
}

struct Tick {
    u32 period;
};

static struct Tick ticks[2];

void tick_set(u32 i, u32 period)
{
    ticks[i & 1U].period = period;
}

u32 tick_phase(u32 now)
{
    struct Tick *t = &ticks[0];
    return now % t->period; /* DEFECT(div_zero): tick_set() stores an unchecked parameter */
}

static u32 count_or_zero(u32 x)
{
    if (x > 10U) {
        return 0U;
    }
    return x + 1U;
}

u32 per_count(u32 a, u32 x)
{
    return a / count_or_zero(x); /* DEFECT(div_zero): count_or_zero() returns 0 for x > 10 */
}

/* ---- not reported --------------------------------------------------------------------------- */

u32 set_on_all_paths(u32 a, u32 m)
{
    u32 d;
    if (m != 0U) {
        d = 2U;
    } else {
        d = 3U;
    }
    return a / d; /* SAFE(div_zero): 2 or 3 */
}

u32 loop_runs_at_least_once(u32 a)
{
    u32 c = 0U;
    u32 i;
    for (i = 0U; i < 4U; i++) {
        c++;
    }
    return a / c; /* SAFE(div_zero): the loop runs 4 times, c >= 1 */
}

static u32 scale_k;

void scale_init(void)
{
    scale_k = 8U;
}

u32 scaled(u32 a)
{
    return a / scale_k; /* SAFE(div_zero): every store in this file is 8 (zero-init alone is not a reason) */
}

extern u32 g_div;
u32 ext_get(void);

u32 by_global(u32 a)
{
    return a / g_div; /* SAFE(div_zero): defined elsewhere, nothing known */
}

u32 by_call(u32 a)
{
    return a / ext_get(); /* SAFE(div_zero): function from another file, nothing known */
}

u32 checked_copy(u32 a)
{
    u32 p = g_div;
    if (p != 0U) {
        return a / p; /* SAFE(div_zero): checked copy */
    }
    return 0U;
}

u32 plus_one(u32 a, u32 n)
{
    return a / (n + 1U); /* SAFE(div_zero): n + 1 is 0 only by wrap-around (another check's job) */
}

static u32 gcd(u32 x, u32 y)
{
    if (y == 0U) {
        return x;
    }
    return gcd(y, x % y); /* SAFE(div_zero): y != 0 here */
}

u32 by_gcd(u32 a, u32 b)
{
    return a / gcd(a, b); /* SAFE(div_zero): recursive function, result unknown */
}

u32 count_down(u32 a, u32 n)
{
    u32 s = 0U;
    while (n != 0U) {
        s += a / n; /* SAFE(div_zero): loop runs only while n != 0 */
        n--;
    }
    return s;
}
