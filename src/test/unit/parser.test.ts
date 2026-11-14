import * as assert from "assert";
import * as path from "path";
import { Analyzer, SourceContext } from "../../core/analyzer";
import { createFinding } from "../../core/finding";
import { languageForFile, nodeRange, SourceParser, walk } from "../../core/parser/parser";

// Compiled tests live in out/test/unit; `npm run compile` copies the .wasm files to out/parsers.
const WASM_DIR = path.join(__dirname, "..", "..", "parsers");

const DIV = `int divide(int x, int y)
{
    if (y >= 0) {
        return x / y;
    }
    return 0;
}
`;

describe("core/parser (unit)", () => {
  let parser: SourceParser;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
  });

  after(() => parser.dispose());

  it("picks the grammar from the file extension", () => {
    assert.strictEqual(languageForFile("a.c"), "c");
    assert.strictEqual(languageForFile("a.h"), "c");
    assert.strictEqual(languageForFile("a.CPP"), "cpp");
    assert.strictEqual(languageForFile("a.hpp"), "cpp");
  });

  it("loads the C and C++ grammars", () => {
    assert.deepStrictEqual(parser.supportedLanguages.sort(), ["c", "cpp"]);
  });

  it("parses C into a syntax tree with 1-based ranges", () => {
    const parsed = parser.parse("div.c", DIV);
    try {
      assert.strictEqual(parsed.language, "c");
      assert.strictEqual(parsed.root.type, "translation_unit");
      assert.strictEqual(parsed.hasSyntaxErrors, false);
      const div = [...walk(parsed.root)].find((n) => n.type === "binary_expression" && n.childForFieldName("operator")?.type === "/");
      assert.ok(div, "division not found");
      assert.strictEqual(div.text, "x / y");
      assert.deepStrictEqual(nodeRange(div), { start: { line: 4, column: 16 }, end: { line: 4, column: 21 } });
    } finally {
      parsed.dispose();
    }
  });

  it("parses C++", () => {
    const parsed = parser.parse("a.cpp", "namespace n { class A { public: int f() const { return 1; } }; }\n");
    try {
      assert.strictEqual(parsed.language, "cpp");
      assert.strictEqual(parsed.hasSyntaxErrors, false);
      assert.ok([...walk(parsed.root)].some((n) => n.type === "class_specifier"));
    } finally {
      parsed.dispose();
    }
  });

  it("keeps going on broken code and reports it", () => {
    const parsed = parser.parse("bad.c", "int f( { return ; \n");
    try {
      assert.strictEqual(parsed.hasSyntaxErrors, true);
    } finally {
      parsed.dispose();
    }
  });

  it("counts columns in characters when non-ASCII text comes first", () => {
    const parsed = parser.parse("u.c", "/* ä */ int x;\n");
    try {
      const decl = [...walk(parsed.root)].find((n) => n.type === "declaration");
      assert.ok(decl);
      assert.strictEqual(nodeRange(decl).start.column, 9);
    } finally {
      parsed.dispose();
    }
  });

  it("walks every node in source order", () => {
    const parsed = parser.parse("w.c", "int a; int b;\n");
    try {
      const ids = [...walk(parsed.root)].filter((n) => n.type === "identifier").map((n) => n.text);
      assert.deepStrictEqual(ids, ["a", "b"]);
    } finally {
      parsed.dispose();
    }
  });

  it("gives checks the parsed tree through the analyzer", () => {
    const seen: string[] = [];
    const check = (src: SourceContext) => {
      seen.push(src.parsed?.root.type ?? "none");
      return [
        createFinding({
          ruleId: "sca-own:test",
          message: "m",
          file: src.file,
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          certainty: "possible",
        }),
      ];
    };
    assert.strictEqual(new Analyzer([check], parser).analyze("div.c", DIV).length, 1);
    assert.strictEqual(new Analyzer([check]).analyze("div.c", DIV).length, 1);
    assert.deepStrictEqual(seen, ["translation_unit", "none"]);
  });
});
