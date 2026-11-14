// Report formats for findings: CSV, SARIF 2.1.0 (for CI and code-scanning tools) and a self-contained HTML page.
// Pure logic: callers write the returned text to a file.

import * as path from "path";
import { Finding, summarize } from "./finding";

export type ReportFormat = "csv" | "sarif" | "html";

export interface ReportInput {
  /** Project root; file paths in the report are relative to it. */
  root: string;
  findings: readonly Finding[];
  /** Number of files that were analyzed (also those without findings). */
  fileCount: number;
  toolVersion: string;
  /** Findings hidden by the baseline (only counted). */
  baselineHidden?: number;
  generatedAt?: Date;
}

export function relative(root: string, file: string): string {
  const rel = path.relative(root, file);
  return (rel.startsWith("..") || path.isAbsolute(rel) ? file : rel).replace(/\\/g, "/");
}

export function renderReport(format: ReportFormat, input: ReportInput): string {
  switch (format) {
    case "csv":
      return toCsv(input);
    case "sarif":
      return toSarif(input);
    case "html":
      return toHtml(input);
  }
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv({ root, findings }: ReportInput): string {
  const head = ["file", "line", "column", "rule", "certainty", "severity", "status", "message", "justification"];
  const rows = findings.map((f) =>
    [relative(root, f.file), f.range.start.line, f.range.start.column, f.ruleId, f.certainty, f.severity, f.status, f.message, f.justification ?? ""]
      .map(csvCell)
      .join(",")
  );
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

const SARIF_LEVEL = { error: "error", warning: "warning", info: "note" } as const;

export function toSarif({ root, findings, toolVersion }: ReportInput): string {
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))].sort();
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SCA",
            version: toolVersion,
            informationUri: "https://github.com/Tomasi12/sca",
            rules: ruleIds.map((id) => ({ id, name: id })),
          },
        },
        originalUriBaseIds: { SRCROOT: { uri: pathToFileUri(root) } },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: ruleIds.indexOf(f.ruleId),
          level: SARIF_LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodeURI(relative(root, f.file)), uriBaseId: "SRCROOT" },
                region: {
                  startLine: f.range.start.line,
                  startColumn: f.range.start.column,
                  endLine: f.range.end.line,
                  endColumn: f.range.end.column,
                },
              },
            },
          ],
          properties: { certainty: f.certainty },
          ...(f.status === "justified" ? { suppressions: [{ kind: "inSource", justification: f.justification ?? "" }] } : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + "\n";
}

function pathToFileUri(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return encodeURI(`file://${abs.startsWith("/") ? "" : "/"}${abs}${abs.endsWith("/") ? "" : "/"}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function toHtml({ root, findings, fileCount, toolVersion, baselineHidden = 0, generatedAt = new Date() }: ReportInput): string {
  const s = summarize(findings);
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const rel = relative(root, f.file);
    byFile.set(rel, [...(byFile.get(rel) ?? []), f]);
  }
  const sections = [...byFile.keys()]
    .sort()
    .map((file) => {
      const rows = byFile
        .get(file)!
        .map(
          (f) => `<tr class="${f.status === "justified" ? "just" : f.certainty}">
<td class="num">${f.range.start.line}:${f.range.start.column}</td>
<td><span class="pill ${f.status === "justified" ? "just" : f.certainty}">${f.status === "justified" ? "justified" : f.certainty}</span></td>
<td><code>${esc(f.ruleId)}</code></td>
<td>${esc(f.message)}${f.justification ? `<div class="why">Justification: ${esc(f.justification)}</div>` : ""}</td>
</tr>`
        )
        .join("\n");
      return `<h2>${esc(file)} <small>${byFile.get(file)!.length}</small></h2>
<table><thead><tr><th>Line</th><th>Certainty</th><th>Rule</th><th>Message</th></tr></thead><tbody>
${rows}
</tbody></table>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCA Report</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6573;--line:#d9dee5;--def:#c53030;--pos:#b7791f;--ok:#2f855a;--chip:#eef1f5}
@media (prefers-color-scheme: dark){:root{--bg:#121417;--fg:#e6e8eb;--muted:#9aa4b2;--line:#2e333a;--def:#f07a7a;--pos:#e5b45a;--ok:#6cc596;--chip:#22262c}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}h1{margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h2 small{color:var(--muted);font-weight:400}
.meta{color:var(--muted);margin-bottom:16px}.stats{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.stat{border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:120px}.stat b{display:block;font-size:26px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase}.num{white-space:nowrap;color:var(--muted)}code{background:var(--chip);padding:1px 5px;border-radius:4px}
.pill{font-size:12px;font-weight:700;padding:1px 7px;border-radius:6px;background:var(--chip)}.pill.definite{color:var(--def)}.pill.possible{color:var(--pos)}.pill.just{color:var(--ok)}
.why{color:var(--muted);font-size:13px;margin-top:2px}.wrap{overflow-x:auto}
</style></head>
<body><main>
<h1>SCA report</h1>
<div class="meta">${esc(root)} · ${fileCount} files analyzed · SCA ${esc(toolVersion)} · ${esc(generatedAt.toISOString().slice(0, 16).replace("T", " "))}</div>
<div class="stats">
<div class="stat"><b style="color:var(--def)">${s.definite}</b>definite</div>
<div class="stat"><b style="color:var(--pos)">${s.possible}</b>possible</div>
<div class="stat"><b style="color:var(--ok)">${s.justified}</b>justified</div>
${baselineHidden > 0 ? `<div class="stat"><b>${baselineHidden}</b>in baseline (not listed)</div>` : ""}
</div>
<div class="wrap">${sections || "<p>No findings.</p>"}</div>
</main></body></html>
`;
}
