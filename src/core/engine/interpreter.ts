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
import { STRING_FUNCTIONS, StringContext, stringChecks, StringIssueKind } from "./strings";
import { applyDeclarator, CType, Declarations, specifierType } from "./declarations";
import { Typing, widthOf } from "./typing";
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
  noHeap,
  ofType,
  range,
  reshape,
  unknown,
  wild,
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
  readonly decls: Declarations;
  /** Body of an object-like macro (for register macros like `ADC1`). */
  macroBody(name: string): string | undefined;
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
  /** For a function in this file that can never return: whether it is declared so (`_Noreturn`) or only behaves so. */
  noReturn?(name: string): "declared" | "implicit" | undefined;
}

export interface Observer {
  division?(op: Node, divisor: Node, value: Value): void;
  deref?(at: Node, pointer: Node, value: Value): void;
  read?(at: Node, info: VarInfo, value: Value): void;
  store?(path: string, value: Value, at: Node): void;
  ret?(value: Value | undefined, at: Node): void;
  /** Signed integer arithmetic (`+ - *`, unary minus) before conversion, with the C type of the result. */
  arith?(at: Node, value: Value, type: ScalarType): void;
  /** An explicit cast (also `(T)(x)` read as a call) of a value of type `from` (if known) to `to`. */
  cast?(at: Node, value: Value, from: ScalarType | undefined, to: ScalarType): void;
  /** A shift by `amount`; `width` is the bit width of the (promoted) left operand. */
  shift?(at: Node, amount: Value, width: number): void;
  /** An array access `a[i]`: the index, the array length if known, and whether the index has an unsigned type. */
  index?(at: Node, index: Value, length: number | undefined, unsignedIndex: boolean): void;
  /** A memory block copy or fill (memcpy, memset, ...) that ends at `end` (exclusive) in an object of `length` bytes. */
  extent?(at: Node, end: Value, length: number, what: string): void;
  /** `x++`, `x--`, `x += k`, ... on a tracked variable: the value before and the result before conversion. */
  update?(at: Node, info: VarInfo, before: Value, result: Value): void;
  /** An if / loop condition edge: whether this outcome of the condition can happen at all. */
  branch?(cond: Node, truth: boolean, feasible: boolean): void;
  /** A direct call with the argument values. */
  call?(at: Node, name: string, args: readonly Value[]): void;
  /** *p, p->f, p[i] through a pointer to a known memory block, with the block's status (undefined: not tracked). */
  blockUse?(at: Node, pointer: Node, value: Value, status: BlockStatus | undefined): void;
  /** free(p): the block's status before the call, and why the argument is not heap memory (when it is not). */
  release?(at: Node, arg: Node, value: Value, status: BlockStatus | undefined, notHeap: string | undefined): void;
  /** The function ends here while it still owns a block it allocated (nobody else has a pointer to it). */
  leak?(at: Node, block: string, info: BlockInfo | undefined, maybe: boolean): void;
  /** Pointer arithmetic on an array (`a + n`, `&a[i] + n`): the element offset of the result and the array length. */
  pointerOffset?(at: Node, offset: Value, length: number, array: string): void;
  /** An allocation for `element` values (`bytes` each) whose size is not a multiple of the element size. */
  allocSize?(at: Node, size: Node, element: string, bytes: number, constant: number | undefined): void;
  /** `sizeof(p)` of the pointer p, used as the size of the memory p points to. */
  pointerSizeof?(at: Node, sizeofNode: Node, name: string): void;
  /** A path of a function with a return type reaches the end of the body without a return statement. */
  fallOff?(at: Node): void;
  /** A cast to an enum type of a value that may not be one of its constants (`values` sorted). */
  enumCast?(at: Node, value: Value, values: readonly number[], typeName: string): void;
  /** A call to a function of this file that never returns and is not declared that way. */
  noReturnCall?(at: Node, name: string): void;
  /** A problem with a string or format call (see strings.ts). */
  stringIssue?(at: Node, kind: StringIssueKind, message: string, definite: boolean): void;
  /** A call to a floating-point math function (exp, sqrt, log, ...) with the value of its first argument. */
  mathCall?(at: Node, name: string, arg: Value): void;
}

/** Floating-point math functions whose argument range matters. */
const FLOAT_MATH = /^(expf?|expl|exp2f?|sqrtf?|sqrtl|logf?|logl|log10f?|log2f?|acosf?|asinf?|powf?|fabsf?|hypotf?)$/;

/** Where a memory block was allocated. */
export interface BlockInfo {
  readonly what: string;
  readonly line: number;
}

/** Block prefix of a local array (its address dies when its block ends). */
export const SCOPE_BLOCK = "scope:";

const ALLOC = /^(malloc|calloc|realloc|strdup|strndup|aligned_alloc)$/;
/** Library functions that neither keep a pointer argument nor change static objects. */
const PURE_LIB =
  /^(memset|memcpy|memmove|memcmp|memchr|strlen|strnlen|strcmp|strncmp|strcpy|strncpy|strcat|strncat|strchr|strrchr|strstr|printf|fprintf|sprintf|snprintf|vsnprintf|puts|fputs|putchar|abs|labs|fabs|fabsf|sqrt|sqrtf|__builtin_memcpy|__builtin_memset|__builtin_memmove)$/;

export interface Budget {
  /** Maximum number of block visits while solving one function. */
  readonly maxVisits: number;
  /** Wall-clock limit per function, in milliseconds. */
  readonly maxMillis: number;
  /** Wall-clock limit for all functions of one file; later functions are skipped. */
  readonly fileMillis?: number;
}

export const DEFAULT_BUDGET: Budget = { maxVisits: 4000, maxMillis: 60, fileMillis: 1500 };

/** Prefix of pseudo variables for sums of two variables (`addr + len`), learned from conditions. */
export const SUM = "+:";

export function sumKey(a: string, b: string): string {
  return a < b ? SUM + a + ":" + b : SUM + b + ":" + a;
}

/** Fact "x >= e" for a non-constant expression e (`if (v >= res + bit) v -= res + bit;` stays >= 0). */
export function geKey(x: string, exprText: string): string {
  return SUM + ">=" + x + ":" + exprText.replace(/[\s()]/g, "");
}

