// Abstract interpreter: runs one function's control-flow graph over abstract values until nothing changes
// (a fixed point; loops are widened after a few rounds), then replays it once so checks can observe
// every division, dereference, read, store and return with the values that hold there.
//
// Tracked: the function's scalar parameters and locals (integers, floats, pointers). Not tracked (always
// "unknown", which never leads to a finding): arrays, structs, locals whose address is taken, names
// declared twice, and everything outside the function unless the file summary (see summaries.ts) knows more.

import { Node } from "web-tree-sitter";
import { ConstantLookup, numericValue } from "../checks/syntax";
import { Assume, Cfg, Item } from "./cfg";
import { field, fieldOpt, named, text } from "./syntaxCache";
import { FLOAT, INT, POINTER, ScalarType, TypeTable, UNKNOWN_INT } from "./types";
import {
  arith,
  BinaryOp,
  clamp,
  containsZero,
  convert,
  equal,
  exact,
  isExact,
  join,
  ofType,
  range,
  unknown,
  Value,
  widen,
  withZero,
} from "./value";

export interface VarInfo {
  readonly name: string;
  readonly type: ScalarType;
  readonly param: boolean;
  readonly index: number;
}

/** What the function can see beyond its own variables. */
export interface Environment {
  readonly types: TypeTable;
  readonly consts?: ConstantLookup;
  /** Value of a read from a file-level static object (`g`, `tab[i].f`), or undefined for "unknown". */
  globalRead(path: string): Value | undefined;
  isStaticObject(name: string): boolean;
  /** True for functions defined or declared in this file. */
  isFunction(name: string): boolean;
  /** Value returned by a call to `name`, or undefined for "unknown". */
  callResult(name: string): Value | undefined;
  /** Start value of a parameter. */
  paramValue(fnName: string, info: VarInfo): Value;
}

export interface Observer {
  division?(op: Node, divisor: Node, value: Value): void;
  deref?(at: Node, pointer: Node, value: Value): void;
  read?(at: Node, info: VarInfo, value: Value): void;
  store?(path: string, value: Value, at: Node): void;
  ret?(value: Value | undefined, at: Node): void;
}

export interface Budget {
  /** Maximum number of block visits while solving one function. */
  readonly maxVisits: number;
  /** Wall-clock limit per function, in milliseconds. */
  readonly maxMillis: number;
  /** Wall-clock limit for all functions of one file; later functions are skipped. */
  readonly fileMillis?: number;
}

export const DEFAULT_BUDGET: Budget = { maxVisits: 4000, maxMillis: 60, fileMillis: 1500 };

/** Abstract state: one value per tracked variable, or dead (this point cannot be reached). */
export class State {
  constructor(
    readonly vars: Map<string, Value> = new Map(),
    public dead = false
  ) {}

  copy(): State {
    return new State(new Map(this.vars), this.dead);
  }

  assign(other: State): void {
    this.vars.clear();
    other.vars.forEach((v, k) => this.vars.set(k, v));
    this.dead = other.dead;
  }

  static join(a: State, b: State): State {
    if (a.dead) {
      return b.copy();
    }
    if (b.dead) {
      return a.copy();
    }
    const out = new State();
    a.vars.forEach((v, k) => {
      const w = b.vars.get(k);
      out.vars.set(k, w ? join(v, w) : v);
    });
    return out;
  }

  equals(other: State): boolean {
    if (this.dead !== other.dead || this.vars.size !== other.vars.size) {
      return false;
    }
    for (const [k, v] of this.vars) {
      const w = other.vars.get(k);
      if (!w || !equal(v, w)) {
        return false;
      }
    }
    return true;
  }
}

/** Parameters and locals of a function, and which of them the engine tracks. */
export class FunctionModel {
  readonly tracked = new Map<string, VarInfo>();
  /** Every name declared in the function (tracked or not): these hide file-level objects. */
  readonly locals = new Set<string>();
  readonly returnType: ScalarType | undefined;

