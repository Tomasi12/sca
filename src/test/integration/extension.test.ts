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

  describe("analysis triggers", () => {
    let api: ScaApi;
    let tempUri: vscode.Uri;

    const analyzedOnce = (file: string, timeoutMs = 5000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`no analysis of ${path.basename(file)} within ${timeoutMs} ms`));
        }, timeoutMs);
        const off = api.onDidAnalyze((f) => {
          if (path.basename(f).toLowerCase() === path.basename(file).toLowerCase()) {
            clearTimeout(timer);
            off();
            resolve(f);
          }
        });
      });

    before(async () => {
      api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ScaApi;
      // A scratch file, so the samples are never changed by the test.
      tempUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "save_trigger_tmp.c");
      await vscode.workspace.fs.writeFile(tempUri, new TextEncoder().encode("int f(void) { return 0; }\n"));
    });

    after(async () => {
      await vscode.commands.executeCommand("sca.clearMonitor");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.workspace.fs.delete(tempUri);
    });

    it("registers sca.analyzeNow and analyzes every monitored file", async () => {
      await vscode.commands.executeCommand("sca.clearMonitor");
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.analyzeNow"), 0);
      await vscode.commands.executeCommand("sca.addToMonitor", tempUri);
      const seen = analyzedOnce(tempUri.fsPath);
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.analyzeNow"), 1);
      await seen;
    });

    it("analyzes a monitored file again when it is saved", async () => {
      await vscode.commands.executeCommand("sca.addToMonitor", tempUri);
      const doc = await vscode.workspace.openTextDocument(tempUri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), "/* edit */\n"));
      const seen = analyzedOnce(tempUri.fsPath);
      assert.ok(await doc.save(), "document did not save");
      await seen;
    });

    it("does not analyze a file that is not monitored", async () => {
      await vscode.commands.executeCommand("sca.clearMonitor");
      const doc = await vscode.workspace.openTextDocument(tempUri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), "/* edit 2 */\n"));
      await doc.save();
      await assert.rejects(analyzedOnce(tempUri.fsPath, 1000));
    });

    it("reports the division by zero in div_by_zero.c when it is monitored", async () => {
      const sample = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "div_by_zero.c");
      await vscode.commands.executeCommand("sca.addToMonitor", sample);
      const file = api.issueStore.files().find((f) => path.basename(f) === "div_by_zero.c");
      assert.ok(file, "sample not in the issue store");
      const findings = api.issueStore.findingsFor(file);
      assert.deepStrictEqual(
        findings.map((f) => [f.ruleId, f.certainty, f.range.start.line]),
        [["runtime-bugfinder:div-zero", "possible", 6]]
      );
      const diags = vscode.languages.getDiagnostics(sample).filter((d) => d.source === "SCA");
      assert.strictEqual(diags.length, 1);
      assert.strictEqual(diags[0].range.start.line, 5);
      await vscode.commands.executeCommand("sca.removeFromMonitor", sample);
    });

    it("reports switch-default and goto findings in coding_rules.c", async () => {
      const sample = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "coding_rules.c");
      await vscode.commands.executeCommand("sca.addToMonitor", sample);
      const file = api.issueStore.files().find((f) => path.basename(f) === "coding_rules.c")!;
      assert.deepStrictEqual(
        api.issueStore.findingsFor(file).map((f) => `${f.ruleId}@${f.range.start.line}`),
        ["sca-own:switch-default@9", "sca-own:switch-default@37", "sca-own:goto@53"]
      );
      await vscode.commands.executeCommand("sca.removeFromMonitor", sample);
    });

    it("loads the tree-sitter parser inside VS Code", () => {
      assert.ok(api.parser, "parser not loaded");
      const parsed = api.parser.parse("x.c", "int main(void) { return 0; }\n");
      try {
        assert.strictEqual(parsed.root.type, "translation_unit");
        assert.strictEqual(parsed.hasSyntaxErrors, false);
      } finally {
        parsed.dispose();
      }
    });
  });

  describe("project setup, baseline and reports", () => {
    let api: ScaApi;
    let folder: vscode.Uri;
    let sample: vscode.Uri;
    const rel = (name: string) => vscode.Uri.joinPath(folder, name);
    const sampleFile = () => api.issueStore.files().find((f) => path.basename(f) === "coding_rules.c")!;

    /** Waits until the condition holds (the extension reacts to file changes asynchronously). */
    async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) {
          throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    async function remove(uri: vscode.Uri): Promise<void> {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // not there
      }
    }

    before(async () => {
      api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ScaApi;
      folder = vscode.workspace.workspaceFolders![0].uri;
      sample = rel("coding_rules.c");
      await vscode.commands.executeCommand("sca.clearMonitor");
      await vscode.commands.executeCommand("sca.addToMonitor", sample);
      await until(() => api.issueStore.findingsFor(sampleFile()).length === 3, "3 findings in coding_rules.c");
    });

    after(async () => {
      await remove(rel(".sca.json"));
      await remove(rel(".sca-baseline.json"));
      await remove(rel("sca-report.csv"));
      await vscode.commands.executeCommand("sca.clearMonitor");
    });

    it("follows .sca.json: a rule set turned off disappears, and comes back", async () => {
      await vscode.workspace.fs.writeFile(rel(".sca.json"), new TextEncoder().encode('{ "rules": { "sca-own:goto": false } }'));
      await until(() => api.issueStore.findingsFor(sampleFile()).every((f) => f.ruleId !== "sca-own:goto"), "goto findings off");
      assert.strictEqual(api.issueStore.findingsFor(sampleFile()).length, 2);
      await remove(rel(".sca.json"));
      await until(() => api.issueStore.findingsFor(sampleFile()).length === 3, "goto findings back");
    });

    it("hides findings after Save Baseline and shows them again after Clear Baseline", async () => {
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.saveBaseline"), 3);
      await until(() => api.issueStore.findingsFor(sampleFile()).length === 0, "findings hidden by baseline");
      assert.strictEqual(api.issueStore.hiddenCount(), 3);
      assert.strictEqual(await vscode.commands.executeCommand<number>("sca.clearBaseline", true), 1);
      await until(() => api.issueStore.findingsFor(sampleFile()).length === 3, "findings back after clear");
      assert.strictEqual(api.issueStore.hiddenCount(), 0);
    });

    it("exports a CSV report", async () => {
      const target = rel("sca-report.csv").fsPath;
      const written = await vscode.commands.executeCommand<string>("sca.exportReport", { format: "csv", file: target });
      assert.strictEqual(written, target);
      const csv = new TextDecoder().decode(await vscode.workspace.fs.readFile(rel("sca-report.csv")));
      const lines = csv.trim().split(/\r?\n/);
      assert.strictEqual(lines[0], "file,line,column,rule,certainty,severity,status,message,justification");
      assert.ok(lines.some((l) => l.startsWith("coding_rules.c,53,") && l.includes("sca-own:goto")));
    });

    it("uses the same icon as the Problems panel (severity)", () => {
      const [f] = api.issueStore.findingsFor(sampleFile());
      assert.strictEqual(f.certainty, "definite");
      assert.strictEqual(f.severity, "warning");
      const diag = vscode.languages.getDiagnostics(sample).find((d) => d.source === "SCA")!;
      assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Warning);
    });
  });

  describe("value engine", () => {
    it("Show Control-Flow Graph describes the function at a line", async () => {
      const folder = vscode.workspace.workspaceFolders![0];
      const file = path.join(folder.uri.fsPath, "div_by_zero.c");
      const text = await vscode.commands.executeCommand<string>("sca.showCfg", { file, line: 6, open: false });
      assert.match(text ?? "", /^CFG of divide\(\)/);
      assert.match(text ?? "", /y = \[0, 2147483647\] \(0: parameter 'y' of divide\(\)\)/);
    });
  });
});
