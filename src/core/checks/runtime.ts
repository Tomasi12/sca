// Run-time error checks on the value engine (src/core/engine). Every function is solved once; one observer
// collects what each check needs, then each check judges its events.
//
// Common policy: a finding needs evidence. Division and null checks need a named source of the 0 / NULL
// (the "zero witness"). Bounds, overflow, shift, wrap and conversion checks only use range bounds that are
// backed by the code (a constant, a parameter's type, a condition); bounds that come from unknown values or
// from widening a loop never give a finding. "definite" means the error happens whenever the line runs;
// "possible" means some values that reach the line cause it.
//
//   runtime-bugfinder:div-zero      / or % by a value that can be 0 (see divByZero.ts)
//   runtime-bugfinder:null-deref    *p, p->f, p[i] where p can be NULL (from NULL itself, or a function that can return NULL)
//   runtime-bugfinder:uninit-read   a local read before it is set on some (or every) path
//   runtime-bugfinder:out-of-bounds a[i] with i outside the array; an unsigned index that wraps below 0;
//                                   memcpy / memset / memmove past the end of an array
//   runtime-bugfinder:overflow      signed arithmetic outside its type; a cast to a narrower signed type that does not fit
//   runtime-bugfinder:uint-wrap     x++ / x-- / x += k / x -= k (constant k) on an unsigned variable that wraps around
//   runtime-bugfinder:invalid-shift shift by a negative amount or by the bit width or more
//   runtime-bugfinder:conversion    a cast of a possibly negative value to an unsigned type (not in a comparison)
//   runtime-bugfinder:dead-code     an if branch that is never taken; code that cannot be reached
//   runtime-bugfinder:endless-loop  a loop whose condition is always true, or a wait loop with no way out
//   runtime-bugfinder:stack-escape  returning the address of a local variable
//   sca-own:invariant-condition     an if condition that is always true or always false (reported with dead-code)

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { engineFor } from "../engine";
import { reachableBlocks } from "../engine/cfg";
import { FunctionAnalysis } from "../engine/interpreter";
import { ScalarType } from "../engine/types";
import { widthOf } from "../engine/typing";
import { join, Value } from "../engine/value";
import { Certainty, createFinding, Finding } from "../finding";
import { nodeRange } from "../parser/parser";
import { DIV_ZERO_RULE, divisorOf, judgeDivision, what } from "./divZeroJudge";
import { alwaysExits, insideError, numericValue, stripParensAndCasts } from "./syntax";

export const NULL_DEREF_RULE = "runtime-bugfinder:null-deref";
export const UNINIT_RULE = "runtime-bugfinder:uninit-read";
export const OOB_RULE = "runtime-bugfinder:out-of-bounds";
export const OVERFLOW_RULE = "runtime-bugfinder:overflow";
export const UINT_WRAP_RULE = "runtime-bugfinder:uint-wrap";
export const SHIFT_RULE = "runtime-bugfinder:invalid-shift";
export const CONVERSION_RULE = "runtime-bugfinder:conversion";
export const DEAD_CODE_RULE = "runtime-bugfinder:dead-code";
export const ENDLESS_LOOP_RULE = "runtime-bugfinder:endless-loop";
export const STACK_ESCAPE_RULE = "runtime-bugfinder:stack-escape";
export const INVARIANT_RULE = "sca-own:invariant-condition";

/** Rules this check produces (div-zero included). */
export const RUNTIME_RULES = [
  DIV_ZERO_RULE,
  NULL_DEREF_RULE,
  UNINIT_RULE,
  OOB_RULE,
  OVERFLOW_RULE,
  UINT_WRAP_RULE,
  SHIFT_RULE,
  CONVERSION_RULE,
  DEAD_CODE_RULE,
  ENDLESS_LOOP_RULE,
  STACK_ESCAPE_RULE,
  INVARIANT_RULE,
];

const fmt = (x: number) => (x === Infinity ? "+inf" : x === -Infinity ? "-inf" : String(x));

