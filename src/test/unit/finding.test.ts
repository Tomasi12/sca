import * as assert from "assert";
import {
  compareFindings,
  createFinding,
  defaultSeverity,
  findingKey,
  FindingInput,
  isValidRuleId,
  summarize,
} from "../../core/finding";

function input(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    ruleId: "runtime-bugfinder:div-zero",
    message: "Divisor y can be 0.",
    file: "div_by_zero.c",
    range: { start: { line: 6, column: 16 }, end: { line: 6, column: 21 } },
    certainty: "possible",
    ...overrides,
  };
}

describe("core/finding (unit)", () => {
  describe("createFinding", () => {
    it("fills defaults: severity from certainty, source sca-native, status open", () => {
      const f = createFinding(input());
      assert.strictEqual(f.severity, "warning");
      assert.strictEqual(f.source, "sca-native");
      assert.strictEqual(f.status, "open");
      assert.strictEqual(f.justification, undefined);
    });

    it("keeps an explicit severity", () => {
      assert.strictEqual(createFinding(input({ severity: "info" })).severity, "info");
    });

    it("rejects a malformed rule ID", () => {
      assert.throws(() => createFinding(input({ ruleId: "div-zero" })), /Invalid rule ID/);
    });

    it("rejects an empty message or file", () => {
      assert.throws(() => createFinding(input({ message: "  " })), /message/);
      assert.throws(() => createFinding(input({ file: "" })), /file/);
    });

    it("rejects 0-based or non-integer positions", () => {
      const bad = { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } };
      assert.throws(() => createFinding(input({ range: bad })), /1-based/);
      const frac = { start: { line: 1.5, column: 1 }, end: { line: 2, column: 1 } };
      assert.throws(() => createFinding(input({ range: frac })), /1-based/);
    });

    it("rejects a range that ends before it starts", () => {
      const back = { start: { line: 6, column: 10 }, end: { line: 6, column: 2 } };
      assert.throws(() => createFinding(input({ range: back })), /before its start/);
    });

    it("requires a justification for justified findings", () => {
      assert.throws(() => createFinding(input({ status: "justified" })), /justification/);
      const f = createFinding(input({ status: "justified", justification: "Checked by caller." }));
      assert.strictEqual(f.justification, "Checked by caller.");
    });
  });

  it("validates rule IDs", () => {
    assert.ok(isValidRuleId("misra-c-2012:17.2"));
    assert.ok(isValidRuleId("his-metrics:cyclomatic-complexity"));
    assert.strictEqual(isValidRuleId("MISRA:1.1"), false);
    assert.strictEqual(isValidRuleId("misra-c-2012:"), false);
  });

  it("maps certainty to default severity", () => {
    assert.strictEqual(defaultSeverity("definite"), "error");
    assert.strictEqual(defaultSeverity("possible"), "warning");
  });

  it("builds a stable key from file, start and rule", () => {
    assert.strictEqual(findingKey(createFinding(input())), "div_by_zero.c:6:16:runtime-bugfinder:div-zero");
  });

  it("sorts by file, then position, then rule", () => {
    const at = (file: string, line: number, ruleId = "runtime-bugfinder:div-zero") =>
      createFinding(input({ file, ruleId, range: { start: { line, column: 1 }, end: { line, column: 2 } } }));
    const sorted = [at("b.c", 1), at("a.c", 9), at("a.c", 2, "sca-own:goto"), at("a.c", 2)].sort(compareFindings);
    assert.deepStrictEqual(
      sorted.map(findingKey),
      ["a.c:2:1:runtime-bugfinder:div-zero", "a.c:2:1:sca-own:goto", "a.c:9:1:runtime-bugfinder:div-zero", "b.c:1:1:runtime-bugfinder:div-zero"]
    );
  });

  it("summarizes open definite / possible and justified findings", () => {
    const s = summarize([
      createFinding(input({ certainty: "definite" })),
      createFinding(input()),
      createFinding(input()),
      createFinding(input({ certainty: "definite", status: "justified", justification: "Reviewed." })),
    ]);
    assert.deepStrictEqual(s, { definite: 1, possible: 2, justified: 1, total: 4 });
  });
});