  constructor(
    readonly fn: Node,
    types: TypeTable
  ) {
    const seen = new Map<string, number>();
    const candidates: VarInfo[] = [];
    const declarator = fn.childForFieldName("declarator");
    let fd: Node | null = declarator;
    let returnsPointer = false;
    while (fd && fd.type !== "function_declarator") {
      if (fd.type === "pointer_declarator") {
        returnsPointer = true;
      }
      fd = fd.childForFieldName("declarator");
    }
    const retSpec = fn.childForFieldName("type");
    this.returnType = returnsPointer ? POINTER : retSpec ? types.ofSpecifier(retSpec) : undefined;
    if (retSpec?.text === "void" && !returnsPointer) {
      this.returnType = undefined;
    }
    const params = fd?.childForFieldName("parameters")?.namedChildren ?? [];
    let index = 0;
    for (const p of params) {
      if (!p || (p.type !== "parameter_declaration" && p.type !== "optional_parameter_declaration")) {
        continue;
      }
      const d = p.childForFieldName("declarator");
      const spec = p.childForFieldName("type");
      const found = d ? declaredScalar(d, spec ? types.ofSpecifier(spec) : undefined) : undefined;
      if (found) {
        seen.set(found.name, (seen.get(found.name) ?? 0) + 1);
        if (found.type) {
          candidates.push({ name: found.name, type: found.type, param: true, index });
        }
      }
      index++;
    }
    const body = fn.childForFieldName("body");
    if (body) {
      for (const decl of body.descendantsOfType("declaration")) {
        if (!decl) {
          continue;
        }
        const storage = decl.namedChildren.some((c) => c?.type === "storage_class_specifier" && /static|extern/.test(c.text));
        const spec = decl.childForFieldName("type");
        const base = spec ? types.ofSpecifier(spec) : undefined;
        for (const d of decl.childrenForFieldName("declarator")) {
          const inner = d?.type === "init_declarator" ? d.childForFieldName("declarator") : d;
          const found = inner ? declaredScalar(inner, base) : undefined;
          if (!found) {
            continue;
          }
          seen.set(found.name, (seen.get(found.name) ?? 0) + (storage ? 2 : 1));
          if (found.type && !storage) {
            candidates.push({ name: found.name, type: found.type, param: false, index: -1 });
          }
        }
      }
      // Locals whose address is taken can change behind our back: do not track them.
      for (const amp of body.descendantsOfType("pointer_expression")) {
        if (amp?.childForFieldName("operator")?.type === "&") {
          const arg = amp.childForFieldName("argument");
          if (arg?.type === "identifier") {
            seen.set(arg.text, 99);
          }
        }
      }
    }
    for (const name of seen.keys()) {
      this.locals.add(name);
    }
    for (const c of candidates) {
      if (seen.get(c.name) === 1) {
        this.tracked.set(c.name, c);
      }
    }
  }
}

/** For a declarator: the declared name and its scalar type (undefined type = array/struct: not tracked). */
function declaredScalar(d: Node, base: ScalarType | undefined): { name: string; type: ScalarType | undefined } | undefined {
  let n: Node | null = d;
  let pointer = false;
  let array = false;
  while (n && n.type !== "identifier") {
    if (n.type === "pointer_declarator") {
      pointer = true;
    } else if (n.type === "array_declarator") {
      array = true;
    } else if (n.type === "function_declarator") {
      return undefined;
    } else if (n.type === "reference_declarator") {
      array = true; // C++ references alias other objects: not tracked
    }
    const next: Node | null = n.childForFieldName("declarator") ?? n.namedChildren.find((c) => c !== null && /declarator|identifier/.test(c.type)) ?? null;
    n = next;
  }
  if (!n) {
    return undefined;
  }
  if (array) {
    return { name: n.text, type: undefined };
  }
  return { name: n.text, type: pointer ? POINTER : base };
}

export type Outcome = { readonly ok: true; readonly visits: number } | { readonly ok: false; readonly reason: string; readonly visits: number };

const WIDEN_AFTER = 3;
const NORETURN = /^(exit|_Exit|abort|quick_exit|__builtin_unreachable|__builtin_trap|std::abort|std::exit|std::terminate)$/;

type Cmp = "==" | "!=" | "<" | "<=" | ">" | ">=";
const CMP = new Set(["==", "!=", "<", "<=", ">", ">="]);
const ARITH = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"]);
const MIRROR: Record<Cmp, Cmp> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
const NEGATE: Record<Cmp, Cmp> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" };

export class FunctionAnalysis {
  readonly model: FunctionModel;
  readonly name: string;
  private inStates: (State | undefined)[] = [];
  private observer: Observer | undefined;
  outcome: Outcome | undefined;

  constructor(
    readonly cfg: Cfg,
    private readonly env: Environment,
    private readonly budget: Budget = DEFAULT_BUDGET,
    model?: FunctionModel
  ) {
    this.model = model ?? new FunctionModel(cfg.fn, env.types);
    this.name = cfg.name;
  }

  /** The state at the start of a block after solving (undefined: never reached). */
  stateAt(block: number): State | undefined {
    return this.inStates[block];
  }

