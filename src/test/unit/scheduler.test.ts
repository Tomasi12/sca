import * as assert from "assert";
import { AnalysisScheduler, Timers } from "../../core/scheduler";

/** Manual clock: timers fire only when the test calls `tick`. */
class FakeTimers implements Timers {
  private now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  get count(): number {
    return this.pending.size;
  }
  tick(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A scheduler whose runs can be held open, to test cancelling. */
function setup() {
  const timers = new FakeTimers();
  const runs: string[] = [];
  const aborted: string[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  const scheduler = new AnalysisScheduler(
    async (file, signal) => {
      runs.push(file);
      if (hold) {
        await new Promise<void>((r) => releases.push(r));
      }
      if (signal.aborted) {
        aborted.push(file);
      }
    },
    { delayMs: 300, timers }
  );
  return { timers, runs, aborted, releases, scheduler, holdRuns: () => (hold = true) };
}

describe("core/scheduler (unit)", () => {
  it("waits for the delay before it analyzes", async () => {
    const t = setup();
    t.scheduler.schedule("a.c");
    t.timers.tick(299);
    assert.deepStrictEqual(t.runs, []);
    t.timers.tick(1);
    await t.scheduler.whenIdle();
    assert.deepStrictEqual(t.runs, ["a.c"]);
  });

  it("restarts the wait when the same file is saved again (autosave burst -> one run)", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.scheduler.schedule("a.c");
      t.timers.tick(100);
    }
    assert.strictEqual(t.timers.count, 1);
    t.timers.tick(300);
    await t.scheduler.whenIdle();
    assert.deepStrictEqual(t.runs, ["a.c"]);
  });

  it("keeps separate waits for different files", async () => {
    const t = setup();
    t.scheduler.schedule("a.c");
    t.scheduler.schedule("b.c");
    t.timers.tick(300);
    await t.scheduler.whenIdle();
    assert.deepStrictEqual([...t.runs].sort(), ["a.c", "b.c"]);
  });

  it("cancels the older run when a newer run of the same file starts", async () => {
    const t = setup();
    t.holdRuns();
    t.scheduler.schedule("a.c");
    t.timers.tick(300);
    await flush();
    assert.strictEqual(t.scheduler.running, 1);
    t.scheduler.schedule("a.c");
    t.timers.tick(300);
    await flush();
    assert.strictEqual(t.scheduler.running, 1, "only the newest run counts");
    t.releases.forEach((r) => r());
    await t.scheduler.whenIdle();
    assert.deepStrictEqual(t.runs, ["a.c", "a.c"]);
    assert.deepStrictEqual(t.aborted, ["a.c"], "the first run saw the abort");
  });

  it("runNow skips the wait and drops a pending timer", async () => {
    const t = setup();
    t.scheduler.schedule("a.c");
    await t.scheduler.runNow(["a.c", "b.c"]);
    assert.strictEqual(t.timers.count, 0);
    assert.deepStrictEqual(t.runs, ["a.c", "b.c"]);
  });

  it("reports busy / idle changes", async () => {
    const t = setup();
    const seen: boolean[] = [];
    t.scheduler.onDidChangeBusy((b) => seen.push(b));
    t.scheduler.schedule("a.c");
    assert.strictEqual(t.scheduler.busy, true);
    t.timers.tick(300);
    await t.scheduler.whenIdle();
    assert.strictEqual(t.scheduler.busy, false);
    assert.deepStrictEqual(seen, [true, false]);
  });

  it("cancel() stops waiting timers, so nothing runs", async () => {
    const t = setup();
    t.scheduler.schedule("a.c");
    t.scheduler.cancel("a.c");
    t.timers.tick(1000);
    await flush();
    assert.deepStrictEqual(t.runs, []);
    assert.strictEqual(t.scheduler.busy, false);
  });

  it("cancel() aborts a running analysis", async () => {
    const t = setup();
    t.holdRuns();
    const done = t.scheduler.runNow(["a.c"]);
    await flush();
    t.scheduler.cancel();
    t.releases.forEach((r) => r());
    await done;
    assert.deepStrictEqual(t.aborted, ["a.c"]);
  });

  it("uses the key function to treat paths as the same file", async () => {
    const timers = new FakeTimers();
    const runs: string[] = [];
    const s = new AnalysisScheduler(async (f) => void runs.push(f), { delayMs: 10, timers, key: (f) => f.toLowerCase() });
    s.schedule("A.c");
    s.schedule("a.C");
    assert.strictEqual(timers.count, 1);
    timers.tick(10);
    await s.whenIdle();
    assert.strictEqual(runs.length, 1);
  });

  it("reports errors and keeps working", async () => {
    const errors: string[] = [];
    let fail = true;
    const s = new AnalysisScheduler(
      async () => {
        if (fail) {
          throw new Error("boom");
        }
      },
      { delayMs: 0, onError: (f, e) => errors.push(`${f}: ${(e as Error).message}`) }
    );
    await s.runNow(["a.c"]);
    fail = false;
    await s.runNow(["a.c"]);
    assert.deepStrictEqual(errors, ["a.c: boom"]);
    assert.strictEqual(s.busy, false);
  });

  it("does nothing after dispose", async () => {
    const t = setup();
    t.scheduler.dispose();
    t.scheduler.schedule("a.c");
    await t.scheduler.runNow(["b.c"]);
    t.timers.tick(1000);
    assert.deepStrictEqual(t.runs, []);
  });
});
