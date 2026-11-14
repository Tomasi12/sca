// runtime-bugfinder:div-zero — division or remainder whose divisor can be 0.
//
// What it reports:
//   * definite: the divisor is the literal 0 (`x / 0`, `x % 0U`).
//   * possible: the divisor is a value parameter of the enclosing function, and nothing on the way to the
//     division shows that it is not 0. The caller could pass 0.
//
// What counts as "shows it is not 0" (a guard), checked on the path from the function start to the division:
//   * an enclosing `if` / `while` / `for` / `?:` / `&&` / `||` whose condition rules out 0 on that branch,
//     e.g. `if (n != 0)`, `if (n > 0U)`, `if (n)`, `if (n == 0) {...} else { x / n }`, `n ? x / n : 0`;
//   * an earlier early exit in an enclosing block: `if (n == 0) return ...;` (also goto / break / continue);
//   * an earlier `assert(n != 0)` (any function or macro whose name contains "assert", any case).
// The parameter is not reported when it is assigned or its address is taken before the division
// (its value is then no longer simply "what the caller passed"), when the function has parse errors,
// or when the function is `static` and every call in the file passes a non-zero constant.
//
// Not covered yet (later, with value tracking): globals, struct fields, locals and return values as divisors;
// guards through helper functions or macros; guards on a different variable that implies this one.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { createFinding, Finding } from "../finding";
import { nodeRange, walk } from "../parser/parser";
import {
  alwaysExits,
  enclosingFunction,
  insideError,
  isBlock,
  ConstantLookup,
  numericValue,
  stripParens,
  stripParensAndCasts,
  valueParameters,
} from "./syntax";

export const DIV_ZERO_RULE = "runtime-bugfinder:div-zero";

const DIVISION_OPERATORS = new Set(["/", "%"]);
const COMPOUND_DIVISION = new Set(["/=", "%="]);

/**
 * Macro constants of the file being checked. Set for the duration of one (synchronous) check run,
 * so the helpers below can resolve `x / CELLS` without passing it through every call.
 */
let consts: ConstantLookup | undefined;

const valueOf = (node: Node) => numericValue(node, consts);

export function checkDivByZero(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  consts = source.macros;
  try {
    return run(source.file, source.parsed.root);
  } finally {
    consts = undefined;
  }
}

function run(file: string, root: Node): Finding[] {
  const findings: Finding[] = [];
  // descendantsOfType runs inside tree-sitter (WASM): much faster than visiting every node from JavaScript.
  for (const node of root.descendantsOfType(["binary_expression", "assignment_expression"])) {
    if (!node) {
      continue;
    }
    const divisor = divisorOf(node);
    if (!divisor || insideError(node)) {
      continue;
    }
    const finding = judge(file, node, divisor);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

/** For `a / b`, `a % b`, `a /= b`, `a %= b`: returns `b`. */
function divisorOf(node: Node): Node | undefined {
  if (node.type === "binary_expression" && DIVISION_OPERATORS.has(node.childForFieldName("operator")?.type ?? "")) {
    return node.childForFieldName("right") ?? undefined;
  }
  if (node.type === "assignment_expression" && COMPOUND_DIVISION.has(node.childForFieldName("operator")?.type ?? "")) {
    return node.childForFieldName("right") ?? undefined;
  }
  return undefined;
}

function judge(file: string, division: Node, divisorNode: Node): Finding | undefined {
  const op = division.childForFieldName("operator")?.type ?? "/";
  const what = op.startsWith("%") ? "Remainder" : "Division";
  const divisor = stripParensAndCasts(divisorNode);

  if (valueOf(divisorNode) === 0) {
    return createFinding({
      ruleId: DIV_ZERO_RULE,
      message: `${what} by zero: the divisor is the constant 0.`,
      file,
      range: nodeRange(divisorNode),
      certainty: "definite",
    });
  }

  if (divisor.type !== "identifier") {
    return undefined;
  }
  const name = divisor.text;
  const fn = enclosingFunction(division);
  // A function tree-sitter could not fully parse (usually macros) gives guards we may have missed: stay quiet.
  if (!fn || fn.hasError || !valueParameters(fn).has(name)) {
    return undefined;
  }
  if (changedBefore(fn, name, division) || guarded(division, name, fn)) {
    return undefined;
  }
  const fnName = functionName(fn);
  if (fnName && everyCallPassesNonZero(fn, fnName, name)) {
    return undefined;
  }
  return createFinding({
    ruleId: DIV_ZERO_RULE,
    message: `Possible ${what.toLowerCase()} by zero: parameter '${name}'${fnName ? ` of ${fnName}()` : ""} is not checked against 0 before it is used as divisor.`,
    file,
    range: nodeRange(divisorNode),
    certainty: "possible",
  });
}

/**
 * For a `static` function all callers are in this file. When every call passes a non-zero constant for the
 * parameter (and the function is not used in any other way, e.g. as a function pointer), 0 cannot arrive.
 */
function everyCallPassesNonZero(fn: Node, fnName: string, param: string): boolean {
  const isStatic = fn.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === "static");
  if (!isStatic) {
    return false;
  }
  const index = parameterIndex(fn, param);
  if (index < 0) {
    return false;
  }
  let calls = 0;
  for (const n of walk(fn.tree.rootNode)) {
    if (n.type !== "identifier" || n.text !== fnName || insideOwnDeclarator(n, fn)) {
      continue;
    }
    const call = n.parent;
    if (call?.type !== "call_expression" || call.childForFieldName("function")?.id !== n.id) {
      return false; // used as a value (function pointer) or declared again: callers unknown
    }
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => a !== null && a.type !== "comment") ?? [];
    const value = args[index] ? valueOf(args[index]) : undefined;
    if (value === undefined || value === 0) {
      return false;
    }
    calls++;
  }
  return calls > 0;
}

