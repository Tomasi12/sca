// VS Code wiring for "Add to Monitor" / "Remove from Monitor": keeps the monitored set (saved per workspace),
// expands monitored folders to their C/C++ files, analyzes them and puts the results into the issue store.
// Monitored files are analyzed again on every save (autosave included), after a short wait.

import * as path from "path";
import * as vscode from "vscode";
import { Analyzer } from "../core/analyzer";
import { applyBaseline, BASELINE_FILE, baselineEntries, BaselineEntry, createBaseline } from "../core/baseline";
import { Finding } from "../core/finding";
import { IssueStore } from "../core/issueStore";
import { isSourceFile, SOURCE_GLOB } from "../core/languages";
import { canonicalPath, MonitorEntry, MonitorSet } from "../core/monitorSet";
import { AnalysisScheduler } from "../core/scheduler";
import { MonitorNode } from "./issueMonitor";
import { ProjectManager } from "./projects";

const STATE_KEY = "sca.monitor";
/** Upper limit of files taken from one monitored folder, so a huge folder cannot freeze the editor. */
const MAX_FILES_PER_FOLDER = 5000;
/** Default wait after a save before the analysis starts (autosave can save several times a second). */
export const DEFAULT_DEBOUNCE_MS = 300;

function analysisConfig() {
  const cfg = vscode.workspace.getConfiguration("sca");
  return {
    runOnSave: cfg.get<boolean>("analysis.runOnSave", true),
    baseline: cfg.get<boolean>("baseline.enabled", true),
    debounceMs: Math.max(0, cfg.get<number>("analysis.debounceMs", DEFAULT_DEBOUNCE_MS)),
  };
}

