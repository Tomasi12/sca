// Runs all checks on one file. Pure logic (no VS Code API), so it also runs headless (benchmark, CLI).

import { compareFindings, Finding } from "./finding";

/** A check gets the file path and its text, and returns findings for that file. */
export type Check = (file: string, text: string) => Finding[];

export class Analyzer {
  constructor(private readonly checks: readonly Check[] = []) {}

  get checkCount(): number {
    return this.checks.length;
  }

  analyze(file: string, text: string): Finding[] {
    return this.checks.flatMap((check) => check(file, text)).sort(compareFindings);
  }
}
