---
"@weaveio/weave-adapter-pi": patch
---

Map `fast true` to OpenAI Codex subscription fast mode.

- Weave registers its own wrapped `openai-codex` provider, so one stream call holds the effective transport, the final body, the outgoing headers, and the same attempt's response.
- A request is mapped only when the active owner declares `fast true`, the request model is an allowlisted Codex model equal to the owner's resolved model, the base URL is the first-party ChatGPT backend, the credential is a subscription OAuth login, and no body or header collision exists.
- A mapped request carries both parts of the contract or neither: `service_tier: "priority"` plus the two Codex routing headers, forced onto SSE. Any failed rule delegates with the caller's own options object and stays byte-identical.
- Registration needs host version `>=0.83.0`, the provider seam, and a trusted, non-health-only session or an authenticated Weave child.
- `requested` means both controls were sent, not that anything was faster. `applied` needs same-attempt `service_tier: "priority"` evidence, so `provider-fast-activation` declares a `degraded` ceiling and stays optional.
- This change is adapter-internal: no public API, no DSL field, and no core, config, or engine schema change.
