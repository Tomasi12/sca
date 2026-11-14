// Parser layer: turns C/C++ source text into a syntax tree with tree-sitter (WASM build, no native code).
// Pure logic (no VS Code API), so checks and the headless benchmark use the same parser.
//
// Known limit: tree-sitter reads the code *before* the preprocessor runs. Macros are not expanded and
// all #if branches are parsed, so checks must not trust the tree blindly around macros.

import * as path from "path";
import { Language, Node, Parser, Tree } from "web-tree-sitter";
import { Position, Range } from "../finding";

export type SourceLanguage = "c" | "cpp";

const CPP_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);

/** Picks the grammar from the file extension. `.h` is read as C (the common case in embedded code). */
export function languageForFile(file: string): SourceLanguage {
  return CPP_EXTENSIONS.has(path.extname(file).toLowerCase()) ? "cpp" : "c";
}

/** Folder with the `.wasm` files, copied there by `npm run compile` (out/parsers). */
export const DEFAULT_WASM_DIR = path.join(__dirname, "..", "..", "parsers");

const GRAMMAR_FILES: Record<SourceLanguage, string> = {
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
};

/** One parsed file. Call `dispose()` when done: the tree lives in WASM memory. */
export interface ParsedSource {
  readonly file: string;
  readonly language: SourceLanguage;
  readonly text: string;
  readonly tree: Tree;
  readonly root: Node;
  /** True when tree-sitter had to recover from syntax it did not understand (often macros). */
  readonly hasSyntaxErrors: boolean;
  dispose(): void;
}

let initDone: Promise<void> | undefined;

export class SourceParser {
  private constructor(
    private readonly parser: Parser,
    private readonly languages: ReadonlyMap<SourceLanguage, Language>
  ) {}

  /** Loads the tree-sitter runtime and the C and C++ grammars from `wasmDir`. */
  static async create(wasmDir = DEFAULT_WASM_DIR): Promise<SourceParser> {
    initDone ??= Parser.init({ locateFile: (name: string) => path.join(wasmDir, name) });
    try {
      await initDone;
    } catch (err) {
      initDone = undefined;
      throw err;
    }
    const languages = new Map<SourceLanguage, Language>();
    for (const [lang, fileName] of Object.entries(GRAMMAR_FILES) as [SourceLanguage, string][]) {
      languages.set(lang, await Language.load(path.join(wasmDir, fileName)));
    }
    return new SourceParser(new Parser(), languages);
  }

  get supportedLanguages(): SourceLanguage[] {
    return [...this.languages.keys()];
  }

  parse(file: string, text: string, language = languageForFile(file)): ParsedSource {
    const grammar = this.languages.get(language);
    if (!grammar) {
      throw new Error(`No grammar loaded for ${language}.`);
    }
    this.parser.setLanguage(grammar);
    const tree = this.parser.parse(text);
    if (!tree) {
      throw new Error(`tree-sitter could not parse ${file}.`);
    }
    let disposed = false;
    return {
      file,
      language,
      text,
      tree,
      root: tree.rootNode,
      hasSyntaxErrors: tree.rootNode.hasError,
      dispose: () => {
        if (!disposed) {
          disposed = true;
          tree.delete();
        }
      },
    };
  }

  dispose(): void {
    this.parser.delete();
  }
}

/** tree-sitter positions are 0-based; findings use 1-based lines and columns. */
export function toPosition(point: { row: number; column: number }): Position {
  return { line: point.row + 1, column: point.column + 1 };
}

/** The finding range of a syntax node (end exclusive, like tree-sitter's end position). */
export function nodeRange(node: Node): Range {
  return { start: toPosition(node.startPosition), end: toPosition(node.endPosition) };
}

/** Visits every node below (and including) `root`, depth-first, in source order. */
export function* walk(root: Node): Generator<Node> {
  const cursor = root.walk();
  try {
    let descending = true;
    while (true) {
      if (descending) {
        yield cursor.currentNode;
        if (cursor.gotoFirstChild()) {
          continue;
        }
      }
      if (cursor.gotoNextSibling()) {
        descending = true;
        continue;
      }
      if (!cursor.gotoParent() || cursor.currentNode.id === root.id) {
        return;
      }
      descending = false;
    }
  } finally {
    cursor.delete();
  }
}
