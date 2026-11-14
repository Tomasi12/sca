// Collects the C/C++ files of a project folder for headless runs.

import * as fs from "fs";
import * as path from "path";
import { isSourceFile } from "../core/languages";

/** Folders never analyzed headless (build output, dependencies, tool folders). */
export const SKIP_DIRS = new Set(["build", "out", "third_party", "node_modules", ".git", "tools", ".vscode", ".vscode-test"]);

/** Turns a simple glob (`**`, `*`, `?`) into a RegExp on forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

export function sourceFiles(root: string, exclude: readonly string[] = []): string[] {
  const patterns = exclude.map(globToRegExp);
  const excluded = (rel: string) => patterns.some((p) => p.test(rel) || p.test(rel + "/"));
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !excluded(rel + "/")) {
          visit(full);
        }
      } else if (isSourceFile(e.name) && !excluded(rel)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}
