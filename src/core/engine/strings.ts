// String and format checks for library calls (strcpy, strncpy, strcat, sprintf, printf, memcpy, ...).
// The interpreter calls `stringChecks` for each such call with what it knows: array lengths, values of
// size arguments, and C types. Same policy as the other checks: a finding needs evidence (a known
// destination size, a backed bound, a known argument type); unknown sizes and types stay quiet, except
// where the call itself has no limit (strcpy / sprintf of a string of unknown length into a fixed buffer).

import { Node } from "web-tree-sitter";
import { CType } from "./declarations";
import { ScalarType } from "./types";
import { arith, Value } from "./value";

export type StringIssueKind = "string-overflow" | "missing-terminator" | "overlapping-copy" | "format-mismatch" | "uncontrolled-format";

export interface StringIssue {
  readonly at: Node;
  readonly kind: StringIssueKind;
  readonly message: string;
  readonly definite: boolean;
}

/** What the checks may ask the interpreter. */
export interface StringContext {
  typeOf(n: Node): CType | undefined;
  scalarOf(n: Node): ScalarType | undefined;
  resolve(t: CType | undefined): CType | undefined;
  arrayLength(t: CType | undefined): number | undefined;
  bytes(t: CType | undefined): number | undefined;
  /** Value of an expression (no side effects). */
  value(n: Node): Value;
  macroBody(name: string): string | undefined;
  /** The enclosing function takes `...` (a printf-style wrapper passes its format on). */
  readonly variadic: boolean;
}

export const STRING_FUNCTIONS = /^(strcpy|strncpy|strcat|sprintf|snprintf|vsprintf|vsnprintf|printf|fprintf|dprintf|memcpy|__builtin_memcpy)$/;

/** Index of the format argument of printf-style functions. */
const FORMAT_INDEX: Record<string, number> = { printf: 0, fprintf: 1, dprintf: 1, sprintf: 1, snprintf: 2, vsprintf: 1, vsnprintf: 2 };

export function stringChecks(ctx: StringContext, call: Node, name: string, args: readonly Node[]): StringIssue[] {
  const out: StringIssue[] = [];
  const add = (at: Node, kind: StringIssueKind, message: string, definite: boolean) => out.push({ at, kind, message, definite });
  if (name === "strcpy" || name === "strcat") {
    copyString(ctx, call, name, args, add);
  } else if (name === "strncpy") {
    boundedCopy(ctx, call, args, add);
  }
  if (name in FORMAT_INDEX) {
    formatCall(ctx, call, name, args, add);
  }
  overlap(ctx, call, name, args, add);
  return out;
}

type Add = (at: Node, kind: StringIssueKind, message: string, definite: boolean) => void;

// ---- sizes --------------------------------------------------------------------------------------------

function strip(n: Node): Node {
  let m = n;
  for (;;) {
    if (m.type === "parenthesized_expression") {
      const inner = m.namedChildren.find((c) => c !== null && c.type !== "comment");
      if (!inner) {
        return m;
      }
      m = inner;
    } else if (m.type === "cast_expression") {
      const v = m.childForFieldName("value");
      if (!v) {
        return m;
      }
      m = v;
    } else {
      return m;
    }
  }
}

const show = (n: Node) => n.text.replace(/\s+/g, " ");

/** Bytes in a char array the expression names (`buf`, `s.name`, `rows[i]`), or undefined. */
function charArrayLength(ctx: StringContext, n: Node): number | undefined {
  const m = strip(n);
  if (!["identifier", "field_expression", "subscript_expression"].includes(m.type)) {
    return undefined;
  }
  const t = ctx.resolve(ctx.typeOf(m));
  if (t?.k !== "array" || ctx.bytes(t.of) !== 1) {
    return undefined;
  }
  return ctx.arrayLength(t);
}

