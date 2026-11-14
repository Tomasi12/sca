// Headless analysis of a project folder (no VS Code), e.g. for CI:
//
//   npm run analyze -- <project-folder> [--format text|csv|sarif|html] [--out <file>] [--baseline] [--fail-on <definite|possible|any>]
//
// Uses the project's .sca.json and compile_commands.json like the extension does.
// Exit code: 0; 1 when --fail-on finds matching open findings; 2 on bad arguments.

import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../core/analyzer";
import { applyBaseline, BASELINE_FILE, parseBaseline } from "../core/baseline";
import { ALL_CHECKS } from "../core/checks";
import { Finding } from "../core/finding";
import { SourceParser } from "../core/parser/parser";
import { Project } from "../core/project/project";
import { relative, renderReport, ReportFormat } from "../core/report";
import { sourceFiles } from "./files";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = require("../../package.json").version;

export interface AnalyzeResult {
  project: Project;
  files: string[];
  findings: Finding[];
  baselineHidden: number;
  ms: number;
}

/** Analyzes every C/C++ file of a project (skipping build folders and the project's excludes). */
export async function analyzeProject(root: string, options: { baseline?: boolean } = {}): Promise<AnalyzeResult> {
  const project = Project.load(root);
  const parser = await SourceParser.create();
  const analyzer = new Analyzer(ALL_CHECKS, parser);
  const started = Date.now();
  const files = sourceFiles(root, project.config.exclude);
  const baseline = options.baseline ? parseBaseline(fs.readFileSync(path.join(root, BASELINE_FILE), "utf8")) : undefined;
  const findings: Finding[] = [];
  let baselineHidden = 0;
  try {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      let result = analyzer.analyze(file, text, project.contextFor(file));
      if (baseline) {
        const split = applyBaseline(result, text, project.relPath(file), baseline);
        result = split.shown;
        baselineHidden += split.hidden;
      }
      findings.push(...result);
    }
  } finally {
    parser.dispose();
  }
  return { project, files, findings, baselineHidden, ms: Date.now() - started };
}

function textReport(r: AnalyzeResult): string {
  const lines = r.findings.map(
    (f) => `${relative(r.project.root, f.file)}:${f.range.start.line}:${f.range.start.column}: ${f.status === "justified" ? "justified" : f.severity}: ${f.message} [${f.ruleId}]`
  );
  const open = r.findings.filter((f) => f.status !== "justified").length;
  lines.push(`${r.files.length} files, ${open} open findings, ${r.findings.length - open} justified${r.baselineHidden ? `, ${r.baselineHidden} in baseline` : ""}, ${r.ms} ms.`);
  return lines.join("\n") + "\n";
}

async function main(argv: string[]): Promise<number> {
  let root: string | undefined;
  let format: ReportFormat | "text" = "text";
  let out: string | undefined;
  let baseline = false;
  let failOn: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      format = argv[++i] as ReportFormat | "text";
    } else if (a === "--out") {
      out = argv[++i];
    } else if (a === "--baseline") {
      baseline = true;
    } else if (a === "--fail-on") {
      failOn = argv[++i];
    } else if (!a.startsWith("-") && !root) {
      root = a;
    } else {
      root = undefined;
      break;
    }
  }
  if (!root || !["text", "csv", "sarif", "html"].includes(format) || (failOn && !["definite", "possible", "any"].includes(failOn))) {
    console.error("Usage: npm run analyze -- <project-folder> [--format text|csv|sarif|html] [--out <file>] [--baseline] [--fail-on definite|possible|any]");
    return 2;
  }
  const abs = path.resolve(root);
  const r = await analyzeProject(abs, { baseline: baseline && fs.existsSync(path.join(abs, BASELINE_FILE)) });
  for (const p of r.project.problems) {
    console.error(`warning: ${p}`);
  }
  const text =
    format === "text"
      ? textReport(r)
      : renderReport(format, { root: abs, findings: r.findings, fileCount: r.files.length, toolVersion: VERSION, baselineHidden: r.baselineHidden });
  if (out) {
    fs.writeFileSync(out, text);
    console.log(`Wrote ${path.resolve(out)} (${r.findings.length} findings, ${r.files.length} files, ${r.ms} ms).`);
  } else {
    process.stdout.write(text);
  }
  const open = r.findings.filter((f) => f.status !== "justified");
  const failing = failOn === "any" ? open : failOn ? open.filter((f) => f.certainty === failOn || (failOn === "possible" && f.certainty === "definite")) : [];
  return failing.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    }
  );
}
