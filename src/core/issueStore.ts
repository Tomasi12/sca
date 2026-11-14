// Holds the current findings per file. The Issue Monitor view and the editor diagnostics both read from here.
// Pure logic (no VS Code API).

import { compareFindings, Finding, findingKey, FindingSummary, summarize } from "./finding";

export type IssueStoreListener = (changedFiles: readonly string[]) => void;

export class IssueStore {
  private readonly byFile = new Map<string, readonly Finding[]>();
  /** Findings hidden by the baseline, per file (only counted). */
  private readonly hidden = new Map<string, number>();
  private readonly listeners = new Set<IssueStoreListener>();

  /**
   * Replaces all findings of one file (the result of one analysis run).
   * Findings for other files are ignored; duplicates (same key) are kept once; the list is sorted.
   * `hiddenByBaseline` counts findings that exist but are not shown because they are in the baseline.
   */
  setFindings(file: string, findings: readonly Finding[], hiddenByBaseline = 0): void {
    const seen = new Set<string>();
    const unique: Finding[] = [];
    for (const f of findings) {
      const key = findingKey(f);
      if (f.file === file && !seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }
    unique.sort(compareFindings);
    this.byFile.set(file, unique);
    this.hidden.set(file, hiddenByBaseline);
    this.emit([file]);
  }

  /** Forgets a file entirely (e.g. removed from the monitor). */
  clearFile(file: string): void {
    if (this.byFile.delete(file)) {
      this.hidden.delete(file);
      this.emit([file]);
    }
  }

  clearAll(): void {
    const files = [...this.byFile.keys()];
    if (files.length > 0) {
      this.byFile.clear();
      this.hidden.clear();
      this.emit(files);
    }
  }

  /** Files that have been analyzed, sorted. A file with zero findings is still listed. */
  files(): string[] {
    return [...this.byFile.keys()].sort((a, b) => a.localeCompare(b));
  }

  findingsFor(file: string): readonly Finding[] {
    return this.byFile.get(file) ?? [];
  }

  allFindings(): Finding[] {
    return this.files().flatMap((f) => this.findingsFor(f));
  }

  /** Findings hidden by the baseline, for one file or all. */
  hiddenCount(file?: string): number {
    if (file !== undefined) {
      return this.hidden.get(file) ?? 0;
    }
    let n = 0;
    this.hidden.forEach((v) => (n += v));
    return n;
  }

  summary(file?: string): FindingSummary {
    return summarize(file === undefined ? this.allFindings() : this.findingsFor(file));
  }

  /** Subscribes to changes; returns a function that unsubscribes. */
  onDidChange(listener: IssueStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(files: readonly string[]): void {
    for (const l of [...this.listeners]) {
      l(files);
    }
  }
}