/** Characters of a string literal (escapes count once), or undefined. */
function literalLength(n: Node): number | undefined {
  const m = strip(n);
  if (m.type === "concatenated_string") {
    let total = 0;
    for (const c of m.namedChildren) {
      const k = c && c.type === "string_literal" ? literalLength(c) : 0;
      if (k === undefined) {
        return undefined;
      }
      total += k;
    }
    return total;
  }
  if (m.type !== "string_literal") {
    return undefined;
  }
  const body = /^[LuU8]*"(.*)"$/s.exec(m.text)?.[1];
  return body === undefined ? undefined : body.replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/g, "X").length;
}

/** The longest string a source can hold: a literal's length, a char array's length - 1, else undefined. */
function maxStringLength(ctx: StringContext, n: Node): number | undefined {
  const lit = literalLength(n);
  if (lit !== undefined) {
    return lit;
  }
  const len = charArrayLength(ctx, n);
  return len === undefined ? undefined : len - 1;
}

// ---- strcpy / strcat / strncpy ------------------------------------------------------------------------

function copyString(ctx: StringContext, call: Node, name: string, args: readonly Node[], add: Add): void {
  if (args.length < 2) {
    return;
  }
  const size = charArrayLength(ctx, args[0]);
  if (size === undefined) {
    return;
  }
  const lit = literalLength(args[1]);
  const max = maxStringLength(ctx, args[1]);
  const dst = show(args[0]);
  if (name === "strcpy") {
    if (lit !== undefined) {
      if (lit + 1 > size) {
        add(call, "string-overflow", `Buffer overflow: strcpy() writes ${lit + 1} bytes (with the terminating 0) into '${dst}', which has ${size}.`, true);
      }
      return;
    }
    if (max !== undefined && max + 1 <= size) {
      return;
    }
    const why = max === undefined ? `the length of '${show(args[1])}' is not checked` : `'${show(args[1])}' can hold ${max} characters`;
    add(call, "string-overflow", `Possible buffer overflow: strcpy() into '${dst}' (${size} bytes), but ${why}. Use a bounded copy and terminate the string.`, false);
    return;
  }
  // strcat: the destination already holds a string of unknown length.
  add(call, "string-overflow", `Possible buffer overflow: strcat() appends to '${dst}' (${size} bytes) without a size limit. Check the remaining space, or use snprintf().`, false);
}

function boundedCopy(ctx: StringContext, call: Node, args: readonly Node[], add: Add): void {
  if (args.length < 3) {
    return;
  }
  const size = charArrayLength(ctx, args[0]);
  if (size === undefined) {
    return;
  }
  const n = ctx.value(args[2]);
  const dst = show(args[0]);
  if (n.kind !== "int") {
    return;
  }
  if (n.hi > size && !n.wh) {
    const definite = n.lo > size && !n.wl;
    add(call, "string-overflow", `${definite ? "Buffer overflow" : "Possible buffer overflow"}: strncpy() can write ${n.hi} bytes into '${dst}', which has ${size}.`, definite);
    return;
  }
  if (n.hi >= size && !n.wh && !terminatedNext(call, args[0])) {
    add(
      call,
      "missing-terminator",
      `Missing string terminator: strncpy() copies up to ${size} bytes into '${dst}' (${size} bytes), so a long source leaves no terminating 0. Copy at most ${size - 1} bytes and set the last byte to 0.`,
      n.lo >= size && !n.wl
    );
  }
}

/** The statement after the call sets `dst[k] = '\0'` (or 0). */
function terminatedNext(call: Node, dst: Node): boolean {
  let stmt: Node | null = call;
  while (stmt && stmt.type !== "expression_statement") {
    stmt = stmt.parent;
  }
  let next = stmt?.nextNamedSibling ?? null;
  while (next?.type === "comment") {
    next = next.nextNamedSibling;
  }
  const e = next?.type === "expression_statement" ? next.namedChildren.find((c) => c !== null && c.type !== "comment") : undefined;
  if (e?.type !== "assignment_expression") {
    return false;
  }
  const left = e.childForFieldName("left");
  const right = e.childForFieldName("right");
  const base = left?.type === "subscript_expression" ? left.childForFieldName("argument") : null;
  return !!base && base.text.replace(/\s+/g, "") === strip(dst).text.replace(/\s+/g, "") && !!right && /^('\\0'|0[uUlL]*|'\\x0+')$/.test(right.text.trim());
}

