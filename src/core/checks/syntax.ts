// Small helpers for reading the C/C++ syntax tree in checks.

import { Node } from "web-tree-sitter";

/** Removes parentheses and casts: `((u32)(x))` -> `x`. */
export function stripParensAndCasts(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === "parenthesized_expression") {
      const inner = n.namedChildren.find((c) => c !== null && c.type !== "comment");
      if (!inner) {
        return n;
      }
      n = inner;
    } else if (n.type === "cast_expression") {
      const value = n.childForFieldName("value");
      if (!value) {
        return n;
      }
      n = value;
    } else {
      return n;
    }
  }
}

/** Removes parentheses only (a cast can change the value, e.g. `(u8)256 == 0`). */
export function stripParens(node: Node): Node {
  let n = node;
  while (n.type === "parenthesized_expression") {
    const inner = n.namedChildren.find((c) => c !== null && c.type !== "comment");
    if (!inner) {
      return n;
    }
    n = inner;
  }
  return n;
}

/** The value of an integer or floating literal (`0`, `0U`, `0x10`, `-1`, `0.0f`), or undefined. */
export function numericValue(node: Node): number | undefined {
  const n = stripParens(node);
  if (n.type === "unary_expression") {
    const op = n.childForFieldName("operator")?.type;
    const arg = n.childForFieldName("argument");
    const v = arg ? numericValue(arg) : undefined;
    if (v === undefined) {
      return undefined;
    }
    return op === "-" ? -v : op === "+" ? v : undefined;
  }
  if (n.type !== "number_literal") {
    return undefined;
  }
  const text = n.text.replace(/'/g, "");
  if (/^0[xX]/.test(text)) {
    const v = parseInt(text.replace(/[uUlL]+$/, ""), 16);
    return Number.isNaN(v) ? undefined : v;
  }
  if (/^0[bB]/.test(text)) {
    const v = parseInt(text.slice(2).replace(/[uUlL]+$/, ""), 2);
    return Number.isNaN(v) ? undefined : v;
  }
  const v = Number(text.replace(/[uUlLfF]+$/, ""));
  return Number.isNaN(v) ? undefined : v;
}

/** The nearest enclosing function definition, or undefined at file level. */
export function enclosingFunction(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === "function_definition" || n.type === "lambda_expression") {
      return n;
    }
  }
  return undefined;
}

/** True when the node lies inside a part tree-sitter could not parse (often a macro); checks skip those. */
export function insideError(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parent) {
    if (n.isError || n.isMissing) {
      return true;
    }
  }
  return false;
}

/**
 * The names of a function's value parameters (not pointers or arrays), e.g. `int f(int a, u8 *p, int b[])` -> a.
 * Returns an empty set for `f(void)` or an unnamed parameter.
 */
export function valueParameters(fn: Node): Set<string> {
  const names = new Set<string>();
  const declarator = fn.childForFieldName("declarator");
  const funcDecl = declarator ? findFunctionDeclarator(declarator) : undefined;
  const params = funcDecl?.childForFieldName("parameters");
  if (!params) {
    return names;
  }
  for (const p of params.namedChildren) {
    if (!p || p.type !== "parameter_declaration") {
      continue;
    }
    const d = p.childForFieldName("declarator");
    if (d?.type === "identifier") {
      names.add(d.text);
    }
  }
  return names;
}

function findFunctionDeclarator(node: Node): Node | undefined {
  for (let n: Node | null = node; n; n = n.childForFieldName("declarator")) {
    if (n.type === "function_declarator") {
      return n;
    }
  }
  return undefined;
}

/** The statement list a statement belongs to, when its parent is a block `{ ... }` (or a case body). */
export function isBlock(node: Node): boolean {
  return node.type === "compound_statement" || node.type === "case_statement";
}

/** True when executing the statement never falls through to the next one (return, goto, break, continue, or a block ending in one). */
export function alwaysExits(stmt: Node | null): boolean {
  if (!stmt) {
    return false;
  }
  switch (stmt.type) {
    case "return_statement":
    case "goto_statement":
    case "break_statement":
    case "continue_statement":
    case "throw_statement":
      return true;
    case "compound_statement": {
      const items = stmt.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment");
      return items.length > 0 && alwaysExits(items[items.length - 1]);
    }
    case "expression_statement": {
      // exit(), abort() and similar never return.
      const call = stmt.namedChildren[0];
      const name = call?.type === "call_expression" ? call.childForFieldName("function")?.text : undefined;
      return name !== undefined && /^(exit|_Exit|abort|quick_exit|std::abort|std::exit)$/.test(name);
    }
    default:
      return false;
  }
}
