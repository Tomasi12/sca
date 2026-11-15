// Coding rules, batch 2: control flow. (switch-default, goto and switch-fallthrough are in codingRules.ts.)
//
//   sca-own:missing-braces        the body of if / else / for / while / do is not a { } block
//   sca-own:empty-body            if / else / for / while with a lone `;` as body (often a stray semicolon)
//   sca-own:else-if-without-else  an if ... else if chain without a final else
//   sca-own:loop-float-counter    a for loop counts with a floating-point variable
//   sca-own:loop-counter-modified the counter of a for loop is also changed inside the body
//   sca-own:switch-too-few-cases  a switch with fewer than two clauses (an if is clearer)
//   sca-own:switch-on-boolean     a switch on a boolean expression

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { Finding } from "../finding";
import { toPosition } from "../parser/parser";
import { essentialType, functionAround, nodesOf, nodesWithin, ruleFinding, spanRange, typingFor } from "./ruleKit";
import { stripParens } from "./syntax";

export const MISSING_BRACES_RULE = "sca-own:missing-braces";
export const EMPTY_BODY_RULE = "sca-own:empty-body";
export const ELSE_IF_WITHOUT_ELSE_RULE = "sca-own:else-if-without-else";
export const LOOP_FLOAT_COUNTER_RULE = "sca-own:loop-float-counter";
export const LOOP_COUNTER_MODIFIED_RULE = "sca-own:loop-counter-modified";
export const SWITCH_TOO_FEW_CASES_RULE = "sca-own:switch-too-few-cases";
export const SWITCH_ON_BOOLEAN_RULE = "sca-own:switch-on-boolean";

export const CONTROL_FLOW_RULES = [
  MISSING_BRACES_RULE,
  EMPTY_BODY_RULE,
  ELSE_IF_WITHOUT_ELSE_RULE,
  LOOP_FLOAT_COUNTER_RULE,
  LOOP_COUNTER_MODIFIED_RULE,
  SWITCH_TOO_FEW_CASES_RULE,
  SWITCH_ON_BOOLEAN_RULE,
];

export function checkControlFlow(source: SourceContext): Finding[] {
  const out: Finding[] = [];
  for (const s of nodesOf(source, "if_statement", "for_statement", "while_statement", "do_statement", "for_range_loop", "switch_statement")) {
    if (s.type === "switch_statement") {
      switchRules(source, s, out);
      continue;
    }
    const keyword = s.type === "if_statement" ? "if" : s.type === "do_statement" ? "do" : s.type === "while_statement" ? "while" : "for";
    const body = s.childForFieldName(s.type === "if_statement" ? "consequence" : "body");
    const head = s.type === "do_statement" ? s.child(0) ?? s : s.childForFieldName("condition") ?? s;
    if (body) {
      bodyRules(source, keyword, body, spanRange(s, s.type === "for_statement" || s.type === "for_range_loop" ? headEnd(s, body) : head), out);
    }
    if (s.type === "if_statement") {
      const alt = s.childForFieldName("alternative");
      const inner = alt?.namedChildren.find((c) => c !== null && c.type !== "comment");
      if (alt && inner && inner.type !== "if_statement") {
        bodyRules(source, "else", inner, spanRange(alt, alt.child(0) ?? alt), out);
      }
      elseIfChain(source, s, out);
    }
    if (s.type === "for_statement") {
      forLoopRules(source, s, out);
    }
  }
  return out;
}

/** The `)` that closes a for header (just before the body). */
function headEnd(s: Node, body: Node): Node {
  let last: Node = s;
  for (let i = 0; i < s.childCount; i++) {
    const c = s.child(i);
    if (!c || c.id === body.id) {
      break;
    }
    last = c;
  }
  return last;
}

function bodyRules(source: SourceContext, keyword: string, body: Node, at: ReturnType<typeof spanRange>, out: Finding[]): void {
  if (body.type === "compound_statement") {
    return;
  }
  if (isEmptyStatement(body) && keyword !== "do") {
    const semi = { start: toPosition(body.startPosition), end: toPosition(body.endPosition) };
    out.push(ruleFinding(source, EMPTY_BODY_RULE, semi, `The ${keyword} has an empty body (a lone ";"); if that is intended write { } with a comment, otherwise remove the stray semicolon.`));
    return;
  }
  out.push(ruleFinding(source, MISSING_BRACES_RULE, at, `The body of this ${keyword} is not in braces; add { } so a later added line cannot fall outside it.`));
}