  solve(): Outcome {
    if (this.cfg.unsupported) {
      this.outcome = { ok: false, reason: this.cfg.unsupported, visits: 0 };
      return this.outcome;
    }
    const start = Date.now();
    const entry = new State();
    for (const info of this.model.tracked.values()) {
      entry.vars.set(info.name, info.param ? this.env.paramValue(this.name, info) : { ...ofType(info.type), init: "no" });
    }
    const blocks = this.cfg.blocks;
    this.inStates = new Array(blocks.length).fill(undefined);
    this.inStates[this.cfg.entry] = entry;
    const visits = new Array<number>(blocks.length).fill(0);
    const queued = new Set<number>([this.cfg.entry]);
    let total = 0;
    while (queued.size > 0) {
      const id = Math.min(...queued);
      queued.delete(id);
      total++;
      if (total > this.budget.maxVisits || ((total & 63) === 0 && Date.now() - start > this.budget.maxMillis)) {
        this.outcome = { ok: false, reason: "time budget exceeded", visits: total };
        return this.outcome;
      }
      visits[id]++;
      const out = this.runBlock(id, this.inStates[id]!.copy());
      const succ = blocks[id].succ;
      const states = this.edgeStates(succ, out);
      for (let i = 0; i < succ.length; i++) {
        const e = succ[i];
        const s = states[i];
        if (s.dead) {
          continue;
        }
        const old = this.inStates[e.to];
        let next: State;
        if (!old) {
          next = s;
        } else if (this.cfg.loopHeads.has(e.to) && visits[e.to] >= WIDEN_AFTER) {
          next = this.widenStates(old, s);
        } else {
          next = State.join(old, s);
        }
        if (!old || !old.equals(next)) {
          this.inStates[e.to] = next;
          queued.add(e.to);
        }
      }
    }
    this.outcome = { ok: true, visits: total };
    return this.outcome;
  }

  /** Re-runs every reachable block once with the solved states, reporting to the observer. */
  replay(observer: Observer): void {
    if (!this.outcome?.ok) {
      return;
    }
    this.observer = observer;
    try {
      this.cfg.blocks.forEach((b, id) => {
        const s = this.inStates[id];
        if (!s) {
          return;
        }
        const out = this.runBlock(id, s.copy());
        this.edgeStates(b.succ, out);
      });
    } finally {
      this.observer = undefined;
    }
  }

  private widenStates(old: State, next: State): State {
    const j = State.join(old, next);
    const out = new State();
    j.vars.forEach((v, k) => {
      const o = old.vars.get(k);
      const info = this.model.tracked.get(k);
      out.vars.set(k, o && info ? widen(o, v, info.type) : v);
    });
    return out;
  }

  private runBlock(id: number, st: State): State {
    for (const item of this.cfg.blocks[id].items) {
      if (st.dead) {
        break;
      }
      this.runItem(item, st);
    }
    return st;
  }

  private runItem(item: Item, st: State): void {
    if (item.kind === "return") {
      let v = item.value ? this.eval(item.value, st) : undefined;
      if (v && this.model.returnType) {
        v = convert(v, this.model.returnType);
      }
      if (!st.dead) {
        this.observer?.ret?.(v, item.node);
      }
      return;
    }
    const node = item.node;
    if (node.type === "expression_statement" || node.type === "throw_statement") {
      for (const c of named(node)) {
        if (c && c.type !== "comment") {
          this.eval(c, st);
        }
      }
    } else if (node.type === "declaration") {
      this.declare(node, st);
    } else {
      this.eval(node, st);
    }
  }

  private declare(decl: Node, st: State): void {
    for (const d of decl.childrenForFieldName("declarator")) {
      if (!d) {
        continue;
      }
      if (d.type === "init_declarator") {
        const value = field(d, "value");
        const name = nameOfDeclarator(field(d, "declarator"));
        const v = value ? this.eval(value, st) : unknown();
        const info = name ? this.model.tracked.get(name) : undefined;
        if (info && value?.type !== "initializer_list" && !st.dead) {
          st.vars.set(info.name, { ...convert(v, info.type), init: "yes" });
        }
      } else {
        const name = nameOfDeclarator(d);
        const info = name ? this.model.tracked.get(name) : undefined;
        if (info) {
          st.vars.set(info.name, { ...ofType(info.type), init: "no" });
        }
      }
    }
  }

  // ---- expressions --------------------------------------------------------------------------------

