# Task 03 Proofs - Init scaffolding and prompt flow

## Task Summary

This task implements `weave init` config scaffolding for global, local, and custom install directories, with idempotency, forced backups, generated config validity, and prompt wrapper behavior.

## What This Task Proves

- Non-interactive global and local init create `config.weave` and `prompts/`.
- Generated starter config validates for both global and project scopes.
- Re-running init without `--force` skips existing config.
- `--force` creates `config.weave.bak` before overwrite.
- Init and prompt tests cover non-TTY, `--yes`, and cancellation paths.

## Evidence Summary

All CLI commands run against fixture directories with isolated `HOME` and no real harness config mutation.

## Artifact: Init CLI and tests

**What it proves:** Scaffolding, validation, idempotency, backup behavior, and prompt tests all pass.

**Why it matters:** Users can safely bootstrap Weave config without accidental destructive writes.

```text
## global init
Weave init complete
Created config: [repo]/tmp/task3-fixtures/home/.weave/config.weave
Created prompts directory: [repo]/tmp/task3-fixtures/home/.weave/prompts

Detected harnesses:
- No supported harness config or PATH binaries detected.

Next steps:
- Edit [repo]/tmp/task3-fixtures/home/.weave/config.weave
- Run weave validate --project or weave validate --global

## global files
[repo]/tmp/task3-fixtures/home/.weave
[repo]/tmp/task3-fixtures/home/.weave/config.weave
[repo]/tmp/task3-fixtures/home/.weave/prompts

## local init
Weave init complete
Created config: [repo]/tmp/task3-fixtures/project/.weave/config.weave
Created prompts directory: [repo]/tmp/task3-fixtures/project/.weave/prompts

Detected harnesses:
- No supported harness config or PATH binaries detected.

Next steps:
- Edit [repo]/tmp/task3-fixtures/project/.weave/config.weave
- Run weave validate --project or weave validate --global

## local files
[repo]/tmp/task3-fixtures/project/.weave
[repo]/tmp/task3-fixtures/project/.weave/config.weave
[repo]/tmp/task3-fixtures/project/.weave/prompts

## validate generated global
Weave config is valid.
agents: 2
categories: 2
workflows: 1
disabled: 0
log_level: INFO

## validate generated project
Weave config is valid.
agents: 2
categories: 2
workflows: 1
disabled: 0
log_level: INFO

## idempotent global init
Weave init complete
Skipped existing config: [repo]/tmp/task3-fixtures/home/.weave/config.weave

Detected harnesses:
- No supported harness config or PATH binaries detected.

Next steps:
- Edit [repo]/tmp/task3-fixtures/home/.weave/config.weave
- Run weave validate --project or weave validate --global

## force global init
Weave init complete
Backed up existing config: [repo]/tmp/task3-fixtures/home/.weave/config.weave.bak
Created config: [repo]/tmp/task3-fixtures/home/.weave/config.weave
Created prompts directory: [repo]/tmp/task3-fixtures/home/.weave/prompts

Detected harnesses:
- No supported harness config or PATH binaries detected.

Next steps:
- Edit [repo]/tmp/task3-fixtures/home/.weave/config.weave
- Run weave validate --project or weave validate --global

## backup file
-rw-r--r--  1 [user]  [group]  2207 May 12 16:13 [repo]/tmp/task3-fixtures/home/.weave/config.weave.bak

## init and prompt tests
bun test v1.3.13 (bf2e2cec)

packages/cli/src/prompt/__tests__/prompt.test.ts:
(pass) prompt adapter > returns selected scope answers [0.17ms]
(pass) prompt adapter > returns install-directory defaults and overrides [0.05ms]
(pass) prompt adapter > returns multi-select harness answers [0.05ms]
(pass) prompt adapter > returns adapter module prompts [0.02ms]
(pass) prompt adapter > reports non-TTY prompt unavailability [0.05ms]
(pass) prompt adapter > supports --yes style bypass by not prompting
(pass) prompt adapter > returns cancellation as an explicit result [0.03ms]

packages/cli/src/commands/__tests__/init.test.ts:
(pass) init command > creates global config and prompts non-interactively [1.22ms]
(pass) init command > creates local config and prompts non-interactively [0.10ms]
(pass) init command > is idempotent without force [0.14ms]
(pass) init command > creates a backup when force overwrites [0.19ms]
(pass) init command > generated config validates [5.15ms]
(pass) init command > reports non-TTY fallback [0.09ms]
(pass) init command > handles prompt cancellation with exit code zero [0.13ms]
(pass) init command > reports detected harnesses and installs supported explicit OpenCode [0.42ms]

 15 pass
 0 fail
 23 expect() calls
Ran 15 tests across 2 files. [62.00ms]
```

## Reviewer Conclusion

`weave init` safely creates valid starter config, avoids overwrites by default, backs up before forced writes, and has deterministic prompt behavior under test.
