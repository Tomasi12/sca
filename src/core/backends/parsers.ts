// Command lines for the external backends and parsers for their output. Pure functions (no processes), so
// they are unit-tested on captured output. The tools run as separate processes only (see run.ts); their
// code is never linked into SCA.

import * as path from "path";
import { Certainty, createFinding, Finding, Severity } from "../finding";
import { SourceLanguage } from "../parser/parser";

export type BackendId = "cppcheck" | "clang-tidy";

/** What a backend needs to know about one file. */
export interface BackendRequest {
  readonly file: string;
  readonly language: SourceLanguage;
  readonly includePaths: readonly string[];
  readonly defines: ReadonlyMap<string, string>;
  readonly undefines: readonly string[];
  /** compile_commands.json, when the project has one. */
  readonly compileDatabase?: string;
}

/** Separator in the cppcheck template; it does not occur in paths or messages. */
const SEP = "@@SCA@@";

/** cppcheck checks that only say something about the setup, not about the code. */
const CPPCHECK_NOISE = new Set([
  "missingInclude", "missingIncludeSystem", "checkersReport", "unmatchedSuppression", "normalCheckLevelMaxBranches",
  "toomanyconfigs", "noValidConfiguration", "unknownMacro", "syntaxError", "internalAstError", "preprocessorErrorDirective",
]);

export function cppcheckArgs(req: BackendRequest, extra: readonly string[]): string[] {
  return [
    "--quiet",
    "--enable=warning,style,performance,portability",
    "--inline-suppr",
    `--language=${req.language === "cpp" ? "c++" : "c"}`,
    `--template={file}${SEP}{line}${SEP}{column}${SEP}{severity}${SEP}{id}${SEP}{message}`,
    ...req.includePaths.map((p) => `-I${p}`),
    ...[...req.defines].map(([k, v]) => `-D${k}=${v}`),
    ...req.undefines.map((u) => `-U${u}`),
    ...extra,
    req.file,
  ];
}

export function clangTidyArgs(req: BackendRequest, extra: readonly string[]): string[] {
  const args = ["--quiet", ...extra];
  if (req.compileDatabase) {
    return [...args, `-p=${path.dirname(req.compileDatabase)}`, req.file];
  }
  return [
    ...args,
    req.file,
    "--",
    ...(req.language === "c" ? ["-xc"] : ["-xc++"]),
    ...req.includePaths.map((p) => `-I${p}`),
    ...[...req.defines].map(([k, v]) => `-D${k}=${v}`),
    ...req.undefines.map((u) => `-U${u}`),
  ];
}

export interface ParsedOutput {
  readonly findings: Finding[];
  /** Setup problems the tool reported (missing headers, compile errors), for the output channel. */
  readonly problems: string[];
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Lines written by cppcheck with the template from cppcheckArgs. Only findings in `file` are kept. */
export function parseCppcheck(output: string, file: string, cwd = process.cwd()): ParsedOutput {
  const findings: Finding[] = [];
  const problems: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split(SEP);
    if (parts.length < 6) {
      continue;
    }
    const [f, l, c, severity, id, ...msg] = parts;
    const message = msg.join(SEP).trim();
    if (CPPCHECK_NOISE.has(id)) {
      if (id !== "normalCheckLevelMaxBranches" && id !== "checkersReport") {
        problems.push(`cppcheck ${id}: ${message}`);
      }
      continue;
    }
    if (!samePath(path.resolve(cwd, f), file)) {
      continue; // in a header: reported when that header is analyzed
    }
    const line1 = Math.max(1, Number(l) || 1);
    const col = Math.max(1, Number(c) || 1);
    const { certainty, sev } = cppcheckLevel(severity);
    findings.push(
      createFinding({
        ruleId: `cppcheck:${id}`,
        message,
        file,
        range: { start: { line: line1, column: col }, end: { line: line1, column: col + 1 } },
        certainty,
        severity: sev,
        source: "cppcheck",
      })
    );
  }
  return { findings, problems };
}

function cppcheckLevel(severity: string): { certainty: Certainty; sev: Severity } {
  switch (severity) {
    case "error":
      return { certainty: "definite", sev: "error" };
    case "warning":
      return { certainty: "possible", sev: "warning" };
    default:
      return { certainty: "definite", sev: "info" }; // style, performance, portability, information
  }
}

const TIDY_LINE = /^(.*?):(\d+):(\d+): (warning|error): (.*?) \[([A-Za-z0-9_.,-]+)\]\s*$/;

/** clang-tidy's `file:line:col: warning: message [check]` lines. Notes and code excerpts are skipped. */
export function parseClangTidy(output: string, file: string): ParsedOutput {
  const findings: Finding[] = [];
  const problems: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = TIDY_LINE.exec(line);
    if (!m) {
      continue;
    }
    const [, f, l, c, level, message, checks] = m;
    const check = checks.split(",")[0];
    if (level === "error" && (check === "clang-diagnostic-error" || check.startsWith("clang-diagnostic-"))) {
      problems.push(`clang-tidy: ${message}`);
      continue;
    }
    if (!samePath(f, file)) {
      continue;
    }
    const line1 = Number(l);
    const col = Number(c);
    const pathSensitive = check.startsWith("clang-analyzer-");
    findings.push(
      createFinding({
        ruleId: `clang-tidy:${check}`,
        message,
        file,
        range: { start: { line: line1, column: col }, end: { line: line1, column: col + 1 } },
        certainty: level === "error" ? "definite" : pathSensitive ? "possible" : "definite",
        severity: level === "error" ? "error" : "warning",
        source: "clang-tidy",
      })
    );
  }
  return { findings, problems };
}

/** First line of `--version` output, e.g. "Cppcheck 2.15.0" or "LLVM version 19.1.1". */
export function parseVersion(id: BackendId, output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (id === "clang-tidy") {
    return lines.find((l) => /version/i.test(l));
  }
  return lines[0];
}
