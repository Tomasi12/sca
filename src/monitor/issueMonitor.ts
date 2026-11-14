// VS Code wiring for the Issue Monitor: a tree view (file -> findings) and the editor diagnostics
// (squiggles + Problems panel). Both are fed from the same IssueStore.

import * as path from "path";
import * as vscode from "vscode";
import { Finding, FindingSummary, Severity } from "../core/finding";
import { IssueStore } from "../core/issueStore";

export const ISSUE_MONITOR_VIEW_ID = "sca.issueMonitor";

export type MonitorNode =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "finding"; readonly finding: Finding };

export function summaryText(s: FindingSummary): string {
  if (s.total === 0) {
    return "no issues";
  }
  const parts = [`${s.definite} definite`, `${s.possible} possible`];
  if (s.justified > 0) {
    parts.push(`${s.justified} justified`);
  }
  return parts.join(" · ");
}

/** Our 1-based, end-exclusive range -> VS Code's 0-based range. */
export function toVsRange(f: Finding): vscode.Range {
  return new vscode.Range(
    f.range.start.line - 1,
    f.range.start.column - 1,
    f.range.end.line - 1,
    f.range.end.column - 1
  );
}

function toVsSeverity(f: Finding): vscode.DiagnosticSeverity {
  if (f.status === "justified") {
    return vscode.DiagnosticSeverity.Hint;
  }
  const map: Record<Severity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  };
  return map[f.severity];
}

export function toDiagnostic(f: Finding): vscode.Diagnostic {
  const label = f.status === "justified" ? "justified" : f.certainty;
  const d = new vscode.Diagnostic(toVsRange(f), `${f.message} (${label})`, toVsSeverity(f));
  d.source = "SCA";
  d.code = f.ruleId;
  return d;
}

function findingIcon(f: Finding): vscode.ThemeIcon {
  if (f.status === "justified") {
    return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (f.certainty === "definite") {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
  }
  return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
}

export class IssueMonitorProvider implements vscode.TreeDataProvider<MonitorNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MonitorNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly unsubscribe: () => void;

  constructor(private readonly store: IssueStore) {
    this.unsubscribe = store.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: MonitorNode): MonitorNode[] {
    if (!node) {
      return this.store.files().map((file) => ({ kind: "file", file }));
    }
    if (node.kind === "file") {
      return this.store.findingsFor(node.file).map((finding) => ({ kind: "finding", finding }));
    }
    return [];
  }

  getTreeItem(node: MonitorNode): vscode.TreeItem {
    if (node.kind === "file") {
      const count = this.store.findingsFor(node.file).length;
      const item = new vscode.TreeItem(
        vscode.Uri.file(node.file),
        count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.description = summaryText(this.store.summary(node.file));
      item.tooltip = node.file;
      item.contextValue = "sca.monitoredFile";
      return item;
    }
    const f = node.finding;
    const item = new vscode.TreeItem(f.message, vscode.TreeItemCollapsibleState.None);
    item.description = `Ln ${f.range.start.line} · ${f.ruleId}`;
    item.iconPath = findingIcon(f);
    item.tooltip = new vscode.MarkdownString(
      `**${f.ruleId}** — ${f.status === "justified" ? "justified" : f.certainty}\n\n${f.message}` +
        (f.justification ? `\n\n_Justification:_ ${f.justification}` : "") +
        `\n\n${path.basename(f.file)}:${f.range.start.line}:${f.range.start.column} · ${f.source}`
    );
    item.contextValue = "sca.finding";
    item.command = {
      command: "vscode.open",
      title: "Go to finding",
      arguments: [vscode.Uri.file(f.file), { selection: toVsRange(f) } satisfies vscode.TextDocumentShowOptions],
    };
    return item;
  }

  dispose(): void {
    this.unsubscribe();
    this.changed.dispose();
  }
}

/** Creates the Issue Monitor view and keeps diagnostics in sync with the store. */
export function registerIssueMonitor(store: IssueStore, options: { checkCount: number }): vscode.Disposable {
  const provider = new IssueMonitorProvider(store);
  const view = vscode.window.createTreeView(ISSUE_MONITOR_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const diagnostics = vscode.languages.createDiagnosticCollection("sca");

  const updateHeader = () => {
    const hasFiles = store.files().length > 0;
    view.description = hasFiles ? summaryText(store.summary()) : undefined;
    view.message =
      hasFiles && options.checkCount === 0
        ? "No checks are active yet. Monitored files are listed, but nothing is checked."
        : undefined;
  };
  const unsubscribe = store.onDidChange((files) => {
    for (const file of files) {
      const uri = vscode.Uri.file(file);
      if (store.files().includes(file)) {
        diagnostics.set(uri, store.findingsFor(file).map(toDiagnostic));
      } else {
        diagnostics.delete(uri);
      }
    }
    updateHeader();
  });
  updateHeader();

  return vscode.Disposable.from(provider, view, diagnostics, { dispose: unsubscribe });
}
