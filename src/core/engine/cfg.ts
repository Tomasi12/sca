// Control-flow graph of one C function, built from the tree-sitter syntax tree.
//
// A block holds straight-line items (expression statements, declarations, returns). Edges may carry an
// assumption: "this condition was true/false" or "the switch value matched this case". Conditions with
// && / || / ?: stay whole on the edge; the interpreter splits them while it evaluates.
//
// The first round of a while/for loop is built twice ("peeled"): once for the first round, once for the
// loop proper. That keeps facts like "the loop ran at least once" apart from "the loop never ran"
// without a relational domain. Loops containing labels or case labels are not peeled.

import { Node } from "web-tree-sitter";

export type Assume =
  | { readonly kind: "cond"; readonly node: Node; readonly truth: boolean }
  | { readonly kind: "case"; readonly subject: Node; readonly value: Node }
  | { readonly kind: "default"; readonly subject: Node; readonly values: readonly Node[] };

export type Item =
  | { readonly kind: "stmt"; readonly node: Node }
  | { readonly kind: "return"; readonly node: Node; readonly value?: Node };

export interface Edge {
  readonly to: number;
  readonly assume?: Assume;
}

export interface Block {
  readonly id: number;
  readonly items: Item[];
  readonly succ: Edge[];
  label?: string;
}

export interface Cfg {
  readonly fn: Node;
  readonly name: string;
  readonly blocks: readonly Block[];
  readonly entry: number;
  readonly exit: number;
  /** Blocks where loops close (loop heads, do-loop bodies, goto labels): the solver widens only there. */
  readonly loopHeads: ReadonlySet<number>;
  /** Set when the function uses a construct the graph cannot model; checks then skip the function. */
  readonly unsupported?: string;
}

const MAX_PEEL_DEPTH = 2;

class Unsupported extends Error {}

/** The function's name from its declarator (`static u32 f(...)` -> "f"), or "" for an anonymous one. */
export function functionName(fn: Node): string {
  let d = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator");
  }
  return d?.childForFieldName("declarator")?.text ?? "";
}

export function buildCfg(fn: Node): Cfg {
  const b = new Builder();
  const name = functionName(fn);
  const body = fn.childForFieldName("body");
  try {
    if (!body) {
      throw new Unsupported("no body");
    }
    b.statement(body);
    b.edge(b.cur, b.exitId);
    b.resolveGotos();
  } catch (e) {
    if (e instanceof Unsupported) {
      return { fn, name, blocks: b.blocks, entry: 0, exit: b.exitId, loopHeads: b.loopHeads, unsupported: e.message };
    }
    throw e;
  }
  return { fn, name, blocks: b.blocks, entry: 0, exit: b.exitId, loopHeads: b.loopHeads };
}

class Builder {
  readonly blocks: Block[] = [];
  readonly exitId: number;
  readonly loopHeads = new Set<number>();
  cur: number;
  private readonly breaks: number[] = [];
  private readonly continues: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly gotos: { from: number; label: string }[] = [];
  private loopDepth = 0;

  constructor() {
    this.cur = this.block("entry");
    this.exitId = this.block("exit");
  }

  block(label?: string): number {
    const id = this.blocks.length;
    this.blocks.push({ id, items: [], succ: [], label });
    return id;
  }

  edge(from: number, to: number, assume?: Assume): void {
    this.blocks[from].succ.push({ to, assume });
  }

  /** Ends the current block with a jump: what follows is unreachable until a label. */
  private jump(to: number): void {
    this.edge(this.cur, to);
    this.cur = this.block("unreachable");
  }

  resolveGotos(): void {
    for (const g of this.gotos) {
      const to = this.labels.get(g.label);
      if (to === undefined) {
        throw new Unsupported(`goto to unknown label ${g.label}`);
      }
      this.edge(g.from, to);
    }
  }

