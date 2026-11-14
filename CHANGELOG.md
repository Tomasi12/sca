# Changelog

## 0.0.1 — unreleased
- Empty extension skeleton: activates on C/C++ files, `SCA: Show Info` command.
- Unit tests (Mocha) and integration tests (@vscode/test-cli).
- `Finding` model in `src/core/finding.ts`: rule ID, message, file, 1-based range, certainty (definite / possible), severity, source, status (open / justified); validation, sorting, stable key and summary counts. Unit-tested.
- Issue Monitor: own "SCA" view in the Activity Bar (monitored file → findings, definite / possible / justified icons, click to open the line) and matching editor diagnostics (squiggles + Problems panel), both fed from one issue store (`src/core/issueStore.ts`). Empty until checks exist.
- Shield icon for the SCA view container.
- Monitor: "SCA: Add to Monitor" / "Remove from Monitor" / "Remove All from Monitor" for C/C++ files and folders (Explorer, editor and tab menus, Issue Monitor buttons, command palette). Folders expand to their C/C++ files (setting `sca.monitor.exclude`). The monitor is saved per workspace. `Analyzer` runs the list of checks (empty for now).
- Run on save: monitored files are analyzed on every save, autosave included. Waits `sca.analysis.debounceMs` (default 300 ms) and restarts the wait on each new save; a newer run of a file cancels the older one (`src/core/scheduler.ts`). Setting `sca.analysis.runOnSave`. New C/C++ files in a monitored folder are picked up when created, renamed or deleted in VS Code.
- `SCA: Analyze Now` command (also a ▶ button in the Issue Monitor).
- Status bar item: "SCA: analyzing…" / "SCA: N issues"; click opens the Issue Monitor.
- Parser layer `src/core/parser/`: C and C++ syntax trees with tree-sitter (web-tree-sitter + tree-sitter-c / tree-sitter-cpp, WASM, no native build). Grammar picked by extension (`.h` = C). Helpers: `walk`, `nodeRange` (1-based ranges). Checks get the tree through `SourceContext.parsed`. The tree is built before preprocessing, so macros are not expanded.
- Packaging now includes the `web-tree-sitter` runtime; the grammar `.wasm` files ship in `out/parsers`.
- First check `runtime-bugfinder:div-zero` (`src/core/checks/divByZero.ts`): definite for a constant 0 divisor; possible for a parameter divisor with no guard that rules out 0 (if / else / loops / `?:` / `&&` / `||`, early exit, `assert`). Quiet on reassigned parameters, functions with parse errors, and `static` functions whose callers all pass non-zero constants. Samples with DEFECT / SAFE markers in `tests/samples/div_by_zero_cases.c`, checked by a unit test. On car-control: 3 of the 6 planted div_zero defects found (the 3 parameter cases), no false positives.
- Coding-rule checks `sca-own:switch-default` (switch without default; nested switches checked on their own) and `sca-own:goto` (every goto), in `src/core/checks/codingRules.ts`. Definite, severity warning. Sample `tests/samples/coding_rules.c`.
- Headless benchmark `npm run benchmark -- <project>` (`src/bench/`): runs all checks, compares with `expected_findings.csv` and prints found / missed / false positives on SAFE lines / unmarked findings per category, plus the categories without a check. `--json`, `--fail-on-fp`. car-control: 7 of 10 found, 0 false positives.
- Rule catalog: `runtime-bugfinder` and `sca-own` marked as implemented, with `implementedRules`. Catalog text reworded to describe SCA on its own.
