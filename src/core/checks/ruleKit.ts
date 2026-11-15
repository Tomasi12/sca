// Shared helpers for the coding-rule checks: building findings, walking functions, and the type of an
// expression as the rules see it (its "essential" type).
//
// The essential type is the type a value really has before C's integer promotion: `u8 + u8` stays u8,
// a constant takes the type of the other operand when it fits (`x + 1U` has x's type), comparisons are
// boolean. Rules about mixing signed / unsigned or narrowing use it, so they do not fire on every `u8 + 1`.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { engineFor } from "../engine";
import { applyDeclarator, CType, Declarations, specifierType } from "../engine/declarations";
import { widthOf, Typing } from "../engine/typing";
import { createFinding, Finding, Range, Severity } from "../finding";
import { nodeRange, toPosition } from "../parser/parser";
import { numericValue, stripParens } from "./syntax";

/** A coding-rule finding: the rule is broken or not, so it is always definite. */
export function ruleFinding(source: SourceContext, ruleId: string, at: Node | Range, message: string, severity: Severity = "warning"): Finding {
  return createFinding({
    ruleId,
    message,
    file: source.file,
    range: "type" in at ? nodeRange(at) : at,
    certainty: "definite",
    severity,
  });
}

/** From the start of `a` to the end of `b` (e.g. `if (cond)` without its body). */
export function spanRange(a: Node, b: Node): Range {
  return { start: toPosition(a.startPosition), end: toPosition(b.endPosition) };
}

/** Nodes of the given types that lie in code tree-sitter could parse. */
export function nodesOf(source: SourceContext, ...types: string[]): Node[] {
  const idx = treeIndex(source);
  if (!idx) {
    return [];
  }
  if (types.length === 1) {
    return idx.byType.get(types[0]) ?? [];
  }
  return types.flatMap((t) => idx.byType.get(t) ?? []).sort((a, b) => a.startIndex - b.startIndex);
}

/** Nodes of the given types inside `scope` (e.g. a function body), in source order. */
export function nodesWithin(source: SourceContext, scope: Node, ...types: string[]): Node[] {
  const idx = treeIndex(source);
  if (!idx) {
    return [];
  }
  const out: Node[] = [];
  for (const t of types) {
    const list = idx.byType.get(t) ?? [];
    // first node starting at or after the scope (lists are in source order)
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

/** Every node type a coding-rule check or metric looks at. One native traversal collects them all. */
const INDEX_TYPES = [
  "function_definition", "function_declarator", "declaration", "init_declarator", "array_declarator", "field_declaration",
  "if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "case_statement",
  "return_statement", "expression_statement", "break_statement", "continue_statement", "goto_statement", "throw_statement",
  "try_statement", "catch_clause", "binary_expression", "unary_expression", "assignment_expression", "update_expression",
  "comma_expression", "conditional_expression", "sizeof_expression", "call_expression", "new_expression", "delete_expression",
  "number_literal",
];

interface TreeIndex {
  readonly byType: Map<string, Node[]>;
}

const indexes = new WeakMap<object, TreeIndex>();

/** Nodes by type for the file's tree, without the ones in parts tree-sitter could not parse. Built once per tree. */
function treeIndex(source: SourceContext): TreeIndex | undefined {
  const parsed = source.parsed;
  if (!parsed) {
    return undefined;
  }
  let idx = indexes.get(parsed);
  if (!idx) {
    const root = parsed.root;
    // Without errors in the tree, nothing is inside one: skip the per-node test.
    const errors = root.hasError ? root.descendantsOfType("ERROR").filter((e): e is Node => e !== null).map((e) => [e.startIndex, e.endIndex]) : [];
    const ok = (n: Node) => errors.length === 0 || (!errors.some(([s, e]) => n.startIndex >= s && n.endIndex <= e) && !n.isMissing);
    const byType = new Map<string, Node[]>();
    for (const n of root.descendantsOfType(INDEX_TYPES)) {
      if (n && ok(n)) {
        const list = byType.get(n.type);
        if (list) {
          list.push(n);
        } else {
          byType.set(n.type, [n]);
        }
      }
    }
    idx = { byType };
    indexes.set(parsed, idx);
  }
  return idx;
}

/** Function definitions without parse errors, in source order. */
export function functionsOf(source: SourceContext): Node[] {
  return nodesOf(source, "function_definition").filter((f) => !f.hasError);
}

/** The innermost function definition around a node. */
export function functionAround(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === "function_definition") {
      return n;
    }
  }
  return undefined;
}

