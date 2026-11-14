// Runs all checks on one file. Pure logic (no VS Code API), so it also runs headless (benchmark, CLI).

import { compareFindings, Finding } from "./finding";
import { ParsedSource, SourceParser } from "./parser/parser";

/** What a check gets: the file, its text and, when the parser is loaded, its syntax tree. */
export interface SourceContext {
  readonly file: string;
  readonly text: string;
  readonly parsed?: ParsedSource;
}

/** A check returns findings for the file it is given. */
export type Check = (source: SourceContext) => Finding[];

export class Analyzer {
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

  analyze(file: string, text: string): Finding[] {
    if (this.checks.length === 0) {
      return [];
    }
    const parsed = this.parser?.parse(file, text);
    try {
      return this.checks.flatMap((check) => check({ file, text, parsed })).sort(compareFindings);
    } finally {
      parsed?.dispose();
    }
  }
}
