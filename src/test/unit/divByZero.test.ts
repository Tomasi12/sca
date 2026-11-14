import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { checkDivByZero, DIV_ZERO_RULE } from "../../core/checks/divByZero";
import { SourceParser } from "../../core/parser/parser";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const SAMPLES = path.join(__dirname, "..", "..", "..", "tests", "samples");
const MARKER = /\/\*\s*(DEFECT|SAFE)\(div_zero\):/;

/** Lines marked DEFECT(div_zero) in a sample. */
function defectLines(text: string): number[] {
  return text
    .split(/\r?\n/)
    .map((l, i) => (MARKER.exec(l)?.[1] === "DEFECT" ? i + 1 : 0))
    .filter((n) => n > 0);
}

describe("checks/div-zero (unit)", () => {
  let parser: SourceParser;
  let analyzer: Analyzer;
  const run = (code: string, file = "t.c") => analyzer.analyze(file, code);

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
    analyzer = new Analyzer([checkDivByZero], parser);
  });

  after(() => parser.dispose());

  for (const sample of ["div_by_zero.c", "div_by_zero_cases.c", "div_by_zero_engine.c"]) {
    it(`matches the markers in tests/samples/${sample}`, () => {
      const file = path.join(SAMPLES, sample);
      const text = fs.readFileSync(file, "utf8");
      const expected = defectLines(text);
      assert.ok(expected.length > 0, "sample has no DEFECT markers");
      const lines = run(text, file).map((f) => f.range.start.line);
      assert.deepStrictEqual(lines, expected, "finding lines differ from DEFECT markers (missing = missed, extra = false positive)");
    });
  }

  it("reports a parameter divisor as possible, at the divisor", () => {
    const [f] = run("int d(int x, int y)\n{\n    return x / y;\n}\n");
    assert.strictEqual(f.ruleId, DIV_ZERO_RULE);
    assert.strictEqual(f.certainty, "possible");
    assert.strictEqual(f.severity, "warning");
    assert.deepStrictEqual(f.range, { start: { line: 3, column: 16 }, end: { line: 3, column: 17 } });
    assert.match(f.message, /parameter 'y' of d\(\)/);
  });

  it("reports a constant 0 divisor as definite", () => {
    const [f] = run("int d(int x) { return x % (0U); }\n");
    assert.strictEqual(f.certainty, "definite");
    assert.match(f.message, /^Remainder by zero/);
  });

  it("sees through casts and parentheses on the divisor", () => {
    assert.strictEqual(run("int d(int x, int y) { return x / ((long)(y)); }\n").length, 1);
  });

  it("ignores pointer and array parameters, globals and fields", () => {
    const code = "int g; struct S { int n; };\nint d(int x, struct S *s, int *p) { return x / g + x / s->n + x / *p; }\n";
    assert.deepStrictEqual(run(code), []);
  });

  it("skips code tree-sitter could not parse", () => {
    assert.deepStrictEqual(run("int d(int x, int y) { return x / y +; }\n"), []);
  });

  it("does not trust a static function that is also used as a function pointer", () => {
    const code = "static int s(int a, int n) { return a / n; }\nint (*fp)(int, int) = s;\nint u(void) { return s(1, 2); }\n";
    assert.strictEqual(run(code).length, 1);
  });

  it("works on C++ files (condition_clause in if)", () => {
    const code = "int d(int x, int y) {\n  if (y != 0) { return x / y; }\n  return x / y;\n}\n";
    assert.deepStrictEqual(run(code, "t.cpp").map((f) => f.range.start.line), [3]);
  });
});
