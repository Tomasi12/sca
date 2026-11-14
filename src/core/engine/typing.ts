// The C type of an expression, as far as SCA can tell: from declarations of locals, parameters, globals,
// struct fields, prototypes, casts and literal suffixes, with C's integer promotions and usual arithmetic
// conversions. Undefined means "not known"; checks that need a type then stay quiet.

import { Node } from "web-tree-sitter";
import { applyDeclarator, CType, Declarations, specifierType } from "./declarations";
import { field, fieldOpt, named, text } from "./syntaxCache";
import { BUILTIN_TYPES, ScalarType } from "./types";

const S32 = BUILTIN_TYPES["int"];
const U32 = BUILTIN_TYPES["unsigned int"];
const S64 = BUILTIN_TYPES["long long"];
const U64 = BUILTIN_TYPES["unsigned long long"];
const FLOAT = BUILTIN_TYPES["double"];

/** Bit width of an integer type from its range. */
export function widthOf(t: ScalarType): number {
  if (t.kind !== "int" || !Number.isFinite(t.hi)) {
    return 0;
  }
  return t.unsigned ? Math.round(Math.log2(t.hi + 1)) : Math.round(Math.log2(t.hi + 1)) + 1;
}

/** Integer promotion: types narrower than int become int. */
export function promote(t: ScalarType): ScalarType {
  if (t.kind !== "int" || !Number.isFinite(t.hi)) {
    return t;
  }
  return widthOf(t) < 32 ? S32 : t;
}

/** The usual arithmetic conversions for a binary operator. */
export function arithmeticType(a: ScalarType, b: ScalarType): ScalarType | undefined {
  if (a.kind === "float" || b.kind === "float") {
    return FLOAT;
  }
  if (a.kind !== "int" || b.kind !== "int" || !Number.isFinite(a.hi) || !Number.isFinite(b.hi)) {
    return undefined;
  }
  const x = promote(a);
  const y = promote(b);
  const w = Math.max(widthOf(x), widthOf(y));
  if (w > 32) {
    return (x.unsigned && widthOf(x) === w) || (y.unsigned && widthOf(y) === w) ? U64 : S64;
  }
  return x.unsigned || y.unsigned ? U32 : S32;
}

export interface TypingContext {
  readonly decls: Declarations;
  /** Declared types of the function's parameters and locals. */
  readonly locals: ReadonlyMap<string, CType>;
  /** Names declared in the function (they hide globals). */
  readonly hidden: ReadonlySet<string>;
  /** Body text of an object-like macro, for `ADC1` -> `(&hw_adc1)`. */
  macroBody(name: string): string | undefined;
}

export class Typing {
  private readonly cache = new Map<number, CType | undefined>();

  constructor(private readonly ctx: TypingContext) {}

  get decls(): Declarations {
    return this.ctx.decls;
  }

  /** Scalar type of an expression after integer promotion of narrow types is NOT applied (declared type). */
  scalar(node: Node): ScalarType | undefined {
    return this.ctx.decls.scalarOf(this.of(node));
  }

  /** The C type of an expression. */
  of(node: Node): CType | undefined {
    if (this.cache.has(node.id)) {
      return this.cache.get(node.id);
    }
    const t = this.compute(node);
    this.cache.set(node.id, t);
    return t;
  }

  /** What a pointer or array points to / contains. */
  element(t: CType | undefined): CType | undefined {
    const r = this.ctx.decls.resolve(t);
    return r?.k === "ptr" ? r.to : r?.k === "array" ? r.of : undefined;
  }

  descriptor(desc: Node): CType {
    const base = specifierType(fieldOpt(desc, "type"), undefined, desc);
    const d = fieldOpt(desc, "declarator");
    return d ? applyDeclarator(d, base).type : base;
  }

  private builtin(name: string): CType {
    return { k: "builtin", name };
  }

  private fromScalar(t: ScalarType | undefined): CType | undefined {
    if (!t) {
      return undefined;
    }
    if (t.kind === "float") {
      return this.builtin("double");
    }
    const name = Object.keys(BUILTIN_TYPES).find((k) => BUILTIN_TYPES[k] === t);
    return name ? this.builtin(name) : undefined;
  }

