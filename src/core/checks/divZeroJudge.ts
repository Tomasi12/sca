// Judging one division for runtime-bugfinder:div-zero (used by the run-time check in runtime.ts).

import { Node } from "web-tree-sitter";
import { Value } from "../engine/value";
import { createFinding, Finding } from "../finding";
import { nodeRange } from "../parser/parser";
import { stripParensAndCasts } from "./syntax";

export const DIV_ZERO_RULE = "runtime-bugfinder:div-zero";

const DIVISION_OPERATORS = new Set(["/", "%"]);
const COMPOUND_DIVISION = new Set(["/=", "%="]);

/** For `a / b`, `a % b`, `a /= b`, `a %= b`: returns `b`. */
export function divisorOf(node: Node): Node | undefined {
  if (node.type === "binary_expression" && DIVISION_OPERATORS.has(node.childForFieldName("operator")?.type ?? "")) {
    return node.childForFieldName("right") ?? undefined;
  }
  if (node.type === "assignment_expression" && COMPOUND_DIVISION.has(node.childForFieldName("operator")?.type ?? "")) {
    return node.childForFieldName("right") ?? undefined;
  }
  return undefined;
}

export function what(op: Node): string {
  return (op.childForFieldName("operator")?.type ?? "/").startsWith("%") ? "Remainder" : "Division";
}

export function judgeDivision(file: string, op: Node, divisorNode: Node, v: Value, fnName: string): Finding | undefined {
  const kind = what(op);
  const divisor = stripParensAndCasts(divisorNode);
  const text = divisor.text.replace(/\s+/g, " ");
  if (v.kind !== "ptr" && v.lo === 0 && v.hi === 0) {
    return createFinding({
      ruleId: DIV_ZERO_RULE,
      message: `${kind} by zero: '${text}' is always 0 here${v.zero ? ` (source of the 0: ${v.zero})` : ""}.`,
      file,
      range: nodeRange(divisorNode),
      certainty: "definite",
    });
  }
  if (v.zero === undefined || v.lo > 0 || v.hi < 0) {
    return undefined;
  }
  const ownParam = divisor.type === "identifier" && v.zero === `parameter '${text}' of ${fnName}()`;
  const message = ownParam
    ? `Possible ${kind.toLowerCase()} by zero: parameter '${text}'${fnName ? ` of ${fnName}()` : ""} is not checked against 0 before it is used as divisor.`
    : `Possible ${kind.toLowerCase()} by zero: '${text}' can be 0 here (source of the 0: ${v.zero}).`;
  return createFinding({ ruleId: DIV_ZERO_RULE, message, file, range: nodeRange(divisorNode), certainty: "possible" });
}
