/* Cross-file sample: accumulators that nothing limits. Markers as in ../runtime_checks.c. */
#include "calib.h"

s32 parse_digits(const char *s)
{
    s32 value = 0;

    while (*s != '\0') {
        value = (value * 10) + (*s - '0'); /* DEFECT(overflow): a long digit string does not fit in s32 */
        s++;
    }
    return value;
}

s32 parse_digits_checked(const char *s)
{
    s32 value = 0;

    while (*s != '\0') {
        if (value > 100000) {
            break;
        }
        value = (value * 10) + (*s - '0'); /* SAFE(overflow): value is limited above */
        s++;
    }
    return value;
}

s32 integrate(Integrator *it, s32 error)
{
    it->integral += error * it->gain; /* DEFECT(overflow): grows on every call, nothing limits it */
    return it->integral;
}

s32 integrate_limited(Integrator *it, s32 error)
{
    it->limited += error * it->gain; /* SAFE(overflow): clamped below */
    if (it->limited > 1000000) {
        it->limited = 1000000;
    }
    return it->limited;
}

s32 window_add(Window *w, s16 x)
{
    w->sum -= w->buf[w->idx];
    w->buf[w->idx] = x;
    w->sum += x; /* SAFE(overflow): a sliding window: what goes in also goes out again */
    w->idx = (u8)((w->idx + 1U) % 4U);
    return w->sum;
}