// ---- printf family -------------------------------------------------------------------------------------

interface Conversion {
  readonly text: string;
  readonly width?: string;
  readonly precision?: string;
  readonly length?: string;
  readonly conv: string;
}

const CONVERSION = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|L|z|j|t)?([diouxXfFeEgGaAcspn%])/g;

function conversions(format: string): Conversion[] {
  const out: Conversion[] = [];
  for (const m of format.matchAll(CONVERSION)) {
    if (m[5] !== "%") {
      out.push({ text: m[0], width: m[2], precision: m[3], length: m[4], conv: m[5] });
    }
  }
  return out;
}

/** The format string's text when the format is a literal (or a macro for one). */
function formatText(ctx: StringContext, n: Node): string | undefined {
  const m = strip(n);
  if (m.type === "string_literal" || m.type === "concatenated_string") {
    const parts = m.type === "string_literal" ? [m] : m.namedChildren.filter((c): c is Node => c !== null && c.type === "string_literal");
    return parts.map((p) => /^[LuU8]*"(.*)"$/s.exec(p.text)?.[1] ?? "").join("");
  }
  if (m.type === "identifier") {
    const body = ctx.macroBody(m.text)?.trim();
    const lit = body ? /^"(.*)"$/s.exec(body)?.[1] : undefined;
    return lit;
  }
  return undefined;
}

function isLiteralLike(ctx: StringContext, n: Node): boolean {
  const m = strip(n);
  if (formatText(ctx, m) !== undefined) {
    return true;
  }
  if (m.type === "conditional_expression") {
    const a = m.childForFieldName("consequence");
    const b = m.childForFieldName("alternative");
    return !!a && !!b && isLiteralLike(ctx, a) && isLiteralLike(ctx, b);
  }
  return false;
}

function formatCall(ctx: StringContext, call: Node, name: string, args: readonly Node[], add: Add): void {
  const fi = FORMAT_INDEX[name];
  const fmtNode = args[fi];
  if (!fmtNode) {
    return;
  }
  const fmt = formatText(ctx, fmtNode);
  if (fmt === undefined) {
    if (!isLiteralLike(ctx, fmtNode) && !ctx.variadic && args.length === fi + 1 && !name.startsWith("v")) {
      add(
        fmtNode,
        "uncontrolled-format",
        `Uncontrolled format string: '${show(fmtNode)}' is used as the format of ${name}(); a '%' in it reads arguments that were never passed. Use "%s" as the format and pass the text as an argument.`,
        false
      );
    }
    return;
  }
  if (name.startsWith("v")) {
    return; // the arguments come in a va_list
  }
  const convs = conversions(fmt);
  let next = fi + 1;
  for (const c of convs) {
    for (const star of [c.width, c.precision]) {
      if (star === "*") {
        next++; // the width / precision argument
      }
    }
    if (c.conv === "n") {
      next++;
      continue;
    }
    const arg = args[next++];
    if (!arg) {
      add(call, "format-mismatch", `Missing argument: the format of ${name}() has '${c.text}', but no argument is passed for it.`, true);
      return;
    }
    const t = ctx.scalarOf(arg);
    if (!t) {
      continue;
    }
    // %p is not judged: printing an integer as an address is common and harmless on most targets.
    const wanted = "diouxXc".includes(c.conv) ? "int" : "fFeEgGaA".includes(c.conv) ? "float" : c.conv === "s" ? "ptr" : undefined;
    if (!wanted || wanted === t.kind) {
      continue;
    }
    const got = t.kind === "float" ? `a floating-point value (passed as double)` : t.kind === "ptr" ? "a pointer" : `an integer (${t.name})`;
    const need = wanted === "int" ? "an integer" : wanted === "float" ? "a double" : "a pointer to a string";
    add(arg, "format-mismatch", `Format mismatch: '${c.text}' expects ${need}, but '${show(arg)}' is ${got}; the output is garbage (undefined behavior).`, true);
  }
  if (name === "sprintf") {
    sprintfSize(ctx, call, args, fmt, convs, add);
  }
}

