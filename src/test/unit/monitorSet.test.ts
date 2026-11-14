import * as assert from "assert";
import * as path from "path";
import { isSourceFile, SOURCE_GLOB } from "../../core/languages";
import { canonicalPath, MonitorSet } from "../../core/monitorSet";

const root = path.resolve("/work/proj");
const p = (...parts: string[]) => path.join(root, ...parts);

describe("core/monitorSet (unit)", () => {
  it("adds files and folders once, and lists them sorted", () => {
    const s = new MonitorSet(false);
    const added = s.add([
      { path: p("src"), kind: "folder" },
      { path: p("main.c"), kind: "file" },
      { path: p("src"), kind: "folder" },
    ]);
    assert.strictEqual(added.length, 2);
    assert.deepStrictEqual(s.list().map((e) => e.path), [p("main.c"), p("src")]);
  });

  it("covers a file directly or through the closest monitored folder", () => {
    const s = new MonitorSet(false);
    s.add([{ path: p("src"), kind: "folder" }, { path: p("src", "drv"), kind: "folder" }, { path: p("main.c"), kind: "file" }]);
    assert.strictEqual(s.coveringEntry(p("main.c"))?.kind, "file");
    assert.strictEqual(s.coveringEntry(p("src", "adc.c"))?.path, p("src"));
    assert.strictEqual(s.coveringEntry(p("src", "drv", "can.c"))?.path, p("src", "drv"));
    assert.strictEqual(s.isMonitored(p("other.c")), false);
  });

  it("does not treat a sibling folder with the same prefix as covered", () => {
    const s = new MonitorSet(false);
    s.add([{ path: p("src"), kind: "folder" }]);
    assert.strictEqual(s.isMonitored(p("src2", "a.c")), false);
  });

  it("does not cover files under a monitored *file* path", () => {
    const s = new MonitorSet(false);
    s.add([{ path: p("x.c"), kind: "file" }]);
    assert.strictEqual(s.isMonitored(p("x.c", "y.c")), false);
  });

  it("ignores case when asked to (Windows)", () => {
    const s = new MonitorSet(true);
    s.add([{ path: p("Src"), kind: "folder" }]);
    assert.ok(s.isMonitored(p("SRC", "a.c")));
    assert.strictEqual(s.add([{ path: p("src"), kind: "folder" }]).length, 0);
  });

  it("removes by exact path and reports what was removed", () => {
    const s = new MonitorSet(false);
    s.add([{ path: p("src"), kind: "folder" }]);
    assert.deepStrictEqual(s.remove([p("src", "a.c")]), []);
    assert.strictEqual(s.remove([p("src")]).length, 1);
    assert.deepStrictEqual(s.list(), []);
  });

  it("notifies on real changes only", () => {
    const s = new MonitorSet(false);
    let n = 0;
    s.onDidChange(() => n++);
    s.add([{ path: p("a.c"), kind: "file" }]);
    s.add([{ path: p("a.c"), kind: "file" }]);
    s.remove([p("missing.c")]);
    s.clear();
    s.clear();
    assert.strictEqual(n, 2);
  });

  it("round-trips through JSON and skips malformed entries", () => {
    const s = new MonitorSet(false);
    s.add([{ path: p("src"), kind: "folder" }, { path: p("a.c"), kind: "file" }]);
    const back = MonitorSet.fromJSON(JSON.parse(JSON.stringify(s)), false);
    assert.deepStrictEqual(back.list(), s.list());
    const junk = MonitorSet.fromJSON([null, 3, { path: "" , kind: "file" }, { path: p("b.c"), kind: "disk" }, { path: p("c.c"), kind: "file" }], false);
    assert.deepStrictEqual(junk.list().map((e) => e.path), [p("c.c")]);
    assert.deepStrictEqual(MonitorSet.fromJSON(undefined).list(), []);
  });

  it("canonicalizes paths (absolute, upper-case drive letter)", () => {
    assert.ok(path.isAbsolute(canonicalPath("rel/x.c")));
    if (process.platform === "win32") {
      assert.strictEqual(canonicalPath("c:\\a\\b.c"), "C:\\a\\b.c");
    }
  });
});

describe("core/languages source files (unit)", () => {
  it("recognizes C/C++ sources and headers by extension", () => {
    for (const f of ["a.c", "a.H", "dir/a.cpp", "a.cc", "a.cxx", "a.hpp", "a.hh", "a.hxx"]) {
      assert.ok(isSourceFile(f), f);
    }
    for (const f of ["a.txt", "Makefile", "dir.c/readme", "a.cs", ".c"]) {
      assert.strictEqual(isSourceFile(f), f === ".c", f);
    }
  });

  it("builds a glob with all extensions", () => {
    assert.strictEqual(SOURCE_GLOB, "**/*.{c,h,cpp,cc,cxx,hpp,hh,hxx}");
  });
});