/** The function_declarator of a definition or declaration. */
export function functionDeclarator(node: Node): Node | undefined {
  for (let d: Node | null = node.childForFieldName("declarator"); d; d = d.childForFieldName("declarator")) {
    if (d.type === "function_declarator") {
      return d;
    }
  }
  return undefined;
}

/** Name of the identifier a declarator declares (`*p`, `a[4]`, `x = 3` -> p, a, x). */
export function declaredName(d: Node | null): Node | undefined {
  for (let n: Node | null = d; n; n = n.childForFieldName("declarator")) {
    if (n.type === "identifier" || n.type === "field_identifier") {
      return n;
    }
    if (n.type === "function_declarator" || n.type === "parenthesized_declarator") {
      return n.type === "parenthesized_declarator" ? declaredName(n.namedChildren.find((c) => c !== null) ?? null) : undefined;
    }
  }
  return undefined;
}

/** Parameter name nodes of a function definition (unnamed and `void` parameters are skipped). */
export function parameterNames(fn: Node): Node[] {
  const params = functionDeclarator(fn)?.childForFieldName("parameters");
  const out: Node[] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p?.type === "parameter_declaration") {
      const id = declaredName(p.childForFieldName("declarator"));
      if (id) {
        out.push(id);
      }
    }
  }
  return out;
}

export function hasStorage(decl: Node, word: string): boolean {
  return decl.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === word);
}

export function hasQualifier(decl: Node, word: string): boolean {
  return decl.namedChildren.some((c) => c?.type === "type_qualifier" && c.text === word);
}

const lineStarts = new WeakMap<object, number[]>();

/**
 * The text as written between two nodes positions. The syntax tree belongs to the preprocessed text, whose
 * inactive #if lines are blank, so character offsets differ from the original; lines and columns do not.
 */
export function originalText(source: SourceContext, from: { row: number; column: number }, to: { row: number; column: number }): string {
  const key = source.parsed ?? source;
  let starts = lineStarts.get(key);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < source.text.length; i++) {
      if (source.text.charCodeAt(i) === 10) {
        starts.push(i + 1);
      }
    }
    lineStarts.set(key, starts);
  }
  const at = (p: { row: number; column: number }) => (starts![p.row] ?? source.text.length) + p.column;
  return source.text.slice(at(from), at(to));
}

/** Source text without comments and string literals, for counting identifier uses. */
export function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, " ");
}

