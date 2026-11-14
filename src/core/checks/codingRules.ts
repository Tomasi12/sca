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
import { nodeRange, toPosition } from "../parser/parser";
import { alwaysExits, insideError } from "./syntax";

export const SWITCH_DEFAULT_RULE = "sca-own:switch-default";
export const GOTO_RULE = "sca-own:goto";

export function checkSwitchDefault(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const findings: Finding[] = [];
  for (const node of source.parsed.root.descendantsOfType("switch_statement")) {
    if (!node || insideError(node) || node.hasError) {
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
  for (const node of source.parsed.root.descendantsOfType("goto_statement")) {
    if (!node || insideError(node)) {
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

export const FALLTHROUGH_RULE = "sca-own:switch-fallthrough";
export const UNCHECKED_RETURN_RULE = "sca-own:unchecked-return";

/**
 * sca-own:switch-fallthrough — a case that has statements must end with break / return / continue / goto
 * (or a call that never returns); otherwise execution falls into the next case. A comment containing
 * "fall" (e.g. `/* fallthrough *\/`) or `[[fallthrough]]` marks it as intended. Stacked labels are fine.
 */
export function checkSwitchFallthrough(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const findings: Finding[] = [];
  for (const sw of source.parsed.root.descendantsOfType("switch_statement")) {
    const body = sw?.childForFieldName("body");
    if (!sw || !body || insideError(sw) || sw.hasError) {
      continue;
    }
    const cases = body.namedChildren.filter((c): c is Node => c !== null && c.type === "case_statement");
    for (let i = 0; i + 1 < cases.length; i++) {
      const value = cases[i].childForFieldName("value");
      const stmts = cases[i].namedChildren.filter((c): c is Node => c !== null && c.id !== value?.id && c.type !== "comment");
      if (stmts.length === 0 || alwaysExits(stmts[stmts.length - 1]) || endsInExit(stmts[stmts.length - 1])) {
        continue;
      }
      const between = source.text.slice(stmts[stmts.length - 1].endIndex, cases[i + 1].startIndex);
      const ownComments = cases[i].namedChildren.filter((c) => c?.type === "comment").map((c) => c?.text ?? "");
      if (/fall|\[\[fallthrough\]\]/i.test(between) || ownComments.some((c) => /fall/i.test(c)) || /fallthrough/.test(stmts[stmts.length - 1].text)) {
        continue;
      }
      const next = cases[i + 1];
      findings.push(
        createFinding({
          ruleId: FALLTHROUGH_RULE,
          message: "The case before this one falls through into it (no break); add a break, or a /* fallthrough */ comment if it is intended.",
          file: source.file,
          range: { start: toPosition(next.startPosition), end: toPosition((next.childForFieldName("value") ?? next).endPosition) },
          certainty: "definite",
          severity: "warning",
        })
      );
    }
  }
  return findings;
}

/** An if/else whose branches all exit, or a block ending in one. */
function endsInExit(stmt: Node): boolean {
  if (stmt.type === "if_statement") {
    const then = stmt.childForFieldName("consequence");
    const alt = stmt.childForFieldName("alternative");
    const inner = alt?.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
    return !!then && !!inner && (alwaysExits(then) || endsInExit(then)) && (alwaysExits(inner) || endsInExit(inner));
  }
  if (stmt.type === "compound_statement") {
    const items = stmt.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment");
    return items.length > 0 && endsInExit(items[items.length - 1]);
  }
  return false;
}

/** Library functions whose result is commonly and safely ignored (they return their argument or a count). */
const IGNORABLE = new Set([
  "memcpy", "memmove", "memset", "strcpy", "strncpy", "strcat", "strncat", "printf", "fprintf", "sprintf", "snprintf", "vprintf",
  "vfprintf", "vsnprintf", "puts", "fputs", "putchar", "fputc", "putc", "fflush",
]);

/**
 * sca-own:unchecked-return — the result of a function that returns a value (a status, a count, a flag) is
 * thrown away. Write `(void)f();` when ignoring it is intended. Only functions whose declaration SCA can see
 * (the file and its headers) are checked; common library functions that return their argument are exempt.
 */
export function checkUncheckedReturn(source: SourceContext): Finding[] {
  const decls = source.declarations;
  if (!source.parsed || !decls) {
    return [];
  }
  const findings: Finding[] = [];
  for (const stmt of source.parsed.root.descendantsOfType("expression_statement")) {
    const call = stmt?.namedChildren.find((c) => c !== null && c.type !== "comment");
    if (!stmt || call?.type !== "call_expression" || insideError(stmt)) {
      continue;
    }
    const fn = call.childForFieldName("function");
    if (fn?.type !== "identifier" || IGNORABLE.has(fn.text)) {
      continue;
    }
    const ret = decls.resolve(decls.returnType(fn.text));
    if (!ret || (ret.k === "builtin" && ret.name === "void") || ret.k === "unknown") {
      continue;
    }
    findings.push(
      createFinding({
        ruleId: UNCHECKED_RETURN_RULE,
        message: `The value returned by ${fn.text}() is ignored; check it, or write (void)${fn.text}(...) if that is intended.`,
        file: source.file,
        range: nodeRange(call),
        certainty: "definite",
        severity: "warning",
      })
    );
  }
  return findings;
}
