/* Coding rules: switch needs default, no goto.
 * Markers: RULE(category) = a finding is expected on this line; SAFE(category) = no finding allowed. */

typedef enum { MODE_OFF, MODE_ON, MODE_TEST } Mode;

int mode_power(Mode m)
{
    int p = 0;
    switch (m) { /* RULE(switch_default): no default clause */
    case MODE_OFF:
        p = 0;
        break;
    case MODE_ON:
        p = 100;
        break;
    case MODE_TEST:
        p = 10;
        break;
    }
    return p;
}

int mode_power_ok(Mode m)
{
    switch (m) { /* SAFE(switch_default): has default */
    case MODE_ON:
        return 100;
    default:
        return 0;
    }
}

int nested(int a, int b)
{
    switch (a) { /* SAFE(switch_default): default at the end */
    case 1:
        switch (b) { /* RULE(switch_default): the inner switch has none; the outer default does not count */
        case 2:
            return 2;
        }
        break;
    default:
        break;
    }
    return 0;
}

int find_first(const int *v, int n, int x)
{
    int i;
    for (i = 0; i < n; i++) {
        if (v[i] == x) {
            goto found; /* RULE(goto): goto used */
        }
    }
    return -1;
found:
    return i;
}

int no_goto(const int *v, int n, int x)
{
    int i;
    for (i = 0; i < n; i++) {
        if (v[i] == x) {
            return i; /* SAFE(goto): early return instead of goto */
        }
    }
    return -1;
}
