// The project config file `.sca.json` in the workspace root. Example:
//
// {
//   "ruleSets": { "sca-own": true, "runtime-bugfinder": true },
//   "rules": { "sca-own:goto": false, "runtime-bugfinder:div-zero": { "severity": "error" } },
//   "exclude": ["**/generated/**"],
//   "compileCommands": "build/compile_commands.json",
//   "includePaths": ["include"],
//   "defines": { "UNIT_TEST": "1" },
//   "deviations": [ { "rule": "sca-own:goto", "file": "src/util.c", "line": 74, "reason": "Single exit for cleanup." } ]
// }
//
// Every key is optional. Unknown keys are reported, not fatal.

import { isValidRuleId, Severity } from "../finding";

export interface RuleSetting {
  enabled: boolean;
  severity?: Severity;
}

export interface Deviation {
  /** Rule ID, `<ruleSet>:*` or `*`. */
  rule: string;
  /** Path relative to the project root, with forward slashes. */
  file: string;
  line: number;
  reason: string;
}

export interface ScaConfig {
  ruleSets: Record<string, boolean>;
  rules: Record<string, RuleSetting>;
  exclude: string[];
  compileCommands?: string;
  includePaths: string[];
  defines: Record<string, string>;
  deviations: Deviation[];
}

export const CONFIG_FILE = ".sca.json";

export function emptyConfig(): ScaConfig {
  return { ruleSets: {}, rules: {}, exclude: [], includePaths: [], defines: {}, deviations: [] };
}

const SEVERITIES: readonly string[] = ["error", "warning", "info"];
const KNOWN_KEYS = new Set(["$schema", "$comment", "ruleSets", "rules", "exclude", "compileCommands", "includePaths", "defines", "deviations"]);

/** Parses `.sca.json`. Never throws: problems are returned as messages, the rest of the file still counts. */
export function parseConfig(text: string): { config: ScaConfig; problems: string[] } {
  const config = emptyConfig();
  const problems: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { config, problems: [`Not valid JSON: ${(err as Error).message}`] };
  }
  if (!isObject(data)) {
    return { config, problems: ["The file must contain a JSON object."] };
  }
  for (const k of Object.keys(data)) {
    if (!KNOWN_KEYS.has(k)) {
      problems.push(`Unknown key "${k}" (ignored).`);
    }
  }
  if (data.ruleSets !== undefined) {
    if (isObject(data.ruleSets)) {
      for (const [set, on] of Object.entries(data.ruleSets)) {
        if (typeof on === "boolean") {
          config.ruleSets[set] = on;
        } else {
          problems.push(`ruleSets.${set} must be true or false.`);
        }
      }
    } else {
      problems.push(`"ruleSets" must be an object.`);
    }
  }
  if (data.rules !== undefined) {
    if (isObject(data.rules)) {
      for (const [id, v] of Object.entries(data.rules)) {
        if (!isValidRuleId(id)) {
          problems.push(`rules: "${id}" is not a rule ID (<ruleSet>:<id>).`);
          continue;
        }
        if (typeof v === "boolean") {
          config.rules[id] = { enabled: v };
        } else if (isObject(v)) {
          const setting: RuleSetting = { enabled: v.enabled !== false };
          if (v.severity !== undefined) {
            if (typeof v.severity === "string" && SEVERITIES.includes(v.severity)) {
              setting.severity = v.severity as Severity;
            } else {
              problems.push(`rules.${id}.severity must be "error", "warning" or "info".`);
            }
          }
          config.rules[id] = setting;
        } else {
          problems.push(`rules.${id} must be true, false or an object.`);
        }
      }
    } else {
      problems.push(`"rules" must be an object.`);
    }
  }
  config.exclude = stringList(data.exclude, "exclude", problems);
  config.includePaths = stringList(data.includePaths, "includePaths", problems);
  if (data.compileCommands !== undefined) {
    if (typeof data.compileCommands === "string") {
      config.compileCommands = data.compileCommands;
    } else {
      problems.push(`"compileCommands" must be a path string.`);
    }
  }
  if (data.defines !== undefined) {
    if (isObject(data.defines)) {
      for (const [k, v] of Object.entries(data.defines)) {
        config.defines[k] = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(Number(v)) : "1";
      }
    } else {
      problems.push(`"defines" must be an object.`);
    }
  }
  if (data.deviations !== undefined) {
    if (Array.isArray(data.deviations)) {
      data.deviations.forEach((d, i) => {
        if (isObject(d) && typeof d.rule === "string" && typeof d.file === "string" && Number.isInteger(d.line) && typeof d.reason === "string" && d.reason.trim() !== "") {
          config.deviations.push({ rule: d.rule, file: d.file.replace(/\\/g, "/"), line: d.line as number, reason: d.reason.trim() });
        } else {
          problems.push(`deviations[${i}] needs rule, file, line and a non-empty reason.`);
        }
      });
    } else {
      problems.push(`"deviations" must be an array.`);
    }
  }
  return { config, problems };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, name: string, problems: string[]): string[] {
  if (v === undefined) {
    return [];
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  problems.push(`"${name}" must be a list of strings.`);
  return [];
}

/** Is the rule on? A single-rule setting wins over its rule set; everything is on by default. */
export function isRuleEnabled(config: ScaConfig, ruleId: string): boolean {
  const rule = config.rules[ruleId];
  if (rule) {
    return rule.enabled;
  }
  const set = ruleId.split(":")[0];
  return config.ruleSets[set] ?? true;
}

/** `sca-own:goto` matches "sca-own:goto", "sca-own:*" and "*". */
export function rulePatternMatches(pattern: string, ruleId: string): boolean {
  const p = pattern.trim();
  return p === "*" || p === ruleId || (p.endsWith(":*") && ruleId.startsWith(p.slice(0, -1)));
}
