# SCA — Static Code Analyzer

SCA checks C/C++ code **as you write it** and reports likely run-time errors
(division by zero, overflow, out-of-bounds, null dereference, uninitialized reads, ...)
and coding-rule violations.

SCA is a **VS Code extension**.

> Status: early development. Activates on C/C++ files, shows the **SCA → Issue Monitor** view; files and folders can be added to the monitor and are analyzed on every save. Checks: possible division by zero, `switch` without `default`, `goto`. A headless benchmark compares the results with an answer key.

## Contents
- [Quick install with `installer.ps1`](#quick-install-with-installerps1) ← start here
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

- Only C/C++ files are monitored (`.c .h .cpp .cc .cxx .hpp .hh .hxx`). A monitored folder includes all of them below it.
- Folders matching `sca.monitor.exclude` are skipped (default: `node_modules`, `.git`, `third_party`, `build`, `out`).
- A file monitored through its folder is removed by removing the folder.
- The monitor is remembered per workspace.
- Findings appear in the Issue Monitor (definite = error, possible = warning) and as squiggles in the Problems panel.
  See [Checks](#checks) for what is checked today.

#### Checks
| Rule ID | Reports | Certainty |
|---|---|---|
| `runtime-bugfinder:div-zero` | `/` or `%` (also `/=`, `%=`) by the constant 0 | definite (error) |
| `runtime-bugfinder:div-zero` | `/` or `%` by a function parameter that is not checked against 0 first | possible (warning) |
| `sca-own:switch-default` | `switch` without a `default` clause (a nested switch needs its own) | definite (warning) |
| `sca-own:goto` | every `goto` statement | definite (warning) |

A parameter counts as checked when the division is only reached after a test that rules out 0:
`if (n != 0)`, `if (n > 0)`, `if (n)`, `n ? a / n : 0`, `n != 0 && ...`, the `else` of `if (n == 0)`,
an earlier `if (n == 0) return ...;` (or `goto` / `break` / `continue` / `abort()`), or an earlier `assert(n != 0)`.
A `static` function whose callers in the file all pass a non-zero constant is not reported.

Not checked yet: globals, struct fields, locals and return values as divisors (needs value tracking).
Functions that tree-sitter cannot fully parse (often because of macros) are skipped.
Examples: [tests/samples/div_by_zero_cases.c](tests/samples/div_by_zero_cases.c), [tests/samples/coding_rules.c](tests/samples/coding_rules.c).

#### When files are analyzed
- When a file is added to the monitor.
- **Every time a monitored file is saved** — by `Ctrl+S` or by autosave (`File → Auto Save`).
  SCA waits a short time after the save (`sca.analysis.debounceMs`, default 300 ms); another save within that time restarts the wait,
  so a burst of autosaves gives one analysis. A newer analysis of the same file cancels the older one.
- On **SCA: Analyze Now**.
- Turn off analysis on save with `sca.analysis.runOnSave: false`.

The status bar shows **SCA: analyzing…** while it works and **SCA: N issues** when done; click it to open the Issue Monitor.

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
Fast unit tests — you should see `69 passing`.
```bash
npm test
```
Lint + integration tests. The first run downloads a separate copy of VS Code
into `.vscode-test/` (about 1 GB on disk after unpacking), then you should see `20 passing`.

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

Result on car-control today: **7 of 10** expected issues found in the covered categories (`div_zero` 3/6, `switch_default` 1/1,
`goto` 3/3), **0 false positives**, 0 unmarked findings.

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
```
See [docs/tech-stack.md](docs/tech-stack.md) for tools and versions.

## Layout
```
installer.ps1             one-step build + install into VS Code (Windows)
catalog/                  rule catalog (rule sets, ISO 26262 mapping) + coverage presentation
src/extension.ts          extension entry point (VS Code API)
src/core/                 pure analyzer logic, no VS Code dependency (Finding model, issue store, scheduler)
src/core/parser/          C/C++ parser (tree-sitter, WASM) and syntax-tree helpers for checks
src/core/checks/          native checks (div-zero, coding rules; list + category map in index.ts)
src/bench/                headless benchmark (not shipped in the extension)
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
