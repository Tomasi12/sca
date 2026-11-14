// Abstract values: what the engine knows about one scalar at one program point.
//
//   * a range [lo, hi] (integers, floats; pointers use 0 = null, 1 = not null);
//   * a "zero witness": the reason the value can be 0 (a constant 0, an unchecked parameter, a memset, ...).
//     A range that merely *contains* 0 because nothing is known is not enough to report anything:
//     checks report only when they can name where the 0 comes from. This keeps unknown values quiet;
//   * whether the variable is set (initialized) on all paths, on some, or on none;
//   * for pointers, the static object they point into (`t = &tasks[i]` -> "tasks"), if known.

import { ScalarKind, ScalarType } from "./types";

export type Init = "yes" | "no" | "maybe";

export interface Value {
  readonly lo: number;
  readonly hi: number;
  readonly kind: ScalarKind;
  readonly zero?: string;
  readonly init: Init;
  readonly base?: string;
}

/** Exactly k. A 0 carries a witness only when one is given (a literal says "the constant 0"; a computed 0 may not). */
export function exact(k: number, kind: ScalarKind = "int", zero?: string): Value {
  return withZero({ lo: k, hi: k, kind, init: "yes" }, zero);
}

export function range(lo: number, hi: number, kind: ScalarKind = "int", zero?: string): Value {
  if (Number.isNaN(lo) || Number.isNaN(hi)) {
    return unknown(kind);
  }
  return withZero({ lo, hi, kind, init: "yes" }, zero);
}

/** Nothing known: the full range, no witness. */
export function unknown(kind: ScalarKind = "int"): Value {
  return kind === "ptr" ? { lo: 0, hi: 1, kind, init: "yes" } : { lo: -Infinity, hi: Infinity, kind, init: "yes" };
}

export function ofType(t: ScalarType, zero?: string): Value {
  return withZero({ lo: t.lo, hi: t.hi, kind: t.kind, init: "yes" }, zero);
}

export const containsZero = (v: Value): boolean => v.lo <= 0 && v.hi >= 0;
export const isExact = (v: Value, k: number): boolean => v.lo === k && v.hi === k;

/** Sets the witness, dropping it when 0 is not in the range any more. */
export function withZero(v: Value, zero: string | undefined): Value {
  const z = zero !== undefined && containsZero(v) ? zero : undefined;
  if (z === v.zero) {
    return v;
  }
  const rest: { -readonly [K in keyof Value]?: Value[K] } = { ...v };
  delete rest.zero;
  return (z === undefined ? rest : { ...rest, zero: z }) as Value;
}

/** Least upper bound of two values (paths merge). */
export function join(a: Value, b: Value): Value {
  const init: Init = a.init === b.init ? a.init : "maybe";
  const out: Value = {
    lo: Math.min(a.lo, b.lo),
    hi: Math.max(a.hi, b.hi),
    kind: a.kind === b.kind ? a.kind : a.kind === "float" || b.kind === "float" ? "float" : a.kind,
    init,
    base: a.base !== undefined && a.base === b.base ? a.base : undefined,
  };
  return withZero(out.base === undefined ? stripBase(out) : out, a.zero ?? b.zero);
}

/** Like join, but bounds that keep moving jump to the type's limits, so loops reach a fixed point. */
export function widen(old: Value, next: Value, type: ScalarType): Value {
  const j = join(old, next);
  const lo = j.lo < old.lo ? (type.lo <= j.lo ? type.lo : -Infinity) : j.lo;
  const hi = j.hi > old.hi ? (type.hi >= j.hi ? type.hi : Infinity) : j.hi;
  return withZero({ ...j, lo, hi }, j.zero);
}

export function equal(a: Value, b: Value): boolean {
  return a.lo === b.lo && a.hi === b.hi && a.kind === b.kind && a.zero === b.zero && a.init === b.init && a.base === b.base;
}

/** Intersects the range with [lo, hi]; undefined when nothing is left (the path is impossible). */
export function clamp(v: Value, lo: number, hi: number): Value | undefined {
  const l = Math.max(v.lo, lo);
  const h = Math.min(v.hi, hi);
  if (l > h) {
    return undefined;
  }
  return withZero({ ...v, lo: l, hi: h }, v.zero);
}

/** Converts to a declared type: out-of-range values wrap (unsigned) or are undefined (signed): full range. */
export function convert(v: Value, t: ScalarType): Value {
  if (t.kind === "ptr") {
    if (v.kind === "ptr") {
      return v;
    }
    // An integer turned into a pointer: 0 stays null, anything else is unknown.
    return isExact(v, 0) ? { ...exact(0, "ptr", v.zero), init: v.init } : { ...unknown("ptr"), init: v.init };
  }
  if (t.kind === "float") {
    return { ...v, kind: "float", base: undefined };
  }
  // To an integer type.
  let lo = v.kind === "float" ? Math.trunc(v.lo) : v.lo;
  let hi = v.kind === "float" ? Math.trunc(v.hi) : v.hi;
  if (v.kind === "ptr") {
    lo = v.lo === 0 ? 0 : 1;
    hi = v.hi === 0 ? 0 : Infinity;
  }
  if (lo < t.lo || hi > t.hi) {
    lo = t.lo;
    hi = t.hi;
  }
  return withZero({ lo, hi, kind: "int", init: v.init }, v.zero);
}

