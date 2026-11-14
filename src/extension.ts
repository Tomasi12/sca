import * as vscode from "vscode";
import { Analyzer } from "./core/analyzer";
import { ALL_CHECKS } from "./core/checks";
import { IssueStore } from "./core/issueStore";
import { SUPPORTED_LANGUAGES } from "./core/languages";
import { MonitorSet } from "./core/monitorSet";
import { SourceParser } from "./core/parser/parser";
import { registerExportReport } from "./monitor/exportReport";
import { registerIssueMonitor } from "./monitor/issueMonitor";
import { MonitorController, registerMonitorCommands } from "./monitor/monitorController";
import { ProjectManager } from "./monitor/projects";
import { registerShowCfg } from "./monitor/showCfg";
import { registerStatusBar } from "./monitor/statusBar";

/** What `activate` returns; used by integration tests (and later by other extensions). */
export interface ScaApi {
  readonly issueStore: IssueStore;
  readonly monitor: MonitorSet;
  /** The C/C++ parser, or undefined when its WASM files could not be loaded. */
  readonly parser: SourceParser | undefined;
  /** Fires after a monitored file was analyzed. Returns an unsubscribe function. */
  onDidAnalyze(listener: (file: string) => void): () => void;
  /** Project setup per workspace folder (.sca.json, compile database, baseline). */
  readonly projects: ProjectManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<ScaApi> {
  const output = vscode.window.createOutputChannel("SCA");
  output.appendLine("SCA activated.");

  const issueStore = new IssueStore();
  const parser = await loadParser(output);
  if (parser) {
    context.subscriptions.push({ dispose: () => parser.dispose() });
  }
  // Checks need the syntax tree; without the parser they are off.
  const analyzer = new Analyzer(parser ? ALL_CHECKS : [], parser);
  const projects = new ProjectManager(output);
  const controller = new MonitorController(context, issueStore, analyzer, output, projects);
  const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");

  context.subscriptions.push(
    output,
    projects,
    controller,
    registerIssueMonitor(issueStore, { checkCount: analyzer.checkCount }),
    registerMonitorCommands(controller),
    registerStatusBar(issueStore, controller.scheduler),
    registerExportReport(issueStore, version),
    registerShowCfg(analyzer, projects),
    vscode.commands.registerCommand("sca.showInfo", () => {
      const message = `SCA is active. Languages: ${SUPPORTED_LANGUAGES.join(", ")}.`;
      vscode.window.showInformationMessage(message);
      return message;
    })
  );

  // Restore the monitor saved for this workspace.
  void controller.refresh();

  return {
    issueStore,
    monitor: controller.monitor,
    parser,
    onDidAnalyze: (listener) => controller.onDidAnalyze(listener),
    projects,
  };
}

async function loadParser(output: vscode.OutputChannel): Promise<SourceParser | undefined> {
  try {
    const parser = await SourceParser.create();
    output.appendLine(`Parser loaded: ${parser.supportedLanguages.join(", ")} (tree-sitter).`);
    return parser;
  } catch (err) {
    output.appendLine(`Parser could not be loaded; checks that need a syntax tree are off. ${String(err)}`);
    return undefined;
  }
}

export function deactivate(): void {
  // Nothing to clean up yet; disposables are released via context.subscriptions.
}
