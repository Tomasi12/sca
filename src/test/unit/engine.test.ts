import * as assert from "assert";
import * as path from "path";
import { Node } from "web-tree-sitter";
import { Analyzer } from "../../core/analyzer";
import { cfgToText, FileEngine, functionName } from "../../core/engine";
import { describeFunctionAt } from "../../core/engine/debug";
import { Value } from "../../core/engine/value";
import { arith, convert, exact, join, range, toText, widen } from "../../core/engine/value";
import { ParsedSource, SourceParser } from "../../core/parser/parser";
import { POINTER } from "../../core/engine/types";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const U8 = { kind: "int" as const, lo: 0, hi: 255, unsigned: true, name: "u8" };

describe("core/engine (unit)", () => {
  let parser: SourceParser;
  const open: ParsedSource[] = [];

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
  });

  after(() => {
    open.forEach((p) => p.dispose());
    parser.dispose();
  });

  function engine(code: string, file = "t.c", budget?: { maxVisits: number; maxMillis: number; fileMillis?: number }): FileEngine {
    const parsed = parser.parse(file, code);
    open.push(parsed);
    return new FileEngine(parsed.root, undefined, budget);
  }

  function fnNamed(e: FileEngine, name: string): Node {
    const fn = e.functionNodes().find((f) => functionName(f) === name);
    assert.ok(fn, `function ${name} not found`);
    return fn;
  }

  /** Values of `name` at every read on lines containing `@` (joined), in function `fn`. */
  function readsAt(code: string, fn: string, name: string): Value {
    const e = engine(code);
    const lines = new Set(code.split("\n").flatMap((l, i) => (l.includes("@") ? [i] : [])));
    let v: Value | undefined;
    const fa = e.analyze(fnNamed(e, fn), {
      read: (at, info, value) => {
        if (info.name === name && lines.has(at.startPosition.row)) {
          v = v ? join(v, value) : value;
        }
      },
    });
    assert.ok(fa.outcome?.ok, `not analyzed: ${JSON.stringify(fa.outcome)}`);
    assert.ok(v, `no read of ${name} on a line with @`);
    return v;
  }

  function divisions(code: string, fn: string): Value[] {
    const e = engine(code);
    const out: Value[] = [];
    e.analyze(fnNamed(e, fn), { division: (_op, _d, v) => out.push(v) });
    return out;
  }

  describe("control-flow graph", () => {
    it("models if/else with a true and a false edge", () => {
      const e = engine("int f(int a) { if (a > 1) { a = 2; } else { a = 3; } return a; }\n");
      const text = cfgToText(e.cfgFor(fnNamed(e, "f")));
      assert.match(text, /\[\(a > 1\)\]/);
      assert.match(text, /\[not \(a > 1\)\]/);
    });

    it("peels the first round of a loop and marks the loop head", () => {
      const e = engine("int f(int n) { int s = 0; while (n > 0) { s++; n--; } return s; }\n");
      const cfg = e.cfgFor(fnNamed(e, "f"));
      const text = cfgToText(cfg);
      assert.match(text, /first round/);
      assert.match(text, /loop head/);
      assert.strictEqual(cfg.loopHeads.size, 1);
    });

    it("gives a switch without default an edge for the other values", () => {
      const e = engine("int f(int m) { int d = 0; switch (m) { case 1: d = 2; break; case 2: d = 3; } return d; }\n");
      assert.match(cfgToText(e.cfgFor(fnNamed(e, "f"))), /\(m\) not in \{1, 2\}/);
    });

    it("follows goto to its label, also backwards", () => {
      const code = "int f(int n) { int s = 0;\nagain:\n  if (n > 0) { s += 2; n--; goto again; }\n  return s; }\n";
      const e = engine(code);
      const fa = e.analyze(fnNamed(e, "f"), {});
      assert.ok(fa.outcome?.ok);
      assert.match(cfgToText(fa.cfg), /label again/);
    });

    it("marks functions with unsupported statements and skips them", () => {
      const e = engine("int f(int x) { try { return 1 / x; } catch (...) { return 0; } }\n", "t.cpp");
      const fa = e.analyze(fnNamed(e, "f"), {});
      assert.strictEqual(fa.outcome?.ok, false);
      assert.match(fa.cfg.unsupported ?? "", /try_statement/);
      assert.strictEqual(e.stats.skipped, 1);
    });
  });

  describe("values", () => {
    it("computes ranges for arithmetic", () => {
      const d = arith("/", range(1, 10), range(2, 5));
      assert.deepStrictEqual([d.lo, d.hi], [0, 5]);
      const m = arith("%", range(0, 100), exact(8));
      assert.deepStrictEqual([m.lo, m.hi], [0, 7]);
    });

    it("wraps out-of-range values to the full type range", () => {
      const v = convert(range(250, 260), U8);
      assert.deepStrictEqual([v.lo, v.hi], [0, 255]);
    });

    it("keeps the zero witness through a join and drops it when 0 is out of range", () => {
      const j = join(exact(0, "int", "the constant 0"), exact(5));
      assert.strictEqual(j.zero, "the constant 0");
      assert.strictEqual(arith("+", j, exact(1)).zero, undefined, "x + 1 is 0 only by wrap-around");
      assert.strictEqual(arith("*", j, exact(3)).zero, "the constant 0");
    });

    it("widens growing bounds to the type limits", () => {
      const w = widen(range(0, 1), range(0, 2), U8);
      assert.deepStrictEqual([w.lo, w.hi], [0, 255]);
    });

    it("prints values readably", () => {
      assert.strictEqual(toText(range(1, 4)), "[1, 4]");
      assert.strictEqual(toText({ ...exact(0, "ptr", "NULL") }), "null (0: NULL)");
      assert.strictEqual(toText(convert(exact(1), POINTER)), "maybe null");
    });
  });

  describe("interpreter", () => {
    it("narrows a value inside a branch", () => {
      const v = readsAt("void use(int);\nint f(int n) {\n  if (n > 0) {\n    use(n); /* @ */\n  }\n  return 0;\n}\n", "f", "n");
      assert.deepStrictEqual([v.lo, v.hi], [1, 2147483647]);
      assert.strictEqual(v.zero, undefined);
    });

    it("knows the exact value after ==", () => {
      const v = readsAt("void use(int);\nint f(int n) {\n  if (n == 3) {\n    use(n); /* @ */\n  }\n  return 0;\n}\n", "f", "n");
      assert.deepStrictEqual([v.lo, v.hi], [3, 3]);
    });

    it("converges on long loops (widening) and narrows at the exit", () => {
      const code = "void use(int);\nint f(void) {\n  int i;\n  for (i = 0; i < 1000000; i++) { }\n  use(i); /* @ */\n  return 0;\n}\n";
      const v = readsAt(code, "f", "i");
      assert.strictEqual(v.lo, 1000000);
      const e = engine(code);
      const fa = e.analyze(fnNamed(e, "f"), {});
      assert.ok(fa.outcome?.ok && fa.outcome.visits < 100, `took ${fa.outcome?.visits} visits`);
    });

    it("tracks pointers as null, not null or maybe null", () => {
      const code = [
        "void use(int *);",
        "int f(int c) {",
        "  int x = 0;",
        "  int *p = 0;",
        "  int *q = (int *)0;",
        "  if (c) { q = &x; }",
        "  use(q); /* @ */",
        "  return 0;",
        "}",
        "",
      ].join("\n");
      const maybe = readsAt(code, "f", "q");
      assert.strictEqual(toText(maybe).startsWith("maybe null"), true, toText(maybe));
      assert.ok(maybe.zero, "the null comes from a constant");
      const guarded = readsAt("void use(int *);\nint f(int *p) {\n  if (p != 0) {\n    use(p); /* @ */\n  }\n  return 0;\n}\n", "f", "p");
      assert.strictEqual(toText(guarded), "not null");
      const used = readsAt("void use(int *);\nint f(int *p) {\n  *p = 1;\n  use(p); /* @ */\n  return 0;\n}\n", "f", "p");
      assert.strictEqual(toText(used), "not null", "a dereferenced pointer was not null");
    });

    it("tracks whether a variable is set on all paths", () => {
      const code = "void use(int);\nint f(int c) {\n  int x;\n  int y;\n  int z = 0;\n  if (c) { x = 1; }\n  use(x); use(y); use(z); /* @ */\n  return 0;\n}\n";
      assert.strictEqual(readsAt(code, "f", "x").init, "maybe");
      assert.strictEqual(readsAt(code, "f", "y").init, "no");
      assert.strictEqual(readsAt(code, "f", "z").init, "yes");
    });

    it("treats globals, fields and other files' functions as unknown (no reason for 0)", () => {
      const code = "struct S { int n; };\nextern int g;\nint h(void);\nint f(int x, struct S *s) { return x / g + x / s->n + x / h(); }\n";
      const vs = divisions(code, "f");
      assert.strictEqual(vs.length, 3);
      vs.forEach((v) => assert.strictEqual(v.zero, undefined));
    });

    it("knows static objects from the stores in the file", () => {
      const code = "static int d;\nstatic int k;\nvoid set(int v) { d = v; }\nvoid init(void) { k = 4; }\nint q(int x) { return x / d + x / k; }\n";
      const [vd, vk] = divisions(code, "q");
      assert.match(vd.zero ?? "", /set\(\) stores its parameter 'v' unchecked/);
      assert.strictEqual(vk.zero, undefined, "only non-zero stores; zero-initialization alone is not a reason");
    });

    it("uses return values of functions in the same file, but not of recursive ones", () => {
      const code = "static int z(void) { return 0; }\nstatic int r(int n) { return n > 1 ? r(n - 1) : n; }\nint q(int x) { return x / z() + x / r(x); }\n";
      const [vz, vr] = divisions(code, "q");
      assert.deepStrictEqual([vz.lo, vz.hi], [0, 0]);
      assert.match(vz.zero ?? "", /z\(\) can return 0/);
      assert.strictEqual(vr.zero, undefined);
    });

    it("reads `(type)(x)` as a cast even when tree-sitter sees a call", () => {
      const v = readsAt("void use(unsigned);\nint f(unsigned v) {\n  unsigned w = (u16)(v);\n  use(w); /* @ */\n  return 0;\n}\n", "f", "w");
      assert.deepStrictEqual([v.lo, v.hi], [0, 65535]);
    });

    it("skips a function quietly when it exceeds the time budget", () => {
      const e = engine("int f(int n) { int s = 0; while (n > 0) { s += 1 / n; n--; } return s; }\n", "t.c", { maxVisits: 3, maxMillis: 1000 });
      const seen: Value[] = [];
      const fa = e.analyze(fnNamed(e, "f"), { division: (_o, _d, v) => seen.push(v) });
      assert.strictEqual(fa.outcome?.ok, false);
      assert.strictEqual(fa.outcome && !fa.outcome.ok ? fa.outcome.reason : "", "time budget exceeded");
      assert.deepStrictEqual(seen, [], "no events from a skipped function");
      assert.strictEqual(e.stats.reasons.get("time budget exceeded"), 1);
    });
  });

  it("stops analyzing a file once the file budget is used up", () => {
    const e = engine("int f(int n) { return 1 / n; }\nint g(int n) { return 1 / n; }\n", "t.c", { maxVisits: 4000, maxMillis: 60, fileMillis: -1 });
    const fa = e.analyze(fnNamed(e, "g"), {});
    assert.strictEqual(fa.outcome && !fa.outcome.ok ? fa.outcome.reason : "", "file time budget exceeded");
  });

  describe("show CFG", () => {
    it("describes the function at a line with its values", () => {
      const code = "int f(int n)\n{\n    int d = 0;\n    if (n > 2) {\n        d = n;\n    }\n    return 10 / d;\n}\n";
      const parsed = parser.parse("t.c", code);
      open.push(parsed);
      const text = describeFunctionAt({ file: "t.c", text: code, parsed }, 5) ?? "";
      assert.match(text, /^CFG of f\(\)/);
      assert.match(text, /d = 0 \(0: the constant 0\)/);
      assert.match(text, /Tracked: n: s32 \(parameter\), d: s32/);
      assert.strictEqual(describeFunctionAt({ file: "t.c", text: "int x;\n", parsed: parser.parse("t.c", "int x;\n") }, 1), undefined);
    });

    it("is available through the analyzer", () => {
      const a = new Analyzer([], parser);
      const text = a.describeFunction("t.c", "int g(int a) { return a; }\n", 1);
      assert.match(text ?? "", /CFG of g\(\)/);
    });
  });
});
