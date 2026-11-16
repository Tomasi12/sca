/* Cross-file sample (see README.md in this folder): types and functions shared by the files. */
#ifndef CALIB_H
#define CALIB_H

#include <stddef.h>

typedef unsigned char  u8;
typedef unsigned short u16;
typedef unsigned int   u32;
typedef signed short   s16;
typedef signed int     s32;

typedef struct {
    u16 ticks;
    u16 scale;
} Calib;

typedef struct {
    u32 id;
    u8  dlc;
    u8  data[8];
} Frame;

typedef struct {
    volatile u32 LEN;
    volatile u8  DATA[8];
} Mailbox;

typedef struct {
    s32 gain;
    s32 integral;
    s32 limited;
} Integrator;

typedef struct {
    s32 sum;
    s16 buf[4];
    u8  idx;
} Window;

extern Mailbox mbox;

const Calib *calib_load(void); /* NULL when the stored block is bad */
const Calib *calib_slot(u32 i); /* NULL for a bad index */
void         calib_store(const Calib *c);

void speed_init(const Calib *c);
u32  speed_of(u32 delta);
u32  speed_slot_scale(u32 i);

void frame_read(Frame *out);
void frame_read_checked(Frame *out);
void frame_dispatch(const Frame *f);
void frame_dispatch_checked(const Frame *f);
void put_u16(u8 *data, u8 offset, u16 value);
s16  table_lookup(const s16 *xs, const s16 *ys, u32 n, s16 x);
u8   checksum(const u8 *data, u32 len);

s32  parse_digits(const char *s);
s32  parse_digits_checked(const char *s);
s32  integrate(Integrator *it, s32 error);
s32  integrate_limited(Integrator *it, s32 error);
s32  window_add(Window *w, s16 x);

#endif /* CALIB_H */