export function toText(v: Value): string {
  const n = (x: number) => (x === Infinity ? "+inf" : x === -Infinity ? "-inf" : String(x));
  let s: string;
  if (v.kind === "ptr") {
    s = v.hi === 0 ? "null" : v.lo === 1 ? "not null" : "maybe null";
    if (v.base) {
      s += ` -> ${v.base}`;
    }
  } else {
    s = v.lo === v.hi ? n(v.lo) : `[${n(v.lo)}, ${n(v.hi)}]`;
  }
  if (v.init !== "yes") {
    s += v.init === "no" ? " (not set)" : " (maybe not set)";
  }
  if (v.zero) {
    s += ` (0: ${v.zero})`;
  }
  return s;
}

function stripBase(v: Value): Value {
  if (v.base === undefined && !("base" in v)) {
    return v;
  }
  const rest = { ...v } as { -readonly [K in keyof Value]?: Value[K] };
  delete rest.base;
  return rest as Value;
}

// ---- arithmetic on ranges ---------------------------------------------------------------------

const fix = (x: number) => (Number.isNaN(x) ? 0 : x);

function corners(a: Value, b: Value, f: (x: number, y: number) => number): [number, number] {
  const c = [f(a.lo, b.lo), f(a.lo, b.hi), f(a.hi, b.lo), f(a.hi, b.hi)].map(fix);
  return [Math.min(...c), Math.max(...c)];
}

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>";

/** The range of `a op b` (without type conversion), and whether it can be 0 for a reason we can name. */
export function arith(op: BinaryOp, a: Value, b: Value): Value {
  const kind = a.kind === "float" || b.kind === "float" ? "float" : "int";
  const isInt = kind === "int";
  let lo: number;
  let hi: number;
  let zero: string | undefined;
  switch (op) {
    case "+":
      [lo, hi] = [fix(a.lo + b.lo), fix(a.hi + b.hi)];
      zero = a.zero !== undefined && b.zero !== undefined ? a.zero : undefined;
      break;
    case "-":
      [lo, hi] = [fix(a.lo - b.hi), fix(a.hi - b.lo)];
      zero = a.zero !== undefined && b.zero !== undefined ? a.zero : undefined;
      break;
    case "*":
      [lo, hi] = corners(a, b, (x, y) => (x === 0 || y === 0 ? 0 : x * y));
      zero = a.zero ?? b.zero;
      break;
    case "/": {
      [lo, hi] = divide(a, b, isInt);
      zero = a.zero;
      break;
    }
    case "%": {
      const m = Math.max(Math.abs(b.lo), Math.abs(b.hi));
      const top = isInt ? m - 1 : m;
      if (a.lo >= 0) {
        [lo, hi] = [0, Math.min(a.hi, top)];
      } else if (a.hi <= 0) {
        [lo, hi] = [Math.max(a.lo, -top), 0];
      } else {
        [lo, hi] = [-top, top];
      }
      zero = a.zero;
      break;
    }
    case "&":
      if (a.lo >= 0 && b.lo >= 0) {
        [lo, hi] = [0, Math.min(a.hi, b.hi)];
      } else if (a.lo >= 0) {
        [lo, hi] = [0, a.hi];
      } else if (b.lo >= 0) {
        [lo, hi] = [0, b.hi];
      } else {
        [lo, hi] = [-Infinity, Infinity];
      }
      zero = a.zero ?? b.zero;
      break;
    case "|":
    case "^":
      if (a.lo >= 0 && b.lo >= 0) {
        const m = Math.max(a.hi, b.hi);
        [lo, hi] = [op === "|" ? Math.max(a.lo, b.lo) : 0, m === Infinity ? Infinity : 2 ** Math.ceil(Math.log2(m + 1)) - 1];
      } else {
        [lo, hi] = [-Infinity, Infinity];
      }
      zero = a.zero !== undefined && b.zero !== undefined ? a.zero : undefined;
      break;
    case "<<":
      if (a.lo >= 0 && b.lo >= 0 && b.hi <= 63) {
        [lo, hi] = [a.lo * 2 ** b.lo, a.hi * 2 ** b.hi];
      } else {
        [lo, hi] = a.lo >= 0 ? [0, Infinity] : [-Infinity, Infinity];
      }
      zero = a.zero;
      break;
    case ">>":
      if (a.lo >= 0 && b.lo >= 0 && b.hi <= 63) {
        [lo, hi] = [Math.floor(a.lo / 2 ** b.hi), Math.floor(a.hi / 2 ** b.lo)];
      } else {
        [lo, hi] = a.lo >= 0 ? [0, a.hi] : [-Infinity, Infinity];
      }
      zero = a.zero;
      break;
  }
  return range(lo, hi, kind, zero);
}

function divide(a: Value, b: Value, isInt: boolean): [number, number] {
  const parts: [number, number][] = [];
  // Split the divisor around 0 (division by 0 itself is reported by the check, not modeled here).
  const step = isInt ? 1 : Number.MIN_VALUE;
  if (b.lo < 0) {
    parts.push([b.lo, Math.min(b.hi, -step)]);
  }
  if (b.hi > 0) {
    parts.push([Math.max(b.lo, step), b.hi]);
  }
  if (parts.length === 0) {
    return [-Infinity, Infinity];
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const [l, h] of parts) {
    const part: Value = { lo: l, hi: h, kind: b.kind, init: "yes" };
    const [x, y] = corners(a, part, (p, q) => (isInt ? Math.trunc(p / q) : p / q));
    lo = Math.min(lo, x);
    hi = Math.max(hi, y);
    // Dividing a range that crosses 0 still gives 0 (and small results) in between.
    if (a.lo <= 0 && a.hi >= 0) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
  }
  return [fix(lo), fix(hi)];
}
