import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { CATEGORY_RULES } from "../../core/checks";
import { checkGoto, checkSwitchDefault, checkSwitchFallthrough, checkUncheckedReturn } from "../../core/checks/codingRules";
import { checkRuntime } from "../../core/checks/runtime";
import { SourceParser } from "../../core/parser/parser";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const SAMPLES = path.join(__dirname, "..", "..", "..", "tests", "samples");
/** The run-time checks and the first coding rules (the newer rules have their own sample tests). */
const CHECKS = [checkRuntime, checkSwitchDefault, checkGoto, checkSwitchFallthrough, checkUncheckedReturn];
const MARKER = /\/\*\s*(DEFECT|RULE|SAFE)\(([a-z_]+)\):/g;

describe("checks/run-time and coding rules (markers)", () => {
  let parser: SourceParser;
  let analyzer: Analyzer;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
    analyzer = new Analyzer(CHECKS, parser);
  });

  after(() => parser.dispose());

  it("matches every marker in tests/samples/runtime_checks.c", () => {
    const file = path.join(SAMPLES, "runtime_checks.c");
    const text = fs.readFileSync(file, "utf8");
    const findings = analyzer.analyze(file, text);
    const problems: string[] = [];
    const marked = new Set<number>();
    text.split(/\r?\n/).forEach((l, i) => {
      const line = i + 1;
      for (const m of l.matchAll(MARKER)) {
        marked.add(line);
        const rules = CATEGORY_RULES[m[2]];
        assert.ok(rules, `no rule for category ${m[2]}`);
        const hit = findings.some((f) => f.range.start.line === line && rules.includes(f.ruleId));
        if (m[1] === "SAFE" && hit) {
          problems.push(`line ${line}: false positive for ${m[2]}`);
        }
        if (m[1] !== "SAFE" && !hit) {
          problems.push(`line ${line}: missed ${m[2]}`);
        }
      }
    });
    for (const f of findings) {
      if (!marked.has(f.range.start.line)) {
        problems.push(`line ${f.range.start.line}: unmarked ${f.ruleId}: ${f.message}`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  it("names the source of a NULL and the array length in messages", () => {
    const file = path.join(SAMPLES, "runtime_checks.c");
    const findings = analyzer.analyze(file, fs.readFileSync(file, "utf8"));
    const nul = findings.find((f) => f.ruleId === "runtime-bugfinder:null-deref");
    assert.match(nul?.message ?? "", /slot_for\(\) can return NULL/);
    const oob = findings.find((f) => f.ruleId === "runtime-bugfinder:out-of-bounds" && /has 8 elements/.test(f.message));
    assert.ok(oob, "index finding mentions the length");
  });

  it("reports nothing for code it knows nothing about", () => {
    const code = "extern int g; extern int arr[];\nint f(int *p, int i) { return p[i] + arr[g] + (g << i) + *p; }\n";
    const runtime = analyzer.analyze("t.c", code).filter((f) => f.ruleId.startsWith("runtime-bugfinder:") && f.ruleId !== "runtime-bugfinder:invalid-shift");
    assert.deepStrictEqual(runtime, []);
  });
});
