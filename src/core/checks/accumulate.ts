// runtime-bugfinder:overflow for accumulators that nothing limits. The value engine widens a loop variable to
// "unknown" after a few rounds, and it does not see a field grow from one call to the next, so it cannot back
// such an overflow with a range. These two shapes are evidence on their own:
//
//   * a signed variable multiplied by a constant >= 2 on every pass of a loop that has no iteration limit
//     (the loop condition compares nothing with <, <=, >, >=: it stops at a data value, like `*s != '\0'`),
//     and nothing in the loop compares the variable: `value = value * 10 + digit` overflows after enough digits;
//   * a signed object that lives across calls (a field behind a pointer parameter, a global) that a function
//     adds a computed step to (`p->integral += error * p->ki`), when nothing in the project compares or limits
//     that field or variable, and the step can be as wide as the object's type (`error * ki` into an s32):
//     over a few calls it leaves its type (an integrator without anti-windup).
//
// Not reported: a constant step (`n += 1`, a counter), a step narrower than the object (an s16 current added
// to an s32 charge counter needs tens of thousands of calls), and windows that also take values out again
// (`sum -= old; sum += x;`).

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { CType } from "../engine/declarations";
import { engineFor, FileEngine } from "../engine/index";
import { FunctionModel } from "../engine/interpreter";
import { ScalarType } from "../engine/types";
import { createFinding, Finding } from "../finding";
import { nodeRange } from "../parser/parser";
import { OVERFLOW_RULE } from "./runtime";
import { numericValue, stripParens } from "./syntax";

const RELATIONAL = /^(<|<=|>|>=)$/;
const LOOPS = ["while_statement", "for_statement", "do_statement"];

export function checkAccumulators(source: SourceContext): Finding[] {
  const engine = engineFor(source);
  if (!engine || !source.declarations) {
    return [];
  }
  const out: Finding[] = [];
  const reported = new Set<number>();
  const fileLimited = limitedInFile(engine);
  const shrinking = decreased(engine);
  for (const fn of engine.functionNodes()) {
    const model = engine.modelFor(fn);
    const typeOf = (n: Node) => lvalueType(n, model, engine);
    for (const loop of engine.within(fn, ...LOOPS)) {
      if (!unbounded(loop)) {
        continue;
      }
      for (const a of engine.within(loop, "assignment_expression")) {
        const hit = multiplied(a, source);
        if (!hit || reported.has(a.id)) {
          continue;
        }
        const t = typeOf(hit.target);
        if (!t || !signedInt(t) || comparedIn(loop, hit.target.text, engine)) {
          continue;
        }
        reported.add(a.id);
        out.push(
          createFinding({
            ruleId: OVERFLOW_RULE,
            message: `Possible integer overflow: '${hit.target.text}' is multiplied by ${hit.factor} on every pass of a loop that runs until a data value stops it, and nothing limits '${hit.target.text}'; enough passes take it outside ${t.name} [${t.lo}, ${t.hi}].`,
            file: source.file,
            range: nodeRange(a),
            certainty: "possible",
          })
        );
      }
    }
    for (const a of engine.within(fn, "assignment_expression")) {
      const hit = persistentStep(a, model, source);
      if (!hit || reported.has(a.id)) {
        continue;
      }
      const t = typeOf(hit.target);
      const name = memberName(hit.target);
      if (!t || !signedInt(t) || !name || shrinking.has(hit.target.text.replace(/\s+/g, "")) || stepWidth(hit.step, model, engine) < widthOf(t)) {
        continue;
      }
      const limited = source.knowledge ? source.knowledge.isLimited(name) || fileLimited.has(name) : fileLimited.has(name);
      if (limited) {
        continue;
      }
      reported.add(a.id);
      const target = hit.target.text.replace(/\s+/g, " ");
      out.push(
        createFinding({
          ruleId: OVERFLOW_RULE,
          message: `Possible integer overflow: '${target}' keeps its value between calls and adds '${hit.step.text.replace(/\s+/g, " ")}' on every call, but nothing ${source.knowledge ? "in the project" : "in this file"} compares or limits '${name}'; over enough calls it leaves ${t.name} [${t.lo}, ${t.hi}].`,
          file: source.file,
          range: nodeRange(a),
          certainty: "possible",
        })
      );
    }
  }
  return out;
}

