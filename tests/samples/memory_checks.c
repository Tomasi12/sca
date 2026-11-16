/* Memory lifetime checks. Markers: DEFECT(category) = a finding of that category's rule is expected on the
 * line; SAFE(category) = no finding of that rule allowed. Lines without a marker must not get any finding.
 * Categories map to rules in src/core/checks/index.ts (CATEGORY_RULES). */

#include <stdlib.h>
#include <string.h>

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define BUF_LEN 8U

struct Node {
    u32 value;
    struct Node *next;
};

static struct Node *g_head;
static u8 *g_buf;
static u8 g_pool[32];
static u8 g_line[BUF_LEN];

void keep(void *p);

/* ---- memory-leak ------------------------------------------------------------------------------ */

u32 leak_on_early_return(u32 n)
{
    u32 *v = (u32 *)malloc(n * sizeof(u32));

    if (v == NULL) {
        return 0U; /* SAFE(memory_leak): the allocation failed, nothing to free */
    }
    if (n > 4U) {
        return 1U; /* DEFECT(memory_leak): v is not freed on this path */
    }
    v[0] = n;
    free(v);
    return v == NULL ? 2U : 3U;
}

void leak_at_end(void)
{
    u8 *p = (u8 *)malloc(BUF_LEN);

    if (p != NULL) {
        p[0] = 1U;
    }
} /* DEFECT(memory_leak): p is lost when the function ends */

void kept_in_list(u32 value)
{
    struct Node *n = (struct Node *)malloc(sizeof(*n));

    if (n == NULL) {
        return;
    }
    n->value = value;
    n->next = g_head;
    g_head = n; /* SAFE(memory_leak): the list owns it now */
}

void kept_by_callee(void)
{
    u8 *p = (u8 *)malloc(BUF_LEN);

    keep(p); /* SAFE(memory_leak): keep() may store it */
}

static u8 *make_buffer(void)
{
    u8 *p = (u8 *)malloc(BUF_LEN);

    return p; /* SAFE(memory_leak): returned to the caller */
}

void leak_from_helper(void)
{
    u8 *b = make_buffer();

    if (b == NULL) {
        return;
    }
    b[0] = 0U;
} /* DEFECT(memory_leak): the buffer from make_buffer() is never freed */

/* ---- double-free ------------------------------------------------------------------------------ */

void double_free_maybe(u32 mode)
{
    u8 *p = (u8 *)malloc(BUF_LEN);

    if (mode == 1U) {
        free(p);
    }
    free(p); /* DEFECT(double_free): already freed when mode == 1 */
}

void free_and_reset(void)
{
    free(g_buf);
    g_buf = NULL;
    free(g_buf); /* SAFE(double_free): free(NULL) does nothing */
}

void free_one_branch(u32 mode)
{
    u8 *p = (u8 *)malloc(BUF_LEN);

    if (mode == 1U) {
        free(p); /* SAFE(double_free): the branches free it once */
    } else {
        free(p); /* SAFE(double_free): the branches free it once */
    }
}

void free_static_twice(void)
{
    free(g_buf);
    free(g_buf); /* DEFECT(double_free): g_buf was not reset after the first free */
    g_buf = NULL;
}

/* ---- use-after-free --------------------------------------------------------------------------- */

u32 use_through_copy(void)
{
    struct Node *a = (struct Node *)malloc(sizeof(*a));
    struct Node *b = a;

    if (a == NULL) {
        return 0U;
    }
    a->value = 5U;
    free(a);
    return b->value; /* DEFECT(use_after_free): b points to the same freed node */
}

u32 copy_before_free(void)
{
    struct Node *a = (struct Node *)malloc(sizeof(*a));
    u32 v;

    if (a == NULL) {
        return 0U;
    }
    a->value = 5U;
    v = a->value; /* SAFE(use_after_free): read before free */
    free(a);
    return v;
}

