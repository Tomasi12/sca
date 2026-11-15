/* Coding rules, batch 2: control flow, and recursion.
 * Markers: RULE(rule-id) = this rule must be reported on the line; SAFE(rule-id) = it must not be. */

int braces(int x)
{
    if (x > 10) /* RULE(sca-own:missing-braces) */
        x = 10;
    return x;
}

int braces_else(int x)
{
    if (x > 10) {
        x = 10;
    } else /* RULE(sca-own:missing-braces) */
        x = 0;
    return x;
}

int braces_else_if(int x)
{
    int r;
    if (x > 10) {
        r = 2;
    } else if (x > 5) { /* SAFE(sca-own:missing-braces): else if is fine */
        r = 1;
    } else {
        r = 0;
    }
    return r;
}

void loop_no_braces(int *a, int n)
{
    int i;
    for (i = 0; i < n; i++) /* RULE(sca-own:missing-braces) */
        a[i] = 0;
}

int stray(int x)
{
    if (x > 10); /* RULE(sca-own:empty-body) SAFE(sca-own:missing-braces): reported as empty body only */
    {
        x = 10;
    }
    return x;
}

void wait_ok(volatile int *ready)
{
    while (*ready == 0) { /* SAFE(sca-own:empty-body): braces with a comment */
        /* wait */
    }
}

int chain(int x)
{
    int r = 0;
    if (x > 10) {
        r = 2;
    } else if (x > 5) { /* RULE(sca-own:else-if-without-else) */
        r = 1;
    }
    return r;
}

int plain_if(int x)
{
    int r = 0;
    if (x > 10) { /* SAFE(sca-own:else-if-without-else): a single if needs no else */
        r = 1;
    }
    return r;
}

float float_loop(void)
{
    float s = 0.0f;
    float x;
    for (x = 0.0f; x < 1.0f; x += 0.1f) { /* RULE(sca-own:loop-float-counter) */
        s += x;
    }
    return s;
}

int int_loop(void)
{
    int s = 0;
    int i;
    for (i = 0; i < 10; i++) { /* SAFE(sca-own:loop-float-counter) */
        s += i;
    }
    return s;
}

int counter_mod(const int *v, int n)
{
    int i;
    int s = 0;
    for (i = 0; i < n; i++) {
        if (v[i] == 0) {
            i++; /* RULE(sca-own:loop-counter-modified) */
        }
        s += v[i]; /* SAFE(sca-own:loop-counter-modified): only read */
    }
    return s;
}

int one_case(int m)
{
    switch (m) { /* RULE(sca-own:switch-too-few-cases) */
    default:
        return 0;
    }
}

int two_cases(int m)
{
    switch (m) { /* SAFE(sca-own:switch-too-few-cases) SAFE(sca-own:switch-on-boolean) */
    case 1:
        return 1;
    default:
        return 0;
    }
}

int bool_switch(int x)
{
    switch (x > 0) { /* RULE(sca-own:switch-on-boolean) */
    case 1:
        return 1;
    default:
        return 0;
    }
}

static unsigned int gcd(unsigned int a, unsigned int b)
{
    if (b == 0U) {
        return a;
    }
    return gcd(b, a % b); /* RULE(sca-own:recursion) */
}

static int is_odd(unsigned int n);

static int is_even(unsigned int n)
{
    return (n == 0U) ? 1 : is_odd(n - 1U); /* RULE(sca-own:recursion): indirect */
}

static int is_odd(unsigned int n)
{
    return (n == 0U) ? 0 : is_even(n - 1U); /* RULE(sca-own:recursion): indirect */
}

int calls_gcd(void)
{
    return (int)gcd(12U, 8U) + is_even(4U); /* SAFE(sca-own:recursion): not part of a cycle */
}
