---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
"@weaveio/weave-adapter-pi": minor
---

Declare optional fast-service intent with `fast true` or `fast false`.

- Agents and categories accept an optional boolean `fast`. Explicit `false` overrides an inherited `true`; omission preserves inherited or harness defaults.
- Normalized agent descriptors retain this intent. The pinned OpenCode V2 adapter does not apply a provider-specific fast-service override or claim that fast service was requested or supplied.
- Structured agent triggers (`{ domain, trigger, routing_hint }`), category `patterns`, and the optional `variant` field remain supported. This release does not migrate them to a different syntax.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