function parameterIndex(fn: Node, param: string): number {
  let d = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator");
  }
  const params = d?.childForFieldName("parameters")?.namedChildren.filter((p): p is Node => p !== null && p.type === "parameter_declaration") ?? [];
  return params.findIndex((p) => p.childForFieldName("declarator")?.text === param);
}

/** True for the function's own name in its definition (`static u32 to_adc(...)`). */
function insideOwnDeclarator(n: Node, fn: Node): boolean {
  const decl = fn.childForFieldName("declarator");
  return decl !== null && n.startIndex >= decl.startIndex && n.endIndex <= decl.endIndex;
}

function functionName(fn: Node): string | undefined {
  let d = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator");
  }
  return d?.childForFieldName("declarator")?.text;
}

/** True when `name` is assigned, incremented or has its address taken anywhere in `fn` before `at`. */
function changedBefore(fn: Node, name: string, at: Node): boolean {
  const body = fn.childForFieldName("body");
  if (!body) {
    return false;
  }
  for (const n of walk(body)) {
    if (n.startIndex >= at.startIndex) {
      break;
    }
    if (n.type === "assignment_expression" && isName(n.childForFieldName("left"), name)) {
      return true;
    }
    if (n.type === "update_expression" && isName(n.childForFieldName("argument"), name)) {
      return true;
    }
    if (n.type === "pointer_expression" && n.childForFieldName("operator")?.type === "&" && isName(n.childForFieldName("argument"), name)) {
      return true;
    }
  }
  return false;
}

function isName(node: Node | null, name: string): boolean {
  return node !== null && stripParens(node).type === "identifier" && stripParens(node).text === name;
}

/** Walks from the division up to the function and looks for a guard that rules out `name == 0`. */
function guarded(division: Node, name: string, fn: Node): boolean {
  let child: Node = division;
  for (let parent = division.parent; parent && parent.id !== fn.id; child = parent, parent = parent.parent) {
    switch (parent.type) {
      case "if_statement": {
        const cond = parent.childForFieldName("condition");
        if (cond && sameNode(parent.childForFieldName("consequence"), child) && whenTrue(cond, name)) {
          return true;
        }
        if (cond && sameNode(parent.childForFieldName("alternative"), child) && whenFalse(cond, name)) {
          return true;
        }
        break;
      }
      case "while_statement":
      case "for_statement": {
        const cond = parent.childForFieldName("condition");
        if (cond && sameNode(parent.childForFieldName("body"), child) && whenTrue(cond, name)) {
          return true;
        }
        break;
      }
      case "conditional_expression": {
        const cond = parent.childForFieldName("condition");
        if (cond && sameNode(parent.childForFieldName("consequence"), child) && whenTrue(cond, name)) {
          return true;
        }
        if (cond && sameNode(parent.childForFieldName("alternative"), child) && whenFalse(cond, name)) {
          return true;
        }
        break;
      }
      case "binary_expression": {
        const op = parent.childForFieldName("operator")?.type;
        const left = parent.childForFieldName("left");
        if (left && sameNode(parent.childForFieldName("right"), child)) {
          if ((op === "&&" && whenTrue(left, name)) || (op === "||" && whenFalse(left, name))) {
            return true;
          }
        }
        break;
      }
      default:
        if (isBlock(parent) && earlierStatementGuards(parent, child, name)) {
          return true;
        }
    }
  }
  return false;
}

