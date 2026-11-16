// The clock for the engine's time budgets. Time spent on other files (the project index preparing another
// file's facts in the middle of a solve) does not count against the function or file being analyzed: their
// budgets are about their own size, and a finding must not depend on which file happened to be analyzed first.

let excluded = 0;
let depth = 0;
let since = 0;

/** Milliseconds, without the time spent inside `outsideBudget`. Stands still while inside it. */
export function budgetNow(): number {
  const t = Date.now();
  return t - excluded - (depth > 0 ? t - since : 0);
}

/** Runs work for other files (the project index); its time is left out of `budgetNow`. */
export function outsideBudget<T>(fn: () => T): T {
  if (depth++ === 0) {
    since = Date.now();
  }
  try {
    return fn();
  } finally {
    if (--depth === 0) {
      excluded += Date.now() - since;
    }
  }
}
