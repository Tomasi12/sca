// Code metrics (HIS-style) with limits. Each metric is a rule `his-metrics:<name>`; a finding means the
// value is above (or, for comment density, below) its limit. Limits come from `.sca.json` "metrics"
// (keys as below; comment-density for commentDensity).
//
//   his-metrics:cyclomatic       decisions + 1 per function (if, loops, case, &&, ||, ?:)      limit 10
//   his-metrics:nesting          deepest nesting of control statements in a function            limit 4
//   his-metrics:statements       number of statements in a function                              limit 50
//   his-metrics:parameters       number of parameters                                            limit 5
//   his-metrics:returns          number of return points                                         limit 1
//   his-metrics:calls            number of different functions called                            limit 7
//   his-metrics:comment-density  comment lines / code lines of the file, at least                limit 0.2

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { functionName } from "../engine/cfg";
import { Finding, Range } from "../finding";
import { toPosition } from "../parser/parser";
import { functionsOf, nodesWithin, parameterNames, ruleFinding } from "./ruleKit";

export const METRIC_RULES = {
  cyclomatic: "his-metrics:cyclomatic",
  nesting: "his-metrics:nesting",
  statements: "his-metrics:statements",
  parameters: "his-metrics:parameters",
  returns: "his-metrics:returns",
  calls: "his-metrics:calls",
  commentDensity: "his-metrics:comment-density",
} as const;

export type MetricName = keyof typeof METRIC_RULES;

/** Default limits. A function metric is reported when its value is ABOVE the limit; comment density when BELOW. */
export const DEFAULT_METRIC_LIMITS: Readonly<Record<MetricName, number>> = {
  cyclomatic: 10,
  nesting: 4,
  statements: 50,
  parameters: 5,
  returns: 1,
  calls: 7,
  commentDensity: 0.2,
};

export interface FunctionMetrics {
  readonly name: string;
  readonly line: number;
  readonly cyclomatic: number;
  readonly nesting: number;
  readonly statements: number;
  readonly parameters: number;
  readonly returns: number;
  readonly calls: number;
}

export interface FileMetrics {
  readonly functions: FunctionMetrics[];
  readonly commentLines: number;
  readonly codeLines: number;
  /** commentLines / codeLines (1 when there is no code). */
  readonly commentDensity: number;
}

