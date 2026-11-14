# Tech stack

What SCA is built with, and why. Versions are the ones installed on 2026-11-11.

## Overview

| Layer | Tool | Version | Purpose |
|---|---|---|---|
| Runtime | Node.js | 24.21.0 | Runs build, lint and test tools |
| Package manager | npm | 11.19.0 | Installs dependencies (`package.json`, `package-lock.json`) |
| Editor / host | Visual Studio Code | 1.144.0 (dev), 1.146.0 (tests) | The extension runs inside VS Code |
| Language | TypeScript | 6.0.3 | Extension source code |
| Lint | ESLint + typescript-eslint | 10.14.0 / 8.72.2 | Code quality checks |
| Unit tests | Mocha | 12.0.3 | Fast tests without VS Code |
| Integration tests | @vscode/test-cli + @vscode/test-electron | 0.0.15 / 3.1.0 | Tests inside a real VS Code instance |
| Parser | web-tree-sitter + tree-sitter-c / tree-sitter-cpp | 0.27.2 / 0.24.1 / 0.23.4 | C/C++ syntax trees (WASM, no native build) |
| Packaging | @vscode/vsce | 4.1.0 | Builds `sca.vsix` (`npm run package`) |
| Installer | PowerShell script `installer.ps1` | Windows PowerShell 5.1+ | One-step build + install into VS Code |
| Version control | Git + GitHub | 2.55.0 | Code at github.com/Tomasi12/sca |

## Runtime and editor

- **VS Code API target:** `engines.vscode = ^1.100.0` → the extension works on VS Code 1.100 and newer.
- **`@types/vscode` 1.100.0** is pinned with `~` so its API types are never newer than `engines`
  (otherwise we could call APIs that older supported VS Code versions do not have).
- **Activation:** the extension starts when a C or C++ file is opened (`onLanguage:c`, `onLanguage:cpp`).
- **Commands:** `SCA: Show Info`, `SCA: Add to Monitor`, `SCA: Remove from Monitor`, `SCA: Remove All from Monitor`, `SCA: Analyze Now`.

## Language and build

- **TypeScript 6**, compiled with plain `tsc` (no bundler yet). Output goes to `out/`.
- `tsconfig.json`: `module: Node16`, `target: ES2022`, `strict: true`.
- **Note:** TypeScript 6 no longer loads `@types/*` packages automatically (`types` defaults to `[]`),
  so `tsconfig.json` lists `"types": ["node", "mocha"]` explicitly.
- Type packages: `@types/node` 22, `@types/mocha` 10, `@types/vscode` 1.100.

## Parser

- **tree-sitter**, loaded as WebAssembly through `web-tree-sitter` (a runtime dependency, shipped in the `.vsix`).
  No native compile step, so it works the same on every OS.
- The grammars come from the `tree-sitter-c` and `tree-sitter-cpp` packages (dev dependencies, installed with
  `--ignore-scripts`; only their prebuilt `.wasm` is used). `npm run compile` copies the runtime and grammar `.wasm`
  files to `out/parsers/` (`scripts/copy-wasm.mjs`).
- Code: `src/core/parser/parser.ts` (`SourceParser`, `walk`, `nodeRange`). Columns are in UTF-16 characters, as in VS Code.
- **Limit:** the tree is built from the source *before* preprocessing — macros are not expanded and every `#if`
  branch is parsed. Checks must handle this.

## Code quality

- **ESLint 10** with the flat config `eslint.config.mjs`.
- **typescript-eslint** recommended rules, plus `curly`, `eqeqeq`, `no-throw-literal`.

## Testing

Two levels, following Microsoft's recommended setup for extensions:

| Level | Location | Runner | Needs VS Code? | Speed |
|---|---|---|---|---|
| Unit | `src/test/unit/` | Mocha | No | milliseconds |
| Integration | `src/test/integration/` | `@vscode/test-cli` (Mocha inside VS Code) | Yes, downloaded automatically | seconds |

- **Unit tests** cover pure logic in `src/core/` (no `vscode` imports allowed there).
- **Integration tests** start a separate VS Code ("Extension Development Host"), open `tests/samples/`
  as the workspace, disable other extensions, and check activation and commands.
- Config: `.vscode-test.mjs`. The test VS Code is cached in `.vscode-test/` (git-ignored).

## Commands

```bash
npm install          # install dependencies
npm run compile      # TypeScript -> out/, parser .wasm -> out/parsers/
npm run watch        # recompile on save
npm run lint         # ESLint
npm run test:unit    # unit tests
npm test             # compile + lint + integration tests
npm run benchmark -- <project>  # headless run vs. expected_findings.csv
```
In VS Code, **F5** launches the extension in a development window (`.vscode/launch.json`).

## Project layout

```
src/extension.ts          entry point, VS Code wiring only
src/core/                 analyzer logic (pure TypeScript)
src/core/parser/          C/C++ parser (tree-sitter)
src/monitor/              Issue Monitor, status bar, save trigger (VS Code wiring)
scripts/                  build helpers (copy-wasm.mjs)
src/core/checks/          native checks
src/bench/                headless benchmark (npm run benchmark)
src/test/unit/            unit tests
src/test/integration/     integration tests
tests/samples/            C/C++ sample files with expected findings
docs/                     documentation (this file)
.vscode/                  launch config, recommended extensions
.vscode-test.mjs          integration test config
eslint.config.mjs         lint config
tsconfig.json             TypeScript config
.vscodeignore             files excluded from the packaged extension
```

## Recommended VS Code extensions (for development)

- `dbaeumer.vscode-eslint` — shows lint errors in the editor.
- `ms-vscode.extension-test-runner` — run integration tests from the Testing view.

## Not used yet (planned / open)

- **Bundler** (esbuild) — before publishing.
- **LICENSE** — packaging currently uses `--skip-license`; choose a license before publishing.
- **Marketplace publishing.**
- **CI** (GitHub Actions) to run tests on every push.
- **Language Server Protocol** (LSP) for the analyzer engine.
- **SARIF** output for CI integration.
