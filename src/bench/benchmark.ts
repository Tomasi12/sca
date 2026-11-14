// Headless benchmark: runs every SCA check on a project and compares the findings with its answer key.
//
//   npm run benchmark -- <project-folder> [--key <csv>] [--json <file>] [--fail-on-fp]
//
// Defaults: answer key <project>/expected_findings.csv; sources = C/C++ files below <project>,
// skipping build, out, third_party, node_modules, .git and tools folders.
// Exit code: 0, or 1 with --fail-on-fp when a SAFE line was reported (for CI), 2 on bad arguments.

import * as fs from "fs";
import * as path from "path";
import { analyzeProject } from "../cli/analyze";
import { sourceFiles as projectSourceFiles } from "../cli/files";
import { CATEGORY_RULES } from "../core/checks";
import { BenchFinding, compare, formatReport, normalizePath, parseAnswerKey } from "./compare";

interface Args {
  project: string;
  key: string;
  json?: string;
  failOnFp: boolean;
}

function parseArgs(argv: string[]): Args {
  let project: string | undefined;
  let key: string | undefined;
  let json: string | undefined;
  let failOnFp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") {
      key = argv[++i];
    } else if (a === "--json") {
      json = argv[++i];
    } else if (a === "--fail-on-fp") {
      failOnFp = true;
    } else if (a === "-h" || a === "--help") {
      throw new UsageError("");
    } else if (a.startsWith("-")) {
      throw new UsageError(`Unknown option ${a}`);
    } else if (!project) {
      project = a;
    } else {
      throw new UsageError(`Unexpected argument ${a}`);
    }
  }
  if (!project) {
    throw new UsageError("Missing project folder.");
  }
  const root = path.resolve(project);
  return { project: root, key: path.resolve(key ?? path.join(root, "expected_findings.csv")), json, failOnFp };
}

class UsageError extends Error {}

/** C/C++ files of a project (build, third_party, ... skipped). */
export function sourceFiles(root: string): string[] {
  return projectSourceFiles(root);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) {
        console.error(err.message);
      }
      console.error("Usage: npm run benchmark -- <project-folder> [--key <csv>] [--json <file>] [--fail-on-fp]");
      return 2;
    }
    throw err;
  }
  if (!fs.existsSync(args.key)) {
    console.error(`Answer key not found: ${args.key}`);
    return 2;
  }

  // Same setup as the extension: .sca.json, compile database, headers. Justified findings count as reported.
  const run = await analyzeProject(args.project);
  for (const p of run.project.problems) {
    console.error(`warning: ${p}`);
  }
  const files = run.files;
  const ms = run.ms;
  const findings: BenchFinding[] = run.findings.map((f) => ({
    file: normalizePath(path.relative(args.project, f.file)),
    line: f.range.start.line,
    ruleId: f.ruleId,
    message: f.message,
  }));

  const expected = parseAnswerKey(fs.readFileSync(args.key, "utf8"));
  const result = compare(expected, findings, CATEGORY_RULES);
  process.stdout.write(formatReport(result, `SCA benchmark: ${path.basename(args.project)}`));
  const db = run.project.dbPath ? `compile database ${normalizePath(path.relative(args.project, run.project.dbPath))}` : "no compile database";
  console.log(`\n${files.length} files, ${findings.length} findings, ${ms} ms, ${db}.`);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ project: args.project, files: files.length, ms, ...result }, null, 2) + "\n");
    console.log(`JSON report: ${path.resolve(args.json)}`);
  }
  return args.failOnFp && result.totals.falsePositives > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    }
  );
}
