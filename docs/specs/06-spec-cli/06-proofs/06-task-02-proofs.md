# Task 02 Proofs - Config validation command

## Task Summary

This task implements `weave validate` for explicit paths, project config, global config, JSON output, and human-readable parse/validation failures.

## What This Task Proves

- Valid project and global configs produce summary counts.
- Invalid DSL prints `file:line:column: message` and exits `1`.
- `--json` emits parseable machine-readable output.
- Validation tests use mocked file reads and pass.

## Evidence Summary

Fixture-backed CLI invocations validate project/global config, reject the invalid fixture with location context, and verify JSON output can be parsed.

## Artifact: Validation CLI invocations

**What it proves:** The command handles project/global/path/JSON modes and failure output.

**Why it matters:** Users and automation need a reliable first-class validator instead of the legacy dev-only script.

```text
## weave validate --project
Weave config is valid.
agents: 1
categories: 1
workflows: 1
disabled: 0
log_level: INFO

## weave validate --global
Weave config is valid.
agents: 1
categories: 1
workflows: 1
disabled: 0
log_level: INFO

## weave validate invalid path
[repo]/packages/cli/src/__fixtures__/invalid.weave:1:1: unclosed block
exit=1

## weave validate --json
{"agents":1,"categories":1,"workflows":1}

## validate tests
bun test v1.3.13 (bf2e2cec)

packages/cli/src/commands/__tests__/validate.test.ts:
(pass) validate command > validates explicit paths [7.30ms]
(pass) validate command > validates project config [0.50ms]
(pass) validate command > validates global config [0.42ms]
(pass) validate command > prints file line and column for invalid DSL [0.49ms]
(pass) validate command > prints missing file errors [0.08ms]
(pass) validate command > emits parseable JSON [0.88ms]

 6 pass
 0 fail
 14 expect() calls
Ran 6 tests across 1 file. [87.00ms]
```

## Reviewer Conclusion

`weave validate` validates scoped and explicit config, emits JSON for automation, and reports actionable line/column errors for invalid DSL.
