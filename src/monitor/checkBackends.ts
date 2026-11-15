// "SCA: Check Backends": shows which external tools are installed, their versions, and whether the
// project's .sca.json turns them on.

import * as vscode from "vscode";
import { BackendHealth, checkBackends } from "../core/backends/run";
import { ProjectManager } from "./projects";

export function healthText(list: readonly BackendHealth[]): string {
  return list
    .map((h) => `${h.backend}: ${h.version ?? `not available (${h.problem ?? "unknown"})`}${h.enabled ? " · on in .sca.json" : " · off"}${h.command !== h.backend ? ` · ${h.command}` : ""}`)
    .join("\n");
}

export function registerCheckBackends(projects: ProjectManager, output: vscode.OutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand("sca.checkBackends", async () => {
    const editor = vscode.window.activeTextEditor;
    const project = (editor && projects.projectFor(editor.document.uri.fsPath)) ?? projects.all()[0];
    const list = await checkBackends(project?.config);
    const text = healthText(list);
    output.appendLine(`Backends:\n${text}`);
    const missing = list.filter((h) => h.enabled && !h.version);
    const show = missing.length > 0 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`SCA backends: ${list.map((h) => `${h.backend} ${h.version ? "found" : "missing"}${h.enabled ? " (on)" : ""}`).join(", ")}. Details in the SCA output.`);
    return list;
  });
}
