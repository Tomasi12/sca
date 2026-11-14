// Baseline: a snapshot of the findings that already exist, so only *new* findings are shown.
// Useful when SCA is turned on for old code with many findings.
//
// A finding is recognized by its file, rule and the text of its source line (whitespace-normalized),
// not by its line number: code added above it does not make an old finding look new.
// When the same line text appears several times in a file, the n-th occurrence is matched with the n-th.

import { Finding } from "./finding";

export const BASELINE_FILE = ".sca-baseline.json";

export interface BaselineEntry {
  file: string;
  rule: string;
  /** The source line, whitespace collapsed. */
  code: string;
  /** Line when the baseline was saved (for humans; not used to match). */
  line: number;
}

export interface Baseline {
  version: 1;
  created: string;
  entries: BaselineEntry[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

function keyOf(file: string, rule: string, code: string): string {
  return `${file.toLowerCase()}\0${rule}\0${code}`;
}

function lineText(lines: readonly string[], line: number): string {
  return norm(lines[line - 1] ?? "");
}

/** Builds baseline entries for one file's findings (justified findings are not baselined; they are already reviewed). */
export function baselineEntries(findings: readonly Finding[], text: string, relPath: string): BaselineEntry[] {
  const lines = text.split(/\r?\n/);
  return findings
    .filter((f) => f.status !== "justified")
    .map((f) => ({ file: relPath, rule: f.ruleId, code: lineText(lines, f.range.start.line), line: f.range.start.line }));
}

export function createBaseline(entries: readonly BaselineEntry[], created = new Date()): Baseline {
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { version: 1, created: created.toISOString(), entries: sorted };
}

export function parseBaseline(text: string): Baseline {
  const data = JSON.parse(text) as Partial<Baseline>;
  if (data?.version !== 1 || !Array.isArray(data.entries)) {
    throw new Error(`${BASELINE_FILE}: unsupported format.`);
  }
  const entries = data.entries.filter(
    (e): e is BaselineEntry => !!e && typeof e.file === "string" && typeof e.rule === "string" && typeof e.code === "string"
  );
  return { version: 1, created: String(data.created ?? ""), entries };
}

/** Splits one file's findings into those to show (new) and the number hidden by the baseline. */
export function applyBaseline(
  findings: readonly Finding[],
  text: string,
  relPath: string,
  baseline: Baseline
): { shown: Finding[]; hidden: number } {
  const budget = new Map<string, number>();
  for (const e of baseline.entries) {
    if (e.file.toLowerCase() === relPath.toLowerCase()) {
      const k = keyOf(e.file, e.rule, e.code);
      budget.set(k, (budget.get(k) ?? 0) + 1);
    }
  }
  if (budget.size === 0) {
    return { shown: [...findings], hidden: 0 };
  }
  const lines = text.split(/\r?\n/);
  const shown: Finding[] = [];
  let hidden = 0;
  for (const f of findings) {
    const k = keyOf(relPath, f.ruleId, lineText(lines, f.range.start.line));
    const left = budget.get(k) ?? 0;
    if (f.status !== "justified" && left > 0) {
      budget.set(k, left - 1);
      hidden++;
    } else {
      shown.push(f);
    }
  }
  return { shown, hidden };
}
