// File-level knowledge for the engine: what one function can learn about the rest of the file.
//
//   * Static objects (file-scope `static` variables, arrays, structs): every store to them in this file
//     is collected. A read gets the type's full range, plus a zero witness when some store can put 0
//     there (a constant 0, a memset to 0, an unchecked parameter). Other objects stay unknown.
//   * Return values of functions defined in this file: the join of their `return` values, computed with
//     unknown parameters (so `return x;` does not turn every caller's argument into a finding).
//   * Parameters of `static` functions whose only uses are direct calls in this file: the join of the
//     argument values at the calls (each caller is solved for that). An argument nothing is known about
//     counts as "anything the caller passes", like a parameter of a function other files can call.

import { Node } from "web-tree-sitter";
import { ConstantLookup, numericValue } from "../checks/syntax";
import { buildCfg, Cfg, functionName } from "./cfg";
import { Budget, DEFAULT_BUDGET, Environment, FunctionAnalysis, FunctionModel, Observer, VarInfo } from "./interpreter";
import { SyntaxCache, withCache } from "./syntaxCache";
import { Declarations } from "./declarations";
import { TypeTable } from "./types";
import { exact, join, ofType, unknown, Value, wild, withZero } from "./value";

export interface EngineStats {
  analyzed: number;
  skipped: number;
  /** Why functions were skipped (unsupported construct, time budget), with counts. */
  reasons: Map<string, number>;
}

/** check: real summaries; lazy: summaries not looked up yet; stores: collecting stores; summary: return values. */
type Mode = "check" | "lazy" | "stores" | "summary";

const LAZY = "(not looked up yet)";
const LAZY_RESULT: Value = { lo: -Infinity, hi: Infinity, kind: "int", init: "yes", zero: LAZY };
// "fresh": the cheap pass treats every pointer result as new memory (more leak findings, never fewer).
const LAZY_POINTER: Value = { lo: 0, hi: 1, kind: "ptr", init: "yes", zero: LAZY, heap: "fresh" };

/** Node types collected by the one walk over the file (each descendantsOfType call is a full walk). */
const INDEXED = [
  "function_definition", "function_declarator", "type_definition", "declaration", "pointer_expression",
  "binary_expression", "assignment_expression", "update_expression", "call_expression", "init_declarator",
  "return_statement", "while_statement", "for_statement", "do_statement", "identifier",
];

export class FileEngine {
  private readonly byType = new Map<string, Node[]>();
  readonly types: TypeTable;
  readonly stats: EngineStats = { analyzed: 0, skipped: 0, reasons: new Map() };
  private readonly functions = new Map<string, Node>();
  private readonly staticFunctions = new Set<string>();
  private readonly staticObjects = new Set<string>();
  private readonly declaredFunctions = new Set<string>();
  private readonly cfgs = new Map<number, Cfg>();
  private readonly models = new Map<number, FunctionModel>();
  /** Stores to static objects, per analyzed function (path -> reasons it can be 0). */
  private readonly storesByFunction = new Map<number, Map<string, string[]>>();
  private readonly writes = new Map<number, Set<string>>();
  private identifiersByName: Map<string, Node[]> | undefined;
  private functionList: Node[] | undefined;
  private readonly syntax = new SyntaxCache();
  private readonly started = Date.now();
  private readonly returns = new Map<string, Value | undefined | "busy">();
  private readonly callerArgs = new Map<string, (Value | undefined)[] | null>();
  /** Argument values of the calls in one caller (by call node id), from solving the caller. */
  private readonly callsByCaller = new Map<number, Map<number, readonly Value[]>>();
  private readonly busyCallers = new Set<number>();
  /** Functions of the file that never return (null: they can return). */
  private readonly noReturns = new Map<string, "declared" | "implicit" | null | "busy">();
  readonly decls: Declarations;

