// Merging findings of SCA's own checks with those of external backends.
//
// Many backend checks find the same problem as an SCA rule. When a backend finding and an SCA finding are
// on the same line and the backend check is the equivalent of the SCA rule, they become one finding: SCA's
// (rule ID and message), with the backend added to its source ("sca-native+cppcheck"). Two backends that
// report the same equivalent problem on a line are merged the same way. Everything else is kept as is.

import { Finding } from "../finding";

/** Backend check -> the SCA rule that finds the same problem. */
export const EQUIVALENT_RULES: Readonly<Record<string, string>> = {
  // cppcheck
  "cppcheck:zerodiv": "runtime-bugfinder:div-zero",
  "cppcheck:zerodivcond": "runtime-bugfinder:div-zero",
  "cppcheck:nullPointer": "runtime-bugfinder:null-deref",
  "cppcheck:nullPointerRedundantCheck": "runtime-bugfinder:null-deref",
  "cppcheck:ctunullpointer": "runtime-bugfinder:null-deref",
  "cppcheck:uninitvar": "runtime-bugfinder:uninit-read",
  "cppcheck:legacyUninitvar": "runtime-bugfinder:uninit-read",
  "cppcheck:uninitdata": "runtime-bugfinder:uninit-read",
  "cppcheck:arrayIndexOutOfBounds": "runtime-bugfinder:out-of-bounds",
  "cppcheck:arrayIndexOutOfBoundsCond": "runtime-bugfinder:out-of-bounds",
  "cppcheck:bufferAccessOutOfBounds": "runtime-bugfinder:out-of-bounds",
  "cppcheck:negativeIndex": "runtime-bugfinder:out-of-bounds",
  "cppcheck:integerOverflow": "runtime-bugfinder:overflow",
  "cppcheck:shiftTooManyBits": "runtime-bugfinder:invalid-shift",
  "cppcheck:shiftTooManyBitsSigned": "runtime-bugfinder:invalid-shift",
  "cppcheck:shiftNegative": "runtime-bugfinder:invalid-shift",
  "cppcheck:autoVariables": "runtime-bugfinder:stack-escape",
  "cppcheck:returnDanglingLifetime": "runtime-bugfinder:stack-escape",
  "cppcheck:knownConditionTrueFalse": "sca-own:invariant-condition",
  "cppcheck:unreadVariable": "sca-own:unused-variable",
  "cppcheck:unusedVariable": "sca-own:unused-variable",
  "cppcheck:shadowVariable": "sca-own:shadowing",
  "cppcheck:shadowArgument": "sca-own:shadowing",
  "cppcheck:clarifyCondition": "sca-own:operator-precedence",
  // clang-tidy (clang-analyzer-* and compiler warnings)
  "clang-tidy:clang-analyzer-core.DivideZero": "runtime-bugfinder:div-zero",
  "clang-tidy:clang-analyzer-core.NullDereference": "runtime-bugfinder:null-deref",
  "clang-tidy:clang-analyzer-core.uninitialized.UndefReturn": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-analyzer-core.uninitialized.Assign": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-analyzer-core.uninitialized.Branch": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-analyzer-core.uninitialized.ArraySubscript": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-diagnostic-sometimes-uninitialized": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-diagnostic-uninitialized": "runtime-bugfinder:uninit-read",
  "clang-tidy:clang-analyzer-security.ArrayBound": "runtime-bugfinder:out-of-bounds",
  "clang-tidy:clang-analyzer-alpha.security.ArrayBoundV2": "runtime-bugfinder:out-of-bounds",
  "clang-tidy:clang-analyzer-core.StackAddressEscape": "runtime-bugfinder:stack-escape",
  "clang-tidy:clang-diagnostic-return-stack-address": "runtime-bugfinder:stack-escape",
  "clang-tidy:clang-analyzer-core.UndefinedBinaryOperatorResult": "runtime-bugfinder:invalid-shift",
  "clang-tidy:clang-diagnostic-shift-count-overflow": "runtime-bugfinder:invalid-shift",
  "clang-tidy:clang-diagnostic-division-by-zero": "runtime-bugfinder:div-zero",
  "clang-tidy:clang-diagnostic-unused-variable": "sca-own:unused-variable",
  "clang-tidy:clang-diagnostic-unused-parameter": "sca-own:unused-parameter",
  "clang-tidy:misc-unused-parameters": "sca-own:unused-parameter",
  "clang-tidy:clang-diagnostic-shadow": "sca-own:shadowing",
  "clang-tidy:clang-diagnostic-sign-compare": "sca-own:signed-unsigned-compare",
  "clang-tidy:clang-diagnostic-implicit-fallthrough": "sca-own:switch-fallthrough",
  "clang-tidy:clang-diagnostic-float-equal": "sca-own:float-equality",
  "clang-tidy:clang-diagnostic-parentheses": "sca-own:assignment-in-condition",
  "clang-tidy:clang-diagnostic-empty-body": "sca-own:empty-body",
  "clang-tidy:clang-diagnostic-vla": "sca-own:vla",
  "clang-tidy:bugprone-assignment-in-if-condition": "sca-own:assignment-in-condition",
  "clang-tidy:bugprone-switch-missing-default-case": "sca-own:switch-default",
  "clang-tidy:bugprone-narrowing-conversions": "sca-own:implicit-conversion",
  "clang-tidy:readability-braces-around-statements": "sca-own:missing-braces",
  "clang-tidy:readability-magic-numbers": "sca-own:magic-number",
  "clang-tidy:cppcoreguidelines-avoid-goto": "sca-own:goto",
  "clang-tidy:misc-no-recursion": "sca-own:recursion",
  "clang-tidy:hicpp-signed-bitwise": "sca-own:signed-bitwise",
};

/** The SCA rule a finding stands for (its own ID for native findings). */
export function canonicalRule(ruleId: string): string {
  return EQUIVALENT_RULES[ruleId] ?? ruleId;
}

function addSource(f: Finding, source: string): Finding {
  const parts = f.source.split("+");
  return parts.includes(source) ? f : { ...f, source: [...parts, source].join("+") };
}

/**
 * One list from SCA's findings and the backends' findings. Same file + line + equivalent rule -> one
 * finding (the first one seen, SCA's own first), with every reporting tool in its source.
 */
export function mergeFindings(native: readonly Finding[], external: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  const index = new Map<string, number>();
  const key = (f: Finding) => `${f.file}\0${f.range.start.line}\0${canonicalRule(f.ruleId)}`;
  for (const f of [...native, ...external]) {
    const k = key(f);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push(f);
    } else {
      out[at] = addSource(out[at], f.source);
    }
  }
  return out;
}
