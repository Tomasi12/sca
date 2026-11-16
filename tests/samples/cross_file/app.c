/* Cross-file sample: the callers. What they pass is what the other files learn. */
#include "calib.h"

Mailbox mbox;

static const s16 xs[5] = {0, 10, 20, 30, 40};
static const s16 ys[5] = {0, 5, 9, 12, 14};

int main(void)
{
    static const Calib erased = {0U, 100U};
    Frame f;
    u8    buf[8] = {1U, 2U, 3U, 4U, 5U, 6U, 7U, 8U};
    Integrator it = {2, 0, 0};
    Window w = {0, {1, 2, 3, 4}, 0U};

    calib_store(&erased);
    speed_init(calib_load());
    frame_read(&f);
    frame_read_checked(&f);
    frame_dispatch(&f);
    frame_dispatch_checked(&f);
    put_u16(f.data, 0U, 0x1234U);
    put_u16(buf, 4U, 0x5678U);
    (void)checksum(buf, 8U);
    (void)checksum(f.data, 4U);
    (void)speed_of(5U);
    (void)speed_slot_scale(1U);
    (void)table_lookup(xs, ys, 5U, 50);
    (void)parse_digits("123");
    (void)parse_digits_checked("7");
    (void)integrate(&it, 3);
    (void)integrate_limited(&it, 3);
    (void)window_add(&w, 1);
    return 0;
}
