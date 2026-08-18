---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-claude-code": minor
"@weaveio/weave-adapter-pi": minor
---

Declare delegation triggers as plain strings, and ask for provider acceleration with `fast true`.

Breaking: `triggers` is now a list of exact guidance strings on agents and categories, and the `{ domain, trigger, routing_hint }` object form is rejected with no compatibility alias. Category `patterns` is removed with no replacement field, so Weave performs no deterministic file routing and categories route by `description` and `triggers`. `weave init migrate` converts legacy JSONC on a best-effort basis, preserving source order and warning for every discarded field.

- Trigger text is never trimmed, case-folded, sorted, or parsed for structure. A generated `shuttle-{category}` uses the category's merged trigger list instead of the base `shuttle` list.
- Agents and categories accept the optional literal `fast true` as neutral provider-acceleration intent. Omission preserves provider defaults, `fast false` and the aliases `service_class`, `speed`, `variant`, and `priority` are rejected, and `fast` merges as a scalar so a higher-priority layer can opt in while omission cancels nothing.
- The new optional `provider-fast-activation` capability reports honestly per harness: OpenCode declares it unsupported because its plugin surface exposes no correlated response proof, and the Claude Code and Pi adapters declare it unsupported because they own no per-invocation request seam. No adapter writes a `service_tier`, `speed`, or `anthropic-beta` value.
- An unsupported optional capability warns only. It never enters health-only mode and never blocks activation, materialization, prompts, models, tools, delegation, or bootstrap.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