/** Number of times `name` appears as a whole word in `text`. */
export function wordCount(text: string, name: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_])`, "g");
  return text.match(re)?.length ?? 0;
}

// ---------------------------------------------------------------------------------------------------------
// Types

const typings = new WeakMap<object, Map<number, Typing>>();

/** Expression types inside `fn` (its parameters and locals known), or at file level when fn is undefined. */
export function typingFor(source: SourceContext, fn: Node | undefined): Typing | undefined {
  const engine = engineFor(source);
  if (!engine || !source.parsed) {
    return undefined;
  }
  let byFn = typings.get(source.parsed);
  if (!byFn) {
    byFn = new Map();
    typings.set(source.parsed, byFn);
  }
  const key = fn?.id ?? -1;
  let t = byFn.get(key);
  if (!t) {
    const macroBody = (name: string) => {
      const m = source.macros?.get(name);
      return m && !m.params ? m.body : undefined;
    };
    if (fn) {
      const model = engine.modelFor(fn);
      t = new Typing({ decls: engine.decls, locals: model.declTypes, hidden: model.locals, macroBody });
    } else {
      t = new Typing({ decls: engine.decls, locals: new Map(), hidden: new Set(), macroBody });
    }
    byFn.set(key, t);
  }
  return t;
}

/** The essential type of a value. `constant` is set for literals, enum constants and macro constants. */
export interface Essential {
  readonly kind: "int" | "char" | "bool" | "enum" | "float" | "ptr";
  /** Bits (integers and floats). */
  readonly width: number;
  readonly unsigned: boolean;
  /** True for a constant expression; `value` when it is known. */
  readonly constant?: boolean;
  readonly value?: number;
}

const BOOL: Essential = { kind: "bool", width: 1, unsigned: true };

/** u8, s32, char, bool, float32, ... for messages. */
export function essentialName(e: Essential): string {
  switch (e.kind) {
    case "int":
      return `${e.unsigned ? "u" : "s"}${e.width}`;
    case "float":
      return e.width === 32 ? "float" : "double";
    case "ptr":
      return "pointer";
    default:
      return e.kind;
  }
}

/** The essential type of a declared C type. */
export function essentialOfType(decls: Declarations, t: CType | undefined): Essential | undefined {
  let cur = t;
  // Look through typedefs one step at a time: `typedef char Char` stays a character type.
  for (let i = 0; cur?.k === "named" && i < 16; i++) {
    if (cur.name === "char") {
      return { kind: "char", width: 8, unsigned: false };
    }
    const next = decls.resolve({ k: "named", name: cur.name }, 15);
    if (!next || next === cur || (next.k === "named" && next.name === cur.name)) {
      break;
    }
    cur = next;
  }
  const r = decls.resolve(cur);
  if (!r) {
    return undefined;
  }
  if (r.k === "enum") {
    return { kind: "enum", width: 32, unsigned: false };
  }
  if (r.k === "ptr" || r.k === "array") {
    return { kind: "ptr", width: 64, unsigned: true };
  }
  if (r.k === "builtin" && r.name === "char") {
    return { kind: "char", width: 8, unsigned: false };
  }
  if (r.k !== "builtin" && r.k !== "named") {
    return undefined;
  }
  const s = decls.scalarOf(r);
  if (!s || !Number.isFinite(s.hi) && s.kind === "int") {
    return undefined;
  }
  if (s.kind === "float") {
    return { kind: "float", width: /^(float|float32|float32_t|f32)$/.test(r.name) ? 32 : 64, unsigned: false };
  }
  if (s.kind === "ptr") {
    return { kind: "ptr", width: 64, unsigned: true };
  }
  if (s.lo === 0 && s.hi === 1) {
    return BOOL;
  }
  return { kind: "int", width: widthOf(s), unsigned: s.unsigned };
}

const COMPARISON = new Set(["==", "!=", "<", "<=", ">", ">=", "&&", "||"]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "&", "|", "^"]);

/** The essential type of an expression, or undefined when SCA cannot tell (checks then stay quiet). */
export function essentialType(source: SourceContext, typing: Typing, node: Node): Essential | undefined {
  const n = stripParens(node);
  switch (n.type) {
    case "number_literal": {
      const t = n.text;
      if (!/^0[xX]/.test(t) && /[.eE]|[fF]$/.test(t)) {
        return { kind: "float", width: /[fF]$/.test(t) ? 32 : 64, unsigned: false, constant: true, value: numericValue(n) };
      }
      const suffix = (/[uUlL]+$/.exec(t)?.[0] ?? "").toLowerCase();
      return { kind: "int", width: suffix.includes("l") ? 64 : 32, unsigned: suffix.includes("u"), constant: true, value: numericValue(n) };
    }
    case "char_literal":
      return { kind: "char", width: 8, unsigned: false, constant: true };
    case "true":
    case "false":
      return { ...BOOL, constant: true };
    case "identifier": {
      const name = n.text;
      const ownType = typing.of(n);
      if (ownType) {
        return essentialOfType(typing.decls, ownType);
      }
      const enumValue = typing.decls.enumValue(name);
      if (enumValue !== undefined) {
        return { kind: "enum", width: 32, unsigned: false, constant: true, value: enumValue };
      }
      const v = source.macros?.valueOf(name);
      if (v !== undefined) {
        const body = source.macros?.get(name)?.body ?? "";
        return { kind: "int", width: /\d[uU]?[lL]/.test(body) ? 64 : 32, unsigned: /\d[lL]?[uU]/.test(body), constant: true, value: v };
      }
      return undefined;
    }
    case "cast_expression":
      return essentialOfType(typing.decls, typing.of(n));
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.type ?? "";
      if (COMPARISON.has(op)) {
        return BOOL;
      }
      const l = n.childForFieldName("left");
      const r = n.childForFieldName("right");
      const a = l ? essentialType(source, typing, l) : undefined;
      if (op === "<<" || op === ">>") {
        return a;
      }
      const b = r ? essentialType(source, typing, r) : undefined;
      if (!a || !b || !ARITHMETIC.has(op)) {
        return undefined;
      }
      return combine(a, b);
    }
    case "unary_expression": {
      const op = n.childForFieldName("operator")?.type;
      if (op === "!") {
        return BOOL;
      }
      const arg = n.childForFieldName("argument");
      const a = arg ? essentialType(source, typing, arg) : undefined;
      if (a && op === "-" && a.value !== undefined) {
        return { ...a, value: -a.value };
      }
      return a;
    }
    case "conditional_expression": {
      const c = n.childForFieldName("consequence");
      const alt = n.childForFieldName("alternative");
      const a = c ? essentialType(source, typing, c) : undefined;
      const b = alt ? essentialType(source, typing, alt) : undefined;
      return a && b ? combine(a, b) : undefined;
    }
    case "sizeof_expression":
    case "alignof_expression":
      return { kind: "int", width: 64, unsigned: true, constant: true };
    case "assignment_expression": {
      const l = n.childForFieldName("left");
      return l ? essentialType(source, typing, l) : undefined;
    }
    case "update_expression": {
      const a = n.childForFieldName("argument");
      return a ? essentialType(source, typing, a) : undefined;
    }
    case "call_expression":
    case "field_expression":
    case "subscript_expression":
    case "pointer_expression":
      return essentialOfType(typing.decls, typing.of(n));
    default:
      return undefined;
  }
}

/** Type of `a op b` for + - * / % & | ^: a constant adapts to the other side; otherwise the wider one wins. */
function combine(a: Essential, b: Essential): Essential | undefined {
  if (a.kind === "ptr" || b.kind === "ptr") {
    return undefined;
  }
  if (a.kind === "float" || b.kind === "float") {
    return { kind: "float", width: Math.max(a.kind === "float" ? a.width : 0, b.kind === "float" ? b.width : 0), unsigned: false, constant: a.constant && b.constant };
  }
  if (a.constant && b.constant) {
    return { kind: "int", width: Math.max(a.width, b.width), unsigned: a.unsigned || b.unsigned, constant: true };
  }
  const asInt = (e: Essential): Essential => (e.kind === "int" ? e : { kind: "int", width: e.kind === "bool" ? 8 : e.kind === "enum" ? 32 : e.width, unsigned: e.unsigned && e.kind !== "enum" && e.kind !== "char" });
  if (a.constant) {
    return asInt(b);
  }
  if (b.constant) {
    return asInt(a);
  }
  const x = asInt(a);
  const y = asInt(b);
  return { kind: "int", width: Math.max(x.width, y.width), unsigned: x.unsigned || y.unsigned };
}

/** The declared type of the object a declaration's declarator introduces (`u8 buf[4]` -> array of u8). */
export function declaredType(decl: Node, declarator: Node): CType {
  return applyDeclarator(declarator, specifierType(decl.childForFieldName("type"), undefined, decl)).type;
}

/** The return type of a function definition (undefined for void and pointer returns are kept). */
export function returnTypeOf(fn: Node): CType | undefined {
  const spec = fn.childForFieldName("type");
  if (!spec) {
    return undefined;
  }
  let pointer = false;
  for (let d: Node | null = fn.childForFieldName("declarator"); d && d.type !== "function_declarator"; d = d.childForFieldName("declarator")) {
    if (d.type === "pointer_declarator") {
      pointer = true;
    }
  }
  const base = specifierType(spec, undefined, fn);
  if (pointer) {
    return { k: "ptr", to: base };
  }
  return base.k === "builtin" && base.name === "void" ? undefined : base;
}

/** A constant expression: literals, enum and macro constants, sizeof, and operators on those. */
export function isConstantExpression(source: SourceContext, node: Node, decls: Declarations | undefined): boolean {
  const n = stripParens(node);
  switch (n.type) {
    case "number_literal":
    case "char_literal":
    case "true":
    case "false":
    case "sizeof_expression":
    case "alignof_expression":
      return true;
    case "identifier":
      return decls?.enumValue(n.text) !== undefined || source.macros?.valueOf(n.text) !== undefined;
    case "cast_expression": {
      const v = n.childForFieldName("value");
      return !!v && isConstantExpression(source, v, decls);
    }
    case "binary_expression":
    case "unary_expression":
    case "conditional_expression":
      return n.namedChildren.every((c) => !c || c.type === "comment" || isConstantExpression(source, c, decls));
    case "call_expression": {
      // A function-like macro on constants, e.g. ARRAY_LEN(table) or BIT(3).
      const fn = n.childForFieldName("function");
      const args = n.childForFieldName("arguments");
      return fn?.type === "identifier" && !!source.macros?.get(fn.text)?.params && (args?.namedChildren ?? []).every((c) => !c || c.type === "comment" || c.type === "identifier" || isConstantExpression(source, c, decls));
    }
    default:
      return false;
  }
}
