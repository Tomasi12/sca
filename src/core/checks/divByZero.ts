// runtime-bugfinder:div-zero — division or remainder whose divisor can be 0.
//
// Built on the value engine (src/core/engine): every division is checked with the divisor's value at that
// point, on all paths through the function.
//
//   * definite: the divisor is the constant 0, or the engine knows it is always 0 there
//     (e.g. inside `if (n == 0) { ... x / n ... }`).
//   * possible: the divisor can be 0 *and* the engine can name where the 0 comes from: an unchecked
//     parameter, a 0 assigned on some path, a static object that some store in this file sets to 0
//     (a memset, an unchecked parameter), or a function in this file that can return 0.
//
// Values the engine knows nothing about (globals from other files, struct fields behind pointers, calls to
// other files) never give a finding: "unknown" is not "can be 0". Conditions (`if`, loops, `?:`, `&&`, `||`,
// `switch`, early `return` / `break` / `continue` / `goto`, `assert(...)`, `exit()`) narrow the values.
// Functions the engine cannot model (some C++ statements, parse errors) or that exceed the time budget are
// skipped quietly; only constant-0 divisors are reported there.

import { SourceContext } from "../analyzer";
import { Finding } from "../finding";
import { checkRuntime } from "./runtime";
import { DIV_ZERO_RULE } from "./divZeroJudge";

export { DIV_ZERO_RULE } from "./divZeroJudge";

/** Only the div-zero findings of the run-time check (the engine solves every function once for all checks). */
export function checkDivByZero(source: SourceContext): Finding[] {
  return checkRuntime(source).filter((f) => f.ruleId === DIV_ZERO_RULE);
}
