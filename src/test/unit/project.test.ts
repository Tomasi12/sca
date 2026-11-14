import * as assert from "assert";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { applyBaseline, baselineEntries, createBaseline, parseBaseline } from "../../core/baseline";
import { ALL_CHECKS } from "../../core/checks";
import { createFinding, Finding } from "../../core/finding";
import { findJustifications, justificationFor } from "../../core/justify";
import { SourceParser } from "../../core/parser/parser";
import { CompileDatabase, parseFlags, splitCommand } from "../../core/project/compileCommands";
import { isRuleEnabled, parseConfig, rulePatternMatches } from "../../core/project/config";
import { Project } from "../../core/project/project";
import { renderReport } from "../../core/report";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const ROOT = path.resolve("/proj");
const P = (...p: string[]) => path.join(ROOT, ...p);

/** In-memory file system for Project tests. */
const memFs = (files: Record<string, string>) => {
  const m = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k).toLowerCase(), v]));
  return (f: string) => m.get(path.resolve(f).toLowerCase());
};

describe("core/project compile database (unit)", () => {
  it("splits command lines with quotes and Windows paths", () => {
    assert.deepStrictEqual(splitCommand('gcc -I"C:\\My Inc" -DNAME=\\"x\\" -c C:\\src\\a.c'), ["gcc", "-IC:\\My Inc", '-DNAME="x"', "-c", "C:\\src\\a.c"]);
  });

  it("reads include paths, defines, undefines and forced includes", () => {
    const f = parseFlags(["cc", "-Iinc", "-I", "../x", "-isystem", "/sys", "-DA", "-DB=2", "-D", "C=3", "-UB", "-include", "cfg.h", "-c", "/Users/me/Inc/a.c"], ROOT);
    assert.deepStrictEqual(f.includePaths, [P("inc"), path.resolve(ROOT, "../x"), path.resolve("/sys")]);
    assert.deepStrictEqual([...f.defines], [["A", "1"], ["C", "3"]], "/Users/... is a path, not /U");
    assert.deepStrictEqual(f.undefines, ["B"]);
    assert.deepStrictEqual(f.forcedIncludes, [P("cfg.h")]);
  });

  it("understands MSVC-style /I /D /FI only for cl and clang-cl", () => {
    const f = parseFlags(["C:\\VS\\cl.exe", "/DMSVC=1", "/Imsinc", "/FIpre.h", "/c", "a.c"], ROOT);
    assert.deepStrictEqual(f.includePaths, [P("msinc")]);
    assert.deepStrictEqual([...f.defines], [["MSVC", "1"]]);
    assert.deepStrictEqual(f.forcedIncludes, [P("pre.h")]);
  });

  it("finds flags per file, per folder, and falls back for headers", () => {
    const db = CompileDatabase.parse(
      JSON.stringify([
        { directory: P("build"), command: "gcc -I../include -DBOARD=2 -c ../src/a.c", file: "../src/a.c" },
        { directory: P("build"), arguments: ["gcc", "-I../lib", "-c", P("lib", "b.c")], file: P("lib", "b.c") },
      ])
    );
    assert.strictEqual(db.size, 2);
    assert.strictEqual(db.flagsFor(P("src", "a.c"))?.exact, true);
    assert.strictEqual(db.flagsFor(P("src", "a.c"))?.defines.get("BOARD"), "2");
    assert.strictEqual(db.flagsFor(P("src", "other.c"))?.exact, false);
    const header = db.flagsFor(P("include", "a.h"))!;
    assert.deepStrictEqual([...header.includePaths].sort(), [P("include"), P("lib")].sort());
  });

  it("rejects a file that is not a JSON array", () => {
    assert.throws(() => CompileDatabase.parse("{}"), /JSON array/);
  });
});

