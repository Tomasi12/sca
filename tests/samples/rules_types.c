/* Coding rules, batch 3: types and literals.
 * Markers: RULE(rule-id) = this rule must be reported on the line; SAFE(rule-id) = it must not be. */

typedef signed short s16;
typedef signed int s32;
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define TRIM_MAX 100
#define BUF_LEN 16U

static s16 g_trim;

void octal(void)
{
    g_trim = 010; /* RULE(sca-own:octal-constant) */
}

void zero(void)
{
    g_trim = 0; /* SAFE(sca-own:octal-constant): plain 0 */
}

long suffix(void)
{
    return 10l; /* RULE(sca-own:lowercase-suffix) */
}

unsigned long suffix_ok(void)
{
    return 10UL; /* SAFE(sca-own:lowercase-suffix) */
}

u32 hex_big(void)
{
    return 0x80000000; /* RULE(sca-own:unsigned-suffix) */
}

u32 hex_ok(void)
{
    return 0x7FFFFFFF; /* SAFE(sca-own:unsigned-suffix): fits a signed int */
}

void narrow(s32 value)
{
    g_trim = value; /* RULE(sca-own:implicit-conversion): s32 into s16 */
}

void narrow_cast(s32 value)
{
    g_trim = (s16)value; /* SAFE(sca-own:implicit-conversion): explicit cast */
}

void narrow_const(void)
{
    g_trim = TRIM_MAX; /* SAFE(sca-own:implicit-conversion): a constant that fits */
}

u32 widen(u8 x)
{
    u32 y = x; /* SAFE(sca-own:implicit-conversion): widening */
    return y;
}

u8 sum8(u8 a, u8 b)
{
    u8 s = a + b; /* SAFE(sca-own:implicit-conversion): u8 + u8 stays u8 */
    return s;
}

u32 sign_change(s32 v)
{
    return v; /* RULE(sca-own:implicit-conversion): signed returned as unsigned */
}

s32 from_float(float f)
{
    s32 r = f; /* RULE(sca-own:implicit-conversion): the fraction is cut off */
    return r;
}

int cmp(s32 parsed, u32 max_len)
{
    return parsed <= max_len; /* RULE(sca-own:signed-unsigned-compare) */
}

int cmp_ok(s32 parsed, u32 max_len)
{
    return (parsed >= 0) && ((u32)parsed <= max_len); /* SAFE(sca-own:signed-unsigned-compare) */
}

int cmp_small(s16 a, u16 b)
{
    return a < b; /* SAFE(sca-own:signed-unsigned-compare): both become int first */
}

s16 shift_signed(void)
{
    return (s16)(g_trim >> 1); /* RULE(sca-own:signed-bitwise) */
}

u32 mask_ok(u32 x)
{
    return x & 0xFFU; /* SAFE(sca-own:signed-bitwise) */
}

u32 shift_const(void)
{
    return 1U << 3; /* SAFE(sca-own:signed-bitwise): non-negative constant */
}

s32 invert(s32 x)
{
    return ~x; /* RULE(sca-own:signed-bitwise) */
}

void vla(const char *s, u32 len)
{
    char copy[len + 1U]; /* RULE(sca-own:vla) */
    copy[0] = s[0];
}

void fixed(const char *s)
{
    char buf[BUF_LEN + 1U]; /* SAFE(sca-own:vla): macro constant */
    char two[sizeof(int) * 2U]; /* SAFE(sca-own:vla): sizeof */
    buf[0] = s[0];
    two[0] = s[1];
}

struct flags {
    int ready : 1; /* RULE(sca-own:bitfield-type) */
    unsigned int busy : 1; /* SAFE(sca-own:bitfield-type) */
};

float avg(s32 sum, s32 n)
{
    float a = sum / n; /* RULE(sca-own:int-division-to-float) */
    return a;
}

float avg_ok(s32 sum, s32 n)
{
    float a = (float)sum / (float)n; /* SAFE(sca-own:int-division-to-float) */
    return a;
}
