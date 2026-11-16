// The project index: what each file of a project tells the others (see engine/knowledge.ts for the facts).
//
// Built lazily and cached, so analysis on save stays fast:
//   * a cheap text scan of every source file finds which files may define or call a name (no parsing);
//   * the facts of one file (its exported functions, their return values, struct-field zeros in initializers,
//     limited field names) are computed once per file content (one parse) and reused;
//   * the calls of a function are collected only from the files whose text mentions it, once per index
//     generation (they depend on other files' return values).
// A function defined in more than one file (copies, several programs in one folder) gives no facts at all.
//
// `invalidate(file)` (on save) drops what came from that file and starts a new generation.

import { createHash } from "crypto";
import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { numericValue } from "../checks/syntax";
import { applyDeclarator, CType, specifierType } from "../engine/declarations";
import { outsideBudget } from "../engine/clock";
import { engineFor } from "../engine/index";
import { CallFacts, ProjectKnowledge } from "../engine/knowledge";
import { CallRecord } from "../engine/summaries";
import { join, Value, withZero } from "../engine/value";
import { ReadFile } from "./project";

/** Runs `use` on a prepared file (preprocessed, parsed, with declarations); undefined without a parser. */
export type Prepare = <T>(file: string, text: string, use: (source: SourceContext) => T) => T | undefined;

interface FileFacts {
  readonly hash: string;
  readonly exported: Set<string>;
  readonly returns: Map<string, Value | undefined>;
  readonly fieldZeros: Map<string, string>;
  readonly limited: Set<string>;
}

interface CallInfo {
  readonly records: Map<string, CallRecord[]>;
  readonly escaped: Set<string>;
}

