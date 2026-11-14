// Coding-rule checks (SCA's own rules, written in our own words).
//
// sca-own:switch-default — every `switch` needs a `default` clause, so unexpected values are handled on purpose.
// sca-own:goto           — `goto` is not used; it makes control flow hard to follow and to analyze.
//
// Both are certain (the rule is either broken or not), so findings are "definite" with severity "warning":
// they are rule violations, not run-time errors.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { createFinding, Finding } from "../finding";
import { nodeRange, toPosition, walk } from "../parser/parser";
import { insideError } from "./syntax";

export const SWITCH_DEFAULT_RULE = "sca-own:switch-default";
export const GOTO_RULE = "sca-own:goto";

export function checkSwitchDefault(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const findings: Finding[] = [];
  for (const node of walk(source.parsed.root)) {
    if (node.type !== "switch_statement" || insideError(node) || node.hasError) {
      continue;
    }
    const body = node.childForFieldName("body");
    if (!body || hasDefault(body)) {
      continue;
    }
    // Point at `switch (...)`, not at the whole body.
    const cond = node.childForFieldName("condition");
    findings.push(
      createFinding({
        ruleId: SWITCH_DEFAULT_RULE,
        message: "switch has no default clause; add one that handles unexpected values.",
        file: source.file,
        range: { start: toPosition(node.startPosition), end: toPosition((cond ?? node).endPosition) },
        certainty: "definite",
        severity: "warning",
      })
    );
  }
  return findings;
}

/** A `default:` label directly in this switch's body (not in a nested switch). */
function hasDefault(body: Node): boolean {
  for (const child of body.namedChildren) {
    if (child?.type === "case_statement" && !child.childForFieldName("value")) {
      return true;
    }
  }
  return false;
}

export function checkGoto(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const findings: Finding[] = [];
  for (const node of walk(source.parsed.root)) {
    if (node.type !== "goto_statement" || insideError(node)) {
      continue;
    }
    const label = node.childForFieldName("label")?.text;
    findings.push(
      createFinding({
        ruleId: GOTO_RULE,
        message: `goto${label ? ` ${label}` : ""} used; restructure with if / loops / early return.`,
        file: source.file,
        range: nodeRange(node),
        certainty: "definite",
        severity: "warning",
      })
    );
  }
  return findings;
}
