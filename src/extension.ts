import * as vscode from "vscode";
import { Analyzer } from "./core/analyzer";
import { IssueStore } from "./core/issueStore";
import { SUPPORTED_LANGUAGES } from "./core/languages";
import { MonitorSet } from "./core/monitorSet";
import { registerIssueMonitor } from "./monitor/issueMonitor";
import { MonitorController, registerMonitorCommands } from "./monitor/monitorController";

/** What `activate` returns; used by integration tests (and later by other extensions). */
export interface ScaApi {
  readonly issueStore: IssueStore;
  readonly monitor: MonitorSet;
}

export function activate(context: vscode.ExtensionContext): ScaApi {
  const output = vscode.window.createOutputChannel("SCA");
  output.appendLine("SCA activated.");

  const issueStore = new IssueStore();
  // No checks yet: they are added to this list as they are written.
  const analyzer = new Analyzer([]);
  const controller = new MonitorController(context, issueStore, analyzer, output);

  context.subscriptions.push(
    output,
    controller,
    registerIssueMonitor(issueStore, { checkCount: analyzer.checkCount }),
    registerMonitorCommands(controller),
    vscode.commands.registerCommand("sca.showInfo", () => {
      const message = `SCA is active. Languages: ${SUPPORTED_LANGUAGES.join(", ")}.`;
      vscode.window.showInformationMessage(message);
      return message;
    })
  );

  // Restore the monitor saved for this workspace.
  void controller.refresh();

  return { issueStore, monitor: controller.monitor };
}

export function deactivate(): void {
  // Nothing to clean up yet; disposables are released via context.subscriptions.
}
