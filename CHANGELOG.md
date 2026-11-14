# Changelog

## 0.0.1 — unreleased
- Empty extension skeleton: activates on C/C++ files, `SCA: Show Info` command.
- Unit tests (Mocha) and integration tests (@vscode/test-cli).
- `Finding` model in `src/core/finding.ts`: rule ID, message, file, 1-based range, certainty (definite / possible), severity, source, status (open / justified); validation, sorting, stable key and summary counts. Unit-tested.
- Issue Monitor: own "SCA" view in the Activity Bar (monitored file → findings, definite / possible / justified icons, click to open the line) and matching editor diagnostics (squiggles + Problems panel), both fed from one issue store (`src/core/issueStore.ts`). Empty until checks exist.
- Shield icon for the SCA view container.
- Monitor: "SCA: Add to Monitor" / "Remove from Monitor" / "Remove All from Monitor" for C/C++ files and folders (Explorer, editor and tab menus, Issue Monitor buttons, command palette). Folders expand to their C/C++ files (setting `sca.monitor.exclude`). The monitor is saved per workspace. `Analyzer` runs the list of checks (empty for now).