export function checkRuntime(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const file = source.file;
  const findings: Finding[] = [];
  const literalZero = new Set<number>();
  const engine = engineFor(source);
  const operators = engine ? [...engine.nodes("binary_expression"), ...engine.nodes("assignment_expression")] : source.parsed.root.descendantsOfType(["binary_expression", "assignment_expression"]);
  // Constant-0 divisors are reported everywhere (also outside functions and in functions the engine skips).
  for (const node of operators) {
    const divisor = node ? divisorOf(node) : undefined;
    if (!node || !divisor || insideError(node)) {
      continue;
    }
    if (numericValue(divisor, source.macros) === 0) {
      literalZero.add(node.id);
      findings.push(
        createFinding({ ruleId: DIV_ZERO_RULE, message: `${what(node)} by zero: the divisor is the constant 0.`, file, range: nodeRange(divisor), certainty: "definite" })
      );
    }
  }
  if (!engine) {
    return findings;
  }
  for (const fn of engine.functionNodes()) {
    if (insideError(fn)) {
      continue;
    }
    const loops = engine.within(fn, "while_statement", "for_statement", "do_statement");
    const { fa, results } = engine.check(fn, (a) => judgeFunction(file, a, literalZero, loops));
    findings.push(...results);
    if (fa.outcome?.ok !== true) {
      continue;
    }
    findings.push(...syntacticChecks(file, fa, engine.within(fn, "return_statement")));
  }
  return findings;
}

