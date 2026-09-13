# OpenCode 2 shared-contract recovery

Date: 2026-09-12. Non-normative evidence for the
[OpenCode 2 adapter](../adapters/opencode2-core.md).

## Cause and scope

The OpenCode release branch carried the older object-trigger schema. The full
string-trigger integration in `af77cecd` was present on a separate integration
history, not in `feat/opencode2-core-release`. An affected project used valid
string triggers, so the older plugin rejected its entire configuration and
registered no Weave agents.

This backport reconciles the shared core, config, engine, CLI, fixtures, and
prompt templates. Triggers remain exact strings, categories require a routing
description instead of patterns, and fast intent is optional `true`. Category
shuttles use their own triggers rather than generic Shuttle triggers.

The OpenCode native variant extension, prompt-reader injection, bounded input
validation, and current command/UI work are preserved. Pi runtime code and
independent release workstreams are not included. This is a scoped backport,
not a merge of the entire Pi or integration branch.

## Verification

- Typecheck, lint, public-package build, and documentation link checks passed.
  Lint reports existing warnings and informational diagnostics.
- The focused core/config/engine/CLI/OpenCode 2 suite passed: 3,104 tests,
  zero failures. After isolating the Pattern snapshot from global user config,
  the full suite reported 5,830 passes, 12 skips, and zero failures. Project config validation and the
  complete build, including the documentation site, also passed.
- The existing packaged-runtime verifier passed against its pinned
  `0.0.0-beta-19151` host. It installs the built tarball in an isolated runtime
  and checks native agents, delegation, plan commands, RPC, and cleanup.
- The live OpenCode `2.0.2` service registered all nine expected Weave agents
  at the affected project: Loom, Tapestry, Shuttle, Pattern, Thread, Spindle,
  Weft, Warp, and the project-defined Forge agent.
- Weave's status RPC reported `refresh: fresh`, `agentCount: 9`, no issues,
  and readiness for native agents, request intent, foreground plans, plan
  display, and native delegation. Durable workflows remain unsupported.
- Only the affected idle location's cached services were evicted. The shared
  service was not restarted, and the existing session's selected agent was
  not changed.

## Limits

The initial full-suite run had one Pattern prompt-snapshot failure. The test
loaded global user configuration instead of only the builtin prompt. A separate
test fix composes the repository's prompt directly and retains all existing
contract assertions. The builtin prompt itself is unchanged.

The live stable-release check proves plugin activation, agent registration,
model/variant resolution, and status RPC. It is not a fresh interactive picker
test or a provider-acceleration test. The isolated packaged verifier remains
pinned to its beta host; package dependencies have not been migrated to the
renamed stable SDK packages in this backport.
