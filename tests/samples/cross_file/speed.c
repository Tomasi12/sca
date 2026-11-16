/* Cross-file sample: findings that need facts from calib.c and app.c. Markers as in ../runtime_checks.c. */
#include "calib.h"

static Calib cal;

void speed_init(const Calib *c)
{
    cal = *c; /* DEFECT(null_deref): app.c passes calib_load(), which is NULL for a bad block */
}

u32 speed_of(u32 delta)
{
    return (delta * cal.scale) / cal.ticks; /* DEFECT(div_zero): the erased calibration in app.c has ticks 0 */
}

u32 speed_slot_scale(u32 i)
{
    const Calib *s = calib_slot(i);
    return s->scale; /* SAFE(null_deref): calib_slot() is NULL only for a bad index */
}
