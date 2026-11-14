// C scalar types as the engine sees them: integer (with a value range), floating point, or pointer.

import { Node } from "web-tree-sitter";

export type ScalarKind = "int" | "float" | "ptr";

export interface ScalarType {
  readonly kind: ScalarKind;
  readonly lo: number;
  readonly hi: number;
  /** Unsigned integers wrap around; signed overflow is undefined, so the result is unknown either way. */
  readonly unsigned: boolean;
  readonly name: string;
}

const int = (name: string, lo: number, hi: number, unsigned = lo === 0): ScalarType => ({ kind: "int", lo, hi, unsigned, name });

const U8 = int("u8", 0, 0xff);
const S8 = int("s8", -0x80, 0x7f);
const U16 = int("u16", 0, 0xffff);
const S16 = int("s16", -0x8000, 0x7fff);
const U32 = int("u32", 0, 0xffffffff);
const S32 = int("s32", -0x80000000, 0x7fffffff);
const U64 = int("u64", 0, 2 ** 64 - 1);
const S64 = int("s64", -(2 ** 63), 2 ** 63 - 1);
const BOOL = int("bool", 0, 1);

export const FLOAT: ScalarType = { kind: "float", lo: -Infinity, hi: Infinity, unsigned: false, name: "float" };
export const POINTER: ScalarType = { kind: "ptr", lo: 0, hi: 1, unsigned: true, name: "pointer" };
/** An integer type we do not know (a typedef from a header we could not read): no range limits. */
export const UNKNOWN_INT: ScalarType = { kind: "int", lo: -Infinity, hi: Infinity, unsigned: false, name: "int?" };
export const INT = S32;

/** Standard names and common embedded aliases. `long` is taken as 64 bits (the wider choice is the safe one). */
const BUILTIN: Record<string, ScalarType> = {
  bool: BOOL, _Bool: BOOL, boolean: BOOL,
  char: S8, "signed char": S8, "unsigned char": U8,
  int8_t: S8, s8: S8, i8: S8, sint8: S8, sint8_t: S8, int8: S8, INT8: S8,
  uint8_t: U8, u8: U8, uint8: U8, UINT8: U8, byte: U8, BYTE: U8,
  short: S16, "short int": S16, "signed short": S16, int16_t: S16, s16: S16, i16: S16, sint16: S16, sint16_t: S16, int16: S16, INT16: S16,
  "unsigned short": U16, "unsigned short int": U16, uint16_t: U16, u16: U16, uint16: U16, UINT16: U16, WORD: U16,
  int: S32, signed: S32, "signed int": S32, int32_t: S32, s32: S32, i32: S32, sint32: S32, sint32_t: S32, int32: S32, INT32: S32,
  unsigned: U32, "unsigned int": U32, uint32_t: U32, u32: U32, uint32: U32, UINT32: U32, DWORD: U32,
  long: S64, "long int": S64, "signed long": S64, "long long": S64, "long long int": S64, int64_t: S64, s64: S64, i64: S64, sint64: S64, int64: S64, ptrdiff_t: S64, intptr_t: S64, ssize_t: S64,
  "unsigned long": U64, "unsigned long int": U64, "unsigned long long": U64, "unsigned long long int": U64, uint64_t: U64, u64: U64, uint64: U64, size_t: U64, uintptr_t: U64,
  float: FLOAT, double: FLOAT, "long double": FLOAT, float32_t: FLOAT, float64_t: FLOAT, f32: FLOAT, f64: FLOAT, float32: FLOAT, float64: FLOAT,
};

/** Type names known in one file: the builtins plus the file's own `typedef ... name;`. */
export class TypeTable {
  private readonly typedefs = new Map<string, ScalarType | "aggregate">();

  /** Reads the file's typedefs (scalar typedefs get a range; struct/union/array typedefs are "aggregate"). */
  static fromTree(root: Node): TypeTable {
    return TypeTable.fromDefinitions(root.descendantsOfType("type_definition"));
  }

  /** Same, from already collected `type_definition` nodes. */
  static fromDefinitions(defs: readonly (Node | null)[]): TypeTable {
    const table = new TypeTable();
    for (const def of defs) {
      if (!def) {
        continue;
      }
      const typeNode = def.childForFieldName("type");
      for (const d of def.childrenForFieldName("declarator")) {
        if (!d) {
          continue;
        }
        if (d.type === "type_identifier") {
          table.typedefs.set(d.text, typeNode ? table.ofSpecifier(typeNode) ?? "aggregate" : "aggregate");
        } else if (d.type === "pointer_declarator") {
          const inner = innermostName(d);
          if (inner) {
            table.typedefs.set(inner, POINTER);
          }
        } else {
          const inner = innermostName(d);
          if (inner) {
            table.typedefs.set(inner, "aggregate");
          }
        }
      }
    }
    return table;
  }

  /**
   * The scalar type of a type specifier node, or undefined for struct/union/array types.
   * Unknown names (typedefs from headers) count as an integer of unknown range.
   */
  ofSpecifier(node: Node): ScalarType | undefined {
    switch (node.type) {
      case "struct_specifier":
      case "union_specifier":
      case "class_specifier":
        return undefined;
      case "enum_specifier":
        return INT;
      case "primitive_type":
      case "sized_type_specifier":
        return BUILTIN[normalize(node.text)] ?? UNKNOWN_INT;
      case "type_identifier": {
        const own = this.typedefs.get(node.text);
        if (own === "aggregate") {
          return undefined;
        }
        return own ?? BUILTIN[node.text] ?? UNKNOWN_INT;
      }
      default:
        return BUILTIN[normalize(node.text)] ?? UNKNOWN_INT;
    }
  }

  /** The type a plain name stands for (a typedef or builtin), or undefined when it is not known as a type. */
  ofName(name: string): ScalarType | undefined {
    const own = this.typedefs.get(name);
    if (own !== undefined) {
      return own === "aggregate" ? undefined : own;
    }
    return BUILTIN[name];
  }

  /** The type of a cast like `(u16)x`: the cast's type descriptor. Pointer casts give POINTER. */
  ofDescriptor(desc: Node): ScalarType | undefined {
    const decl = desc.childForFieldName("declarator");
    if (decl && /pointer/.test(decl.type)) {
      return POINTER;
    }
    if (decl && /array|function/.test(decl.type)) {
      return undefined;
    }
    const spec = desc.childForFieldName("type");
    return spec ? this.ofSpecifier(spec) : undefined;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function innermostName(d: Node): string | undefined {
  for (let n: Node | null = d; n; n = n.childForFieldName("declarator")) {
    if (n.type === "type_identifier" || n.type === "identifier") {
      return n.text;
    }
  }
  return undefined;
}
