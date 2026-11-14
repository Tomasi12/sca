// Evaluates `#if` / `#elif` expressions. Pure logic.
//
// The result is tri-state: a number (0 = false), or `undefined` when it depends on something we do not know
// (a macro that may or may not be defined, a function-like macro, ...). Callers keep both branches in that case.

export interface MacroLookup {
  /** "defined" | "undefined" | "unknown" for `defined(NAME)`. */
  isDefined(name: string): boolean | undefined;
  /** The integer value of an object-like macro, or undefined when unknown / not an integer. */
  valueOf(name: string, depth: number): number | undefined;
  /** True when a name that is not defined counts as 0 (complete defines, e.g. from a compile database). */
  readonly undefinedIsZero: boolean;
}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

const OPS = ["<<=", ">>=", "&&", "||", "==", "!=", "<=", ">=", "<<", ">>", "+", "-", "*", "/", "%", "<", ">", "!", "~", "&", "|", "^", "?", ":", "(", ")", ","];

/** Parses an integer literal with C suffixes (`10U`, `0x1F`, `017`, `0b101`). */
export function parseIntLiteral(text: string): number | undefined {
  const s = text.replace(/'/g, "").replace(/[uUlL]+$/, "");
  let v: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
    v = parseInt(s.slice(2), 16);
  } else if (/^0[bB][01]+$/.test(s)) {
    v = parseInt(s.slice(2), 2);
  } else if (/^0[0-7]*$/.test(s)) {
    v = parseInt(s, 8);
  } else if (/^[1-9][0-9]*$/.test(s)) {
    v = parseInt(s, 10);
  } else {
    return undefined;
  }
  return Number.isNaN(v) ? undefined : v;
}

function charValue(lit: string): number | undefined {
  const m = /^'(\\?.)'$/.exec(lit);
  if (!m) {
    return undefined;
  }
  const c = m[1];
  if (c.length === 1) {
    return c.charCodeAt(0);
  }
  return { n: 10, t: 9, r: 13, "0": 0, "\\": 92, "'": 39 }[c[1]] ?? c.charCodeAt(1);
}

export function tokenize(expr: string): Tok[] | undefined {
  const toks: Tok[] = [];
  let i = 0;
  const s = expr.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/, "");
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9a-zA-Z_']*/.exec(s.slice(i))!;
      const v = parseIntLiteral(m[0]);
      if (v === undefined) {
        return undefined;
      }
      toks.push({ t: "num", v });
      i += m[0].length;
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^'\\])'/.exec(s.slice(i));
      const v = m ? charValue(m[0]) : undefined;
      if (!m || v === undefined) {
        return undefined;
      }
      toks.push({ t: "num", v });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))!;
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) {
      return undefined;
    }
    toks.push({ t: "op", v: op });
    i += op.length;
  }
  return toks;
}

const MAX_DEPTH = 32;

/** Evaluates a `#if` expression. Returns a number, or undefined when the result is not known. */
export function evaluateCondition(expr: string, macros: MacroLookup, depth = 0): number | undefined {
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  const toks = tokenize(expr);
  if (!toks || toks.length === 0) {
    return undefined;
  }
  const p = new Parser(toks, macros, depth);
  try {
    const v = p.ternary();
    return p.atEnd() ? v : undefined;
  } catch {
    return undefined;
  }
}

