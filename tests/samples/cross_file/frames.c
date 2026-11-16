/* Cross-file sample: inputs (a volatile mailbox, fields behind pointer-to-const parameters) and the array
 * lengths the callers in app.c pass. Markers as in ../runtime_checks.c. */
#include <string.h>

#include "calib.h"

static u8 seen[64];

void frame_read(Frame *out)
{
    out->dlc = (u8)mbox.LEN;
    (void)memcpy(out->data, (const void *)mbox.DATA, out->dlc); /* DEFECT(out_of_bounds): LEN from the hardware can be up to 255 */
}

void frame_read_checked(Frame *out)
{
    out->dlc = (u8)mbox.LEN;
    if (out->dlc > 8U) {
        out->dlc = 8U;
    }
    (void)memcpy(out->data, (const void *)mbox.DATA, out->dlc); /* SAFE(out_of_bounds): clamped to 8 above */
}

void frame_dispatch(const Frame *f)
{
    seen[f->id] = 1U; /* DEFECT(out_of_bounds): the id of an input frame is not checked */
}

void frame_dispatch_checked(const Frame *f)
{
    if (f->id < 64U) {
        seen[f->id] = 1U; /* SAFE(out_of_bounds): id checked above */
    }
}

void put_u16(u8 *data, u8 offset, u16 value)
{
    data[offset] = (u8)(value & 0xFFU); /* DEFECT(out_of_bounds): app.c passes 8-byte buffers, offset is not checked */
    data[offset + 1U] = (u8)(value >> 8U); /* DEFECT(out_of_bounds): offset 7 writes data[8] */
}

s16 table_lookup(const s16 *xs, const s16 *ys, u32 n, s16 x)
{
    u32 i = 0U;

    while ((i < (n - 1U)) && (x > xs[i + 1U])) { /* SAFE(out_of_bounds): i + 1 < n inside the loop */
        i++;
    }
    return ys[i + 1U]; /* DEFECT(out_of_bounds): i + 1 == n when x is above the last entry */
}

u8 checksum(const u8 *data, u32 len)
{
    u8  sum = 0U;
    u32 i;

    for (i = 0U; i < len; i++) {
        sum = (u8)(sum + data[i]); /* SAFE(out_of_bounds): the caller passes the length with the buffer */
    }
    return sum;
}
