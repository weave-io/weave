---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-copilot": minor
"@weaveio/weave-adapter-pi": minor
---

Agent evals gain verification-aware cases. (The builtin prompt changes that shipped alongside them in #170 were reverted; see the results doc.)

Evals (`weave eval run`): paired `judgment` cases for all five agents, and verification-aware harness trajectory cases (Spec 35) with fixture workspaces, a starting agent, expected commands with exit status, a hidden verifier, and an `opencode-local` sandbox profile. The judge no longer crashes on braces in case text, and Pattern plans get an 8192-token output budget. The two existing Shuttle report cases no longer pass on the phrases "Commands run" and "ALL acceptance criteria are met"; nothing runs in those text-only cases, so they now require the report to say what was not verified and to claim no pass. A `--case` run no longer fails the Shuttle suite for matrix models that the case does not allow.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
