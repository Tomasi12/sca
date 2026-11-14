import * as assert from "assert";
import * as path from "path";
import { evaluateCondition, MacroLookup, parseIntLiteral } from "../../core/preprocess/condition";
import { MacroTable, preprocess, PreprocessEnv, scanDirectives } from "../../core/preprocess/preprocessor";

const lookup = (defs: Record<string, number>, undefinedIsZero = true): MacroLookup => ({
  isDefined: (n) => (n in defs ? true : undefinedIsZero ? false : undefined),
  valueOf: (n) => defs[n],
  undefinedIsZero,
});

function env(over: Partial<PreprocessEnv> = {}, files: Record<string, string> = {}): PreprocessEnv {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const byPath = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    defines: new Map(),
    includePaths: [],
    complete: true,
    readFile: (f) => byPath.get(norm(f)),
    ...over,
  };
}

const lines = (text: string) => text.split("\n");

describe("core/preprocess condition (unit)", () => {
  it("parses C integer literals", () => {
    assert.strictEqual(parseIntLiteral("10U"), 10);
    assert.strictEqual(parseIntLiteral("0x1F"), 31);
    assert.strictEqual(parseIntLiteral("017"), 15);
    assert.strictEqual(parseIntLiteral("0b101"), 5);
    assert.strictEqual(parseIntLiteral("1.5"), undefined);
  });

  it("evaluates arithmetic, comparisons, logic and ?:", () => {
    const m = lookup({ A: 3, B: 0 });
    assert.strictEqual(evaluateCondition("A * 2 + 1 == 7", m), 1);
    assert.strictEqual(evaluateCondition("(A > 2) && !B", m), 1);
    assert.strictEqual(evaluateCondition("A ? 10 : 20", m), 10);
    assert.strictEqual(evaluateCondition("1 << 4", m), 16);
    assert.strictEqual(evaluateCondition("defined(A) && defined B", m), 1);
    assert.strictEqual(evaluateCondition("defined(C)", m), 0);
    assert.strictEqual(evaluateCondition("C + 1", m), 1, "an undefined name counts as 0");
  });

  it("returns unknown when the answer depends on unknown macros", () => {
    const m = lookup({ A: 1 }, false);
    assert.strictEqual(evaluateCondition("UNKNOWN", m), undefined);
    assert.strictEqual(evaluateCondition("FOO(1)", m), undefined);
    assert.strictEqual(evaluateCondition("0 && UNKNOWN", m), 0, "short-circuit still decides");
    assert.strictEqual(evaluateCondition("A || UNKNOWN", m), 1);
    assert.strictEqual(evaluateCondition("1 / 0", m), undefined);
    assert.strictEqual(evaluateCondition("(1", m), undefined);
  });
});

describe("core/preprocess preprocessor (unit)", () => {
  it("finds directives with line continuations and skips block comments", () => {
    const d = scanDirectives(lines("#define A \\\n  1\n/* #define NO\n #define NO2 */\n  #  if A\n#endif"));
    assert.deepStrictEqual(d.map((x) => `${x.line}:${x.name}`), ["0:define", "4:if", "5:endif"]);
    assert.strictEqual(d[0].rest, "A    1");
  });

  it("blanks inactive branches and keeps line numbers", () => {
    const src = "#if 0\nint a;\n#else\nint b;\n#endif\nint c;";
    const r = preprocess("t.c", src, env());
    assert.deepStrictEqual(lines(r.text), ["#if 0", "", "#else", "int b;", "#endif", "int c;"]);
    assert.strictEqual(r.inactiveLines, 1);
  });

  it("uses -D defines and #elif chains", () => {
    const src = "#if MODE == 1\none\n#elif MODE == 2\ntwo\n#else\nother\n#endif";
    const r = preprocess("t.c", src, env({ defines: new Map([["MODE", "2"]]) }));
    assert.deepStrictEqual(lines(r.text).filter((l) => !l.startsWith("#") && l !== ""), ["two"]);
  });

  it("keeps both branches when a condition is unknown (no compile database)", () => {
    const src = "#ifdef FEATURE_X\nx();\n#else\ny();\n#endif";
    const r = preprocess("t.c", src, env({ complete: false }));
    assert.ok(r.text.includes("x();") && r.text.includes("y();"));
    assert.strictEqual(r.unknownConditions, 1);
  });

  it("decides include guards even without a compile database", () => {
    const src = "#ifndef T_H\n#define T_H\n#define LIMIT 4U\n#endif";
    const r = preprocess("t.h", src, env({ complete: false }));
    assert.strictEqual(r.macros.valueOf("LIMIT"), 4);
    assert.strictEqual(r.unknownConditions, 0);
  });

  it("reads macros from included headers through the include paths", () => {
    const files = {
      "/proj/include/battery.h": "#ifndef BATTERY_H\n#define BATTERY_H\n#define BATTERY_CELLS (4U)\n#endif",
      "/proj/src/local.h": "#define LOCAL 7",
    };
    const src = '#include "battery.h"\n#include "local.h"\n#include <stdint.h>\n';
    const r = preprocess(path.resolve("/proj/src/a.c"), src, env({ includePaths: [path.resolve("/proj/include")] }, files));
    assert.strictEqual(r.macros.valueOf("BATTERY_CELLS"), 4);
    assert.strictEqual(r.macros.valueOf("LOCAL"), 7);
    assert.strictEqual(r.includes.length, 2);
  });

  it("follows #undef and ignores defines in inactive branches", () => {
    const src = "#define A 1\n#undef A\n#if 0\n#define B 2\n#endif\n";
    const r = preprocess("t.c", src, env());
    assert.strictEqual(r.macros.isDefined("A"), false);
    assert.strictEqual(r.macros.isDefined("B"), false);
  });

  it("does not trust macros defined inside an unknown branch", () => {
    const src = "#ifdef BIG\n#define N 0\n#else\n#define N 8\n#endif\n";
    const r = preprocess("t.c", src, env({ complete: false }));
    assert.strictEqual(r.macros.valueOf("N"), undefined);
  });

  it("evaluates macro values that use other macros, but not function-like macros", () => {
    const t = new MacroTable(true);
    t.define({ name: "A", body: "2", uncertain: false });
    t.define({ name: "B", body: "(A * 3)", uncertain: false });
    t.define({ name: "F", body: "x", params: ["x"], uncertain: false });
    assert.strictEqual(t.valueOf("B"), 6);
    assert.strictEqual(t.valueOf("F"), undefined);
  });

  it("survives include cycles", () => {
    const files = { "/p/a.h": '#include "b.h"\n#define A 1', "/p/b.h": '#include "a.h"\n#define B 2' };
    const r = preprocess(path.resolve("/p/x.c"), '#include "a.h"', env({}, files));
    assert.strictEqual(r.macros.valueOf("A"), 1);
    assert.strictEqual(r.macros.valueOf("B"), 2);
  });
});
