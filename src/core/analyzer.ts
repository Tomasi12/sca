// Runs all checks on one file. Pure logic (no VS Code API), so it also runs headless (benchmark, CLI).
//
// Steps: preprocess (#if branches, macros) -> parse -> checks -> project rules (on/off incl. rule defaults, severity)
// -> justifications (comments in the code, deviations in .sca.json). Results are cached by file content.

import { createHash } from "crypto";
import { DeclData, Declarations, emptyDecls, extractDeclarations } from "./engine/declarations";
import { describeFunctionAt } from "./engine/debug";
import { justificationFor, findJustifications } from "./justify";
import { compareFindings, Finding } from "./finding";
import { ParsedSource, SourceParser } from "./parser/parser";
import { MacroTable, preprocess, PreprocessEnv, PreprocessResult } from "./preprocess/preprocessor";
import { emptyConfig, isRuleEnabled, rulePatternMatches, ScaConfig } from "./project/config";
import { isEnabledByDefault } from "./rules/registry";
import { FileContext, fsReadFile, Project, ReadFile } from "./project/project";
import { ProjectKnowledge } from "./engine/knowledge";
import { ProjectIndex } from "./project/projectIndex";

/** What a check gets: the file, its text and, when the parser is loaded, its syntax tree. */
export interface SourceContext {
  readonly file: string;
  /** The text as written (line and column numbers match `parsed`). */
  readonly text: string;
  /** Syntax tree of the preprocessed text (inactive #if branches are blank lines). */
  readonly parsed?: ParsedSource;
  /** Macros known at the end of the file (from the file, its headers and the build flags). */
  readonly macros?: MacroTable;
  /** Typedefs, structs, enums, globals and prototypes from the included headers and the file. */
  readonly declarations?: Declarations;
  /** The project config (.sca.json), for rule parameters such as metric limits. */
  readonly config?: ScaConfig;
  /** Quoted includes that were not found; checks that need every header stay quiet when this is not empty. */
  readonly missingIncludes?: readonly string[];
  /** Facts from the other files of the project (cross-file summaries), when there is a project index. */
  readonly knowledge?: ProjectKnowledge;
}

/** A check returns findings for the file it is given. */
export type Check = (source: SourceContext) => Finding[];

/** Without a project: no include paths, unknown build defines (both #ifdef branches stay). */
const NO_PROJECT_ENV: PreprocessEnv = { defines: new Map(), includePaths: [], complete: false, readFile: () => undefined };

const CACHE_LIMIT = 10000;

