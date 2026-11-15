import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EQUIVALENT_RULES, mergeFindings } from "../../core/backends/merge";
import { clangTidyArgs, cppcheckArgs, parseClangTidy, parseCppcheck, parseVersion } from "../../core/backends/parsers";
import { checkBackends, enabledBackends, isBackendTarget, runBackend, runBackends, RunProcess } from "../../core/backends/run";
import { createFinding } from "../../core/finding";
import { parseConfig } from "../../core/project/config";
import { ruleInfo } from "../../core/rules/registry";

const FILE = path.resolve("proj", "src", "config_parser.c");
const SEP = "@@SCA@@";

function native(line: number, ruleId: string) {
  return createFinding({ ruleId, message: "native", file: FILE, range: { start: { line, column: 5 }, end: { line, column: 9 } }, certainty: "definite" });
}

describe("backends (unit)", () => {
  it("reads backends from .sca.json; all are off unless listed", () => {
    const { config, problems } = parseConfig(
      JSON.stringify({ backends: { cppcheck: true, "clang-tidy": { path: "C:/llvm/clang-tidy.exe", args: ["--checks=-*,bugprone-*"], timeoutMs: 5000 }, pclint: true } })
    );
    assert.deepStrictEqual(config.backends.cppcheck, { enabled: true, args: [], timeoutMs: 20000 });
    assert.deepStrictEqual(config.backends["clang-tidy"], { enabled: true, path: "C:/llvm/clang-tidy.exe", args: ["--checks=-*,bugprone-*"], timeoutMs: 5000 });
    assert.deepStrictEqual(problems, ['backends: unknown tool "pclint" (known: cppcheck, clang-tidy).']);
    assert.deepStrictEqual(enabledBackends(config).map(([id]) => id), ["cppcheck", "clang-tidy"]);
    assert.deepStrictEqual(enabledBackends(parseConfig("{}").config), []);
  });

  it("builds the command lines", () => {
    const req = { file: FILE, language: "c" as const, includePaths: ["inc"], defines: new Map([["UNIT", "1"]]), undefines: ["NDEBUG"] };
    const cpp = cppcheckArgs(req, ["--std=c99"]);
    assert.ok(cpp.includes("--language=c") && cpp.includes("-Iinc") && cpp.includes("-DUNIT=1") && cpp.includes("-UNDEBUG") && cpp.includes("--std=c99"));
    assert.strictEqual(cpp[cpp.length - 1], FILE);
    assert.deepStrictEqual(clangTidyArgs({ ...req, compileDatabase: path.join("proj", "build", "compile_commands.json") }, []), ["--quiet", `-p=${path.join("proj", "build")}`, FILE]);
    assert.deepStrictEqual(clangTidyArgs(req, []), ["--quiet", FILE, "--", "-xc", "-Iinc", "-DUNIT=1", "-UNDEBUG"]);
  });

  it("parses cppcheck output (template lines), keeping only the analyzed file", () => {
    const out = [
      `src\\config_parser.c${SEP}0${SEP}0${SEP}information${SEP}normalCheckLevelMaxBranches${SEP}Limiting analysis of branches.`,
      `src\\config_parser.c${SEP}75${SEP}12${SEP}error${SEP}legacyUninitvar${SEP}Uninitialized variable: name`,
      `src\\config_parser.c${SEP}201${SEP}13${SEP}style${SEP}shadowVariable${SEP}Local variable 'len' shadows outer variable`,
      `include\\config_parser.h${SEP}9${SEP}9${SEP}style${SEP}unusedStructMember${SEP}struct member is never used.`,
      `src\\config_parser.c${SEP}3${SEP}0${SEP}information${SEP}missingInclude${SEP}Include file "x.h" not found.`,
      "Checking src/config_parser.c ...",
    ].join("\n");
    const { findings, problems } = parseCppcheck(out, FILE, path.resolve("proj"));
    assert.deepStrictEqual(
      findings.map((f) => [f.ruleId, f.range.start.line, f.range.start.column, f.certainty, f.severity, f.source]),
      [
        ["cppcheck:legacyUninitvar", 75, 12, "definite", "error", "cppcheck"],
        ["cppcheck:shadowVariable", 201, 13, "definite", "info", "cppcheck"],
      ]
    );
    assert.deepStrictEqual(problems, ['cppcheck missingInclude: Include file "x.h" not found.']);
  });

  it("parses clang-tidy output; notes and excerpts are skipped, compile errors become problems", () => {
    const out = [
      "7 warnings generated.",
      `${FILE}:72:16: warning: variable 'name' is used uninitialized whenever 'if' condition is false [clang-diagnostic-sometimes-uninitialized]`,
      "   72 |     } else if (m == DRIVE_SPORT) {",
      `${FILE}:75:12: note: uninitialized use occurs here`,
      `${FILE}:75:5: warning: Undefined or garbage value returned to caller [clang-analyzer-core.uninitialized.UndefReturn]`,
      `${FILE}:3:10: error: 'config_parser.h' file not found [clang-diagnostic-error]`,
      `${path.resolve("proj", "include", "x.h")}:4:1: warning: something in a header [bugprone-x]`,
    ].join("\n");
    const { findings, problems } = parseClangTidy(out, FILE);
    assert.deepStrictEqual(
      findings.map((f) => [f.ruleId, f.range.start.line, f.certainty]),
      [
        ["clang-tidy:clang-diagnostic-sometimes-uninitialized", 72, "definite"],
        ["clang-tidy:clang-analyzer-core.uninitialized.UndefReturn", 75, "possible"],
      ]
    );
    assert.deepStrictEqual(problems, ["clang-tidy: 'config_parser.h' file not found"]);
  });

  it("reads tool versions", () => {
    assert.strictEqual(parseVersion("cppcheck", "Cppcheck 2.15.0\n"), "Cppcheck 2.15.0");
    assert.strictEqual(parseVersion("clang-tidy", "LLVM (http://llvm.org/):\n  LLVM version 19.1.1\n  Optimized build.\n"), "LLVM version 19.1.1");
  });

  it("merges a backend finding into the equivalent SCA finding on the same line", () => {
    const ext = parseCppcheck(
      [
        `${FILE}${SEP}201${SEP}13${SEP}style${SEP}shadowVariable${SEP}shadows`,
        `${FILE}${SEP}50${SEP}1${SEP}error${SEP}doubleFree${SEP}Memory pointed to by 'p' is freed twice.`,
      ].join("\n"),
      FILE
    ).findings;
    const tidy = parseClangTidy(`${FILE}:201:13: warning: declaration shadows a local variable [clang-diagnostic-shadow]`, FILE).findings;
    const merged = mergeFindings([native(201, "sca-own:shadowing"), native(182, "sca-own:unused-variable")], [...ext, ...tidy]);
    assert.deepStrictEqual(
      merged.map((f) => [f.ruleId, f.range.start.line, f.source]),
      [
        ["sca-own:shadowing", 201, "sca-native+cppcheck+clang-tidy"],
        ["sca-own:unused-variable", 182, "sca-native"],
        ["cppcheck:doubleFree", 50, "cppcheck"],
      ]
    );
    assert.strictEqual(merged[0].message, "native", "SCA's message is kept");
  });

  it("maps backend checks only to SCA rules that exist", () => {
    for (const [ext, rule] of Object.entries(EQUIVALENT_RULES)) {
      assert.ok(ruleInfo(rule), `${ext} -> ${rule}`);
    }
  });

  it("runs a backend through the process runner, with timeout and missing-tool problems", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const fake: RunProcess = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: `${FILE}${SEP}10${SEP}5${SEP}error${SEP}zerodiv${SEP}Division by zero.` };
    };
    const settings = { enabled: true, args: [], timeoutMs: 1000 };
    const req = { file: FILE, language: "c" as const, includePaths: [], defines: new Map(), undefines: [] };
    const run = await runBackend("cppcheck", settings, req, { run: fake });
    assert.strictEqual(calls[0].command, "cppcheck");
    assert.deepStrictEqual(run.findings.map((f) => f.ruleId), ["cppcheck:zerodiv"]);

    const missing: RunProcess = async () => ({ stdout: "", stderr: "", failure: "cppcheck was not found." });
    assert.deepStrictEqual((await runBackend("cppcheck", settings, req, { run: missing })).problems, ["cppcheck was not found."]);
    const cancelled: RunProcess = async () => ({ stdout: "", stderr: "", failure: "cancelled" });
    assert.deepStrictEqual((await runBackend("cppcheck", settings, req, { run: cancelled })).problems, []);
  });

  it("does not run backends on headers or when none is turned on", async () => {
    let called = 0;
    const fake: RunProcess = async () => {
      called++;
      return { stdout: "", stderr: "" };
    };
    const { config } = parseConfig(JSON.stringify({ backends: { cppcheck: true } }));
    assert.strictEqual(isBackendTarget("a.h"), false);
    assert.strictEqual(isBackendTarget("a.c"), true);
    assert.deepStrictEqual(await runBackends("a.h", { config, version: "1" }, { run: fake }), []);
    assert.deepStrictEqual(await runBackends("a.c", { config: parseConfig("{}").config, version: "1" }, { run: fake }), []);
    assert.strictEqual((await runBackends("a.c", { config, version: "1" }, { run: fake })).length, 1);
    assert.strictEqual(called, 1);
  });

  it("checks which backends are installed", async () => {
    const fake: RunProcess = async (command) =>
      command === "cppcheck" ? { stdout: "Cppcheck 2.15.0\n", stderr: "" } : { stdout: "", stderr: "", failure: `${command} was not found.` };
    const { config } = parseConfig(JSON.stringify({ backends: { "clang-tidy": true } }));
    const list = await checkBackends(config, fake);
    assert.deepStrictEqual(
      list.map((h) => [h.backend, h.version, h.enabled, h.problem]),
      [
        ["cppcheck", "Cppcheck 2.15.0", false, undefined],
        ["clang-tidy", undefined, true, "clang-tidy was not found."],
      ]
    );
  });

  it("runs the real cppcheck when it is installed", async function () {
    try {
      execFileSync("cppcheck", ["--version"], { stdio: "ignore" });
    } catch {
      this.skip();
    }
    this.timeout(30000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sca-backend-"));
    const file = path.join(dir, "zero.c");
    fs.writeFileSync(file, "int f(void)\n{\n    int a = 10;\n    int b = 0;\n    return a / b;\n}\n");
    try {
      const run = await runBackend("cppcheck", { enabled: true, args: [], timeoutMs: 20000 }, { file, language: "c", includePaths: [], defines: new Map(), undefines: [] }, { cwd: dir });
      assert.ok(run.findings.some((f) => f.ruleId === "cppcheck:zerodiv" && f.range.start.line === 5), JSON.stringify(run));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
