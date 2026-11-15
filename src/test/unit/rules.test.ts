import * as assert from "assert";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { ALL_CHECKS, ALL_RULE_IDS } from "../../core/checks";
import { isValidRuleId } from "../../core/finding";
import { emptyConfig } from "../../core/project/config";
import { explainRule, ruleHover, ruleReference } from "../../core/rules/explain";
import { RULES, ruleInfo } from "../../core/rules/registry";
import { SourceParser } from "../../core/parser/parser";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");

describe("rules/registry (unit)", () => {
  let parser: SourceParser;
  let analyzer: Analyzer;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
    analyzer = new Analyzer(ALL_CHECKS, parser);
  });

  after(() => parser.dispose());

  /** All rules on (off-by-default ones too), so every example is judged. */
  function allOn() {
    const config = emptyConfig();
    for (const r of RULES) {
      config.rules[r.id] = { enabled: true };
    }
    return { config, version: "all-on", env: { defines: new Map(), includePaths: [], complete: false, readFile: () => undefined } };
  }

  it("describes every rule a check can report, and nothing else", () => {
    const described = new Set(RULES.map((r) => r.id));
    const reported = new Set(ALL_RULE_IDS);
    assert.deepStrictEqual([...reported].filter((id) => !described.has(id)), [], "rules without a description");
    assert.deepStrictEqual([...described].filter((id) => !reported.has(id)), [], "descriptions without a check");
    assert.strictEqual(described.size, RULES.length, "duplicate IDs");
  });

  it("has complete entries", () => {
    for (const r of RULES) {
      assert.ok(isValidRuleId(r.id), r.id);
      for (const k of ["title", "summary", "rationale", "fix", "group"] as const) {
        assert.ok(r[k].trim().length > 3, `${r.id}: ${k}`);
      }
      if (r.kind === "metric") {
        assert.ok(r.limit !== undefined, `${r.id}: limit`);
      } else {
        assert.ok(r.bad && r.good, `${r.id}: examples`);
      }
    }
  });

  for (const r of RULES.filter((x) => x.bad && x.good)) {
    it(`example for ${r.id}: bad is reported, good is not`, () => {
      const ctx = allOn();
      const bad = analyzer.analyze(`bad_${r.id.replace(/\W/g, "_")}.c`, r.bad! + "\n", ctx).filter((f) => f.ruleId === r.id);
      const good = analyzer.analyze(`good_${r.id.replace(/\W/g, "_")}.c`, r.good! + "\n", ctx).filter((f) => f.ruleId === r.id);
      assert.ok(bad.length > 0, `bad example not reported:\n${r.bad}`);
      assert.deepStrictEqual(good.map((f) => `${f.range.start.line}: ${f.message}`), [], `good example reported:\n${r.good}`);
    });
  }

  it("explains a rule with why, fix and examples", () => {
    const md = explainRule("sca-own:float-equality");
    assert.match(md, /^# Floating-point equality/);
    assert.match(md, /## Why/);
    assert.match(md, /## How to fix/);
    assert.match(md, /```c/);
    assert.match(explainRule("his-metrics:nesting"), /"metrics": \{ "nesting": 4 \}/);
    assert.match(explainRule("nope:rule"), /no description/);
    assert.match(ruleHover("sca-own:vla") ?? "", /Variable-length array/);
    assert.strictEqual(ruleHover("nope:rule"), undefined);
  });

  it("builds the rule reference with every rule", () => {
    const md = ruleReference();
    for (const r of RULES) {
      assert.ok(md.includes(`### ${r.id}`), r.id);
    }
  });

  it("off-by-default rules are quiet unless turned on", () => {
    const code = "int long_line(unsigned int len)\n{\n    return len > 24U;\n}\n";
    assert.strictEqual(ruleInfo("sca-own:magic-number")?.enabledByDefault, false);
    assert.ok(!analyzer.analyze("m.c", code).some((f) => f.ruleId === "sca-own:magic-number"));
    assert.ok(analyzer.analyze("m.c", code, allOn()).some((f) => f.ruleId === "sca-own:magic-number"));
  });
});