u32 head_after_pop(void)
{
    struct Node *n = g_head;

    if (n == NULL) {
        return 0U;
    }
    g_head = n->next;
    free(n);
    return (g_head != NULL) ? g_head->value : 0U; /* SAFE(use_after_free): g_head is the next node */
}

/* ---- bad-free --------------------------------------------------------------------------------- */

void free_pool(void)
{
    free(g_pool); /* DEFECT(bad_free): a static array */
}

void free_local_address(void)
{
    u32 x = 0U;
    u32 *p = &x;

    *p = 1U;
    free(&x); /* DEFECT(bad_free): the address of a local */
}

void free_moved_copy(void)
{
    u8 *base = (u8 *)malloc(BUF_LEN);
    u8 *cur = base;
    u32 i;

    if (base == NULL) {
        return;
    }
    for (i = 0U; i < BUF_LEN; i++) {
        *cur = (u8)i; /* SAFE(unchecked_alloc): base was tested, cur is the same pointer */
        cur++;
    }
    free(base); /* SAFE(bad_free): the pointer malloc returned */
}

/* ---- dangling-pointer ------------------------------------------------------------------------- */

u8 dangling_inner_array(u32 mode)
{
    const u8 *src = g_line;

    if (mode == 2U) {
        u8 tmp[BUF_LEN] = {0U};
        src = tmp;
    }
    return src[1]; /* DEFECT(dangling_ptr): tmp is gone after its block */
}

u8 outer_array(u32 mode)
{
    u8 tmp[BUF_LEN] = {0U};
    const u8 *src = g_line;

    if (mode == 2U) {
        src = tmp;
    }
    return src[1]; /* SAFE(dangling_ptr): tmp lives until the function returns */
}

/* ---- unchecked-alloc -------------------------------------------------------------------------- */

void unchecked_calloc(u32 n)
{
    u32 *p = (u32 *)calloc(n, sizeof(u32));

    p[0] = 1U; /* DEFECT(unchecked_alloc): calloc can return NULL */
    free(p);
}

void checked_with_not(u32 n)
{
    u32 *p = (u32 *)calloc(n, sizeof(u32));

    if (!p) {
        return;
    }
    p[0] = 1U; /* SAFE(unchecked_alloc): tested with !p */
    free(p);
}

/* ---- alloc-size ------------------------------------------------------------------------------- */

void alloc_size_cases(void)
{
    u32 *a = (u32 *)malloc(10U); /* DEFECT(alloc_size): 10 bytes is not a whole number of u32 */
    u32 *b = (u32 *)malloc(16U); /* SAFE(alloc_size): 16 bytes hold 4 u32 values */
    u8 *c = (u8 *)malloc(10U);   /* SAFE(alloc_size): bytes */

    free(a);
    free(b);
    free(c);
}

/* ---- sizeof-pointer --------------------------------------------------------------------------- */

void copy_line(u8 *dst, const u8 *src)
{
    (void)memcpy(dst, src, sizeof(src)); /* DEFECT(wrong_sizeof): size of the pointer */
}

void clear_line(void)
{
    (void)memset(g_line, 0, sizeof(g_line)); /* SAFE(wrong_sizeof): sizeof of the array itself */
}

void clear_node(struct Node *n)
{
    (void)memset(n, 0, sizeof(*n)); /* SAFE(wrong_sizeof): size of the node */
}

/* ---- pointer-arith ---------------------------------------------------------------------------- */

const u8 *field_at(u32 offset)
{
    return &g_line[2] + offset; /* DEFECT(ptr_arith): offset is not checked */
}

const u8 *line_end(void)
{
    return g_line + BUF_LEN; /* SAFE(ptr_arith): one past the end is allowed */
}

const u8 *field_checked(u32 offset)
{
    if (offset > 6U) {
        offset = 6U;
    }
    return &g_line[2] + offset; /* SAFE(ptr_arith): at most one past the end */
}