type V = number | undefined;
const known = (...vs: V[]): boolean => vs.every((v) => v !== undefined);
const bool = (b: boolean) => (b ? 1 : 0);

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly macros: MacroLookup,
    private readonly depth: number
  ) {}

  atEnd(): boolean {
    return this.i >= this.toks.length;
  }

  private peekOp(...ops: string[]): string | undefined {
    const t = this.toks[this.i];
    return t?.t === "op" && ops.includes(t.v) ? t.v : undefined;
  }

  private expect(op: string): void {
    if (this.peekOp(op) !== op) {
      throw new Error(`expected ${op}`);
    }
    this.i++;
  }

  ternary(): V {
    const c = this.binary(0);
    if (!this.peekOp("?")) {
      return c;
    }
    this.i++;
    const a = this.ternary();
    this.expect(":");
    const b = this.ternary();
    if (c === undefined) {
      return a !== undefined && a === b ? a : undefined;
    }
    return c !== 0 ? a : b;
  }

  private static readonly LEVELS: string[][] = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<", ">", "<=", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  private binary(level: number): V {
    if (level >= Parser.LEVELS.length) {
      return this.unary();
    }
    let left = this.binary(level + 1);
    for (let op = this.peekOp(...Parser.LEVELS[level]); op; op = this.peekOp(...Parser.LEVELS[level])) {
      this.i++;
      const right = this.binary(level + 1);
      left = apply(op, left, right);
    }
    return left;
  }

  private unary(): V {
    const op = this.peekOp("!", "~", "-", "+");
    if (op) {
      this.i++;
      const v = this.unary();
      if (v === undefined) {
        return undefined;
      }
      return op === "!" ? bool(v === 0) : op === "~" ? ~v : op === "-" ? -v : v;
    }
    return this.primary();
  }

  private primary(): V {
    const t = this.toks[this.i++];
    if (!t) {
      throw new Error("unexpected end");
    }
    if (t.t === "num") {
      return t.v;
    }
    if (t.t === "op") {
      if (t.v !== "(") {
        throw new Error(`unexpected ${t.v}`);
      }
      const v = this.ternary();
      this.expect(")");
      return v;
    }
    if (t.v === "defined") {
      const paren = this.peekOp("(") !== undefined;
      if (paren) {
        this.i++;
      }
      const name = this.toks[this.i++];
      if (!name || name.t !== "id") {
        throw new Error("defined needs a name");
      }
      if (paren) {
        this.expect(")");
      }
      const d = this.macros.isDefined(name.v);
      return d === undefined ? undefined : bool(d);
    }
    if (t.v === "true") {
      return 1;
    }
    if (t.v === "false") {
      return 0;
    }
    // A function-like macro call: we do not expand those.
    if (this.peekOp("(")) {
      this.skipParens();
      return undefined;
    }
    const d = this.macros.isDefined(t.v);
    if (d === false) {
      return this.macros.undefinedIsZero ? 0 : undefined;
    }
    if (d === undefined) {
      return undefined;
    }
    return this.macros.valueOf(t.v, this.depth + 1);
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const t = this.toks[this.i++];
      if (!t) {
        throw new Error("unbalanced");
      }
      if (t.t === "op" && t.v === "(") {
        depth++;
      } else if (t.t === "op" && t.v === ")") {
        depth--;
      }
    } while (depth > 0);
  }
}

function apply(op: string, a: V, b: V): V {
  // Short-circuit rules work even when one side is unknown.
  if (op === "&&") {
    if (a === 0 || b === 0) {
      return 0;
    }
    return known(a, b) ? 1 : undefined;
  }
  if (op === "||") {
    if ((a !== undefined && a !== 0) || (b !== undefined && b !== 0)) {
      return 1;
    }
    return known(a, b) ? 0 : undefined;
  }
  if (!known(a, b)) {
    return undefined;
  }
  const x = a as number;
  const y = b as number;
  switch (op) {
    case "|":
      return x | y;
    case "^":
      return x ^ y;
    case "&":
      return x & y;
    case "==":
      return bool(x === y);
    case "!=":
      return bool(x !== y);
    case "<":
      return bool(x < y);
    case ">":
      return bool(x > y);
    case "<=":
      return bool(x <= y);
    case ">=":
      return bool(x >= y);
    case "<<":
      return x * 2 ** y;
    case ">>":
      return Math.floor(x / 2 ** y);
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? undefined : Math.trunc(x / y);
    case "%":
      return y === 0 ? undefined : x % y;
    default:
      return undefined;
  }
}