const signedInt = (t: ScalarType) => t.kind === "int" && !t.unsigned && Number.isFinite(t.lo) && Number.isFinite(t.hi);

/** A loop whose condition (if any) compares nothing with an ordering operator: no iteration limit. */
function unbounded(loop: Node): boolean {
  const cond = loop.childForFieldName("condition");
  if (!cond) {
    return false; // for (;;) / while (1) style loops end somewhere else; not judged here
  }
  if (numericValue(stripParens(cond)) !== undefined) {
    return false;
  }
  return ![cond, ...cond.descendantsOfType("binary_expression")].some((b) => b?.type === "binary_expression" && RELATIONAL.test(b.childForFieldName("operator")?.type ?? ""));
}

/** `v = v * K + e`, `v = K * v + e`, `v = (v * K) - e`, `v *= K` with a constant K >= 2. */
function multiplied(a: Node, source: SourceContext): { target: Node; factor: number } | undefined {
  const left = a.childForFieldName("left");
  const right = a.childForFieldName("right");
  const op = a.childForFieldName("operator")?.type;
  if (!left || !right) {
    return undefined;
  }
  const constant = (n: Node | null) => (n ? numericValue(n, source.macros) : undefined);
  if (op === "*=") {
    const k = constant(right);
    return k !== undefined && Math.abs(k) >= 2 ? { target: left, factor: k } : undefined;
  }
  if (op !== "=") {
    return undefined;
  }
  let r = stripParens(right);
  if (r.type === "binary_expression" && /^[+-]$/.test(r.childForFieldName("operator")?.type ?? "")) {
    r = stripParens(r.childForFieldName("left") ?? r);
  }
  if (r.type !== "binary_expression" || r.childForFieldName("operator")?.type !== "*") {
    return undefined;
  }
  const x = r.childForFieldName("left");
  const y = r.childForFieldName("right");
  for (const [v, k] of [
    [x, y],
    [y, x],
  ] as const) {
    const factor = constant(k);
    if (v && factor !== undefined && Math.abs(factor) >= 2 && stripParens(v).text === left.text) {
      return { target: left, factor };
    }
  }
  return undefined;
}

/** True when some comparison inside `scope` uses `name` (`value > LIMIT`, `if (v >= max) break;`). */
function comparedIn(scope: Node, name: string, engine: FileEngine): boolean {
  return engine.within(scope, "binary_expression").some((b) => RELATIONAL.test(b.childForFieldName("operator")?.type ?? "") && [b.childForFieldName("left"), b.childForFieldName("right")].some((s) => s !== null && stripParens(s).text === name));
}

/**
 * `X += step` / `X -= step` / `X = X + step` where X lives across calls (`p->f` with p a pointer parameter
 * that is not const, or a global) and the step is computed (not a constant).
 */
function persistentStep(a: Node, model: FunctionModel, source: SourceContext): { target: Node; step: Node } | undefined {
  const left = a.childForFieldName("left");
  const right = a.childForFieldName("right");
  const op = a.childForFieldName("operator")?.type;
  if (!left || !right) {
    return undefined;
  }
  let step: Node | null = null;
  if (op === "+=" || op === "-=") {
    step = right;
  } else if (op === "=") {
    const r = stripParens(right);
    if (r.type === "binary_expression" && /^[+-]$/.test(r.childForFieldName("operator")?.type ?? "") && stripParens(r.childForFieldName("left") ?? r).text === left.text) {
      step = r.childForFieldName("right");
    }
  }
  if (!step || numericValue(step, source.macros) !== undefined || !persistent(left, model, source)) {
    return undefined;
  }
  const computed = [step, ...step.descendantsOfType("identifier")].some((id) => id?.type === "identifier" && model.locals.has(id.text));
  return computed ? { target: left, step } : undefined;
}

function persistent(n: Node, model: FunctionModel, source: SourceContext): boolean {
  const x = stripParens(n);
  if (x.type === "identifier") {
    return !model.locals.has(x.text) && source.declarations?.varType(x.text) !== undefined;
  }
  if (x.type === "field_expression" && x.childForFieldName("operator")?.type === "->") {
    const p = x.childForFieldName("argument");
    return p?.type === "identifier" && model.params.has(p.text) && !model.inputParams.has(p.text);
  }
  return false;
}