  private labelBlock(name: string): number {
    let id = this.labels.get(name);
    if (id === undefined) {
      id = this.block(`label ${name}`);
      this.labels.set(name, id);
      this.loopHeads.add(id);
    }
    return id;
  }

  statement(node: Node): void {
    switch (node.type) {
      case "compound_statement":
        for (const c of node.namedChildren) {
          if (c) {
            this.statement(c);
          }
        }
        return;
      case "comment":
      case "type_definition":
      case "preproc_def":
      case "preproc_function_def":
      case "preproc_call":
      case "preproc_include":
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier":
        return;
      case "expression_statement":
        if (node.namedChildren.some((c) => c !== null && c.type !== "comment")) {
          this.blocks[this.cur].items.push({ kind: "stmt", node });
        }
        return;
      case "declaration":
        this.blocks[this.cur].items.push({ kind: "stmt", node });
        return;
      case "return_statement": {
        const value = node.namedChildren.find((c) => c !== null && c.type !== "comment") ?? undefined;
        this.blocks[this.cur].items.push({ kind: "return", node, value });
        this.jump(this.exitId);
        return;
      }
      case "throw_statement":
        this.blocks[this.cur].items.push({ kind: "stmt", node });
        this.jump(this.exitId);
        return;
      case "break_statement":
        if (this.breaks.length === 0) {
          throw new Unsupported("break outside a loop or switch");
        }
        this.jump(this.breaks[this.breaks.length - 1]);
        return;
      case "continue_statement":
        if (this.continues.length === 0) {
          throw new Unsupported("continue outside a loop");
        }
        this.jump(this.continues[this.continues.length - 1]);
        return;
      case "goto_statement": {
        const label = node.childForFieldName("label")?.text ?? "";
        this.gotos.push({ from: this.cur, label });
        this.cur = this.block("unreachable");
        return;
      }
      case "labeled_statement": {
        const target = this.labelBlock(node.childForFieldName("label")?.text ?? "");
        this.edge(this.cur, target);
        this.cur = target;
        for (const c of node.namedChildren) {
          if (c && c.type !== "statement_identifier") {
            this.statement(c);
          }
        }
        return;
      }
      case "if_statement":
        this.ifStatement(node);
        return;
      case "while_statement":
        this.whileStatement(node);
        return;
      case "do_statement":
        this.doStatement(node);
        return;
      case "for_statement":
        this.forStatement(node);
        return;
      case "switch_statement":
        this.switchStatement(node);
        return;
      case "preproc_if":
      case "preproc_ifdef":
      case "preproc_elif":
      case "preproc_elifdef":
      case "preproc_else":
        this.preprocBranch(node);
        return;
      case "attributed_statement": {
        const inner = node.namedChildren.find((c) => c !== null && c.type !== "attribute_declaration");
        if (inner) {
          this.statement(inner);
        }
        return;
      }
      default:
        throw new Unsupported(`statement ${node.type}`);
    }
  }

  private ifStatement(node: Node): void {
    const cond = node.childForFieldName("condition");
    const then = node.childForFieldName("consequence");
    const alt = node.childForFieldName("alternative");
    if (!cond || !then) {
      throw new Unsupported("incomplete if");
    }
    if (cond.type === "condition_clause" && cond.childForFieldName("initializer")) {
      throw new Unsupported("if with initializer");
    }
    const from = this.cur;
    const after = this.block();
    const thenB = this.block();
    this.edge(from, thenB, { kind: "cond", node: cond, truth: true });
    this.cur = thenB;
    this.statement(then);
    this.edge(this.cur, after);
    if (alt) {
      const elseB = this.block();
      this.edge(from, elseB, { kind: "cond", node: cond, truth: false });
      this.cur = elseB;
      const inner = alt.type === "else_clause" ? alt.namedChildren.find((c) => c !== null && c.type !== "comment") : alt;
      if (inner) {
        this.statement(inner);
      }
      this.edge(this.cur, after);
    } else {
      this.edge(from, after, { kind: "cond", node: cond, truth: false });
    }
    this.cur = after;
  }

