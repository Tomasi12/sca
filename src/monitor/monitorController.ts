// VS Code wiring for "Add to Monitor" / "Remove from Monitor": keeps the monitored set (saved per workspace),
// expands monitored folders to their C/C++ files, analyzes them and puts the results into the issue store.

import * as path from "path";
import * as vscode from "vscode";
import { Analyzer } from "../core/analyzer";
import { IssueStore } from "../core/issueStore";
import { isSourceFile, SOURCE_GLOB } from "../core/languages";
import { canonicalPath, MonitorEntry, MonitorSet } from "../core/monitorSet";
import { MonitorNode } from "./issueMonitor";

const STATE_KEY = "sca.monitor";
/** Upper limit of files taken from one monitored folder, so a huge folder cannot freeze the editor. */
const MAX_FILES_PER_FOLDER = 5000;

export class MonitorController implements vscode.Disposable {
  readonly monitor: MonitorSet;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: IssueStore,
    private readonly analyzer: Analyzer,
    private readonly output: vscode.OutputChannel
  ) {
    this.monitor = MonitorSet.fromJSON(context.workspaceState.get(STATE_KEY));
    const off = this.monitor.onDidChange(() => {
      void context.workspaceState.update(STATE_KEY, this.monitor.toJSON());
      void vscode.commands.executeCommand("setContext", "sca.hasMonitoredEntries", this.monitor.list().length > 0);
    });
    this.disposables.push({ dispose: off });
    void vscode.commands.executeCommand("setContext", "sca.hasMonitoredEntries", this.monitor.list().length > 0);
  }

  /** Expands every monitored entry to its C/C++ files, drops stale results, analyzes what is new. */
  async refresh(): Promise<void> {
    const files = await this.monitoredFiles();
    const keep = new Set(files.map((f) => this.key(f)));
    for (const f of this.store.files()) {
      if (!keep.has(this.key(f))) {
        this.store.clearFile(f);
      }
    }
    const known = new Set(this.store.files().map((f) => this.key(f)));
    await this.analyzeFiles(files.filter((f) => !known.has(this.key(f))));
  }

  /** Adds files/folders; non-C/C++ files are skipped. Returns how many entries were added. */
  async add(uris: readonly vscode.Uri[]): Promise<number> {
    const entries: MonitorEntry[] = [];
    const skipped: string[] = [];
    for (const uri of uris) {
      const kind = await this.kindOf(uri);
      if (kind === "folder" || (kind === "file" && isSourceFile(uri.fsPath))) {
        entries.push({ path: uri.fsPath, kind });
      } else {
        skipped.push(path.basename(uri.fsPath));
      }
    }
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(`SCA monitors C/C++ files only. Skipped: ${skipped.join(", ")}`);
    }
    const added = this.monitor.add(entries);
    for (const e of added) {
      this.output.appendLine(`Monitor: added ${e.kind} ${e.path}`);
    }
    await this.refresh();
    return added.length;
  }

  /** Removes exact entries. A file monitored through a folder cannot be removed on its own. Returns how many were removed. */
  async remove(uris: readonly vscode.Uri[]): Promise<number> {
    const removed = this.monitor.remove(uris.map((u) => u.fsPath));
    for (const e of removed) {
      this.output.appendLine(`Monitor: removed ${e.kind} ${e.path}`);
    }
    const viaFolder = uris
      .map((u) => this.monitor.coveringEntry(u.fsPath))
      .filter((e): e is MonitorEntry => e?.kind === "folder");
    if (removed.length === 0 && viaFolder.length > 0) {
      void vscode.window.showInformationMessage(
        `This file is monitored through the folder "${path.basename(viaFolder[0].path)}". Remove that folder from the monitor instead.`
      );
    }
    await this.refresh();
    return removed.length;
  }

  async clear(): Promise<void> {
    this.monitor.clear();
    this.output.appendLine("Monitor: cleared");
    await this.refresh();
  }

  /** Analyzes the given files and stores the results (used now on add; later on save). */
  async analyzeFiles(files: readonly string[]): Promise<void> {
    for (const file of files) {
      const text = await this.readText(file);
      if (text !== undefined) {
        this.store.setFindings(file, this.analyzer.analyze(file, text));
      }
    }
  }

  private async monitoredFiles(): Promise<string[]> {
    const result = new Map<string, string>();
    for (const e of this.monitor.list()) {
      if (e.kind === "file") {
        if ((await this.kindOf(vscode.Uri.file(e.path))) === "file") {
          result.set(this.key(e.path), e.path);
        }
        continue;
      }
      const exclude = vscode.workspace.getConfiguration("sca").get<string[]>("monitor.exclude", []);
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(e.path), SOURCE_GLOB),
        exclude.length > 0 ? `{${exclude.join(",")}}` : undefined,
        MAX_FILES_PER_FOLDER
      );
      if (uris.length >= MAX_FILES_PER_FOLDER) {
        void vscode.window.showWarningMessage(
          `SCA: "${path.basename(e.path)}" has more than ${MAX_FILES_PER_FOLDER} C/C++ files; only the first ${MAX_FILES_PER_FOLDER} are monitored.`
        );
      }
      for (const u of uris) {
        const f = canonicalPath(u.fsPath);
        result.set(this.key(f), f);
      }
    }
    return [...result.values()];
  }

  private async readText(file: string): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => this.key(canonicalPath(d.uri.fsPath)) === this.key(file));
    if (open) {
      return open.getText();
    }
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
    } catch (err) {
      this.output.appendLine(`Monitor: cannot read ${file}: ${String(err)}`);
      return undefined;
    }
  }

  private async kindOf(uri: vscode.Uri): Promise<"file" | "folder" | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type & vscode.FileType.Directory ? "folder" : "file";
    } catch {
      return undefined;
    }
  }

  private key(p: string): string {
    return process.platform === "win32" ? canonicalPath(p).toLowerCase() : canonicalPath(p);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Turns the different ways VS Code calls a command into a list of URIs:
 * Explorer (clicked uri + selected uris), editor menus (uri), Issue Monitor items (node), command palette (nothing -> active editor).
 */
export function urisFromArgs(arg?: unknown, selection?: unknown): vscode.Uri[] {
  if (Array.isArray(selection) && selection.length > 0 && selection.every((u) => u instanceof vscode.Uri)) {
    return selection;
  }
  if (arg instanceof vscode.Uri) {
    return [arg];
  }
  if (Array.isArray(arg) && arg.every((u) => u instanceof vscode.Uri)) {
    return arg;
  }
  const node = arg as MonitorNode | undefined;
  if (node?.kind === "file") {
    return [vscode.Uri.file(node.file)];
  }
  if (node?.kind === "finding") {
    return [vscode.Uri.file(node.finding.file)];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active && active.scheme === "file" ? [active] : [];
}

export function registerMonitorCommands(controller: MonitorController): vscode.Disposable {
  const needTarget = () =>
    vscode.window.showInformationMessage("Open a C/C++ file, or right-click a file or folder in the Explorer, to use the monitor.");
  return vscode.Disposable.from(
    vscode.commands.registerCommand("sca.addToMonitor", async (arg?: unknown, selection?: unknown) => {
      const uris = urisFromArgs(arg, selection);
      if (uris.length === 0) {
        void needTarget();
        return 0;
      }
      return controller.add(uris);
    }),
    vscode.commands.registerCommand("sca.removeFromMonitor", async (arg?: unknown, selection?: unknown) => {
      const uris = urisFromArgs(arg, selection);
      if (uris.length === 0) {
        void needTarget();
        return 0;
      }
      return controller.remove(uris);
    }),
    vscode.commands.registerCommand("sca.clearMonitor", () => controller.clear())
  );
}