  private compute(n: Node): CType | undefined {
    const d = this.ctx.decls;
    switch (n.type) {
      case "identifier": {
        const name = text(n);
        const own = this.ctx.locals.get(name);
        if (own) {
          return own;
        }
        if (this.ctx.hidden.has(name)) {
          return undefined;
        }
        if (d.enumValue(name) !== undefined) {
          return this.builtin("int");
        }
        return d.varType(name) ?? this.macroType(name);
      }
      case "number_literal": {
        const t = text(n);
        if (!/^0[xX]/.test(t) && /[.eE]|[fF]$/.test(t)) {
          return this.builtin(/[fF]$/.test(t) ? "float" : "double");
        }
        const suffix = (/[uUlL]+$/.exec(t)?.[0] ?? "").toLowerCase();
        const unsigned = suffix.includes("u");
        const long = suffix.includes("l");
        return this.builtin(long ? (unsigned ? "unsigned long" : "long") : unsigned ? "unsigned int" : "int");
      }
      case "char_literal":
        return this.builtin("int");
      case "true":
      case "false":
        return this.builtin("bool");
      case "string_literal":
      case "concatenated_string":
        return { k: "ptr", to: this.builtin("char") };
      case "parenthesized_expression": {
        const inner = named(n).find((c) => c.type !== "comment");
        return inner ? this.of(inner) : undefined;
      }
      case "cast_expression": {
        const desc = field(n, "type");
        return desc ? this.descriptor(desc) : undefined;
      }
      case "field_expression": {
        const arg = field(n, "argument");
        const member = fieldOpt(n, "field");
        if (!arg || !member) {
          return undefined;
        }
        let base = this.of(arg);
        if (fieldOpt(n, "operator")?.type === "->") {
          base = this.element(base);
        }
        return d.field(base, text(member));
      }
      case "subscript_expression": {
        const arg = field(n, "argument");
        return arg ? this.element(this.of(arg)) : undefined;
      }
      case "pointer_expression": {
        const arg = field(n, "argument");
        if (!arg) {
          return undefined;
        }
        const t = this.of(arg);
        if (fieldOpt(n, "operator")?.type === "&") {
          return t ? { k: "ptr", to: t } : undefined;
        }
        return this.element(t);
      }
      case "call_expression": {
        const fn = field(n, "function");
        if (fn?.type === "identifier") {
          return d.returnType(text(fn));
        }
        if (fn?.type === "parenthesized_expression") {
          // `(u16)(x)`: a cast that tree-sitter read as a call.
          const inner = named(fn).find((c) => c.type !== "comment");
          if (inner?.type === "identifier" && !this.ctx.hidden.has(text(inner)) && (d.hasTypedef(text(inner)) || BUILTIN_TYPES[text(inner)])) {
            return { k: "named", name: text(inner) };
          }
        }
        return undefined;
      }
      case "binary_expression": {
        const op = fieldOpt(n, "operator")?.type ?? "";
        if (["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(op)) {
          return this.builtin("int");
        }
        const l = field(n, "left");
        const r = field(n, "right");
        if (!l || !r) {
          return undefined;
        }
        const lt = this.of(l);
        if (op === "<<" || op === ">>") {
          const s = d.scalarOf(lt);
          return this.fromScalar(s ? promote(s) : undefined);
        }
        const rt = this.of(r);
        const lr = d.resolve(lt);
        const rr = d.resolve(rt);
        if (lr?.k === "ptr" || lr?.k === "array") {
          return op === "-" && (rr?.k === "ptr" || rr?.k === "array") ? this.builtin("long") : lr.k === "array" ? { k: "ptr", to: lr.of } : lr;
        }
        if (rr?.k === "ptr" || rr?.k === "array") {
          return rr.k === "array" ? { k: "ptr", to: rr.of } : rr;
        }
        const a = d.scalarOf(lt);
        const b = d.scalarOf(rt);
        return a && b ? this.fromScalar(arithmeticType(a, b)) : undefined;
      }
      case "unary_expression": {
        const op = fieldOpt(n, "operator")?.type;
        if (op === "!") {
          return this.builtin("int");
        }
        const arg = field(n, "argument");
        const s = arg ? this.scalar(arg) : undefined;
        return this.fromScalar(s ? promote(s) : undefined);
      }
      case "assignment_expression": {
        const l = field(n, "left");
        return l ? this.of(l) : undefined;
      }
      case "update_expression": {
        const a = field(n, "argument");
        return a ? this.of(a) : undefined;
      }
      case "conditional_expression": {
        const c = field(n, "consequence");
        return c ? this.of(c) : undefined;
      }
      case "comma_expression": {
        const r = field(n, "right");
        return r ? this.of(r) : undefined;
      }
      case "sizeof_expression":
      case "alignof_expression":
        return this.builtin("size_t");
      default:
        return undefined;
    }
  }

  /** `#define ADC1 (&hw_adc1)` -> pointer to hw_adc1's type; `#define REG ((Regs *)0x4000)` -> Regs *. */
  private macroType(name: string): CType | undefined {
    const body = this.ctx.macroBody(name)?.trim();
    if (!body) {
      return undefined;
    }
    const addr = /^\(?\s*&\s*([A-Za-z_]\w*)\s*\)?$/.exec(body);
    if (addr) {
      const t = this.ctx.decls.varType(addr[1]);
      return t ? { k: "ptr", to: t } : undefined;
    }
    const cast = /^\(\s*\(\s*(?:volatile\s+|const\s+)*([A-Za-z_]\w*)\s*\*\s*\)/.exec(body);
    if (cast) {
      return { k: "ptr", to: { k: "named", name: cast[1] } };
    }
    return undefined;
  }
}