  /** Evaluates an expression: returns its value and applies its side effects to `st`. */
  eval(node: Node, st: State): Value {
    if (st.dead) {
      return unknown();
    }
    switch (node.type) {
      case "number_literal": {
        const k = numericValue(node);
        if (k === undefined) {
          return unknown();
        }
        const isFloat = !/^0[xXbB]/.test(text(node)) && /[.eEfF]/.test(text(node).replace(/[uUlL]+$/, ""));
        return exact(k, isFloat ? "float" : "int", k === 0 ? "the constant 0" : undefined);
      }
      case "char_literal": {
        const k = charValue(text(node));
        return k === undefined ? range(0, 255) : exact(k, "int", k === 0 ? "the constant 0" : undefined);
      }
      case "string_literal":
      case "concatenated_string":
      case "raw_string_literal":
        return exact(1, "ptr");
      case "true":
        return exact(1);
      case "false":
        return exact(0, "int", "false");
      case "null":
      case "nullptr":
        return exact(0, "ptr", "NULL");
      case "identifier":
        return this.readName(node, st);
      case "parenthesized_expression":
      case "condition_clause": {
        const inner = innerExpression(node);
        return inner ? this.eval(inner, st) : unknown();
      }
      case "cast_expression": {
        const value = field(node, "value");
        const v = value ? this.eval(value, st) : unknown();
        const desc = field(node, "type");
        const t = desc ? this.env.types.ofDescriptor(desc) : undefined;
        return t ? convert(v, t) : unknown();
      }
      case "unary_expression":
        return this.unary(node, st);
      case "binary_expression":
        return this.binary(node, st);
      case "assignment_expression":
        return this.assignment(node, st);
      case "update_expression":
        return this.update(node, st);
      case "conditional_expression":
        return this.conditional(node, st);
      case "comma_expression": {
        const l = field(node, "left");
        const r = field(node, "right");
        if (l) {
          this.eval(l, st);
        }
        return r ? this.eval(r, st) : unknown();
      }
      case "call_expression":
        return this.call(node, st);
      case "field_expression":
      case "subscript_expression":
        return this.access(node, st);
      case "pointer_expression":
        return this.pointer(node, st);
      case "sizeof_expression":
      case "alignof_expression":
      case "offsetof_expression":
        return node.type === "offsetof_expression" ? range(0, Infinity) : range(1, Infinity);
      case "lambda_expression":
        return unknown("ptr");
      case "comment":
        return unknown();
      default:
        for (const c of named(node)) {
          if (c && c.type !== "type_descriptor" && c.type !== "comment") {
            this.eval(c, st);
          }
        }
        return unknown();
    }
  }

  private readName(node: Node, st: State): Value {
    const name = text(node);
    const info = this.model.tracked.get(name);
    if (info) {
      const v = st.vars.get(name) ?? ofType(info.type);
      this.observer?.read?.(node, info, v);
      return v;
    }
    if (this.model.locals.has(name)) {
      return unknown();
    }
    if (name === "NULL" || name === "nullptr") {
      return exact(0, "ptr", "NULL");
    }
    const k = this.env.consts?.valueOf(name);
    if (k !== undefined) {
      return exact(k, Number.isInteger(k) ? "int" : "float", k === 0 ? `the constant 0 (${name})` : undefined);
    }
    if (this.env.isStaticObject(name)) {
      return this.env.globalRead(name) ?? unknown();
    }
    return unknown();
  }

  private unary(node: Node, st: State): Value {
    const op = field(node, "operator")?.type;
    const arg = field(node, "argument");
    const v = arg ? this.eval(arg, st) : unknown();
    switch (op) {
      case "-":
        return withZero({ ...v, lo: -v.hi, hi: -v.lo, base: undefined }, v.zero);
      case "+":
        return v;
      case "!":
        if (isExact(v, 0)) {
          return exact(1);
        }
        return containsZero(v) ? range(0, 1) : exact(0);
      default:
        return unknown();
    }
  }

  private binary(node: Node, st: State): Value {
    const op = field(node, "operator")?.type ?? "";
    const left = field(node, "left");
    const right = field(node, "right");
    if (!left || !right) {
      return unknown();
    }
    if (op === "&&" || op === "||") {
      const t = this.assume(node, true, st);
      const f = this.assume(node, false, st);
      st.assign(State.join(t, f));
      if (t.dead && f.dead) {
        st.dead = true;
      }
      return t.dead ? exact(0) : f.dead ? exact(1) : range(0, 1);
    }
    const a = this.eval(left, st);
    const b = this.eval(right, st);
    if (st.dead) {
      return unknown();
    }
    if (op === "/" || op === "%") {
      this.observer?.division?.(node, right, b);
    }
    if (CMP.has(op)) {
      const [canTrue, canFalse] = compare(op as Cmp, a, b);
      return canTrue && canFalse ? range(0, 1) : canTrue ? exact(1) : exact(0);
    }
    if (ARITH.has(op)) {
      if (a.kind === "ptr" || b.kind === "ptr") {
        // Pointer arithmetic: a valid pointer stays valid (going out of bounds is another check's job).
        const p = a.kind === "ptr" ? a : b;
        return op === "-" && a.kind === "ptr" && b.kind === "ptr" ? unknown() : p.lo === 1 ? { ...exact(1, "ptr"), base: p.base } : unknown("ptr");
      }
      return arith(op as BinaryOp, a, b);
    }
    return unknown();
  }

  private assignment(node: Node, st: State): Value {
    const op = field(node, "operator")?.type ?? "=";
    const left = field(node, "left");
    const right = field(node, "right");
    if (!left || !right) {
      return unknown();
    }
    const target = this.lvalue(left, st);
    const r = this.eval(right, st);
    let v = r;
    if (op !== "=") {
      const cur = this.readLvalue(target, left, st);
      const arithOp = op.slice(0, -1);
      if ((arithOp === "/" || arithOp === "%") && !st.dead) {
        this.observer?.division?.(node, right, r);
      }
      v = ARITH.has(arithOp) && cur.kind !== "ptr" ? arith(arithOp as BinaryOp, cur, r) : unknown(cur.kind);
    }
    return this.write(target, v, node, st);
  }

