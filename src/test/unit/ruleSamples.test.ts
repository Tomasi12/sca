import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { ALL_CHECKS } from "../../core/checks";
import { metricLimits, commentStats, functionMetrics } from "../../core/checks/metrics";
import { emptyConfig, parseConfig } from "../../core/project/config";
import { RULES } from "../../core/rules/registry";
import { SourceParser } from "../../core/parser/parser";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const SAMPLES = path.join(__dirname, "..", "..", "..", "tests", "samples");

/** RULE(rule-id) / SAFE(rule-id) markers with a full rule ID, by line. */
function markers(text: string): { rule: Map<string, number[]>; safe: Map<string, number[]> } {
  const rule = new Map<string, number[]>();
  const safe = new Map<string, number[]>();
  text.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/\b(RULE|SAFE)\(([a-z0-9-]+:[a-z0-9-]+)\)/g)) {
      const map = m[1] === "RULE" ? rule : safe;
      map.set(m[2], [...(map.get(m[2]) ?? []), i + 1]);
    }
  });
  return { rule, safe };
}

function allOn() {
  const config = emptyConfig();
  for (const r of RULES) {
    config.rules[r.id] = { enabled: true };
  }
  return { config, version: "all-on" };
}

describe("coding rules and metrics on samples (unit)", () => {
  let parser: SourceParser;
  let analyzer: Analyzer;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
    analyzer = new Analyzer(ALL_CHECKS, parser);
  });

  after(() => parser.dispose());

  for (const sample of ["rules_expressions.c", "rules_control_flow.c", "rules_types.c", "rules_declarations.c", "metrics.c"]) {
    it(`matches the RULE / SAFE markers in tests/samples/${sample}`, () => {
      const file = path.join(SAMPLES, sample);
      const text = fs.readFileSync(file, "utf8");
      const findings = analyzer.analyze(file, text, allOn());
      const { rule, safe } = markers(text);
      assert.ok(rule.size > 0, "sample has no RULE markers");
      const problems: string[] = [];
      for (const [id, lines] of rule) {
        const got = new Set(findings.filter((f) => f.ruleId === id).map((f) => f.range.start.line));
        for (const l of lines) {
          if (!got.has(l)) {
            problems.push(`missed ${id} on line ${l}`);
          }
        }
      }
      for (const [id, lines] of safe) {
        for (const f of findings.filter((x) => x.ruleId === id && lines.includes(x.range.start.line))) {
          problems.push(`false positive ${id} on line ${f.range.start.line}: ${f.message}`);
        }
      }
      assert.deepStrictEqual(problems, []);
    });
  }

  it("coding-rule findings are definite warnings; metrics are info", () => {
    const code = "int answer()\n{\n    return 42;\n}\nint many(int a, int b, int c, int d, int e, int f)\n{\n    return a + b + c + d + e + f;\n}\n";
    const findings = analyzer.analyze("t.c", code);
    const rule = findings.find((f) => f.ruleId === "sca-own:empty-parameter-list");
    const metric = findings.find((f) => f.ruleId === "his-metrics:parameters");
    assert.strictEqual(rule?.certainty, "definite");
    assert.strictEqual(rule?.severity, "warning");
    assert.strictEqual(metric?.severity, "info");
    assert.match(metric?.message ?? "", /number of parameters is 6, above the limit of 5/);
  });

  it("uses metric limits from .sca.json", () => {
    const { config, problems } = parseConfig(JSON.stringify({ metrics: { parameters: 6, "comment-density": 0, bogus: 1, returns: -1 } }));
    assert.strictEqual(config.metrics.parameters, 6);
    assert.strictEqual(config.metrics.commentDensity, 0);
    assert.strictEqual(problems.length, 2, problems.join("\n"));
    const code = "int many(int a, int b, int c, int d, int e, int f)\n{\n    return a + b + c + d + e + f;\n}\n";
    const findings = analyzer.analyze("t.c", code, { config, version: "limits" });
    assert.ok(!findings.some((f) => f.ruleId === "his-metrics:parameters"));
    assert.strictEqual(metricLimits({ file: "t.c", text: "", config }).parameters, 6);
  });

  it("counts comment lines and code lines", () => {
    const s = commentStats("/* a\n b */\nint x; // c\n\n{\n}\nint y;\n");
    assert.deepStrictEqual(s, { commentLines: 3, codeLines: 2 });
    const code = Array.from({ length: 25 }, (_, i) => `int v${i};`).join("\n") + "\n";
    const f = analyzer.analyze("dense.c", code).filter((x) => x.ruleId === "his-metrics:comment-density");
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].range.start.line, 1);
  });

  it("computes function metrics", () => {
    const tree = parser.parse("m.c", "int f(int a, int b)\n{\n    if (a && b) {\n        return g(a);\n    }\n    while (a > 0) {\n        a--;\n    }\n    return 0;\n}\n");
    try {
      const fn = tree.root.descendantsOfType("function_definition")[0]!;
      const m = functionMetrics({ file: "m.c", text: "", parsed: tree }, fn);
      assert.deepStrictEqual({ ...m }, { name: "f", line: 1, cyclomatic: 4, nesting: 1, statements: 5, parameters: 2, returns: 2, calls: 1 });
    } finally {
      tree.dispose();
    }
  });
});
