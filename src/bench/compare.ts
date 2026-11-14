// Compares SCA findings with an answer key of planted issues (expected_findings.csv).
// Pure logic: no file system, no VS Code.
//
// Answer key rows come from markers in the code, on the line where the issue is:
//   DEFECT(category) / RULE(category)  -> should be reported   (missing = "missed")
//   SAFE(category)                     -> must not be reported (reported = "false positive")
// A finding matches a row when file and line are equal and its rule ID belongs to the row's category.

export type MarkerKind = "DEFECT" | "RULE" | "SAFE";

export interface ExpectedRow {
  file: string;
  line: number;
  kind: MarkerKind;
  category: string;
  description: string;
}

export interface BenchFinding {
  /** Path relative to the project, with forward slashes. */
  file: string;
  line: number;
  ruleId: string;
  message: string;
}

export interface CategoryResult {
  category: string;
  ruleIds: readonly string[];
  expected: number;
  found: ExpectedRow[];
  missed: ExpectedRow[];
  falsePositives: { row: ExpectedRow; finding: BenchFinding }[];
  safeLines: number;
}

export interface BenchmarkResult {
  categories: CategoryResult[];
  /** Findings on lines without a matching marker: neither confirmed nor refuted, review them by hand. */
  unmarked: BenchFinding[];
  /** Answer-key categories that no SCA check covers yet, with the number of expected issues. */
  notCovered: { category: string; expected: number }[];
  totals: { expected: number; found: number; missed: number; falsePositives: number; unmarked: number };
}

/** Parses the CSV written by car-control's tools/expected_findings.ps1 (quoted fields, optional BOM). */
export function parseAnswerKey(csv: string): ExpectedRow[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return [];
  }
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) {
      throw new Error(`Answer key has no "${name}" column.`);
    }
    return i;
  };
  const [iFile, iLine, iKind, iCat, iDesc] = ["file", "line", "kind", "category", "description"].map(col);
  return lines.slice(1).map((l, n) => {
    const cells = parseCsvLine(l);
    const kind = cells[iKind] as MarkerKind;
    const line = Number(cells[iLine]);
    if (!["DEFECT", "RULE", "SAFE"].includes(kind) || !Number.isInteger(line)) {
      throw new Error(`Answer key line ${n + 2} is malformed: ${l}`);
    }
    return { file: normalizePath(cells[iFile]), line, kind, category: cells[iCat], description: cells[iDesc] ?? "" };
  });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function compare(
  expected: readonly ExpectedRow[],
  findings: readonly BenchFinding[],
  categoryRules: Readonly<Record<string, readonly string[]>>
): BenchmarkResult {
  const key = (file: string, line: number) => `${normalizePath(file).toLowerCase()}:${line}`;
  const rowsAt = new Map<string, ExpectedRow[]>();
  for (const r of expected) {
    const k = key(r.file, r.line);
    rowsAt.set(k, [...(rowsAt.get(k) ?? []), r]);
  }
  const matches = (row: ExpectedRow, f: BenchFinding) => (categoryRules[row.category] ?? []).includes(f.ruleId);

  const categories: CategoryResult[] = Object.entries(categoryRules).map(([category, ruleIds]) => ({
    category,
    ruleIds,
    expected: 0,
    found: [],
    missed: [],
    falsePositives: [],
    safeLines: 0,
  }));
  const byCategory = new Map(categories.map((c) => [c.category, c]));

  const used = new Set<BenchFinding>();
  for (const row of expected) {
    const cat = byCategory.get(row.category);
    if (!cat) {
      continue;
    }
    const hits = findings.filter((f) => key(f.file, f.line) === key(row.file, row.line) && matches(row, f));
    hits.forEach((h) => used.add(h));
    if (row.kind === "SAFE") {
      cat.safeLines++;
      hits.forEach((finding) => cat.falsePositives.push({ row, finding }));
    } else {
      cat.expected++;
      (hits.length > 0 ? cat.found : cat.missed).push(row);
    }
  }

  const unmarked = findings.filter((f) => !used.has(f));
  const notCoveredCounts = new Map<string, number>();
  for (const r of expected) {
    if (!byCategory.has(r.category) && r.kind !== "SAFE") {
      notCoveredCounts.set(r.category, (notCoveredCounts.get(r.category) ?? 0) + 1);
    }
  }
  const sum = (f: (c: CategoryResult) => number) => categories.reduce((n, c) => n + f(c), 0);
  return {
    categories,
    unmarked,
    notCovered: [...notCoveredCounts].map(([category, n]) => ({ category, expected: n })).sort((a, b) => a.category.localeCompare(b.category)),
    totals: {
      expected: sum((c) => c.expected),
      found: sum((c) => c.found.length),
      missed: sum((c) => c.missed.length),
      falsePositives: sum((c) => c.falsePositives.length),
      unmarked: unmarked.length,
    },
  };
}

/** Plain-text report for the terminal. */
export function formatReport(result: BenchmarkResult, title = "SCA benchmark"): string {
  const out: string[] = [title, "=".repeat(title.length), ""];
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  out.push(`${pad("category", 16)}${pad("expected", 10)}${pad("found", 8)}${pad("missed", 8)}${pad("false pos.", 12)}safe lines`);
  for (const c of result.categories) {
    out.push(`${pad(c.category, 16)}${pad(c.expected, 10)}${pad(c.found.length, 8)}${pad(c.missed.length, 8)}${pad(c.falsePositives.length, 12)}${c.safeLines}`);
  }
  const t = result.totals;
  out.push(`${pad("TOTAL", 16)}${pad(t.expected, 10)}${pad(t.found, 8)}${pad(t.missed, 8)}${pad(t.falsePositives, 12)}`);
  out.push("", `Recall (covered categories): ${t.expected === 0 ? "-" : `${Math.round((100 * t.found) / t.expected)} %`}`);

  const missed = result.categories.flatMap((c) => c.missed);
  if (missed.length > 0) {
    out.push("", "Missed:");
    missed.forEach((r) => out.push(`  ${r.file}:${r.line}  ${r.category}  ${r.description}`));
  }
  const fps = result.categories.flatMap((c) => c.falsePositives);
  if (fps.length > 0) {
    out.push("", "False positives (reported on a SAFE line):");
    fps.forEach(({ row, finding }) => out.push(`  ${row.file}:${row.line}  ${finding.ruleId}  (SAFE: ${row.description})`));
  }
  if (result.unmarked.length > 0) {
    out.push("", "Unmarked findings (no marker on that line; review by hand):");
    result.unmarked.forEach((f) => out.push(`  ${f.file}:${f.line}  ${f.ruleId}  ${f.message}`));
  }
  if (result.notCovered.length > 0) {
    out.push("", "Categories without an SCA check yet:");
    out.push("  " + result.notCovered.map((c) => `${c.category} (${c.expected})`).join(", "));
  }
  return out.join("\n") + "\n";
}
