# SCA — Static Code Analyzer

SCA checks C/C++ code **as you write it** and reports likely run-time errors
(division by zero, overflow, out-of-bounds, null dereference, uninitialized reads, ...)
and coding-rule violations.

> Status: early design. No working code yet.

## Layout
```
src/            analyzer source code
include/        public headers / interfaces
tests/          unit and regression tests
tests/samples/  small C/C++ inputs with expected findings
docs/           user and design documentation
tools/          helper scripts
```

## Goals
- Fast, incremental feedback inside the editor (LSP).
- Low false-positive rate; every false positive becomes a regression test.
- Standard output format (SARIF) for CI integration.

## Coding rules
Rules are described in our own words and referenced by ID only.
Official rule texts (e.g. MISRA) are copyrighted and are not included here.