export class MonitorController implements vscode.Disposable {
  readonly monitor: MonitorSet;
  readonly scheduler: AnalysisScheduler;
  /** Keys of the files the monitor covers right now (folders expanded, excludes applied). */
  private tracked = new Set<string>();
  private readonly analyzedListeners = new Set<(file: string) => void>();
  /** Last analysis per file before the baseline filter: findings and the text they were found in. */
  private readonly raw = new Map<string, { findings: Finding[]; text: string }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: IssueStore,
    private readonly analyzer: Analyzer,
    private readonly output: vscode.OutputChannel,
    readonly projects: ProjectManager
  ) {
    this.monitor = MonitorSet.fromJSON(context.workspaceState.get(STATE_KEY));
    const off = this.monitor.onDidChange(() => {
      void context.workspaceState.update(STATE_KEY, this.monitor.toJSON());
      void vscode.commands.executeCommand("setContext", "sca.hasMonitoredEntries", this.monitor.list().length > 0);
    });
    this.disposables.push({ dispose: off });
    void vscode.commands.executeCommand("setContext", "sca.hasMonitoredEntries", this.monitor.list().length > 0);

    this.scheduler = new AnalysisScheduler((file, signal) => this.analyzeOne(file, signal), {
      delayMs: analysisConfig().debounceMs,
      key: (f) => this.key(f),
      onError: (file, err) => this.output.appendLine(`Analysis failed for ${file}: ${String(err)}`),
    });
    this.disposables.push(
      { dispose: () => this.scheduler.dispose() },
      // Fires for manual saves and for autosave alike.
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc)),
      vscode.workspace.onDidCreateFiles((e) => this.onFilesChanged(e.files)),
      vscode.workspace.onDidDeleteFiles((e) => this.onFilesChanged(e.files)),
      vscode.workspace.onDidRenameFiles((e) => this.onFilesChanged(e.files.flatMap((r) => [r.oldUri, r.newUri]))),
      { dispose: projects.onDidChange((root) => void this.projectChanged(root)) },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sca.analysis.debounceMs")) {
          this.scheduler.delayMs = analysisConfig().debounceMs;
        }
        if (e.affectsConfiguration("sca.baseline.enabled")) {
          void this.projectChanged(undefined);
        }
        if (e.affectsConfiguration("sca.monitor.exclude")) {
          void this.refresh();
        }
      })
    );
  }

  /** True when the file is covered by the monitor (and not excluded). */
  isTracked(file: string): boolean {
    return this.tracked.has(this.key(file));
  }

  /** Fires after a file was analyzed and its findings were stored. Returns an unsubscribe function. */
  onDidAnalyze(listener: (file: string) => void): () => void {
    this.analyzedListeners.add(listener);
    return () => this.analyzedListeners.delete(listener);
  }

  /** "SCA: Analyze now": re-reads the monitored set and analyzes every file at once. Returns the number of files. */
  async analyzeNow(): Promise<number> {
    const files = await this.monitoredFiles();
    this.applyTracked(files);
    await this.scheduler.runNow(files);
    return files.length;
  }

  /** Expands every monitored entry to its C/C++ files, drops stale results, analyzes what is new. */
  async refresh(): Promise<void> {
    const files = await this.monitoredFiles();
    this.applyTracked(files);
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

  /** Analyzes the given files at once and stores the results. */
  async analyzeFiles(files: readonly string[]): Promise<void> {
    await this.scheduler.runNow(files);
  }

  private applyTracked(files: readonly string[]): void {
    this.tracked = new Set(files.map((f) => this.key(f)));
    for (const f of this.store.files()) {
      if (!this.isTracked(f)) {
        this.scheduler.cancel(f);
        this.store.clearFile(f);
        this.raw.delete(this.key(f));
      }
    }
  }

  /** .sca.json, the compile database, the baseline or a header changed: check the affected files again. */
  private async projectChanged(root: string | undefined): Promise<void> {
    const files = await this.monitoredFiles();
    this.applyTracked(files);
    const inRoot = (f: string) => root === undefined || this.key(f).startsWith(this.key(root) + path.sep);
    for (const f of files.filter(inRoot)) {
      this.scheduler.schedule(f);
    }
  }

  /** "SCA: Save Baseline": records all current findings, so from now on only new ones are shown. */
  async saveBaseline(): Promise<number> {
    const byRoot = new Map<string, BaselineEntry[]>();
    for (const file of this.store.files()) {
      const project = this.projects.projectFor(file);
      const raw = this.raw.get(this.key(file));
      if (!project || !raw) {
        continue;
      }
      const list = byRoot.get(project.root) ?? [];
      list.push(...baselineEntries(raw.findings, raw.text, project.relPath(file)));
      byRoot.set(project.root, list);
    }
    let total = 0;
    for (const [root, entries] of byRoot) {
      const uri = vscode.Uri.file(path.join(root, BASELINE_FILE));
      const json = JSON.stringify(createBaseline(entries), null, 2) + "\n";
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
      this.output.appendLine(`Baseline saved: ${uri.fsPath} (${entries.length} findings)`);
      total += entries.length;
    }
    return total;
  }

  /** "SCA: Clear Baseline": deletes the baseline files (to the trash), so all findings are shown again. */
  async clearBaseline(): Promise<number> {
    let n = 0;
    for (const project of this.projects.all()) {
      const uri = vscode.Uri.file(path.join(project.root, BASELINE_FILE));
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        continue; // no baseline in this folder
      }
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        // No trash on this system (e.g. some Linux setups): the baseline can be saved again at any time.
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      }
      n++;
    }
    return n;
  }

  private async analyzeOne(file: string, signal: AbortSignal): Promise<void> {
    const text = await this.readText(file);
    // Skip when a newer run took over, or the file left the monitor while we were reading it.
    if (text === undefined || signal.aborted || !this.isTracked(file)) {
      return;
    }
    const project = this.projects.projectFor(file);
    const findings = this.analyzer.analyze(file, text, project?.contextFor(file));
    if (signal.aborted || !this.isTracked(file)) {
      return;
    }
    this.raw.set(this.key(file), { findings, text });
    const baseline = project && analysisConfig().baseline ? this.projects.baselineFor(project) : undefined;
    if (project && baseline) {
      const { shown, hidden } = applyBaseline(findings, text, project.relPath(file), baseline);
      this.store.setFindings(file, shown, hidden);
    } else {
      this.store.setFindings(file, findings);
    }
    for (const l of [...this.analyzedListeners]) {
      l(file);
    }
  }

  private onSaved(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file" || !analysisConfig().runOnSave) {
      return;
    }
    const file = canonicalPath(doc.uri.fsPath);
    // A saved header can change macros and #if branches of every file that includes it.
    if (/.(h|hh|hpp|hxx)$/i.test(file) && this.tracked.size > 0) {
      this.projects.headerChanged(file);
    }
    if (this.isTracked(file)) {
      this.scheduler.schedule(file);
    }
  }

  /** A C/C++ file was created, deleted or renamed: the expanded file list of a monitored folder may change. */
  private onFilesChanged(uris: readonly vscode.Uri[]): void {
    if (uris.some((u) => this.monitor.isMonitored(u.fsPath) && (isSourceFile(u.fsPath) || this.isTracked(u.fsPath)))) {
      void this.refresh();
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
      const exclude = [
        ...vscode.workspace.getConfiguration("sca").get<string[]>("monitor.exclude", []),
        ...(this.projects.projectFor(e.path)?.config.exclude ?? []),
      ];
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
    vscode.commands.registerCommand("sca.clearMonitor", () => controller.clear()),
    vscode.commands.registerCommand("sca.analyzeNow", async () => {
      const n = await controller.analyzeNow();
      if (n === 0) {
        void vscode.window.showInformationMessage("SCA: nothing to analyze. Add files or folders to the monitor first.");
      }
      return n;
    }),
    vscode.commands.registerCommand("sca.saveBaseline", async () => {
      const n = await controller.saveBaseline();
      void vscode.window.showInformationMessage(
        n > 0
          ? `SCA: baseline saved with ${n} finding(s). From now on only new findings are shown.`
          : "SCA: no open findings, nothing to put in a baseline."
      );
      return n;
    }),
    // `skipConfirm` is for automation and tests; from the UI the user always confirms.
    vscode.commands.registerCommand("sca.clearBaseline", async (skipConfirm?: unknown) => {
      if (skipConfirm !== true) {
        const ok = await vscode.window.showWarningMessage(
          `Delete ${BASELINE_FILE}? All findings will be shown again. The file goes to the trash.`,
          { modal: true },
          "Delete Baseline"
        );
        if (ok !== "Delete Baseline") {
          return 0;
        }
      }
      return controller.clearBaseline();
    })
  );
}
