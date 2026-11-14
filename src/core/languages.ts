// Pure logic (no VS Code API) lives in src/core so it can be unit-tested fast, without VS Code.

export const SUPPORTED_LANGUAGES: readonly string[] = ["c", "cpp"];

export function isSupportedLanguage(languageId: string): boolean {
  return SUPPORTED_LANGUAGES.includes(languageId);
}

/** File extensions SCA analyzes (C and C++ sources and headers), lower case, with the dot. */
export const SOURCE_EXTENSIONS: readonly string[] = [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"];

/** Glob for finding C/C++ files in a folder. */
export const SOURCE_GLOB = `**/*.{${SOURCE_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`;

export function isSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return dot > sep && SOURCE_EXTENSIONS.includes(filePath.slice(dot).toLowerCase());
}