function memberName(n: Node): string | undefined {
  const x = stripParens(n);
  return x.type === "field_expression" ? x.childForFieldName("field")?.text : x.type === "identifier" ? x.text : undefined;
}

/** The scalar type of `x`, `p->f`, `s.f`, `a[i]` from the declarations. */
function lvalueType(n: Node, model: FunctionModel, engine: FileEngine): ScalarType | undefined {
  const d = engine.decls;
  const typeOf = (x: Node): CType | undefined => {
    x = stripParens(x);
    if (x.type === "identifier") {
      const tracked = model.tracked.get(x.text);
      return model.declTypes.get(x.text) ?? (tracked ? undefined : d.varType(x.text));
    }
    if (x.type === "field_expression") {
      const base = x.childForFieldName("argument");
      const member = x.childForFieldName("field")?.text;
      const t = base ? typeOf(base) : undefined;
      if (!member) {
        return undefined;
      }
      const r = d.resolve(t);
      return d.field(x.childForFieldName("operator")?.type === "->" ? (r?.k === "ptr" ? r.to : r?.k === "array" ? r.of : undefined) : t, member);
    }
    if (x.type === "subscript_expression") {
      const r = d.resolve(typeOf(x.childForFieldName("argument") ?? x));
      return r?.k === "ptr" ? r.to : r?.k === "array" ? r.of : undefined;
    }
    return undefined;
  };
  const x = stripParens(n);
  if (x.type === "identifier" && model.tracked.has(x.text)) {
    return model.tracked.get(x.text)?.type;
  }
  return d.scalarOf(typeOf(x));
}

const widthOf = (t: ScalarType) => Math.ceil(Math.log2(t.hi - t.lo + 1));

/**
 * The widest operand type of a step (in bits); 0 when the step is a quotient or a right shift (it is smaller
 * than its operands) or no operand type is known.
 */
function stepWidth(step: Node, model: FunctionModel, engine: FileEngine): number {
  const s = stripParens(step);
  if (s.type === "binary_expression" && /^(\/|>>|%)$/.test(s.childForFieldName("operator")?.type ?? "")) {
    return 0;
  }
  let width = 0;
  for (const n of [s, ...s.descendantsOfType(["identifier", "field_expression", "subscript_expression"])]) {
    if (!n || !/^(identifier|field_expression|subscript_expression)$/.test(n.type) || n.parent?.type === "field_expression") {
      continue;
    }
    const t = lvalueType(n, model, engine);
    if (t && t.kind === "int" && Number.isFinite(t.hi) && Number.isFinite(t.lo)) {
      width = Math.max(width, widthOf(t));
    }
  }
  return width;
}

/** Objects that some function of the file also takes values out of (`sum -= old`), in compact text form. */
function decreased(engine: FileEngine): Set<string> {
  const out = new Set<string>();
  for (const a of engine.nodes("assignment_expression")) {
    const left = a.childForFieldName("left");
    if (left && a.childForFieldName("operator")?.type === "-=") {
      out.add(left.text.replace(/\s+/g, ""));
    }
  }
  return out;
}

/** Names compared with an ordering operator anywhere in the file, or set from a call or a condition. */
function limitedInFile(engine: FileEngine): Set<string> {
  const out = new Set<string>();
  const name = (s: Node | null) => (s ? memberName(s) : undefined);
  for (const b of engine.nodes("binary_expression")) {
    if (RELATIONAL.test(b.childForFieldName("operator")?.type ?? "")) {
      for (const s of [b.childForFieldName("left"), b.childForFieldName("right")]) {
        const n = name(s);
        if (n) {
          out.add(n);
        }
      }
    }
  }
  for (const a of engine.nodes("assignment_expression")) {
    const r = a.childForFieldName("right");
    if (a.childForFieldName("operator")?.type === "=" && r && /^(call_expression|conditional_expression)$/.test(stripParens(r).type)) {
      const n = name(a.childForFieldName("left"));
      if (n) {
        out.add(n);
      }
    }
  }
  return out;
}