  /** while (cond) body, also used for for-loops (with `update` run before each re-test). */
  private loop(cond: Node | null, body: Node, update: readonly Node[]): void {
    const after = this.block("loop exit");
    const peel = this.loopDepth < MAX_PEEL_DEPTH && !hasLabels(body);
    this.loopDepth++;
    if (peel) {
      // First round: the condition is tested once on entry.
      const firstBody = this.block("first round");
      const firstNext = this.block();
      this.test(this.cur, cond, firstBody, after);
      this.cur = firstBody;
      this.inLoop(after, firstNext, body);
      this.edge(this.cur, firstNext);
      this.cur = firstNext;
      this.updates(update);
    }
    const head = this.block("loop head");
    this.loopHeads.add(head);
    this.edge(this.cur, head);
    const bodyB = this.block("loop body");
    const next = this.block();
    this.test(head, cond, bodyB, after);
    this.cur = bodyB;
    this.inLoop(after, next, body);
    this.edge(this.cur, next);
    this.cur = next;
    this.updates(update);
    this.edge(this.cur, head);
    this.loopDepth--;
    this.cur = after;
  }

  private test(from: number, cond: Node | null, yes: number, no: number): void {
    if (!cond) {
      this.edge(from, yes); // for (;;)
      return;
    }
    this.edge(from, yes, { kind: "cond", node: cond, truth: true });
    this.edge(from, no, { kind: "cond", node: cond, truth: false });
  }

  private inLoop(brk: number, cont: number, body: Node): void {
    this.breaks.push(brk);
    this.continues.push(cont);
    this.statement(body);
    this.breaks.pop();
    this.continues.pop();
  }

  private updates(update: readonly Node[]): void {
    for (const u of update) {
      this.blocks[this.cur].items.push({ kind: "stmt", node: u });
    }
  }

  private whileStatement(node: Node): void {
    const body = node.childForFieldName("body");
    if (!body) {
      throw new Unsupported("while without body");
    }
    const cond = node.childForFieldName("condition");
    if (cond?.type === "condition_clause" && cond.childForFieldName("value")?.type === "declaration") {
      throw new Unsupported("while with declaration");
    }
    this.loop(cond, body, []);
  }

  private forStatement(node: Node): void {
    const body = node.childForFieldName("body");
    if (!body) {
      throw new Unsupported("for without body");
    }
    const init = node.childForFieldName("initializer");
    if (init) {
      this.blocks[this.cur].items.push({ kind: "stmt", node: init });
    }
    const update = node.childrenForFieldName("update").filter((u): u is Node => u !== null);
    this.loop(node.childForFieldName("condition"), body, update);
  }

  private doStatement(node: Node): void {
    const body = node.childForFieldName("body");
    const cond = node.childForFieldName("condition");
    if (!body || !cond) {
      throw new Unsupported("incomplete do");
    }
    const bodyB = this.block("do body");
    this.loopHeads.add(bodyB);
    const test = this.block("do test");
    const after = this.block("loop exit");
    this.edge(this.cur, bodyB);
    this.cur = bodyB;
    this.loopDepth++;
    this.inLoop(after, test, body);
    this.loopDepth--;
    this.edge(this.cur, test);
    this.test(test, cond, bodyB, after);
    this.cur = after;
  }