/** Forgets the facts a variable takes part in (it was assigned). */
function dropSums(st: State, name: string): void {
  let word: RegExp | undefined;
  for (const k of st.vars.keys()) {
    if (k.startsWith(SUM)) {
      word ??= new RegExp("(^|[^A-Za-z0-9_])" + name + "([^A-Za-z0-9_]|$)");
      if (word.test(k.slice(SUM.length))) {
        st.vars.delete(k);
      }
    }
  }
}

/**
 * State of a memory block: allocated here and still owned, freed, freed on some paths only ("maybe"),
 * or handed to someone else (stored in an object, passed to a function, returned): "escaped".
 */
export type BlockStatus = "alloc" | "freed" | "maybe" | "escaped";

function joinStatus(a: BlockStatus, b: BlockStatus): BlockStatus {
  if (a === b) {
    return a;
  }
  return a === "escaped" || b === "escaped" ? "escaped" : "maybe";
}

/** Block prefix of "whatever the static pointer g held when the function started". */
export const ENTRY_BLOCK = "@";

/** Abstract state: one value per tracked variable, or dead (this point cannot be reached). */
export class State {
  constructor(
    readonly vars: Map<string, Value> = new Map(),
    public dead = false,
    /** Status of the memory blocks this function allocated or freed. */
    readonly blocks: Map<string, BlockStatus> = new Map(),
    /** Static pointers assigned in this function: which block they point to now. */
    readonly statics: Map<string, Value> = new Map()
  ) {}

  copy(): State {
    return new State(new Map(this.vars), this.dead, new Map(this.blocks), new Map(this.statics));
  }

  assign(other: State): void {
    this.vars.clear();
    other.vars.forEach((v, k) => this.vars.set(k, v));
    this.blocks.clear();
    other.blocks.forEach((v, k) => this.blocks.set(k, v));
    this.statics.clear();
    other.statics.forEach((v, k) => this.statics.set(k, v));
    this.dead = other.dead;
  }

