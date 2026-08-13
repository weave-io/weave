---
"@weaveio/weave-cli": major
"@weaveio/weave-adapter-opencode": major
---

**Breaking:** replace structured delegation triggers with portable strings, remove category file patterns, and add the neutral `fast true` intent.

- **Breaking:** `triggers` is now `string[]` on both agents and categories. Each entry is one exact, nonblank guidance string. The old `{ domain, trigger, routing_hint? }` object form is a hard validation error and has no runtime compatibility alias. Trigger text is never trimmed, case-folded, sorted, or parsed for structure.
- **Breaking:** category `patterns` is removed completely. It is not renamed, deprecated, or preserved as inert metadata, and there is no replacement field. Weave performs no deterministic file routing; categories route by `description` and `triggers`.
- **Breaking:** `AgentDescriptorCategory.patterns` and the exported structured trigger types are gone. `DelegationTarget.triggers` is `string[]`, and template context exposes `delegation.targets.triggers` as scalar strings rendered with `{{.}}`. Stale typed consumers fail compilation and stale untyped values fail strict validation.
- Add the optional literal `fast true` to agents and categories as neutral provider-acceleration intent. Only `fast true` is valid; omission preserves provider defaults. `fast false` and the aliases `service_class`, `speed`, `variant`, and `priority` are rejected. `fast` merges as a scalar, so a higher-priority layer can opt in but omission cannot cancel a lower-priority declaration.
- A generated `shuttle-{category}` uses the category's merged trigger list and never inherits the base `shuttle` triggers. A category `fast true` overrides the base `shuttle` value; omission inherits it.
- `weave init migrate` converts legacy JSONC on a best-effort basis: it emits each trigger object's nonblank `routing_hint`, otherwise its nonblank `trigger`, preserves source order, drops exact duplicates, and warns for every discarded field. It drops valid or malformed category patterns with a warning, converts a category only when it has a nonblank description, and never infers `fast`.
- Add the optional `provider-fast-activation` capability. The OpenCode adapter declares it `unsupported` with the bounded reason `response-proof-unavailable`: its plugin surface can mutate a request, but exposes no correlated official response-body proof for the same attempt, so the adapter sends no acceleration control and mutates no request option or header. This optional gap warns and never blocks descriptor materialization or agent mapping.
