// Headless benchmark: runs every SCA check on a project and compares the findings with its answer key.
//
//   npm run benchmark -- <project-folder> [--key <csv>] [--json <file>] [--fail-on-fp]
//
// Defaults: answer key <project>/expected_findings.csv; sources = C/C++ files below <project>,
// skipping build, out, third_party, node_modules, .git and tools folders.
// Exit code: 0, or 1 with --fail-on-fp when a SAFE line was reported (for CI), 2 on bad arguments.

import * as fs from "fs";
import * as path from "path";
import { Analyzer } from "../core/analyzer";
import { ALL_CHECKS, CATEGORY_RULES } from "../core/checks";
import { isSourceFile } from "../core/languages";
import { SourceParser } from "../core/parser/parser";
import { BenchFinding, compare, formatReport, normalizePath, parseAnswerKey } from "./compare";

const SKIP_DIRS = new Set(["build", "out", "third_party", "node_modules", ".git", "tools", ".vscode", ".vscode-test"]);

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

export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) {
          visit(full);
        }
      } else if (isSourceFile(e.name)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
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

  const parser = await SourceParser.create();
  const analyzer = new Analyzer(ALL_CHECKS, parser);
  const started = Date.now();
  const files = sourceFiles(args.project);
  const findings: BenchFinding[] = [];
  for (const file of files) {
    const rel = normalizePath(path.relative(args.project, file));
    for (const f of analyzer.analyze(rel, fs.readFileSync(file, "utf8"))) {
      findings.push({ file: rel, line: f.range.start.line, ruleId: f.ruleId, message: f.message });
    }
  }
  parser.dispose();
  const ms = Date.now() - started;

  const expected = parseAnswerKey(fs.readFileSync(args.key, "utf8"));
  const result = compare(expected, findings, CATEGORY_RULES);
  process.stdout.write(formatReport(result, `SCA benchmark: ${path.basename(args.project)}`));
  console.log(`\n${files.length} files, ${findings.length} findings, ${analyzer.checkCount} checks, ${ms} ms.`);

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
