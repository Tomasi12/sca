// All native checks, in the order they run. Add new checks here.

import { Check } from "../analyzer";
import { checkGoto, checkSwitchDefault, GOTO_RULE, SWITCH_DEFAULT_RULE } from "./codingRules";
import { checkDivByZero, DIV_ZERO_RULE } from "./divByZero";

export const ALL_CHECKS: readonly Check[] = [checkDivByZero, checkSwitchDefault, checkGoto];

/**
 * Which rule IDs answer which ground-truth category (the `category` in DEFECT(...) / RULE(...) / SAFE(...) markers).
 * Used by the benchmark to compare findings with an answer key.
 */
export const CATEGORY_RULES: Readonly<Record<string, readonly string[]>> = {
  div_zero: [DIV_ZERO_RULE],
  switch_default: [SWITCH_DEFAULT_RULE],
  goto: [GOTO_RULE],
};