  private update(node: Node, st: State): Value {
    const arg = field(node, "argument");
    if (!arg) {
      return unknown();
    }
    const op = field(node, "operator")?.type === "--" ? "-" : "+";
    const prefix = node.firstChild?.type === "++" || node.firstChild?.type === "--";
    const target = this.lvalue(arg, st);
    const cur = this.readLvalue(target, arg, st);
    const next = cur.kind === "ptr" ? cur : arith(op, cur, exact(1));
    const stored = this.write(target, next, node, st);
    return prefix ? stored : cur;
  }

  private conditional(node: Node, st: State): Value {
    const cond = field(node, "condition");
    const cons = field(node, "consequence");
    const alt = field(node, "alternative");
    if (!cond || !cons || !alt) {
      return unknown();
    }
    const t = this.assume(cond, true, st);
    const f = this.assume(cond, false, st);
    const vt = this.eval(cons, t);
    const vf = this.eval(alt, f);
    st.assign(State.join(t, f));
    if (t.dead && f.dead) {
      st.dead = true;
      return unknown();
    }
    return t.dead ? vf : f.dead ? vt : join(vt, vf);
  }

  private call(node: Node, st: State): Value {
    const fnNode = field(node, "function");
    const name = fnNode?.type === "identifier" || fnNode?.type === "qualified_identifier" ? text(fnNode) : undefined;
    const args = (field(node, "arguments")?.namedChildren ?? []).filter((a): a is Node => a !== null && a.type !== "comment");
    if (fnNode?.type === "parenthesized_expression" && args.length === 1) {
      // `(u16)(x)`: without the typedef, tree-sitter reads a cast as a call through `(u16)`.
      const inner = innerExpression(fnNode);
      if (inner?.type === "identifier" && !this.model.locals.has(text(inner)) && !this.env.isStaticObject(text(inner)) && !this.env.isFunction(text(inner))) {
        const v = this.eval(args[0], st);
        const t = this.env.types.ofName(text(inner)) ?? UNKNOWN_INT;
        return convert(v, t);
      }
    }
    if (fnNode && !name) {
      this.eval(fnNode, st);
    }
    if (name && /assert/i.test(name) && args.length > 0 && !this.model.locals.has(name)) {
      for (const a of args.slice(1)) {
        this.eval(a, st);
      }
      st.assign(this.assume(args[0], true, st));
      return unknown();
    }
    const values = args.map((a) => this.eval(a, st));
    if (name && NORETURN.test(name)) {
      st.dead = true;
      return unknown();
    }
    if (name && /^(memset|__builtin_memset)$/.test(name) && args.length >= 2) {
      const path = this.objectPath(args[0], st, true);
      if (path && !st.dead) {
        const zero = isExact(values[1], 0);
        this.observer?.store?.(path, zero ? exact(0, "int", `set to 0 by memset() in ${this.name}()`) : unknown(), node);
      }
      return unknown("ptr");
    }
    if (name && /^(memcpy|memmove|strcpy|strncpy|__builtin_memcpy)$/.test(name) && args.length >= 1) {
      const path = this.objectPath(args[0], st, true);
      if (path && !st.dead) {
        this.observer?.store?.(path, unknown(), node);
      }
      return unknown("ptr");
    }
    if (name && !this.model.locals.has(name)) {
      return this.env.callResult(name) ?? unknown();
    }
    return unknown();
  }

  /** `a.f`, `p->f`, `a[i]`: a read through an object or a pointer. */
  private access(node: Node, st: State): Value {
    const path = this.accessPath(node, st);
    if (st.dead) {
      return unknown();
    }
    return path ? this.env.globalRead(path) ?? unknown() : unknown();
  }

  private pointer(node: Node, st: State): Value {
    const op = field(node, "operator")?.type;
    const arg = field(node, "argument");
    if (!arg) {
      return unknown();
    }
    if (op === "&") {
      const path = this.objectPath(arg, st, false);
      if (arg.type !== "identifier") {
        // &a[i], &s.f, &p->f: evaluate the parts (index, pointer) for their effects and checks.
        this.accessPath(arg, st);
      }
      return path ? { ...exact(1, "ptr"), base: path } : exact(1, "ptr");
    }
    const p = this.eval(arg, st);
    this.dereferenced(node, arg, p, st);
    return p.base ? this.env.globalRead(p.base) ?? unknown() : unknown();
  }

  /** Reports a dereference and remembers that the pointer was not null (it was used). */
  private dereferenced(at: Node, ptr: Node, value: Value, st: State): void {
    if (st.dead) {
      return;
    }
    this.observer?.deref?.(at, ptr, value);
    const name = ptr.type === "identifier" ? text(ptr) : undefined;
    const info = name ? this.model.tracked.get(name) : undefined;
    if (info && value.kind === "ptr" && value.lo === 0) {
      st.vars.set(info.name, { ...value, lo: 1, hi: 1, zero: undefined });
    }
  }

