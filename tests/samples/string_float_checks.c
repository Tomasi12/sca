/* String, format and floating-point checks. Markers: DEFECT(category) = a finding of that category's rule is
 * expected on the line; SAFE(category) = no finding of that rule allowed. Lines without a marker must not get
 * any finding. Categories map to rules in src/core/checks/index.ts (CATEGORY_RULES). */

#include <math.h>
#include <stdio.h>
#include <string.h>

typedef unsigned char u8;
typedef short s16;
typedef unsigned int u32;

#define NAME_LEN 8U
#define LINE_LEN 32U
#define SCALE    100.0f
#define TEMP_MAX 120.0f

static char g_name[NAME_LEN];
static char g_line[LINE_LEN];
static char g_rows[4][LINE_LEN];

/* ---- string-overflow -------------------------------------------------------------------------- */

void name_from_input(const char *s)
{
    (void)strcpy(g_name, s); /* DEFECT(string_overflow): the input length is not checked */
}

void name_from_literal(void)
{
    (void)strcpy(g_name, "pump"); /* SAFE(string_overflow): 5 bytes fit in 8 */
}

void name_too_long(void)
{
    (void)strcpy(g_name, "compressor"); /* DEFECT(string_overflow): 11 bytes do not fit in 8 */
}

void line_from_parts(const char *a, u32 n)
{
    (void)sprintf(g_line, "%s=%u", a, n); /* DEFECT(string_overflow): '%s' has no limit */
}

void line_from_number(u32 n)
{
    (void)sprintf(g_line, "n=%u", n); /* SAFE(string_overflow): at most 13 bytes */
}

void line_bounded(const char *a)
{
    (void)snprintf(g_line, sizeof(g_line), "%s", a); /* SAFE(string_overflow): snprintf stops at the size */
}

void copy_too_much(const char *s)
{
    (void)strncpy(g_name, s, LINE_LEN); /* DEFECT(string_overflow): 32 bytes into 8 */
}

/* ---- missing-terminator ----------------------------------------------------------------------- */

void name_full_copy(const char *s)
{
    (void)strncpy(g_name, s, sizeof(g_name)); /* DEFECT(missing_null_terminator): may fill all 8 bytes */
}

void name_full_copy_terminated(const char *s)
{
    (void)strncpy(g_name, s, sizeof(g_name)); /* SAFE(missing_null_terminator): terminated on the next line */
    g_name[sizeof(g_name) - 1U] = '\0';
}

/* ---- overlapping-copy ------------------------------------------------------------------------- */

void rows_up(void)
{
    (void)memcpy(g_rows[0], g_rows[1], 3U * LINE_LEN); /* DEFECT(overlapping_copy): the rows overlap */
}

void rows_last_to_first(void)
{
    (void)memcpy(g_rows[0], g_rows[3], LINE_LEN); /* SAFE(overlapping_copy): one row, 96 bytes apart */
}

void line_append_self(void)
{
    (void)sprintf(g_line, "%s!", g_line); /* DEFECT(overlapping_copy): g_line is read and written */
}

/* ---- format-mismatch -------------------------------------------------------------------------- */

void print_temp(float t, u32 n)
{
    (void)printf("%d C\n", t);          /* DEFECT(format_string): %d with a float */
    (void)printf("%f C\n", (double)t);  /* SAFE(format_string): %f with a double */
    (void)printf("%u of %u\n", n);      /* DEFECT(format_string): the second argument is missing */
    (void)printf("%s: %u\n", g_name, n); /* SAFE(format_string): string and unsigned */
}

/* ---- uncontrolled-format ---------------------------------------------------------------------- */

void print_text(const char *msg)
{
    (void)printf(msg); /* DEFECT(uncontrolled_format): msg is used as the format */
    (void)printf("%s", msg); /* SAFE(uncontrolled_format): msg is an argument */
}

void log_wrapper(const char *fmt, ...)
{
    (void)printf(fmt); /* SAFE(uncontrolled_format): a printf-style wrapper passes its format on */
}

/* ---- float-overflow --------------------------------------------------------------------------- */

float heat_factor(float temp)
{
    return expf(temp * 0.9f); /* DEFECT(float_overflow): temp is not limited */
}

float heat_factor_safe(float temp)
{
    if (temp > TEMP_MAX) {
        temp = TEMP_MAX;
    }
    return expf(temp * 0.5f); /* SAFE(float_overflow): at most 60 */
}

/* ---- float-invalid ---------------------------------------------------------------------------- */

float current_from_power(float power)
{
    return sqrtf(power / 0.25f); /* DEFECT(float_invalid): power can be negative */
}

float length2(float x, float y)
{
    return sqrtf((x * x) + (y * y)); /* SAFE(float_invalid): a sum of squares */
}

float decibel(float ratio)
{
    return 20.0f * log10f(ratio); /* DEFECT(float_invalid): ratio can be 0 or negative */
}

/* ---- float-conversion ------------------------------------------------------------------------- */

s16 to_raw(float x)
{
    return (s16)(x * SCALE); /* DEFECT(float_conversion): above 327.67 it does not fit */
}

s16 to_raw_safe(float x)
{
    if (x > 300.0f) {
        x = 300.0f;
    } else if (x < -300.0f) {
        x = -300.0f;
    }
    return (s16)(x * SCALE); /* SAFE(float_conversion): at most +-30000 */
}

int to_int(float x)
{
    return (int)x; /* SAFE(float_conversion): any float input is only judged against narrow types */
}
