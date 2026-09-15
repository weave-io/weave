---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-copilot": minor
"@weaveio/weave-adapter-pi": minor
---

Builtin agents check that a change works, not only that its tests pass.

- Shuttle finds how a user reaches the code it changes, reproduces a bug the way it was reported, and after the tests runs the change itself: the CLI with the task's inputs, a request to the local server, or a short script against the public API. Probes stay outside the repository, stop what they start, and never call external services. Each acceptance criterion is labelled `Verified (exercised)`, `Verified (tests)`, `Verified (static)`, or `Not verified:`.
- Pattern plans gain a `## How to run it` section and at least one check that runs the product. `manual:` is kept for checks only a person can make.
- Tapestry re-runs the commands a specialist says it ran and, after the plan's Verification checks, exercises the plan's goal end to end. Its task envelope carries a `How to run it` line.
- Loom sends implementation work in the same task envelope, with the user's own scenario as an acceptance criterion, and says how the result was verified.
- Weft and Warp follow each `SUSPECTED:` finding with a `REPRO:` line naming the command or input that would confirm it. Weft flags user-visible changes that nobody ran.
- Thread reports how to run the code it explored, and Spindle checks cited docs against the version the project pins.

Evals (`weave eval run`): `expected_commands` accepts `matches`, a regular expression, as an alternative to `contains`. New cases `shuttle-exercises-cli-trajectory`, `tapestry-exercises-plan-goal-trajectory` (a CLI fixture whose unit tests pass with the bug in place), and `pattern-plan-exercise-the-service`, with the Pattern signals `plan_how_to_run` and `plan_exercise_check`.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
