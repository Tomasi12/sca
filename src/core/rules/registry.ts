// The rule registry: every rule SCA can report, with a description in our own words, the reason it
// exists, how to fix a finding and a short bad / good example. Hover help, "SCA: Explain Rule", the
// generated catalog (catalog/rules.json) and the rule reference (docs/rules.md) all come from here.
//
// The examples are tested: the bad one must produce the rule's finding, the good one must not
// (src/test/unit/rules.test.ts). Pure data, no imports from the checks, so anything can use it.

export type RuleKind = "run-time" | "coding-rule" | "metric";

export interface RuleInfo {
  /** `<ruleSet>:<id>` */
  readonly id: string;
  readonly title: string;
  readonly kind: RuleKind;
  /** Group in the rule reference, e.g. "Expressions". */
  readonly group: string;
  /** One sentence: what the rule finds. */
  readonly summary: string;
  /** Why it matters. */
  readonly rationale: string;
  /** What to do about a finding. */
  readonly fix: string;
  /** Code that breaks the rule (C). Metrics have no examples. */
  readonly bad?: string;
  /** The same code, fixed. */
  readonly good?: string;
  /** Off-by-default rules must be turned on in `.sca.json` "rules". */
  readonly enabledByDefault: boolean;
  /** For metrics: the default limit. */
  readonly limit?: number;
}

type Def = Omit<RuleInfo, "enabledByDefault" | "kind" | "group"> & { enabledByDefault?: boolean };

const group = (kind: RuleKind, name: string, defs: Def[]): RuleInfo[] =>
  defs.map((d) => ({ ...d, kind, group: name, enabledByDefault: d.enabledByDefault ?? true }));