function isEmptyStatement(n: Node): boolean {
  return n.type === "expression_statement" && n.namedChildren.every((c) => c === null || c.type === "comment");
}

/** Reported once per chain, at the last `else if`. */
function elseIfChain(source: SourceContext, top: Node, out: Finding[]): void {
  if (top.parent?.type === "else_clause") {
    return; // not the head of the chain
  }
  let cur = top;
  let elseIfs = 0;
  for (;;) {
    const alt = cur.childForFieldName("alternative");
    if (!alt) {
      break;
    }
    const inner = alt.namedChildren.find((c) => c !== null && c.type !== "comment");
    if (inner?.type !== "if_statement") {
      return; // ends with a plain else
    }
    elseIfs++;
    cur = inner;
  }
  if (elseIfs > 0) {
    const cond = cur.childForFieldName("condition") ?? cur;
    out.push(ruleFinding(source, ELSE_IF_WITHOUT_ELSE_RULE, spanRange(cur.parent ?? cur, cond), "This if ... else if chain has no final else; add one that handles (or documents) the remaining cases."));
  }
}

function forLoopRules(source: SourceContext, s: Node, out: Finding[]): void {
  const counters = loopCounters(s);
  const typing = typingFor(source, functionAround(s));
  const init = s.childForFieldName("initializer");
  if (typing && init) {
    for (const [name, node] of counters) {
      const t = essentialType(source, typing, node);
      if (t?.kind === "float") {
        out.push(ruleFinding(source, LOOP_FLOAT_COUNTER_RULE, node, `The loop counter ${name} is floating-point; rounding makes the number of iterations uncertain. Count with an integer.`));
      }
    }
  }
  const body = s.childForFieldName("body");
  if (!body) {
    return;
  }
  for (const n of nodesWithin(source, body, "assignment_expression", "update_expression")) {
    const target = stripParens((n.type === "assignment_expression" ? n.childForFieldName("left") : n.childForFieldName("argument")) ?? n);
    if (target.type === "identifier" && counters.has(target.text)) {
      out.push(ruleFinding(source, LOOP_COUNTER_MODIFIED_RULE, n, `The loop counter ${target.text} is changed inside the loop body; change it only in the for header (or use a while loop).`));
    }
  }
}

/** Variables stepped in the for header's update part: `i++`, `i += 2`, `i = i + 1`. */
function loopCounters(s: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const u of s.childrenForFieldName("update")) {
    if (!u) {
      continue;
    }
    for (const n of [u, ...u.descendantsOfType(["update_expression", "assignment_expression"])]) {
      if (!n || (n.type !== "update_expression" && n.type !== "assignment_expression")) {
        continue;
      }
      const target = stripParens((n.type === "assignment_expression" ? n.childForFieldName("left") : n.childForFieldName("argument")) ?? n);
      if (target.type === "identifier") {
        out.set(target.text, target);
      }
    }
  }
  return out;
}

function switchRules(source: SourceContext, s: Node, out: Finding[]): void {
  const body = s.childForFieldName("body");
  const cond = s.childForFieldName("condition");
  if (!body || !cond || s.hasError) {
    return;
  }
  const head = spanRange(s, cond);
  const clauses = body.namedChildren.filter((c) => c?.type === "case_statement").length;
  if (clauses < 2) {
    out.push(ruleFinding(source, SWITCH_TOO_FEW_CASES_RULE, head, `This switch has ${clauses === 0 ? "no clauses" : "only one clause"}; an if statement says the same more clearly.`));
  }
  const inner = stripParens(cond);
  const typing = typingFor(source, functionAround(s));
  if (typing && essentialType(source, typing, inner)?.kind === "bool") {
    out.push(ruleFinding(source, SWITCH_ON_BOOLEAN_RULE, head, "This switch tests a boolean value; use if / else instead."));
  }
}
