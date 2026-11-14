/* Division by zero: cases the check must report (DEFECT) and must stay quiet on (SAFE).
 * Markers: DEFECT(div_zero) = a finding is expected on this line; SAFE(div_zero) = no finding allowed.
 * Lines without a marker must not get a finding either. */

#include <assert.h>
#include <stdlib.h>

typedef unsigned int u32;

/* ---- reported ------------------------------------------------------------------------------- */

u32 remainder_of(u32 a, u32 m)
{
    return a % m; /* DEFECT(div_zero): m == 0 */
}

void scale_down(u32 *v, u32 f)
{
    *v /= f; /* DEFECT(div_zero): compound division, f == 0 */
}

int literal_zero(int x)
{
    return x / 0; /* DEFECT(div_zero): constant 0 divisor */
}

u32 wrong_branch(u32 a, u32 n)
{
    if (n != 0U) {
        return 1U;
    } else {
        return a / n; /* DEFECT(div_zero): this is the n == 0 branch */
    }
}

u32 check_without_exit(u32 a, u32 n)
{
    if (n == 0U) {
        a = 0U;
    }
    return a / n; /* DEFECT(div_zero): the check does not leave the function */
}

u32 check_after_use(u32 a, u32 n)
{
    u32 q = a / n; /* DEFECT(div_zero): checked only after the division */
    if (n == 0U) {
        return 0U;
    }
    return q;
}

u32 either_guard(u32 a, u32 n, u32 m)
{
    if ((n != 0U) || (m != 0U)) {
        return a / n; /* DEFECT(div_zero): only one of n, m is known to be non-zero */
    }
    return 0U;
}

static u32 per_unit(u32 total, u32 units)
{
    return total / units; /* DEFECT(div_zero): one caller passes 0 */
}

u32 use_per_unit(u32 t)
{
    return per_unit(t, 4U) + per_unit(t, 0U);
}

/* ---- not reported --------------------------------------------------------------------------- */

u32 guarded_if(u32 a, u32 n)
{
    if (n != 0U) {
        return a / n; /* SAFE(div_zero): inside if (n != 0) */
    }
    return 0U;
}

u32 guarded_truthy(u32 a, u32 n)
{
    return n ? a / n : 0U; /* SAFE(div_zero): ?: on n */
}

u32 guarded_early_return(u32 a, u32 n)
{
    if (n == 0U) {
        return 0U;
    }
    return a / n; /* SAFE(div_zero): early return on n == 0 */
}

u32 guarded_not(u32 a, u32 n)
{
    if (!n)
        return 0U;
    return a % n; /* SAFE(div_zero): early return on !n */
}

int guarded_positive(int a, int n)
{
    if (n > 0) {
        return a / n; /* SAFE(div_zero): n > 0 */
    }
    return 0;
}

int guarded_negative(int a, int n)
{
    if (n < 0) {
        return a / n; /* SAFE(div_zero): n < 0 */
    }
    return 0;
}

int guarded_else(int a, int n)
{
    if (n == 0) {
        return 0;
    } else {
        return a / n; /* SAFE(div_zero): else of n == 0 */
    }
}

int guarded_and(int a, int n)
{
    return (n != 0) && ((a / n) > 3); /* SAFE(div_zero): && short-circuit */
}

int guarded_or(int a, int n)
{
    return (n == 0) || ((a / n) > 3); /* SAFE(div_zero): || short-circuit */
}

int guarded_combined_exit(int a, int n, int *p)
{
    if ((p == 0) || (n <= 0)) {
        return -1;
    }
    return a / n; /* SAFE(div_zero): n <= 0 left the function */
}

int guarded_literal_left(int a, int n)
{
    if (0 != n) {
        return a / n; /* SAFE(div_zero): 0 != n */
    }
    return 0;
}

int guarded_assert(int a, int n)
{
    assert(n != 0);
    return a / n; /* SAFE(div_zero): assert(n != 0) */
}

int guarded_exit(int a, int n)
{
    if (n == 0) {
        abort();
    }
    return a / n; /* SAFE(div_zero): abort() does not return */
}

int guarded_loop(int a, int n)
{
    int s = 0;
    while (n > 0) {
        s += a / n; /* SAFE(div_zero): loop runs only while n > 0 */
        n--;
    }
    return s;
}

int guarded_in_loop(int a, int n, int k)
{
    int s = 0;
    int i;
    for (i = 0; i < k; i++) {
        if (n == 0) {
            continue;
        }
        s += a / n; /* SAFE(div_zero): continue on n == 0 */
    }
    return s;
}

int reassigned(int a, int n)
{
    n = n + 1;
    return a / n; /* SAFE(div_zero): n is no longer the caller's value (not tracked yet) */
}

int float_constant(float v)
{
    return (int)(v / 2.0f); /* SAFE(div_zero): constant divisor */
}

int divisor_is_local(int a)
{
    int d = 4;
    return a / d; /* SAFE(div_zero): local, not a parameter (out of scope for this check) */
}

static int scale(int v, int full)
{
    return v / full; /* SAFE(div_zero): static, every caller passes a non-zero constant */
}

int use_scale(int v)
{
    return scale(v, 100) + scale(v, (190));
}
