// The set of files and folders the user put "in the monitor". Only monitored C/C++ files are analyzed.
// Pure logic (no VS Code API).

import * as path from "path";

export type EntryKind = "file" | "folder";

export interface MonitorEntry {
  readonly path: string;
  readonly kind: EntryKind;
}

/** Absolute, normalized path with an upper-case drive letter (Windows), so the same file always looks the same. */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  return /^[a-z]:/.test(resolved) ? resolved[0].toUpperCase() + resolved.slice(1) : resolved;
}

export class MonitorSet {
  private readonly entries = new Map<string, MonitorEntry>();
  private readonly listeners = new Set<() => void>();

  /** Windows paths are case-insensitive; default follows the current platform. */
  constructor(private readonly caseInsensitive = process.platform === "win32") {}

  private key(p: string): string {
    return this.caseInsensitive ? p.toLowerCase() : p;
  }

  /** Adds entries; returns the ones that were new. */
  add(newEntries: readonly MonitorEntry[]): MonitorEntry[] {
    const added: MonitorEntry[] = [];
    for (const e of newEntries) {
      const entry = { path: canonicalPath(e.path), kind: e.kind };
      const k = this.key(entry.path);
      if (!this.entries.has(k)) {
        this.entries.set(k, entry);
        added.push(entry);
      }
    }
    if (added.length > 0) {
      this.emit();
    }
    return added;
  }

  /** Removes entries by exact path; returns the ones that were removed. */
  remove(paths: readonly string[]): MonitorEntry[] {
    const removed: MonitorEntry[] = [];
    for (const p of paths) {
      const k = this.key(canonicalPath(p));
      const e = this.entries.get(k);
      if (e) {
        this.entries.delete(k);
        removed.push(e);
      }
    }
    if (removed.length > 0) {
      this.emit();
    }
    return removed;
  }

  clear(): void {
    if (this.entries.size > 0) {
      this.entries.clear();
      this.emit();
    }
  }

  list(): MonitorEntry[] {
    return [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The entry that makes `file` monitored: the file itself, or the closest monitored folder above it. */
  coveringEntry(file: string): MonitorEntry | undefined {
    const f = this.key(canonicalPath(file));
    const exact = this.entries.get(f);
    if (exact) {
      return exact;
    }
    let best: MonitorEntry | undefined;
    for (const [k, e] of this.entries) {
      const prefix = k.endsWith(path.sep) ? k : k + path.sep;
      if (e.kind === "folder" && f.startsWith(prefix) && (!best || e.path.length > best.path.length)) {
        best = e;
      }
    }
    return best;
  }

  isMonitored(file: string): boolean {
    return this.coveringEntry(file) !== undefined;
  }

  /** For saving in workspace state. */
  toJSON(): MonitorEntry[] {
    return this.list();
  }

  /** Restores saved entries; silently skips malformed ones. */
  static fromJSON(data: unknown, caseInsensitive?: boolean): MonitorSet {
    const set = new MonitorSet(caseInsensitive);
    if (Array.isArray(data)) {
      set.add(
        data.filter(
          (e): e is MonitorEntry =>
            typeof e === "object" && e !== null && typeof e.path === "string" && e.path !== "" &&
            (e.kind === "file" || e.kind === "folder")
        )
      );
    }
    return set;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      l();
    }
  }
}
