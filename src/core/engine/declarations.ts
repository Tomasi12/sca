// Declarations SCA learns from headers and from the file itself: typedefs, struct fields (with array sizes),
// enum constants, global variables and function return types.
//
// Extraction turns a syntax tree into plain data (no tree-sitter nodes), so the result for a header can be
// cached and reused for every file that includes it. Array sizes stay as text (`[RB_SIZE]`) and are
// evaluated later with the macros of the file being analyzed.

import { Node } from "web-tree-sitter";
import { evaluateCondition, MacroLookup } from "../preprocess/condition";
import { BUILTIN_TYPES, INT, POINTER, ScalarType, TypedefSource, UNKNOWN_INT } from "./types";

export type CType =
  | { readonly k: "builtin"; readonly name: string }
  | { readonly k: "named"; readonly name: string }
  | { readonly k: "struct"; readonly tag: string }
  | { readonly k: "enum"; readonly values?: readonly number[] }
  | { readonly k: "ptr"; readonly to: CType }
  | { readonly k: "array"; readonly of: CType; readonly size?: string }
  | { readonly k: "func"; readonly ret: CType }
  | { readonly k: "unknown" };

export interface DeclData {
  readonly typedefs: Map<string, CType>;
  readonly structs: Map<string, Map<string, CType>>;
  readonly enums: Map<string, number>;
  readonly vars: Map<string, CType>;
  readonly funcs: Map<string, CType>;
  /** Volatile objects: `tag.field` for struct fields, the plain name for variables (hardware registers). */
  readonly volatiles?: Set<string>;
}

export function emptyDecls(): DeclData {
  return { typedefs: new Map(), structs: new Map(), enums: new Map(), vars: new Map(), funcs: new Map(), volatiles: new Set() };
}

function isVolatileDecl(decl: Node): boolean {
  return decl.namedChildren.some((c) => c?.type === "type_qualifier" && c.text === "volatile");
}

