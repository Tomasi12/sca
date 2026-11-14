// Copies the tree-sitter runtime and the C/C++ grammars (.wasm) to out/parsers, where the extension loads them.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "out", "parsers");
mkdirSync(target, { recursive: true });

const files = [
  ["web-tree-sitter", "web-tree-sitter.wasm"],
  ["tree-sitter-c", "tree-sitter-c.wasm"],
  ["tree-sitter-cpp", "tree-sitter-cpp.wasm"],
];
for (const [pkg, file] of files) {
  const from = join(root, "node_modules", pkg, file);
  copyFileSync(from, join(target, file));
  console.log(`copied ${pkg}/${file} -> out/parsers/${file}`);
}
