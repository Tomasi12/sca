# SCA — Static Code Analyzer

SCA checks C/C++ code **as you write it** and reports likely run-time errors
(division by zero, overflow, out-of-bounds, null dereference, uninitialized reads, ...)
and coding-rule violations.

SCA is a **VS Code extension**.

> Status: empty extension skeleton. Activates on C/C++ files and offers `SCA: Show Info`. No analysis yet.

## Layout
```
src/extension.ts          extension entry point (VS Code API)
src/core/                 pure analyzer logic, no VS Code dependency
src/test/unit/            fast Mocha tests for src/core (no VS Code)
src/test/integration/     tests inside a real VS Code instance
tests/samples/            C/C++ inputs with expected findings (also the integration test workspace)
docs/                     user documentation
.vscode-test.mjs          integration test config (@vscode/test-cli)
```

## Installation — step by step

SCA is not on the VS Code Marketplace yet. You run it from source.

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
Fast unit tests — you should see `3 passing`.
```bash
npm test
```
Lint + integration tests. The first run downloads a separate copy of VS Code
into `.vscode-test/` (about 1 GB on disk after unpacking), then you should see `4 passing`.

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

## Commands (reference)
```bash
npm install           # install dependencies
npm run compile       # TypeScript -> out/
npm run watch         # recompile on save
npm run lint          # ESLint
npm run test:unit     # unit tests (seconds, no VS Code)
npm test              # compile + lint + integration tests in a downloaded VS Code
```
See [docs/tech-stack.md](docs/tech-stack.md) for tools and versions.

## Goals
- Fast, incremental feedback inside the editor (LSP).
- Low false-positive rate; every false positive becomes a regression test.
- Standard output format (SARIF) for CI integration.

## Coding rules
Rules are described in our own words and referenced by ID only.
Official rule texts (e.g. MISRA) are copyrighted and are not included here.
