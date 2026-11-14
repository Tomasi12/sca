// Status bar item: "SCA: analyzing…" while checks run, "SCA: N issues" when done. A click opens the Issue Monitor.

import * as vscode from "vscode";
import { IssueStore } from "../core/issueStore";
import { AnalysisScheduler } from "../core/scheduler";

export function statusText(busy: boolean, monitoredFiles: number, openIssues: number): string {
  if (busy) {
    return "$(sync~spin) SCA: analyzing…";
  }
  if (monitoredFiles === 0) {
    return "$(shield) SCA";
  }
  return `$(shield) SCA: ${openIssues === 1 ? "1 issue" : `${openIssues} issues`}`;
}

export function registerStatusBar(store: IssueStore, scheduler: AnalysisScheduler): vscode.Disposable {
  const item = vscode.window.createStatusBarItem("sca.status", vscode.StatusBarAlignment.Left, 50);
  item.name = "SCA";
  item.command = "workbench.view.extension.sca";

  const update = () => {
    const files = store.files().length;
    const s = store.summary();
    const open = s.definite + s.possible;
    item.text = statusText(scheduler.busy, files, open);
    item.tooltip =
      files === 0
        ? "SCA: no files are monitored. Click to open the Issue Monitor."
        : `SCA: ${files} monitored file(s) · ${s.definite} definite · ${s.possible} possible · ${s.justified} justified. Click to open the Issue Monitor.`;
    item.show();
  };

  const offStore = store.onDidChange(update);
  const offBusy = scheduler.onDidChangeBusy(update);
  update();
  return vscode.Disposable.from(item, { dispose: offStore }, { dispose: offBusy });
}