describe("core/project config (unit)", () => {
  it("parses rule sets, rules, excludes, defines and deviations", () => {
    const { config, problems } = parseConfig(
      JSON.stringify({
        ruleSets: { "sca-own": false },
        rules: { "sca-own:goto": true, "runtime-bugfinder:div-zero": { severity: "error" } },
        exclude: ["**/gen/**"],
        defines: { DEBUG: 1, NAME: "x" },
        deviations: [{ rule: "sca-own:*", file: "src\\a.c", line: 3, reason: "ok" }],
      })
    );
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(isRuleEnabled(config, "sca-own:goto"), true, "rule wins over its set");
    assert.strictEqual(isRuleEnabled(config, "sca-own:switch-default"), false);
    assert.strictEqual(isRuleEnabled(config, "runtime-bugfinder:div-zero"), true);
    assert.strictEqual(config.rules["runtime-bugfinder:div-zero"].severity, "error");
    assert.deepStrictEqual(config.defines, { DEBUG: "1", NAME: "x" });
    assert.strictEqual(config.deviations[0].file, "src/a.c");
  });

  it("reports problems without failing", () => {
    const { config, problems } = parseConfig(JSON.stringify({ rulez: 1, rules: { goto: false, "a:b": { severity: "fatal" } }, deviations: [{ rule: "x" }] }));
    assert.strictEqual(problems.length, 4);
    assert.strictEqual(config.rules["a:b"].enabled, true);
    assert.match(parseConfig("{ nope").problems[0], /Not valid JSON/);
  });

  it("matches rule patterns", () => {
    assert.ok(rulePatternMatches("*", "sca-own:goto"));
    assert.ok(rulePatternMatches("sca-own:*", "sca-own:goto"));
    assert.ok(!rulePatternMatches("sca:*", "sca-own:goto"));
  });
});

describe("core/project Project + analyzer (unit)", () => {
  let parser: SourceParser;
  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
  });
  after(() => parser.dispose());

  const files = {
    [P("build", "compile_commands.json")]: JSON.stringify([{ directory: P("build"), command: "gcc -I../include -DUSE_FAST=0 -c ../src/a.c", file: "../src/a.c" }]),
    [P("include", "cfg.h")]: "#ifndef CFG_H\n#define CFG_H\n#define CELLS 0U\n#endif\n",
    [P(".sca.json")]: JSON.stringify({ rules: { "runtime-bugfinder:div-zero": { severity: "error" } }, deviations: [{ rule: "sca-own:goto", file: "src/a.c", line: 9, reason: "cleanup path" }] }),
  };
  const SRC = [
    '#include "cfg.h"', // 1
    "int f(int x)", // 2
    "{", // 3
    "#if USE_FAST", // 4
    "    return x / 0;", // 5  inactive: not reported
    "#endif", // 6
    "    return x / CELLS;", // 7  macro from the header = 0 -> definite
    "}", // 8
    "void g(void) { goto end; end: ; }", // 9  deviation in .sca.json
    "int h(int n) { return 1 / n; } /* sca-justify(runtime-bugfinder:div-zero): callers pass 1..8 */", // 10
  ].join("\n");

  it("finds the compile database and the config", () => {
    const project = Project.load(ROOT, memFs(files));
    assert.deepStrictEqual(project.problems, []);
    assert.strictEqual(project.dbPath, P("build", "compile_commands.json"));
    assert.strictEqual(project.relPath(P("src", "a.c")), "src/a.c");
  });

  it("analyzes with #if branches, header macros, severity overrides and justifications", () => {
    const project = Project.load(ROOT, memFs(files));
    const analyzer = new Analyzer(ALL_CHECKS, parser);
    const file = P("src", "a.c");
    const out = analyzer.analyze(file, SRC, project.contextFor(file));
    const view = out.map((f) => `${f.range.start.line}:${f.ruleId}:${f.certainty}:${f.severity}:${f.status}`);
    assert.deepStrictEqual(view, [
      "7:runtime-bugfinder:div-zero:definite:error:open",
      "9:sca-own:goto:definite:warning:justified",
      "10:runtime-bugfinder:div-zero:possible:error:justified",
    ]);
  });

  it("turns rules off from .sca.json", () => {
    const project = Project.load(ROOT, memFs({ ...files, [P(".sca.json")]: JSON.stringify({ ruleSets: { "runtime-bugfinder": false } }) }));
    const out = new Analyzer(ALL_CHECKS, parser).analyze(P("src", "a.c"), SRC, project.contextFor(P("src", "a.c")));
    assert.deepStrictEqual(out.map((f) => f.ruleId), ["sca-own:goto"]);
  });

  it("caches results by content and project version", () => {
    const project = Project.load(ROOT, memFs(files));
    const analyzer = new Analyzer(ALL_CHECKS, parser);
    const file = P("src", "a.c");
    analyzer.analyze(file, SRC, project.contextFor(file));
    analyzer.analyze(file, SRC, project.contextFor(file));
    assert.deepStrictEqual(analyzer.cacheStats, { hits: 1, misses: 1, size: 1 });
    project.invalidateHeaders();
    analyzer.analyze(file, SRC, project.contextFor(file));
    assert.strictEqual(analyzer.cacheStats.misses, 2, "a header change invalidates the cache");
  });

  it("reports setup problems", () => {
    const project = Project.load(ROOT, memFs({ [P(".sca.json")]: JSON.stringify({ compileCommands: "nope/cc.json", bad: 1 }) }));
    assert.strictEqual(project.problems.length, 2);
  });
});

