// Reads compile_commands.json (the JSON compilation database written by CMake, Bear, ...):
// for every source file, its include paths and macro definitions.

import * as path from "path";
import { canonicalPath } from "../monitorSet";

export interface FileFlags {
  readonly includePaths: readonly string[];
  /** -D NAME[=value]; a bare -DNAME has the value "1". */
  readonly defines: ReadonlyMap<string, string>;
  readonly undefines: readonly string[];
  readonly forcedIncludes: readonly string[];
  /** True when the flags come from this file's own entry (not borrowed from a neighbour). */
  readonly exact: boolean;
}

interface Entry {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
}

/** Splits a command line like a shell (quotes; backslash only escapes quotes, so Windows paths survive). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "'") && quote !== "'") {
      cur += cmd[++i];
      has = true;
    } else if (quote) {
      if (c === quote) {
        quote = undefined;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
      }
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) {
    out.push(cur);
  }
  return out;
}

/** Picks include paths and macro flags out of compiler arguments (GCC/Clang and MSVC spellings). */
export function parseFlags(args: readonly string[], directory: string): Omit<FileFlags, "exact"> {
  const includePaths: string[] = [];
  const defines = new Map<string, string>();
  const undefines: string[] = [];
  const forcedIncludes: string[] = [];
  const abs = (p: string) => path.resolve(directory, p);
  // "/I", "/D", "/U" are flags only for MSVC-style compilers; for GCC/Clang they are absolute paths (/Users/...).
  const msvc = /(^|[\\/])(cl|clang-cl)(\.exe)?$/i.test(args[0] ?? "");
  const flag = (a: string, letter: string) => a.startsWith(`-${letter}`) || (msvc && a.startsWith(`/${letter}`));
  const value = (i: number, flag: string): [string | undefined, number] => {
    const a = args[i];
    if (a.length > flag.length) {
      return [a.slice(flag.length), i];
    }
    return [args[i + 1], i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const take = (flag: string) => {
      const [v, j] = value(i, flag);
      i = j;
      return v;
    };
    if (flag(a, "I")) {
      const v = take(a.slice(0, 2));
      if (v) {
        includePaths.push(abs(v));
      }
    } else if (a === "-isystem" || a === "-iquote" || a === "-idirafter") {
      const v = args[++i];
      if (v) {
        includePaths.push(abs(v));
      }
    } else if (flag(a, "D")) {
      const v = take(a.slice(0, 2));
      if (v) {
        const eq = v.indexOf("=");
        defines.set(eq < 0 ? v : v.slice(0, eq), eq < 0 ? "1" : v.slice(eq + 1));
      }
    } else if (flag(a, "U")) {
      const v = take(a.slice(0, 2));
      if (v) {
        undefines.push(v);
        defines.delete(v);
      }
    } else if (a === "-include" || (msvc && a === "/FI")) {
      const v = args[++i];
      if (v) {
        forcedIncludes.push(abs(v));
      }
    } else if (msvc && a.startsWith("/FI")) {
      forcedIncludes.push(abs(a.slice(3)));
    }
  }
  return { includePaths, defines, undefines, forcedIncludes };
}

const key = (p: string) => (process.platform === "win32" ? canonicalPath(p).toLowerCase() : canonicalPath(p));

export class CompileDatabase {
  private readonly byFile = new Map<string, Omit<FileFlags, "exact">>();
  private readonly byDir = new Map<string, Omit<FileFlags, "exact">>();
  private fallback: Omit<FileFlags, "exact"> | undefined;

  private constructor() {}

  get size(): number {
    return this.byFile.size;
  }

  /** Parses the JSON text of a compile_commands.json. Throws on invalid JSON or a wrong shape. */
  static parse(json: string): CompileDatabase {
    const data: unknown = JSON.parse(json);
    if (!Array.isArray(data)) {
      throw new Error("compile_commands.json must contain a JSON array.");
    }
    const db = new CompileDatabase();
    const allIncludes = new Set<string>();
    for (const raw of data as Entry[]) {
      if (!raw || typeof raw.file !== "string" || typeof raw.directory !== "string") {
        continue;
      }
      const args = Array.isArray(raw.arguments) ? raw.arguments : typeof raw.command === "string" ? splitCommand(raw.command) : [];
      const flags = parseFlags(args, raw.directory);
      const file = path.resolve(raw.directory, raw.file);
      db.byFile.set(key(file), flags);
      const dir = key(path.dirname(file));
      if (!db.byDir.has(dir)) {
        db.byDir.set(dir, flags);
      }
      db.fallback ??= flags;
      flags.includePaths.forEach((p) => allIncludes.add(p));
    }
    if (db.fallback) {
      // For headers and files without an entry: the defines of the first entry, all include paths seen.
      db.fallback = { ...db.fallback, includePaths: [...allIncludes] };
    }
    return db;
  }

  /** Flags for a file: its own entry, else one from the same folder, else the project-wide fallback. */
  flagsFor(file: string): FileFlags | undefined {
    const own = this.byFile.get(key(file));
    if (own) {
      return { ...own, exact: true };
    }
    const near = this.byDir.get(key(path.dirname(file))) ?? this.fallback;
    return near ? { ...near, exact: false } : undefined;
  }
}