const CONTAINERS = new Set(["translation_unit", "preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "preproc_elifdef", "linkage_specification", "declaration_list"]);

/** Top-level declarations of a tree (also inside #if blocks and extern "C" { }), as plain data. */
export function extractDeclarations(root: Node): DeclData {
  const out = emptyDecls();
  const visit = (n: Node) => {
    for (const c of n.namedChildren) {
      if (!c) {
        continue;
      }
      if (CONTAINERS.has(c.type)) {
        visit(c);
        continue;
      }
      if (c.type === "type_definition") {
        const base = specifierType(c.childForFieldName("type"), out, c);
        for (const d of c.childrenForFieldName("declarator")) {
          if (d) {
            const { name, type } = applyDeclarator(d, base);
            if (name) {
              out.typedefs.set(name, type);
            }
          }
        }
      } else if (c.type === "declaration") {
        const base = specifierType(c.childForFieldName("type"), out, c);
        for (const d of c.childrenForFieldName("declarator")) {
          if (!d) {
            continue;
          }
          const { name, type } = applyDeclarator(d.type === "init_declarator" ? d.childForFieldName("declarator") ?? d : d, base, d.type === "init_declarator" ? d.childForFieldName("value") : null);
          if (!name) {
            continue;
          }
          if (type.k === "func") {
            out.funcs.set(name, type.ret);
          } else {
            out.vars.set(name, type);
            if (isVolatileDecl(c)) {
              out.volatiles?.add(name);
            }
          }
        }
      } else if (c.type === "function_definition") {
        const base = specifierType(c.childForFieldName("type"), out, c);
        const d = c.childForFieldName("declarator");
        if (d) {
          const { name, type } = applyDeclarator(d, base);
          if (name && type.k === "func") {
            out.funcs.set(name, type.ret);
          }
        }
      } else if (c.type === "struct_specifier" || c.type === "union_specifier" || c.type === "enum_specifier") {
        specifierType(c, out, c); // `struct S { ... };` on its own
      } else if (c.type === "expression_statement") {
        const inner = c.namedChildren.find((x) => x !== null && /specifier$/.test(x.type));
        if (inner) {
          specifierType(inner, out, c);
        }
      }
    }
  };
  visit(root);
  return out;
}

/** The type a specifier names; registers struct fields and enum constants it defines on the way. */
export function specifierType(spec: Node | null, out: DeclData | undefined, owner: Node): CType {
  if (!spec) {
    return { k: "unknown" };
  }
  switch (spec.type) {
    case "primitive_type":
    case "sized_type_specifier":
      return { k: "builtin", name: spec.text.replace(/\s+/g, " ").trim() };
    case "type_identifier":
      return { k: "named", name: spec.text };
    case "struct_specifier":
    case "union_specifier":
    case "class_specifier": {
      const tagNode = spec.childForFieldName("name");
      const body = spec.childForFieldName("body");
      const tag = tagNode?.text ?? `<anon@${owner.startIndex}>`;
      if (body && out) {
        const fields = new Map<string, CType>();
        for (const fd of body.namedChildren) {
          if (fd?.type !== "field_declaration") {
            continue;
          }
          const base = specifierType(fd.childForFieldName("type"), out, fd);
          for (const d of fd.childrenForFieldName("declarator")) {
            if (d) {
              const { name, type } = applyDeclarator(d, base);
              if (name) {
                fields.set(name, type);
                if (isVolatileDecl(fd)) {
                  out.volatiles?.add(`${tag}.${name}`);
                }
              }
            }
          }
        }
        out.structs.set(tag, fields);
      }
      return { k: "struct", tag };
    }
    case "enum_specifier": {
      const body = spec.childForFieldName("body");
      // The values of the enum's constants, when every one of them is known.
      let values: number[] | undefined = body ? [] : undefined;
      if (body && out) {
        let next: number | undefined = 0;
        for (const e of body.namedChildren) {
          if (e?.type !== "enumerator") {
            continue;
          }
          const name = e.childForFieldName("name")?.text;
          const value = e.childForFieldName("value");
          let v: number | undefined = next;
          if (value) {
            v = literalValue(value.text) ?? (/^[A-Za-z_]\w*$/.test(value.text) ? out.enums.get(value.text) : undefined);
          }
          if (name && v !== undefined) {
            out.enums.set(name, v);
          }
          if (v === undefined) {
            values = undefined;
          } else {
            values?.push(v);
          }
          next = v === undefined ? undefined : v + 1;
        }
      }
      return values && values.length > 0 ? { k: "enum", values } : { k: "enum" };
    }
    default:
      return { k: "unknown" };
  }
}

/** Applies a declarator (`*p`, `a[8]`, `f(void)`) to a base type: returns the declared name and type. */
export function applyDeclarator(d: Node, base: CType, init?: Node | null): { name?: string; type: CType } {
  let type = base;
  let n: Node | null = d;
  while (n) {
    switch (n.type) {
      case "identifier":
      case "field_identifier":
      case "type_identifier":
        return { name: n.text, type };
      case "pointer_declarator":
      case "abstract_pointer_declarator":
        type = { k: "ptr", to: type };
        break;
      case "array_declarator":
      case "abstract_array_declarator": {
        const size = n.childForFieldName("size");
        const count = !size && init?.type === "initializer_list" ? String(init.namedChildren.filter((c) => c !== null && c.type !== "comment").length) : undefined;
        type = { k: "array", of: type, size: size?.text ?? count };
        break;
      }
      case "function_declarator":
      case "abstract_function_declarator":
        type = { k: "func", ret: type };
        break;
      case "parenthesized_declarator":
        n = n.namedChildren.find((c) => c !== null) ?? null;
        continue;
      case "init_declarator":
        return applyDeclarator(n.childForFieldName("declarator") ?? n, base, n.childForFieldName("value"));
      default:
        break;
    }
    n = n.childForFieldName("declarator");
  }
  return { type };
}

function literalValue(text: string): number | undefined {
  const t = text.trim().replace(/[uUlL]+$/, "");
  if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) {
    return parseInt(t, 16);
  }
  if (/^-?\d+$/.test(t)) {
    return parseInt(t, 10);
  }
  return undefined;
}

/** All declarations visible in one file (its headers first, then the file), with lookups. */
export class Declarations implements TypedefSource {
  /** Later parts win (the file over its headers). Looked up, not copied: headers are shared by many files. */
  private readonly parts: readonly DeclData[];

  constructor(
    parts: readonly DeclData[],
    private readonly macros?: MacroLookup
  ) {
    this.parts = [...parts].reverse();
  }

  private find<T>(pick: (d: DeclData) => Map<string, T>, name: string): T | undefined {
    for (const p of this.parts) {
      const v = pick(p).get(name);
      if (v !== undefined) {
        return v;
      }
    }
    return undefined;
  }

  static empty(): Declarations {
    return new Declarations([]);
  }

  /** Follows typedef names (`u8` -> `uint8_t` -> builtin). */
  resolve(t: CType | undefined, depth = 0): CType | undefined {
    let cur = t;
    while (cur?.k === "named" && depth++ < 16) {
      const next = this.find((d) => d.typedefs, cur.name);
      if (!next) {
        return BUILTIN_TYPES[cur.name] ? { k: "builtin", name: cur.name } : cur;
      }
      cur = next;
    }
    return cur;
  }

  /** The scalar type (range) of a C type, or undefined for structs, arrays and functions. */
  scalarOf(t: CType | undefined): ScalarType | undefined {
    const r = this.resolve(t);
    switch (r?.k) {
      case "builtin":
        return BUILTIN_TYPES[r.name] ?? UNKNOWN_INT;
      case "named":
        return BUILTIN_TYPES[r.name] ?? UNKNOWN_INT;
      case "enum":
        return INT;
      case "ptr":
        return POINTER;
      default:
        return undefined;
    }
  }

  isAggregate(name: string): boolean {
    const r = this.resolve({ k: "named", name });
    return r?.k === "struct" || r?.k === "array";
  }

  hasTypedef(name: string): boolean {
    return this.find((d) => d.typedefs, name) !== undefined;
  }

  scalarOfName(name: string): ScalarType | undefined {
    return this.scalarOf({ k: "named", name });
  }

  field(t: CType | undefined, name: string): CType | undefined {
    const r = this.resolve(t);
    return r?.k === "struct" ? this.find((d) => d.structs, r.tag)?.get(name) : undefined;
  }

  /** Number of elements of an array type, when its size can be evaluated. */
  arrayLength(t: CType | undefined): number | undefined {
    const r = this.resolve(t);
    if (r?.k !== "array" || r.size === undefined) {
      return undefined;
    }
    const lit = literalValue(r.size);
    if (lit !== undefined) {
      return lit;
    }
    if (!this.macros) {
      return undefined;
    }
    const v = evaluateCondition(r.size, { ...this.macros, undefinedIsZero: false });
    return v !== undefined && v > 0 ? v : undefined;
  }

  /** True for a volatile field of a struct type (a hardware register: its value comes from outside). */
  isVolatileField(t: CType | undefined, name: string): boolean {
    const r = this.resolve(t);
    return r?.k === "struct" && this.parts.some((p) => p.volatiles?.has(`${r.tag}.${name}`) ?? false);
  }

  /** True for a variable declared volatile. */
  isVolatileVar(name: string): boolean {
    return this.parts.some((p) => p.volatiles?.has(name) ?? false);
  }

  /** The fields of a struct type in declaration order (empty when unknown). */
  fieldsOf(t: CType | undefined): [string, CType][] {
    const r = this.resolve(t);
    const f = r?.k === "struct" ? this.find((d) => d.structs, r.tag) : undefined;
    return f ? [...f] : [];
  }

  /** The tag of a struct type (after typedefs). */
  structTag(t: CType | undefined): string | undefined {
    const r = this.resolve(t);
    return r?.k === "struct" ? r.tag : undefined;
  }

  enumValue(name: string): number | undefined {
    return this.find((d) => d.enums, name);
  }

  varType(name: string): CType | undefined {
    return this.find((d) => d.vars, name);
  }

  returnType(name: string): CType | undefined {
    return this.find((d) => d.funcs, name);
  }

  hasFunction(name: string): boolean {
    return this.find((d) => d.funcs, name) !== undefined;
  }

  /**
   * True when a function or object of this name is declared in an included header. The analyzer passes the
   * headers first and the file itself last; that last part is not searched here.
   */
  declaredInHeader(name: string): boolean {
    return this.parts.slice(1).some((p) => p.funcs.has(name) || p.vars.has(name));
  }
}
