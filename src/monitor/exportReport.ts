// "SCA: Export Report": writes the findings of all monitored files as HTML, CSV or SARIF.

import * as path from "path";
import * as vscode from "vscode";
import { IssueStore } from "../core/issueStore";
import { renderReport, ReportFormat } from "../core/report";

const FORMATS: { format: ReportFormat; label: string; detail: string }[] = [
  { format: "html", label: "HTML", detail: "A page to read or share" },
  { format: "csv", label: "CSV", detail: "For spreadsheets" },
  { format: "sarif", label: "SARIF", detail: "Standard format for CI and code-scanning tools" },
];

/** Arguments for automation and tests; without them the user picks the format and the file. */
export interface ExportArgs {
  format?: ReportFormat;
  file?: string;
}

export function registerExportReport(store: IssueStore, version: string): vscode.Disposable {
  return vscode.commands.registerCommand("sca.exportReport", async (args?: ExportArgs) => {
    if (store.files().length === 0) {
      void vscode.window.showInformationMessage("SCA: nothing to export. Add files or folders to the monitor first.");
      return undefined;
    }
    const format =
      args?.format ??
      (await vscode.window.showQuickPick(
        FORMATS.map((f) => ({ ...f, description: f.detail })),
        { title: "SCA: report format" }
      ))?.format;
    if (!format) {
      return undefined;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(store.files()[0]);
    let target = args?.file ? vscode.Uri.file(args.file) : undefined;
    if (!target) {
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(root, `sca-report.${format}`)),
        filters: { [format.toUpperCase()]: [format] },
        title: "SCA: save report",
      });
    }
    if (!target) {
      return undefined;
    }
    const text = renderReport(format, {
      root,
      findings: store.allFindings(),
      fileCount: store.files().length,
      toolVersion: version,
      baselineHidden: store.hiddenCount(),
    });
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    if (!args?.file) {
      const open = await vscode.window.showInformationMessage(`SCA: report saved to ${target.fsPath}`, "Open");
      if (open) {
        await vscode.commands.executeCommand("vscode.open", target);
      }
    }
    return target.fsPath;
  });
}