/** Replays one solved function and turns its events into findings. */
function judgeFunction(file: string, fa: FunctionAnalysis, literalZero: ReadonlySet<number>, loops: readonly Node[]): Finding[] {
  const divisions = new Map<number, { op: Node; divisor: Node; v: Value }>();
  const derefs = new Map<number, { ptr: Node; v: Value }>();
  const reads = new Map<number, { at: Node; name: string; init: Value["init"] }>();
  const indexes = new Map<number, { at: Node; v: Value; length?: number; unsigned: boolean }>();
  const extents = new Map<string, { at: Node; end: Value; length: number; what: string }>();
  const ariths = new Map<number, { at: Node; v: Value; t: ScalarType }>();
  const casts = new Map<number, { at: Node; v: Value; from?: ScalarType; to: ScalarType }>();
  const shifts = new Map<number, { at: Node; v: Value; width: number }>();
  const updates = new Map<number, { at: Node; name: string; t: ScalarType; before: Value; result: Value }>();
  const branches = new Map<string, { cond: Node; truth: boolean; feasible: boolean }>();
  const merge = <K, T extends { v: Value }>(m: Map<K, T>, k: K, entry: T) => {
    const old = m.get(k);
    m.set(k, old ? { ...entry, v: join(old.v, entry.v) } : entry);
  };
  fa.replay({
    division: (op, divisor, v) => {
      if (!literalZero.has(op.id)) {
        merge(divisions, op.id, { op, divisor, v });
      }
    },
    deref: (_at, ptr, v) => merge(derefs, ptr.id, { ptr, v }),
    read: (at, info, v) => {
      if (info.param) {
        return;
      }
      const old = reads.get(at.id);
      const init = old ? (old.init === v.init ? v.init : "maybe") : v.init;
      reads.set(at.id, { at, name: info.name, init });
    },
    index: (at, v, length, unsigned) => merge(indexes, at.id, { at, v, length, unsigned }),
    extent: (at, end, length, what) => {
      const k = `${at.id}:${what}`;
      const old = extents.get(k);
      extents.set(k, old ? { ...old, end: join(old.end, end) } : { at, end, length, what });
    },
    arith: (at, v, t) => merge(ariths, at.id, { at, v, t }),
    cast: (at, v, from, to) => merge(casts, at.id, { at, v, from, to }),
    shift: (at, v, width) => merge(shifts, at.id, { at, v, width }),
    update: (at, info, before, result) => {
      const old = updates.get(at.id);
      updates.set(at.id, old ? { ...old, before: join(old.before, before), result: join(old.result, result) } : { at, name: info.name, t: info.type, before, result });
    },
    branch: (cond, truth, feasible) => {
      const k = `${cond.id}:${truth}`;
      const old = branches.get(k);
      branches.set(k, { cond, truth, feasible: feasible || (old?.feasible ?? false) });
    },
  });

  const out: Finding[] = [];
  const add = (ruleId: string, message: string, node: Node, certainty: Certainty) => out.push(createFinding({ ruleId, message, file, range: nodeRange(node), certainty }));

  for (const { op, divisor, v } of divisions.values()) {
    const f = judgeDivision(file, op, divisor, v, fa.name);
    if (f) {
      out.push(f);
    }
  }

  for (const { ptr, v } of derefs.values()) {
    if (v.kind !== "ptr") {
      continue;
    }
    const name = ptr.text.replace(/\s+/g, " ");
    if (v.hi === 0) {
      add(NULL_DEREF_RULE, `Null pointer dereference: '${name}' is always NULL here${v.zero ? ` (${v.zero})` : ""}.`, ptr, "definite");
    } else if (v.lo === 0 && v.zero !== undefined) {
      add(NULL_DEREF_RULE, `Possible null pointer dereference: '${name}' can be NULL here (source of the NULL: ${v.zero}).`, ptr, "possible");
    }
  }

  for (const { at, name, init } of reads.values()) {
    if (init === "no") {
      add(UNINIT_RULE, `'${name}' is read before it is set.`, at, "definite");
    } else if (init === "maybe") {
      add(UNINIT_RULE, `'${name}' may be read before it is set: some path reaches this line without setting it.`, at, "possible");
    }
  }

  for (const { at, v, length, unsigned } of indexes.values()) {
    const index = at.childForFieldName("index") ?? at;
    const what = index.text.replace(/\s+/g, " ");
    if (length !== undefined) {
      const tooHigh = v.hi >= length && !v.wh;
      const tooLow = v.lo < 0 && !v.wl;
      if (tooHigh || tooLow) {
        const always = (tooHigh && v.lo >= length && !v.wl) || (tooLow && v.hi < 0 && !v.wh);
        const range = `[${fmt(v.lo)}, ${fmt(v.hi)}]`;
        const why = tooLow && unsigned ? ` (an unsigned value below 0 wraps around to a huge index)` : "";
        add(OOB_RULE, `${always ? "Array index out of bounds" : "Possible array index out of bounds"}: '${what}' can be ${range}, the array has ${length} elements (0..${length - 1})${why}.`, index, always ? "definite" : "possible");
      }
    } else if (unsigned && v.lo < 0 && !v.wl) {
      add(OOB_RULE, `Possible out-of-bounds access: the unsigned index '${what}' wraps around to a huge value when it goes below 0 (it can be ${fmt(v.lo)} before the wrap).`, index, v.hi < 0 && !v.wh ? "definite" : "possible");
    }
  }

  for (const { at, end, length, what } of extents.values()) {
    if (end.hi > length && !end.wh) {
      const always = end.lo > length && !end.wl;
      const fnName = at.childForFieldName("function")?.text ?? "the call";
      add(OOB_RULE, `${always ? "Buffer overflow" : "Possible buffer overflow"}: ${fnName}() can reach byte ${fmt(end.hi)} of the ${what}, which has ${length} bytes.`, at, always ? "definite" : "possible");
    }
  }

  for (const { at, v, t } of ariths.values()) {
    const high = v.hi > t.hi && !v.wh;
    const low = v.lo < t.lo && !v.wl;
    if (high || low) {
      const always = (high && v.lo > t.hi && !v.wl) || (low && v.hi < t.lo && !v.wh);
      add(OVERFLOW_RULE, `${always ? "Integer overflow" : "Possible integer overflow"}: '${at.text.replace(/\s+/g, " ")}' can be [${fmt(v.lo)}, ${fmt(v.hi)}], outside ${t.name} [${fmt(t.lo)}, ${fmt(t.hi)}].`, at, always ? "definite" : "possible");
    }
  }

  for (const { at, v, from, to } of casts.values()) {
    if (to.kind !== "int" || v.kind === "ptr") {
      continue;
    }
    if (!Number.isFinite(v.lo) || !Number.isFinite(v.hi)) {
      continue; // e.g. a float parameter: any value; float-to-int conversion is another check
    }
    if (!to.unsigned) {
      const high = v.hi > to.hi && !v.wh;
      const low = v.lo < to.lo && !v.wl;
      // Only narrowing from a wider signed type (s32 -> s16); u16 -> s16 and float -> int are other checks.
      if ((high || low) && from && from.kind === "int" && !from.unsigned && widthOf(from) > widthOf(to)) {
        const always = (high && v.lo > to.hi && !v.wl) || (low && v.hi < to.lo && !v.wh);
        add(OVERFLOW_RULE, `${always ? "Value does not fit" : "Value may not fit"} in ${to.name}: it can be [${fmt(v.lo)}, ${fmt(v.hi)}], ${to.name} holds [${fmt(to.lo)}, ${fmt(to.hi)}].`, at, always ? "definite" : "possible");
      }
    } else if (v.lo < 0 && !v.wl && from && from.kind === "int" && !from.unsigned && !inComparison(at) && isPlainValue(at)) {
      const always = v.hi < 0 && !v.wh;
      add(CONVERSION_RULE, `${always ? "Negative value converted" : "Possibly negative value converted"} to ${to.name}: it can be ${fmt(v.lo)}, which becomes a large positive number.`, at, always ? "definite" : "possible");
    }
  }

  for (const { at, v, width } of shifts.values()) {
    const amount = at.childForFieldName("right") ?? at;
    const tooFar = v.hi >= width && !v.wh;
    const negative = v.lo < 0 && !v.wl;
    if (tooFar || negative) {
      const always = (tooFar && v.lo >= width && !v.wl) || (negative && v.hi < 0 && !v.wh);
      add(SHIFT_RULE, `${always ? "Invalid shift" : "Possible invalid shift"}: the shift amount '${amount.text}' can be [${fmt(v.lo)}, ${fmt(v.hi)}]; for a ${width}-bit value it must be 0..${width - 1}.`, amount, always ? "definite" : "possible");
    }
  }

  for (const { at, name, t, result } of updates.values()) {
    if (t.kind !== "int" || !t.unsigned || !Number.isFinite(t.hi) || !isCounterStep(at)) {
      continue;
    }
    if (result.hi > t.hi && !result.wh) {
      add(UINT_WRAP_RULE, `Possible wrap-around: ${t.name} '${name}' can go past ${fmt(t.hi)} here and wraps to 0.`, at, result.lo > t.hi && !result.wl ? "definite" : "possible");
    } else if (result.lo < 0 && !result.wl) {
      add(UINT_WRAP_RULE, `Possible wrap-around: ${t.name} '${name}' can go below 0 here and wraps to ${fmt(t.hi)}.`, at, result.hi < 0 && !result.wh ? "definite" : "possible");
    }
  }

  out.push(...deadBranches(file, branches));
  out.push(...endlessLoops(file, loops, branches));
  return out;
}

