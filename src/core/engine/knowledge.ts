// What one file can learn from the other files of its project (see src/core/project/projectIndex.ts).
// Only facts the code itself backs:
//
//   * the return value of a function defined (once, not static) in another file, from its own `return`s;
//   * the calls of a function in the whole project: the join of the argument values (a NULL that some caller
//     can pass, with the caller named), and for pointer arguments the length of the array passed;
//   * explicit 0 values that initializers put into a struct field (`WheelCalib erased = {0U, 1950U};`);
//   * field names that some code compares or limits (an accumulator that nobody limits can only grow).
//
// Interface only: the engine does not know how the facts are collected or cached.

import { Value } from "./value";

/** The calls of one function in the whole project. */
export interface CallFacts {
  /** Number of direct calls. */
  readonly calls: number;
  /** Per parameter: the join of the argument values (undefined when some call passes an unknown value). */
  readonly args: readonly (Value | undefined)[];
  /** Per parameter: the smallest array length passed (undefined when no call passes an array of known length). */
  readonly minLength: readonly (number | undefined)[];
  /** Per parameter: the array length when every call passes an array of one and the same known length. */
  readonly sameLength: readonly (number | undefined)[];
}

export interface ProjectKnowledge {
  /** Changes whenever a fact may have changed (part of the analysis cache key). */
  readonly version: string;
  /** True when exactly one other file of the project defines `name` (not static). */
  definesElsewhere(name: string, file: string): boolean;
  /** Return value of a function defined in another file, or undefined for "unknown". */
  returnOf(name: string, file: string): Value | undefined;
  /** The calls of a function in the project; undefined when its callers are not all known (address taken, no calls). */
  callFacts(name: string): CallFacts | undefined;
  /** Why field `field` of struct `tag` can be 0 (an explicit 0 in an initializer somewhere), or undefined. */
  fieldZero(tag: string, field: string): string | undefined;
  /** True when some code of the project compares the field (or variable) `name` or limits it. */
  isLimited(name: string): boolean;
}
