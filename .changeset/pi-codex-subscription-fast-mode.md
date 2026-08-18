---
"@weaveio/weave-adapter-pi": patch
---

Map `fast true` to OpenAI Codex subscription fast mode inside the Pi adapter.

Weave now registers its own wrapped `openai-codex` provider, so one stream call holds the effective transport, the final body, the outgoing headers, and the same attempt's response. A request is mapped only when the active owner declares `fast true`, the request model is an exact allowlisted Codex model that equals the owner's resolved model, the effective base URL is the first-party ChatGPT backend, the credential is a subscription OAuth login, and no body or header collision exists. A mapped request is forced onto SSE and carries both parts of the contract or neither: `service_tier: "priority"` plus the two Codex routing headers. Eligibility is process-level, so an ambient host request on the same allowlisted model is mapped while a fast owner is active. Registration is gated on host version `>=0.83.0` and the provider seam, and it happens only in a trusted, non-health-only session or an authenticated Weave child.

Everything else is native behavior unchanged: no intent, any failed rule, a gateway base URL, an older host, a failed registration, or a known collision delegates with the caller's own options object and stays byte-identical. A routing-hint collision that appears only at fetch time cannot roll back a tier already written, so that attempt is blocked instead of sent partially. `requested` means both controls were sent, not that anything was faster; the pinned host reports standard-speed evidence for mapped and control requests alike, so a successful mapped request ends at `not-confirmed`, and `applied` needs same-attempt `service_tier: "priority"` evidence. The `provider-fast-activation` capability declares the `degraded` ceiling this implies and stays optional.

This change is adapter-internal. It adds no public API, no DSL field, and no core, config, or engine schema change, and it leaves the OpenCode and Claude Code adapters untouched.