/** x++ / x-- / x += k / x -= k with a constant k: a counter step. Accumulating values (s += x) often wraps on purpose. */
function isCounterStep(at: Node): boolean {
  if (at.type === "update_expression") {
    return true;
  }
  const op = at.childForFieldName("operator")?.type;
  const right = at.childForFieldName("right");
  return (op === "+=" || op === "-=") && !!right && numericValue(right) !== undefined;
}

/** The cast's operand is a variable, field, element or call result, not computed arithmetic. */
function isPlainValue(cast: Node): boolean {
  let v = cast.childForFieldName("value") ?? cast.childForFieldName("arguments")?.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
  while (v?.type === "parenthesized_expression") {
    v = v.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
  }
  return !!v && ["identifier", "field_expression", "subscript_expression", "call_expression", "pointer_expression"].includes(v.type);
}

function inComparison(node: Node): boolean {
  let p = node.parent;
  while (p && p.type === "parenthesized_expression") {
    p = p.parent;
  }
  return p?.type === "binary_expression" && ["<", "<=", ">", ">=", "==", "!="].includes(p.childForFieldName("operator")?.type ?? "");
}

/** if-branches whose condition outcome never happens (on any path, in any round of a loop). */
function deadBranches(file: string, branches: Map<string, { cond: Node; truth: boolean; feasible: boolean }>): Finding[] {
  const out: Finding[] = [];
  for (const b of branches.values()) {
    const stmt = b.cond.parent;
    if (b.feasible || stmt?.type !== "if_statement" || !branches.get(`${b.cond.id}:${!b.truth}`)?.feasible || !usesVariables(b.cond)) {
      continue;
    }
    const target = b.truth ? stmt.childForFieldName("consequence") : stmt.childForFieldName("alternative");
    if (!target) {
      continue;
    }
    out.push(
      createFinding({
        ruleId: INVARIANT_RULE,
        message: `The condition '${b.cond.text.replace(/\s+/g, " ")}' is always ${b.truth ? "false" : "true"}; remove it or fix the test.`,
        file,
        range: nodeRange(b.cond),
        certainty: "definite",
        severity: "warning",
      })
    );
    const first = firstStatement(target);
    out.push(
      createFinding({
        ruleId: DEAD_CODE_RULE,
        message: `Dead code: this branch never runs, the condition '${b.cond.text.replace(/\s+/g, " ")}' is always ${b.truth ? "false" : "true"} here.`,
        file,
        range: nodeRange(first),
        certainty: "definite",
      })
    );
  }
  return out;
}