describe("core/justify (unit)", () => {
  it("applies a justification on the same line or from a comment line above", () => {
    const text = [
      "a = b / c; // sca-justify(runtime-bugfinder:div-zero): c is a constant",
      "/* sca-justify(sca-own:*): legacy */",
      "",
      "goto x;",
      "// sca-justify(*):",
    ].join("\n");
    const j = findJustifications(text);
    assert.deepStrictEqual(j.map((x) => [x.line, x.rule, x.reason]), [
      [1, "runtime-bugfinder:div-zero", "c is a constant"],
      [4, "sca-own:*", "legacy"],
    ]);
    assert.strictEqual(justificationFor(j, "sca-own:goto", 4), "legacy");
    assert.strictEqual(justificationFor(j, "sca-own:goto", 1), undefined);
  });
});

describe("core/baseline (unit)", () => {
  const f = (line: number, ruleId = "sca-own:goto"): Finding =>
    createFinding({ ruleId, message: "m", file: "a.c", range: { start: { line, column: 1 }, end: { line, column: 2 } }, certainty: "definite" });

  it("hides old findings by line text, even after lines move, and shows new ones", () => {
    const before = "x;\n  goto a;\ny;\n  goto a;\n";
    const baseline = createBaseline(baselineEntries([f(2), f(4)], before, "src/a.c"));
    const roundTrip = parseBaseline(JSON.stringify(baseline));
    const after = "new;\nx;\n  goto   a;\ny;\n  goto a;\n  goto a;\n";
    const { shown, hidden } = applyBaseline([f(3), f(5), f(6)], after, "src/a.c", roundTrip);
    assert.strictEqual(hidden, 2);
    assert.deepStrictEqual(shown.map((x) => x.range.start.line), [6], "the third goto is new");
  });

  it("does not hide findings of other files or other rules", () => {
    const b = createBaseline(baselineEntries([f(1)], "goto a;", "src/a.c"));
    assert.strictEqual(applyBaseline([f(1)], "goto a;", "src/b.c", b).hidden, 0);
    assert.strictEqual(applyBaseline([f(1, "sca-own:switch-default")], "goto a;", "src/a.c", b).hidden, 0);
  });

  it("rejects an unknown format", () => {
    assert.throws(() => parseBaseline('{"version":2}'), /unsupported/);
  });
});

describe("core/report (unit)", () => {
  const findings = [
    createFinding({ ruleId: "sca-own:goto", message: 'goto "x", used', file: P("src", "a.c"), range: { start: { line: 3, column: 5 }, end: { line: 3, column: 12 } }, certainty: "definite", severity: "warning" }),
    createFinding({ ruleId: "runtime-bugfinder:div-zero", message: "<div>", file: P("src", "b.c"), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, certainty: "possible", status: "justified", justification: "ok" }),
  ];
  const input = { root: ROOT, findings, fileCount: 2, toolVersion: "0.0.1", generatedAt: new Date("2026-11-14T10:00:00Z") };

  it("writes CSV with relative paths and quoting", () => {
    const csv = renderReport("csv", input).split("\r\n");
    assert.strictEqual(csv[0], "file,line,column,rule,certainty,severity,status,message,justification");
    assert.strictEqual(csv[1], 'src/a.c,3,5,sca-own:goto,definite,warning,open,"goto ""x"", used",');
  });

  it("writes SARIF 2.1.0 with levels, regions and suppressions", () => {
    const sarif = JSON.parse(renderReport("sarif", input));
    assert.strictEqual(sarif.version, "2.1.0");
    const [a, b] = sarif.runs[0].results;
    assert.strictEqual(a.level, "warning");
    assert.deepStrictEqual(a.locations[0].physicalLocation.region, { startLine: 3, startColumn: 5, endLine: 3, endColumn: 12 });
    assert.strictEqual(a.locations[0].physicalLocation.artifactLocation.uri, "src/a.c");
    assert.deepStrictEqual(b.suppressions, [{ kind: "inSource", justification: "ok" }]);
    assert.deepStrictEqual(sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id), ["runtime-bugfinder:div-zero", "sca-own:goto"]);
  });

  it("writes escaped HTML with counts", () => {
    const html = renderReport("html", input);
    assert.ok(html.includes("&lt;div&gt;"));
    assert.ok(!html.includes("<div>m"));
    assert.match(html, /<b[^>]*>1<\/b>definite/);
    assert.match(html, /Justification: ok/);
  });
});
