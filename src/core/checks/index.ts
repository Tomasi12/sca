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
import { checkControlFlow, CONTROL_FLOW_RULES, EMPTY_BODY_RULE, MISSING_BRACES_RULE } from "./controlFlow";
import {
  checkDeclarations,
  DECLARATION_RULES,
  DYNAMIC_MEMORY_RULE,
  MAGIC_NUMBER_RULE,
  MISSING_VOLATILE_RULE,
  SHADOWING_RULE,
  UNUSED_PARAMETER_RULE,
  UNUSED_VARIABLE_RULE,
} from "./declarationRules";
import { DIV_ZERO_RULE } from "./divZeroJudge";
import {
  ASSIGNMENT_IN_CONDITION_RULE,
  checkExpressions,
  EXPRESSION_RULES,
  FLOAT_EQUALITY_RULE,
  OPERATOR_PRECEDENCE_RULE,
  SIDE_EFFECT_IN_LOGICAL_RULE,
} from "./expressions";
import { checkAccumulators } from "./accumulate";
import { checkMetrics, METRIC_RULES } from "./metrics";
import { checkRecursion, RECURSION_RULE } from "./recursion";
import {
  ALLOC_SIZE_RULE,
  BAD_FREE_RULE,
  BAD_FUNCTION_POINTER_RULE,
  INVALID_ENUM_RULE,
  MISSING_RETURN_RULE,
  NO_RETURN_CALL_RULE,
  checkRuntime,
  CONVERSION_RULE,
  DANGLING_RULE,
  DOUBLE_FREE_RULE,
  MEMORY_LEAK_RULE,
  POINTER_ARITH_RULE,
  SIZEOF_POINTER_RULE,
  UNCHECKED_ALLOC_RULE,
  USE_AFTER_FREE_RULE,
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
  RUNTIME_RULES,
} from "./runtime";
import {
  checkTypesAndLiterals,
  IMPLICIT_CONVERSION_RULE,
  INT_DIVISION_TO_FLOAT_RULE,
  OCTAL_CONSTANT_RULE,
  SIGNED_BITWISE_RULE,
  SIGNED_UNSIGNED_COMPARE_RULE,
  TYPE_RULES,
  VLA_RULE,
} from "./typesLiterals";

export const ALL_CHECKS: readonly Check[] = [
  checkAccumulators,
  checkRuntime,
  checkSwitchDefault,
  checkGoto,
  checkSwitchFallthrough,
  checkUncheckedReturn,
  checkExpressions,
  checkControlFlow,
  checkTypesAndLiterals,
  checkDeclarations,
  checkRecursion,
  checkMetrics,
];

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
  memory_leak: [MEMORY_LEAK_RULE],
  double_free: [DOUBLE_FREE_RULE],
  use_after_free: [USE_AFTER_FREE_RULE],
  bad_free: [BAD_FREE_RULE],
  dangling_ptr: [DANGLING_RULE],
  unchecked_alloc: [UNCHECKED_ALLOC_RULE],
  alloc_size: [ALLOC_SIZE_RULE],
  wrong_sizeof: [SIZEOF_POINTER_RULE],
  ptr_arith: [POINTER_ARITH_RULE],
  missing_return: [MISSING_RETURN_RULE],
  invalid_enum: [INVALID_ENUM_RULE],
  non_terminating_call: [NO_RETURN_CALL_RULE],
  bad_func_ptr: [BAD_FUNCTION_POINTER_RULE],
  switch_default: [SWITCH_DEFAULT_RULE],
  goto: [GOTO_RULE],
  missing_break: [FALLTHROUGH_RULE],
  unchecked_return: [UNCHECKED_RETURN_RULE],
  invariant_condition: [INVARIANT_RULE],
  float_equality: [FLOAT_EQUALITY_RULE],
  assignment_in_condition: [ASSIGNMENT_IN_CONDITION_RULE],
  side_effect_in_condition: [SIDE_EFFECT_IN_LOGICAL_RULE],
  operator_precedence: [OPERATOR_PRECEDENCE_RULE],
  missing_braces: [MISSING_BRACES_RULE],
  empty_body: [EMPTY_BODY_RULE],
  octal_constant: [OCTAL_CONSTANT_RULE],
  implicit_conversion: [IMPLICIT_CONVERSION_RULE],
  signed_unsigned_compare: [SIGNED_UNSIGNED_COMPARE_RULE],
  signed_bitwise: [SIGNED_BITWISE_RULE],
  vla: [VLA_RULE],
  integer_division_in_float: [INT_DIVISION_TO_FLOAT_RULE],
  unused_variable: [UNUSED_VARIABLE_RULE],
  unused_parameter: [UNUSED_PARAMETER_RULE],
  shadowing: [SHADOWING_RULE],
  missing_volatile: [MISSING_VOLATILE_RULE],
  dynamic_memory: [DYNAMIC_MEMORY_RULE],
  magic_number: [MAGIC_NUMBER_RULE],
  recursion: [RECURSION_RULE],
};

/** Every rule ID a native check can report (the registry must describe each of them). */
export const ALL_RULE_IDS: readonly string[] = [
  ...RUNTIME_RULES,
  SWITCH_DEFAULT_RULE,
  GOTO_RULE,
  FALLTHROUGH_RULE,
  UNCHECKED_RETURN_RULE,
  ...EXPRESSION_RULES,
  ...CONTROL_FLOW_RULES,
  ...TYPE_RULES,
  ...DECLARATION_RULES,
  RECURSION_RULE,
  ...Object.values(METRIC_RULES),
];