  /**
   * The summary path of an access (`tasks.period_ms` for `tasks[i].period_ms` or `t->period_ms` with
   * t -> tasks), evaluating indexes and pointers on the way. Undefined when it is not a static object.
   */
  private accessPath(node: Node, st: State): string | undefined {
    if (node.type === "field_expression") {
      const arg = field(node, "argument");
      const name = fieldOpt(node, "field");
      const member = name ? text(name) : undefined;
      if (!arg || !member) {
        return undefined;
      }
      if (field(node, "operator")?.type === "->") {
        const p = this.eval(arg, st);
        this.dereferenced(node, arg, p, st);
        return p.base ? `${p.base}.${member}` : undefined;
      }
      const base = this.accessPath(arg, st);
      return base ? `${base}.${member}` : undefined;
    }
    if (node.type === "subscript_expression") {
      const arg = field(node, "argument");
      const index = field(node, "index") ?? field(node, "indices");
      if (index) {
        this.eval(index, st);
      }
      if (!arg) {
        return undefined;
      }
      if (arg.type === "identifier" && this.model.tracked.get(text(arg))?.type.kind === "ptr") {
        const p = this.eval(arg, st);
        this.dereferenced(node, arg, p, st);
        return p.base;
      }
      return this.accessPath(arg, st);
    }
    if (node.type === "parenthesized_expression") {
      const inner = innerExpression(node);
      return inner ? this.accessPath(inner, st) : undefined;
    }
    if (node.type === "identifier") {
      return this.staticName(text(node));
    }
    if (node.type === "pointer_expression" && field(node, "operator")?.type === "*") {
      const arg = field(node, "argument");
      if (!arg) {
        return undefined;
      }
      const p = this.eval(arg, st);
      this.dereferenced(node, arg, p, st);
      return p.base;
    }
    this.eval(node, st);
    return undefined;
  }

  /** The static object an expression names or points to (`g`, `&g`, `g.f`, `&tab[i]`), without side effects when `pure`. */
  private objectPath(node: Node, st: State, pure: boolean): string | undefined {
    const n = node.type === "parenthesized_expression" ? innerExpression(node) ?? node : node;
    if (n.type === "identifier") {
      const own = this.staticName(text(n));
      if (own) {
        return own;
      }
      const v = this.model.tracked.get(text(n)) ? st.vars.get(text(n)) : undefined;
      return v?.base;
    }
    if (n.type === "pointer_expression" && field(n, "operator")?.type === "&") {
      const arg = field(n, "argument");
      return arg ? this.objectPath(arg, st, pure) : undefined;
    }
    if (n.type === "field_expression" && field(n, "operator")?.type === ".") {
      const arg = field(n, "argument");
      const base = arg ? this.objectPath(arg, st, pure) : undefined;
      const name = fieldOpt(n, "field");
      const member = name ? text(name) : undefined;
      return base && member ? `${base}.${member}` : undefined;
    }
    if (n.type === "subscript_expression") {
      const arg = field(n, "argument");
      return arg ? this.objectPath(arg, st, pure) : undefined;
    }
    if (n.type === "cast_expression") {
      const v = field(n, "value");
      return v ? this.objectPath(v, st, pure) : undefined;
    }
    return undefined;
  }

  private staticName(name: string): string | undefined {
    return !this.model.locals.has(name) && this.env.isStaticObject(name) ? name : undefined;
  }

  // ---- lvalues --------------------------------------------------------------------------------------

  private lvalue(node: Node, st: State): { kind: "var"; info: VarInfo } | { kind: "global"; path: string } | { kind: "none" } {
    const n = node.type === "parenthesized_expression" ? innerExpression(node) ?? node : node;
    if (n.type === "identifier") {
      const info = this.model.tracked.get(text(n));
      if (info) {
        return { kind: "var", info };
      }
      const path = this.staticName(text(n));
      return path ? { kind: "global", path } : { kind: "none" };
    }
    if (n.type === "field_expression" || n.type === "subscript_expression" || n.type === "pointer_expression") {
      const path = this.accessPath(n, st);
      return path ? { kind: "global", path } : { kind: "none" };
    }
    this.eval(n, st);
    return { kind: "none" };
  }

  private readLvalue(target: ReturnType<FunctionAnalysis["lvalue"]>, node: Node, st: State): Value {
    if (target.kind === "var") {
      const v = st.vars.get(target.info.name) ?? ofType(target.info.type);
      this.observer?.read?.(node, target.info, v);
      return v;
    }
    if (target.kind === "global") {
      return this.env.globalRead(target.path) ?? unknown();
    }
    return unknown();
  }

  private write(target: ReturnType<FunctionAnalysis["lvalue"]>, v: Value, at: Node, st: State): Value {
    if (st.dead) {
      return v;
    }
    if (target.kind === "var") {
      const stored = { ...convert(v, target.info.type), init: "yes" as const };
      st.vars.set(target.info.name, stored);
      return stored;
    }
    if (target.kind === "global") {
      this.observer?.store?.(target.path, v, at);
    }
    return v;
  }

