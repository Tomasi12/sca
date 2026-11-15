// Coding rules, batch 1: expressions. Descriptions, rationale and examples are in src/core/rules/registry.ts.
//
//   sca-own:float-equality          == or != on floating-point values
//   sca-own:assignment-in-condition an assignment inside an if / while / for / ?: condition
//   sca-own:assignment-as-value     the result of an assignment is used (a = b = 0, f(x = 3))
//   sca-own:side-effect-in-logical  ++ / -- / assignment in the right operand of && or || (it may not run)
//   sca-own:increment-in-expression ++ / -- mixed into a larger expression (a[i++] = x)
//   sca-own:comma-operator          the comma operator (outside a for header)
//   sca-own:operator-precedence     a & b == c, a << b + c, a && b || c without parentheses
//   sca-own:sizeof-side-effect      sizeof applied to an expression with a side effect (never evaluated)

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { Finding } from "../finding";
import { essentialType, functionAround, nodesOf, nodesWithin, ruleFinding, typingFor } from "./ruleKit";
import { stripParens } from "./syntax";

export const FLOAT_EQUALITY_RULE = "sca-own:float-equality";
export const ASSIGNMENT_IN_CONDITION_RULE = "sca-own:assignment-in-condition";
export const ASSIGNMENT_AS_VALUE_RULE = "sca-own:assignment-as-value";
export const SIDE_EFFECT_IN_LOGICAL_RULE = "sca-own:side-effect-in-logical";
export const INCREMENT_IN_EXPRESSION_RULE = "sca-own:increment-in-expression";
export const COMMA_OPERATOR_RULE = "sca-own:comma-operator";
export const OPERATOR_PRECEDENCE_RULE = "sca-own:operator-precedence";
export const SIZEOF_SIDE_EFFECT_RULE = "sca-own:sizeof-side-effect";

export const EXPRESSION_RULES = [
  FLOAT_EQUALITY_RULE,
  ASSIGNMENT_IN_CONDITION_RULE,
  ASSIGNMENT_AS_VALUE_RULE,
  SIDE_EFFECT_IN_LOGICAL_RULE,
  INCREMENT_IN_EXPRESSION_RULE,
  COMMA_OPERATOR_RULE,
  OPERATOR_PRECEDENCE_RULE,
  SIZEOF_SIDE_EFFECT_RULE,
];

const BITWISE = new Set(["&", "|", "^"]);
const RELATIONAL = new Set(["==", "!=", "<", "<=", ">", ">="]);
const SHIFT = new Set(["<<", ">>"]);
const ADDITIVE = new Set(["+", "-"]);

export function checkExpressions(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const out: Finding[] = [];
  const conditionAssignments = new Set<number>();

  // Conditions first: an assignment found here is reported once, as assignment-in-condition.
  for (const cond of conditions(source)) {
    for (const a of nodesWithin(source, cond, "assignment_expression")) {
      conditionAssignments.add(a.id);
      out.push(ruleFinding(source, ASSIGNMENT_IN_CONDITION_RULE, a, `Assignment "${a.text}" inside a condition; assign first, then test the variable (or did you mean ==?).`));
    }
  }

  for (const n of nodesOf(source, "binary_expression", "assignment_expression", "update_expression", "comma_expression", "sizeof_expression")) {
    switch (n.type) {
      case "binary_expression":
        binary(source, n, out);
        break;
      case "assignment_expression":
        if (!conditionAssignments.has(n.id) && !isStatementLevel(n)) {
          out.push(ruleFinding(source, ASSIGNMENT_AS_VALUE_RULE, n, `The value of the assignment "${n.text}" is used; write the assignment as its own statement.`));
        }
        break;
      case "update_expression":
        if (!isStatementLevel(n) && !insideSizeof(n)) {
          out.push(ruleFinding(source, INCREMENT_IN_EXPRESSION_RULE, n, `"${n.text}" changes a variable in the middle of an expression; do the ${n.text.includes("++") ? "increment" : "decrement"} as its own statement.`));
        }
        break;
      case "comma_expression":
        if (!inForHeader(n) && n.parent?.type !== "comma_expression") {
          out.push(ruleFinding(source, COMMA_OPERATOR_RULE, n, "Comma operator used; write the expressions as separate statements."));
        }
        break;
      case "sizeof_expression": {
        const v = n.childForFieldName("value");
        if (v && hasSideEffect(v)) {
          out.push(ruleFinding(source, SIZEOF_SIDE_EFFECT_RULE, n, `sizeof does not evaluate its operand, so the side effect in "${v.text}" never happens.`));
        }
        break;
      }
    }
  }
  return out;
}