  /** True when some variable or static pointer still points to the block. */
  holds(block: string): boolean {
    if (block.startsWith(ENTRY_BLOCK)) {
      const s = this.statics.get(block.slice(ENTRY_BLOCK.length));
      if (!s || s.heap === block) {
        return true;
      }
    }
    for (const v of this.vars.values()) {
      if (v.heap === block) {
        return true;
      }
    }
    for (const v of this.statics.values()) {
      if (v.heap === block) {
        return true;
      }
    }
    return false;
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
      if (w) {
        out.vars.set(k, join(v, w));
      } else if (!k.startsWith(SUM)) {
        out.vars.set(k, v);
      }
    });
    a.statics.forEach((v, k) => {
      const w = b.statics.get(k);
      if (w) {
        out.statics.set(k, join(v, w));
      }
    });
    // A block nobody points to any more on one path does not matter on that path.
    for (const k of new Set([...a.blocks.keys(), ...b.blocks.keys()])) {
      const x = a.holds(k) ? a.blocks.get(k) : undefined;
      const y = b.holds(k) ? b.blocks.get(k) : undefined;
      const s = x && y ? joinStatus(x, y) : x ?? y;
      if (s) {
        out.blocks.set(k, s);
      }
    }
    return out;
  }

  equals(other: State): boolean {
    if (this.dead !== other.dead || this.vars.size !== other.vars.size || this.blocks.size !== other.blocks.size || this.statics.size !== other.statics.size) {
      return false;
    }
    for (const [k, v] of this.vars) {
      const w = other.vars.get(k);
      if (!w || !equal(v, w)) {
        return false;
      }
    }
    for (const [k, v] of this.blocks) {
      if (other.blocks.get(k) !== v) {
        return false;
      }
    }
    for (const [k, v] of this.statics) {
      const w = other.statics.get(k);
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
  /** Declared C types of parameters and locals (arrays and structs included). */
  readonly declTypes = new Map<string, CType>();
  /** Locals with automatic storage (not static, not extern, not parameters): their address dies with the call. */
  readonly autoLocals = new Set<string>();
  /** Parameter names (an array parameter is a pointer). */
  readonly params = new Set<string>();

  constructor(
    readonly fn: Node,
    types: TypeTable,
    declarations?: readonly Node[],
    pointerExpressions?: readonly Node[]
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
      if (d) {
        const ct = applyDeclarator(d, specifierType(spec, undefined, p));
        if (ct.name) {
          this.declTypes.set(ct.name, ct.type);
        }
      }
      if (found) {
        this.params.add(found.name);
        seen.set(found.name, (seen.get(found.name) ?? 0) + 1);
        if (found.type) {
          candidates.push({ name: found.name, type: found.type, param: true, index });
        }
      }
      index++;
    }
    const body = fn.childForFieldName("body");
    if (body) {
      for (const decl of declarations ?? body.descendantsOfType("declaration")) {
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
          if (d) {
            const ct = applyDeclarator(d, specifierType(spec, undefined, decl));
            if (ct.name) {
              this.declTypes.set(ct.name, ct.type);
            }
          }
          if (!storage) {
            this.autoLocals.add(found.name);
          }
          seen.set(found.name, (seen.get(found.name) ?? 0) + (storage ? 2 : 1));
          if (found.type && !storage) {
            candidates.push({ name: found.name, type: found.type, param: false, index: -1 });
          }
        }
      }
      // Locals whose address is taken can change behind our back: do not track them.
      for (const amp of pointerExpressions ?? body.descendantsOfType("pointer_expression")) {
        if (amp?.childForFieldName("operator")?.type === "&") {
          const arg = amp.childForFieldName("argument");
          if (arg?.type === "identifier") {
            seen.set(arg.text, 99);
          }
        }
      }
    }
    for (const [name, count] of seen) {
      this.locals.add(name);
      if (count > 1 && count < 99) {
        this.declTypes.delete(name); // declared twice: which one is meant depends on the scope
      }
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
  readonly typing: Typing;
  private inStates: (State | undefined)[] = [];
  private observer: Observer | undefined;
  outcome: Outcome | undefined;
  /** Where each block allocated in this function comes from. */
  readonly blockInfo = new Map<string, BlockInfo>();

  constructor(
    readonly cfg: Cfg,
    private readonly env: Environment,
    private readonly budget: Budget = DEFAULT_BUDGET,
    model?: FunctionModel
  ) {
    this.model = model ?? new FunctionModel(cfg.fn, env.types);
    this.name = cfg.name;
    this.typing = new Typing({ decls: env.decls, locals: this.model.declTypes, hidden: this.model.locals, macroBody: (n) => env.macroBody(n) });
  }

  isKnownFunction(name: string): boolean {
    return this.env.isFunction(name);
  }

  /** True for a variable or object (not a function, not a function pointer) visible in this function. */
  isDataObject(name: string): boolean {
    const isData = (t: CType | undefined): boolean => {
      const r = this.env.decls.resolve(t);
      if (!r || r.k === "func" || r.k === "unknown") {
        return false;
      }
      return !(r.k === "ptr" && this.env.decls.resolve(r.to)?.k === "func");
    };
    if (this.model.locals.has(name)) {
      return isData(this.model.declTypes.get(name));
    }
    if (this.env.isFunction(name)) {
      return false;
    }
    return isData(this.env.decls.varType(name));
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
      entry.vars.set(info.name, info.param ? this.env.paramValue(this.name, info) : { ...wild(ofType(info.type)), init: "no" });
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
    const end = field(this.cfg.fn, "body")?.lastChild ?? this.cfg.fn;
    try {
      this.cfg.blocks.forEach((b, id) => {
        const s = this.inStates[id];
        if (!s) {
          return;
        }
        const out = this.runBlock(id, s.copy());
        // Falling off the end of the function (no return statement): owned blocks are lost here.
        const last = b.items[b.items.length - 1];
        if (!out.dead && b.succ.some((e) => e.to === this.cfg.exit) && last?.kind !== "return" && last?.node.type !== "throw_statement") {
          this.leaks(end, out);
          this.observer?.fallOff?.(end);
        }
        this.edgeStates(b.succ, out);
      });
    } finally {
      this.observer = undefined;
    }
  }

  private widenStates(old: State, next: State): State {
    const j = State.join(old, next);
    const out = new State(new Map(), false, j.blocks, j.statics);
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
        // A returned block that this function allocated and still owns is new memory for the caller.
        const fresh = v?.heap !== undefined && !v.hm && st.blocks.get(v.heap) === "alloc";
        this.leaks(item.node, st, v?.heap);
        if (v) {
          this.escape(v, st);
        }
        this.observer?.ret?.(v && !fresh ? noHeap(v) : v, item.node);
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
        } else if (!st.dead) {
          this.escape(v, st); // kept in something the engine does not track
        }
      } else {
        const name = nameOfDeclarator(d);
        const info = name ? this.model.tracked.get(name) : undefined;
        if (info) {
          st.vars.set(info.name, { ...wild(ofType(info.type)), init: "no" });
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
        if (t && value && !st.dead) {
          this.observer?.cast?.(node, v, this.typing.scalar(value), t);
        }
        if (desc && !st.dead) {
          this.enumCast(node, this.typing.descriptor(desc), text(desc), v);
        }
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
      case "sizeof_expression": {
        const size = this.sizeOf(node);
        return size !== undefined ? exact(size) : range(1, Infinity, "int", undefined, false, true);
      }
      case "alignof_expression":
        return range(1, Infinity, "int", undefined, false, true);
      case "offsetof_expression":
        return range(0, Infinity, "int", undefined, false, true);
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
      // A local array used as a pointer: points to memory that dies when its block ends.
      if (this.model.autoLocals.has(name) && this.model.declTypes.get(name)?.k === "array") {
        return { ...unknown("ptr"), heap: SCOPE_BLOCK + name };
      }
      return unknown();
    }
    if (name === "NULL" || name === "nullptr") {
      return exact(0, "ptr", "NULL");
    }
    const k = this.env.consts?.valueOf(name);
    if (k !== undefined) {
      return exact(k, Number.isInteger(k) ? "int" : "float", k === 0 ? `the constant 0 (${name})` : undefined);
    }
    const e = this.env.decls.enumValue(name);
    if (e !== undefined) {
      return exact(e, "int", e === 0 ? `the constant 0 (${name})` : undefined);
    }
    if (this.env.isStaticObject(name)) {
      return this.staticPointer(name, node, this.typed(node, this.env.globalRead(name) ?? unknown()), st);
    }
    return this.typed(node, unknown());
  }

  /** A read of a static pointer: which block it points to (what this function stored, or what it held at the start). */
  private staticPointer(name: string, node: Node, v: Value, st: State): Value {
    if (this.typing.scalar(node)?.kind !== "ptr") {
      return v;
    }
    const s = st.statics.get(name);
    if (!s) {
      return { ...noHeap(v), heap: ENTRY_BLOCK + name };
    }
    return s.heap !== undefined ? { ...noHeap(v), heap: s.heap, ...(s.hm ? { hm: true as const } : {}) } : noHeap(v);
  }

  /** The block was handed to something the engine does not follow: it is not this function's to free any more. */
  private escape(v: Value, st: State): void {
    const s = v.heap !== undefined ? st.blocks.get(v.heap) : undefined;
    if (v.heap !== undefined && (s === "alloc" || s === "maybe")) {
      st.blocks.set(v.heap, "escaped");
    }
  }

  /** Reports blocks this function allocated and still owns at a return (or at the end of the function). */
  private leaks(at: Node, st: State, returned?: string): void {
    if (!this.observer?.leak) {
      return;
    }
    for (const [block, status] of st.blocks) {
      if (status !== "alloc" || block === returned || block.startsWith(ENTRY_BLOCK)) {
        continue;
      }
      let isNull = false;
      let sure = false;
      for (const v of st.vars.values()) {
        if (v.heap === block) {
          isNull ||= v.hi === 0; // the allocation failed on this path: nothing to free
          sure ||= !v.hm;
        }
      }
      if (!isNull) {
        this.observer.leak(at, block, this.blockInfo.get(block), !sure && [...st.vars.values()].some((v) => v.heap === block));
      }
    }
  }

  /** An unknown value still has its declared type's range (a u8 global is 0..255); the bounds stay unbacked. */
  private typed(node: Node, v: Value): Value {
    if (!v.wl || !v.wh || v.kind !== "int") {
      return v;
    }
    const t = this.typing.scalar(node);
    if (!t || t.kind !== "int" || !Number.isFinite(t.lo) || !Number.isFinite(t.hi)) {
      return v;
    }
    const lo = Math.max(v.lo, t.lo);
    const hi = Math.min(v.hi, t.hi);
    return lo <= hi ? withZero({ ...v, lo, hi }, v.zero) : v;
  }

  /** sizeof of an array of scalars, of a scalar variable or of a scalar type; undefined when unknown. */
  private sizeOf(node: Node): number | undefined {
    const desc = field(node, "type");
    const value = field(node, "value");
    const t = desc ? this.typing.descriptor(desc) : value ? this.typing.of(value) : undefined;
    return this.bytes(t, 0);
  }

  private bytes(t: CType | undefined, depth: number): number | undefined {
    const d = this.env.decls;
    const r = d.resolve(t);
    if (!r || depth > 8) {
      return undefined;
    }
    if (r.k === "array") {
      const n = d.arrayLength(r);
      const e = this.bytes(r.of, depth + 1);
      return n !== undefined && e !== undefined ? n * e : undefined;
    }
    const s = d.scalarOf(r);
    if (!s || s.kind !== "int" || !Number.isFinite(s.hi)) {
      return undefined;
    }
    const w = widthOf(s);
    return w >= 8 ? w / 8 : undefined;
  }

  private unary(node: Node, st: State): Value {
    const op = field(node, "operator")?.type;
    const arg = field(node, "argument");
    const v = arg ? this.eval(arg, st) : unknown();
    switch (op) {
      case "-": {
        const r = range(-v.hi, -v.lo, v.kind, v.zero, !!v.wh, !!v.wl);
        this.signedArith(node, r, st);
        return r;
      }
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
      if ((op === "+" || op === "-") && this.observer?.pointerOffset && (a.kind === "ptr" || b.kind === "ptr" || this.isPointer(left) || this.isPointer(right)) && this.outermostSum(node)) {
        this.pointerArith(node, st);
      }
      if (a.kind === "ptr" || b.kind === "ptr") {
        // Pointer arithmetic: a valid pointer stays valid (going out of bounds is another check's job).
        const p = a.kind === "ptr" ? a : b;
        return op === "-" && a.kind === "ptr" && b.kind === "ptr" ? unknown() : p.lo === 1 ? { ...exact(1, "ptr"), base: p.base } : unknown("ptr");
      }
      if ((op === "<<" || op === ">>") && !st.dead) {
        this.shiftEvent(node, left, b);
      }
      let r = arith(op as BinaryOp, a, b);
      if (op === "*" && left.type === "identifier" && text(left) === text(right)) {
        // x * x is never negative
        const sq = [a.lo * a.lo, a.hi * a.hi].map((x) => (Number.isNaN(x) ? Infinity : x));
        r = range(a.lo <= 0 && a.hi >= 0 ? 0 : Math.min(...sq), Math.max(...sq), r.kind, r.zero, false, !!(a.wl || a.wh));
      }
      if (op === "+" || op === "-" || op === "*") {
        this.signedArith(node, r, st);
      }
      return r;
    }
    return unknown();
  }

  private isPointer(n: Node): boolean {
    const t = this.env.decls.resolve(this.typing.of(n));
    return t?.k === "ptr" || t?.k === "array";
  }

  /** The node is not itself an operand of a larger `p + n` / `p - n`. */
  private outermostSum(node: Node): boolean {
    let p = node.parent;
    while (p?.type === "parenthesized_expression") {
      p = p.parent;
    }
    const op = p?.type === "binary_expression" ? fieldOpt(p, "operator")?.type : undefined;
    return !(p && (op === "+" || op === "-") && this.isPointer(p));
  }

  /** `a + i + 1`, `&a[k] + n - 1`: the element offset from the start of the array `a`, if its length is known. */
  private pointerArith(node: Node, st: State): void {
    const terms: { node: Node; sign: 1 | -1 }[] = [];
    let base: Node | undefined;
    const walk = (n: Node, sign: 1 | -1): boolean => {
      const m = stripParens(n);
      const op = m.type === "binary_expression" ? fieldOpt(m, "operator")?.type : undefined;
      const l = op ? field(m, "left") : null;
      const r = op ? field(m, "right") : null;
      if (l && r && (op === "+" || op === "-")) {
        if (this.isPointer(l)) {
          if (op === "-" && this.isPointer(r)) {
            return false; // p - q: a distance, not a pointer
          }
          terms.push({ node: r, sign: op === "-" ? -sign as 1 | -1 : sign });
          return walk(l, sign);
        }
        if (op === "+" && this.isPointer(r)) {
          terms.push({ node: l, sign });
          return walk(r, sign);
        }
      }
      base = m;
      return sign === 1;
    };
    if (!walk(node, 1) || !base || terms.length === 0) {
      return;
    }
    let array: Node | undefined;
    let offset: Value = exact(0);
    if (base.type === "identifier") {
      array = base;
    } else if (base.type === "pointer_expression" && fieldOpt(base, "operator")?.type === "&") {
      const sub = field(base, "argument");
      const a = sub?.type === "subscript_expression" ? field(sub, "argument") : null;
      const i = sub?.type === "subscript_expression" ? field(sub, "index") : null;
      if (!a || !i) {
        return;
      }
      array = a;
      offset = this.quietEval(i, st);
    }
    if (!array || (array.type === "identifier" && this.model.params.has(text(array)))) {
      return;
    }
    const length = this.env.decls.arrayLength(this.typing.of(array));
    if (length === undefined) {
      return;
    }
    for (const t of terms) {
      offset = arith(t.sign === 1 ? "+" : "-", offset, this.quietEval(t.node, st));
    }
    this.observer?.pointerOffset?.(node, offset, length, text(array));
  }

  /** Value of an expression without side effects on `st` and without reporting events. */
  private quietEval(n: Node, st: State): Value {
    const saved = this.observer;
    this.observer = undefined;
    try {
      return this.eval(n, st.copy());
    } finally {
      this.observer = saved;
    }
  }

  private shiftEvent(node: Node, left: Node, amount: Value): void {
    const lt = this.typing.scalar(left);
    const w = lt && lt.kind === "int" ? widthOf(widthOf(lt) < 32 ? INT : lt) : 0;
    if (w > 0) {
      this.observer?.shift?.(node, amount, w);
    }
  }

  /** Reports signed integer arithmetic to the observer (for overflow), using the expression's C type. */
  private signedArith(node: Node, r: Value, st: State): void {
    if (st.dead || !this.observer?.arith || r.kind !== "int") {
      return;
    }
    const t = this.typing.scalar(node);
    if (t && t.kind === "int" && !t.unsigned && Number.isFinite(t.hi)) {
      this.observer.arith(node, r, t);
    }
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
      if (arithOp === "-" && target.kind === "var" && st.vars.has(geKey(target.info.name, text(right)))) {
        v = clamp(v, 0, Infinity) ?? v; // x >= e held, so x - e >= 0
      }
      if ((arithOp === "<<" || arithOp === ">>") && !st.dead) {
        this.shiftEvent(node, left, r);
      }
      if (target.kind === "var" && !st.dead) {
        this.observer?.update?.(node, target.info, cur, v);
      }
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
    if (target.kind === "var" && cur.kind !== "ptr" && !st.dead) {
      this.observer?.update?.(node, target.info, cur, next);
    }
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
        if (!st.dead && Number.isFinite(t.hi)) {
          this.observer?.cast?.(node, v, this.typing.scalar(args[0]), t);
        }
        if (!st.dead) {
          this.enumCast(node, { k: "named", name: text(inner) }, text(inner), v);
        }
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
    if (name && !st.dead) {
      this.observer?.call?.(node, name, values);
    }
    if (name && !st.dead && !this.model.locals.has(name)) {
      this.pointerSizeofs(node, name, args);
      if (this.observer?.stringIssue && STRING_FUNCTIONS.test(name)) {
        for (const i of stringChecks(this.stringContext(st), node, name, args)) {
          this.observer.stringIssue(i.at, i.kind, i.message, i.definite);
        }
      }
      const math = FLOAT_MATH.exec(name);
      if (math) {
        if (values[0]) {
          this.observer?.mathCall?.(node, name, values[0]);
        }
        // sqrt, exp, fabs, hypot are never negative; the rest is any float
        return /^(sqrt|exp|fabs|hypot)/.test(name) ? range(0, Infinity, "float", undefined, false, true) : unknown("float");
      }
      if (ALLOC.test(name)) {
        return this.allocate(node, name, args, values, st);
      }
      if (name === "free") {
        if (args[0]) {
          this.release(node, args[0], values[0], st);
        }
        return unknown();
      }
      const never = this.env.noReturn?.(name);
      if (never) {
        if (never === "implicit") {
          this.observer?.noReturnCall?.(node, name);
        }
        st.dead = true; // nothing after the call runs
        return unknown();
      }
      if (!PURE_LIB.test(name)) {
        // The callee may keep a pointer argument and may change static pointers.
        values.forEach((v) => this.escape(v, st));
        st.statics.clear();
        for (const k of [...st.blocks.keys()]) {
          if (k.startsWith(ENTRY_BLOCK)) {
            st.blocks.delete(k);
          }
        }
      }
    }
    if (name && /^(memcpy|memmove|memset|__builtin_memcpy|__builtin_memset)$/.test(name) && args.length >= 3 && !st.dead) {
      this.blockExtent(node, name, args, values[2], st);
    }
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
    if (name && /^(ARRAY_LEN|ARRAY_SIZE|COUNT_OF|COUNTOF|NELEMS|NUM_ELEMS|ELEMENTS|_countof)$/i.test(name) && args.length === 1) {
      const n = this.env.decls.arrayLength(this.typing.of(args[0]));
      if (n !== undefined) {
        return exact(n);
      }
    }
    if (name && !this.model.locals.has(name)) {
      const r = this.env.callResult(name);
      if (r?.heap !== undefined && !r.hm && !st.dead) {
        // The callee returns memory it allocated: the caller owns it now.
        const block = `call:${node.id}:${name}`;
        this.blockInfo.set(block, { what: `${name}()`, line: node.startPosition.row + 1 });
        st.blocks.set(block, "alloc");
        return { ...noHeap(this.typed(node, r)), heap: block };
      }
      return this.typed(node, r ? noHeap(r) : unknown());
    }
    return unknown();
  }

  /** What the string and format checks may ask about this function (values without side effects). */
  private stringContext(st: State): StringContext {
    const fd = (() => {
      let d: Node | null = field(this.cfg.fn, "declarator");
      while (d && d.type !== "function_declarator") {
        d = field(d, "declarator");
      }
      return d;
    })();
    return {
      typeOf: (n) => this.typing.of(n),
      scalarOf: (n) => this.typing.scalar(n),
      resolve: (t) => this.env.decls.resolve(t),
      arrayLength: (t) => this.env.decls.arrayLength(t),
      bytes: (t) => this.bytes(t, 0),
      value: (n) => this.quietEval(n, st),
      macroBody: (n) => this.env.macroBody(n),
      variadic: !!fd && /\.\.\./.test(field(fd, "parameters")?.text ?? ""),
    };
  }

  /** `(Mode)x`: reports values outside the range of the enum's constants. */
  private enumCast(node: Node, t: CType, typeName: string, v: Value): void {
    if (!this.observer?.enumCast || v.kind !== "int") {
      return;
    }
    const r = this.env.decls.resolve(t);
    if (r?.k !== "enum" || !r.values) {
      return;
    }
    this.observer.enumCast(node, v, [...r.values].sort((a, b) => a - b), typeName.replace(/\s+/g, " ").trim());
  }

  private allocate(node: Node, name: string, args: readonly Node[], values: readonly Value[], st: State): Value {
    const block = `alloc:${node.id}`;
    this.blockInfo.set(block, { what: `${name}()`, line: node.startPosition.row + 1 });
    if (name === "realloc" && values[0]) {
      this.escape(values[0], st);
    }
    st.blocks.set(block, "alloc");
    this.allocSize(node, name, args);
    return { ...range(0, 1, "ptr", `${name}() returns NULL when no memory is left`), heap: block };
  }

  /** free(p): reports the call, then marks the block freed. */
  private release(node: Node, arg: Node, v: Value | undefined, st: State): void {
    if (!v) {
      return;
    }
    const status = v.heap !== undefined ? st.blocks.get(v.heap) : undefined;
    this.observer?.release?.(node, arg, v, status, this.notHeap(arg, v));
    if (v.heap !== undefined && !v.heap.startsWith(SCOPE_BLOCK) && v.hi !== 0) {
      st.blocks.set(v.heap, v.hm && status !== "freed" ? "maybe" : "freed");
    }
  }

  /** Why the argument of free() is not memory from malloc (an array, an address, a string), if we can tell. */
  private notHeap(arg: Node, v: Value): string | undefined {
    const n = stripCasts(arg);
    if (n.type === "string_literal" || n.type === "concatenated_string") {
      return "a string literal";
    }
    if (n.type === "pointer_expression" && fieldOpt(n, "operator")?.type === "&") {
      return `the address of '${text(field(n, "argument") ?? n)}'`;
    }
    if (n.type === "identifier" && !this.model.params.has(text(n)) && this.env.decls.resolve(this.typing.of(n))?.k === "array") {
      return `the array '${text(n)}'`;
    }
    if (v.base !== undefined) {
      return `a pointer into '${v.base}'`;
    }
    if (v.heap?.startsWith(SCOPE_BLOCK) && !v.hm) {
      return `a pointer to the local array '${v.heap.slice(SCOPE_BLOCK.length)}'`;
    }
    return undefined;
  }

  /** The type a call result is stored as: `(T *)malloc(...)`, `T *p = malloc(...)`, `p = malloc(...)`. */
  private allocTarget(call: Node): { to: CType; name?: string } | undefined {
    let p = call.parent;
    while (p?.type === "parenthesized_expression") {
      p = p.parent;
    }
    const pointee = (t: CType | undefined) => {
      const r = this.env.decls.resolve(t);
      return r?.k === "ptr" ? r.to : undefined;
    };
    if (p?.type === "cast_expression") {
      const desc = field(p, "type");
      const to = desc ? pointee(this.typing.descriptor(desc)) : undefined;
      return to ? { to } : undefined;
    }
    if (p?.type === "init_declarator") {
      const name = nameOfDeclarator(field(p, "declarator"));
      const t = name ? this.model.declTypes.get(name) ?? this.env.decls.varType(name) : undefined;
      const to = pointee(t);
      return to ? { to, name } : undefined;
    }
    if (p?.type === "assignment_expression") {
      const left = field(p, "left");
      const to = left ? pointee(this.typing.of(left)) : undefined;
      return to ? { to, name: left?.type === "identifier" ? text(left) : undefined } : undefined;
    }
    return undefined;
  }

  /** malloc(n) stored as T* where n is not a multiple of sizeof(T) (and has no sizeof in it). */
  private allocSize(node: Node, name: string, args: readonly Node[]): void {
    const size = name === "malloc" ? args[0] : name === "calloc" || name === "realloc" ? args[1] : undefined;
    if (!size || !this.observer?.allocSize || size.type === "sizeof_expression" || size.descendantsOfType("sizeof_expression").length > 0) {
      return;
    }
    const target = this.allocTarget(node);
    const r = target ? this.env.decls.resolve(target.to) : undefined;
    const bytes = target ? this.bytes(target.to, 0) : undefined;
    if (!r || bytes === undefined || bytes <= 1 || (r.k !== "builtin" && r.k !== "named")) {
      return;
    }
    const k = numericValue(size, this.env.consts);
    if (k !== undefined && k % bytes === 0) {
      return;
    }
    const element = target!.to.k === "named" || target!.to.k === "builtin" ? target!.to.name : r.name;
    this.observer.allocSize(node, size, element, bytes, k);
  }

  /** memset(p, 0, sizeof(p)), malloc(sizeof(p)) for p = ...: the size of the pointer instead of the memory. */
  private pointerSizeofs(node: Node, name: string, args: readonly Node[]): void {
    if (!this.observer?.pointerSizeof) {
      return;
    }
    const target = ALLOC.test(name) ? this.allocTarget(node)?.name : undefined;
    for (const a of args) {
      const sizes = a.type === "sizeof_expression" ? [a] : a.descendantsOfType("sizeof_expression").filter((s): s is Node => s !== null);
      for (const s of sizes) {
        const v = field(s, "value");
        const desc = field(s, "type");
        const inner = v ? stripParens(v) : undefined;
        const nm = inner?.type === "identifier" ? text(inner) : desc && /^[A-Za-z_]\w*$/.test(text(desc).trim()) ? text(desc).trim() : undefined;
        if (!nm || this.model.params.has(nm) === false && this.model.locals.has(nm) === false && this.env.decls.varType(nm) === undefined) {
          continue;
        }
        const t = this.env.decls.resolve(this.model.declTypes.get(nm) ?? (this.model.locals.has(nm) ? undefined : this.env.decls.varType(nm)));
        if (t?.k !== "ptr") {
          continue;
        }
        const same = target === nm || args.some((o) => o !== a && stripCasts(o).type === "identifier" && text(stripCasts(o)) === nm);
        if (same) {
          this.observer.pointerSizeof(node, s, nm);
        }
      }
    }
  }

  /** `a.f`, `p->f`, `a[i]`: a read through an object or a pointer. */
  private access(node: Node, st: State): Value {
    const path = this.accessPath(node, st);
    if (st.dead) {
      return unknown();
    }
    return this.typed(node, path ? this.env.globalRead(path) ?? unknown() : unknown());
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
      if (path) {
        return { ...exact(1, "ptr"), base: path };
      }
      const root = rootName(arg);
      return root && this.model.autoLocals.has(root) ? { ...exact(1, "ptr"), heap: SCOPE_BLOCK + root } : exact(1, "ptr");
    }
    const p = this.eval(arg, st);
    this.dereferenced(node, arg, p, st);
    return this.typed(node, p.base ? this.env.globalRead(p.base) ?? unknown() : unknown());
  }

  /** Reports a dereference and remembers that the pointer was not null (it was used). */
  private dereferenced(at: Node, ptr: Node, value: Value, st: State): void {
    if (st.dead) {
      return;
    }
    this.observer?.deref?.(at, ptr, value);
    if (value.heap !== undefined && value.hi !== 0) {
      this.observer?.blockUse?.(at, ptr, value, st.blocks.get(value.heap));
    }
    const name = ptr.type === "identifier" ? text(ptr) : undefined;
    const info = name ? this.model.tracked.get(name) : undefined;
    if (info && value.kind === "ptr" && value.lo === 0) {
      const used: Value = { ...value, lo: 1, hi: 1, zero: undefined };
      st.vars.set(info.name, used);
      sameBlockNullness(st, info.name, used);
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
        const iv = this.eval(index, st);
        if (arg && !st.dead) {
          this.indexed(node, arg, index, iv, st);
        }
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

  /**
   * Reports `a[i]` with the array length when the type knows it. After the access the index is taken to be in
   * bounds (the program went on), so one bad index gives one finding, not one per later use.
   */
  private indexed(at: Node, arrayNode: Node, indexNode: Node, iv: Value, st: State): void {
    const length = this.env.decls.arrayLength(this.typing.of(arrayNode));
    const it = this.typing.scalar(indexNode);
    let p = at.parent;
    while (p?.type === "parenthesized_expression") {
      p = p.parent;
    }
    const addressOnly = p?.type === "pointer_expression" && fieldOpt(p, "operator")?.type === "&";
    this.observer?.index?.(at, iv, length === undefined ? undefined : addressOnly ? length + 1 : length, !!it && it.kind === "int" && it.unsigned);
    const name = targetName(indexNode);
    const info = name ? this.model.tracked.get(name) : undefined;
    if (info && length !== undefined) {
      const v = st.vars.get(info.name);
      const inside = v ? clamp(v, 0, length - 1) : undefined;
      if (inside) {
        st.vars.set(info.name, inside);
      }
    }
  }

  /** memcpy / memset / ... : the end of the block in the destination and source, against their lengths. */
  private blockExtent(at: Node, fn: string, args: readonly Node[], len: Value, st: State): void {
    const lenName = targetName(args[2]);
    const regions = fn.includes("memset") ? [args[0]] : [args[0], args[1]];
    for (const r of regions) {
      const region = this.region(r, st);
      if (!region) {
        continue;
      }
      let end = arith("+", region.offset, len);
      if (region.offsetName && lenName) {
        const sum = st.vars.get(sumKey(region.offsetName, lenName));
        if (sum) {
          end = sum;
        }
      }
      this.observer?.extent?.(at, end, region.length, r === args[0] ? "destination" : "source");
    }
  }

  /** `arr` -> (length, offset 0); `&arr[i]` -> (length, offset i). Only byte arrays (the length counts bytes). */
  private region(node: Node, st: State): { length: number; offset: Value; offsetName?: string } | undefined {
    let n: Node = node;
    for (;;) {
      if (n.type === "cast_expression") {
        const v = field(n, "value");
        if (!v) {
          return undefined;
        }
        n = v;
      } else if (n.type === "parenthesized_expression") {
        const inner = innerExpression(n);
        if (!inner || inner === n) {
          return undefined;
        }
        n = inner;
      } else {
        break;
      }
    }
    if (n.type === "subscript_expression") {
      return undefined; // a row of a 2-D array: copies across rows are common; the whole object is bigger
    }
    let arr = n;
    let offset: Value = exact(0);
    let offsetName: string | undefined;
    if (n.type === "pointer_expression" && fieldOpt(n, "operator")?.type === "&") {
      const sub = field(n, "argument");
      if (sub?.type !== "subscript_expression") {
        return undefined;
      }
      const a = field(sub, "argument");
      const i = field(sub, "index");
      if (!a || !i) {
        return undefined;
      }
      arr = a;
      offsetName = targetName(i);
      const known = offsetName && this.model.tracked.has(offsetName) ? st.vars.get(offsetName) : undefined;
      offset = known ?? unknown();
    }
    const t = this.typing.of(arr);
    const length = this.env.decls.arrayLength(t);
    const el = this.env.decls.scalarOf(this.typing.element(t));
    if (length === undefined || !el || el.kind !== "int" || widthOf(el) !== 8) {
      return undefined;
    }
    return { length, offset, offsetName };
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
      dropSums(st, target.info.name);
      return stored;
    }
    if (target.kind === "global") {
      this.observer?.store?.(target.path, v, at);
      const left = at.type === "assignment_expression" ? field(at, "left") : at.type === "update_expression" ? field(at, "argument") : null;
      if (!target.path.includes(".") && (v.heap !== undefined || (left && this.typing.scalar(left)?.kind === "ptr"))) {
        st.statics.set(target.path, v);
      }
    }
    this.escape(v, st); // stored in a static object, a field or an element: someone else may free it
    return v;
  }

  // ---- conditions ---------------------------------------------------------------------------------

  /** The state on each outgoing edge. An if's two edges share one evaluation of the condition. */
  private edgeStates(succ: readonly { assume?: Assume }[], out: State): State[] {
    if (succ.length === 2) {
      const [x, y] = succ;
      if (x.assume?.kind === "cond" && y.assume?.kind === "cond" && x.assume.node.id === y.assume.node.id && x.assume.truth !== y.assume.truth) {
        const [t, f] = this.assumeBoth(x.assume.node, out);
        if (this.observer?.branch && !out.dead) {
          this.observer.branch(x.assume.node, true, !t.dead);
          this.observer.branch(x.assume.node, false, !f.dead);
        }
        return x.assume.truth ? [t, f] : [f, t];
      }
    }
    return succ.map((e) => {
      const st = e.assume ? this.applyAssume(e.assume, out) : out.copy();
      if (e.assume?.kind === "cond" && !out.dead) {
        this.observer?.branch?.(e.assume.node, e.assume.truth, !st.dead);
      }
      return st;
    });
  }

  /** A compile-time integer: literal, macro or enum constant. */
  private constantOf(node: Node): number | undefined {
    const k = numericValue(node, this.env.consts);
    if (k !== undefined) {
      return k;
    }
    const n = innerExpression(node) ?? node;
    return n.type === "identifier" && !this.model.locals.has(text(n)) ? this.env.decls.enumValue(text(n)) : undefined;
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
    const x = targetName(left);
    const y = targetName(right);
    if (x && this.model.tracked.has(x) && (cmp === ">=" || cmp === ">") && right.type !== "number_literal" && this.constantOf(right) === undefined) {
      s.vars.set(geKey(x, text(right)), exact(1));
    } else if (y && this.model.tracked.has(y) && (cmp === "<=" || cmp === "<") && left.type !== "number_literal" && this.constantOf(left) === undefined) {
      s.vars.set(geKey(y, text(left)), exact(1));
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
    let n: Node = node;
    while (n.type === "parenthesized_expression") {
      const inner = innerExpression(n);
      if (!inner || inner.id === n.id) {
        break;
      }
      n = inner;
    }
    // `(u32)x < k`: a cast to an unsigned type that is below k means 0 <= x < k for a signed x.
    if (n.type === "cast_expression") {
      const value = field(n, "value");
      const desc = field(n, "type");
      const t = desc ? this.env.types.ofDescriptor(desc) : undefined;
      if (value && t && t.kind === "int" && t.unsigned) {
        if (cmp === "<" || cmp === "<=" || cmp === "==") {
          this.narrow(value, cmp, other, s);
          this.narrow(value, ">=", exact(0), s);
        } else if (cmp === "!=") {
          this.narrow(value, cmp, other, s);
        }
      }
      return;
    }
    if (n.type === "binary_expression") {
      const op = fieldOpt(n, "operator")?.type;
      const l = field(n, "left");
      const r = field(n, "right");
      if (l && r && (op === "+" || op === "-")) {
        const k = this.constantOf(r);
        if (k !== undefined) {
          // x + k <cmp> v  ->  x <cmp> v - k ;  x - k <cmp> v  ->  x <cmp> v + k
          this.narrow(l, cmp, arith(op === "+" ? "-" : "+", other, exact(k)), s);
          return;
        }
        const kl = this.constantOf(l);
        if (kl !== undefined && op === "+") {
          this.narrow(r, cmp, arith("-", other, exact(kl)), s);
          return;
        }
        const a = targetName(stripCasts(l));
        const b = targetName(stripCasts(r));
        if (op === "+" && a && b && this.model.tracked.has(a) && this.model.tracked.has(b) && (cmp === "<" || cmp === "<=")) {
          // x + y <= K: remember the sum, and bound each side by K minus the other's lower bound.
          const key = sumKey(a, b);
          const va = s.vars.get(a)!;
          const vb = s.vars.get(b)!;
          const sum = s.vars.get(key) ?? arith("+", va, vb);
          const hi = cmp === "<" ? other.hi - 1 : other.hi;
          const next = clamp(sum, -Infinity, hi, false, !!other.wh);
          if (!next) {
            s.dead = true;
            return;
          }
          s.vars.set(key, next);
          this.narrow(l, "<=", arith("-", range(next.lo, next.hi, "int", undefined, !!next.wl, !!next.wh), exact(vb.lo)), s);
          this.narrow(r, "<=", arith("-", range(next.lo, next.hi, "int", undefined, !!next.wl, !!next.wh), exact(va.lo)), s);
          return;
        }
      }
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
    if ((v.kind === "ptr" || other.kind === "ptr") && cmp !== "==" && cmp !== "!=") {
      return; // p < end says nothing about null
    }
    const step = v.kind === "float" || other.kind === "float" ? Number.MIN_VALUE : 1;
    let next: Value | undefined = v;
    switch (cmp) {
      case "<":
        next = clamp(v, -Infinity, other.hi - step, false, !!other.wh);
        next = next && other.wh ? { ...next, wh: true } : next;
        break;
      case "<=":
        next = clamp(v, -Infinity, other.hi, false, !!other.wh);
        next = next && other.wh ? { ...next, wh: true } : next;
        break;
      case ">":
        next = clamp(v, other.lo + step, Infinity, !!other.wl, false);
        next = next && other.wl ? { ...next, wl: true } : next;
        break;
      case ">=":
        next = clamp(v, other.lo, Infinity, !!other.wl, false);
        next = next && other.wl ? { ...next, wl: true } : next;
        break;
      case "==":
        next = clamp(v, other.lo, other.hi, !!other.wl, !!other.wh);
        break;
      case "!=":
        if (other.lo === other.hi) {
          const k = other.lo;
          if (v.lo === k && v.hi === k) {
            next = undefined;
          } else if (v.lo === k) {
            next = reshape(v, step === 1 ? k + 1 : k === 0 ? Number.MIN_VALUE : k, v.hi);
          } else if (v.hi === k) {
            next = reshape(v, v.lo, step === 1 ? k - 1 : k === 0 ? -Number.MIN_VALUE : k);
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
    if (v.kind === "ptr") {
      sameBlockNullness(s, info.name, s.vars.get(info.name)!);
    }
  }
}

/** Copies of a pointer to the same block (`q = p`) are NULL exactly when p is: `if (p == NULL)` narrows them too. */
function sameBlockNullness(s: State, name: string, v: Value): void {
  if (v.heap === undefined || v.hm) {
    return;
  }
  for (const [k, w] of s.vars) {
    if (k !== name && w.heap === v.heap && !w.hm && (w.lo !== v.lo || w.hi !== v.hi)) {
      const n = clamp(w, v.lo, v.hi);
      if (n) {
        s.vars.set(k, v.lo > 0 ? withZero(n, undefined) : n);
      }
    }
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
function stripCasts(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === "cast_expression") {
      const v = field(n, "value");
      if (!v) {
        return n;
      }
      n = v;
    } else if (n.type === "parenthesized_expression") {
      const inner = innerExpression(n);
      if (!inner || inner.id === n.id) {
        return n;
      }
      n = inner;
    } else {
      return n;
    }
  }
}

function stripParens(node: Node): Node {
  let n = node;
  while (n.type === "parenthesized_expression") {
    const inner = innerExpression(n);
    if (!inner || inner.id === n.id) {
      break;
    }
    n = inner;
  }
  return n;
}

/** The variable an object expression is part of: `x`, `x[i]`, `x.f`. */
function rootName(node: Node): string | undefined {
  let n: Node | null = node;
  while (n) {
    if (n.type === "identifier") {
      return text(n);
    }
    if (n.type === "subscript_expression" || (n.type === "field_expression" && fieldOpt(n, "operator")?.type === ".")) {
      n = field(n, "argument");
    } else if (n.type === "parenthesized_expression") {
      n = innerExpression(n) ?? null;
    } else {
      return undefined;
    }
  }
  return undefined;
}

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
