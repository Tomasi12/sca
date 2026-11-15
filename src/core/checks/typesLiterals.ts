// Coding rules, batch 3: types and literals.
//
//   sca-own:octal-constant          an integer constant written in octal (010 is eight)
//   sca-own:lowercase-suffix        a literal suffix with a lowercase l (1l looks like 11)
//   sca-own:unsigned-suffix         a hex / octal constant above the signed int range without a U suffix
//   sca-own:implicit-conversion     assignment, initialization or return that narrows or changes signedness without a cast
//   sca-own:signed-unsigned-compare a comparison where a signed value is converted to unsigned
//   sca-own:signed-bitwise          a bitwise operator or shift on a signed value
//   sca-own:vla                     a variable-length array
//   sca-own:bitfield-type           a bit-field declared with plain int / char / short / long
//   sca-own:int-division-to-float   an integer division whose result is stored as floating-point

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { Typing } from "../engine/typing";
import { Finding } from "../finding";
import {
  declaredType,
  Essential,
  essentialName,
  essentialOfType,
  essentialType,
  functionAround,
  isConstantExpression,
  nodesOf,
  returnTypeOf,
  ruleFinding,
  typingFor,
} from "./ruleKit";
import { stripParens } from "./syntax";

export const OCTAL_CONSTANT_RULE = "sca-own:octal-constant";
export const LOWERCASE_SUFFIX_RULE = "sca-own:lowercase-suffix";
export const UNSIGNED_SUFFIX_RULE = "sca-own:unsigned-suffix";
export const IMPLICIT_CONVERSION_RULE = "sca-own:implicit-conversion";
export const SIGNED_UNSIGNED_COMPARE_RULE = "sca-own:signed-unsigned-compare";
export const SIGNED_BITWISE_RULE = "sca-own:signed-bitwise";
export const VLA_RULE = "sca-own:vla";
export const BITFIELD_TYPE_RULE = "sca-own:bitfield-type";
export const INT_DIVISION_TO_FLOAT_RULE = "sca-own:int-division-to-float";

export const TYPE_RULES = [
  OCTAL_CONSTANT_RULE,
  LOWERCASE_SUFFIX_RULE,
  UNSIGNED_SUFFIX_RULE,
  IMPLICIT_CONVERSION_RULE,
  SIGNED_UNSIGNED_COMPARE_RULE,
  SIGNED_BITWISE_RULE,
  VLA_RULE,
  BITFIELD_TYPE_RULE,
  INT_DIVISION_TO_FLOAT_RULE,
];

const BITWISE_OPS = new Set(["&", "|", "^", "<<", ">>"]);
const BITWISE_ASSIGN = new Set(["&=", "|=", "^=", "<<=", ">>="]);
const COMPARE_OPS = new Set(["<", "<=", ">", ">=", "==", "!="]);

export function checkTypesAndLiterals(source: SourceContext): Finding[] {
  const out: Finding[] = [];
  for (const n of nodesOf(source, "number_literal")) {
    literal(source, n, out);
  }
  for (const n of nodesOf(source, "binary_expression", "unary_expression", "assignment_expression", "init_declarator", "return_statement", "array_declarator", "field_declaration")) {
    switch (n.type) {
      case "binary_expression":
        binary(source, n, out);
        break;
      case "unary_expression":
        if (n.childForFieldName("operator")?.type === "~") {
          signedOperand(source, n, n.childForFieldName("argument"), "~", out);
        }
        break;
      case "assignment_expression": {
        const op = n.childForFieldName("operator")?.type ?? "";
        const left = n.childForFieldName("left");
        const right = n.childForFieldName("right");
        if (op === "=" && left && right) {
          const typing = typingFor(source, functionAround(n));
          const target = typing ? essentialType(source, typing, left) : undefined;
          storeRules(source, typing, target, right, "assigned to", left.text, out);
        } else if (BITWISE_ASSIGN.has(op)) {
          signedOperand(source, n, left, op, out);
          signedOperand(source, n, right, op, out);
        }
        break;
      }
      case "init_declarator":
        initRules(source, n, out);
        break;
      case "return_statement": {
        const value = n.namedChildren.find((c) => c !== null && c.type !== "comment");
        const fn = functionAround(n);
        if (value && fn) {
          const typing = typingFor(source, fn);
          const target = typing ? essentialOfType(typing.decls, returnTypeOf(fn)) : undefined;
          storeRules(source, typing, target, value, "returned as", "the return type", out);
        }
        break;
      }
      case "array_declarator":
        vla(source, n, out);
        break;
      case "field_declaration":
        bitfield(source, n, out);
        break;
    }
  }
  return out;
}