  private switchStatement(node: Node): void {
    const subject = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    if (!subject || !body) {
      throw new Unsupported("incomplete switch");
    }
    const from = this.cur;
    const after = this.block("switch exit");
    const values: Node[] = [];
    let hasDefault = false;
    this.cur = this.block("unreachable");
    this.breaks.push(after);
    for (const c of body.namedChildren) {
      if (!c) {
        continue;
      }
      if (c.type !== "case_statement") {
        this.statement(c); // code before the first case: unreachable
        continue;
      }
      const caseB = this.block(c.text.startsWith("default") ? "default" : "case");
      this.edge(this.cur, caseB); // fall-through from the case before
      const value = c.childForFieldName("value");
      if (value) {
        values.push(value);
        this.edge(from, caseB, { kind: "case", subject, value });
      } else {
        hasDefault = true;
        this.edge(from, caseB, { kind: "default", subject, values });
      }
      this.cur = caseB;
      for (const s of c.namedChildren) {
        if (s && s.id !== value?.id) {
          if (s.type === "case_statement") {
            throw new Unsupported("nested case label");
          }
          this.statement(s);
        }
      }
    }
    this.breaks.pop();
    if (!hasDefault) {
      this.edge(from, after, { kind: "default", subject, values });
    }
    this.edge(this.cur, after);
    this.cur = after;
  }

  /** #if / #ifdef inside a function: the preprocessor left only the active lines, or both when unknown. */
  private preprocBranch(node: Node): void {
    const skip = new Set(["condition", "name", "alternative"].map((f) => node.childForFieldName(f)?.id).filter((x) => x !== undefined));
    const alt = node.childForFieldName("alternative");
    const from = this.cur;
    const after = this.block();
    const thenB = this.block();
    this.edge(from, thenB);
    this.cur = thenB;
    for (const c of node.namedChildren) {
      if (c && !skip.has(c.id)) {
        this.statement(c);
      }
    }
    this.edge(this.cur, after);
    const elseB = this.block();
    this.edge(from, elseB);
    this.cur = elseB;
    if (alt) {
      this.statement(alt);
    }
    this.edge(this.cur, after);
    this.cur = after;
  }
}

function hasLabels(body: Node): boolean {
  return body.descendantsOfType(["labeled_statement", "case_statement"]).length > 0;
}

/** A readable listing of the graph, for the "Show CFG" command and tests. */
export function cfgToText(cfg: Cfg, facts?: (block: number) => string | undefined): string {
  const lines: string[] = [`CFG of ${cfg.name || "(anonymous)"}()${cfg.unsupported ? ` -- not analyzed: ${cfg.unsupported}` : ""}`];
  const reachable = reachableBlocks(cfg);
  for (const b of cfg.blocks) {
    if (!reachable.has(b.id)) {
      continue;
    }
    const tag = b.id === cfg.entry ? "entry" : b.id === cfg.exit ? "exit" : b.label ?? "";
    lines.push("");
    lines.push(`B${b.id}${tag ? ` (${tag})` : ""}`);
    const f = facts?.(b.id);
    if (f !== undefined) {
      lines.push(`  in: ${f}`);
    }
    for (const it of b.items) {
      const line = it.node.startPosition.row + 1;
      const text = oneLine(it.kind === "return" ? it.node.text : it.node.text);
      lines.push(`  ${line}: ${text}`);
    }
    for (const e of b.succ) {
      lines.push(`  -> B${e.to}${e.assume ? `  [${assumeText(e.assume)}]` : ""}`);
    }
  }
  return lines.join("\n");
}

export function reachableBlocks(cfg: Cfg): Set<number> {
  const seen = new Set<number>([cfg.entry]);
  const todo = [cfg.entry];
  while (todo.length > 0) {
    const id = todo.pop()!;
    for (const e of cfg.blocks[id].succ) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        todo.push(e.to);
      }
    }
  }
  return seen;
}

function assumeText(a: Assume): string {
  switch (a.kind) {
    case "cond":
      return `${a.truth ? "" : "not "}${oneLine(a.node.text)}`;
    case "case":
      return `${oneLine(a.subject.text)} == ${oneLine(a.value.text)}`;
    case "default":
      return a.values.length ? `${oneLine(a.subject.text)} not in {${a.values.map((v) => oneLine(v.text)).join(", ")}}` : "default";
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}