export const RULES: readonly RuleInfo[] = [
  // ---------------------------------------------------------------------------------------------- run-time
  ...group("run-time", "Run-time errors", [
    {
      id: "runtime-bugfinder:div-zero",
      title: "Division by zero",
      summary: "A division or remainder whose divisor can be 0.",
      rationale: "Dividing an integer by 0 is undefined behavior: most targets trap, some return garbage.",
      fix: "Check the divisor before dividing, or make sure every caller passes a non-zero value.",
      bad: "int ratio(int a, int b)\n{\n    return a / b;\n}",
      good: "int ratio(int a, int b)\n{\n    if (b == 0) {\n        return 0;\n    }\n    return a / b;\n}",
    },
    {
      id: "runtime-bugfinder:null-deref",
      title: "Null pointer dereference",
      summary: "A pointer that can be NULL is dereferenced (*p, p->f, p[i]).",
      rationale: "Reading or writing through NULL is undefined behavior; on a microcontroller it may silently touch address 0.",
      fix: "Test the pointer before use, or guarantee it can never be NULL at this point.",
      bad: "int first(void)\n{\n    int *p = 0;\n    return *p;\n}",
      good: "int first(const int *p)\n{\n    if (p == 0) {\n        return 0;\n    }\n    return *p;\n}",
    },
    {
      id: "runtime-bugfinder:uninit-read",
      title: "Read of an uninitialized variable",
      summary: "A local variable is read before it is set on some path.",
      rationale: "An uninitialized local holds whatever was on the stack, so the result changes from run to run.",
      fix: "Initialize the variable at its declaration, or set it on every path before it is read.",
      bad: "int pick(int c)\n{\n    int x;\n    if (c > 0) {\n        x = 1;\n    }\n    return x;\n}",
      good: "int pick(int c)\n{\n    int x = 0;\n    if (c > 0) {\n        x = 1;\n    }\n    return x;\n}",
    },
    {
      id: "runtime-bugfinder:out-of-bounds",
      title: "Array index out of bounds",
      summary: "An array is indexed outside its size, or memcpy / memset / memmove writes past its end.",
      rationale: "Accessing past the end of an array corrupts neighboring data or reads garbage; it is undefined behavior.",
      fix: "Check the index against the array size before the access.",
      bad: "int last(void)\n{\n    int a[4] = {0};\n    return a[4];\n}",
      good: "int last(void)\n{\n    int a[4] = {0};\n    return a[3];\n}",
    },
    {
      id: "runtime-bugfinder:overflow",
      title: "Signed integer overflow",
      summary: "Signed arithmetic gives a result outside its type, or a cast to a narrower signed type does not fit.",
      rationale: "Signed overflow is undefined behavior; compilers may optimize on the assumption that it never happens.",
      fix: "Check the operands before the operation, or compute in a wider type and range-check the result.",
      bad: "int next(void)\n{\n    int x = 2147483647;\n    return x + 1;\n}",
      good: "int next(void)\n{\n    int x = 2147483646;\n    return x + 1;\n}",
    },
    {
      id: "runtime-bugfinder:uint-wrap",
      title: "Unsigned wrap-around",
      summary: "An unsigned counter is stepped past 0 or past its maximum and wraps around.",
      rationale: "Unsigned arithmetic wraps silently; a counter that goes below 0 becomes a huge number.",
      fix: "Test the value before stepping it.",
      bad: "unsigned int down(void)\n{\n    unsigned int x = 0U;\n    x--;\n    return x;\n}",
      good: "unsigned int down(unsigned int x)\n{\n    if (x > 0U) {\n        x--;\n    }\n    return x;\n}",
    },
    {
      id: "runtime-bugfinder:invalid-shift",
      title: "Invalid shift amount",
      summary: "A shift by a negative amount, or by the bit width of the type or more.",
      rationale: "Such shifts are undefined behavior; different CPUs give different results.",
      fix: "Keep the shift amount between 0 and the bit width minus one.",
      bad: "unsigned int top(unsigned int x)\n{\n    return x << 32;\n}",
      good: "unsigned int top(unsigned int x)\n{\n    return x << 31;\n}",
    },
    {
      id: "runtime-bugfinder:conversion",
      title: "Negative value converted to unsigned",
      summary: "A value that can be negative is cast to an unsigned type.",
      rationale: "The cast turns -1 into the largest unsigned value, which then passes range checks it should fail.",
      fix: "Check that the value is not negative before the cast.",
      bad: "unsigned int as_count(int x)\n{\n    return (unsigned int)x;\n}",
      good: "unsigned int as_count(int x)\n{\n    if (x < 0) {\n        return 0U;\n    }\n    return (unsigned int)x;\n}",
    },
    {
      id: "runtime-bugfinder:dead-code",
      title: "Dead code",
      summary: "A branch that is never taken, or code that can never be reached.",
      rationale: "Dead code is untested by definition and often shows that a condition is not what the author meant.",
      fix: "Fix the condition, or remove the code that cannot run.",
      bad: "int sign(void)\n{\n    int x = 0;\n    if (x > 0) {\n        return 1;\n    }\n    return 0;\n}",
      good: "int sign(int x)\n{\n    if (x > 0) {\n        return 1;\n    }\n    return 0;\n}",
    },
    {
      id: "runtime-bugfinder:endless-loop",
      title: "Endless loop",
      summary: "A loop whose condition is always true, or a wait loop with no way out.",
      rationale: "A loop that never ends hangs the task; in a wait loop a hardware fault becomes a lock-up.",
      fix: "Add a timeout or an exit condition that can become true.",
      bad: "void count(void)\n{\n    unsigned char i;\n    for (i = 0U; i < 300U; i++) {\n    }\n}",
      good: "void count(void)\n{\n    unsigned int i;\n    for (i = 0U; i < 300U; i++) {\n    }\n}",
    },
    {
      id: "runtime-bugfinder:stack-escape",
      title: "Address of a local returned",
      summary: "A function returns the address of one of its local variables.",
      rationale: "The local's memory is reused after the function returns, so the pointer points to garbage.",
      fix: "Return the value, use a static or caller-provided buffer instead.",
      bad: "int *make(void)\n{\n    int x = 1;\n    return &x;\n}",
      good: "int *make(void)\n{\n    static int x = 1;\n    return &x;\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------ memory lifetime
  ...group("run-time", "Memory lifetime", [
    {
      id: "runtime-bugfinder:memory-leak",
      title: "Memory leak",
      summary: "The function returns (or ends) while it still owns memory it allocated, and no pointer to it is kept.",
      rationale: "The memory can never be freed again. In a long-running program each leak shrinks the heap until an allocation fails.",
      fix: "Free the memory on every path that does not hand it on, or store it where it is freed later.",
      bad: "int sum(int n)\n{\n    int *buf = malloc(n * sizeof(int));\n    if (buf == 0) {\n        return 0;\n    }\n    buf[0] = n;\n    return buf[0];\n}",
      good: "int sum(int n)\n{\n    int *buf = malloc(n * sizeof(int));\n    int r;\n    if (buf == 0) {\n        return 0;\n    }\n    buf[0] = n;\n    r = buf[0];\n    free(buf);\n    return r;\n}",
    },
    {
      id: "runtime-bugfinder:double-free",
      title: "Double free",
      summary: "free() is called on memory that was already freed.",
      rationale: "Freeing twice corrupts the heap's bookkeeping; later allocations can return memory that is still in use.",
      fix: "Set the pointer to NULL right after free() (free(NULL) does nothing), or make sure only one owner frees it.",
      bad: "void twice(void)\n{\n    char *p = malloc(16);\n    free(p);\n    free(p);\n}",
      good: "void twice(void)\n{\n    char *p = malloc(16);\n    free(p);\n    p = 0;\n    free(p);\n}",
    },
    {
      id: "runtime-bugfinder:use-after-free",
      title: "Use after free",
      summary: "Memory is read or written through a pointer after it was freed.",
      rationale: "Freed memory belongs to the allocator again: it may already hold other data, so the read gives garbage and the write corrupts it.",
      fix: "Copy what you still need before free(), and free the memory last.",
      bad: "int last(void)\n{\n    int *p = malloc(sizeof(int));\n    if (p == 0) {\n        return 0;\n    }\n    *p = 1;\n    free(p);\n    return *p;\n}",
      good: "int last(void)\n{\n    int *p = malloc(sizeof(int));\n    int v;\n    if (p == 0) {\n        return 0;\n    }\n    *p = 1;\n    v = *p;\n    free(p);\n    return v;\n}",
    },
    {
      id: "runtime-bugfinder:bad-free",
      title: "Free of memory not from malloc",
      summary: "free() is called on an array, the address of a variable or a string literal.",
      rationale: "free() only accepts pointers that malloc(), calloc() or realloc() returned; anything else corrupts the heap.",
      fix: "Only free what was allocated; static and local objects need no free().",
      bad: "static char pool[32];\n\nvoid release(void)\n{\n    free(pool);\n}",
      good: "static char *pool;\n\nvoid release(void)\n{\n    free(pool);\n    pool = 0;\n}",
    },
    {
      id: "runtime-bugfinder:dangling-pointer",
      title: "Dangling pointer to a local array",
      summary: "A pointer to a local array is used after the block that declares the array has ended.",
      rationale: "The array's memory is reused once its block ends, so the pointer reads whatever is there now.",
      fix: "Declare the array in the outer block, or make it static.",
      bad: "int pick(int mode)\n{\n    const int *t = 0;\n    if (mode != 0) {\n        int local[2] = {1, 2};\n        t = local;\n    }\n    return (t != 0) ? t[1] : 0;\n}",
      good: "int pick(int mode)\n{\n    const int *t = 0;\n    if (mode != 0) {\n        static const int local[2] = {1, 2};\n        t = local;\n    }\n    return (t != 0) ? t[1] : 0;\n}",
    },
    {
      id: "runtime-bugfinder:unchecked-alloc",
      title: "Allocation result not checked",
      summary: "The result of malloc(), calloc() or realloc() is used without testing it against NULL.",
      rationale: "Allocations fail when memory runs out; the NULL result is then dereferenced.",
      fix: "Test the pointer before the first use and handle the failure.",
      bad: "int *make(void)\n{\n    int *p = malloc(sizeof(int));\n    *p = 0;\n    return p;\n}",
      good: "int *make(void)\n{\n    int *p = malloc(sizeof(int));\n    if (p != 0) {\n        *p = 0;\n    }\n    return p;\n}",
    },
    {
      id: "runtime-bugfinder:alloc-size",
      title: "Allocation size not in elements",
      summary: "malloc(n) is stored as a pointer to values wider than a byte, but n is not multiplied by the element size.",
      rationale: "malloc() counts bytes. Allocating n bytes for n 16-bit values gives half the memory, and writing the last values overflows the block.",
      fix: "Multiply the count by sizeof the element: malloc(n * sizeof(*p)).",
      bad: "unsigned short *table(unsigned int n)\n{\n    unsigned short *t = (unsigned short *)malloc(n);\n    return t;\n}",
      good: "unsigned short *table(unsigned int n)\n{\n    unsigned short *t = (unsigned short *)malloc(n * sizeof(unsigned short));\n    return t;\n}",
    },
    {
      id: "runtime-bugfinder:sizeof-pointer",
      title: "sizeof of a pointer used as a buffer size",
      summary: "sizeof(p) of a pointer p is used as the size of the memory p points to (memset, memcpy, malloc, ...).",
      rationale: "sizeof(p) is the size of the pointer itself (4 or 8 bytes), not of the table or buffer, so only part of it is cleared or copied.",
      fix: "Use the object's size: sizeof(*p) times the element count, or sizeof of the array itself.",
      bad: "void clear(int *table)\n{\n    memset(table, 0, sizeof(table));\n}",
      good: "void clear(int *table, unsigned int n)\n{\n    memset(table, 0, n * sizeof(*table));\n}",
    },
    {
      id: "runtime-bugfinder:pointer-arith",
      title: "Pointer arithmetic out of bounds",
      summary: "Adding to (or subtracting from) a pointer into an array gives a pointer before its start or more than one past its end.",
      rationale: "Such a pointer is undefined behavior even before it is dereferenced, and any use of it reads or writes outside the array.",
      fix: "Check the offset against the array length before computing the pointer.",
      bad: "static char line[16];\n\nconst char *after(unsigned int n)\n{\n    return line + n;\n}",
      good: "static char line[16];\n\nconst char *after(unsigned int n)\n{\n    if (n > 16U) {\n        n = 16U;\n    }\n    return line + n;\n}",
    },
  ]),

  // --------------------------------------------------------------------------------------- functions and values
  ...group("run-time", "Functions and values", [
    {
      id: "runtime-bugfinder:missing-return",
      title: "Missing return value",
      summary: "A function that returns a value can reach the end of its body without a return statement.",
      rationale: "The caller then uses whatever happens to be in the return register: undefined behavior that often looks like a random value.",
      fix: "Return a value on every path, for example a safe default after a switch.",
      bad: "int sign(int x)\n{\n    if (x > 0) {\n        return 1;\n    } else if (x < 0) {\n        return -1;\n    }\n}",
      good: "int sign(int x)\n{\n    if (x > 0) {\n        return 1;\n    } else if (x < 0) {\n        return -1;\n    }\n    return 0;\n}",
    },
    {
      id: "runtime-bugfinder:invalid-enum",
      title: "Invalid enum value",
      summary: "An integer is cast to an enum type, but its value can be outside the range of the enum's constants.",
      rationale: "Code that switches on the enum assumes one of its constants; an out-of-range value takes a path nobody planned for.",
      fix: "Check the integer against the enum's range before the cast, and map bad values to a safe constant.",
      bad: "typedef enum { RED = 0, GREEN = 1, BLUE = 2 } Color;\n\nColor color_of(unsigned char raw)\n{\n    return (Color)raw;\n}",
      good: "typedef enum { RED = 0, GREEN = 1, BLUE = 2 } Color;\n\nColor color_of(unsigned char raw)\n{\n    if (raw > 2U) {\n        return RED;\n    }\n    return (Color)raw;\n}",
    },
    {
      id: "runtime-bugfinder:no-return-call",
      title: "Call to a function that never returns",
      summary: "A function of the file can never return (an endless loop, or every path stops the program), but it is not declared _Noreturn.",
      rationale: "Readers and tools expect the code after the call to run. A hidden endless loop also hangs the program in a way that is easy to miss (for example until a watchdog reset).",
      fix: "Declare the function _Noreturn (or with a noreturn attribute) when that is intended; otherwise give it a way out.",
      bad: "static void halt(void)\n{\n    for (;;) {\n    }\n}\n\nvoid check(int ok)\n{\n    if (ok == 0) {\n        halt();\n    }\n}",
      good: "static void halt(void)\n{\n    for (;;) {\n        if (stop_requested() != 0) {\n            return;\n        }\n    }\n}\n\nvoid check(int ok)\n{\n    if (ok == 0) {\n        halt();\n    }\n}",
    },
    {
      id: "runtime-bugfinder:bad-function-pointer",
      title: "Call through a function pointer made from data",
      summary: "A function pointer is made by casting the address of a data object (an array, a variable) and then called.",
      rationale: "Data memory does not hold code for this function; the call jumps into the data, which crashes or runs garbage (and is often blocked by the memory protection).",
      fix: "Point the function pointer to a real function. Calling code at a fixed address (a boot loader) should use that address as a constant, with a justification.",
      bad: "typedef int (*Handler)(int);\nstatic unsigned char code_buf[64];\n\nint run(int x)\n{\n    Handler h = (Handler)(void *)code_buf;\n    return h(x);\n}",
      good: "typedef int (*Handler)(int);\n\nstatic int twice(int x)\n{\n    return 2 * x;\n}\n\nint run(int x)\n{\n    Handler h = twice;\n    return h(x);\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------- strings and formats
  ...group("run-time", "Strings and formats", [
    {
      id: "runtime-bugfinder:string-overflow",
      title: "String buffer overflow",
      summary: "strcpy(), strcat(), sprintf() or strncpy() can write more characters than the destination array holds.",
      rationale: "These functions do not know the size of the destination; a long input writes past its end and corrupts the memory next to it.",
      fix: "Use a bounded call (snprintf() with the buffer size, or strncpy() with size - 1 and a terminating 0) and check the input length.",
      bad: "static char name[8];\n\nvoid set_name(const char *s)\n{\n    (void)strcpy(name, s);\n}",
      good: "static char name[8];\n\nvoid set_name(const char *s)\n{\n    (void)strncpy(name, s, sizeof(name) - 1U);\n    name[sizeof(name) - 1U] = '\\0';\n}",
    },
    {
      id: "runtime-bugfinder:missing-terminator",
      title: "String without terminating 0",
      summary: "strncpy() may fill the whole destination array, so a long source leaves it without the terminating 0.",
      rationale: "Code that reads the array as a string then runs past its end, until some 0 byte happens to follow.",
      fix: "Copy at most size - 1 bytes and set the last byte to 0 right after the copy.",
      bad: "void copy(char *out, const char *s)\n{\n    char tmp[12];\n    (void)strncpy(tmp, s, sizeof(tmp));\n    out[0] = tmp[0];\n}",
      good: "void copy(char *out, const char *s)\n{\n    char tmp[12];\n    (void)strncpy(tmp, s, sizeof(tmp));\n    tmp[sizeof(tmp) - 1U] = '\\0';\n    out[0] = tmp[0];\n}",
    },
    {
      id: "runtime-bugfinder:overlapping-copy",
      title: "Overlapping copy",
      summary: "memcpy(), strcpy() or sprintf() reads from memory it is writing to.",
      rationale: "These functions are undefined when source and destination overlap; optimized versions copy in blocks and can scramble the data.",
      fix: "Use memmove() for overlapping blocks, or copy through a separate buffer.",
      bad: "static char rows[4][16];\n\nvoid shift(void)\n{\n    (void)memcpy(rows[0], rows[1], 3U * 16U);\n}",
      good: "static char rows[4][16];\n\nvoid shift(void)\n{\n    (void)memmove(rows[0], rows[1], 3U * 16U);\n}",
    },
    {
      id: "runtime-bugfinder:format-mismatch",
      title: "printf format does not match the argument",
      summary: "A conversion in a printf-style format does not fit the type of its argument (%d with a float, %f with an int, %s with a number), or the argument is missing.",
      rationale: "printf() reads the arguments by the format: a wrong type reads the wrong bytes, and a missing argument reads garbage from the stack.",
      fix: "Use the conversion for the argument's type, or cast the argument: (int)x for %d, (double)x for %f.",
      bad: "void show(float t)\n{\n    (void)printf(\"%d\\n\", t);\n}",
      good: "void show(float t)\n{\n    (void)printf(\"%d\\n\", (int)t);\n}",
    },
    {
      id: "runtime-bugfinder:uncontrolled-format",
      title: "Format string from a variable",
      summary: "The format of a printf-style call is a variable (a parameter, a buffer) and no other arguments are passed.",
      rationale: "If the text contains '%', printf() reads arguments that do not exist; with %n it even writes to memory. Text from a tester or a bus must never be a format.",
      fix: "Pass the text as an argument: printf(\"%s\", msg).",
      bad: "void say(const char *msg)\n{\n    (void)printf(msg);\n}",
      good: "void say(const char *msg)\n{\n    (void)printf(\"%s\", msg);\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------- floating point
  ...group("run-time", "Floating point", [
    {
      id: "runtime-bugfinder:float-overflow",
      title: "Floating-point overflow",
      summary: "exp() or expf() gets an argument so large that the result is infinite (above about 88 for float, 709 for double).",
      rationale: "An infinite value spreads through the following math (inf - inf is NaN) and usually ends in a wrong output or a failed check much later.",
      fix: "Clamp the argument to a safe range before the call.",
      bad: "float grow(float t)\n{\n    return expf(t * 0.5f);\n}",
      good: "float grow(float t)\n{\n    if (t > 100.0f) {\n        t = 100.0f;\n    }\n    return expf(t * 0.5f);\n}",
    },
    {
      id: "runtime-bugfinder:float-invalid",
      title: "Invalid floating-point operation",
      summary: "sqrt() of a negative value, log() of 0 or a negative value, or acos() / asin() outside [-1, 1].",
      rationale: "The result is NaN (or -infinity), and every comparison with NaN is false, so later range checks let it through.",
      fix: "Check the argument's range first and handle the invalid case.",
      bad: "float root(float p)\n{\n    return sqrtf(p);\n}",
      good: "float root(float p)\n{\n    if (p < 0.0f) {\n        return 0.0f;\n    }\n    return sqrtf(p);\n}",
    },
    {
      id: "runtime-bugfinder:float-conversion",
      title: "Float to integer conversion out of range",
      summary: "A floating-point value is cast to an integer type that cannot hold it.",
      rationale: "Converting a float that does not fit the integer type is undefined behavior: targets saturate, wrap or produce a trap value.",
      fix: "Clamp the value to the integer type's range (and handle NaN) before the cast.",
      bad: "short to_raw(float x)\n{\n    return (short)(x * 100.0f);\n}",
      good: "short to_raw(float x)\n{\n    if (x > 300.0f) {\n        x = 300.0f;\n    } else if (x < -300.0f) {\n        x = -300.0f;\n    }\n    return (short)(x * 100.0f);\n}",
    },
  ]),

  // -------------------------------------------------------------------------------------------- expressions
  ...group("coding-rule", "Expressions", [
    {
      id: "sca-own:float-equality",
      title: "Floating-point equality",
      summary: "Floating-point values are compared with == or !=.",
      rationale: "Rounding makes two computations of the same value differ in the last bits, so exact equality is rarely true when it should be.",
      fix: "Compare the difference with a tolerance: fabsf(a - b) < EPS.",
      bad: "int same(float a, float b)\n{\n    return a == b;\n}",
      good: "int same(float a, float b)\n{\n    float d = a - b;\n    return (d < 0.001f) && (d > -0.001f);\n}",
    },
    {
      id: "sca-own:assignment-in-condition",
      title: "Assignment in a condition",
      summary: "An assignment inside the condition of if, while, for or ?:.",
      rationale: "It is easy to read as a comparison, and = typed instead of == is a classic bug.",
      fix: "Assign first, then test the variable in the condition.",
      bad: "int ready(int *p, int v)\n{\n    if ((*p = v) != 0) {\n        return 1;\n    }\n    return 0;\n}",
      good: "int ready(int *p, int v)\n{\n    *p = v;\n    if (*p != 0) {\n        return 1;\n    }\n    return 0;\n}",
    },
    {
      id: "sca-own:assignment-as-value",
      title: "Assignment used as a value",
      summary: "The result of an assignment is used inside a larger expression (a = b = 0, f(x = 3)).",
      rationale: "Hidden assignments make an expression do two things at once and hide where a variable changes.",
      fix: "Write each assignment as its own statement.",
      bad: "void reset(int *a, int *b)\n{\n    *a = *b = 0;\n}",
      good: "void reset(int *a, int *b)\n{\n    *b = 0;\n    *a = 0;\n}",
    },
    {
      id: "sca-own:side-effect-in-logical",
      title: "Side effect in the right operand of && or ||",
      summary: "++, -- or an assignment in the right operand of && or ||.",
      rationale: "The right operand only runs when the left one does not decide the result, so the side effect happens only sometimes.",
      fix: "Move the side effect out of the condition.",
      bad: "int over(unsigned int len, unsigned int *seen)\n{\n    return (len == 0U) || ((*seen)++ > 10U);\n}",
      good: "int over(unsigned int len, unsigned int *seen)\n{\n    unsigned int before = *seen;\n    *seen = before + 1U;\n    return (len == 0U) || (before > 10U);\n}",
    },
    {
      id: "sca-own:increment-in-expression",
      title: "Increment or decrement inside an expression",
      summary: "++ or -- is part of a larger expression (a[i++] = x).",
      rationale: "Mixing the change of a variable with its use makes the order of effects hard to see and easy to get wrong.",
      fix: "Do the increment or decrement as its own statement.",
      bad: "void put(int *a, int *n, int v)\n{\n    a[(*n)++] = v;\n}",
      good: "void put(int *a, int *n, int v)\n{\n    a[*n] = v;\n    *n = *n + 1;\n}",
      enabledByDefault: false,
    },
    {
      id: "sca-own:comma-operator",
      title: "Comma operator",
      summary: "The comma operator is used outside a for header.",
      rationale: "It packs several actions into one expression and is often a typo for a semicolon or a parameter list.",
      fix: "Write the expressions as separate statements.",
      bad: "void both(int *a, int *b)\n{\n    *a = 1, *b = 2;\n}",
      good: "void both(int *a, int *b)\n{\n    *a = 1;\n    *b = 2;\n}",
    },
    {
      id: "sca-own:operator-precedence",
      title: "Unclear operator precedence",
      summary: "Bitwise operators mixed with comparisons, shifts or arithmetic, or && mixed with ||, without parentheses.",
      rationale: "C's precedence for these operators surprises people: a & b == c tests b == c first.",
      fix: "Add parentheses that show the intended grouping.",
      bad: "int locked(unsigned int flags)\n{\n    return flags & 4U != 0U;\n}",
      good: "int locked(unsigned int flags)\n{\n    return (flags & 4U) != 0U;\n}",
    },
    {
      id: "sca-own:sizeof-side-effect",
      title: "Side effect inside sizeof",
      summary: "sizeof is applied to an expression with ++, --, an assignment or a call.",
      rationale: "sizeof does not evaluate its operand, so the side effect never happens.",
      fix: "Do the side effect separately and apply sizeof to a plain expression or a type.",
      bad: "unsigned long size(int i)\n{\n    return sizeof(i++);\n}",
      good: "unsigned long size(int i)\n{\n    return sizeof(i);\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------- control flow
  ...group("coding-rule", "Control flow", [
    {
      id: "sca-own:switch-default",
      title: "switch without default",
      summary: "A switch statement has no default clause.",
      rationale: "Values that no case expects then pass silently; a default clause handles them on purpose.",
      fix: "Add a default clause that handles (or reports) unexpected values.",
      bad: "int power(int m)\n{\n    int p = 0;\n    switch (m) {\n    case 1:\n        p = 100;\n        break;\n    case 2:\n        p = 10;\n        break;\n    }\n    return p;\n}",
      good: "int power(int m)\n{\n    int p;\n    switch (m) {\n    case 1:\n        p = 100;\n        break;\n    case 2:\n        p = 10;\n        break;\n    default:\n        p = 0;\n        break;\n    }\n    return p;\n}",
    },
    {
      id: "sca-own:goto",
      title: "goto",
      summary: "A goto statement is used.",
      rationale: "Jumps make control flow hard to follow, review and analyze.",
      fix: "Restructure with if, loops or an early return.",
      bad: "int find(const int *v, int n, int x)\n{\n    int i;\n    for (i = 0; i < n; i++) {\n        if (v[i] == x) {\n            goto found;\n        }\n    }\n    return -1;\nfound:\n    return i;\n}",
      good: "int find(const int *v, int n, int x)\n{\n    int i;\n    for (i = 0; i < n; i++) {\n        if (v[i] == x) {\n            return i;\n        }\n    }\n    return -1;\n}",
    },
    {
      id: "sca-own:switch-fallthrough",
      title: "switch fall-through",
      summary: "A case with statements does not end with break, return, continue or goto, so it falls into the next case.",
      rationale: "A forgotten break is a common bug; intended fall-through should be visible.",
      fix: "Add the missing break, or mark intended fall-through with a /* fallthrough */ comment.",
      bad: "int step(int m)\n{\n    int r = 0;\n    switch (m) {\n    case 1:\n        r = 1;\n    case 2:\n        r = r + 2;\n        break;\n    default:\n        break;\n    }\n    return r;\n}",
      good: "int step(int m)\n{\n    int r = 0;\n    switch (m) {\n    case 1:\n        r = 1;\n        break;\n    case 2:\n        r = r + 2;\n        break;\n    default:\n        break;\n    }\n    return r;\n}",
    },
    {
      id: "sca-own:missing-braces",
      title: "Body without braces",
      summary: "The body of if, else, for, while or do is not a { } block.",
      rationale: "A line added later looks like part of the body but is not.",
      fix: "Put the body in braces.",
      bad: "int clamp(int x)\n{\n    if (x > 10)\n        x = 10;\n    return x;\n}",
      good: "int clamp(int x)\n{\n    if (x > 10) {\n        x = 10;\n    }\n    return x;\n}",
    },
    {
      id: "sca-own:empty-body",
      title: "Empty body (stray semicolon)",
      summary: "if, else, for or while has a lone ; as its body.",
      rationale: "Usually a stray semicolon: the code below then runs every time.",
      fix: "Remove the semicolon; if an empty body is intended, write { } with a comment.",
      bad: "int clamp(int x)\n{\n    if (x > 10);\n    {\n        x = 10;\n    }\n    return x;\n}",
      good: "int clamp(int x)\n{\n    if (x > 10) {\n        x = 10;\n    }\n    return x;\n}",
    },
    {
      id: "sca-own:else-if-without-else",
      title: "else if chain without final else",
      summary: "An if ... else if chain ends without an else.",
      rationale: "Like a switch without default: the remaining cases are not handled on purpose.",
      fix: "Add a final else that handles the rest, or says in a comment why nothing is needed.",
      bad: "int level(int x)\n{\n    int r = 0;\n    if (x > 10) {\n        r = 2;\n    } else if (x > 5) {\n        r = 1;\n    }\n    return r;\n}",
      good: "int level(int x)\n{\n    int r;\n    if (x > 10) {\n        r = 2;\n    } else if (x > 5) {\n        r = 1;\n    } else {\n        r = 0;\n    }\n    return r;\n}",
    },
    {
      id: "sca-own:loop-float-counter",
      title: "Floating-point loop counter",
      summary: "A for loop counts with a floating-point variable.",
      rationale: "Rounding makes the number of iterations hard to predict.",
      fix: "Count with an integer and compute the floating-point value from it.",
      bad: "float sum(void)\n{\n    float s = 0.0f;\n    float x;\n    for (x = 0.0f; x < 1.0f; x += 0.1f) {\n        s += x;\n    }\n    return s;\n}",
      good: "float sum(void)\n{\n    float s = 0.0f;\n    int i;\n    for (i = 0; i < 10; i++) {\n        s += (float)i * 0.1f;\n    }\n    return s;\n}",
    },
    {
      id: "sca-own:loop-counter-modified",
      title: "Loop counter changed in the body",
      summary: "The counter of a for loop is also changed inside the loop body.",
      rationale: "Readers expect the for header to say how the loop steps; a second change hides that.",
      fix: "Change the counter only in the header, or use a while loop.",
      bad: "int skip(const int *v, int n)\n{\n    int i;\n    int s = 0;\n    for (i = 0; i < n; i++) {\n        if (v[i] == 0) {\n            i++;\n        }\n        s += v[i];\n    }\n    return s;\n}",
      good: "int skip(const int *v, int n)\n{\n    int i;\n    int s = 0;\n    for (i = 0; i < n; i++) {\n        if (v[i] != 0) {\n            s += v[i];\n        }\n    }\n    return s;\n}",
    },
    {
      id: "sca-own:switch-too-few-cases",
      title: "switch with fewer than two clauses",
      summary: "A switch has no clause or only one.",
      rationale: "An if statement says the same more clearly.",
      fix: "Replace the switch with an if.",
      bad: "int one(int m)\n{\n    switch (m) {\n    default:\n        return 0;\n    }\n}",
      good: "int one(int m)\n{\n    (void)m;\n    return 0;\n}",
    },
    {
      id: "sca-own:switch-on-boolean",
      title: "switch on a boolean",
      summary: "A switch tests a boolean expression (a comparison or a bool variable).",
      rationale: "A boolean has two values; if / else is the natural way to write that.",
      fix: "Use if / else.",
      bad: "int pos(int x)\n{\n    switch (x > 0) {\n    case 1:\n        return 1;\n    default:\n        return 0;\n    }\n}",
      good: "int pos(int x)\n{\n    if (x > 0) {\n        return 1;\n    }\n    return 0;\n}",
    },
    {
      id: "sca-own:invariant-condition",
      title: "Condition that never changes",
      summary: "An if condition is always true or always false (e.g. a u8 compared with 255).",
      rationale: "The test is useless, and usually means the author expected another type or value.",
      fix: "Fix the condition or remove it.",
      bad: "int ok(unsigned char x)\n{\n    int r;\n    if (x <= 255U) {\n        r = 1;\n    } else {\n        r = 0;\n    }\n    return r;\n}",
      good: "int ok(unsigned char x)\n{\n    int r;\n    if (x <= 200U) {\n        r = 1;\n    } else {\n        r = 0;\n    }\n    return r;\n}",
    },
    {
      id: "sca-own:recursion",
      title: "Recursion",
      summary: "A function calls itself, directly or through other functions of the same file.",
      rationale: "Stack use then depends on the input and cannot be bounded when the code is built.",
      fix: "Rewrite the algorithm as a loop.",
      bad: "unsigned int gcd(unsigned int a, unsigned int b)\n{\n    if (b == 0U) {\n        return a;\n    }\n    return gcd(b, a % b);\n}",
      good: "unsigned int gcd(unsigned int a, unsigned int b)\n{\n    while (b != 0U) {\n        unsigned int t = a % b;\n        a = b;\n        b = t;\n    }\n    return a;\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------- types and literals
  ...group("coding-rule", "Types and literals", [
    {
      id: "sca-own:octal-constant",
      title: "Octal constant",
      summary: "An integer constant is written in octal (a leading 0, as in 010).",
      rationale: "010 is eight, not ten; a leading zero is easy to add by accident.",
      fix: "Write the number in decimal or hex.",
      bad: "int trim(void)\n{\n    return 010;\n}",
      good: "int trim(void)\n{\n    return 10;\n}",
    },
    {
      id: "sca-own:lowercase-suffix",
      title: "Lowercase l suffix",
      summary: "A literal suffix uses a lowercase l (10l).",
      rationale: "A lowercase l looks like the digit 1.",
      fix: "Write the suffix as L (10L, 10UL).",
      bad: "long big(void)\n{\n    return 10l;\n}",
      good: "long big(void)\n{\n    return 10L;\n}",
    },
    {
      id: "sca-own:unsigned-suffix",
      title: "Unsigned constant without U",
      summary: "A hex or octal constant above the signed int range has no U suffix.",
      rationale: "Such a constant silently gets an unsigned type, which changes how comparisons and arithmetic behave.",
      fix: "Add a U suffix so the type is visible.",
      bad: "unsigned int mask(void)\n{\n    return 0x80000000;\n}",
      good: "unsigned int mask(void)\n{\n    return 0x80000000U;\n}",
    },
    {
      id: "sca-own:implicit-conversion",
      title: "Implicit narrowing or sign change",
      summary: "An assignment, initialization or return converts a value to a narrower type, or between signed and unsigned, without a cast.",
      rationale: "High bits are cut off or the sign changes without anything in the code showing it.",
      fix: "Check the range, then convert with an explicit cast.",
      bad: "short trim(int value)\n{\n    short t = value;\n    return t;\n}",
      good: "short trim(int value)\n{\n    short t = 0;\n    if ((value >= -100) && (value <= 100)) {\n        t = (short)value;\n    }\n    return t;\n}",
    },
    {
      id: "sca-own:signed-unsigned-compare",
      title: "Signed / unsigned comparison",
      summary: "A comparison where a signed value is converted to unsigned.",
      rationale: "The conversion turns a negative value into a huge one, so -1 < 1U is false.",
      fix: "Check that the signed value is not negative, then cast it.",
      bad: "int fits(int parsed, unsigned int max_len)\n{\n    return parsed <= max_len;\n}",
      good: "int fits(int parsed, unsigned int max_len)\n{\n    return (parsed >= 0) && ((unsigned int)parsed <= max_len);\n}",
    },
    {
      id: "sca-own:signed-bitwise",
      title: "Bitwise operation on a signed value",
      summary: "&, |, ^, ~, << or >> is applied to a signed value.",
      rationale: "Shifting negative values is undefined or compiler-specific, and bit patterns of signed values depend on their representation.",
      fix: "Do bit operations on unsigned types.",
      bad: "short half(short trim)\n{\n    return (short)(trim >> 1);\n}",
      good: "short half(short trim)\n{\n    return (short)(trim / 2);\n}",
    },
    {
      id: "sca-own:vla",
      title: "Variable-length array",
      summary: "An array whose size is only known at run time.",
      rationale: "Stack use then depends on the input and cannot be bounded; a large size overflows the stack without warning.",
      fix: "Use a fixed maximum size and check the length against it.",
      bad: "void copy(const char *s, unsigned int len)\n{\n    char buf[len + 1U];\n    buf[0] = s[0];\n}",
      good: "void copy(const char *s, unsigned int len)\n{\n    char buf[32];\n    if (len < 32U) {\n        buf[0] = s[0];\n    }\n}",
    },
    {
      id: "sca-own:bitfield-type",
      title: "Bit-field with plain int",
      summary: "A bit-field is declared with plain int, char, short or long.",
      rationale: "Whether such a bit-field is signed depends on the compiler.",
      fix: "Declare it with an explicitly unsigned (or signed) type.",
      bad: "struct flags {\n    int ready : 1;\n};",
      good: "struct flags {\n    unsigned int ready : 1;\n};",
    },
    {
      id: "sca-own:int-division-to-float",
      title: "Integer division stored as float",
      summary: "The result of an integer division is stored as a floating-point value.",
      rationale: "The division is done in integers first, so the fraction is lost before the conversion.",
      fix: "Cast an operand to float so the division is done in floating point.",
      bad: "float avg(int sum, int n)\n{\n    float a = sum / n;\n    return a;\n}",
      good: "float avg(int sum, int n)\n{\n    float a = (float)sum / (float)n;\n    return a;\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------- declarations
  ...group("coding-rule", "Declarations", [
    {
      id: "sca-own:unused-variable",
      title: "Unused local variable",
      summary: "A local variable is declared but never used.",
      rationale: "Unused variables are noise, and often a sign that the code does not do what was planned.",
      fix: "Remove the variable, or use it as intended.",
      bad: "int len(const char *s)\n{\n    int checksum = 0;\n    int n = 0;\n    while (s[n] != 0) {\n        n++;\n    }\n    return n;\n}",
      good: "int len(const char *s)\n{\n    int n = 0;\n    while (s[n] != 0) {\n        n++;\n    }\n    return n;\n}",
    },
    {
      id: "sca-own:unused-parameter",
      title: "Unused parameter",
      summary: "A function parameter is never used.",
      rationale: "Either the function ignores input it should use, or the parameter is not needed.",
      fix: "Use the parameter, remove it, or write (void)name; when an interface requires it.",
      bad: "void reset(int reason)\n{\n}",
      good: "void reset(int reason)\n{\n    (void)reason;\n}",
    },
    {
      id: "sca-own:shadowing",
      title: "Name hides an outer name",
      summary: "A local variable has the same name as a parameter, an outer local or a file-level object.",
      rationale: "Readers (and later edits) easily mix up the two variables.",
      fix: "Rename the inner variable.",
      bad: "int sum(int len)\n{\n    int s = 0;\n    {\n        int len = 3;\n        s = len;\n    }\n    return s + len;\n}",
      good: "int sum(int len)\n{\n    int s = 0;\n    {\n        int part = 3;\n        s = part;\n    }\n    return s + len;\n}",
    },
    {
      id: "sca-own:missing-volatile",
      title: "Data shared with an interrupt is not volatile",
      summary: "A file-level object is used by an interrupt handler and by other code, but is not declared volatile.",
      rationale: "Without volatile the compiler may keep the value in a register and never see the interrupt's change.",
      fix: "Declare the object volatile, and protect read-modify-write sequences against the interrupt.",
      bad: "static unsigned int ticks;\n\nvoid timer_isr(void)\n{\n    ticks++;\n}\n\nunsigned int ticks_now(void)\n{\n    return ticks;\n}",
      good: "static volatile unsigned int ticks;\n\nvoid timer_isr(void)\n{\n    ticks++;\n}\n\nunsigned int ticks_now(void)\n{\n    return ticks;\n}",
    },
    {
      id: "sca-own:internal-linkage",
      title: "External name without a header declaration",
      summary: "A file-level function or object is visible to other files, but no included header declares it.",
      rationale: "Either it is only used in this file (then it should be static) or other files declare it themselves, which lets declarations drift apart.",
      fix: "Make it static, or declare it in the module's header and include that header.",
      bad: "int helper(int x)\n{\n    return x + 1;\n}",
      good: "static int helper(int x)\n{\n    return x + 1;\n}",
    },
    {
      id: "sca-own:dynamic-memory",
      title: "Dynamic memory",
      summary: "malloc, calloc, realloc or free (or new / delete) is used.",
      rationale: "Heap use can fail or fragment at run time, so memory use is not known when the code is built.",
      fix: "Allocate statically (fixed-size arrays or pools).",
      bad: "#include <stdlib.h>\n\nint *make(void)\n{\n    return (int *)malloc(sizeof(int));\n}",
      good: "static int storage;\n\nint *make(void)\n{\n    return &storage;\n}",
    },
    {
      id: "sca-own:magic-number",
      title: "Magic number",
      summary: "A numeric constant other than 0 or 1 appears in code without a name.",
      rationale: "A name says what the number means and keeps every use in step when it changes.",
      fix: "Give the number a name with #define, an enum or a const object.",
      bad: "int long_line(unsigned int len)\n{\n    return len > 24U;\n}",
      good: "#define LINE_MAX 24U\n\nint long_line(unsigned int len)\n{\n    return len > LINE_MAX;\n}",
      enabledByDefault: false,
    },
    {
      id: "sca-own:empty-parameter-list",
      title: "Empty parameter list in C",
      summary: "A C function is declared with () instead of (void).",
      rationale: "In C, () means \"unknown arguments\", so calls with wrong arguments are not checked.",
      fix: "Write (void).",
      bad: "int answer()\n{\n    return 42;\n}",
      good: "int answer(void)\n{\n    return 42;\n}",
    },
    {
      id: "sca-own:unchecked-return",
      title: "Return value ignored",
      summary: "The value a function returns (a status, a count, a flag) is thrown away.",
      rationale: "Errors reported through the return value then go unnoticed.",
      fix: "Check the value, or write (void)f(...); when ignoring it is intended.",
      bad: "int nvm_read(int addr);\n\nvoid load(void)\n{\n    nvm_read(4);\n}",
      good: "int nvm_read(int addr);\n\nint load(void)\n{\n    return nvm_read(4);\n}",
    },
  ]),

  // ------------------------------------------------------------------------------------------------ metrics
  ...group("metric", "Metrics", [
    {
      id: "his-metrics:cyclomatic",
      title: "Cyclomatic complexity",
      summary: "The number of decisions in a function plus one (if, loops, case, &&, ||, ?:) is above the limit.",
      rationale: "Each decision adds a path to understand and to test; complex functions hide bugs.",
      fix: "Split the function into smaller ones, or simplify the logic (tables, early returns).",
      limit: 10,
    },
    {
      id: "his-metrics:nesting",
      title: "Nesting depth",
      summary: "Control statements are nested deeper than the limit.",
      rationale: "Deep nesting is hard to read and usually means the function does too much.",
      fix: "Return early, or move inner blocks into functions.",
      limit: 4,
    },
    {
      id: "his-metrics:statements",
      title: "Function length",
      summary: "A function has more statements than the limit.",
      rationale: "Long functions are hard to review and to test completely.",
      fix: "Split the function by task.",
      limit: 50,
    },
    {
      id: "his-metrics:parameters",
      title: "Number of parameters",
      summary: "A function has more parameters than the limit.",
      rationale: "Many parameters are easy to mix up and suggest the function has too many jobs.",
      fix: "Group related parameters in a struct, or split the function.",
      limit: 5,
    },
    {
      id: "his-metrics:returns",
      title: "Number of return points",
      summary: "A function has more return points than the limit.",
      rationale: "Several exits make it harder to see that every path cleans up and sets its results.",
      fix: "Use one exit at the end, or raise the limit if early returns are your style.",
      limit: 1,
    },
    {
      id: "his-metrics:calls",
      title: "Number of called functions",
      summary: "A function calls more different functions than the limit.",
      rationale: "Many dependencies make a function hard to understand and to test in isolation.",
      fix: "Move groups of calls into helper functions.",
      limit: 7,
    },
    {
      id: "his-metrics:comment-density",
      title: "Comment density",
      summary: "A file has fewer comment lines per code line than the limit.",
      rationale: "Code without comments says what it does, but not why.",
      fix: "Add comments that explain intent, units and limits.",
      limit: 0.2,
    },
  ]),
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function ruleInfo(id: string): RuleInfo | undefined {
  return BY_ID.get(id);
}

/** False only for rules that are off unless a project turns them on. */
export function isEnabledByDefault(id: string): boolean {
  return BY_ID.get(id)?.enabledByDefault ?? true;
}

/** Rule IDs of one rule set (`sca-own`, `his-metrics`, ...). */
export function rulesOfSet(set: string): RuleInfo[] {
  return RULES.filter((r) => r.id.startsWith(`${set}:`));
}
