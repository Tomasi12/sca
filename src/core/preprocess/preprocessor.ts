// A small preprocessor, enough for analysis (not for compiling):
//   * follows #define / #undef and #include (quoted and <angled>, through the include paths) to know the macros;
//   * evaluates #if / #ifdef / #ifndef / #elif / #else and blanks the lines of branches that are not active,
//     so the parser sees the code the compiler sees. Line and column numbers stay the same;
//   * when a condition cannot be decided (unknown macro without a compile database), both branches stay.
// Macro *uses* in the code are not expanded; checks ask `macros.valueOf(name)` for constants instead.

import * as path from "path";
import { evaluateCondition, MacroLookup } from "./condition";

export interface Macro {
  readonly name: string;
  /** Replacement text (already without the name and parameter list). */
  readonly body: string;
  /** Parameter names for function-like macros. */
  readonly params?: readonly string[];
  /** Defined inside a branch whose condition was unknown: its value cannot be trusted. */
  readonly uncertain: boolean;
}

export interface PreprocessEnv {
  /** Predefined macros, e.g. from -D (name -> body, "1" for a bare -DNAME). */
  readonly defines: ReadonlyMap<string, string>;
  readonly undefines?: readonly string[];
  readonly includePaths: readonly string[];
  readonly forcedIncludes?: readonly string[];
  /** True when the defines are complete (compile database): a macro that is not defined counts as 0 in #if. */
  readonly complete: boolean;
  /** Reads a header; undefined when it does not exist. */
  readFile(file: string): string | undefined;
}

export class MacroTable implements MacroLookup {
  private readonly map = new Map<string, Macro>();
  /** Names that were #undef'd or never seen, while some branch was unknown: we cannot say. */
  private readonly maybe = new Set<string>();

  constructor(public undefinedIsZero: boolean) {}

  define(m: Macro): void {
    this.map.set(m.name, m);
    if (m.uncertain) {
      this.maybe.add(m.name);
    } else {
      this.maybe.delete(m.name);
    }
  }

  undefine(name: string, uncertain: boolean): void {
    this.map.delete(name);
    if (uncertain) {
      this.maybe.add(name);
    } else {
      this.maybe.delete(name);
    }
  }

  get(name: string): Macro | undefined {
    return this.map.get(name);
  }

  names(): string[] {
    return [...this.map.keys()].sort();
  }

  get size(): number {
    return this.map.size;
  }

  isDefined(name: string): boolean | undefined {
    if (this.maybe.has(name)) {
      return undefined;
    }
    return this.map.has(name);
  }

  /** Integer value of an object-like macro such as `#define CELLS (4U)`, or undefined. */
  valueOf(name: string, depth = 0): number | undefined {
    const m = this.map.get(name);
    if (!m || m.params || m.uncertain || this.maybe.has(name) || depth > 32) {
      return undefined;
    }
    const body = m.body.trim();
    if (body === "") {
      return undefined;
    }
    return evaluateCondition(body, { ...this.lookup(), undefinedIsZero: false }, depth + 1);
  }

  private lookup(): MacroLookup {
    return {
      isDefined: (n) => this.isDefined(n),
      valueOf: (n, d) => this.valueOf(n, d),
      undefinedIsZero: this.undefinedIsZero,
    };
  }
}

export interface PreprocessResult {
  /** Same lines as the input; lines in inactive branches are empty. */
  readonly text: string;
  readonly macros: MacroTable;
  /** Number of lines blanked because their branch is not active. */
  readonly inactiveLines: number;
  /** Number of #if / #elif conditions that could not be decided. */
  readonly unknownConditions: number;
  /** Headers that were found and read. */
  readonly includes: readonly string[];
}

interface Directive {
  /** 0-based index of the first physical line. */
  line: number;
  /** Number of physical lines (line continuations). */
  span: number;
  name: string;
  rest: string;
}

/** Finds directives, joining `\` continuations and skipping block comments. */
export function scanDirectives(lines: readonly string[]): Directive[] {
  const out: Directive[] = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inComment) {
      const end = line.indexOf("*/");
      if (end < 0) {
        continue;
      }
      inComment = false;
      line = " ".repeat(end + 2) + line.slice(end + 2);
    }
    const m = /^\s*#\s*([A-Za-z_]+)(.*)$/.exec(line);
    if (m) {
      let rest = m[2];
      let span = 1;
      while (rest.endsWith("\\") && i + span < lines.length) {
        rest = rest.slice(0, -1) + " " + lines[i + span];
        span++;
      }
      out.push({ line: i, span, name: m[1], rest: stripComments(rest) });
      i += span - 1;
      continue;
    }
    // track an unclosed block comment on this line
    const noStrings = line.replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/g, '""');
    const lastOpen = noStrings.lastIndexOf("/*");
    if (lastOpen >= 0 && noStrings.indexOf("*/", lastOpen + 2) < 0) {
      inComment = true;
    }
  }
  return out;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/, "").trim();
}

function parseDefine(rest: string, uncertain: boolean): Macro | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?(.*)$/.exec(rest);
  if (!m) {
    return undefined;
  }
  const params = m[2] !== undefined ? m[3].split(",").map((p) => p.trim()).filter((p) => p !== "") : undefined;
  return { name: m[1], body: m[4].trim(), params, uncertain };
}

interface Frame {
  parentActive: boolean;
  parentUncertain: boolean;
  /** Has a branch been taken? true / false / undefined (unknown). */
  taken: boolean | undefined;
  active: boolean;
  uncertain: boolean;
}

const MAX_INCLUDE_DEPTH = 24;

