// One Project per workspace folder: its .sca.json, compile database and baseline.
// Reloads when one of those files changes, and when a header is saved (macros may change).
// Each project gets an index over its source files (cross-file summaries); a saved, created or deleted source
// file starts a new index generation, so the facts from other files stay true.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { sourceFiles } from "../cli/files";
import { Analyzer } from "../core/analyzer";
import { Baseline, BASELINE_FILE, parseBaseline } from "../core/baseline";
import { isTranslationUnit } from "../core/languages";
import { CONFIG_FILE } from "../core/project/config";
import { Project } from "../core/project/project";

export class ProjectManager implements vscode.Disposable {
  private readonly projects = new Map<string, Project>();
  private readonly baselines = new Map<string, Baseline | undefined>();
  private readonly listeners = new Set<(root: string | undefined) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sources = new Map<string, string[]>();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly analyzer?: Analyzer
  ) {
    const watch = (glob: string, onChange: (uri: vscode.Uri) => void) => {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      this.disposables.push(w, w.onDidChange(onChange), w.onDidCreate(onChange), w.onDidDelete(onChange));
    };
    watch(`**/${CONFIG_FILE}`, (u) => this.reload(u));
    watch("**/compile_commands.json", (u) => this.reload(u));
    watch(`**/${BASELINE_FILE}`, (u) => this.reloadBaseline(u));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.reloadAll()));
  }

  /** The project of the workspace folder that contains the file, or undefined outside any folder. */
  projectFor(file: string): Project | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (!folder) {
      return undefined;
    }
    const root = folder.uri.fsPath;
    let p = this.projects.get(root);
    if (!p) {
      p = Project.load(root);
      this.projects.set(root, p);
      if (this.analyzer?.hasParser) {
        const project = p;
        this.analyzer.indexProject(project, () => this.sourcesOf(project));
      }
      const db = p.dbPath ? path.relative(root, p.dbPath) : "none";
      this.output.appendLine(`Project ${root}: config ${p.configPath ? CONFIG_FILE : "none"}, compile database ${db}.`);
      for (const problem of p.problems) {
        this.output.appendLine(`  problem: ${problem}`);
      }
      if (p.problems.length > 0) {
        void vscode.window.showWarningMessage(`SCA: problems in the project setup of "${folder.name}". See View → Output → SCA.`);
      }
    }
    return p;
  }

  /** All loaded projects (one per workspace folder that has monitored files). */
  all(): Project[] {
    return [...this.projects.values()];
  }

  baselineFor(project: Project): Baseline | undefined {
    if (!this.baselines.has(project.root)) {
      let b: Baseline | undefined;
      try {
        const text = fs.readFileSync(path.join(project.root, BASELINE_FILE), "utf8");
        b = parseBaseline(text);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.output.appendLine(`Baseline ${project.root}: ${String(err)}`);
        }
      }
      this.baselines.set(project.root, b);
    }
    return this.baselines.get(project.root);
  }

  /** C/C++ source files of the project (for the index), listed once and again after files were added or deleted. */
  private sourcesOf(p: Project): string[] {
    let list = this.sources.get(p.root);
    if (!list) {
      try {
        list = sourceFiles(p.root, p.config.exclude).filter(isTranslationUnit);
      } catch {
        list = [];
      }
      this.sources.set(p.root, list);
    }
    return list;
  }

  /** A source file was saved: what other files know from it is computed again (new index generation). */
  sourceChanged(file: string): void {
    this.projectFor(file)?.sourceChanged(file);
  }

  /** Source files were created, deleted or renamed: the file list and the index start again. */
  sourcesChanged(files: readonly string[]): void {
    for (const f of files) {
      const p = this.projectFor(f);
      if (p) {
        this.sources.delete(p.root);
        p.sourceChanged();
      }
    }
  }

  /** A header was saved: cached headers and cached results of that project are no longer valid. */
  headerChanged(file: string): void {
    const p = this.projectFor(file);
    if (p) {
      p.invalidateHeaders();
      this.emit(p.root);
    }
  }

  /** Fires with the folder whose setup changed (undefined: all). Returns an unsubscribe function. */
  onDidChange(listener: (root: string | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reload(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder && this.projects.delete(folder.uri.fsPath)) {
      this.sources.delete(folder.uri.fsPath);
      this.output.appendLine(`Project setup changed: ${uri.fsPath}`);
      this.emit(folder.uri.fsPath);
    }
  }

  private reloadBaseline(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      this.baselines.delete(folder.uri.fsPath);
      this.emit(folder.uri.fsPath);
    }
  }

  private reloadAll(): void {
    this.projects.clear();
    this.sources.clear();
    this.baselines.clear();
    this.emit(undefined);
  }

  private emit(root: string | undefined): void {
    for (const l of [...this.listeners]) {
      l(root);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.listeners.clear();
  }
}
