/* Function and value checks. Markers: DEFECT(category) = a finding of that category's rule is expected on the
 * line; SAFE(category) = no finding of that rule allowed. Lines without a marker must not get any finding.
 * Categories map to rules in src/core/checks/index.ts (CATEGORY_RULES). */

#include <stdint.h>
#include <stdlib.h>

typedef unsigned char u8;
typedef unsigned int u32;

typedef enum { GEAR_P = 0, GEAR_R = 1, GEAR_N = 2, GEAR_D = 3 } Gear;
typedef u32 (*Filter)(u32);

static u8 g_scratch[32];
static u32 g_count;

int stop_requested(void);

/* ---- missing-return --------------------------------------------------------------------------- */

u32 gear_ratio(Gear g)
{
    switch (g) {
    case GEAR_D:
        return 4U;
    case GEAR_R:
        return 3U;
    default:
        break;
    }
} /* DEFECT(missing_return): P and N fall off the end */

u32 gear_ratio_safe(Gear g)
{
    u32 r = 0U;

    if (g == GEAR_D) {
        r = 4U;
    }
    return r; /* SAFE(missing_return): one exit with a value */
}

static void halt(void)
{
    for (;;) {
        /* wait for the watchdog */
    }
}

u32 checked_ratio(Gear g)
{
    if (g == GEAR_D) {
        return 4U;
    }
    halt(); /* DEFECT(non_terminating_call): halt() never returns */
} /* SAFE(missing_return): halt() never returns, so the end is never reached */

/* ---- invalid-enum ----------------------------------------------------------------------------- */

Gear gear_from_bus(u8 raw)
{
    return (Gear)raw; /* DEFECT(invalid_enum): raw can be up to 255 */
}

Gear gear_from_bus_checked(u8 raw)
{
    if (raw > (u8)GEAR_D) {
        return GEAR_P;
    }
    return (Gear)raw; /* SAFE(invalid_enum): checked against the last constant */
}

Gear gear_from_bits(u8 raw)
{
    return (Gear)(raw & 3U); /* SAFE(invalid_enum): the mask keeps it in 0..3 */
}

/* ---- no-return-call --------------------------------------------------------------------------- */

static void wait_or_stop(void)
{
    for (;;) {
        if (stop_requested() != 0) {
            return;
        }
    }
}

void shutdown(void)
{
    wait_or_stop(); /* SAFE(non_terminating_call): returns when a stop is requested */
    abort(); /* SAFE(non_terminating_call): library function, known to stop the program */
}

/* ---- bad-function-pointer --------------------------------------------------------------------- */

static u32 identity(u32 x)
{
    return x;
}

static u32 halve(u32 x)
{
    return x / 2U;
}

u32 run_patch(u32 x)
{
    Filter f = (Filter)(uintptr_t)g_scratch;

    return f(x); /* DEFECT(bad_func_ptr): g_scratch is data */
}

u32 run_filter(u32 x, u8 mode)
{
    Filter f = identity;

    if (mode != 0U) {
        f = halve;
    }
    return f(x); /* SAFE(bad_func_ptr): f is always one of the two functions */
}

u32 run_maybe_patch(u32 x, u8 mode)
{
    Filter f = identity;

    if (mode == 7U) {
        f = (Filter)(uintptr_t)&g_count;
    }
    return f(x); /* DEFECT(bad_func_ptr): f is the address of g_count when mode == 7 */
}

u32 run_rom(u32 x)
{
    Filter f = (Filter)0x08004000U;

    return f(x); /* SAFE(bad_func_ptr): a fixed code address, not a data object */
}