export function preprocess(file: string, text: string, env: PreprocessEnv): PreprocessResult {
  const macros = new MacroTable(env.complete);
  for (const [name, body] of env.defines) {
    const d = parseDefine(`${name} ${body}`, false);
    if (d) {
      macros.define(d);
    }
  }
  for (const u of env.undefines ?? []) {
    macros.undefine(u, false);
  }
  const state = { includes: [] as string[], visiting: new Set<string>(), unknown: 0 };
  for (const inc of env.forcedIncludes ?? []) {
    const content = env.readFile(inc);
    if (content !== undefined) {
      run(inc, content, env, macros, state, 1);
    }
  }
  const result = run(file, text, env, macros, state, 0);
  return {
    text: result.text,
    macros,
    inactiveLines: result.inactive,
    unknownConditions: state.unknown,
    includes: state.includes,
  };
}

function run(
  file: string,
  text: string,
  env: PreprocessEnv,
  macros: MacroTable,
  state: { includes: string[]; visiting: Set<string>; unknown: number },
  depth: number
): { text: string; inactive: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const directives = scanDirectives(lines);
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  const active = () => (stack.length === 0 ? true : top().active);
  const uncertain = () => (stack.length === 0 ? false : top().uncertain);
  const cond = (expr: string): boolean | undefined => {
    const v = evaluateCondition(expr, macros);
    if (v === undefined) {
      state.unknown++;
      return undefined;
    }
    return v !== 0;
  };

  // which physical lines are active
  const activeLine = new Array<boolean>(lines.length).fill(true);
  let next = 0;
  const markUntil = (end: number) => {
    const a = active();
    for (; next < end; next++) {
      activeLine[next] = a;
    }
  };

  for (let di = 0; di < directives.length; di++) {
    const d = directives[di];
    markUntil(d.line);
    next = d.line + d.span; // directive lines stay as they are
    switch (d.name) {
      case "if":
      case "ifdef":
      case "ifndef": {
        const parentActive = active();
        const parentUncertain = uncertain();
        let v: boolean | undefined;
        if (!parentActive) {
          v = false;
        } else if (d.name === "if") {
          v = cond(d.rest);
        } else {
          const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(d.rest)?.[0] ?? "";
          const def = macros.isDefined(name);
          // Not defined is only certain with complete defines, or for an include guard
          // (`#ifndef X` directly followed by `#define X`). A plain #ifdef FOO may come from the build.
          const next = directives[di + 1];
          const guard = d.name === "ifndef" && next?.name === "define" && next.rest.split(/[s(]/)[0] === name;
          const known = def === true || (def === false && (env.complete || guard));
          v = known ? (d.name === "ifdef" ? def : !def) : undefined;
          if (!known) {
            state.unknown++;
          }
        }
        stack.push({
          parentActive,
          parentUncertain,
          taken: v,
          active: parentActive && v !== false,
          uncertain: parentUncertain || v === undefined,
        });
        break;
      }
      case "elif":
      case "elifdef":
      case "elifndef": {
        const f = top();
        if (!f) {
          break;
        }
        if (!f.parentActive || f.taken === true) {
          f.active = false;
          break;
        }
        let v: boolean | undefined;
        if (d.name === "elif") {
          v = cond(d.rest);
        } else {
          const def = macros.isDefined(/^[A-Za-z_][A-Za-z0-9_]*/.exec(d.rest)?.[0] ?? "");
          v = def === undefined ? undefined : d.name === "elifdef" ? def : !def;
        }
        f.active = v !== false;
        f.uncertain = f.parentUncertain || f.taken === undefined || v === undefined;
        // After an unknown branch we never know which branch was taken.
        if (f.taken === false) {
          f.taken = v;
        }
        break;
      }
      case "else": {
        const f = top();
        if (!f) {
          break;
        }
        f.active = f.parentActive && f.taken !== true;
        f.uncertain = f.parentUncertain || f.taken === undefined;
        f.taken = f.taken === undefined ? undefined : true;
        break;
      }
      case "endif":
        stack.pop();
        break;
      case "define":
        if (active()) {
          const m = parseDefine(d.rest, uncertain());
          if (m) {
            macros.define(m);
          }
        }
        break;
      case "undef":
        if (active()) {
          macros.undefine(d.rest.split(/\s+/)[0], uncertain());
        }
        break;
      case "include":
        if (active() && depth < MAX_INCLUDE_DEPTH) {
          includeHeader(file, d.rest, env, macros, state, depth);
        }
        break;
      default:
        break;
    }
  }
  markUntil(lines.length);

  let inactive = 0;
  const out = lines.map((l, i) => {
    if (activeLine[i] || l.trim() === "") {
      return l;
    }
    inactive++;
    return "";
  });
  return { text: out.join(eol), inactive };
}

function includeHeader(
  from: string,
  rest: string,
  env: PreprocessEnv,
  macros: MacroTable,
  state: { includes: string[]; visiting: Set<string>; unknown: number },
  depth: number
): void {
  const m = /^"([^"]+)"|^<([^>]+)>/.exec(rest);
  if (!m) {
    return;
  }
  const name = m[1] ?? m[2];
  const candidates = [...(m[1] !== undefined ? [path.dirname(from)] : []), ...env.includePaths].map((dir) => path.resolve(dir, name));
  for (const c of candidates) {
    const key = process.platform === "win32" ? c.toLowerCase() : c;
    if (state.visiting.has(key)) {
      return; // include cycle
    }
    const content = env.readFile(c);
    if (content === undefined) {
      continue;
    }
    state.includes.push(c);
    state.visiting.add(key);
    run(c, content, env, macros, state, depth + 1);
    state.visiting.delete(key);
    return;
  }
}