export class Analyzer {
  private readonly cache = new Map<string, Finding[]>();
  /** Declarations of headers, by path; reused while the header text is unchanged. */
  private readonly headerDecls = new Map<string, { text: string; data: DeclData }>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly checks: readonly Check[] = [],
    private readonly parser?: SourceParser
  ) {}

  get checkCount(): number {
    return this.checks.length;
  }

  get hasParser(): boolean {
    return this.parser !== undefined;
  }

  get cacheStats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }

  clearCache(): void {
    this.cache.clear();
  }

  analyze(file: string, text: string, context?: FileContext): Finding[] {
    if (this.checks.length === 0) {
      return [];
    }
    const key = `${file}\0${context?.version ?? "-"}\0${createHash("sha1").update(text).digest("hex")}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, cached);
      return [...cached];
    }
    this.misses++;
    const result = this.run(file, text, context);
    this.cache.set(key, result);
    if (this.cache.size > CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return [...result];
  }

  /**
   * Gives the project an index over its source files (`files`), so each file's analysis knows what the other
   * files return, pass and initialize. Other files are prepared with the same steps as an analyzed file.
   */
  indexProject(project: Project, files: () => readonly string[], readFile: ReadFile = fsReadFile): ProjectIndex {
    const index = new ProjectIndex(files, (file, text, use) => this.withSource(file, text, project.contextFor(file), use), readFile);
    project.useIndex(index);
    return index;
  }

  /** Preprocesses and parses a file and runs `use` on it (undefined without a parser). */
  withSource<T>(file: string, text: string, context: FileContext | undefined, use: (source: SourceContext) => T): T | undefined {
    const pre = preprocess(file, text, context?.env ?? NO_PROJECT_ENV);
    const parsed = this.parser?.parse(file, pre.text);
    if (!parsed) {
      return undefined;
    }
    try {
      const declarations = this.declarationsFor(pre, parsed.root);
      return use({ file, text, parsed, macros: pre.macros, declarations, config: context?.config, missingIncludes: pre.missingIncludes, knowledge: context?.knowledge });
    } finally {
      parsed.dispose();
    }
  }

  /** "Show CFG": the engine's view of the function at a 1-based line (undefined: no parser or no function). */
  describeFunction(file: string, text: string, line: number, context?: FileContext): string | undefined {
    const pre = preprocess(file, text, context?.env ?? NO_PROJECT_ENV);
    const parsed = this.parser?.parse(file, pre.text);
    if (!parsed) {
      return undefined;
    }
    try {
      return describeFunctionAt({ file, text, parsed, macros: pre.macros, declarations: this.declarationsFor(pre, parsed.root), knowledge: context?.knowledge }, line);
    } finally {
      parsed.dispose();
    }
  }

  /** Headers first (in include order), then the file itself, so the file's own declarations win. */
  private declarationsFor(pre: PreprocessResult, root: import("web-tree-sitter").Node): Declarations {
    const parts: DeclData[] = [];
    for (const h of pre.headers) {
      parts.push(this.headerDeclarations(h.file, h.text));
    }
    parts.push(extractDeclarations(root));
    return new Declarations(parts, pre.macros.asLookup());
  }

  private headerDeclarations(file: string, text: string): DeclData {
    const known = this.headerDecls.get(file);
    if (known && known.text === text) {
      return known.data;
    }
    let data: DeclData = emptyDecls();
    if (this.parser && text.length <= 400_000) {
      const tree = this.parser.parse(file, text);
      try {
        data = extractDeclarations(tree.root);
      } finally {
        tree.dispose();
      }
    }
    if (this.headerDecls.size >= 4000) {
      this.headerDecls.clear();
    }
    this.headerDecls.set(file, { text, data });
    return data;
  }

  private run(file: string, text: string, context?: FileContext): Finding[] {
    const pre = preprocess(file, text, context?.env ?? NO_PROJECT_ENV);
    const parsed = this.parser?.parse(file, pre.text);
    let findings: Finding[];
    try {
      const declarations = parsed ? this.declarationsFor(pre, parsed.root) : undefined;
      const ctx: SourceContext = { file, text, parsed, macros: pre.macros, declarations, config: context?.config, missingIncludes: pre.missingIncludes, knowledge: context?.knowledge };
      findings = this.checks.flatMap((check) => check(ctx));
    } finally {
      parsed?.dispose();
    }
    return this.applyProject(text, findings, context);
  }

  /**
   * The project steps every finding goes through, native or from an external backend: rules on/off (rule
   * defaults included), severity overrides, justification comments and deviations from .sca.json.
   */
  applyProject(text: string, input: readonly Finding[], context?: FileContext): Finding[] {
    let findings = [...input];
    const config = context?.config;
    const rules = config ?? emptyConfig();
    findings = findings
      .filter((f) => isRuleEnabled(rules, f.ruleId, isEnabledByDefault(f.ruleId)))
      .map((f) => {
        const severity = rules.rules[f.ruleId]?.severity;
        return severity && severity !== f.severity ? { ...f, severity } : f;
      });

    const inCode = text.includes("sca-justify(") ? findJustifications(text) : [];
    const deviations = config && context?.relPath ? config.deviations.filter((d) => d.file === context.relPath) : [];
    if (inCode.length > 0 || deviations.length > 0) {
      findings = findings.map((f) => {
        const line = f.range.start.line;
        const reason =
          justificationFor(inCode, f.ruleId, line) ??
          deviations.find((d) => d.line === line && rulePatternMatches(d.rule, f.ruleId))?.reason;
        return reason && f.status !== "justified" ? { ...f, status: "justified", justification: reason } : f;
      });
    }
    return findings.sort(compareFindings);
  }
}
