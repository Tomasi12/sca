// Entry point for checks: one FileEngine per analyzed file, shared by all checks of that run.

import { SourceContext } from "../analyzer";
import { FileEngine } from "./summaries";

const engines = new WeakMap<object, FileEngine>();

/** The engine for this file's syntax tree (created on first use), or undefined without a parse. */
export function engineFor(source: SourceContext): FileEngine | undefined {
  if (!source.parsed) {
    return undefined;
  }
  let engine = engines.get(source.parsed);
  if (!engine) {
    engine = new FileEngine(source.parsed.root, source.macros);
    engines.set(source.parsed, engine);
  }
  return engine;
}

export { FileEngine } from "./summaries";
export type { EngineStats } from "./summaries";
export { buildCfg, cfgToText, functionName } from "./cfg";
export type { Cfg } from "./cfg";
export { FunctionAnalysis, DEFAULT_BUDGET } from "./interpreter";
export type { Budget, Observer } from "./interpreter";
export { toText as valueToText } from "./value";
export type { Value } from "./value";