const DECISIONS = new Set(["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "conditional_expression", "catch_clause"]);
const NESTING = new Set(["if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement"]);
const STATEMENTS = new Set([
  "expression_statement", "return_statement", "break_statement", "continue_statement", "goto_statement", "declaration",
  "if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "throw_statement", "try_statement",
]);

const COUNTED = [...new Set([...DECISIONS, ...NESTING, ...STATEMENTS, "case_statement", "binary_expression", "call_expression"])];

/** Metrics of one function. Uses the file's node index, so no extra walk over the tree. */
export function functionMetrics(source: SourceContext, fn: Node): FunctionMetrics {
  let cyclomatic = 1;
  let statements = 0;
  let returns = 0;
  let nesting = 0;
  const callees = new Set<string>();
  const body = fn.childForFieldName("body");
  for (const n of body ? nodesWithin(source, body, ...COUNTED) : []) {
    const t = n.type;
    if (DECISIONS.has(t)) {
      cyclomatic++;
    } else if (t === "case_statement") {
      if (n.childForFieldName("value")) {
        cyclomatic++;
      }
    } else if (t === "binary_expression") {
      const op = n.childForFieldName("operator")?.type;
      if (op === "&&" || op === "||") {
        cyclomatic++;
      }
    } else if (t === "call_expression") {
      const f = n.childForFieldName("function");
      if (f) {
        callees.add(f.text);
      }
    }
    if (STATEMENTS.has(t) && !(t === "expression_statement" && n.namedChildCount === 0)) {
      statements++;
    }
    if (t === "return_statement") {
      returns++;
    }
    if (NESTING.has(t)) {
      nesting = Math.max(nesting, depthOf(n, fn));
    }
  }
  // A function that runs off its end has one more exit point without a return statement.
  const lastStmt = body?.namedChildren.filter((c) => c !== null && c.type !== "comment").pop();
  if (lastStmt?.type !== "return_statement") {
    returns++;
  }
  return {
    name: functionName(fn),
    line: fn.startPosition.row + 1,
    cyclomatic,
    nesting,
    statements,
    parameters: parameterNames(fn).length || countUnnamedParameters(fn),
    returns,
    calls: callees.size,
  };
}

/** Control statements around (and including) n inside fn. `else if` continues a level, it does not nest. */
function depthOf(n: Node, fn: Node): number {
  let d = 0;
  for (let p: Node | null = n; p && p.id !== fn.id; p = p.parent) {
    if (NESTING.has(p.type) && !(p.type === "if_statement" && p.parent?.type === "else_clause")) {
      d++;
    }
  }
  return d;
}

function countUnnamedParameters(fn: Node): number {
  let d: Node | null = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator");
  }
  const params = d?.childForFieldName("parameters")?.namedChildren ?? [];
  return params.filter((p) => p?.type === "parameter_declaration" && p.text.trim() !== "void").length;
}

/** Comment lines vs. code lines: a line counts as comment when a comment covers part of it. */
export function commentStats(text: string): { commentLines: number; codeLines: number } {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let commentLines = 0;
  let codeLines = 0;
  for (const raw of lines) {
    let line = raw;
    let hasComment = inBlock;
    let code = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end < 0) {
          i = line.length;
        } else {
          inBlock = false;
          i = end + 2;
        }
      } else if (line.startsWith("/*", i)) {
        inBlock = true;
        hasComment = true;
        i += 2;
      } else if (line.startsWith("//", i)) {
        hasComment = true;
        break;
      } else {
        code += line[i];
        i++;
      }
    }
    line = code.trim();
    if (hasComment) {
      commentLines++;
    }
    if (line !== "" && !/^#\s*(include|pragma)\b/.test(line) && line !== "{" && line !== "}") {
      codeLines++;
    }
  }
  return { commentLines, codeLines };
}

export function fileMetrics(source: SourceContext): FileMetrics {
  const { commentLines, codeLines } = commentStats(source.text);
  return {
    functions: functionsOf(source).map((fn) => functionMetrics(source, fn)),
    commentLines,
    codeLines,
    commentDensity: codeLines === 0 ? 1 : commentLines / codeLines,
  };
}

/** Limits for this file: defaults, overridden by `.sca.json` "metrics". */
export function metricLimits(source: SourceContext): Record<MetricName, number> {
  return { ...DEFAULT_METRIC_LIMITS, ...((source.config?.metrics ?? {}) as Partial<Record<MetricName, number>>) };
}

const LABELS: Record<Exclude<MetricName, "commentDensity">, string> = {
  cyclomatic: "cyclomatic complexity",
  nesting: "nesting depth",
  statements: "number of statements",
  parameters: "number of parameters",
  returns: "number of return points",
  calls: "number of called functions",
};

export function checkMetrics(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const limits = metricLimits(source);
  const out: Finding[] = [];
  for (const fn of functionsOf(source)) {
    const m = functionMetrics(source, fn);
    const at = nameRange(fn);
    for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
      if (m[key] > limits[key]) {
        out.push(ruleFinding(source, METRIC_RULES[key], at, `${m.name}(): ${LABELS[key]} is ${m[key]}, above the limit of ${limits[key]}.`, "info"));
      }
    }
  }
  const { commentLines, codeLines } = commentStats(source.text);
  const density = codeLines === 0 ? 1 : commentLines / codeLines;
  if (codeLines >= 20 && density < limits.commentDensity) {
    out.push(
      ruleFinding(
        source,
        METRIC_RULES.commentDensity,
        { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
        `Comment density is ${density.toFixed(2)} (${commentLines} comment lines for ${codeLines} code lines), below the limit of ${limits.commentDensity}.`,
        "info"
      )
    );
  }
  return out;
}

/** The function's name in its declarator, so the finding sits on the header line. */
function nameRange(fn: Node): Range {
  let d: Node | null = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator");
  }
  const id = d?.childForFieldName("declarator") ?? fn;
  return { start: toPosition(id.startPosition), end: toPosition(id.endPosition) };
}
