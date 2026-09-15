# Exercise the product: baseline

Baseline for the change that has builtin agents run what they change, not only its tests. Taken on 2026-09-15 at `cd52741` (new eval cases, prompts unchanged since `main`). The after-change runs are pending; see [Status](#status).

## Why

The verification feedback loops from #170 made agents run the project's checks. Every builtin prompt still treated verification as a check command, though: a typecheck, `bun test`, or the plan's `verify by` lines. Those can all pass while the product is broken, because a test can mock the part that is broken, and the agent that wrote the code often wrote the test. The change adds a step where the agent runs the product the way a user would: the CLI with the task's inputs, a request to the local server, or a script against the public API. It also labels each acceptance criterion with how it was verified.

## New cases

| Case | Kind | What it needs |
| --- | --- | --- |
| `shuttle-exercises-cli-trajectory` | harness trajectory, starts at Loom | run the real CLI after the last edit (exit 0); the hidden verifier runs the CLI |
| `tapestry-exercises-plan-goal-trajectory` | harness trajectory, starts at Tapestry | the same, from a plan whose checks only name `bun test` |
| `pattern-plan-exercise-the-service` | text-only judgment | a `How to run` section with a declared launch command, and a non-`manual:` check against the running service |

Both trajectory cases use `slugctl-cli`: its six unit tests pass with the bug in place (the parser reads `--sep`, the README documents `--separator`, and the `run()` test mocks the parser). Checked by hand before the baseline: `bun test` passes, `bun src/slugctl.ts --separator _ "Hello World"` prints `hello-world`, the verifier fails 2 of 3 expectations, and after the one-line parser fix it passes 3 of 3.

## Baseline

Eight default models, one sample per case, except the trajectory cases (four allowed models).

| Case or suite | Baseline |
| --- | --- |
| **`pattern-plan-exercise-the-service`** | **0/8** |
| `pattern-plan-no-invented-commands` (guard) | 6/8 |
| `pattern-plan-verify-by-per-criterion` | 4/8 |
| `pattern-plan-release-checklist` | 4/8 |
| `pattern-plan-settings-refactor` | 4/8 |
| **`shuttle-exercises-cli-trajectory`** | 1/1 completed (Sonnet 4.5); Opus 5 crashed, Opus 5 second sample, GPT-5.5 and DeepSeek not run |
| **`tapestry-exercises-plan-goal-trajectory`** | 0/0 completed; both runs crashed |
| Shuttle text cases (reports unverified / structured evidence / tests and assumptions) | 8/8, 7/8, 4/8 |
| Tapestry text cases (accepts evidenced / rejects contradicted / delegate / plan step) | 8/8, 8/8, 8/8, 7/8 |
| Weft (clean approval / guarded false positive / blocker citation / traced true positive) | 6/8, 6/8, 4/8, 5/8 |
| Warp (block evidence / fast exit / guarded false positive / traced injection) | 8/8, 7/8, 6/8, 5/8 |
| Spindle (citations / network claims) | 6/8, 6/8 |
| Loom routing, 15 cases | 117/120 |
| Tapestry category routing, 10 cases | 42/80 |

### What the Pattern baseline shows

Every model missed both new signals, but most of them already knew the service should be checked end to end. They wrote the check and labelled it `manual:`, because the current prompt reserves `manual:` for "checks no command can make" and a request to localhost is not a project command:

- Sonnet 4.5: `- [ ] manual: start server with bun run dev, curl http://localhost:3000/health, verify response is {"status":"ok"} with status 200`
- DeepSeek: `verify by: manual: run bun run dev, request http://localhost:3000/health with an HTTP client, confirm status 200`
- Qwen: `verify by: manual: run bun run dev, then request http://localhost:3000/health`
- GPT-5.6: `manual: run bun run dev, request http://localhost:3000/health in a browser, and confirm through the Network panel…`

A check that an agent could run was handed to a person. That is the gap the Pattern change targets. Opus 4.5 (a 175-character reply) and GPT-5.5 (a file-writing tool call instead of a plan) are the known "reply is not a plan" failures, not signal misses.

### Errors

13 of 380 case results errored and count as failures:

- 10 empty responses (`EmptyResponse`) from DeepSeek (6) and Qwen (4) across Weft, Warp, Loom and the Shuttle text cases, between 07:13 and 08:26 UTC. Other models answered the same cases in the same batches, and the credit error below first appeared at 08:44, so these look model-side, but the logs do not rule out a provider cause.
- 3 trajectory runs crashed (`HarnessCrashed`) when the OpenRouter key ran out of credits: "This request would exceed your available credits given your current in-flight requests".

## How the runs were taken

This machine is shared and memory-constrained, and background runs were killed by the host's memory guard, so each run was a foreground `weave eval run` for one suite and one model. Parallel runs each used their own slot directory (`eval-bundles/slots/<phase>/<slot>/`, gitignored), because bundle run ids are allocated by scanning `eval-bundles/runs/` and parallel writers in one directory can collide. Each slot's `.weave` is a symlink to the worktree's. `weave prompt inspect` gives identical composed prompts for all eight agents from a slot and from the root, and both resolve the same git SHA. Bundles and raw artifacts are local.

## Status

- Done: new cases and harness (`matches` command matcher, Pattern exercise signals), fixture checks, text baseline on all suites, prompt changes.
- Pending OpenRouter credits: the remaining trajectory baseline runs (two samples each for four models on both cases) and every after-change run. The after table will use the same slots layout and will be added here.
