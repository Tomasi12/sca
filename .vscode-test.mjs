import { defineConfig } from "@vscode/test-cli";

// Integration tests: run inside a real VS Code instance (Extension Development Host).
export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  version: "stable",
  workspaceFolder: "./tests/samples",
  launchArgs: ["--disable-extensions"],
  mocha: {
    ui: "bdd",
    timeout: 20000
  }
});
