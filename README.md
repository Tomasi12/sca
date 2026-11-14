# SCA — Static Code Analyzer

SCA checks C/C++ code **as you write it** and reports likely run-time errors
(division by zero, overflow, out-of-bounds, null dereference, uninitialized reads, ...)
and coding-rule violations.

SCA is a **VS Code extension**.

> Status: early development. Activates on C/C++ files, shows the **SCA → Issue Monitor** view; files and folders can be added to the monitor and are analyzed on every save. Checks: possible division by zero, `switch` without `default`, `goto`. A headless benchmark compares the results with an answer key.

## Contents
- [Quick install with `installer.ps1`](#quick-install-with-installerps1) ← start here
- [Walkthrough presentation (14 Nov 2026)](docs/14112026/index.html): purpose, how it works, step-by-step screenshots and recordings
- [Installation for development — step by step](#installation-for-development--step-by-step)
- [Benchmark](#benchmark)
- [Commands (reference)](#commands-reference)
- [Layout](#layout)

## Quick install with `installer.ps1`

`installer.ps1` builds SCA and installs it into your normal VS Code with **one command**.
After it finishes, SCA is available in every VS Code window — no F5, no development window.

### 1. Requirements (install once)
- **Git** — https://git-scm.com/downloads
- **Node.js 22 or newer** — https://nodejs.org
- **VS Code 1.100 or newer** — https://code.visualstudio.com (keep *"Add to PATH"* checked during setup)

Restart PowerShell after installing them.

### 2. Download SCA
Open **PowerShell** in the folder where you keep projects:
```powershell
git clone https://github.com/Tomasi12/sca.git
```
```powershell
cd sca
```

### 3. Run the installer
```powershell
powershell -ExecutionPolicy Bypass -File .\installer.ps1
```
`-ExecutionPolicy Bypass` allows this one script to run. It only applies to this run and does **not** change your Windows settings.

What the script does, in order:

| # | Step | What you see |
|---|---|---|
| 1 | Checks Node.js, npm and VS Code (`code`) | `OK  Node.js v24...`, `OK  npm ...`, `OK  VS Code ...` |
| 2 | Installs dependencies (`npm ci`) | `OK  Dependencies installed` |
| 3 | *(only with `-RunTests`)* runs unit + integration tests | `OK  All tests passed` |
| 4 | Builds the extension file `sca.vsix` | `OK  Created ...\sca.vsix` |
| 5 | Installs `sca.vsix` into VS Code and verifies it | `OK  Installed tomasi12.sca@0.0.1` |

It ends with **`SCA is installed.`** If any step fails, it stops and prints a red `ERROR:` line telling you what to fix.

### 4. Use SCA in VS Code
1. If VS Code was already open: `Ctrl+Shift+P` → **Developer: Reload Window** (or restart VS Code).
2. Open any `.c` or `.cpp` file.
3. `Ctrl+Shift+P` → **SCA: Show Info** → message *"SCA is active. Languages: c, cpp."* ✅

You can also check it in the Extensions view (`Ctrl+Shift+X`): search **SCA**.

### 5. The Issue Monitor
Click the **shield icon** in the Activity Bar to open **SCA → Issue Monitor**.

| To… | Do this |
|---|---|
| Monitor a file or folder | Right-click it in the Explorer → **SCA: Add to Monitor** (works with a multi-selection too) |
| Monitor the open file | Right-click in the editor or on its tab → **SCA: Add to Monitor**, or the **+** button in the Issue Monitor |
| Stop monitoring | **SCA: Remove from Monitor** (same menus), or the **×** next to a file in the Issue Monitor |
| Start over | The **Remove All** button in the Issue Monitor title bar |
| Analyze all monitored files now | **SCA: Analyze Now** (command palette), or the **▶** button in the Issue Monitor title bar |
| See what SCA knows inside a function | Right-click in the function → **SCA: Show Control-Flow Graph** |

- Only C/C++ files are monitored (`.c .h .cpp .cc .cxx .hpp .hh .hxx`). A monitored folder includes all of them below it.
- Folders matching `sca.monitor.exclude` are skipped (default: `node_modules`, `.git`, `third_party`, `build`, `out`).
- A file monitored through its folder is removed by removing the folder.
- The monitor is remembered per workspace.
- Findings appear in the Issue Monitor (definite = error, possible = warning) and as squiggles in the Problems panel.
  See [Checks](#checks) for what is checked today.

#### Checks
| Rule ID | Reports | Certainty |
|---|---|---|
| `runtime-bugfinder:div-zero` | `/` or `%` (also `/=`, `%=`) by the constant 0, or by a value that is always 0 at that point | definite (error) |
| `runtime-bugfinder:div-zero` | `/` or `%` by a value that can be 0, when SCA can name where the 0 comes from | possible (warning) |
| `sca-own:switch-default` | `switch` without a `default` clause (a nested switch needs its own) | definite (warning) |
| `sca-own:goto` | every `goto` statement | definite (warning) |

div-zero runs on the **value engine** (see [How the value engine works](#how-the-value-engine-works)): it follows
every path through the function and knows the divisor's range at the division. Where a 0 can come from:

| Source of the 0 | Example |
|---|---|
| a parameter not checked first | `int avg(int s, int n) { return s / n; }` |
| a 0 still there on some path | `d = 0; if (m > 3) d = m; ... x / d` |
| a loop counter's first value | `for (i = 0; i < n; i++) s += a / i;` |
| a `static` object that some code in the file sets to 0 | `memset(tab, 0, ...)`; a store of an unchecked parameter |
| a function in the same file that can return 0 | `return a / count_or_zero(x);` |

Conditions narrow the value: `if` / `else`, loops, `switch`, `?:`, `&&` / `||`, early `return` / `break` /
`continue` / `goto` / `abort()`, `assert(...)`. Values SCA knows nothing about (globals from other files, fields
behind pointer parameters, functions from other files) never give a finding: "unknown" is not "can be 0".
A `static` function whose callers in the file all pass a non-zero constant is not reported.

Not covered: functions with statements the engine cannot model yet (some C++: `try`, range-`for`) or that exceed the
time budget, and functions tree-sitter cannot fully parse (often because of macros). Only constant-0 divisors are
reported there. Examples: [tests/samples/div_by_zero_cases.c](tests/samples/div_by_zero_cases.c),
[tests/samples/div_by_zero_engine.c](tests/samples/div_by_zero_engine.c), [tests/samples/coding_rules.c](tests/samples/coding_rules.c).

#### How the value engine works
`src/core/engine/`, for C functions:

1. **Control-flow graph** (`cfg.ts`): blocks and edges for `if`, loops, `switch` (with fall-through), `goto`,
   `break`, `continue` and `return`. The first round of a loop is kept apart ("peeled"), so "the loop ran at least once"
   and "the loop never ran" do not mix.
2. **Values** (`value.ts`): each tracked variable has a range `[lo, hi]`, a *zero witness* (where a 0 can come from),
   whether it is set on all paths, some, or none, and for pointers: null, not null, or maybe null.
3. **Solver** (`interpreter.ts`): runs the graph until nothing changes; loops are widened to the type's limits after a few
   rounds, so they always end. Conditions narrow values on each branch (`if (n > 0)` gives `n ∈ [1, max]` inside).
4. **File summaries** (`summaries.ts`): stores to `static` objects, return values of functions in the file, and the
   constant arguments of `static` functions. They are computed only when a finding depends on them.
5. **Time budget**: at most 4,000 block visits and 60 ms per function, 1.5 s per file. Code over budget is skipped quietly,
   so the editor never waits for it.

**SCA: Show Control-Flow Graph** (editor context menu, or the command palette with the cursor in a function) opens the
graph of that function with the values at the start of every block, e.g.
`d = [0, 2147483647] (0: the constant 0)`. Useful to understand a finding or a missed one.

#### When files are analyzed
- When a file is added to the monitor.
- **Every time a monitored file is saved** — by `Ctrl+S` or by autosave (`File → Auto Save`).
  SCA waits a short time after the save (`sca.analysis.debounceMs`, default 300 ms); another save within that time restarts the wait,
  so a burst of autosaves gives one analysis. A newer analysis of the same file cancels the older one.
- On **SCA: Analyze Now**.
- Turn off analysis on save with `sca.analysis.runOnSave: false`.

The status bar shows **SCA: analyzing…** while it works and **SCA: N issues** when done; click it to open the Issue Monitor.

#### Icons
The icon of a finding follows its **severity**, as in the Problems panel (red = error, yellow = warning).
The text next to it says the **certainty** (*definite* / *possible*) or *justified*.

### 6. Project setup: compile database and `.sca.json`
SCA reads the project like the compiler does, so `#if` branches and macros are right:

- **`compile_commands.json`** (written by CMake with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or by Bear) gives each file its
  include paths and `-D` defines. SCA looks in `compile_commands.json`, `build/`, `out/` and `cmake-build-debug/`.
- **`#if` / `#ifdef` / `#elif`** are evaluated; code in inactive branches is not checked. Without a compile database an
  `#ifdef` on an unknown macro keeps both branches (include guards are still recognized).
- **Macro constants** from the file and its headers are known to the checks: `x / CELLS` with `#define CELLS 0U` is reported.

An optional **`.sca.json`** in the workspace root sets up the project (VS Code completes the keys):

```json
{
  "ruleSets": { "sca-own": true },
  "rules": { "sca-own:goto": false, "runtime-bugfinder:div-zero": { "severity": "error" } },
  "exclude": ["**/generated/**"],
  "compileCommands": "build/compile_commands.json",
  "includePaths": ["include"],
  "defines": { "UNIT_TEST": "1" },
  "deviations": [{ "rule": "sca-own:goto", "file": "src/util.c", "line": 74, "reason": "Single cleanup exit." }]
}
```

Everything is on by default; a single rule wins over its rule set. Changes to `.sca.json`, the compile database or a header
re-check the monitored files. Problems in the setup are shown in **View → Output → SCA**.

### 7. Review: justify, baseline, report
- **Justify a finding** (reviewed and accepted): a comment on the same line, or on a comment line directly above it —
  `/* sca-justify(runtime-bugfinder:div-zero): n is checked by every caller */`. The rule can also be `sca-own:*` or `*`.
  The reason is required. Justified findings get a green check and do not count as issues. Without touching the code:
  `deviations` in `.sca.json`.
- **Baseline** for old code: **SCA: Save Baseline** writes `.sca-baseline.json`; from then on only **new** findings are shown
  (the Issue Monitor shows how many are hidden). A finding is recognized by its file, rule and line text, so it stays hidden when
  lines above it change. **SCA: Clear Baseline** shows everything again. Setting `sca.baseline.enabled`.
- **SCA: Export Report** writes all findings as **HTML** (to read or share), **CSV** (spreadsheets) or **SARIF** (CI and
  code-scanning tools). Also in the `…` menu of the Issue Monitor.

### Options
| Command | What it does |
|---|---|
| `powershell -ExecutionPolicy Bypass -File .\installer.ps1` | Build and install (normal use) |
| `powershell -ExecutionPolicy Bypass -File .\installer.ps1 -RunTests` | Run all tests first, install only if they pass (slower; first run downloads a test VS Code, ~1 GB on disk) |
| `powershell -ExecutionPolicy Bypass -File .\installer.ps1 -Uninstall` | Remove SCA from VS Code |
| `powershell -ExecutionPolicy Bypass -File .\installer.ps1 -CodeCommand code-insiders` | Install into VS Code Insiders instead |

Show the built-in help:
```powershell
Get-Help .\installer.ps1 -Detailed
```

### Update to a new version
```powershell
git pull
```
```powershell
powershell -ExecutionPolicy Bypass -File .\installer.ps1
```
The installer replaces the old version (`--force`). Reload VS Code afterwards.

### Installer troubleshooting
| Message | Fix |
|---|---|
| `running scripts is disabled on this system` | You started it as `.\installer.ps1`. Use the full command with `-ExecutionPolicy Bypass`. |
| `ERROR: Node.js not found` / `too old` | Install Node.js 22+ from https://nodejs.org, restart PowerShell. |
| `ERROR: 'code' not found` | Reinstall VS Code with *"Add to PATH"* checked, restart PowerShell. |
| `ERROR: package.json not found` | Run the script from inside the `sca` folder (`cd sca`). |
| `ERROR: npm ci failed` | Check your internet / proxy, then run the installer again. |
| SCA not visible after install | Reload the VS Code window (`Developer: Reload Window`). |

> Not on Windows? Use the development steps below, or run `npm ci`, `npm run package` and
> `code --install-extension sca.vsix` manually.

## Installation for development — step by step

SCA is not on the VS Code Marketplace yet. These steps run it from source in a development window.

### Step 1 — Install the prerequisites
| Tool | Version | Download | Check it works |
|---|---|---|---|
| Git | any recent | https://git-scm.com/downloads | `git --version` |
| Node.js | 22 LTS or newer (tested with 24) | https://nodejs.org | `node --version` |
| VS Code | 1.100 or newer | https://code.visualstudio.com | `code --version` |

npm comes with Node.js (`npm --version`).
Restart your terminal after installing, so the commands are found.

### Step 2 — Get the code
Open a terminal in the folder where you keep projects, then:
```bash
git clone https://github.com/Tomasi12/sca.git
```
```bash
cd sca
```

### Step 3 — Install the dependencies
```bash
npm install
```
This creates a `node_modules/` folder. It takes under a minute.

### Step 4 — Build
```bash
npm run compile
```
TypeScript is compiled into the `out/` folder. No output means no errors.

### Step 5 — Check everything works (optional, recommended)
```bash
npm run test:unit
```
Fast unit tests — you should see `126 passing`.
```bash
npm test
```
Lint + integration tests. The first run downloads a separate copy of VS Code
into `.vscode-test/` (about 1 GB on disk after unpacking), then you should see `25 passing`.

### Step 6 — Open the project in VS Code
```bash
code .
```
If VS Code suggests the recommended extensions (ESLint, Extension Test Runner), click **Install**.

### Step 7 — Run the extension
1. Press **F5** (or *Run → Start Debugging*, configuration **Run Extension**).
2. A second VS Code window opens, titled **[Extension Development Host]**, with the sample folder `tests/samples/`.
3. In that window, open `div_by_zero.c` — this starts SCA.

### Step 8 — Try it
1. Press **Ctrl+Shift+P** (macOS: **Cmd+Shift+P**).
2. Type **SCA: Show Info** and press Enter.
3. A message appears: *"SCA is active. Languages: c, cpp."* ✅
4. Optional: *View → Output*, choose **SCA** in the dropdown — you see `SCA activated.`

### Step 9 — Make changes
- Run `npm run watch` in a terminal: it recompiles on every save.
- In the Extension Development Host window press **Ctrl+R** to reload with your changes.

### Troubleshooting
| Problem | Fix |
|---|---|
| `node`, `npm` or `code` not found | Reinstall / restart the terminal. For `code`: in VS Code, Ctrl+Shift+P → *Shell Command: Install 'code' command in PATH* (macOS) — on Windows it is added by the installer. |
| `npm install` fails | Check `node --version` is 22+; delete `node_modules/` and run `npm install` again. |
| F5 does nothing / "Cannot find out/extension.js" | Run `npm run compile` first, then F5 again. |
| `SCA: Show Info` is not in the list | Make sure you are in the **[Extension Development Host]** window, not the main one. |
| `npm test` hangs on the first run | It is downloading VS Code — wait, or check your internet / proxy. |

## Benchmark
Runs every check on a C/C++ project **without VS Code** and compares the findings with the project's answer key
(`expected_findings.csv`, one row per planted issue: `file, line, kind, category, description`).
The test project [car-control](https://github.com/Tomasi12/car-control) has such a key.

```bash
npm run benchmark -- ../dummy_project
npm run benchmark -- ../dummy_project --json bench.json --fail-on-fp
```

| Column | Meaning |
|---|---|
| expected | `DEFECT` / `RULE` rows of the category: should be reported |
| found / missed | expected rows with / without a matching finding (same file, same line, rule of that category) |
| false pos. | findings on a `SAFE` row of the category (correct code that was reported) |
| unmarked | findings on lines without a marker: review them by hand, then add a marker to the project |

Categories in the key that no check covers yet are listed at the end. Which rule IDs answer which category is set in
`CATEGORY_RULES` (`src/core/checks/index.ts`). `--fail-on-fp` returns exit code 1 when there is a false positive (for CI).

Result on car-control today: **9 of 10** expected issues found in the covered categories (`div_zero` 5/6, `switch_default` 1/1,
`goto` 3/3), **0 false positives**, 0 unmarked findings. The one left (`wheel_speed.c:28`) needs knowledge across files
(the calibration comes from another module).

## Commands (reference)
```bash
npm install           # install dependencies
npm run compile       # TypeScript -> out/
npm run watch         # recompile on save
npm run lint          # ESLint
npm run test:unit     # unit tests (seconds, no VS Code)
npm test              # compile + lint + integration tests in a downloaded VS Code
npm run package       # build sca.vsix (installable extension file)
npm run benchmark -- <project>   # run all checks headless and compare with <project>/expected_findings.csv
npm run analyze -- <project> [--format text|csv|sarif|html] [--out file] [--baseline] [--fail-on definite|possible|any]
npm run perf -- [files=5000] [template-project] [--max-seconds s]   # speed test
```
See [docs/tech-stack.md](docs/tech-stack.md) for tools and versions.

## Continuous integration
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:
unit and integration tests on Linux and Windows; on Linux also the car-control benchmark (fails on a false positive),
a 2,000-file speed test, a SARIF report and the `.vsix` package (both kept as build artifacts).

## Speed
5,000 files (~436,000 lines, copies of car-control) take about **9.6 s** on a laptop the first time (the value engine adds
about 3 s); unchanged files come from a cache (**~2 s** for all 5,000). Measure with `npm run perf`.

## Layout
```
installer.ps1             one-step build + install into VS Code (Windows)
catalog/                  rule catalog (rule sets, ISO 26262 mapping) + coverage presentation
src/extension.ts          extension entry point (VS Code API)
src/core/                 pure analyzer logic, no VS Code dependency (Finding model, issue store, scheduler)
src/core/parser/          C/C++ parser (tree-sitter, WASM) and syntax-tree helpers for checks
src/core/checks/          native checks (div-zero, coding rules; list + category map in index.ts)
src/core/engine/          value engine: control-flow graph, value ranges, solver, file summaries, Show CFG text
src/core/preprocess/      #if evaluation and macro table (small preprocessor for analysis)
src/core/project/         compile_commands.json, .sca.json, per-project context
src/core/                 also: justify.ts, baseline.ts, report.ts (CSV / SARIF / HTML)
src/cli/                  headless analysis (npm run analyze)
schemas/                  JSON schema for .sca.json
src/bench/                benchmark vs. answer key, speed test (not shipped in the extension)
src/monitor/              Issue Monitor view, editor diagnostics, status bar, save trigger (VS Code wiring)
scripts/copy-wasm.mjs     copies the parser .wasm files to out/parsers during `npm run compile`
media/                    icons
src/test/unit/            fast Mocha tests for src/core (no VS Code)
src/test/integration/     tests inside a real VS Code instance
tests/samples/            C/C++ inputs with expected findings (also the integration test workspace)
docs/                     user documentation
.vscode-test.mjs          integration test config (@vscode/test-cli)
```

## Goals
- Fast, incremental feedback inside the editor (LSP).
- Low false-positive rate; every false positive becomes a regression test.
- Standard output format (SARIF) for CI integration.

## Coding rules
Rules are described in our own words and referenced by ID only.
Official rule texts (e.g. MISRA) are copyrighted and are not included here.