  constructor(
    readonly root: Node,
    readonly consts?: ConstantLookup,
    readonly budget: Budget = DEFAULT_BUDGET,
    decls?: Declarations,
    private readonly macroBody: (name: string) => string | undefined = () => undefined
  ) {
    this.decls = decls ?? Declarations.empty();
    for (const n of root.descendantsOfType(INDEXED)) {
      if (n) {
        const list = this.byType.get(n.type) ?? [];
        list.push(n);
        this.byType.set(n.type, list);
      }
    }
    const nodes = [...this.nodes("function_definition"), ...this.nodes("function_declarator"), ...this.nodes("type_definition")];
    this.types = TypeTable.fromDefinitions(nodes.filter((n) => n.type === "type_definition"));
    this.types.external = this.decls;
    for (const fn of nodes) {
      if (fn.type !== "function_definition") {
        continue;
      }
      const name = functionName(fn);
      if (name && !this.functions.has(name)) {
        this.functions.set(name, fn);
        if (fn.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === "static")) {
          this.staticFunctions.add(name);
        }
      }
    }
    for (const fd of nodes) {
      if (fd.type !== "function_declarator") {
        continue;
      }
      const id = fd.childForFieldName("declarator");
      if (id?.type === "identifier") {
        this.declaredFunctions.add(id.text);
      }
    }
    for (const decl of root.namedChildren) {
      if (decl?.type !== "declaration" || !decl.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === "static")) {
        continue;
      }
      for (const d of decl.childrenForFieldName("declarator")) {
        const name = d ? objectName(d) : undefined;
        if (name) {
          this.staticObjects.add(name);
        }
      }
    }
  }

  /** All function definitions of the file, in source order. */
  functionNodes(): Node[] {
    this.functionList ??= this.nodes("function_definition").filter((f) => !f.hasError);
    return this.functionList;
  }

  /** All nodes of an indexed type in the file, in source order. */
  nodes(type: string): readonly Node[] {
    return this.byType.get(type) ?? [];
  }

  /** Nodes of the given types inside `scope` (by position), in source order. */
  within(scope: Node, ...types: string[]): Node[] {
    const out: Node[] = [];
    for (const t of types) {
      const list = this.nodes(t);
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].startIndex < scope.startIndex) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      for (let i = lo; i < list.length && list[i].startIndex < scope.endIndex; i++) {
        if (list[i].endIndex <= scope.endIndex) {
          out.push(list[i]);
        }
      }
    }
    return types.length > 1 ? out.sort((a, b) => a.startIndex - b.startIndex) : out;
  }

  private analysis(fn: Node, mode: Mode, onLazy?: () => void): FunctionAnalysis {
    return new FunctionAnalysis(this.cfgFor(fn), this.environment(mode, onLazy), this.budget, this.modelFor(fn));
  }

  /**
   * A function of this file that never returns: no path reaches its end (an endless loop, or every path calls
   * abort() or another such function). "declared" when it says so (`_Noreturn`, `noreturn` attribute).
   */
  noReturn(name: string): "declared" | "implicit" | undefined {
    const known = this.noReturns.get(name);
    if (known !== undefined) {
      return known === "busy" || known === null ? undefined : known;
    }
    const fn = this.functions.get(name);
    if (!fn || fn.hasError) {
      this.noReturns.set(name, null);
      return undefined;
    }
    this.noReturns.set(name, "busy");
    const cfg = this.cfgFor(fn);
    let never = false;
    if (!cfg.unsupported) {
      const fa = this.analysis(fn, "summary");
      never = fa.solve().ok && fa.stateAt(cfg.exit) === undefined;
    }
    let result: "declared" | "implicit" | null = null;
    if (never) {
      const NORETURN_MARK = /\b_Noreturn\b|\[\[\s*noreturn\s*\]\]|\bnoreturn\b|__attribute__\s*\(\(\s*(__)?noreturn|__declspec\s*\(\s*noreturn/;
      const body = fn.childForFieldName("body");
      const head = body ? fn.text.slice(0, body.startIndex - fn.startIndex) : fn.text;
      const proto = this.nodes("declaration").some((d) => d.parent?.type === "translation_unit" && new RegExp(`\\b${name}\\s*\\(`).test(d.text) && NORETURN_MARK.test(d.text));
      result = NORETURN_MARK.test(head) || proto ? "declared" : "implicit";
    }
    this.noReturns.set(name, result);
    return result ?? undefined;
  }

  /** Parameters and locals of a function (built once, shared by the engine and the coding-rule checks). */
  modelFor(fn: Node): FunctionModel {
    let model = this.models.get(fn.id);
    if (!model) {
      model = new FunctionModel(fn, this.types, this.within(fn, "declaration"), this.within(fn, "pointer_expression"));
      this.models.set(fn.id, model);
    }
    return model;
  }

  cfgFor(fn: Node): Cfg {
    let cfg = this.cfgs.get(fn.id);
    if (!cfg) {
      cfg = buildCfg(fn);
      this.cfgs.set(fn.id, cfg);
    }
    return cfg;
  }

  /** Solves `fn` in check mode (parameters = what callers can pass) and replays it to `observer`. */
  analyze(fn: Node, observer: Observer): FunctionAnalysis {
    return withCache(this.syntax, () => this.analyzeNow(fn, observer));
  }

  /**
   * Runs checks on one function: `run` replays the analysis with its observer and returns its findings.
   * First with summaries not looked up yet (cheaper; can only give more findings, never fewer). Only when
   * that pass used such a value and found something, the function is solved again with the real summaries.
   */
  check<T>(fn: Node, run: (fa: FunctionAnalysis) => T[]): { fa: FunctionAnalysis; results: T[] } {
    return withCache(this.syntax, () => {
      if (this.budget.fileMillis !== undefined && Date.now() - this.started > this.budget.fileMillis) {
        return { fa: this.skipped(fn, "file time budget exceeded"), results: [] };
      }
      let usedLazy = false;
      let fa = this.analysis(fn, "lazy", () => (usedLazy = true));
      let outcome = fa.solve();
      let results: T[] = outcome.ok ? run(fa) : [];
      if (outcome.ok && usedLazy && results.length > 0) {
        fa = this.analysis(fn, "check");
        outcome = fa.solve();
        results = outcome.ok ? run(fa) : [];
      }
      this.count(fa);
      return { fa, results };
    });
  }

  private skipped(fn: Node, reason: string): FunctionAnalysis {
    const fa = this.analysis(fn, "check");
    fa.outcome = { ok: false, reason, visits: 0 };
    this.count(fa);
    return fa;
  }

  private count(fa: FunctionAnalysis): void {
    if (fa.outcome?.ok) {
      this.stats.analyzed++;
    } else if (fa.outcome) {
      this.stats.skipped++;
      this.stats.reasons.set(fa.outcome.reason, (this.stats.reasons.get(fa.outcome.reason) ?? 0) + 1);
    }
  }

  /**
   * First a cheap pass: static objects and same-file calls count as "can be 0, reason not looked up yet".
   * That can only add zero witnesses, never remove one. Only when the function used such a value and some
   * division or dereference then has a witness, the file summaries are computed and the function is
   * solved again with the real values. Most functions never need the summaries.
   */
  private analyzeNow(fn: Node, observer: Observer): FunctionAnalysis {
    if (this.budget.fileMillis !== undefined && Date.now() - this.started > this.budget.fileMillis) {
      const fa = this.analysis(fn, "check");
      fa.outcome = { ok: false, reason: "file time budget exceeded", visits: 0 };
      this.stats.skipped++;
      this.stats.reasons.set(fa.outcome.reason, (this.stats.reasons.get(fa.outcome.reason) ?? 0) + 1);
      return fa;
    }
    let usedLazy = false;
    let fa = this.analysis(fn, "lazy", () => (usedLazy = true));
    let outcome = fa.solve();
    let replayed = false;
    if (outcome.ok && usedLazy) {
      // Replay once, keeping the events: if nothing depends on a summary, they are the final answer.
      let suspicious = false;
      const events: (() => void)[] = [];
      fa.replay({
        division: (op, d, v) => {
          suspicious ||= v.zero !== undefined;
          events.push(() => observer.division?.(op, d, v));
        },
        deref: (at, p, v) => {
          suspicious ||= v.zero !== undefined;
          events.push(() => observer.deref?.(at, p, v));
        },
        read: observer.read ? (at, info, v) => events.push(() => observer.read?.(at, info, v)) : undefined,
        store: observer.store ? (path, v, at) => events.push(() => observer.store?.(path, v, at)) : undefined,
        ret: observer.ret ? (v, at) => events.push(() => observer.ret?.(v, at)) : undefined,
      });
      if (suspicious) {
        fa = this.analysis(fn, "check");
        outcome = fa.solve();
      } else {
        events.forEach((e) => e());
        replayed = true;
      }
    }
    if (outcome.ok) {
      this.stats.analyzed++;
      if (!replayed) {
        fa.replay(observer);
      }
    } else {
      this.stats.skipped++;
      this.stats.reasons.set(outcome.reason, (this.stats.reasons.get(outcome.reason) ?? 0) + 1);
    }
    return fa;
  }

  private environment(mode: Mode, onLazy?: () => void): Environment {
    return {
      types: this.types,
      decls: this.decls,
      macroBody: (name) => this.macroBody(name),
      consts: this.consts,
      isStaticObject: (name) => this.staticObjects.has(name),
      isFunction: (name) => this.functions.has(name) || this.declaredFunctions.has(name),
      noReturn: (name) => this.noReturn(name),
      globalRead: (path) => {
        if (mode === "lazy") {
          onLazy?.();
          return withZero(unknown(), LAZY);
        }
        return mode === "stores" ? undefined : this.globalRead(path);
      },
      // Lazy: a same-file call gives "any value, bounds backed, 0 / NULL possible": a superset of every
      // finding the real summary could give, so the cheap pass never misses one.
      callResult: (name) => {
        if (mode === "stores") {
          return undefined;
        }
        if (mode === "lazy") {
          if (!this.functions.has(name)) {
            return undefined;
          }
          onLazy?.();
          return this.decls.scalarOf(this.decls.returnType(name))?.kind === "ptr" ? LAZY_POINTER : LAZY_RESULT;
        }
        return this.computeReturn(name);
      },
      paramValue: (fnName, info) => {
        if (mode === "summary") {
          // A return value computed from parameters says nothing about one caller's arguments: unbacked bounds.
          return wild(ofType(info.type));
        }
        if (mode === "lazy" && this.usesCallSites(fnName, info)) {
          onLazy?.();
          return this.ownParam(fnName, info);
        }
        return this.paramValue(fnName, info);
      },
    };
  }

  // ---- static objects -----------------------------------------------------------------------------

  private globalRead(path: string): Value | undefined {
    const root = path.split(".")[0];
    // A store to `tasks` (memset, struct copy) also covers `tasks.period_ms`.
    let why: string | undefined;
    for (let p = path; ; p = p.slice(0, p.lastIndexOf("."))) {
      why ??= best(this.storesTo(root, p));
      if (!p.includes(".")) {
        break;
      }
    }
    return withZero(unknown(), why);
  }

  /** Reasons a store in this file can put 0 at `path` (an object path under the static object `root`). */
  private storesTo(root: string, path: string): string[] {
    const out: string[] = [];
    for (const fn of this.functionNodes()) {
      if (!this.writesName(fn, root)) {
        continue;
      }
      for (const why of this.storesOf(fn).get(path) ?? []) {
        if (!out.includes(why)) {
          out.push(why);
        }
      }
    }
    return out;
  }

  /**
   * True when `fn` may write the object `name`: assigns, increments or memsets it, or takes its address or
   * array value (a pointer alias, e.g. `Task *t = &tasks[i]; t->period_ms = p;`). Only those functions
   * are run in store mode.
   */
  private writesName(fn: Node, name: string): boolean {
    let names = this.writes.get(fn.id);
    if (!names) {
      names = new Set();
      for (const n of this.within(fn, "assignment_expression", "update_expression", "pointer_expression", "call_expression", "init_declarator")) {
        const targets: (Node | null)[] = [];
        switch (n.type) {
          case "assignment_expression":
            targets.push(n.childForFieldName("left"), n.childForFieldName("right"));
            break;
          case "update_expression":
            targets.push(n.childForFieldName("argument"));
            break;
          case "pointer_expression":
            if (n.childForFieldName("operator")?.type === "&") {
              targets.push(n.childForFieldName("argument"));
            }
            break;
          case "init_declarator":
            targets.push(n.childForFieldName("value"));
            break;
          case "call_expression":
            if (/^(memset|memcpy|memmove|strcpy|strncpy|__builtin_memset|__builtin_memcpy)$/.test(n.childForFieldName("function")?.text ?? "")) {
              targets.push(n.childForFieldName("arguments")?.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null);
            }
            break;
        }
        for (const t of targets) {
          const r = t ? rootName(t) : undefined;
          if (r) {
            names.add(r);
          }
        }
      }
      this.writes.set(fn.id, names);
    }
    return names.has(name);
  }

  /** Runs one function in store mode (once) and returns what it stores into static objects. */
  private storesOf(fn: Node): Map<string, string[]> {
    const known = this.storesByFunction.get(fn.id);
    if (known) {
      return known;
    }
    const stores = new Map<string, string[]>();
    this.storesByFunction.set(fn.id, stores);
    const fa = this.analysis(fn, "stores");
    if (!fa.solve().ok) {
      return stores;
    }
    fa.replay({
      store: (path, value, at) => {
        if (value.zero !== undefined) {
          const why = value.zero.startsWith("set to 0 by memset") ? value.zero : `${fa.name}() stores ${describe(value.zero)} at line ${at.startPosition.row + 1}`;
          const list = stores.get(path) ?? [];
          if (!list.includes(why)) {
            list.push(why);
          }
          stores.set(path, list);
        }
      },
    });
    return stores;
  }

  // ---- return values ------------------------------------------------------------------------------

  returnSummary(name: string): Value | undefined {
    return withCache(this.syntax, () => this.computeReturn(name));
  }

  private computeReturn(name: string): Value | undefined {
    const known = this.returns.get(name);
    if (known === "busy") {
      return undefined; // recursion: unknown
    }
    if (this.returns.has(name)) {
      return known;
    }
    const fn = this.functions.get(name);
    if (!fn || fn.hasError) {
      return undefined;
    }
    this.returns.set(name, "busy");
    const fa = this.analysis(fn, "summary");
    let result: Value | undefined;
    let all = true;
    if (fa.solve().ok) {
      fa.replay({
        ret: (v) => {
          if (!v) {
            all = false;
            return;
          }
          result = result ? join(result, v) : v;
        },
      });
    }
    if (!all || !result) {
      result = undefined;
    } else if (result.zero !== undefined) {
      result = withZero(result, result.kind === "ptr" ? `${name}() can return NULL` : `${name}() can return 0`);
    }
    this.returns.set(name, result);
    return result;
  }

  // ---- parameters ---------------------------------------------------------------------------------

  private ownParam(fnName: string, info: VarInfo): Value {
    return info.type.kind === "ptr" ? unknown("ptr") : ofType(info.type, `parameter '${info.name}' of ${fnName}()`);
  }

  private usesCallSites(fnName: string, info: VarInfo): boolean {
    return info.type.kind !== "ptr" && this.staticFunctions.has(fnName) && this.constantArgs(fnName) !== null;
  }

  /**
   * A parameter's start value. For a static function used only in direct calls: the join of the argument
   * values over all calls (constants directly, others by solving the caller). Otherwise, or when some
   * argument is unknown: any value of the type, with "the caller can pass 0" as zero witness.
   */
  private paramValue(fnName: string, info: VarInfo): Value {
    const own = this.ownParam(fnName, info);
    if (!this.usesCallSites(fnName, info)) {
      return own;
    }
    const constant = this.constantArgs(fnName)?.[info.index];
    if (constant) {
      return constant;
    }
    let result: Value | undefined;
    for (const call of this.callsTo(fnName)) {
      const v = this.argumentAt(call, info.index);
      if (!v || v.wl || v.wh) {
        return own;
      }
      const caller = enclosingFunctionName(call);
      const named = v.zero !== undefined ? withZero(v, isExactZero(v) ? `${caller}() passes 0` : `${caller}() can pass 0 (${v.zero})`) : v;
      result = result ? join(result, named) : named;
    }
    return result ? { ...result, init: "yes" } : own;
  }

  private callsTo(fnName: string): Node[] {
    this.constantArgs(fnName);
    return (this.identifiersByName?.get(fnName) ?? []).map((id) => id.parent).filter((p): p is Node => p !== null && p.type === "call_expression");
  }

  /** The value of argument `index` at a call, from solving the calling function (once per caller). */
  private argumentAt(call: Node, index: number): Value | undefined {
    let fn: Node | null = call.parent;
    while (fn && fn.type !== "function_definition") {
      fn = fn.parent;
    }
    if (!fn || fn.hasError || this.busyCallers.has(fn.id)) {
      return undefined;
    }
    let calls = this.callsByCaller.get(fn.id);
    if (!calls) {
      calls = new Map();
      this.callsByCaller.set(fn.id, calls);
      this.busyCallers.add(fn.id);
      try {
        const fa = this.analysis(fn, "stores");
        if (fa.solve().ok) {
          const seen = calls;
          fa.replay({
            call: (at, _name, args) => {
              const old = seen.get(at.id);
              seen.set(at.id, old ? old.map((v, i) => (args[i] ? join(v, args[i]) : v)) : args);
            },
          });
        }
      } finally {
        this.busyCallers.delete(fn.id);
      }
    }
    return calls.get(call.id)?.[index];
  }

  /**
   * For a static function used only in direct calls: per parameter index, the join of the constant
   * arguments over all calls (undefined where some call passes a non-constant). Null when not usable.
   */
  private constantArgs(fnName: string): (Value | undefined)[] | null {
    if (this.callerArgs.has(fnName)) {
      return this.callerArgs.get(fnName)!;
    }
    const fn = this.functions.get(fnName)!;
    const decl = fn.childForFieldName("declarator");
    let result: (Value | undefined)[] | null = [];
    let calls = 0;
    if (!this.identifiersByName) {
      this.identifiersByName = new Map();
      for (const id of this.nodes("identifier")) {
        {
          const list = this.identifiersByName.get(id.text) ?? [];
          list.push(id);
          this.identifiersByName.set(id.text, list);
        }
      }
    }
    for (const id of this.identifiersByName.get(fnName) ?? []) {
      if ( (decl && id.startIndex >= decl.startIndex && id.endIndex <= decl.endIndex)) {
        continue;
      }
      const call = id.parent;
      if (call?.type !== "call_expression" || call.childForFieldName("function")?.id !== id.id) {
        // Used as a value (function pointer) or declared again: callers unknown.
        if (call?.type === "function_declarator") {
          continue;
        }
        result = null;
        break;
      }
      calls++;
      const caller = enclosingFunctionName(call);
      const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => a !== null && a.type !== "comment");
      args.forEach((a, i) => {
        if (!result) {
          return;
        }
        const k = numericValue(a, this.consts);
        const v = k === undefined ? undefined : exact(k, Number.isInteger(k) && !/[.]/.test(a.text) ? "int" : "float", k === 0 ? `${caller}() passes 0` : undefined);
        if (calls === 1) {
          result[i] = v;
        } else {
          const old = result[i];
          result[i] = old && v ? join(old, v) : undefined;
        }
      });
    }
    if (calls === 0) {
      result = null;
    }
    this.callerArgs.set(fnName, result);
    return result;
  }
}

function isExactZero(v: Value): boolean {
  return v.lo === 0 && v.hi === 0;
}

function best(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) {
    return undefined;
  }
  // An explicit store (e.g. of an unchecked parameter) explains more than an initial memset.
  return list.find((w) => !w.startsWith("set to 0 by memset")) ?? list[0];
}

