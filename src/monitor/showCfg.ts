// "SCA: Show Control-Flow Graph": opens the engine's view of the function under the cursor in a new editor.

import * as vscode from "vscode";
import { Analyzer } from "../core/analyzer";
import { ProjectManager } from "./projects";

export function registerShowCfg(analyzer: Analyzer, projects: ProjectManager): vscode.Disposable {
  return vscode.commands.registerCommand("sca.showCfg", async (args?: { file?: string; line?: number; open?: boolean }) => {
    const editor = vscode.window.activeTextEditor;
    const doc = args?.file ? await vscode.workspace.openTextDocument(args.file) : editor?.document;
    if (!doc || !/.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(doc.fileName)) {
      void vscode.window.showWarningMessage("SCA: open a C or C++ file and place the cursor inside a function.");
      return undefined;
    }
    const line = args?.line ?? (editor && editor.document === doc ? editor.selection.active.line + 1 : 1);
    const file = doc.uri.fsPath;
    const text = analyzer.describeFunction(file, doc.getText(), line, projects.projectFor(file)?.contextFor(file));
    if (!text) {
      void vscode.window.showWarningMessage("SCA: no function at the cursor (or the parser is not loaded).");
      return undefined;
    }
    if (args?.open !== false) {
      const out = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
      await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
    return text;
  });
}