function firstStatement(n: Node): Node {
  let cur = n;
  for (;;) {
    const inner =
      cur.type === "compound_statement" || cur.type === "else_clause" ? cur.namedChildren.find((c) => c !== null && c.type !== "comment") : undefined;
    if (!inner) {
      return cur;
    }
    cur = inner;
  }
}

/** True when a condition depends on something other than constants (a constant `if (0)` is on purpose). */
function usesVariables(cond: Node): boolean {
  return cond.descendantsOfType(["identifier", "field_expression", "call_expression"]).some((n) => n !== null && !/^[A-Z_][A-Z0-9_]*$/.test(n.text));
}

/** Loops that never end: the exit test is never true, or a wait loop on something that never changes. */
function endlessLoops(file: string, loops: readonly Node[], branches: Map<string, { cond: Node; truth: boolean; feasible: boolean }>): Finding[] {
  const out: Finding[] = [];
  for (const loop of loops) {
    const cond = loop.childForFieldName("condition");
    const loopBody = loop.childForFieldName("body");
    if (!cond || !loopBody) {
      continue;
    }
    const exit = branches.get(`${cond.id}:false`);
    const enter = branches.get(`${cond.id}:true`);
    const alwaysTrue = exit && enter?.feasible && !exit.feasible;
    // A for-loop with an update (`t++`) changes something each round: not a plain wait loop.
    const empty = isEmptyBody(loopBody) && !(loop.type === "for_statement" && loop.childForFieldName("update"));
    if ((!alwaysTrue && !empty) || !usesVariables(cond) || hasExit(loopBody)) {
      continue;
    }
    if (alwaysTrue) {
      out.push(
        createFinding({
          ruleId: ENDLESS_LOOP_RULE,
          message: `Endless loop: the condition '${cond.text.replace(/\s+/g, " ")}' is always true and nothing in the loop leaves it.`,
          file,
          range: nodeRange(cond),
          certainty: "definite",
        })
      );
      continue;
    }
    if (isEmptyBody(loopBody) && cond.descendantsOfType(["call_expression", "assignment_expression", "update_expression"]).length === 0 && readsMemory(cond)) {
      out.push(
        createFinding({
          ruleId: ENDLESS_LOOP_RULE,
          message: `Possible endless loop: this wait loop has no timeout; if '${cond.text.replace(/\s+/g, " ")}' never changes, it never ends.`,
          file,
          range: nodeRange(cond),
          certainty: "possible",
        })
      );
    }
  }
  return out;
}

