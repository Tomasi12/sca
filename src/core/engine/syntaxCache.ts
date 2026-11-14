// Memo for tree-sitter node lookups. Every `childForFieldName`, `namedChildren` and `text` call crosses into
// WebAssembly and allocates new wrapper objects; the interpreter asks the same questions many times while a
// loop converges. Node ids are only unique within one living tree, so a cache belongs to one FileEngine and
// is active only while that engine runs (see `withCache`).

import { Node } from "web-tree-sitter";

export class SyntaxCache {
  readonly fields = new Map<number, Map<string, Node | null>>();
  readonly children = new Map<number, Node[]>();
  readonly texts = new Map<number, string>();
}

let current: SyntaxCache | undefined;

/** Runs `fn` with `cache` active (nested calls with the same cache are fine). */
export function withCache<T>(cache: SyntaxCache, fn: () => T): T {
  const prev = current;
  current = cache;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

export function field(n: Node, name: string): Node | null {
  if (!current) {
    return n.childForFieldName(name);
  }
  let byName = current.fields.get(n.id);
  if (!byName) {
    byName = new Map();
    current.fields.set(n.id, byName);
  }
  let v = byName.get(name);
  if (v === undefined) {
    v = n.childForFieldName(name);
    byName.set(name, v);
  }
  return v;
}

export function fieldOpt(n: Node | null | undefined, name: string): Node | null {
  return n ? field(n, name) : null;
}

/** Named children (comments included, nulls removed). */
export function named(n: Node): Node[] {
  let v = current?.children.get(n.id);
  if (!v) {
    v = n.namedChildren.filter((c): c is Node => c !== null);
    current?.children.set(n.id, v);
  }
  return v;
}

export function text(n: Node): string {
  if (!current) {
    return n.text;
  }
  let v = current.texts.get(n.id);
  if (v === undefined) {
    v = n.text;
    current.texts.set(n.id, v);
  }
  return v;
}
