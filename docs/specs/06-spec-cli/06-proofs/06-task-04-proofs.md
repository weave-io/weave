# Task 04 Proofs - Side-effect-free harness detection

## Task Summary

This task adds side-effect-free harness detection with injectable probes for OpenCode, Claude Code, and Pi.

## What This Task Proves

- Detection tests cover all-detected, none-detected, partial, unreadable-path, PATH-binary, and version scenarios.
- The no-write assertion proves detection does not mutate harness files.
- `weave init --yes` reports detected fixture harnesses without changing harness config.

## Evidence Summary

The fixture-backed CLI run detects OpenCode from isolated `HOME`/`PATH` and leaves the fixture config unchanged.

## Artifact: Detection tests and fixture-backed init

**What it proves:** Detection is deterministic, injectable, and side-effect free.

**Why it matters:** The CLI can report harness state safely before any installer confirmation or explicit install flag.

```text
## detection tests
bun test v1.3.13 (bf2e2cec)

packages/cli/src/detect/__tests__/detect.test.ts:
(pass) harness detection > detects all harnesses [0.49ms]
(pass) harness detection > returns none detected [0.04ms]
(pass) harness detection > detects partial harness sets [0.07ms]
(pass) harness detection > marks unreadable config paths [0.10ms]
(pass) harness detection > detects PATH-binary-only harnesses [0.04ms]
(pass) harness detection > includes optional version data [0.18ms]
(pass) harness detection > does not call write probes [0.05ms]

 7 pass
 0 fail
 9 expect() calls
Ran 7 tests across 1 file. [25.00ms]

## no write probe assertion
67:  it("does not call write probes", async () => {

## fixture-backed init detection summary
Weave init complete
Created config: [repo]/tmp/task4-fixtures/project/.weave/config.weave
Created prompts directory: [repo]/tmp/task4-fixtures/project/.weave/prompts

Detected harnesses:
- opencode (opencode fixture 1.0.0): readable at [repo]/tmp/task4-fixtures/home/.config/opencode/config.json

Next steps:
- Edit [repo]/tmp/task4-fixtures/project/.weave/config.weave
- Run weave validate --project or weave validate --global

## fixture opencode config after detection-only init
{}```

## Reviewer Conclusion

Harness detection is isolated behind probes, covered by deterministic tests, and does not write to detected harness config.