function binary(source: SourceContext, n: Node, out: Finding[]): void {
  const op = n.childForFieldName("operator")?.type ?? "";
  const l = n.childForFieldName("left");
  const r = n.childForFieldName("right");
  if (!l || !r) {
    return;
  }
  if (op === "==" || op === "!=") {
    const typing = typingFor(source, functionAround(n));
    if (typing) {
      const a = essentialType(source, typing, l);
      const b = essentialType(source, typing, r);
      if (a?.kind === "float" || b?.kind === "float") {
        out.push(ruleFinding(source, FLOAT_EQUALITY_RULE, n, `Floating-point values compared with ${op}; rounding makes exact equality unreliable. Compare the difference with a tolerance.`));
      }
    }
  }
  if ((op === "&&" || op === "||") && hasSideEffect(r, false)) {
    out.push(ruleFinding(source, SIDE_EFFECT_IN_LOGICAL_RULE, r, `The right operand of ${op} has a side effect that only happens when the left operand is ${op === "&&" ? "true" : "false"}; move it out of the condition.`));
  }
  const precedence = mixedPrecedence(op, l) ?? mixedPrecedence(op, r);
  if (precedence) {
    out.push(ruleFinding(source, OPERATOR_PRECEDENCE_RULE, n, precedence));
  }
}

/** A message when an operand mixes operators whose precedence is easy to get wrong, without parentheses. */
function mixedPrecedence(op: string, operand: Node): string | undefined {
  if (operand.type !== "binary_expression") {
    return undefined; // parenthesized operands are fine
  }
  const inner = operand.childForFieldName("operator")?.type ?? "";
  if (BITWISE.has(op) && RELATIONAL.has(inner)) {
    return `"${operand.text}" is evaluated before ${op} (comparison binds tighter than bitwise ${op}); add parentheses to say which is meant.`;
  }
  if (BITWISE.has(op) && (SHIFT.has(inner) || ADDITIVE.has(inner) || (BITWISE.has(inner) && inner !== op))) {
    return `Bitwise ${op} mixed with ${inner} without parentheses; add parentheses to make the order explicit.`;
  }
  if (SHIFT.has(op) && ADDITIVE.has(inner)) {
    return `"${operand.text}" is evaluated before the shift (+ and - bind tighter than ${op}); add parentheses.`;
  }
  if ((op === "||" && inner === "&&") || (op === "&&" && inner === "||")) {
    return `&& and || mixed without parentheses; add parentheses to make the grouping explicit.`;
  }
  return undefined;
}

/** Conditions of if / while / do / for and ?: (the expression inside the parentheses). */
function* conditions(source: SourceContext): Generator<Node> {
  for (const s of nodesOf(source, "if_statement", "while_statement", "do_statement", "for_statement", "conditional_expression")) {
    const c = s.childForFieldName("condition");
    if (c) {
      yield c;
    }
  }
}

/** An expression whose value is not used: a statement of its own, a for-header part, or an operand of a top-level comma. */
function isStatementLevel(n: Node): boolean {
  let p = n.parent;
  let child: Node = n;
  while (p && (p.type === "parenthesized_expression" || p.type === "comma_expression")) {
    if (p.type === "comma_expression" && p.childForFieldName("left")?.id !== child.id && p.childForFieldName("right")?.id !== child.id) {
      break;
    }
    child = p;
    p = p.parent;
  }
  if (!p) {
    return false;
  }
  if (p.type === "expression_statement") {
    return true;
  }
  if (p.type === "for_statement") {
    return p.childForFieldName("condition")?.id !== child.id;
  }
  // `(void)(x = f())` and `(void)i++` discard the value on purpose.
  return p.type === "cast_expression" && p.childForFieldName("type")?.text === "void";
}

function inForHeader(n: Node): boolean {
  const p = n.parent;
  return p?.type === "for_statement" && p.childForFieldName("body")?.id !== n.id;
}

function insideSizeof(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === "sizeof_expression") {
      return true;
    }
    if (p.type.endsWith("_statement")) {
      return false;
    }
  }
  return false;
}

/** ++, --, assignments and (optionally) calls inside the expression. */
function hasSideEffect(n: Node, calls = true): boolean {
  const e = stripParens(n);
  const types = calls ? ["update_expression", "assignment_expression", "call_expression"] : ["update_expression", "assignment_expression"];
  return types.includes(e.type) || e.descendantsOfType(types).some((x) => x !== null);
}
