import * as assert from "assert";
import { Certainty, createFinding, Finding, findingKey } from "../../core/finding";
import { IssueStore } from "../../core/issueStore";

function finding(file: string, line: number, certainty: Certainty = "possible", ruleId = "runtime-bugfinder:div-zero"): Finding {
  return createFinding({
    ruleId,
    message: "msg",
    file,
    range: { start: { line, column: 1 }, end: { line, column: 5 } },
    certainty,
  });
}

describe("core/issueStore (unit)", () => {
  it("starts empty", () => {
    const s = new IssueStore();
    assert.deepStrictEqual(s.files(), []);
    assert.deepStrictEqual(s.findingsFor("a.c"), []);
    assert.strictEqual(s.summary().total, 0);
  });

  it("replaces a file's findings, sorted, and lists files sorted", () => {
    const s = new IssueStore();
    s.setFindings("b.c", [finding("b.c", 9), finding("b.c", 2)]);
    s.setFindings("a.c", []);
    assert.deepStrictEqual(s.files(), ["a.c", "b.c"]);
    assert.deepStrictEqual(s.findingsFor("b.c").map((f) => f.range.start.line), [2, 9]);

    s.setFindings("b.c", [finding("b.c", 4)]);
    assert.deepStrictEqual(s.findingsFor("b.c").map((f) => f.range.start.line), [4]);
  });

  it("drops duplicates and findings that belong to another file", () => {
    const s = new IssueStore();
    s.setFindings("a.c", [finding("a.c", 3), finding("a.c", 3), finding("other.c", 1)]);
    assert.deepStrictEqual(s.findingsFor("a.c").map(findingKey), ["a.c:3:1:runtime-bugfinder:div-zero"]);
  });

  it("summarizes per file and overall", () => {
    const s = new IssueStore();
    s.setFindings("a.c", [finding("a.c", 1, "definite"), finding("a.c", 2)]);
    s.setFindings("b.c", [finding("b.c", 1)]);
    assert.deepStrictEqual(s.summary("a.c"), { definite: 1, possible: 1, justified: 0, total: 2 });
    assert.deepStrictEqual(s.summary(), { definite: 1, possible: 2, justified: 0, total: 3 });
  });

  it("notifies listeners with the changed files, and stops after unsubscribe", () => {
    const s = new IssueStore();
    const events: string[][] = [];
    const off = s.onDidChange((files) => events.push([...files]));
    s.setFindings("a.c", [finding("a.c", 1)]);
    s.setFindings("b.c", []);
    s.clearFile("a.c");
    s.clearFile("missing.c");
    s.clearAll();
    off();
    s.setFindings("c.c", []);
    assert.deepStrictEqual(events, [["a.c"], ["b.c"], ["a.c"], ["b.c"]]);
  });
});
