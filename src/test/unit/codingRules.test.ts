import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { checkGoto, checkSwitchDefault, GOTO_RULE, SWITCH_DEFAULT_RULE } from "../../core/checks/codingRules";
import { SourceParser } from "../../core/parser/parser";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const SAMPLE = path.join(__dirname, "..", "..", "..", "tests", "samples", "coding_rules.c");

function markedLines(text: string, category: string): number[] {
  const re = new RegExp(`/\\*\\s*RULE\\(${category}\\):`);
  return text
    .split(/\r?\n/)
    .map((l, i) => (re.test(l) ? i + 1 : 0))
    .filter((n) => n > 0);
}

describe("checks/coding rules (unit)", () => {
  let parser: SourceParser;
  let analyzer: Analyzer;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
    analyzer = new Analyzer([checkSwitchDefault, checkGoto], parser);
  });

  after(() => parser.dispose());

  it("matches the RULE markers in tests/samples/coding_rules.c", () => {
    const text = fs.readFileSync(SAMPLE, "utf8");
    const findings = analyzer.analyze(SAMPLE, text);
    const lines = (rule: string) => findings.filter((f) => f.ruleId === rule).map((f) => f.range.start.line);
    assert.deepStrictEqual(lines(SWITCH_DEFAULT_RULE), markedLines(text, "switch_default"));
    assert.deepStrictEqual(lines(GOTO_RULE), markedLines(text, "goto"));
    assert.strictEqual(findings.length, 3);
  });

  it("reports rule violations as definite warnings", () => {
    const [f] = analyzer.analyze("t.c", "void f(int a) { switch (a) { case 1: break; } }\n");
    assert.strictEqual(f.ruleId, SWITCH_DEFAULT_RULE);
    assert.strictEqual(f.certainty, "definite");
    assert.strictEqual(f.severity, "warning");
    assert.deepStrictEqual(f.range, { start: { line: 1, column: 17 }, end: { line: 1, column: 27 } });
  });

  it("names the goto label", () => {
    const [f] = analyzer.analyze("t.c", "void f(void) { goto out; out: ; }\n");
    assert.match(f.message, /goto out/);
  });

  it("also works on C++", () => {
    const code = "void f(int a) {\n  switch (a) { case 1: break; }\n  goto end;\nend:;\n}\n";
    const rules = analyzer.analyze("t.cpp", code).map((f) => `${f.ruleId}@${f.range.start.line}`);
    assert.deepStrictEqual(rules, [`${SWITCH_DEFAULT_RULE}@2`, `${GOTO_RULE}@3`]);
  });
});