/** Longest output of one conversion, or undefined when it has no limit (%s of unknown length, %f). */
function maxWidth(ctx: StringContext, c: Conversion, arg: Node | undefined): number | undefined {
  const width = c.width && c.width !== "*" ? Number(c.width) : 0;
  const long = c.length === "l" || c.length === "ll" || c.length === "j" || c.length === "z";
  let w: number | undefined;
  switch (c.conv) {
    case "d":
    case "i":
      w = long ? 20 : 11;
      break;
    case "u":
      w = long ? 20 : 10;
      break;
    case "x":
    case "X":
      w = long ? 16 : 8;
      break;
    case "o":
      w = long ? 22 : 11;
      break;
    case "c":
      w = 1;
      break;
    case "p":
      w = 18;
      break;
    case "s": {
      const p = c.precision !== undefined && c.precision !== "*" ? Number(c.precision || "0") : undefined;
      const src = arg ? maxStringLength(ctx, arg) : undefined;
      w = p !== undefined ? (src !== undefined ? Math.min(p, src) : p) : src;
      break;
    }
    default:
      w = undefined; // floating point: no practical limit
  }
  return w === undefined ? undefined : Math.max(w, width);
}

function sprintfSize(ctx: StringContext, call: Node, args: readonly Node[], fmt: string, convs: readonly Conversion[], add: Add): void {
  const size = charArrayLength(ctx, args[0]);
  const literal = fmt.replace(CONVERSION, (m) => (m === "%%" ? "%" : "")).replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/g, "X").length;
  let max: number | undefined = literal;
  let next = 2;
  let unbounded: string | undefined;
  for (const c of convs) {
    next += (c.width === "*" ? 1 : 0) + (c.precision === "*" ? 1 : 0);
    const arg = c.conv === "n" ? undefined : args[next];
    next++;
    if (c.conv === "n") {
      continue;
    }
    const w = maxWidth(ctx, c, arg);
    if (w === undefined) {
      unbounded ??= c.conv === "s" && arg ? `the length of '${show(arg)}'` : `'${c.text}'`;
      max = undefined;
    } else if (max !== undefined) {
      max += w;
    }
  }
  const dst = show(args[0]);
  if (size !== undefined && literal + 1 > size) {
    add(call, "string-overflow", `Buffer overflow: sprintf() writes at least ${literal + 1} bytes into '${dst}', which has ${size}.`, true);
  } else if (unbounded) {
    add(call, "string-overflow", `Possible buffer overflow: sprintf() into '${dst}' has no size limit, and ${unbounded} is not bounded. Use snprintf() with the buffer size.`, false);
  } else if (size !== undefined && max !== undefined && max + 1 > size) {
    add(call, "string-overflow", `Possible buffer overflow: sprintf() can write ${max + 1} bytes into '${dst}', which has ${size}. Use snprintf() with the buffer size.`, false);
  }
}

// ---- overlapping copies --------------------------------------------------------------------------------

interface Place {
  readonly root: string;
  readonly offset: Value;
}

