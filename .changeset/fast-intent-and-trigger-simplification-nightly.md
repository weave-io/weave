---
"@weaveio/weave-adapter-pi": major
"@weaveio/weave-adapter-claude-code": major
---

**Breaking:** carry portable string triggers and the neutral `fast true` intent; report provider acceleration as honestly unsupported.

- **Breaking:** normalized descriptors and Pi's authenticated child bootstraps now carry `DelegationTarget.triggers` as `string[]`. The structured `{ domain, trigger, routing_hint? }` form is rejected, and category `patterns` is removed with no replacement field or deterministic file routing.
- Descriptors, Pi primary activation state, and ordinary and direct-step child bootstraps carry the optional literal `fast?: true`. Absence is preserved exactly so provider defaults survive; `false` is never stored and intent is never inferred from a model or provider name.
- Add the optional `provider-fast-activation` capability. Both adapters declare it `unsupported`:
  - Pi reports the bounded reason `harness-seam-unavailable`. Pi's public extension contract cannot bind the effective transport or the response body of one prepared provider request, so the adapter registers no provider request, header, or response handler and leaves every payload and header exactly as other extensions left it. No `service_tier`, `speed`, or `anthropic-beta` value is written. `/weave:status` may report `fast: unsupported (harness-seam-unavailable)` and never claims applied, active, or confirmed.
  - Claude Code reports the bounded reason `harness-seam-unavailable`. Static file materialization owns no per-invocation request seam and no response evidence, so generated agent and command files encode no frontmatter field, environment value, prompt instruction, or provider control.
- These optional-capability gaps warn only. They never enter health-only mode and never block activation, materialization, prompts, models, tools, delegation, or bootstrap.
