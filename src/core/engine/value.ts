// Abstract values: what the engine knows about one scalar at one program point.
//
//   * a range [lo, hi] (integers, floats; pointers use 0 = null, 1 = not null);
//   * a "zero witness": the reason the value can be 0 (a constant 0, an unchecked parameter, a memset, ...).
//     A range that merely *contains* 0 because nothing is known is not enough to report anything:
//     checks report only when they can name where the 0 comes from. This keeps unknown values quiet;
//   * whether each bound is backed by the code: a constant, a parameter's type, a condition like
//     `i <= 16`. A bound that comes from an unknown value, a loop that was widened, or a variable that was
//     never set is "wild" (`wl` / `wh`). Checks for bounds, overflow and shifts only use backed bounds;
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
  /** The lower bound is not backed by the code. */
  readonly wl?: true;
  /** The upper bound is not backed by the code. */
  readonly wh?: true;
}

type Mutable = { -readonly [K in keyof Value]?: Value[K] };

/** Builds a value, leaving out unset optional fields (so values compare and print cleanly). */
function make(lo: number, hi: number, kind: ScalarKind, init: Init, zero?: string, wl?: boolean, wh?: boolean, base?: string): Value {
  const v: Mutable = { lo, hi, kind, init };
  if (zero !== undefined && lo <= 0 && hi >= 0) {
    v.zero = zero;
  }
  if (wl) {
    v.wl = true;
  }
  if (wh) {
    v.wh = true;
  }
  if (base !== undefined) {
    v.base = base;
  }
  return v as Value;
}

/** Exactly k. A 0 carries a witness only when one is given (a literal says "the constant 0"; a computed 0 may not). */
export function exact(k: number, kind: ScalarKind = "int", zero?: string): Value {
  return make(k, k, kind, "yes", zero);
}

export function range(lo: number, hi: number, kind: ScalarKind = "int", zero?: string, wl = false, wh = false): Value {
  if (Number.isNaN(lo) || Number.isNaN(hi)) {
    return unknown(kind);
  }
  return make(lo, hi, kind, "yes", zero, wl, wh);
}

/** Nothing known: the full range, no witness, neither bound backed. */
export function unknown(kind: ScalarKind = "int"): Value {
  return kind === "ptr" ? make(0, 1, kind, "yes", undefined, true, true) : make(-Infinity, Infinity, kind, "yes", undefined, true, true);
}

/** Any value of the type (e.g. a parameter: the caller can pass any of them). Both bounds are backed. */
export function ofType(t: ScalarType, zero?: string): Value {
  return make(t.lo, t.hi, t.kind, "yes", zero);
}

export const containsZero = (v: Value): boolean => v.lo <= 0 && v.hi >= 0;
export const isExact = (v: Value, k: number): boolean => v.lo === k && v.hi === k;

/** Sets the witness, dropping it when 0 is not in the range any more. */
export function withZero(v: Value, zero: string | undefined): Value {
  const z = zero !== undefined && containsZero(v) ? zero : undefined;
  if (z === v.zero) {
    return v;
  }
  return make(v.lo, v.hi, v.kind, v.init, z, v.wl, v.wh, v.base);
}

/** Marks both bounds as not backed (e.g. the value of a variable that was never set). */
export function wild(v: Value): Value {
  return v.wl && v.wh ? v : make(v.lo, v.hi, v.kind, v.init, v.zero, true, true, v.base);
}

/** Least upper bound of two values (paths merge). */
export function join(a: Value, b: Value): Value {
  const init: Init = a.init === b.init ? a.init : "maybe";
  const lo = Math.min(a.lo, b.lo);
  const hi = Math.max(a.hi, b.hi);
  const wl = a.lo < b.lo ? a.wl : b.lo < a.lo ? b.wl : a.wl && b.wl;
  const wh = a.hi > b.hi ? a.wh : b.hi > a.hi ? b.wh : a.wh && b.wh;
  const kind = a.kind === b.kind ? a.kind : a.kind === "float" || b.kind === "float" ? "float" : a.kind;
  return make(lo, hi, kind, init, a.zero ?? b.zero, wl, wh, a.base !== undefined && a.base === b.base ? a.base : undefined);
}

/** Like join, but bounds that keep moving jump to the type's limits (and are no longer backed), so loops end. */
export function widen(old: Value, next: Value, type: ScalarType): Value {
  const j = join(old, next);
  const movedLo = j.lo < old.lo;
  const movedHi = j.hi > old.hi;
  const lo = movedLo ? (type.lo <= j.lo ? type.lo : -Infinity) : j.lo;
  const hi = movedHi ? (type.hi >= j.hi ? type.hi : Infinity) : j.hi;
  return make(lo, hi, j.kind, j.init, j.zero, movedLo || j.wl, movedHi || j.wh, j.base);
}

export function equal(a: Value, b: Value): boolean {
  return a.lo === b.lo && a.hi === b.hi && a.kind === b.kind && a.zero === b.zero && a.init === b.init && a.base === b.base && a.wl === b.wl && a.wh === b.wh;
}

/**
 * Intersects the range with [lo, hi] (a condition); undefined when nothing is left (the path is impossible).
 * A bound that the condition moved is backed exactly when the condition's own bound is (`loWild` / `hiWild`).
 */
