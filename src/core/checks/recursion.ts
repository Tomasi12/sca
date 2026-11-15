// sca-own:recursion — a function that calls itself, directly or through other functions of the same file.
// Recursion makes stack use depend on the input, so it cannot be bounded at build time.
//
// The call graph covers the functions defined in the analyzed file (calls through function pointers are
// not followed). Cycles are found as strongly connected components; every call that stays inside a
// cycle is reported.

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { functionName } from "../engine/cfg";
import { Finding } from "../finding";
import { functionsOf, nodesWithin, ruleFinding } from "./ruleKit";

export const RECURSION_RULE = "sca-own:recursion";

interface CallSite {
  readonly callee: string;
  readonly node: Node;
}

/** For each function defined in the file: the calls it makes to functions of the same file. */
export function callGraph(source: SourceContext): Map<string, CallSite[]> {
  const fns = functionsOf(source);
  const defined = new Set(fns.map(functionName).filter((n) => n !== ""));
  const graph = new Map<string, CallSite[]>();
  for (const fn of fns) {
    const name = functionName(fn);
    if (!name || graph.has(name)) {
      continue;
    }
    const calls: CallSite[] = [];
    for (const call of nodesWithin(source, fn, "call_expression")) {
      const callee = call.childForFieldName("function");
      if (callee?.type === "identifier" && defined.has(callee.text)) {
        calls.push({ callee: callee.text, node: call });
      }
    }
    graph.set(name, calls);
  }
  return graph;
}

/** Tarjan's algorithm: the strongly connected components of the call graph. */
function components(graph: Map<string, CallSite[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const comp = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0;
  let compId = 0;
  const strong = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const { callee: w } of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.set(w, compId);
        if (w === v) {
          break;
        }
      }
      compId++;
    }
  };
  for (const v of graph.keys()) {
    if (!index.has(v)) {
      strong(v);
    }
  }
  return comp;
}

export function checkRecursion(source: SourceContext): Finding[] {
  const graph = callGraph(source);
  const comp = components(graph);
  const members = new Map<number, string[]>();
  for (const [fn, c] of comp) {
    members.set(c, [...(members.get(c) ?? []), fn]);
  }
  const out: Finding[] = [];
  for (const [caller, calls] of graph) {
    for (const { callee, node } of calls) {
      if (comp.get(caller) !== comp.get(callee)) {
        continue;
      }
      const message =
        caller === callee
          ? `${caller}() calls itself (recursion); stack use then depends on the input. Use a loop instead.`
          : `${caller}() calls ${callee}(), which leads back to ${caller}() (indirect recursion through ${members.get(comp.get(caller)!)!.join(", ")}); stack use then depends on the input.`;
      out.push(ruleFinding(source, RECURSION_RULE, node, message));
    }
  }
  return out;
}
