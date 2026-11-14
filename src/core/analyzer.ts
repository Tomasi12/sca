// Runs all checks on one file. Pure logic (no VS Code API), so it also runs headless (benchmark, CLI).
//
// Steps: preprocess (#if branches, macros) -> parse -> checks -> project rules (on/off, severity)
// -> justifications (comments in the code, deviations in .sca.json). Results are cached by file content.

import { createHash } from "crypto";
import { describeFunctionAt } from "./engine/debug";
import { justificationFor, findJustifications } from "./justify";
import { compareFindings, Finding } from "./finding";
import { ParsedSource, SourceParser } from "./parser/parser";
import { MacroTable, preprocess, PreprocessEnv } from "./preprocess/preprocessor";
import { isRuleEnabled, rulePatternMatches } from "./project/config";
import { FileContext } from "./project/project";

/** What a check gets: the file, its text and, when the parser is loaded, its syntax tree. */
export interface SourceContext {
  readonly file: string;
  /** The text as written (line and column numbers match `parsed`). */
  readonly text: string;
  /** Syntax tree of the preprocessed text (inactive #if branches are blank lines). */
  readonly parsed?: ParsedSource;
  /** Macros known at the end of the file (from the file, its headers and the build flags). */
  readonly macros?: MacroTable;
}

/** A check returns findings for the file it is given. */
export type Check = (source: SourceContext) => Finding[];

/** Without a project: no include paths, unknown build defines (both #ifdef branches stay). */
const NO_PROJECT_ENV: PreprocessEnv = { defines: new Map(), includePaths: [], complete: false, readFile: () => undefined };

const CACHE_LIMIT = 10000;

export class Analyzer {
  private readonly cache = new Map<string, Finding[]>();
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

  /** "Show CFG": the engine's view of the function at a 1-based line (undefined: no parser or no function). */
  describeFunction(file: string, text: string, line: number, context?: FileContext): string | undefined {
    const pre = preprocess(file, text, context?.env ?? NO_PROJECT_ENV);
    const parsed = this.parser?.parse(file, pre.text);
    if (!parsed) {
      return undefined;
    }
    try {
      return describeFunctionAt({ file, text, parsed, macros: pre.macros }, line);
    } finally {
      parsed.dispose();
    }
  }

  private run(file: string, text: string, context?: FileContext): Finding[] {
    const pre = preprocess(file, text, context?.env ?? NO_PROJECT_ENV);
    const parsed = this.parser?.parse(file, pre.text);
    let findings: Finding[];
    try {
      findings = this.checks.flatMap((check) => check({ file, text, parsed, macros: pre.macros }));
    } finally {
      parsed?.dispose();
    }

    const config = context?.config;
    if (config) {
      findings = findings
        .filter((f) => isRuleEnabled(config, f.ruleId))
        .map((f) => {
          const severity = config.rules[f.ruleId]?.severity;
          return severity && severity !== f.severity ? { ...f, severity } : f;
        });
    }

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