function sameNode(a: Node | null, b: Node): boolean {
  return a !== null && a.id === b.id;
}

/** Looks at the statements before `child` in the block: early exits and asserts. */
function earlierStatementGuards(block: Node, child: Node, name: string): boolean {
  for (const stmt of block.namedChildren) {
    if (!stmt || stmt.startIndex >= child.startIndex) {
      break;
    }
    if (stmt.type === "if_statement" && !stmt.childForFieldName("alternative")) {
      const cond = stmt.childForFieldName("condition");
      if (cond && alwaysExits(stmt.childForFieldName("consequence")) && whenFalse(cond, name)) {
        return true;
      }
    }
    if (stmt.type === "expression_statement") {
      const call = stmt.namedChildren[0];
      if (call?.type === "call_expression" && /assert/i.test(call.childForFieldName("function")?.text ?? "")) {
        const firstArg = call.childForFieldName("arguments")?.namedChildren.find((a) => a !== null && a.type !== "comment");
        if (firstArg && whenTrue(firstArg, name)) {
          return true;
        }
      }
    }
  }
  return false;
}

type Cmp = "==" | "!=" | "<" | "<=" | ">" | ">=";
const NEGATE: Record<Cmp, Cmp> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" };
const MIRROR: Record<Cmp, Cmp> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** If `cond` is true, is `name` surely not 0? */
function whenTrue(cond: Node, name: string): boolean {
  return implies(cond, name, true);
}

/** If `cond` is false, is `name` surely not 0? */
function whenFalse(cond: Node, name: string): boolean {
  return implies(cond, name, false);
}

function implies(node: Node, name: string, truth: boolean): boolean {
  const n = stripParens(node);
  if (n.type === "condition_clause") {
    const value = n.childForFieldName("value") ?? n.namedChildren.find((c) => c !== null && c.type !== "comment");
    return value ? implies(value, name, truth) : false;
  }
  if (n.type === "identifier" || n.type === "cast_expression") {
    // `if (n)`: true means n != 0. A cast to bool/int keeps that (we do not trust narrowing casts here).
    return truth && n.type === "identifier" && n.text === name;
  }
  if (n.type === "unary_expression" && n.childForFieldName("operator")?.type === "!") {
    const arg = n.childForFieldName("argument");
    return arg ? implies(arg, name, !truth) : false;
  }
  if (n.type !== "binary_expression") {
    return false;
  }
  const op = n.childForFieldName("operator")?.type ?? "";
  const left = n.childForFieldName("left");
  const right = n.childForFieldName("right");
  if (!left || !right) {
    return false;
  }
  if (op === "&&") {
    // true: both true -> either side is enough. false: we do not know which side failed -> both needed.
    return truth ? implies(left, name, true) || implies(right, name, true) : implies(left, name, false) && implies(right, name, false);
  }
  if (op === "||") {
    return truth ? implies(left, name, true) && implies(right, name, true) : implies(left, name, false) || implies(right, name, false);
  }
  if (!(op in NEGATE)) {
    return false;
  }
  let cmp = op as Cmp;
  let k: number | undefined;
  if (isName(left, name) && (k = valueOf(right)) !== undefined) {
    // name <cmp> k
  } else if (isName(right, name) && (k = valueOf(left)) !== undefined) {
    cmp = MIRROR[cmp];
  } else {
    return false;
  }
  if (!truth) {
    cmp = NEGATE[cmp];
  }
  return excludesZero(cmp, k);
}

/** Does `name <cmp> k` rule out name == 0? */
function excludesZero(cmp: Cmp, k: number): boolean {
  switch (cmp) {
    case "==":
      return k !== 0;
    case "!=":
      return k === 0;
    case ">":
      return k >= 0;
    case ">=":
      return k > 0;
    case "<":
      return k <= 0;
    case "<=":
      return k < 0;
  }
}
