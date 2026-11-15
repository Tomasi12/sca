/* Metrics (his-metrics): limits are the defaults (cyclomatic 10, nesting 4, parameters 5, returns 1, calls 7).
 * Markers: RULE(rule-id) = this rule must be reported on the line; SAFE(rule-id) = it must not be.
 * The comments here also keep the file above the comment-density limit. */

int f1(int x);
int f2(int x);
int f3(int x);
int f4(int x);
int f5(int x);
int f6(int x);
int f7(int x);
int f8(int x);

/* Eleven decisions: complexity 12. */
int classify(int a, int b) /* RULE(his-metrics:cyclomatic) SAFE(his-metrics:returns) */
{
    int r = 0;
    if (a > 0) {
        r++;
    }
    if (b > 0) {
        r++;
    }
    if ((a > 10) && (b > 10)) {
        r++;
    }
    if ((a < -10) || (b < -10)) {
        r--;
    }
    while (r > 5) {
        r--;
    }
    r = (r > 2) ? 2 : r;
    switch (a) {
    case 1:
        r = 1;
        break;
    case 2:
        r = 2;
        break;
    default:
        break;
    }
    return r;
}

/* Five levels of nested control statements. */
int deep(int a) /* RULE(his-metrics:nesting) */
{
    int r = 0;
    if (a > 0) {
        if (a > 1) {
            if (a > 2) {
                if (a > 3) {
                    if (a > 4) {
                        r = 1;
                    }
                }
            }
        }
    }
    return r;
}

/* else if chains do not nest deeper. */
int flat(int a) /* SAFE(his-metrics:nesting) */
{
    int r;
    if (a == 1) {
        r = 1;
    } else if (a == 2) {
        r = 2;
    } else if (a == 3) {
        r = 3;
    } else if (a == 4) {
        r = 4;
    } else if (a == 5) {
        r = 5;
    } else {
        r = 0;
    }
    return r;
}

int many(int a, int b, int c, int d, int e, int f) /* RULE(his-metrics:parameters) */
{
    return a + b + c + d + e + f;
}

int exits(int a) /* RULE(his-metrics:returns) */
{
    if (a > 0) {
        return 1;
    }
    return 0;
}

void no_return(int *a) /* SAFE(his-metrics:returns): running off the end is the one exit */
{
    *a = 0;
}

int fan_out(int x) /* RULE(his-metrics:calls) */
{
    return f1(x) + f2(x) + f3(x) + f4(x) + f5(x) + f6(x) + f7(x) + f8(x);
}

int fan_ok(int x) /* SAFE(his-metrics:calls): the same function called twice counts once */
{
    return f1(x) + f1(x + 1);
}
