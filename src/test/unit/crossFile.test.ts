import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../../core/analyzer";
import { CATEGORY_RULES } from "../../core/checks";
import { checkAccumulators } from "../../core/checks/accumulate";
import { checkRuntime } from "../../core/checks/runtime";
import { SourceParser } from "../../core/parser/parser";
import { fsReadFile, Project } from "../../core/project/project";

const WASM_DIR = path.join(__dirname, "..", "..", "parsers");
const ROOT = path.join(__dirname, "..", "..", "..", "tests", "samples", "cross_file");
const CHECKS = [checkRuntime, checkAccumulators];
const MARKER = /\/\*\s*(DEFECT|RULE|SAFE)\(([a-z_]+)\):/g;
const SOURCES = ["app.c", "calib.c", "speed.c", "frames.c", "accumulate.c"].map((f) => path.join(ROOT, f));

describe("cross-file knowledge: project index (unit)", () => {
  let parser: SourceParser;

  before(async () => {
    parser = await SourceParser.create(WASM_DIR);
  });

  after(() => parser.dispose());

  function indexed(readFile = fsReadFile): { analyzer: Analyzer; project: Project; reindex: (file?: string) => void } {
    const analyzer = new Analyzer(CHECKS, parser);
    const project = Project.load(ROOT, readFile);
    const index = analyzer.indexProject(project, () => SOURCES, readFile);
    return { analyzer, project, reindex: (file) => index.invalidate(file) };
  }

  for (const file of SOURCES.slice(1)) {
    it(`matches every marker in tests/samples/cross_file/${path.basename(file)}`, () => {
      const { analyzer, project } = indexed();
      const text = fs.readFileSync(file, "utf8");
      const findings = analyzer.analyze(file, text, project.contextFor(file)).filter((f) => f.ruleId.startsWith("runtime-bugfinder:"));
      const problems: string[] = [];
      const marked = new Set<number>();
      text.split(/\r?\n/).forEach((l, i) => {
        for (const m of l.matchAll(MARKER)) {
          marked.add(i + 1);
          const rules = CATEGORY_RULES[m[2]];
          const hit = findings.some((f) => f.range.start.line === i + 1 && rules.includes(f.ruleId));
          if (m[1] === "SAFE" && hit) {
            problems.push(`line ${i + 1}: false positive for ${m[2]}`);
          }
          if (m[1] !== "SAFE" && !hit) {
            problems.push(`line ${i + 1}: missed ${m[2]}`);
          }
        }
      });
      for (const f of findings) {
        if (!marked.has(f.range.start.line)) {
          problems.push(`line ${f.range.start.line}: unmarked ${f.ruleId}: ${f.message}`);
        }
      }
      assert.deepStrictEqual(problems, []);
    });
  }

  it("names the other file and the caller in messages", () => {
    const { analyzer, project } = indexed();
    const speed = path.join(ROOT, "speed.c");
    const findings = analyzer.analyze(speed, fs.readFileSync(speed, "utf8"), project.contextFor(speed));
    assert.match(findings.find((f) => f.ruleId === "runtime-bugfinder:null-deref")?.message ?? "", /main\(\) passes .*calib_load\(\) can return NULL/);
    assert.match(findings.find((f) => f.ruleId === "runtime-bugfinder:div-zero")?.message ?? "", /initializer of 'erased' in app\.c \(line 11\) sets ticks to 0/);
  });

  it("finds nothing from other files without the index", () => {
    const analyzer = new Analyzer(CHECKS, parser);
    const project = Project.load(ROOT);
    const speed = path.join(ROOT, "speed.c");
    const findings = analyzer.analyze(speed, fs.readFileSync(speed, "utf8"), project.contextFor(speed));
    assert.deepStrictEqual(findings.filter((f) => f.ruleId.startsWith("runtime-bugfinder:")), []);
  });

  it("redoes the facts of a changed file (and only then)", () => {
    const app = path.join(ROOT, "app.c");
    let appText = fs.readFileSync(app, "utf8");
    const readFile = (f: string) => (f === app ? appText : fsReadFile(f));
    const { analyzer, project, reindex } = indexed(readFile);
    const speed = path.join(ROOT, "speed.c");
    const divZero = () => analyzer.analyze(speed, fs.readFileSync(speed, "utf8"), project.contextFor(speed)).some((f) => f.ruleId === "runtime-bugfinder:div-zero");
    assert.ok(divZero());
    appText = appText.replace("erased = {0U, 100U}", "erased = {7U, 100U}");
    assert.ok(divZero(), "cached until the change is reported");
    reindex(app);
    assert.ok(!divZero(), "the 0 came from app.c and is gone now");
  });
});
