# Cross-file sample

A small project whose findings need facts from other files (the project index, `src/core/project/projectIndex.ts`).
Markers work as in the other samples: `DEFECT(category)` = a finding of that category is expected on the line,
`SAFE(category)` = no finding allowed; lines without a marker must not get a run-time finding.
`src/test/unit/crossFile.test.ts` checks them.

| File | What it shows |
|---|---|
| `calib.c` | Return values other files learn: `calib_load()` can return NULL (no argument decides it), `calib_slot(i)` only for a bad index (no evidence). |
| `speed.c` | A NULL a caller in `app.c` passes; a 0 that an initializer in `app.c` puts into a struct field, read through a struct copy. |
| `frames.c` | Inputs: a volatile mailbox register, fields behind `const Frame *`; array lengths and a length parameter from the callers in `app.c`. |
| `accumulate.c` | Accumulators nothing limits: a digit loop, an integrator; SAFE: a limited loop, a clamped integrator, a sliding window. |
| `app.c` | The callers. |
