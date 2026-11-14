// One Project per workspace folder: its .sca.json, compile database and baseline.
// Reloads when one of those files changes, and when a header is saved (macros may change).

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Baseline, BASELINE_FILE, parseBaseline } from "../core/baseline";
import { CONFIG_FILE } from "../core/project/config";
import { Project } from "../core/project/project";

export class ProjectManager implements vscode.Disposable {
  private readonly projects = new Map<string, Project>();
  private readonly baselines = new Map<string, Baseline | undefined>();
  private readonly listeners = new Set<(root: string | undefined) => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly output: vscode.OutputChannel) {
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
