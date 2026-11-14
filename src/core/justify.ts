// Justifications: a reviewer marks a finding as checked and acceptable.
//
// In the code, on the line of the finding or on a comment line directly above it:
//     x = a / n;  /* sca-justify(runtime-bugfinder:div-zero): n is never 0, checked by the caller */
//     // sca-justify(sca-own:*): legacy module, rules waived until rewrite
// The rule can be a full rule ID, `<ruleSet>:*` or `*`. The reason must not be empty.
// The project config can do the same without touching the code ("deviations" in .sca.json).

import { rulePatternMatches } from "./project/config";

export interface Justification {
  /** 1-based line the justification applies to. */
  line: number;
  rule: string;
  reason: string;
}

const TAG = /sca-justify\(\s*([^)\s]+)\s*\)\s*:?\s*(.*?)\s*(?:\*\/|$)/;

/** Finds justification comments. A comment-only line applies to the next non-empty line. */
export function findJustifications(text: string): Justification[] {
  const lines = text.split(/\r?\n/);
  const out: Justification[] = [];
  lines.forEach((line, i) => {
    const at = line.indexOf("sca-justify(");
    if (at < 0) {
      return;
    }
    const m = TAG.exec(line.slice(at));
    if (!m || m[2].trim() === "") {
      return;
    }
    const before = line.slice(0, at);
    const commentOnly = /^\s*(\/\/|\/\*)\s*$/.test(before) || /^\s*\*\s*$/.test(before);
    let target = i + 1;
    if (commentOnly) {
      target = i + 2;
      while (target <= lines.length && lines[target - 1].trim() === "") {
        target++;
      }
    }
    out.push({ line: target, rule: m[1], reason: m[2].trim() });
  });
  return out;
}

/** The reason for a finding at `line` with `ruleId`, if any justification covers it. */
export function justificationFor(justifications: readonly Justification[], ruleId: string, line: number): string | undefined {
  return justifications.find((j) => j.line === line && rulePatternMatches(j.rule, ruleId))?.reason;
}