const DEFINITION = /^[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)\s*\([^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*\)\s*\{/gm;
const RELATIONAL = new Set(["<", "<=", ">", ">="]);

export class ProjectIndex implements ProjectKnowledge {
  private generation = 0;
  private readonly texts = new Map<string, string | undefined>();
  private readonly mentions = new Map<string, Set<string>>();
  private readonly paths = new Map<string, string>();
  /** Files with an initializer list that has a 0 in it. */
  private readonly zeroInits = new Set<string>();
  private readonly definers = new Map<string, Set<string>>();
  private scanned = false;
  private readonly facts = new Map<string, FileFacts>();
  private readonly calls = new Map<string, CallInfo>();
  private readonly callFactsCache = new Map<string, CallFacts | undefined>();
  private readonly busy = new Set<string>();
  /** Counts lookups that hit a file still being computed: results made meanwhile are incomplete, not cached. */
  private skipped = 0;
  private allFieldZeros: Map<string, string> | undefined;
  private allLimited: Set<string> | undefined;

  constructor(
    private readonly files: () => readonly string[],
    private readonly prepare: Prepare,
    private readonly readFile: ReadFile
  ) {}

  get version(): string {
    return `ix${this.generation}`;
  }

  /** Call when a file changed on disk (saved, created, deleted). */
  invalidate(file?: string): void {
    if (file === undefined) {
      this.texts.clear();
      this.facts.clear();
    } else {
      this.texts.delete(key(file));
      this.facts.delete(key(file));
    }
    this.scanned = false;
    this.mentions.clear();
    this.definers.clear();
    this.paths.clear();
    this.zeroInits.clear();
    this.calls.clear();
    this.callFactsCache.clear();
    this.allFieldZeros = undefined;
    this.allLimited = undefined;
    this.generation++;
  }

  // ---- ProjectKnowledge ---------------------------------------------------------------------------

  definesElsewhere(name: string, file: string): boolean {
    const definer = this.uniqueDefiner(name);
    return definer !== undefined && definer !== key(file);
  }

  returnOf(name: string, file: string): Value | undefined {
    const definer = this.uniqueDefiner(name);
    if (!definer || definer === key(file)) {
      return undefined;
    }
    const v = this.factsOf(definer)?.returns.get(name);
    return v && v.zero !== undefined ? withZero(v, v.zero.includes(`${name}()`) ? v.zero : `${name}() can return ${v.kind === "ptr" ? "NULL" : "0"}`) : v;
  }

  callFacts(name: string): CallFacts | undefined {
    if (this.callFactsCache.has(name)) {
      return this.callFactsCache.get(name);
    }
    this.callFactsCache.set(name, undefined); // recursion guard
    const before = this.skipped;
    const result = this.computeCallFacts(name);
    if (this.skipped === before) {
      this.callFactsCache.set(name, result);
    } else {
      this.callFactsCache.delete(name);
    }
    return result;
  }

  fieldZero(tag: string, field: string): string | undefined {
    let zeros = this.allFieldZeros;
    if (!zeros) {
      zeros = new Map();
      this.scan();
      const before = this.skipped;
      for (const f of this.zeroInits) {
        for (const [k, why] of this.factsOf(f)?.fieldZeros ?? []) {
          if (!zeros.has(k)) {
            zeros.set(k, why);
          }
        }
      }
      if (this.skipped === before) {
        this.allFieldZeros = zeros;
      }
    }
    return zeros.get(`${tag}.${field}`);
  }

  isLimited(name: string): boolean {
    if (!this.allLimited) {
      this.allLimited = new Set();
    }
    if (this.allLimited.has(name) || this.allLimited.has(`?${name}`)) {
      return this.allLimited.has(name);
    }
    this.scan();
    const before = this.skipped;
    const limited = [...(this.mentions.get(name) ?? [])].some((f) => this.factsOf(f)?.limited.has(name) ?? false);
    if (limited || this.skipped === before) {
      this.allLimited.add(limited ? name : `?${name}`);
    }
    return limited;
  }

  // ---- text scan ----------------------------------------------------------------------------------

  private text(file: string): string | undefined {
    const k = key(file);
    if (!this.texts.has(k)) {
      this.texts.set(k, this.readFile(file));
    }
    return this.texts.get(k);
  }

  private scan(): void {
    if (this.scanned) {
      return;
    }
    this.scanned = true;
    for (const f of this.files()) {
      const text = this.text(f);
      if (text === undefined) {
        continue;
      }
      const k = key(f);
      this.paths.set(k, f);
      if (/=\s*\{[^;]*?\b0[uUlL]*\b/.test(text)) {
        this.zeroInits.add(k);
      }
      for (const m of text.matchAll(DEFINITION)) {
        add(this.definers, m[1], k);
      }
      for (const m of text.matchAll(/\b[A-Za-z_]\w*\b/g)) {
        add(this.mentions, m[0], k);
      }
    }
  }

  /** The one file that defines `name` (not static), or undefined (none, several, or only static ones). */
  private uniqueDefiner(name: string): string | undefined {
    this.scan();
    const candidates = this.definers.get(name);
    if (!candidates || candidates.size === 0 || candidates.size > 4) {
      return undefined;
    }
    let found: string | undefined;
    for (const f of candidates) {
      if (this.factsOf(f)?.exported.has(name)) {
        if (found) {
          return undefined;
        }
        found = f;
      }
    }
    return found;
  }

  // ---- per-file facts -----------------------------------------------------------------------------

  private pathOf(k: string): string | undefined {
    this.scan();
    return this.paths.get(k);
  }

  private factsOf(k: string): FileFacts | undefined {
    const file = this.pathOf(k);
    const text = file ? this.text(file) : undefined;
    if (!file || text === undefined) {
      return undefined;
    }
    if (this.busy.has(k)) {
      this.skipped++;
      return undefined;
    }
    const hash = createHash("sha1").update(text).digest("hex");
    const known = this.facts.get(k);
    if (known && known.hash === hash) {
      return known;
    }
    this.busy.add(k);
    try {
      const facts = outsideBudget(() => this.prepare(file, text, (source) => {
        const engine = engineFor(source);
        if (!engine) {
          return undefined;
        }
        const exported = new Set(engine.exportedFunctions());
        const returns = new Map<string, Value | undefined>();
        for (const name of exported) {
          returns.set(name, engine.exportedReturn(name));
        }
        return { hash, exported, returns, fieldZeros: fieldZeros(source, engine.nodes("init_declarator"), file), limited: limitedNames(engine.nodes("binary_expression"), engine.nodes("assignment_expression")) };
      }));
      if (facts) {
        this.facts.set(k, facts);
      }
      return facts;
    } finally {
      this.busy.delete(k);
    }
  }

  private callsOf(k: string): CallInfo | undefined {
    const known = this.calls.get(k);
    if (known) {
      return known;
    }
    const file = this.pathOf(k);
    const text = file ? this.text(file) : undefined;
    if (!file || text === undefined) {
      return undefined;
    }
    if (this.busy.has(k)) {
      this.skipped++;
      return undefined;
    }
    this.busy.add(k);
    const before = this.skipped;
    try {
      const info = outsideBudget(() =>
        this.prepare(file, text, (source) => {
          const engine = engineFor(source);
          return engine ? { records: engine.callRecords(), escaped: engine.escapedFunctions() } : undefined;
        })
      );
      if (info && this.skipped === before) {
        this.calls.set(k, info);
      }
      return info;
    } finally {
      this.busy.delete(k);
    }
  }

  private computeCallFacts(name: string): CallFacts | undefined {
    if (!this.uniqueDefiner(name)) {
      return undefined;
    }
    const records: CallRecord[] = [];
    for (const f of this.mentions.get(name) ?? []) {
      const info = this.callsOf(f);
      if (!info) {
        return undefined; // a caller we cannot see
      }
      if (info.escaped.has(name)) {
        return undefined; // used as a function pointer: callers unknown
      }
      records.push(...(info.records.get(name) ?? []));
    }
    if (records.length === 0) {
      return undefined;
    }
    const width = Math.max(...records.map((r) => r.args.length));
    const args: (Value | undefined)[] = [];
    const minLength: (number | undefined)[] = [];
    const sameLength: (number | undefined)[] = [];
    for (let i = 0; i < width; i++) {
      let v: Value | undefined;
      let missing = false;
      let min: number | undefined;
      let same: number | undefined;
      let allSame = true;
      for (const r of records) {
        const a = r.args[i];
        if (!a) {
          missing = true;
          continue;
        }
        const named = a.zero !== undefined ? withZero(a, `${r.caller}() passes ${a.kind === "ptr" ? "a pointer that can be NULL" : "a value that can be 0"} ('${r.texts[i]}': ${a.zero})`) : a;
        v = v ? join(v, named) : named;
        const len = r.lengths[i];
        if (len !== undefined) {
          min = min === undefined ? len : Math.min(min, len);
        }
        if (len === undefined || (same !== undefined && same !== len)) {
          allSame = false;
        }
        same = len;
      }
      args.push(missing ? undefined : v);
      minLength.push(min);
      sameLength.push(allSame && !missing ? same : undefined);
    }
    return { calls: records.length, args, minLength, sameLength };
  }
}

function key(file: string): string {
  return process.platform === "win32" ? file.toLowerCase() : file;
}

function add(map: Map<string, Set<string>>, name: string, file: string): void {
  let set = map.get(name);
  if (!set) {
    set = new Set();
    map.set(name, set);
  }
  set.add(file);
}

/**
 * Explicit zeros that initializers put into struct fields: `WheelCalib erased = {0U, 1950U};` gives
 * "WheelCalib.ticks_per_rev". An all-zero list (`= {0}`) is a plain reset, not a value someone chose: skipped.
 */
function fieldZeros(source: SourceContext, inits: readonly Node[], file: string): Map<string, string> {
  const out = new Map<string, string>();
  const decls = source.declarations;
  if (!decls) {
    return out;
  }
  const short = file.replace(/\\/g, "/").split("/").slice(-1)[0];
  for (const init of inits) {
    const value = init.childForFieldName("value");
    const decl = init.parent;
    if (value?.type !== "initializer_list" || decl?.type !== "declaration") {
      continue;
    }
    const d = init.childForFieldName("declarator");
    if (!d) {
      continue;
    }
    const { name, type } = applyDeclarator(d, specifierType(decl.childForFieldName("type"), undefined, decl));
    const visit = (list: Node, t: CType | undefined) => {
      const r = decls.resolve(t);
      const items = list.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment");
      if (r?.k === "array") {
        items.filter((c) => c.type === "initializer_list").forEach((c) => visit(c, r.of));
        return;
      }
      const tag = decls.structTag(r);
      if (!tag) {
        return;
      }
      const fields = decls.fieldsOf(r);
      const values = items.map((c, i): [string | undefined, Node | null] => {
        if (c.type === "initializer_pair") {
          const designator = c.childForFieldName("designator") ?? c.namedChildren.find((x) => x?.type === "field_designator") ?? null;
          return [designator?.text.replace(/^\./, ""), c.childForFieldName("value")];
        }
        return [fields[i]?.[0], c];
      });
      const zeros = values.filter(([, v]) => v !== null && numericValue(v, source.macros) === 0);
      if (zeros.length === 0 || zeros.length === values.length) {
        return;
      }
      for (const [f, v] of zeros) {
        if (f && v) {
          out.set(`${tag}.${f}`, `the initializer of '${name ?? "an object"}' in ${short} (line ${v.startPosition.row + 1}) sets ${f} to 0`);
        }
      }
    };
    visit(value, type);
  }
  return out;
}

/** Names (fields and variables) that some comparison bounds or that are set from a limiting call or a condition. */
function limitedNames(binaries: readonly Node[], assignments: readonly Node[]): Set<string> {
  const out = new Set<string>();
  const nameOf = (n: Node | null): string | undefined => {
    while (n?.type === "parenthesized_expression" || n?.type === "cast_expression") {
      n = n.childForFieldName("value") ?? n.namedChildren.find((c) => c !== null && c.type !== "comment" && c.type !== "type_descriptor") ?? null;
    }
    if (n?.type === "field_expression") {
      return n.childForFieldName("field")?.text;
    }
    return n?.type === "identifier" ? n.text : undefined;
  };
  for (const b of binaries) {
    if (RELATIONAL.has(b.childForFieldName("operator")?.type ?? "")) {
      for (const side of [b.childForFieldName("left"), b.childForFieldName("right")]) {
        const n = nameOf(side);
        if (n) {
          out.add(n);
        }
      }
    }
  }
  for (const a of assignments) {
    const right = a.childForFieldName("right");
    if (a.childForFieldName("operator")?.type === "=" && (right?.type === "call_expression" || right?.type === "conditional_expression")) {
      const n = nameOf(a.childForFieldName("left"));
      if (n) {
        out.add(n);
      }
    }
  }
  return out;
}
