import * as assert from "assert";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "../../core/languages";

describe("core/languages (unit)", () => {
  it("supports C and C++", () => {
    assert.ok(isSupportedLanguage("c"));
    assert.ok(isSupportedLanguage("cpp"));
  });

  it("rejects other languages", () => {
    assert.strictEqual(isSupportedLanguage("python"), false);
    assert.strictEqual(isSupportedLanguage(""), false);
  });

  it("lists exactly the supported languages", () => {
    assert.deepStrictEqual([...SUPPORTED_LANGUAGES], ["c", "cpp"]);
  });
});