/** Where in an array object an argument points: `a` (0), `a[i]` (row i), `&a[i]`, `a + i`, in bytes. */
function placeOf(ctx: StringContext, n: Node): Place | undefined {
  const m = strip(n);
  if (m.type === "identifier") {
    const t = ctx.resolve(ctx.typeOf(m));
    return t?.k === "array" ? { root: m.text, offset: { lo: 0, hi: 0, kind: "int", init: "yes" } } : undefined;
  }
  if (m.type === "subscript_expression") {
    // a row of a 2-D array: a[i] is itself an array
    const a = m.childForFieldName("argument");
    const i = m.childForFieldName("index");
    const row = ctx.resolve(ctx.typeOf(m));
    const base = a ? placeOf(ctx, a) : undefined;
    const bytes = row?.k === "array" ? ctx.bytes(row) : undefined;
    if (!base || !i || bytes === undefined) {
      return undefined;
    }
    return { root: base.root, offset: arith("+", base.offset, arith("*", ctx.value(i), { lo: bytes, hi: bytes, kind: "int", init: "yes" })) };
  }
  if (m.type === "pointer_expression" && m.childForFieldName("operator")?.type === "&") {
    const sub = m.childForFieldName("argument");
    if (sub?.type !== "subscript_expression") {
      return undefined;
    }
    const a = sub.childForFieldName("argument");
    const i = sub.childForFieldName("index");
    const base = a ? placeOf(ctx, a) : undefined;
    const el = ctx.bytes(ctx.typeOf(sub));
    if (!base || !i || el === undefined) {
      return undefined;
    }
    return { root: base.root, offset: arith("+", base.offset, arith("*", ctx.value(i), { lo: el, hi: el, kind: "int", init: "yes" })) };
  }
  return undefined;
}

function overlap(ctx: StringContext, call: Node, name: string, args: readonly Node[], add: Add): void {
  if (name === "memcpy" || name === "__builtin_memcpy") {
    if (args.length < 3) {
      return;
    }
    const d = placeOf(ctx, args[0]);
    const s = placeOf(ctx, args[1]);
    if (!d || !s || d.root !== s.root) {
      return;
    }
    const len = ctx.value(args[2]);
    const diff = arith("-", d.offset, s.offset);
    if (len.kind !== "int" || len.wl || len.wh || diff.wl || diff.wh || !Number.isFinite(diff.lo) || !Number.isFinite(diff.hi)) {
      return;
    }
    const maxAbs = Math.max(Math.abs(diff.lo), Math.abs(diff.hi));
    const minAbs = diff.lo <= 0 && diff.hi >= 0 ? 0 : Math.min(Math.abs(diff.lo), Math.abs(diff.hi));
    if (minAbs < len.hi && len.hi > 0) {
      const definite = maxAbs < len.lo;
      add(call, "overlapping-copy", `${definite ? "Overlapping copy" : "Possibly overlapping copy"}: memcpy() copies ${len.lo === len.hi ? len.lo : `up to ${len.hi}`} bytes between parts of '${d.root}' that are ${minAbs === maxAbs ? minAbs : `${minAbs} to ${maxAbs}`} bytes apart; memcpy() is undefined when they overlap. Use memmove().`, definite);
    }
    return;
  }
  // strcpy(a, a), sprintf(buf, "%s", buf): the destination is also a source.
  const sources = name === "sprintf" || name === "snprintf" ? args.slice(FORMAT_INDEX[name] + 1) : name === "strcpy" || name === "strcat" || name === "strncpy" ? args.slice(1, 2) : [];
  const d = args[0];
  if (!d || sources.length === 0) {
    return;
  }
  const rootOf = (n: Node): string | undefined => placeOf(ctx, n)?.root ?? (strip(n).type === "identifier" ? strip(n).text : undefined);
  const dp = rootOf(d);
  for (const s of sources) {
    if (dp !== undefined && rootOf(s) === dp) {
      add(call, "overlapping-copy", `Overlapping copy: ${name}() reads '${show(s)}' while it writes '${show(d)}', the same memory; the result is undefined.`, true);
      return;
    }
  }
}