  // ---- conditions ---------------------------------------------------------------------------------

  /** The state on each outgoing edge. An if's two edges share one evaluation of the condition. */
  private edgeStates(succ: readonly { assume?: Assume }[], out: State): State[] {
    if (succ.length === 2) {
      const [x, y] = succ;
      if (x.assume?.kind === "cond" && y.assume?.kind === "cond" && x.assume.node.id === y.assume.node.id && x.assume.truth !== y.assume.truth) {
        const [t, f] = this.assumeBoth(x.assume.node, out);
        return x.assume.truth ? [t, f] : [f, t];
      }
    }
    return succ.map((e) => (e.assume ? this.applyAssume(e.assume, out) : out.copy()));
  }

  /** [state where cond is true, state where it is false], evaluating simple conditions only once. */
  private assumeBoth(cond: Node, st: State): [State, State] {
    if (st.dead) {
      return [st.copy(), st.copy()];
    }
    const n = innerExpression(cond) ?? cond;
    const op = n.type === "binary_expression" ? fieldOpt(n, "operator")?.type ?? "" : "";
    const isNot = n.type === "unary_expression" && fieldOpt(n, "operator")?.type === "!";
    if (n.type === "parenthesized_expression" || n.type === "condition_clause" || isNot || op === "&&" || op === "||") {
      return [this.assume(cond, true, st), this.assume(cond, false, st)];
    }
    const s = st.copy();
    if (CMP.has(op)) {
      const left = field(n, "left");
      const right = field(n, "right");
      if (!left || !right) {
        return [s, s.copy()];
      }
      const a = this.eval(left, s);
      const b = this.eval(right, s);
      if (s.dead) {
        return [s, s.copy()];
      }
      const t = s.copy();
      this.refine(left, right, op as Cmp, a, b, t);
      this.refine(left, right, NEGATE[op as Cmp], a, b, s);
      return [t, s];
    }
    const v = this.eval(n, s);
    if (s.dead) {
      return [s, s.copy()];
    }
    const t = s.copy();
    if (isExact(v, 0)) {
      t.dead = true;
    } else {
      this.narrow(n, "!=", exact(0), t);
    }
    if (!containsZero(v)) {
      s.dead = true;
    } else {
      this.narrow(n, "==", exact(0), s);
    }
    return [t, s];
  }

  /** Narrows both sides with `left <cmp> right` (values a, b), or marks the state dead when impossible. */
  private refine(left: Node, right: Node, cmp: Cmp, a: Value, b: Value, s: State): void {
    if (!compare(cmp, a, b)[0]) {
      s.dead = true;
      return;
    }
    this.narrow(left, cmp, b, s);
    this.narrow(right, MIRROR[cmp], a, s);
  }

  private applyAssume(a: Assume, st: State): State {
    if (a.kind === "cond") {
      return this.assume(a.node, a.truth, st);
    }
    const s = st.copy();
    const subject = innerExpression(a.subject) ?? a.subject;
    const sv = this.eval(subject, s);
    if (a.kind === "case") {
      const cv = this.eval(a.value, s);
      this.narrow(subject, "==", cv, s);
      if (!s.dead && compare("==", sv, cv)[0] === false) {
        s.dead = true;
      }
      return s;
    }
    for (const value of a.values) {
      const cv = this.eval(value, s);
      this.narrow(subject, "!=", cv, s);
    }
    return s;
  }

  /** The state in which `cond` evaluated to `truth` (dead when that cannot happen). Does not change `st`. */
  assume(cond: Node, truth: boolean, st: State): State {
    if (st.dead) {
      return st.copy();
    }
    const n = innerExpression(cond) ?? cond;
    if (n.type === "parenthesized_expression" || n.type === "condition_clause") {
      return this.assume(n, truth, st);
    }
    if (n.type === "unary_expression" && field(n, "operator")?.type === "!") {
      const arg = field(n, "argument");
      return arg ? this.assume(arg, !truth, st) : st.copy();
    }
    if (n.type === "binary_expression") {
      const op = field(n, "operator")?.type ?? "";
      const left = field(n, "left");
      const right = field(n, "right");
      if (left && right && (op === "&&" || op === "||")) {
        const shortCircuit = op === "&&" ? !truth : truth; // the left side alone decides
        const leftDecides = this.assume(left, op === "||", st);
        const goOn = this.assume(left, op === "&&", st);
        const viaRight = this.assume(right, truth, goOn);
        return shortCircuit ? State.join(leftDecides, viaRight) : viaRight;
      }
      if (left && right && CMP.has(op)) {
        const s = st.copy();
        const a = this.eval(left, s);
        const b = this.eval(right, s);
        if (s.dead) {
          return s;
        }
        this.refine(left, right, (truth ? op : NEGATE[op as Cmp]) as Cmp, a, b, s);
        return s;
      }
    }
    // Any other expression: true means "not 0".
    const s = st.copy();
    const v = this.eval(n, s);
    if (s.dead) {
      return s;
    }
    if (truth ? isExact(v, 0) : !containsZero(v)) {
      s.dead = true;
      return s;
    }
    this.narrow(n, truth ? "!=" : "==", exact(0), s);
    return s;
  }

