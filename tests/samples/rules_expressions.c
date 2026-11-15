/* Coding rules, batch 1: expressions.
 * Markers: RULE(rule-id) = this rule must be reported on the line; SAFE(rule-id) = it must not be. */

typedef unsigned int u32;

#define FLAG_LOCKED 4U

static u32 g_seen;

int float_equal(float a, float b)
{
    return a == b; /* RULE(sca-own:float-equality) */
}

int float_less(float a, float b)
{
    return a < b; /* SAFE(sca-own:float-equality): ordering is fine */
}

int int_equal(int a, int b)
{
    return a == b; /* SAFE(sca-own:float-equality): integers */
}

int float_zero(float a)
{
    return a != 0.0f; /* RULE(sca-own:float-equality): a constant does not make it exact */
}

int assign_in_if(int *p, int v)
{
    int r = 0;
    if ((*p = v) != 0) { /* RULE(sca-own:assignment-in-condition) */
        r = 1;
    }
    return r;
}

void assign_in_for(int *a, int n)
{
    int i;
    for (i = 0; i < n; i++) { /* SAFE(sca-own:assignment-in-condition): init and step are not the condition */
        a[i] = 0;
    }
}

int assign_in_while(const int *s)
{
    int c;
    int n = 0;
    while ((c = s[n]) != 0) { /* RULE(sca-own:assignment-in-condition) */
        n++;
    }
    return n + c;
}

void chained(int *a, int *b)
{
    *a = *b = 0; /* RULE(sca-own:assignment-as-value) */
}

void voided(int *a)
{
    (void)(*a = 3); /* SAFE(sca-own:assignment-as-value): the value is thrown away on purpose */
}

int logical(u32 len)
{
    return (len == 0U) || (g_seen++ >= 10U); /* RULE(sca-own:side-effect-in-logical) */
}

int logical_call(u32 len, int (*check)(u32))
{
    return (len > 0U) && check(len); /* SAFE(sca-own:side-effect-in-logical): calls are not counted */
}

void incr(int *a, int *n, int v)
{
    a[(*n)++] = v; /* RULE(sca-own:increment-in-expression) */
}

void incr_ok(int *n)
{
    (*n)++; /* SAFE(sca-own:increment-in-expression): a statement of its own */
}

void comma(int *a, int *b)
{
    *a = 1, *b = 2; /* RULE(sca-own:comma-operator) */
}

void comma_for(int *a, int n)
{
    int i;
    int j;
    for (i = 0, j = n - 1; i < j; i++, j--) { /* SAFE(sca-own:comma-operator): for header SAFE(sca-own:increment-in-expression) */
        a[i] = a[j];
    }
}

int prec(u32 flags)
{
    return flags & FLAG_LOCKED != 0U; /* RULE(sca-own:operator-precedence): != binds tighter than & */
}

int prec_ok(u32 flags)
{
    return (flags & FLAG_LOCKED) != 0U; /* SAFE(sca-own:operator-precedence) */
}

u32 shift_add(u32 x, u32 n)
{
    return x << n + 1U; /* RULE(sca-own:operator-precedence) */
}

int and_or(int a, int b, int c)
{
    return a && b || c; /* RULE(sca-own:operator-precedence) */
}

int and_or_ok(int a, int b, int c)
{
    return (a && b) || c; /* SAFE(sca-own:operator-precedence) */
}

unsigned long size_side(int i)
{
    return sizeof(i++); /* RULE(sca-own:sizeof-side-effect) SAFE(sca-own:increment-in-expression): never evaluated */
}

unsigned long size_ok(int i)
{
    return sizeof(i); /* SAFE(sca-own:sizeof-side-effect) */
}
