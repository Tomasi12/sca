/* Cross-file sample: the calibration store. Its return values are what the other files learn. */
#include "calib.h"

static Calib stored;
static Calib slots[4];
static u8    valid;

const Calib *calib_load(void)
{
    if (valid == 0U) {
        return NULL; /* a NULL that does not depend on an argument: evidence for the callers */
    }
    return &stored;
}

const Calib *calib_slot(u32 i)
{
    return (i < 4U) ? &slots[i] : NULL; /* NULL only for a bad index: no evidence for callers */
}

void calib_store(const Calib *c)
{
    stored = *c;
    valid  = 1U;
}
