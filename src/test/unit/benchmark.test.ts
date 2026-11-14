import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sourceFiles } from "../../bench/benchmark";
import { BenchFinding, compare, formatReport, parseAnswerKey } from "../../bench/compare";

const KEY = [
  '﻿"file","line","kind","category","description"',
  '"src/a.c","10","DEFECT","div_zero","n == 0"',
  '"src/a.c","20","SAFE","div_zero","checked, ""really"""',
  '"src/b.c","5","RULE","goto","goto used"',
  '"src/b.c","9","DEFECT","overflow","no check for this yet"',
  '"src/b.c","12","SAFE","overflow","fits"',
  "",
].join("\r\n");

const RULES = { div_zero: ["runtime-bugfinder:div-zero"], goto: ["sca-own:goto"] };

const f = (file: string, line: number, ruleId: string): BenchFinding => ({ file, line, ruleId, message: "m" });

describe("bench/compare (unit)", () => {
  it("parses the answer key (BOM, quotes, CRLF)", () => {
    const rows = parseAnswerKey(KEY);
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows[1], { file: "src/a.c", line: 20, kind: "SAFE", category: "div_zero", description: 'checked, "really"' });
  });

  it("rejects a malformed answer key", () => {
    assert.throws(() => parseAnswerKey('"file","line"\n"a.c","1"\n'), /no "kind" column/);
    assert.throws(() => parseAnswerKey('"file","line","kind","category","description"\n"a.c","x","DEFECT","c","d"\n'), /malformed/);
  });

  it("counts found, missed, false positives and unmarked findings", () => {
    const findings = [
      f("src/a.c", 10, "runtime-bugfinder:div-zero"), // found
      f("src/a.c", 20, "runtime-bugfinder:div-zero"), // false positive (SAFE line)
      f("src/a.c", 30, "runtime-bugfinder:div-zero"), // unmarked
      f("src/b.c", 5, "runtime-bugfinder:div-zero"), // wrong rule on a goto line -> unmarked, goto missed
    ];
    const r = compare(parseAnswerKey(KEY), findings, RULES);
    const div = r.categories.find((c) => c.category === "div_zero")!;
    const go = r.categories.find((c) => c.category === "goto")!;
    assert.deepStrictEqual([div.expected, div.found.length, div.missed.length, div.falsePositives.length, div.safeLines], [1, 1, 0, 1, 1]);
    assert.deepStrictEqual([go.expected, go.found.length, go.missed.length], [1, 0, 1]);
    assert.deepStrictEqual(r.unmarked.map((u) => `${u.file}:${u.line}`), ["src/a.c:30", "src/b.c:5"]);
    assert.deepStrictEqual(r.notCovered, [{ category: "overflow", expected: 1 }]);
    assert.deepStrictEqual(r.totals, { expected: 2, found: 1, missed: 1, falsePositives: 1, unmarked: 2 });
  });

  it("matches paths regardless of slashes and case", () => {
    const r = compare(parseAnswerKey(KEY), [f("SRC\\a.c", 10, "runtime-bugfinder:div-zero")], RULES);
    assert.strictEqual(r.totals.found, 1);
  });

  it("formats a readable report", () => {
    const r = compare(parseAnswerKey(KEY), [f("src/a.c", 20, "runtime-bugfinder:div-zero")], RULES);
    const text = formatReport(r, "T");
    assert.match(text, /div_zero\s+1\s+0\s+1\s+1\s+1/);
    assert.match(text, /False positives[^\n]*\n\s+src\/a\.c:20/);
    assert.match(text, /Missed:\n\s+src\/a\.c:10/);
    assert.match(text, /without an SCA check yet:\n\s+overflow \(1\)/);
  });

  it("collects C/C++ sources and skips build / third_party folders", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sca-bench-"));
    try {
      for (const p of ["src/a.c", "include/a.h", "build/gen.c", "third_party/x/y.c", "src/notes.txt"]) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), "");
      }
      const files = sourceFiles(dir).map((p) => path.relative(dir, p).replace(/\\/g, "/"));
      assert.deepStrictEqual(files, ["include/a.h", "src/a.c"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
