// Pure logic (no VS Code API) lives in src/core so it can be unit-tested fast, without VS Code.

export const SUPPORTED_LANGUAGES: readonly string[] = ["c", "cpp"];

export function isSupportedLanguage(languageId: string): boolean {
  return SUPPORTED_LANGUAGES.includes(languageId);
}