function describe(zero: string): string {
  if (zero.startsWith("parameter ")) {
    return `its ${zero.replace(/ of \w+\(\)$/, "")} unchecked`;
  }
  if (zero.startsWith("the constant 0")) {
    return "0";
  }
  return `a value that can be 0 (${zero})`;
}

/** The object an lvalue-like expression starts from: `tasks[i].period_ms` -> tasks, `&wcal` -> wcal. */
function rootName(node: Node): string | undefined {
  let n: Node | null = node;
  while (n) {
    switch (n.type) {
      case "identifier":
        return n.text;
      case "field_expression":
        if (n.childForFieldName("operator")?.type === "->") {
          return undefined;
        }
        n = n.childForFieldName("argument");
        break;
      case "subscript_expression":
        n = n.childForFieldName("argument");
        break;
      case "pointer_expression":
      case "parenthesized_expression":
      case "cast_expression":
        n = n.childForFieldName("argument") ?? n.childForFieldName("value") ?? n.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}

function objectName(d: Node): string | undefined {
  for (let n: Node | null = d; n; n = n.childForFieldName("declarator")) {
    if (n.type === "function_declarator") {
      return undefined;
    }
    if (n.type === "identifier") {
      return n.text;
    }
  }
  return undefined;
}

function enclosingFunctionName(node: Node): string {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    if (n.type === "function_definition") {
      return functionName(n) || "a function";
    }
  }
  return "file scope";
}
