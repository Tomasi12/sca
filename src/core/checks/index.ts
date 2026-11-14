// All native checks, in the order they run. Add new checks here.

import { Check } from "../analyzer";
import {
  checkGoto,
  checkSwitchDefault,
  checkSwitchFallthrough,
  checkUncheckedReturn,
  FALLTHROUGH_RULE,
  GOTO_RULE,
  SWITCH_DEFAULT_RULE,
  UNCHECKED_RETURN_RULE,
} from "./codingRules";
import { DIV_ZERO_RULE } from "./divZeroJudge";
import {
  checkRuntime,
  CONVERSION_RULE,
  DEAD_CODE_RULE,
  ENDLESS_LOOP_RULE,
  NULL_DEREF_RULE,
  OOB_RULE,
  OVERFLOW_RULE,
  SHIFT_RULE,
  INVARIANT_RULE,
  STACK_ESCAPE_RULE,
  UINT_WRAP_RULE,
  UNINIT_RULE,
} from "./runtime";

export const ALL_CHECKS: readonly Check[] = [checkRuntime, checkSwitchDefault, checkGoto, checkSwitchFallthrough, checkUncheckedReturn];

/**
 * Which rule IDs answer which ground-truth category (the `category` in DEFECT(...) / RULE(...) / SAFE(...) markers).
 * Used by the benchmark to compare findings with an answer key.
 */
export const CATEGORY_RULES: Readonly<Record<string, readonly string[]>> = {
  div_zero: [DIV_ZERO_RULE],
  null_deref: [NULL_DEREF_RULE],
  uninit_var: [UNINIT_RULE],
  uninit_ptr: [UNINIT_RULE],
  out_of_bounds: [OOB_RULE],
  overflow: [OVERFLOW_RULE],
  uint_wrap: [UINT_WRAP_RULE],
  shift: [SHIFT_RULE],
  conversion: [CONVERSION_RULE],
  dead_code: [DEAD_CODE_RULE],
  unreachable_code: [DEAD_CODE_RULE],
  non_terminating_loop: [ENDLESS_LOOP_RULE],
  stack_escape: [STACK_ESCAPE_RULE],
  switch_default: [SWITCH_DEFAULT_RULE],
  goto: [GOTO_RULE],
  missing_break: [FALLTHROUGH_RULE],
  unchecked_return: [UNCHECKED_RETURN_RULE],
  invariant_condition: [INVARIANT_RULE],
};
