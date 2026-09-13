---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-copilot": minor
"@weaveio/weave-adapter-pi": minor
---

Builtin agents build feedback loops to validate their own work and findings.

- Pattern ends every acceptance criterion with how it will be verified, using only commands the project has, and writes the plan's Verification section as a checklist.
- Shuttle finds the project's checks before editing, reproduces bugs with a failing test first, runs the check after the change, and says `Not verified:` with the command to run when it cannot execute.
- Tapestry treats a specialist's report as a claim until evidence backs it, re-runs checks itself when it can execute, and runs the plan's Verification section before finishing, whatever its format.
- Weft and Warp trace a finding through the code before it blocks and report unconfirmed concerns as non-blocking `SUSPECTED:` lines. Warp no longer blocks on a security pattern match alone.
- Loom separates confirmed from suspected review findings, offers to validate suspected ones with a reproducing test, and checks changes it makes itself.

Evals (`weave eval run`): paired `judgment` cases for all five agents, and verification-aware harness trajectory cases (Spec 35) with fixture workspaces, a starting agent, expected commands with exit status, a hidden verifier, and an `opencode-local` sandbox profile. The judge no longer crashes on braces in case text, and Pattern plans get an 8192-token output budget. The two existing Shuttle report cases no longer pass on the phrases "Commands run" and "ALL acceptance criteria are met"; nothing runs in those text-only cases, so they now require the report to say what was not verified and to claim no pass. A `--case` run no longer fails the Shuttle suite for matrix models that the case does not allow.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
