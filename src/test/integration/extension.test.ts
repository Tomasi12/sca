import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { createFinding } from "../../core/finding";
import type { ScaApi } from "../../extension";

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

  it("contributes the Issue Monitor view in its own container", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
    assert.ok(pkg.contributes.viewsContainers.activitybar.some((c: { id: string }) => c.id === "sca"));
    assert.ok(pkg.contributes.views.sca.some((v: { id: string }) => v.id === "sca.issueMonitor"));
  });

  it("shows findings from the issue store as diagnostics, and clears them", async () => {
    const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ScaApi;
    const folder = vscode.workspace.workspaceFolders![0];
    const file = path.join(folder.uri.fsPath, "div_by_zero.c");
    const uri = vscode.Uri.file(file);

    api.issueStore.setFindings(file, [
      createFinding({
        ruleId: "runtime-bugfinder:div-zero",
        message: "Divisor y can be 0.",
        file,
        range: { start: { line: 6, column: 16 }, end: { line: 6, column: 21 } },
        certainty: "possible",
      }),
    ]);

    const diags = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "SCA");
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].code, "runtime-bugfinder:div-zero");
    assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(diags[0].range.start.line, 5); // 1-based line 6 -> 0-based 5
    assert.strictEqual(diags[0].range.start.character, 15);

    api.issueStore.clearFile(file);
    assert.strictEqual(vscode.languages.getDiagnostics(uri).filter((d) => d.source === "SCA").length, 0);
  });

  describe("monitor commands", () => {
    let api: ScaApi;
    let folderUri: vscode.Uri;
    let fileUri: vscode.Uri;
    const listed = () => api.issueStore.files().map((f) => path.basename(f));

    before(async () => {
      api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ScaApi;
      folderUri = vscode.workspace.workspaceFolders![0].uri;
      fileUri = vscode.Uri.joinPath(folderUri, "div_by_zero.c");
    });

    beforeEach(async () => {
      await vscode.commands.executeCommand("sca.clearMonitor");
    });

    after(async () => {
      await vscode.commands.executeCommand("sca.clearMonitor");
    });

    it("registers add / remove / clear commands", async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const c of ["sca.addToMonitor", "sca.removeFromMonitor", "sca.clearMonitor"]) {
        assert.ok(commands.includes(c), c);
      }
    });

    it("adds a file (Explorer / editor menu) and lists it in the Issue Monitor", async () => {
      const added = await vscode.commands.executeCommand<number>("sca.addToMonitor", fileUri);
      assert.strictEqual(added, 1);
      assert.ok(api.monitor.isMonitored(fileUri.fsPath));
      assert.deepStrictEqual(listed(), ["div_by_zero.c"]);
    });

    it("uses the Explorer multi-selection when given", async () => {
      const added = await vscode.commands.executeCommand<number>("sca.addToMonitor", fileUri, [fileUri, folderUri]);
      assert.strictEqual(added, 2);
    });

    it("adds a folder and expands it to its C/C++ files", async () => {
      await vscode.commands.executeCommand("sca.addToMonitor", folderUri);
      assert.strictEqual(api.monitor.coveringEntry(fileUri.fsPath)?.kind, "folder");
      assert.ok(listed().includes("div_by_zero.c"));
    });

    it("removes a file again and clears its entry", async () => {
      await vscode.commands.executeCommand("sca.addToMonitor", fileUri);
      const removed = await vscode.commands.executeCommand<number>("sca.removeFromMonitor", fileUri);
      assert.strictEqual(removed, 1);
      assert.strictEqual(api.monitor.isMonitored(fileUri.fsPath), false);
      assert.deepStrictEqual(listed(), []);
    });

    it("does not remove a file that is monitored through its folder", async () => {
      await vscode.commands.executeCommand("sca.addToMonitor", folderUri);
      const removed = await vscode.commands.executeCommand<number>("sca.removeFromMonitor", fileUri);
      assert.strictEqual(removed, 0);
      assert.ok(api.monitor.isMonitored(fileUri.fsPath));
    });

    it("removes from the Issue Monitor item (tree node argument)", async () => {
      await vscode.commands.executeCommand("sca.addToMonitor", fileUri);
      const node = { kind: "file", file: api.issueStore.files()[0] };
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.removeFromMonitor", node), 1);
    });

    it("uses the active editor when run from the command palette", async () => {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.addToMonitor"), 1);
      assert.ok(api.monitor.isMonitored(fileUri.fsPath));
    });
  });
});