function hasExit(body: Node): boolean {
  if (body.descendantsOfType(["return_statement", "goto_statement", "throw_statement"]).length > 0) {
    return true;
  }
  // A break that belongs to this loop: no loop or switch between it and the loop body.
  const ownBreak = body.descendantsOfType("break_statement").some((b) => {
    for (let p = b?.parent ?? null; p && p.id !== body.id; p = p.parent) {
      if (/^(while|for|do|switch)_statement$/.test(p.type)) {
        return false;
      }
    }
    return b !== null;
  });
  if (ownBreak || body.type === "break_statement") {
    return true;
  }
  return body.descendantsOfType("expression_statement").some((s) => s !== null && alwaysExits(s));
}

function isEmptyBody(body: Node): boolean {
  if (body.type === "compound_statement") {
    return body.namedChildren.every((c) => c === null || c.type === "comment");
  }
  return body.type === "expression_statement" && body.namedChildren.every((c) => c === null || c.type === "comment");
}

/** The condition reads memory something else can change (a field, a dereference, a global or register macro). */
function readsMemory(cond: Node): boolean {
  return cond.descendantsOfType(["field_expression", "subscript_expression", "pointer_expression", "identifier"]).some((n) => n !== null && n.type !== "identifier") ||
    cond.descendantsOfType("identifier").some((n) => n !== null && /^[A-Z_][A-Z0-9_]*$/.test(n.text) === false);
}

/** Checks that need the function's structure, not values: returning a local's address, unreachable code. */
function syntacticChecks(file: string, fa: FunctionAnalysis, returns: readonly Node[]): Finding[] {
  const out: Finding[] = [];
  for (const ret of returns) {
    const value = ret?.namedChildren.find((c) => c !== null && c.type !== "comment");
    if (!ret || !value) {
      continue;
    }
    const v = stripParensAndCasts(value);
    let local: string | undefined;
    if (v.type === "pointer_expression" && v.childForFieldName("operator")?.type === "&") {
      const arg = v.childForFieldName("argument");
      const root = arg ? rootIdentifier(arg) : undefined;
      local = root && fa.model.autoLocals.has(root) ? root : undefined;
    } else if (v.type === "identifier" && fa.model.autoLocals.has(v.text) && fa.model.declTypes.get(v.text)?.k === "array") {
      local = v.text;
    }
    if (local) {
      out.push(
        createFinding({
          ruleId: STACK_ESCAPE_RULE,
          message: `Returns the address of the local variable '${local}'; it is gone when the function returns.`,
          file,
          range: nodeRange(value),
          certainty: "definite",
        })
      );
    }
  }
  // Code in blocks the graph cannot reach (after return / break / goto, before the first case).
  const reachable = reachableBlocks(fa.cfg);
  const live = new Set<number>();
  for (const id of reachable) {
    for (const it of fa.cfg.blocks[id].items) {
      live.add(it.node.id);
    }
  }
  const reported = new Set<number>();
  for (const b of fa.cfg.blocks) {
    if (reachable.has(b.id) || b.items.length === 0) {
      continue;
    }
    const first = b.items[0].node;
    if (live.has(first.id) || reported.has(first.startPosition.row)) {
      continue;
    }
    reported.add(first.startPosition.row);
    out.push(createFinding({ ruleId: DEAD_CODE_RULE, message: "Unreachable code: no path leads to this statement.", file, range: nodeRange(first), certainty: "definite" }));
  }
  return out;
}

function rootIdentifier(n: Node): string | undefined {
  let cur: Node | null = n;
  while (cur) {
    if (cur.type === "identifier") {
      return cur.text;
    }
    if (cur.type === "subscript_expression" || (cur.type === "field_expression" && cur.childForFieldName("operator")?.type === ".")) {
      cur = cur.childForFieldName("argument");
    } else if (cur.type === "parenthesized_expression") {
      cur = cur.namedChildren.find((c) => c !== null) ?? null;
    } else {
      return undefined;
    }
  }
  return undefined;
}
