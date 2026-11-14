/* Run-time checks on the value engine. Markers: DEFECT(category) / RULE(category) = a finding of that
 * category's rule is expected on the line; SAFE(category) = no finding of that rule allowed. Lines without
 * a marker must not get any finding. Categories map to rules in src/core/checks/index.ts (CATEGORY_RULES). */

#include <string.h>

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef short s16;
typedef int s32;

#define TABLE_LEN 8U
#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef enum { MODE_OFF = 0, MODE_ON, MODE_TEST } Mode;

struct Slot {
    u32 value;
};

static u32 table[TABLE_LEN];
static struct Slot slots[4];
static u8 bytes[16];

/* ---- null-deref ----------------------------------------------------------------------------- */

static struct Slot *slot_for(u32 key)
{
    if (key < 4U) {
        return &slots[key];
    }
    return 0;
}

u32 slot_value(u32 key)
{
    struct Slot *s = slot_for(key);
    return s->value; /* DEFECT(null_deref): slot_for() returns NULL for key >= 4 */
}

u32 slot_value_checked(u32 key)
{
    struct Slot *s = slot_for(key);
    if (s == 0) {
        return 0U;
    }
    return s->value; /* SAFE(null_deref): checked above */
}

/* ---- uninit-read ---------------------------------------------------------------------------- */

s32 pick(s32 c)
{
    s32 r;
    if (c > 0) {
        r = 1;
    } else if (c < 0) {
        r = -1;
    }
    return r; /* DEFECT(uninit_var): r is not set when c == 0 */
}

s32 pick_all(s32 c)
{
    s32 r;
    if (c > 0) {
        r = 1;
    } else {
        r = -1;
    }
    return r; /* SAFE(uninit_var): set on both paths */
}

/* ---- out-of-bounds -------------------------------------------------------------------------- */

u32 table_get(u32 i)
{
    if (i <= TABLE_LEN) {
        return table[i]; /* DEFECT(out_of_bounds): i == TABLE_LEN is one past the end */
    }
    return 0U;
}

u32 table_get_ok(u32 i)
{
    if (i < TABLE_LEN) {
        return table[i]; /* SAFE(out_of_bounds): i < TABLE_LEN */
    }
    return 0U;
}

u32 table_masked(u32 i)
{
    return table[i & (TABLE_LEN - 1U)]; /* SAFE(out_of_bounds): masked to 0..7 */
}

u8 last_byte(const u8 *buf, u32 len)
{
    return buf[len - 1U]; /* DEFECT(out_of_bounds): len == 0 wraps the index to 0xFFFFFFFF */
}

void fill(u32 offset, u32 n)
{
    if (offset >= 16U) {
        return;
    }
    (void)memset(&bytes[offset], 0, n); /* DEFECT(out_of_bounds): offset + n can pass the 16 bytes */
}

void fill_ok(u32 offset, u32 n)
{
    if ((offset + n) > 16U) {
        return;
    }
    (void)memset(&bytes[offset], 0, n); /* SAFE(out_of_bounds): offset + n <= 16 checked above */
}

const char *mode_name(Mode m)
{
    static const char *const names[] = {"off", "on", "test"};
    if ((u32)m < ARRAY_LEN(names)) {
        return names[m]; /* SAFE(out_of_bounds): checked against the array length */
    }
    return "?";
}

/* ---- overflow ------------------------------------------------------------------------------- */

s32 negate(s32 v)
{
    if (v < 0) {
        return -v; /* DEFECT(overflow): -INT_MIN does not fit */
    }
    return v;
}

s16 narrow_diff(s16 a, s16 b)
{
    return (s16)(a - b); /* DEFECT(overflow): a - b can be outside s16 */
}

s32 scaled(u16 raw)
{
    return (s32)raw * 1000; /* SAFE(overflow): 65535 * 1000 fits in s32 */
}

/* ---- uint-wrap ------------------------------------------------------------------------------ */

u8 count_up(u8 c)
{
    c++; /* DEFECT(uint_wrap): 255 + 1 wraps to 0 */
    return c;
}

u8 count_up_sat(u8 c)
{
    if (c < 255U) {
        c++; /* SAFE(uint_wrap): stops at 255 */
    }
    return c;
}

/* ---- invalid-shift -------------------------------------------------------------------------- */

u32 bit(u8 n)
{
    return 1U << n; /* DEFECT(shift): n can be 32 or more */
}

u32 bit_ok(u8 n)
{
    if (n < 32U) {
        return 1U << n; /* SAFE(shift): n < 32 */
    }
    return 0U;
}

/* ---- conversion ----------------------------------------------------------------------------- */

u32 as_unsigned(s32 v)
{
    return (u32)v; /* DEFECT(conversion): a negative v becomes a huge number */
}

u32 as_unsigned_ok(s32 v)
{
    if (v < 0) {
        return 0U;
    }
    return (u32)v; /* SAFE(conversion): v >= 0 here */
}

/* ---- dead-code ------------------------------------------------------------------------------ */

s32 never(Mode m)
{
    if ((m == MODE_ON) && (m == MODE_TEST)) { /* RULE(invariant_condition): m cannot be both */
        return 1; /* DEFECT(dead_code): the condition above is always false */
    }
    return 0;
}

s32 after_return(s32 x)
{
    return x;
    x = x + 1; /* DEFECT(unreachable_code): after return */
}

/* ---- endless-loop --------------------------------------------------------------------------- */

void spin(void)
{
    u8 i;
    for (i = 0U; i < 300U; i++) { /* DEFECT(non_terminating_loop): a u8 is always < 300 */
        table[0]++;
    }
}

extern volatile u32 hw_status;

void wait_ready(void)
{
    while ((hw_status & 1U) == 0U) { /* DEFECT(non_terminating_loop): no timeout */
    }
}

void wait_ready_timeout(void)
{
    u32 t;
    for (t = 0U; ((hw_status & 1U) == 0U) && (t < 1000U); t++) { /* SAFE(non_terminating_loop): bounded by t */
    }
}

/* ---- stack-escape --------------------------------------------------------------------------- */

u32 *local_address(void)
{
    u32 x = 1U;
    return &x; /* DEFECT(stack_escape): x is gone after the return */
}

u32 *static_address(void)
{
    static u32 y = 1U;
    return &y; /* SAFE(stack_escape): static storage */
}

/* ---- coding rules: fall-through, unchecked return ------------------------------------------- */

u32 classify(u32 v)
{
    u32 r = 0U;
    switch (v) {
    case 0U:
        r = 1U;
    case 1U: /* DEFECT(missing_break): case 0 falls through */
        r += 2U;
        break;
    case 2U:
        r = 5U;
        /* fallthrough */
    case 3U: /* SAFE(missing_break): marked as intended */
        r += 1U;
        break;
    default:
        break;
    }
    return r;
}

static s32 store(u32 v)
{
    table[1] = v;
    return 0;
}

void use_store(u32 v)
{
    store(v); /* RULE(unchecked_return): result ignored */
    (void)store(v); /* SAFE(unchecked_return): ignored on purpose */
}