  /** Refines the variable behind `node` (if any) with `node <cmp> other`. */
  private narrow(node: Node, cmp: Cmp, other: Value, s: State): void {
    if (s.dead) {
      return;
    }
    const name = targetName(node);
    const info = name ? this.model.tracked.get(name) : undefined;
    if (!info) {
      return;
    }
    const v = s.vars.get(info.name);
    if (!v) {
      return;
    }
    const step = v.kind === "float" || other.kind === "float" ? Number.MIN_VALUE : 1;
    let next: Value | undefined = v;
    switch (cmp) {
      case "<":
        next = clamp(v, -Infinity, other.hi - step);
        break;
      case "<=":
        next = clamp(v, -Infinity, other.hi);
        break;
      case ">":
        next = clamp(v, other.lo + step, Infinity);
        break;
      case ">=":
        next = clamp(v, other.lo, Infinity);
        break;
      case "==":
        next = clamp(v, other.lo, other.hi);
        if (next && next.kind === "ptr" && other.kind !== "ptr") {
          next = { ...next };
        }
        break;
      case "!=":
        if (other.lo === other.hi) {
          const k = other.lo;
          if (v.lo === k && v.hi === k) {
            next = undefined;
          } else if (v.lo === k) {
            next = { ...v, lo: step === 1 ? k + 1 : k === 0 ? Number.MIN_VALUE : k };
          } else if (v.hi === k) {
            next = { ...v, hi: step === 1 ? k - 1 : k === 0 ? -Number.MIN_VALUE : k };
          }
          if (next && k === 0) {
            next = withZero(next, undefined); // known: not 0
          }
        }
        break;
    }
    if (!next) {
      s.dead = true;
      return;
    }
    s.vars.set(info.name, withZero(next, next.zero));
  }
}

/** Which comparison outcomes are possible: [can be true, can be false]. */
function compare(op: Cmp, a: Value, b: Value): [boolean, boolean] {
  switch (op) {
    case "<":
      return [a.lo < b.hi, a.hi >= b.lo];
    case "<=":
      return [a.lo <= b.hi, a.hi > b.lo];
    case ">":
      return [a.hi > b.lo, a.lo <= b.hi];
    case ">=":
      return [a.hi >= b.lo, a.lo < b.hi];
    case "==": {
      const overlap = a.lo <= b.hi && b.lo <= a.hi;
      const same = a.lo === a.hi && b.lo === b.hi && a.lo === b.lo;
      return [overlap, !same];
    }
    case "!=": {
      const [eq, ne] = compare("==", a, b);
      return [ne, eq];
    }
  }
}

/** The tracked variable a condition operand stands for: `x`, `(x)`, `(x = f())`. */
function targetName(node: Node): string | undefined {
  let n: Node | undefined = node;
  while (n && (n.type === "parenthesized_expression" || n.type === "condition_clause")) {
    n = innerExpression(n);
  }
  if (!n) {
    return undefined;
  }
  if (n.type === "identifier") {
    return text(n);
  }
  if (n.type === "assignment_expression" && field(n, "operator")?.type === "=") {
    const left = field(n, "left");
    return left ? targetName(left) : undefined;
  }
  return undefined;
}

function innerExpression(node: Node): Node | undefined {
  if (node.type === "condition_clause") {
    const value = field(node, "value");
    if (value) {
      return value.type === "declaration" ? undefined : value;
    }
  }
  if (node.type !== "parenthesized_expression" && node.type !== "condition_clause") {
    return node;
  }
  return named(node).find((c) => c !== null && c.type !== "comment") ?? undefined;
}

function nameOfDeclarator(d: Node | null): string | undefined {
  for (let n: Node | null = d; n; n = field(n, "declarator")) {
    if (n.type === "identifier") {
      return text(n);
    }
  }
  return undefined;
}

function charValue(text: string): number | undefined {
  const m = /^[LuU8]*'(.*)'$/s.exec(text);
  if (!m) {
    return undefined;
  }
  const body = m[1];
  if (body.length === 1) {
    return body.charCodeAt(0);
  }
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, "0": 0, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
  if (body.length === 2 && body[0] === "\\" && body[1] in esc) {
    return esc[body[1]];
  }
  if (/^\\x[0-9a-fA-F]+$/.test(body)) {
    return parseInt(body.slice(2), 16);
  }
  if (/^\\[0-7]{1,3}$/.test(body)) {
    return parseInt(body.slice(1), 8);
  }
  return undefined;
}

export { FLOAT, INT, UNKNOWN_INT };
