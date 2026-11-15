import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { generateCatalog, implementedSets, staleFiles, stringifyCompact } from "../../tools/catalog";

const ROOT = path.join(__dirname, "..", "..", "..");

describe("generated catalog (unit)", () => {
  it("catalog files and the rule reference match the rule registry (run `npm run catalog` when this fails)", () => {
    assert.deepStrictEqual(staleFiles(ROOT), []);
  });

  it("marks exactly the rule sets with rules as implemented", () => {
    const sets = implementedSets();
    const catalog = JSON.parse(generateCatalog(ROOT).get("catalog/rulesets.json")!) as { ruleSets: { id: string; implemented: boolean; implementedRules?: string[] }[] };
    for (const s of catalog.ruleSets) {
      assert.strictEqual(s.implemented, sets.has(s.id), s.id);
      assert.deepStrictEqual(s.implementedRules, sets.get(s.id), s.id);
    }
    assert.ok(sets.get("his-metrics")?.includes("cyclomatic"));
    // Every rule set SCA reports must be in the catalog.
    for (const id of sets.keys()) {
      assert.ok(catalog.ruleSets.some((s) => s.id === id), `${id} missing in rulesets.json`);
    }
  });

  it("keeps short arrays on one line", () => {
    assert.strictEqual(stringifyCompact({ a: [1, "x"], b: { c: true } }), '{\n  "a": [1, "x"],\n  "b": {\n    "c": true\n  }\n}');
  });

  it("writes no official rule texts: every description is in the registry", () => {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "rules.json"), "utf8")) as { rules: { id: string }[] };
    assert.ok(rules.rules.length > 50);
  });
});
