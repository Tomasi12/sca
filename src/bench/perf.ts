// Speed test: copies the C files of a template project many times into a temp folder and analyzes them all.
//
//   npm run perf -- [file-count=5000] [template-project=tests/samples] [--max-seconds <s>]
//
// Prints the time of a cold run (every file parsed) and of a warm run (unchanged files come from the cache).
// With --max-seconds the exit code is 1 when the cold run is slower (for CI).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sourceFiles } from "../cli/files";
import { Analyzer } from "../core/analyzer";
import { ALL_CHECKS } from "../core/checks";
import { SourceParser } from "../core/parser/parser";
import { Project } from "../core/project/project";

async function main(argv: string[]): Promise<number> {
  const maxIdx = argv.indexOf("--max-seconds");
  const maxSeconds = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : undefined;
  const rest = maxIdx >= 0 ? argv.filter((_, i) => i !== maxIdx && i !== maxIdx + 1) : argv;
  const count = Number(rest[0] ?? 5000);
  const template = path.resolve(rest[1] ?? path.join(__dirname, "..", "..", "tests", "samples"));
  const templates = sourceFiles(template).filter((f) => /\.(c|cpp|cc)$/i.test(f));
  if (!Number.isInteger(count) || count < 1 || templates.length === 0) {
    console.error("Usage: npm run perf -- [file-count] [template-project] [--max-seconds <s>]");
    return 2;
  }

  // Build the test project: headers copied once, sources copied round-robin.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sca-perf-"));
  try {
    for (const h of sourceFiles(template).filter((f) => /\.(h|hpp)$/i.test(f))) {
      const target = path.join(dir, path.relative(template, h));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(h, target);
    }
    const srcDir = path.join(dir, "gen");
    fs.mkdirSync(srcDir, { recursive: true });
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      const t = templates[i % templates.length];
      const text = fs.readFileSync(t, "utf8");
      bytes += text.length;
      fs.writeFileSync(path.join(srcDir, `f${String(i).padStart(5, "0")}_${path.basename(t)}`), text);
    }
    const files = sourceFiles(srcDir);
    const lines = Math.round((bytes / Math.max(1, templates.reduce((n, t) => n + fs.readFileSync(t, "utf8").length, 0))) * templates.reduce((n, t) => n + fs.readFileSync(t, "utf8").split("\n").length, 0));

    const parser = await SourceParser.create();
    const analyzer = new Analyzer(ALL_CHECKS, parser);
    const project = Project.load(dir);
    const runOnce = () => {
      const t0 = process.hrtime.bigint();
      let findings = 0;
      for (const f of files) {
        findings += analyzer.analyze(f, fs.readFileSync(f, "utf8"), project.contextFor(f)).length;
      }
      return { ms: Number(process.hrtime.bigint() - t0) / 1e6, findings };
    };
    const cold = runOnce();
    const warm = runOnce();
    parser.dispose();

    const fmt = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
    console.log(`SCA speed test: ${files.length} files (~${lines.toLocaleString("en")} lines) from ${path.basename(template)}`);
    console.log(`  cold run (parse + check): ${fmt(cold.ms)}  (${(cold.ms / files.length).toFixed(2)} ms/file, ${cold.findings} findings)`);
    console.log(`  warm run (cache):         ${fmt(warm.ms)}  (${(warm.ms / files.length).toFixed(3)} ms/file)`);
    if (maxSeconds !== undefined && cold.ms / 1000 > maxSeconds) {
      console.error(`Too slow: cold run ${fmt(cold.ms)} > ${maxSeconds} s.`);
      return 1;
    }
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