function literal(source: SourceContext, n: Node, out: Finding[]): void {
  const t = n.text.replace(/'/g, "");
  if (/^0[0-7]+[uUlL]*$/.test(t)) {
    out.push(ruleFinding(source, OCTAL_CONSTANT_RULE, n, `${n.text} is an octal constant (value ${parseInt(t, 8)}); write it in decimal or hex.`));
  }
  if (/^(0[xX][0-9a-fA-F]+|\d+(\.\d*)?([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)[uUL]*l/.test(t)) {
    out.push(ruleFinding(source, LOWERCASE_SUFFIX_RULE, n, `The suffix of ${n.text} uses a lowercase l, which looks like the digit 1; write L.`));
  }
  const hex = /^0[xX]([0-9a-fA-F]+)([lL]*)$/.exec(t);
  const oct = /^0([0-7]+)([lL]*)$/.exec(t);
  const value = hex ? parseInt(hex[1], 16) : oct ? parseInt(oct[1], 8) : undefined;
  if (value !== undefined && value > 0x7fffffff && value <= 0xffffffff) {
    out.push(ruleFinding(source, UNSIGNED_SUFFIX_RULE, n, `${n.text} does not fit a signed int, so its type is silently unsigned; add a U suffix to say so.`));
  }
}

function binary(source: SourceContext, n: Node, out: Finding[]): void {
  const op = n.childForFieldName("operator")?.type ?? "";
  const l = n.childForFieldName("left");
  const r = n.childForFieldName("right");
  if (!l || !r) {
    return;
  }
  if (BITWISE_OPS.has(op)) {
    signedOperand(source, n, l, op, out);
    if (op !== "<<" && op !== ">>") {
      signedOperand(source, n, r, op, out);
    }
    return;
  }
  if (!COMPARE_OPS.has(op)) {
    return;
  }
  const typing = typingFor(source, functionAround(n));
  if (!typing) {
    return;
  }
  const a = essentialType(source, typing, l);
  const b = essentialType(source, typing, r);
  if (!a || !b || a.constant || b.constant || !isInteger(a) || !isInteger(b) || a.unsigned === b.unsigned) {
    return;
  }
  const [signed, unsigned] = a.unsigned ? [b, a] : [a, b];
  // Below int width both sides become int first and nothing goes wrong.
  if (unsigned.width >= 32 && unsigned.width >= promotedWidth(signed)) {
    out.push(
      ruleFinding(
        source,
        SIGNED_UNSIGNED_COMPARE_RULE,
        n,
        `${essentialName(signed)} compared with ${essentialName(unsigned)}: the signed value is converted to unsigned, so a negative value compares as a huge number. Check the sign first, then cast.`
      )
    );
  }
}

function signedOperand(source: SourceContext, at: Node, operand: Node | null, op: string, out: Finding[]): void {
  if (!operand) {
    return;
  }
  const typing = typingFor(source, functionAround(at));
  const t = typing ? essentialType(source, typing, operand) : undefined;
  if (!t || t.kind === "bool" || t.kind === "enum" || t.kind === "ptr" || t.kind === "float" || t.unsigned) {
    return;
  }
  if (t.constant && (t.value === undefined || t.value >= 0)) {
    return; // a non-negative constant is fine
  }
  out.push(ruleFinding(source, SIGNED_BITWISE_RULE, at, `${op} applied to the signed value ${stripParens(operand).text} (${essentialName(t)}); the result for negative values depends on the compiler. Use an unsigned type.`));
}

function initRules(source: SourceContext, n: Node, out: Finding[]): void {
  const value = n.childForFieldName("value");
  const decl = n.parent;
  if (!value || !decl || value.type === "initializer_list" || (decl.type !== "declaration" && decl.type !== "field_declaration")) {
    return;
  }
  const fn = functionAround(n);
  const typing = typingFor(source, fn);
  if (!typing) {
    return;
  }
  const target = essentialOfType(typing.decls, declaredType(decl, n));
  const name = n.childForFieldName("declarator")?.text ?? "the variable";
  storeRules(source, typing, target, value, "used to initialize", name, out);
}

/** A value stored into a target type: narrowing / signedness change without a cast, integer division into float. */
function storeRules(source: SourceContext, typing: Typing | undefined, target: Essential | undefined, value: Node, verb: string, what: string, out: Finding[]): void {
  if (!typing || !target) {
    return;
  }
  const v = stripParens(value);
  if (target.kind === "float" && v.type === "binary_expression" && (v.childForFieldName("operator")?.type === "/" || v.childForFieldName("operator")?.type === "%")) {
    const l = v.childForFieldName("left");
    const r = v.childForFieldName("right");
    const a = l ? essentialType(source, typing, l) : undefined;
    const b = r ? essentialType(source, typing, r) : undefined;
    if (a && b && isInteger(a) && isInteger(b) && !(a.constant && b.constant)) {
      out.push(ruleFinding(source, INT_DIVISION_TO_FLOAT_RULE, v, `"${v.text}" is an integer division (the fraction is lost) whose result is stored as floating-point; cast an operand to float first.`));
      return;
    }
  }
  if (!isInteger(target) && target.kind !== "char") {
    return;
  }
  const src = essentialType(source, typing, v);
  if (!src || src.kind === "bool" || src.kind === "enum" || src.kind === "ptr" || isConstantExpression(source, v, typing.decls)) {
    return;
  }
  if (src.kind === "float") {
    out.push(ruleFinding(source, IMPLICIT_CONVERSION_RULE, value, `A floating-point value is ${verb} ${what} (${essentialName(target)}) without a cast; the fraction is cut off. Convert explicitly.`));
    return;
  }
  const narrows = src.width > target.width;
  const signChange = src.unsigned !== target.unsigned && !(src.unsigned && src.width < target.width) && !(src.kind === "char" || target.kind === "char");
  if (narrows || signChange) {
    out.push(
      ruleFinding(
        source,
        IMPLICIT_CONVERSION_RULE,
        value,
        `A ${essentialName(src)} value is ${verb} ${what} (${essentialName(target)}) without a cast; ${narrows ? "high bits can be lost" : "the sign can change"}. Add a range check and an explicit cast.`
      )
    );
  }
}

function vla(source: SourceContext, n: Node, out: Finding[]): void {
  const size = n.childForFieldName("size");
  if (!size || isInsideParameter(n) || !n.parent || !hasFunctionAround(n)) {
    return;
  }
  const typing = typingFor(source, functionAround(n));
  if (isConstantExpression(source, size, typing?.decls) || size.text === "*") {
    return;
  }
  out.push(ruleFinding(source, VLA_RULE, n, `${n.text} is a variable-length array: its size (${size.text}) is only known at run time, so stack use cannot be bounded. Use a fixed maximum size.`));
}

function bitfield(source: SourceContext, n: Node, out: Finding[]): void {
  if (!n.namedChildren.some((c) => c?.type === "bitfield_clause")) {
    return;
  }
  const type = n.childForFieldName("type");
  if (type?.type === "primitive_type" && /^(int|char|short|long)$/.test(type.text)) {
    out.push(ruleFinding(source, BITFIELD_TYPE_RULE, n, `Bit-field declared with plain ${type.text}: whether it is signed depends on the compiler. Use an explicitly unsigned (or signed) type.`));
  }
}

function isInsideParameter(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === "parameter_declaration") {
      return true;
    }
    if (p.type === "declaration" || p.type === "function_definition") {
      return false;
    }
  }
  return false;
}

function hasFunctionAround(n: Node): boolean {
  return functionAround(n) !== undefined;
}

function isInteger(e: Essential): boolean {
  return e.kind === "int" || e.kind === "char";
}

function promotedWidth(e: Essential): number {
  return e.width < 32 ? 32 : e.width;
}
