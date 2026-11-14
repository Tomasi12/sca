// One analyzed project (a workspace folder, or the folder given to the CLI):
// its .sca.json, its compile database, and a cached view of its headers.
// Uses the file system through `readFile`, so tests can pass their own.

import * as fs from "fs";
import * as path from "path";
import { PreprocessEnv } from "../preprocess/preprocessor";
import { CompileDatabase } from "./compileCommands";
import { CONFIG_FILE, emptyConfig, parseConfig, ScaConfig } from "./config";

/** Everything the analyzer needs to know about one file's surroundings. */
export interface FileContext {
  readonly env?: PreprocessEnv;
  readonly config?: ScaConfig;
  /** Path relative to the project root, forward slashes (for deviations in .sca.json). */
  readonly relPath?: string;
  /** Changes whenever the project setup changes; part of the analysis cache key. */
  readonly version: string;
}

export type ReadFile = (file: string) => string | undefined;

export const fsReadFile: ReadFile = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Where we look for a compile database when .sca.json does not say. */
export const COMPILE_DB_CANDIDATES = ["compile_commands.json", "build/compile_commands.json", "out/compile_commands.json", "cmake-build-debug/compile_commands.json"];

let nextId = 1;

export class Project {
  /** Messages about the setup (bad .sca.json, unreadable compile database, ...). */
  readonly problems: string[] = [];
  readonly config: ScaConfig;
  readonly db?: CompileDatabase;
  readonly dbPath?: string;
  readonly configPath?: string;
  private readonly id = nextId++;
  private generation = 0;
  private readonly headers = new Map<string, string | undefined>();

  private constructor(
    readonly root: string,
    private readonly readFile: ReadFile,
    setup: { config: ScaConfig; configPath?: string; db?: CompileDatabase; dbPath?: string; problems: string[] }
  ) {
    this.config = setup.config;
    this.configPath = setup.configPath;
    this.db = setup.db;
    this.dbPath = setup.dbPath;
    this.problems.push(...setup.problems);
  }

  /** Reads .sca.json and the compile database below `root`. Never throws; problems are collected. */
  static load(root: string, readFile: ReadFile = fsReadFile): Project {
    const problems: string[] = [];
    const configPath = path.join(root, CONFIG_FILE);
    const configText = readFile(configPath);
    let config = emptyConfig();
    if (configText !== undefined) {
      const parsed = parseConfig(configText);
      config = parsed.config;
      problems.push(...parsed.problems.map((p) => `${CONFIG_FILE}: ${p}`));
    }
    const candidates = config.compileCommands ? [config.compileCommands] : COMPILE_DB_CANDIDATES;
    let db: CompileDatabase | undefined;
    let dbPath: string | undefined;
    for (const c of candidates) {
      const p = path.resolve(root, c);
      const text = readFile(p);
      if (text === undefined) {
        continue;
      }
      try {
        db = CompileDatabase.parse(text);
        dbPath = p;
      } catch (err) {
        problems.push(`${c}: ${(err as Error).message}`);
      }
      break;
    }
    if (config.compileCommands && !dbPath && !problems.some((p) => p.startsWith(config.compileCommands!))) {
      problems.push(`${CONFIG_FILE}: compileCommands "${config.compileCommands}" not found.`);
    }
    return new Project(root, readFile, { config, configPath: configText !== undefined ? configPath : undefined, db, dbPath, problems });
  }

  get version(): string {
    return `${this.id}.${this.generation}`;
  }

  /** Call when a header may have changed: drops cached headers and invalidates cached results. */
  invalidateHeaders(): void {
    this.headers.clear();
    this.generation++;
  }

  contains(file: string): boolean {
    const rel = path.relative(this.root, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  relPath(file: string): string {
    return path.relative(this.root, file).replace(/\\/g, "/");
  }

  contextFor(file: string): FileContext {
    const flags = this.db?.flagsFor(file);
    const defines = new Map(flags?.defines ?? []);
    for (const [k, v] of Object.entries(this.config.defines)) {
      defines.set(k, v);
    }
    const includePaths = [...(flags?.includePaths ?? []), ...this.config.includePaths.map((p) => path.resolve(this.root, p))];
    const env: PreprocessEnv = {
      defines,
      undefines: flags?.undefines,
      includePaths,
      forcedIncludes: flags?.forcedIncludes,
      complete: flags !== undefined,
      readFile: (f) => this.header(f),
    };
    return { env, config: this.config, relPath: this.relPath(file), version: this.version };
  }

  private header(file: string): string | undefined {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (!this.headers.has(key)) {
      this.headers.set(key, this.readFile(file));
    }
    return this.headers.get(key);
  }
}
