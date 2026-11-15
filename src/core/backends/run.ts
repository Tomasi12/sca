// Runs the external backends as separate processes, with a timeout and cancellation.

import { execFile } from "child_process";
import * as path from "path";
import { Finding } from "../finding";
import { languageForFile } from "../parser/parser";
import { BackendSettings, KNOWN_BACKENDS, ScaConfig } from "../project/config";
import { FileContext } from "../project/project";
import { BackendId, BackendRequest, clangTidyArgs, cppcheckArgs, parseClangTidy, parseCppcheck, parseVersion } from "./parsers";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the tool could not run or did not finish. */
  readonly failure?: string;
  /** Exit code (0 when the tool finished normally). */
  readonly code?: number;
}

/** Runs a program; never throws. Non-zero exit codes are normal for these tools (they mean "findings"). */
export type RunProcess = (command: string, args: readonly string[], options: { timeoutMs: number; cwd?: string; signal?: AbortSignal }) => Promise<ProcessResult>;

export const runProcess: RunProcess = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs, cwd: options.cwd, signal: options.signal, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        let failure: string | undefined;
        if (e?.code === "ENOENT") {
          failure = `${command} was not found. Install it or set its "path" in .sca.json "backends".`;
        } else if (e?.name === "AbortError") {
          failure = "cancelled";
        } else if (e?.killed) {
          failure = `${command} did not finish within ${options.timeoutMs} ms.`;
        }
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failure, code });
      }
    );
  });

/** The backends a project turned on. */
export function enabledBackends(config: ScaConfig | undefined): [BackendId, BackendSettings][] {
  if (!config) {
    return [];
  }
  return KNOWN_BACKENDS.filter((id) => config.backends[id]?.enabled).map((id) => [id, config.backends[id]]);
}

export function requestFor(file: string, context: FileContext | undefined): BackendRequest {
  const env = context?.env;
  return {
    file,
    language: languageForFile(file),
    includePaths: env?.includePaths ?? [],
    defines: env?.defines ?? new Map(),
    undefines: env?.undefines ?? [],
    compileDatabase: context?.compileDatabase,
  };
}

export interface BackendRun {
  readonly backend: BackendId;
  readonly findings: Finding[];
  readonly problems: string[];
  readonly ms: number;
}

/** Runs one backend on one file. */
export async function runBackend(
  id: BackendId,
  settings: BackendSettings,
  req: BackendRequest,
  options: { cwd?: string; signal?: AbortSignal; run?: RunProcess } = {}
): Promise<BackendRun> {
  const started = Date.now();
  const command = settings.path ?? id;
  const args = id === "cppcheck" ? cppcheckArgs(req, settings.args) : clangTidyArgs(req, settings.args);
  const cwd = options.cwd ?? path.dirname(req.file);
  const res = await (options.run ?? runProcess)(command, args, { timeoutMs: settings.timeoutMs, cwd, signal: options.signal });
  if (res.failure) {
    return { backend: id, findings: [], problems: res.failure === "cancelled" ? [] : [res.failure], ms: Date.now() - started };
  }
  // cppcheck writes its template lines to stderr, clang-tidy its warnings to stdout.
  const parsed = id === "cppcheck" ? parseCppcheck(res.stderr + "\n" + res.stdout, req.file, cwd) : parseClangTidy(res.stdout + "\n" + res.stderr, req.file);
  const problems = [...parsed.problems];
  // A tool that stopped with an error and printed nothing SCA understands (an unknown option, a broken
  // install): say what it printed instead of silently reporting no findings.
  if ((res.code ?? 0) !== 0 && parsed.findings.length === 0 && problems.length === 0) {
    const text = `${res.stderr}\n${res.stdout}`.trim().split(/\r?\n/).slice(0, 5).join(" | ").slice(0, 400);
    problems.push(`${command} exited with code ${res.code}${text ? `: ${text}` : " without output"}`);
  }
  return { backend: id, findings: parsed.findings, problems, ms: Date.now() - started };
}

/** Headers are checked through the source files that include them; alone, the tools misjudge them. */
export function isBackendTarget(file: string): boolean {
  return /\.(c|cc|cpp|cxx|c\+\+)$/i.test(file);
}

/** Runs every enabled backend on a source file (in parallel). Headers get no backend run. */
export async function runBackends(file: string, context: FileContext | undefined, options: { signal?: AbortSignal; run?: RunProcess } = {}): Promise<BackendRun[]> {
  if (!isBackendTarget(file)) {
    return [];
  }
  const req = requestFor(file, context);
  return Promise.all(enabledBackends(context?.config).map(([id, s]) => runBackend(id, s, req, { cwd: context?.root, ...options })));
}

export interface BackendHealth {
  readonly backend: BackendId;
  readonly command: string;
  readonly enabled: boolean;
  readonly version?: string;
  readonly problem?: string;
}

/** "SCA: Check Backends": which tools are found, their versions, and whether the project uses them. */
export async function checkBackends(config: ScaConfig | undefined, run: RunProcess = runProcess): Promise<BackendHealth[]> {
  const out: BackendHealth[] = [];
  for (const id of KNOWN_BACKENDS) {
    const settings = config?.backends[id];
    const command = settings?.path ?? id;
    const res = await run(command, ["--version"], { timeoutMs: 10000 });
    const version = res.failure ? undefined : parseVersion(id, res.stdout + "\n" + res.stderr);
    out.push({ backend: id, command, enabled: settings?.enabled ?? false, version, problem: res.failure ?? (version ? undefined : "no version output") });
  }
  return out;
}
