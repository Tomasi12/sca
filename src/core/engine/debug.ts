// "Show CFG": a readable dump of one function's control-flow graph and the values the engine knows
// at the start of every block. For debugging the engine and for understanding a finding.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { cfgToText } from "./cfg";
import { engineFor } from "./index";
import { toText } from "./value";

/** The function definition around a 1-based line, innermost first. */
export function functionAtLine(root: Node, line: number): Node | undefined {
  let best: Node | undefined;
  for (const fn of root.descendantsOfType("function_definition")) {
    if (fn && fn.startPosition.row + 1 <= line && fn.endPosition.row + 1 >= line) {
      if (!best || fn.startIndex >= best.startIndex) {
        best = fn;
      }
    }
  }
  return best;
}

/** Text dump for the function at `line`, or undefined when there is none. */
export function describeFunctionAt(source: SourceContext, line: number): string | undefined {
  const engine = engineFor(source);
  const fn = source.parsed ? functionAtLine(source.parsed.root, line) : undefined;
  if (!engine || !fn) {
    return undefined;
  }
  const fa = engine.analyze(fn, {});
  const outcome = fa.outcome;
  const head = outcome?.ok ? `Solved in ${outcome.visits} block visits.` : `Not analyzed: ${outcome?.reason ?? "unknown"}. Findings in this function are skipped (constant 0 divisors excepted).`;
  const tracked = [...fa.model.tracked.values()].map((v) => `${v.name}: ${v.type.name}${v.param ? " (parameter)" : ""}`);
  const facts = (block: number) => {
    const s = fa.stateAt(block);
    if (!s) {
      return outcome?.ok ? "unreachable" : undefined;
    }
    return [...s.vars].map(([k, v]) => `${k} = ${toText(v)}`).join("; ") || "(no tracked variables)";
  };
  return [
    cfgToText(fa.cfg, facts),
    "",
    head,
    `Tracked: ${tracked.length ? tracked.join(", ") : "none"}`,
    "Reading values: [lo, hi] is the range; (0: ...) names where a 0 can come from; findings need such a source.",
  ].join("\n");
}
