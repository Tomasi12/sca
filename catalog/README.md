# SCA rule catalog

The catalog lists **which rule sets SCA supports, how well, with which backend tool, and why something is not covered**.
Users turn rule sets (or single rules) on and off.

> **Status:** the catalog shows the **target** coverage. Rule sets with at least one working rule have `"implemented": true` and list them in `implementedRules`: today `runtime-bugfinder` (`div-zero`) and `sca-own` (`switch-default`, `goto`).

📊 **Overview presentation:** open [coverage-presentation.html](coverage-presentation.html) in a browser.

## Files
| File | Content |
|---|---|
| `rulesets.json` | All rule sets: coverage level, backends, ISO 26262 topics, reason |
| `iso26262-mapping.json` | ISO 26262 Part 6 / Part 8 topics → which rule sets support them |
| `config-example.json` | Example project config: enable/disable sets and rules, deviations |
| `coverage-presentation.html` | Slides: what we can cover, and why not the rest |

## Coverage levels
| Level | Meaning |
|---|---|
| `full` | All checkable rules of the set can be covered |
| `partial` | A useful subset; the rest is missing or approximated |
| `planned` | No existing free tool covers it; needs our own checks |
| `not-covered` | Out of scope for now (see `reason`) |

## Backends
SCA is the front end. Each rule is checked by the best backend:
`sca-native` (our own), `clang-tidy`, `clang-analyzer`, `cppcheck`, `cppcheck-misra`, optionally `frama-c-eva`.
GPL tools (Cppcheck) and LGPL tools (Frama-C) run as **separate processes** only - their code is never copied into SCA.

## Rule IDs and copyright
Rules are referenced as `<ruleSet>:<id>`, e.g. `misra-c-2012:17.2`.
**Official MISRA / AUTOSAR rule texts are copyrighted and are not included.** Descriptions are written in our own words.
Users who own the standards can load the official texts locally.

## ISO 26262
The catalog maps rule sets to ISO 26262 topics so a project can show which guideline topics are supported.
SCA can **support** ISO 26262 work; it does not make code compliant by itself, and SCA is **not a qualified tool** (Part 8) yet.