export function clamp(v: Value, lo: number, hi: number, loWild = false, hiWild = false): Value | undefined {
  const l = Math.max(v.lo, lo);
  const h = Math.min(v.hi, hi);
  if (l > h) {
    return undefined;
  }
  const wl = l > v.lo ? loWild : v.wl;
  const wh = h < v.hi ? hiWild : v.wh;
  return make(l, h, v.kind, v.init, v.zero, wl, wh, v.base);
}

/** The same value with another range (keeps init, witness, base, and the wildness of unchanged bounds). */
export function reshape(v: Value, lo: number, hi: number): Value {
  return make(lo, hi, v.kind, v.init, v.zero, lo === v.lo ? v.wl : false, hi === v.hi ? v.wh : false, v.base);
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
    return make(v.lo, v.hi, "float", v.init, v.zero, v.wl, v.wh);
  }
  // To an integer type.
  let lo = v.kind === "float" ? Math.trunc(v.lo) : v.lo;
  let hi = v.kind === "float" ? Math.trunc(v.hi) : v.hi;
  let wl = v.wl;
  let wh = v.wh;
  if (v.kind === "ptr") {
    lo = v.lo === 0 ? 0 : 1;
    hi = v.hi === 0 ? 0 : Infinity;
  }
  if (lo < t.lo || hi > t.hi) {
    // Wrap-around (or undefined overflow): any value of the type. Backed only when the overflow itself was.
    const w = (lo < t.lo && v.wl) || (hi > t.hi && v.wh);
    lo = t.lo;
    hi = t.hi;
    wl = w || undefined;
    wh = w || undefined;
  }
  return make(lo, hi, "int", v.init, v.zero, wl, wh);
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

// ---- arithmetic on ranges ---------------------------------------------------------------------

const fix = (x: number) => (Number.isNaN(x) ? 0 : x);

function corners(a: Value, b: Value, f: (x: number, y: number) => number): [number, number] {
  const c = [f(a.lo, b.lo), f(a.lo, b.hi), f(a.hi, b.lo), f(a.hi, b.hi)].map(fix);
  return [Math.min(...c), Math.max(...c)];
}

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>";

/** The range of `a op b` (without type conversion), whether it can be 0 for a reason we can name, and which bounds are backed. */
export function arith(op: BinaryOp, a: Value, b: Value): Value {
  const kind = a.kind === "float" || b.kind === "float" ? "float" : "int";
  const isInt = kind === "int";
  const anyWild = !!(a.wl || a.wh || b.wl || b.wh);
  let lo: number;
  let hi: number;
  let zero: string | undefined;
  let wl: boolean = anyWild;
  let wh: boolean = anyWild;
  switch (op) {
    case "+":
      [lo, hi] = [fix(a.lo + b.lo), fix(a.hi + b.hi)];
      zero = a.zero !== undefined && b.zero !== undefined ? a.zero : undefined;
      wl = !!(a.wl || b.wl);
      wh = !!(a.wh || b.wh);
      break;
    case "-":
      [lo, hi] = [fix(a.lo - b.hi), fix(a.hi - b.lo)];
      zero = a.zero !== undefined && b.zero !== undefined ? a.zero : undefined;
      wl = !!(a.wl || b.wh);
      wh = !!(a.wh || b.wl);
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
      const bWild = !!(b.wl || b.wh);
      if (a.lo >= 0) {
        [lo, hi] = [0, Math.min(a.hi, top)];
        wl = false;
        wh = a.hi < top ? !!a.wh : bWild;
      } else if (a.hi <= 0) {
        [lo, hi] = [Math.max(a.lo, -top), 0];
        wl = a.lo > -top ? !!a.wl : bWild;
        wh = false;
      } else {
        [lo, hi] = [-top, top];
        wl = !!a.wl || bWild;
        wh = a.hi < top ? !!a.wh || bWild : bWild;
      }
      zero = a.zero;
      break;
    }
    case "&":
      // Masking with a known non-negative value bounds the result by that value.
      if (a.lo >= 0 && b.lo >= 0) {
        [lo, hi] = [0, Math.min(a.hi, b.hi)];
        wh = a.hi <= b.hi ? !!a.wh : !!b.wh;
        wl = false;
      } else if (a.lo >= 0) {
        [lo, hi] = [0, a.hi];
        wl = false;
        wh = !!a.wh;
      } else if (b.lo >= 0) {
        [lo, hi] = [0, b.hi];
        wl = false;
        wh = !!b.wh;
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
        wl = wh = true;
      }
      zero = a.zero;
      break;
    case ">>":
      if (a.lo >= 0 && b.lo >= 0 && b.hi <= 63) {
        [lo, hi] = [Math.floor(a.lo / 2 ** b.hi), Math.floor(a.hi / 2 ** b.lo)];
      } else {
        [lo, hi] = a.lo >= 0 ? [0, a.hi] : [-Infinity, Infinity];
        wl = wh = a.lo >= 0 ? !!(a.wh || b.wl || b.wh) : true;
        if (a.lo >= 0) {
          wl = false;
        }
      }
      zero = a.zero;
      break;
  }
  return range(lo, hi, kind, zero, wl, wh);
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
