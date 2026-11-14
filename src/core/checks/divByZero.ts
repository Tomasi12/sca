// runtime-bugfinder:div-zero — division or remainder whose divisor can be 0.
//
// Built on the value engine (src/core/engine): every division is checked with the divisor's value at that
// point, on all paths through the function.
//
//   * definite: the divisor is the constant 0, or the engine knows it is always 0 there
//     (e.g. inside `if (n == 0) { ... x / n ... }`).
//   * possible: the divisor can be 0 *and* the engine can name where the 0 comes from: an unchecked
//     parameter, a 0 assigned on some path, a static object that some store in this file sets to 0
//     (a memset, an unchecked parameter), or a function in this file that can return 0.
//
// Values the engine knows nothing about (globals from other files, struct fields behind pointers, calls to
// other files) never give a finding: "unknown" is not "can be 0". Conditions (`if`, loops, `?:`, `&&`, `||`,
// `switch`, early `return` / `break` / `continue` / `goto`, `assert(...)`, `exit()`) narrow the values.
// Functions the engine cannot model (some C++ statements, parse errors) or that exceed the time budget are
// skipped quietly; only constant-0 divisors are reported there.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { engineFor } from "../engine";
import { join, Value } from "../engine/value";
import { createFinding, Finding } from "../finding";
import { nodeRange } from "../parser/parser";
import { enclosingFunction, insideError, numericValue, stripParensAndCasts } from "./syntax";

export const DIV_ZERO_RULE = "runtime-bugfinder:div-zero";

const DIVISION_OPERATORS = new Set(["/", "%"]);
const COMPOUND_DIVISION = new Set(["/=", "%="]);

export function checkDivByZero(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const findings: Finding[] = [];
  // Divisions by a non-constant, grouped by function: only those functions need the engine.
  const byFunction = new Map<number, { fn: Node; divisions: Node[] }>();
  for (const node of source.parsed.root.descendantsOfType(["binary_expression", "assignment_expression"])) {
    if (!node) {
      continue;
    }
    const divisor = divisorOf(node);
    if (!divisor || insideError(node)) {
      continue;
    }
    const constant = numericValue(stripParensAndCasts(divisor), source.macros);
    if (constant !== undefined && constant !== 0) {
      continue; // `x / 10`, `t % PERIOD`: a non-zero constant is never 0
    }
    if (stripParensAndCasts(divisor).type === "sizeof_expression") {
      continue; // sizeof is at least 1
    }
    if (numericValue(divisor, source.macros) === 0) {
      findings.push(
        createFinding({
          ruleId: DIV_ZERO_RULE,
          message: `${what(node)} by zero: the divisor is the constant 0.`,
          file: source.file,
          range: nodeRange(divisor),
          certainty: "definite",
        })
      );
      continue;
    }
    const fn = enclosingFunction(node);
    if (!fn || fn.type !== "function_definition" || fn.hasError) {
      continue;
    }
    const entry = byFunction.get(fn.id) ?? { fn, divisions: [] };
    entry.divisions.push(node);
    byFunction.set(fn.id, entry);
  }
  const engine = byFunction.size > 0 ? engineFor(source) : undefined;
  if (!engine) {
    return findings;
  }
  for (const { fn, divisions } of byFunction.values()) {
    const wanted = new Set(divisions.map((d) => d.id));
    const seen = new Map<number, { op: Node; divisor: Node; value: Value }>();
    const fa = engine.analyze(fn, {
      division: (op, divisor, value) => {
        if (!wanted.has(op.id)) {
          return;
        }
        const old = seen.get(op.id);
        seen.set(op.id, { op, divisor, value: old ? join(old.value, value) : value });
      },
    });
    for (const { op, divisor, value } of seen.values()) {
      const finding = judge(source.file, op, divisor, value, fa.name);
      if (finding) {
        findings.push(finding);
      }
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

function what(op: Node): string {
  return (op.childForFieldName("operator")?.type ?? "/").startsWith("%") ? "Remainder" : "Division";
}

function judge(file: string, op: Node, divisorNode: Node, v: Value, fnName: string): Finding | undefined {
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
