// Rule help in the editor: a hover on SCA findings and the "SCA: Explain Rule" command, which opens the
// rule's page (description, why, fix, examples) as a Markdown preview. Texts come from src/core/rules.

import * as vscode from "vscode";
import { SUPPORTED_LANGUAGES } from "../core/languages";
import { explainRule, ruleHover } from "../core/rules/explain";
import { RULES } from "../core/rules/registry";
import type { MonitorNode } from "./issueMonitor";

export const RULE_SCHEME = "sca-rule";
export const EXPLAIN_COMMAND = "sca.explainRule";

/** sca-rule:/sca-own%3Afloat-equality.md -> the rule's page. */
export function ruleUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: RULE_SCHEME, path: `/${encodeURIComponent(id)}.md` });
}

function idFromUri(uri: vscode.Uri): string {
  return decodeURIComponent(uri.path.replace(/^\//, "").replace(/\.md$/, ""));
}

function diagnosticCode(d: vscode.Diagnostic): string | undefined {
  const c = d.code;
  return typeof c === "string" ? c : typeof c === "object" && c !== null ? String(c.value) : undefined;
}

/** SCA diagnostics at a position in a document. */
function scaDiagnosticsAt(uri: vscode.Uri, pos: vscode.Position): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === "SCA" && d.range.contains(pos));
}

/** Which rule to explain: an argument, a finding in the Issue Monitor, the finding at the cursor, or a pick. */
async function pickRule(arg: unknown): Promise<string | undefined> {
  if (typeof arg === "string") {
    return arg;
  }
  const node = arg as MonitorNode | undefined;
  if (node && typeof node === "object" && node.kind === "finding") {
    return node.finding.ruleId;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const at = scaDiagnosticsAt(editor.document.uri, editor.selection.active).map(diagnosticCode).find((c) => c !== undefined);
    if (at) {
      return at;
    }
  }
  const items = RULES.map((r) => ({ label: r.title, description: r.id, detail: r.summary, id: r.id }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Explain which SCA rule?", matchOnDescription: true, matchOnDetail: true });
  return picked?.id;
}

export function registerRuleHelp(): vscode.Disposable {
  const content = vscode.workspace.registerTextDocumentContentProvider(RULE_SCHEME, {
    provideTextDocumentContent: (uri) => explainRule(idFromUri(uri)),
  });

  const command = vscode.commands.registerCommand(EXPLAIN_COMMAND, async (arg?: unknown) => {
    const id = await pickRule(arg);
    if (!id) {
      return undefined;
    }
    const uri = ruleUri(id);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }
    return explainRule(id);
  });

  const hover = vscode.languages.registerHoverProvider(
    SUPPORTED_LANGUAGES.map((language) => ({ language })),
    {
      provideHover(doc, pos) {
        const ids = [...new Set(scaDiagnosticsAt(doc.uri, pos).map(diagnosticCode).filter((c): c is string => c !== undefined))];
        const parts = ids.map((id) => {
          const text = ruleHover(id);
          const link = `[Explain rule](command:${EXPLAIN_COMMAND}?${encodeURIComponent(JSON.stringify([id]))})`;
          return text ? `${text}\n\n${link}` : undefined;
        });
        const body = parts.filter((p): p is string => p !== undefined);
        if (body.length === 0) {
          return undefined;
        }
        const md = new vscode.MarkdownString(body.join("\n\n---\n\n"));
        md.isTrusted = { enabledCommands: [EXPLAIN_COMMAND] };
        return new vscode.Hover(md);
      },
    }
  );

  return vscode.Disposable.from(content, command, hover);
}
