// Decides *when* a file is analyzed: waits a short time after a save (autosave can save often),
// runs one analysis per file at a time and cancels an older run when a newer one starts.
// Pure logic (no VS Code API); timers can be replaced in unit tests.

/** Runs the analysis of one file. Should stop early (and store nothing) once `signal.aborted` is true. */
export type RunFn = (file: string, signal: AbortSignal) => Promise<void>;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  /** Wait time after the last request for a file before it is analyzed. */
  delayMs: number;
  timers?: Timers;
  /** Maps a file path to the key used to find "the same file" (e.g. lower-case on Windows). */
  key?: (file: string) => string;
  /** Called when a run throws; the scheduler keeps working. */
  onError?: (file: string, err: unknown) => void;
}

interface FileState {
  file: string;
  timer?: unknown;
  run?: { controller: AbortController; done: Promise<void> };
}

export class AnalysisScheduler {
  delayMs: number;
  private readonly timers: Timers;
  private readonly key: (file: string) => string;
  private readonly onError: (file: string, err: unknown) => void;
  private readonly states = new Map<string, FileState>();
  private readonly listeners = new Set<(busy: boolean) => void>();
  private readonly stateListeners = new Set<() => void>();
  private lastBusy = false;
  private disposed = false;

  constructor(private readonly runFn: RunFn, options: SchedulerOptions) {
    this.delayMs = options.delayMs;
    this.timers = options.timers ?? realTimers;
    this.key = options.key ?? ((f) => f);
    this.onError = options.onError ?? (() => undefined);
  }

  /** True while any file waits for its timer or is being analyzed. */
  get busy(): boolean {
    for (const s of this.states.values()) {
      if (s.timer !== undefined || s.run) {
        return true;
      }
    }
    return false;
  }

  /** Number of files whose analysis is running right now. */
  get running(): number {
    let n = 0;
    for (const s of this.states.values()) {
      if (s.run) {
        n++;
      }
    }
    return n;
  }

  /** Asks for an analysis after the delay; a new request for the same file restarts the wait. */
  schedule(file: string, delayMs = this.delayMs): void {
    if (this.disposed) {
      return;
    }
    const state = this.stateFor(file);
    if (state.timer !== undefined) {
      this.timers.clear(state.timer);
    }
    state.timer = this.timers.set(() => {
      state.timer = undefined;
      void this.start(state);
    }, delayMs);
    this.emit();
  }

  /** Analyzes the files at once (no wait), cancelling older runs of the same files. Resolves when all are done. */
  async runNow(files: readonly string[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    const runs = files.map((f) => {
      const state = this.stateFor(f);
      if (state.timer !== undefined) {
        this.timers.clear(state.timer);
        state.timer = undefined;
      }
      return this.start(state);
    });
    await Promise.all(runs);
  }

  /** Stops waiting timers and cancels running analyses; for one file or for all. */
  cancel(file?: string): void {
    const states = file === undefined ? [...this.states.values()] : [this.states.get(this.key(file))].filter((s) => s);
    for (const s of states as FileState[]) {
      if (s.timer !== undefined) {
        this.timers.clear(s.timer);
        s.timer = undefined;
      }
      s.run?.controller.abort();
    }
    this.emit();
  }

  /** Resolves once nothing waits or runs (used by tests and by "Analyze now"). */
  async whenIdle(): Promise<void> {
    while (this.busy) {
      const runs = [...this.states.values()].map((s) => s.run?.done).filter((d): d is Promise<void> => d !== undefined);
      if (runs.length > 0) {
        await Promise.all(runs);
      } else {
        // Only timers are waiting: wake up on the next state change (a timer fired, or a cancel).
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.stateListeners.delete(wake);
            resolve();
          };
          this.stateListeners.add(wake);
        });
      }
    }
  }

  /** Fires when the scheduler goes from idle to busy or back. Returns an unsubscribe function. */
  onDidChangeBusy(listener: (busy: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.listeners.clear();
    for (const wake of [...this.stateListeners]) {
      wake();
    }
  }

  private stateFor(file: string): FileState {
    const k = this.key(file);
    let state = this.states.get(k);
    if (!state) {
      state = { file };
      this.states.set(k, state);
    }
    return state;
  }

  private start(state: FileState): Promise<void> {
    state.run?.controller.abort();
    const controller = new AbortController();
    const done = (async () => {
      try {
        await this.runFn(state.file, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          this.onError(state.file, err);
        }
      } finally {
        if (state.run?.controller === controller) {
          state.run = undefined;
        }
        this.cleanup(state);
        this.emit();
      }
    })();
    state.run = { controller, done };
    this.emit();
    return done;
  }

  private cleanup(state: FileState): void {
    if (state.timer === undefined && !state.run) {
      this.states.delete(this.key(state.file));
    }
  }

  private emit(): void {
    for (const wake of [...this.stateListeners]) {
      wake();
    }
    const busy = this.busy;
    if (busy !== this.lastBusy) {
      this.lastBusy = busy;
      for (const l of [...this.listeners]) {
        l(busy);
      }
    }
  }
}
