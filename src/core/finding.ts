// The Finding model: the one result type every SCA check produces.
// Pure logic (no VS Code API), so it can be unit-tested and reused by a CLI or benchmark.

/** How sure SCA is that the code is wrong. */
export type Certainty =
  /** The error happens on a path SCA can see. */
  | "definite"
  /** SCA cannot show the code is safe, e.g. a value comes from an unchecked input. */
  | "possible";

export type Severity = "error" | "warning" | "info";

/** "open" = needs attention; "justified" = accepted with a recorded reason (deviation). */
export type FindingStatus = "open" | "justified";

/** 1-based line and column, as people and reports count them. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** `start` is the first character; `end` is just after the last character (exclusive), like the editor. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Finding {
  /** Catalog rule ID, `<ruleSet>:<id>`, e.g. `runtime-bugfinder:div-zero`. */
  readonly ruleId: string;
  readonly message: string;
  /** Path of the analyzed file, as given to the analyzer. */
  readonly file: string;
  readonly range: Range;
  readonly certainty: Certainty;
  readonly severity: Severity;
  /** Which check engine produced it, e.g. `sca-native`. */
  readonly source: string;
  readonly status: FindingStatus;
  /** Reason when `status` is "justified". */
  readonly justification?: string;
}

export interface FindingInput {
  ruleId: string;
  message: string;
  file: string;
  range: Range;
  certainty: Certainty;
  severity?: Severity;
  source?: string;
  status?: FindingStatus;
  justification?: string;
}

const RULE_ID = /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRuleId(ruleId: string): boolean {
  return RULE_ID.test(ruleId);
}

/** Default severity: definite errors are errors, possible ones are warnings. */
export function defaultSeverity(certainty: Certainty): Severity {
  return certainty === "definite" ? "error" : "warning";
}

function checkPosition(p: Position, what: string): void {
  if (!Number.isInteger(p.line) || !Number.isInteger(p.column) || p.line < 1 || p.column < 1) {
    throw new Error(`Invalid ${what} position ${p.line}:${p.column} (1-based line and column expected).`);
  }
}

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.column - b.column;
}

/** Builds a validated Finding. Throws on a malformed rule ID, empty message/file or bad range. */
export function createFinding(input: FindingInput): Finding {
  if (!isValidRuleId(input.ruleId)) {
    throw new Error(`Invalid rule ID "${input.ruleId}" (expected "<ruleSet>:<id>").`);
  }
  if (input.message.trim() === "") {
    throw new Error("Finding message must not be empty.");
  }
  if (input.file.trim() === "") {
    throw new Error("Finding file must not be empty.");
  }
  checkPosition(input.range.start, "start");
  checkPosition(input.range.end, "end");
  if (comparePositions(input.range.start, input.range.end) > 0) {
    throw new Error("Finding range end is before its start.");
  }
  const status = input.status ?? "open";
  if (status === "justified" && !input.justification?.trim()) {
    throw new Error("A justified finding needs a justification.");
  }
  return {
    ruleId: input.ruleId,
    message: input.message,
    file: input.file,
    range: input.range,
    certainty: input.certainty,
    severity: input.severity ?? defaultSeverity(input.certainty),
    source: input.source ?? "sca-native",
    status,
    ...(input.justification !== undefined ? { justification: input.justification } : {}),
  };
}

/** Stable identity of a finding (file + start + rule), used to merge duplicates and track findings. */
export function findingKey(f: Finding): string {
  return `${f.file}:${f.range.start.line}:${f.range.start.column}:${f.ruleId}`;
}

/** Order for display and reports: file, then position, then rule ID. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    a.file.localeCompare(b.file) ||
    comparePositions(a.range.start, b.range.start) ||
    a.ruleId.localeCompare(b.ruleId)
  );
}

export interface FindingSummary {
  readonly definite: number;
  readonly possible: number;
  readonly justified: number;
  readonly total: number;
}

/** Counts for the Issue Monitor header and the status bar. Justified findings are counted apart. */
export function summarize(findings: readonly Finding[]): FindingSummary {
  let definite = 0;
  let possible = 0;
  let justified = 0;
  for (const f of findings) {
    if (f.status === "justified") {
      justified++;
    } else if (f.certainty === "definite") {
      definite++;
    } else {
      possible++;
    }
  }
  return { definite, possible, justified, total: findings.length };
}
