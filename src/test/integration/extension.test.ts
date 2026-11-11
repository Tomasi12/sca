import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const EXTENSION_ID = "tomasi12.sca";

describe("SCA extension (integration)", () => {
  it("is installed in the test instance", () => {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID), "extension not found");
  });

  it("activates when a C file is opened", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test workspace not opened");

    const file = vscode.Uri.file(path.join(folder.uri.fsPath, "div_by_zero.c"));
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, "c");

    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    await ext.activate();
    assert.ok(ext.isActive, "extension did not activate");
  });

  it("registers the sca.showInfo command", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("sca.showInfo"));
  });

  it("runs the sca.showInfo command", async () => {
    const result = await vscode.commands.executeCommand<string>("sca.showInfo");
    assert.match(result ?? "", /SCA is active/);
  });
});
