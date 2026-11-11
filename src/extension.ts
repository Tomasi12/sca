import * as vscode from "vscode";
import { SUPPORTED_LANGUAGES } from "./core/languages";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("SCA");
  output.appendLine("SCA activated.");

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("sca.showInfo", () => {
      const message = `SCA is active. Languages: ${SUPPORTED_LANGUAGES.join(", ")}.`;
      vscode.window.showInformationMessage(message);
      return message;
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up yet; disposables are released via context.subscriptions.
}
