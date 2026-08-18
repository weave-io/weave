# Fast provider acceleration contract

Date: 2026-08-12

Last amended: 2026-08-17

Status: Approved. OpenCode and Claude Code stay `unsupported`. The public OpenAI API and Anthropic mappings stay unimplemented on every adapter. The shipped Pi adapter still declares `provider-fast-activation` as `unsupported` and mutates no provider request; this note now authorizes exactly one Pi mapping, the OpenAI Codex subscription transport through a Weave-registered wrapped provider, under the rules below.

Retrieval date for web sources: 2026-08-12

## Purpose

This note fixes the evidence threshold for provider acceleration before Weave maps the neutral `fast` intent. It records current provider contracts and harness seams. Provider and harness behavior is volatile. Recheck every linked contract before an allowlist change.

Normative provider facts below come from first-party API documentation, with one recorded exception: the [OpenAI Codex subscription transport](#openai-codex-subscription-fast-mode-chatgpt-backend), whose provenance relaxation is approved and scoped in decision OD-1. Harness facts come from public documentation, tagged public source, and installed public types. Examples confirm shape but do not extend an allowlist.

### Amendment history

| Date | Change |
| --- | --- |
| 2026-08-12 | Original note. Every adapter `unsupported`; no adapter mutates a provider request. |
| 2026-08-17 | Added the OpenAI Codex subscription contract, the Pi wrapped-provider seam verdict, the normative Pi Codex mapping rules, and the pinned-host probe appendix. Owner approved OD-1, OD-5, and OD-6; Task 1 resolved OD-2, OD-3, and OD-4. Public OpenAI and Anthropic thresholds unchanged. |

## Neutral Weave boundary

Core and engine may carry only the user's neutral acceleration intent and bounded outcome state. They must not carry provider request fields, request or response headers, credentials, raw payloads, raw responses, harness event objects, or arbitrary provider metadata. Each adapter owns provider recognition, the exact allowlist, request mutation, response interpretation, and safe diagnostics.

The only acceleration declaration is the literal `fast true` on an agent or category. Omission preserves the provider default. `fast false` is invalid, and there is no unset operator. The names `service_class`, `speed`, `variant`, and `priority` are invalid aliases in the DSL. Intent alone does not select a provider, model, endpoint, or credential.

For a category-generated agent, an explicit category `fast true` takes precedence over the base `shuttle` value. If the category omits `fast`, the generated agent inherits the base `shuttle` intent. Because the only valid value is `true`, a higher-priority config layer cannot cancel an inherited declaration; it can only omit the field and leave the lower declaration in place.

## Official provider contracts

### OpenAI

This section covers the public first-party OpenAI API only: `https://api.openai.com`, authenticated with an API key. The ChatGPT-backed Codex subscription transport is a separate contract with a different request control, a different credential, and a different evidence basis; see [OpenAI Codex subscription fast mode](#openai-codex-subscription-fast-mode-chatgpt-backend). No fact, allowlist entry, request field, header, or positive response value crosses between the two.

[OpenAI Fast mode](https://platform.openai.com/docs/guides/fast-mode) is the request and response contract. [OpenAI pricing](https://platform.openai.com/docs/pricing) identifies currently priced models, and [GPT-5.6 model guidance](https://platform.openai.com/docs/guides/latest-model) defines the family names.

| Concern | Current contract |
| --- | --- |
| APIs | Responses and Chat Completions |
| Request control | `service_tier: "fast"`; `"priority"` has the same behavior on supported models |
| Extra acceleration header | None documented |
| Response proof | The response object's `service_tier` reports the tier used |
| Positive evidence | `service_tier: "fast"`, or `service_tier: "priority"` for GPT-5.6 and earlier models |
| Negative evidence | `service_tier: "default"` means the request was processed at standard speed |
| Retry behavior | Fast and Standard share the same baseline limits. Use normal retry logic and wait between attempts. A retry is a new evidence attempt. |
| Incompatibilities | Fine-tuned models and embeddings are not supported. Multimodal image input is supported. The current guide says GPT-5.6 supports long context. |

OpenAI can downgrade traffic that ramps too quickly. A successful HTTP status or a mutated request therefore does not prove application. Only the response `service_tier` does.

#### Frozen allowlist baseline

The initial allowlist is intentionally narrower than every model that might work:

| Provider model | Endpoint | Request contract | Response contract | Decision |
| --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | Responses or Chat Completions | [Fast mode configuration](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) and the model's Fast price row in [pricing](https://platform.openai.com/docs/pricing) | [Fast mode `service_tier` evidence](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) | Eligible |
| `gpt-5.6-terra` | Responses or Chat Completions | [Fast mode configuration](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) and the model's Fast price row in [pricing](https://platform.openai.com/docs/pricing) | [Fast mode `service_tier` evidence](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) | Eligible |
| `gpt-5.6-luna` | Responses or Chat Completions | [Fast mode configuration](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) and the model's Fast price row in [pricing](https://platform.openai.com/docs/pricing) | [Fast mode `service_tier` evidence](https://platform.openai.com/docs/guides/fast-mode#configuring-fast-mode) | Eligible |

The `gpt-5.6` alias, older model families, future model names, snapshots, fine-tuned IDs, embeddings, proxies, and OpenAI-compatible providers are not implicitly eligible. Add an exact entry only when current official request eligibility and response evidence both cover it. Model-name shape, SDK acceptance, or a pricing inference alone is insufficient.

### Anthropic

[Anthropic Fast mode](https://docs.anthropic.com/en/docs/build-with-claude/fast-mode) is the request, eligibility, pricing, limit, and response contract. [Anthropic API release notes](https://docs.anthropic.com/en/release-notes/api) explain removals and changed behavior; current Fast mode documentation takes precedence over historical launch entries.

| Concern | Current contract |
| --- | --- |
| API | Synchronous Messages API on the first-party Claude API, including Claude Managed Agents |
| Request control | `speed: "fast"` |
| Required acceleration header | `anthropic-beta: fast-mode-2026-02-01` in addition to the normal API headers |
| Response proof | The response usage object reports `speed`; only `usage.speed: "fast"` proves application |
| Limits and retries | Fast mode has dedicated limits. Limit exhaustion returns `429` with `retry-after`; capacity pressure can return `529`. Respect `retry-after` and use bounded backoff. Each retry needs its own response proof. |
| Limit evidence | `anthropic-fast-*` response headers report fast-limit status but do not prove that a successful generation used fast speed |
| Incompatibilities | Batch API, Priority Tier commitments, Amazon Bedrock, Google Cloud Vertex AI, Microsoft Foundry, and Claude Platform on AWS |
| Cache behavior | Switching between fast and standard speed invalidates prompt-cache sharing |

#### Frozen allowlist baseline

| Provider model | API | Request contract | Response contract | Decision |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | First-party synchronous Messages API | Supported-model table and request examples in [Fast mode](https://docs.anthropic.com/en/docs/build-with-claude/fast-mode) | `usage.speed` in the same official contract | Eligible |
| `claude-opus-4-8` | First-party synchronous Messages API | Supported-model table and request examples in [Fast mode](https://docs.anthropic.com/en/docs/build-with-claude/fast-mode) | `usage.speed` in the same [official response contract](https://docs.anthropic.com/en/docs/build-with-claude/fast-mode) | Eligible |

Versioned snapshots are not covered unless Anthropic lists them or guarantees alias coverage in the current contract. Claude Opus 4.7 rejects fast requests. Claude Opus 4.6 accepts the field but runs and bills at standard speed. Neither is eligible. No partner-hosted model or API-compatible proxy inherits eligibility.

## OpenAI Codex subscription fast mode (ChatGPT backend)

This is a second, distinct OpenAI mapping. It is not the [public OpenAI API contract](#openai), and it never inherits from it.

| Concern | Public OpenAI API Fast/Priority | OpenAI Codex subscription fast mode |
| --- | --- | --- |
| Transport | `https://api.openai.com`, Responses or Chat Completions | `https://chatgpt.com/backend-api`, the Codex responses transport |
| Credential | API key | ChatGPT OAuth subscription token carrying an account claim |
| Source of truth | First-party OpenAI documentation | Codex CLI behavior, reproduced by a reference implementation and confirmed by a live probe |
| Request control | `service_tier: "fast"`, or `"priority"` on supported models | `service_tier: "priority"` **and** two routing headers |
| Response proof | `service_tier` on the response object | `service_tier` on the SSE `response.*` objects |
| Positive value | `"fast"`, or `"priority"` for GPT-5.6 and earlier models | `"priority"` only |
| Allowlist source | Official pricing and Fast mode eligibility | The pinned host's `openai-codex` model catalog |
| Weave adapter status | Unmapped on every adapter | Authorized on Pi only, through the wrapped-provider seam; the shipped build still reports `unsupported` |

### Two-part request contract

One attempt carries both parts or neither part:

1. **Body.** The final serialized request body carries `service_tier: "priority"`.
2. **Headers.** The outgoing request carries `originator: codex_cli_rs` and `x-codex-routing-hint: model=<model id>;tier=priority`, where `<model id>` is exactly the model id the same final body carries.

The header part is conditional on the body part. Fast intent without a resolved `"priority"` tier for that attempt carries neither header. Both parts are request-scoped and are never cached between attempts, so no stale routing hint can survive into a fast-off request. The model id is embedded in a header value, so it must first match `^[A-Za-z0-9._-]{1,64}$`; any other id is ineligible.

### Provenance and evidence basis

Three sources support this contract. None of them is first-party API documentation.

- **Codex CLI derivation.** The header pair reproduces what the OpenAI Codex CLI sends on this transport. OpenAI does not publish it in the API reference.
- **Reference implementation.** [`IgorWarzocha/howaboua-pi-stuff`](https://github.com/IgorWarzocha/howaboua-pi-stuff), commit `bde69c3dfd83bb6dab01961dd9c75b1e814105df` ("fix(pi-codex-conversion): activate Codex Fast Mode"), read at reference HEAD `4b4e42f7659e42854ec81cb502bf69a48422d9eb`. Its `resolveCodexRequestRouting` emits the header pair only when `fast === true && serviceTier === "priority"`, resolves routing from the final body, and its tests pin the both-or-nothing rule across transports.
- **Live probe.** The [Pi 0.84.2 provider-seam audit](#appendix-pi-0842-provider-seam-audit) in this note (probe date 2026-08-17). On the pinned host the backend answered the two-part request with HTTP 200 and a normal completed stream (A15), the outgoing body decoded to `service_tier: "priority"` (A13), and an unknown tier value was rejected with HTTP 400 (A14), which shows the backend validates the field rather than ignoring it.

**Caveat: this is not first-party API documentation.** OpenAI publishes no contract, eligibility table, pricing row, response-value definition, or stability guarantee for this transport. The header names, the header value format, the accepted tier values, and the response `service_tier` semantics can change or disappear without notice, and an account can be ineligible for priority admission for reasons this note cannot observe. Nothing here may be cited as an official OpenAI contract.

**Decision OD-1, approved by the owner on 2026-08-17.** Reverse-engineered provenance is accepted as the evidence basis for this one mapping, because the adapter owns the whole transport: it registers the provider, and it holds the effective post-auth base URL, the resolved credential shape, the final body, the outgoing request headers, and the same attempt's response. The relaxation is scoped to this transport only. It does not lower the threshold for the [public OpenAI API](#openai) or [Anthropic](#anthropic) mappings, which still require first-party documentation for every allowlist entry and every positive response value, and it does not permit a guessed field or header anywhere else.

### Frozen allowlist baseline (pinned host catalog)

**Decision OD-5, approved by the owner on 2026-08-17.** The allowlist is the complete model catalog that the pinned host's `openai-codex` provider ships, and nothing beyond it. Catalog source: `@earendil-works/pi-ai` 0.84.2, `providers/data/openai-codex.json`, api `openai-codex-responses`. Allowlist revision `codex-sub-r1`.

| Provider model | Allowlist rule ID | Transport | Request contract | Response contract | Decision |
| --- | --- | --- | --- | --- | --- |
| `gpt-5.3-codex-spark` | `codex-sub-01` | ChatGPT backend, Codex responses | Two-part contract above | `service_tier` on the SSE `response.*` objects | Eligible |
| `gpt-5.4` | `codex-sub-02` | ChatGPT backend, Codex responses | Two-part contract above | `service_tier` on the SSE `response.*` objects | Eligible |
| `gpt-5.4-mini` | `codex-sub-03` | ChatGPT backend, Codex responses | Two-part contract above | `service_tier` on the SSE `response.*` objects | Eligible |
| `gpt-5.5` | `codex-sub-04` | ChatGPT backend, Codex responses | Two-part contract above | `service_tier` on the SSE `response.*` objects | Eligible |
| `gpt-5.6-luna` | `codex-sub-05` | ChatGPT backend, Codex responses | Two-part contract above, probed live (A15) | `service_tier` on the SSE `response.*` objects, probed live (A16) | Eligible |
| `gpt-5.6-sol` | `codex-sub-06` | ChatGPT backend, Codex responses | Two-part contract above, probed live (A15) | `service_tier` on the SSE `response.*` objects, probed live (A16) | Eligible |
| `gpt-5.6-terra` | `codex-sub-07` | ChatGPT backend, Codex responses | Two-part contract above | `service_tier` on the SSE `response.*` objects | Eligible |

The catalog choice is deliberate and narrow in a different way from the public-API allowlist: every entry reaches the same adapter-owned transport with the same request and response shape, so per-model first-party eligibility rows do not exist and cannot be required. Eligibility still needs an exact id match. A newer host catalog does not widen this list on its own; adding an entry requires re-freezing this table against the pinned catalog, bumping the allowlist revision, and repeating the recheck below. Aliases, snapshots, fine-tuned ids, public-API `openai` models, models reached through a gateway or proxy, and any id that fails the character rule are not eligible.

Evidence may name the allowlist rule ID or the revision. It may not name arbitrary model text.

### Response evidence and ceiling

- Evidence kind: `openai-service-tier`.
- Positive evidence: exactly `"priority"` in a `response.created`, `response.in_progress`, or `response.completed` object read from the same attempt, by a bounded sniffer that never buffers the whole stream and never blocks it.
- Negative evidence: `"default"`, which is the documented standard-speed value. Outcome `standard`, state `not-confirmed`.
- **Observed ceiling on the pinned host.** Audit row A17 failed: `response.completed` reported `"default"` for the full two-part fast request, for a tier-only request, and for the untouched control. Fast and control were indistinguishable in the response evidence. The shipped ceiling for a successful eligible fast request on Pi 0.84.2 is therefore `not-confirmed` with evidence outcome `standard`. `applied` stays reachable in code only through a genuine same-attempt `"priority"` value, which was never observed.
- Three explanations of A17 remain indistinguishable from outside (OD-2): the backend may ignore this control on this transport; the probed subscription may lack priority entitlement, since its credit-balance headers reported no available credits at probe time; or the backend may report `"default"` while still routing differently. Because they cannot be separated, the adapter must never infer acceleration from HTTP status, latency, absence of error, or the mutation itself.

### Recheck obligation for this transport

Every finding for this transport is host-specific and account-specific, and none of it carries a stability guarantee.

- Recheck audit rows A11, A12, A16, A17, and A20 on each Pi or pi-ai upgrade, and before any release that changes the pinned host version.
- Recheck A17 before any claim, in code, docs, telemetry, or release notes, that this mapping accelerates anything.
- Re-read the reference implementation and the Codex CLI behavior before adding an allowlist entry or changing a header name or value format.
- If a recheck shows the backend rejects the contract, the header names changed, the response field disappeared, or `options.fetch` is no longer honored on the SSE path, the mapping reverts to `unsupported`, the adapter sends no control, and the request stays byte-identical.
- A failed recheck is a blocker for the affected release, not a warning.

## Harness seam audit

Versions inspected on 2026-08-12: Pi 0.84.1, OpenCode 1.18.9, and Claude Code 2.1.220. Pi 0.84.2 was inspected again on 2026-08-17 for the wrapped-provider seam. A public seam can support Weave only if the adapter can set the request without replacing unrelated values and can observe the provider's documented response proof for the same attempt.

Pi has two independent seams, and they get separate verdicts. The hook seam stays unsupported. The wrapped-provider seam supports the Codex subscription mapping only.

### Pi 0.84.1 hook seam — unsupported for this adapter

Pi's [extension documentation at tag v0.84.1](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md) and [public extension types](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/types.ts) define these seams:

- `before_provider_request` receives the assembled provider payload. Handlers run in extension order; a returned payload becomes the input to later handlers.
- `before_provider_headers` mutates assembled request headers. It runs once for the provider operation; Pi retries reuse the result.
- `after_provider_response` exposes HTTP status and normalized response headers before stream consumption.

Those hooks can mutate a request, but a mutation alone is not a truthful `requested` state. `requested` requires an exact allowlist match, and the allowlist is a first-party provider contract, so the adapter must know the transport of the request it is holding.

The hook context's `ctx.model.baseUrl` is declared configuration, not the request transport. Pi prepares each request as `resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model`, so auth resolution can replace a first-party declaration with a gateway. The only documented alternative, `ctx.modelRegistry.getProviderAuth(provider)`, performs a *fresh* auth resolution. Its result describes what a new resolution would return; it is not the resolution the held request was prepared with, and awaiting it also lets an asynchronous hook cross a session generation. No public Pi seam reports the effective transport of one prepared request.

The hooks also do not expose the response body or streamed usage event. Pi's public finalized-message type does not expose OpenAI `service_tier` or Anthropic `usage.speed`. Response status and Anthropic limit headers are not positive application proof. Custom provider transports can also omit these callbacks.

**Outcome:** unsupported for this adapter. With neither an effective-transport proof nor a response proof bound to the same prepared request, any acceleration control the adapter sent would be a guess. The adapter therefore registers no provider request or header hook, leaves every provider payload and header exactly unchanged, and reports declared intent as terminal `unsupported` with the reason `harness-seam-unavailable`. Agent activation, prompts, models, tools, and delegation are unaffected. Supporting `requested` requires a documented seam that reports the effective transport of one prepared request; `applied` additionally requires correlated official response-body evidence for that same request.

This verdict is unchanged. The adapter registers no `before_provider_request`, `before_provider_headers`, or `after_provider_response` handler for acceleration on any Pi version. The seam below is a different mechanism, not a relaxation of this one.

### Pi 0.84.2 wrapped provider — supported for the Codex subscription mapping

Pi's public `ExtensionAPI.registerProvider(provider: Provider)` accepts a complete provider object. A Weave-owned override registered under the existing id `openai-codex` wraps the native provider from `@earendil-works/pi-ai`: same id, name, `auth` object by reference, and model list, with only `stream` and `streamSimple` wrapped. This supplies both proofs the hook seam lacks. The [appendix](#appendix-pi-0842-provider-seam-audit) records each assumption and its result.

| Proof the contract requires | Hook seam | Wrapped-provider seam |
| --- | --- | --- |
| Effective post-auth transport of the held request | Absent; `ctx.model.baseUrl` is declared configuration and a fresh auth resolution describes a different request | Present; `requestModel.baseUrl` is the post-auth value (A7), and a `models.json` override is visible and classifies as `transport-not-first-party` (A5) |
| Resolved credential shape for the held request | Absent | Present; `options.apiKey` (A8). The raw token and account id are never read into state, logs, or evidence |
| Final body after other extensions | Absent; `before_provider_headers` runs before the body exists | Present; the caller's `onPayload` runs first and the wrapper sees its output (A9) |
| Authority over `originator` | Absent; the api hardcodes `originator: "pi"` after extension headers | Present at the `fetch` seam (A12), on the SSE path only (A11) |
| Same-attempt response evidence | Absent | Present; a bounded SSE sniffer reads `service_tier` (A16) |

Four constraints follow from the audit and bound what the adapter may ship.

1. **SSE only (OD-3, resolved).** `options.fetch` exists only on the codex SSE path; the WebSocket path builds its own connection and exposes no request seam. The adapter forces `transport: "sse"` for eligible fast requests only. The host default `transport: "auto"` prefers WebSocket, so this is a real change and must never touch a fast-off or ineligible request. Forced SSE completed normally and was not slower in a bounded three-run sample (A19). Weave does not vendor the WebSocket transport.
2. **Version gate, not a raised floor (OD-4, resolved).** `registerProvider` exists at the declared peer floor, but `options.fetch` on the codex SSE path first appears in pi-ai 0.83.0 (A20). Keep the `@earendil-works/pi-coding-agent` peer floor at `>=0.81.1`, and register the wrapper only when the host's public `VERSION` export is at least `0.83.0`, the dynamic import of `@earendil-works/pi-ai/providers/openai-codex` resolves and exposes `openaiCodexProvider`, and `pi.registerProvider` is a function. Any probe failure means register nothing and report `unsupported` with `harness-seam-unavailable`.
3. **Process-level activation window (OD-6, approved by the owner on 2026-08-17).** No per-request agent identity exists at the provider seam, so eligibility is evaluated against the process-local active fast owner. While a fast owner is active, an ambient host request on the same allowlisted model, such as a branch summary or a title generation, is also accelerated. The owner accepts this coarse window. The alternative needs a harness change that does not exist, and narrowing it by heuristic would be a guess. The user-facing adapter documentation must state the window plainly.
4. **Evidence ceiling.** `applied` requires same-attempt positive evidence, and none was observed on the pinned host. A successful eligible fast request terminates at `not-confirmed` with evidence outcome `standard`.

**Outcome:** supported for the OpenAI Codex subscription mapping only, and only through the wrapped provider. Every other provider, including the public-API `openai` provider, stays unmapped and reports `unsupported`. A request that fails any eligibility rule is delegated to the native implementation with the caller's options object unchanged, so it stays byte-identical to the same config without `fast true`. If registration fails, the adapter logs a bounded degradation, leaves the native provider in place, reports `unsupported`, and does not affect agent activation.

### OpenCode 1.18.9 — unsupported for this adapter

OpenCode's tagged [plugin hook types](https://github.com/anomalyco/opencode/blob/v1.18.9/packages/plugin/src/index.ts) expose `chat.params` and `chat.headers`. Current [LLM assembly source](https://github.com/anomalyco/opencode/blob/v1.18.9/packages/opencode/src/session/llm.ts) passes the mutated options as provider options and the mutated headers to the provider call. This is a request mutation seam.

The public plugin event and assistant-message contracts do not expose OpenAI `service_tier` or Anthropic `usage.speed` for a successful call. Error response data, a successful status, or ordinary token usage does not prove acceleration. An authentication loader that replaces `fetch` would take ownership of provider authentication and transport and is not a safe general adapter seam.

**Outcome:** unsupported for this adapter. Because no correlated official response-body proof exists for a successful call, the adapter sends no acceleration control, mutates no request option or header, and reports declared intent as terminal `unsupported` with the reason `response-proof-unavailable`. Descriptor materialization and agent mapping are unaffected. Reaching `requested` requires an implemented exact provider mapping; `applied` additionally requires correlated official response-body evidence, which the current plugin contract cannot supply.

### Claude Code 2.1.220 — unsupported for the current adapter

Claude Code has a native fast mode. Official [interactive mode documentation](https://docs.anthropic.com/en/docs/claude-code/interactive-mode) documents `/fast` and Option/Alt+O. The [Agent SDK TypeScript reference](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript) documents `settings.fastMode: true`, `applyFlagSettings()`, initialization `fast_mode_state`, and `fast_mode_disabled_reason` values such as `not_first_party`, `model_not_allowed`, and `sdk_opt_in_required`.

Those are supported Claude Code or Agent SDK controls, not a seam owned by Weave's current static file-materialization adapter. Official [subagent configuration](https://docs.anthropic.com/en/docs/claude-code/sub-agents) has no fast-mode frontmatter field. Official [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) cover tool, session, and subagent events, not provider request mutation and provider response evidence. Initialization state indicates mode availability, not the provider response's `usage.speed` for one generation.

**Outcome:** unsupported for this adapter. Generated agent or command files must not claim that fast intent was requested or applied. Supporting it requires a runtime Agent SDK integration plus per-attempt response proof, or a new official materialization field with equivalent proof.

## Mapping rules

### Collision policy

1. Work only on an exact provider, endpoint, model, and harness allowlist match.
2. If the acceleration field or required beta header is absent, add the adapter-owned value while preserving all unrelated payload members and headers.
3. If the existing value is exactly the required value, keep it. Record no raw value.
4. If an existing acceleration field or beta-header value differs, do not overwrite it. Return a bounded `collision` reason and classify the attempt as `unsupported`.
5. Treat duplicate case-insensitive header names, non-scalar values, malformed payloads, unknown providers, proxies, and ambiguous model IDs as unsupported. Do not guess.
6. Never modify authentication, organization, project, routing, or other credential-bearing headers.

This policy makes extension order safe: Weave preserves earlier compatible edits and fails closed on conflicting ownership. A later extension can still overwrite Weave's value; missing response proof then prevents a false `applied` state.

### Retry semantics

- Apply intent to each logical provider attempt. Do not infer that a retry inherited acceleration.
- Let the harness/provider retry policy handle transport and rate errors. Weave must not create an unbounded parallel retry loop.
- Respect provider delay signals, cap attempts and delay, and honor cancellation and deadlines.
- Correlate request mutation and response proof to the same attempt using adapter-local opaque identity. If the harness cannot correlate them, the result is `not-confirmed`.
- A failed, canceled, timed-out, or superseded attempt cannot become `applied`.
- OpenAI `default` and Anthropic non-`fast` response evidence are completed but not confirmed attempts. Do not automatically retry solely to force a premium tier.
- Persist only the terminal sanitized outcome for the logical operation and bounded counters. Do not persist raw attempt payloads or responses.

### Pi Codex subscription mapping rules

These rules are normative for the Pi adapter's [wrapped-provider seam](#pi-0842-wrapped-provider-supported-for-the-codex-subscription-mapping). They sit under the general [collision policy](#collision-policy) and [retry semantics](#retry-semantics) above and never relax them. The wrapper computes one eligibility verdict per stream call, before any mutation. Every failure produces a bounded reason and forces native passthrough.

**Eligibility**

1. **Provider identity.** The request reached the Weave-wrapped provider registered under id `openai-codex`. No other provider, including the public-API `openai` provider, ever receives this mapping.
2. **Intent.** The process-local active owner declares `fast: true`: the committed primary descriptor in parent mode, or the authenticated applied bootstrap in child and direct-step mode. Intent must never apply before bootstrap authentication completes. No owner or no intent means passthrough and no acceleration state.
3. **Model.** `requestModel.id` is an exact member of the frozen allowlist above **and** equals the active owner's resolved model id. It must also match `^[A-Za-z0-9._-]{1,64}$` before it may enter the routing hint. Ambient calls for other models pass through.
4. **Transport.** The effective `requestModel.baseUrl` is absent or exactly the first-party ChatGPT backend, compared as a whole string. Any gateway, proxy, localhost, or lookalike base URL yields `transport-not-first-party` and passthrough.
5. **Auth.** The resolved credential parses as a ChatGPT OAuth token whose claim yields an account id. A parse failure yields `auth-not-subscription` and passthrough. The raw token and the account id never enter state, logs, evidence, or errors.

**Collisions**

6. **Body.** After the caller's `onPayload` chain has run, if `service_tier` is absent, set `"priority"`. If it is already exactly `"priority"`, keep it. If it is present with any other value, is not a string, or the payload is not a plain object, record `request-collision`, leave the payload untouched, and activate no header.
7. **Headers.** At fetch time, a preexisting `x-codex-routing-hint` in any casing that this attempt did not write yields `request-collision` and an unmodified request. A preexisting `originator` is Pi's hardcoded `"pi"`; the wrapper replaces it only under full activation. `Authorization`, `chatgpt-account-id`, `session-id`, and every other credential or routing header stay untouched.

**Transport, retry, and state**

8. **Both parts or neither.** Headers activate only when fast intent held and the recorded final body for the same attempt carries `service_tier === "priority"`. Fast-off and ineligible requests gain neither part, and nothing is cached between attempts.
9. **Forced SSE.** Eligible fast requests use `transport: "sse"`, because that is the only path with header authority. Fast-off and ineligible requests keep the native transport.
10. **Retry.** Pi's SSE retry loop reuses the same body and headers for one logical call. The wrapper observes each attempt, records evidence per attempt, caps counters, and takes the terminal snapshot from the final attempt. The wrapper adds no retries of its own. An abort or timeout terminates as `canceled` or `timed-out`. An attempt aborted before any fetch is `canceled`, not `not-confirmed`.
11. **State.** `requested` requires an exact allowlist match plus the wrapper's own fetch actually running for that attempt and writing both parts. `applied` requires same-attempt positive `openai-service-tier` evidence with the exact value `"priority"`. Mutation, HTTP success, or a completed stream alone terminates at `not-confirmed`. Intent with no eligible mapping terminates at `unsupported`.
12. **Fail closed.** Any wrapper-internal failure, ambiguity, or doubt reverts that call to native behavior and records a bounded degradation. The adapter never sends a guessed field or header, and this optional capability never fails agent activation, materialization, or a valid standard request.

## Truthful states and transitions

The neutral runtime states are:

| State | Meaning |
| --- | --- |
| `declared` | The effective active descriptor contains `fast true`, but no provider attempt exists. A source declaration that was overridden or did not reach the active descriptor does not qualify. |
| `requested` | For this attempt, the adapter matched an exact allowlist entry and inserted or preserved every required request control. This is not evidence that the provider applied acceleration. |
| `applied` | The same correlated attempt completed, and the provider's official response field contained the exact positive value defined in this contract. No other signal qualifies. |
| `not-confirmed` | The adapter made a valid fast request, but positive response evidence was absent, inaccessible, ambiguous, standard-tier, or not correlated to that attempt. |
| `unsupported` | The adapter cannot make a valid fast request for this descriptor and attempt because of its harness seam, provider, endpoint, model, transport, malformed input, or collision policy. |

Allowed transitions are:

```text
(no intent) -> no acceleration state

declared -> requested -> applied
declared -> requested -> not-confirmed
declared -> unsupported
```

`requested` is not a success alias. It is transient attempt state. Only `applied` is positive application. A capability declaration, request mutation, HTTP success, latency observation, premium-looking charge, response limit header, project default, or harness mode indicator cannot substitute for the provider's documented response field.

### Adapter fallback

- With no effective `fast` declaration, an adapter leaves provider controls unchanged and emits no acceleration state.
- An adapter may enter `requested` only for an exact mapping in this contract, proven against the transport of the same prepared request. Pi proves this only inside the wrapped-provider seam for the Codex subscription mapping; Pi's hook seam and every other Pi provider, and all of OpenCode, cannot prove it and therefore enter `unsupported` and send no control.
- Claude Code static materialization enters `unsupported`. It must not encode a guessed frontmatter field, environment value, prompt instruction, or provider control. Agent materialization still continues.
- An unknown provider, endpoint, model, proxy, malformed input, or conflicting existing control enters `unsupported`. The adapter does not guess or overwrite the conflict. It preserves unrelated request data and allows normal harness behavior to continue when safe.
- Failure of this optional capability does not fail agent activation, materialization, or an otherwise valid standard request. Existing adapter safety rules may still reject an independently invalid request.

## Breaking DSL, merge, and migration contract

The normative DSL syntax is defined in the [DSL reference](../reference/dsl.md). This section freezes the cross-layer behavior that adapters and exported consumers must implement.

### Merge and generated-category behavior

`fast` uses scalar merge behavior. A higher-priority `fast true` wins; omission does not erase a lower-priority declaration. Trigger arrays use ordered union merge. At each merge, entries from the higher-priority layer come first in their declared order, followed by lower-priority entries that are not exact string duplicates.

For example, builtin triggers `["review code", "fix tests"]`, global triggers `["fix tests", "audit APIs"]`, and project triggers `["ship patch", "review code"]` produce:

```text
["ship patch", "review code", "fix tests", "audit APIs"]
```

Matching is exact and case-sensitive. The merge does not trim, case-fold, sort, or interpret trigger text.

A generated `shuttle-{category}` uses the final merged category trigger list in its existing order. It does not inherit the base `shuttle` triggers. If the category omits triggers, the generated agent has no triggers. The generic `shuttle` keeps its own triggers as the fallback target. A category `fast true` overrides the base value; category omission inherits the base `shuttle` intent. Categories have no file patterns or replacement file-routing field.

### Deterministic migration outcomes

| Legacy form | Required outcome |
| --- | --- |
| Handwritten `.weave` | Parsing fails for a structured trigger object, any category `patterns` field, `fast false`, or a rejected alias. The user must replace each trigger object with one string, delete `patterns`, and use `fast true` only when opting in. No compatibility parser rewrites the file at runtime. |
| Legacy JSONC | The converter selects each trigger object's nonblank `routing_hint`; if absent, it selects its nonblank `trigger`. It preserves source order, removes exact duplicate strings, and warns when `domain` or any other field is discarded. It drops a valid category pattern array with a warning. A malformed pattern value also warns and produces no metadata. A category with a nonblank description still converts; one without a nonblank description is skipped. The converter never infers `fast` from a legacy or provider-specific name. |
| Builtin config | Maintainers replace each structured trigger with its nonblank `routing_hint`, or its `trigger` when no nonblank hint exists; exact duplicates are removed in source order. All category patterns are deleted. Builtins pass through the same strict DSL parser and receive no compatibility path. |
| Exported core, engine, and adapter consumers | Consumers replace structured trigger types with `string[]`, remove every category `patterns` read/write, and accept the optional literal intent `fast?: true`. Removed trigger-object and pattern types receive no deprecated alias. Old TypeScript values fail compilation, and old untyped values fail strict runtime validation. |

Example legacy JSONC input:

```jsonc
{
  "agents": {
    "loom": {
      "triggers": [
        { "domain": "Review", "trigger": "Review code", "routing_hint": "Use for pull request review" },
        { "domain": "Tests", "trigger": "Fix tests" },
        { "domain": "Review", "trigger": "Duplicate", "routing_hint": "Use for pull request review" }
      ]
    }
  },
  "categories": {
    "backend": {
      "description": "Backend APIs",
      "patterns": ["src/api/**"]
    }
  }
}
```

The deterministic converted declarations are:

```weave
agent loom {
  triggers ["Use for pull request review", "Fix tests"]
}

category backend {
  description "Backend APIs"
}
```

The converter reports discarded trigger fields and dropped patterns. It does not emit aliases, structured trigger objects, or a pattern replacement.

## Sanitized evidence

Adapters may emit only these bounded fields:

- neutral state;
- adapter ID and adapter version;
- provider family enum;
- endpoint family enum;
- allowlist rule ID or revision, not arbitrary model text;
- attempt count, each bounded by the retry policy;
- collision boolean;
- evidence kind enum: `openai-service-tier`, `anthropic-usage-speed`, or `none`;
- evidence outcome enum: `confirmed`, `standard`, `absent`, `ambiguous`, or `inaccessible`;
- bounded reason code, such as `harness-seam-unavailable`, `model-not-allowed`, `endpoint-not-allowed`, `transport-not-first-party`, `auth-not-subscription`, `request-collision`, `response-proof-unavailable`, `attempt-uncorrelated`, `rate-limited`, `capacity-limited`, `canceled`, or `timed-out`;
- event time and bounded duration, if already part of the neutral runtime contract.

Do not emit model prompts, completions, payload fragments, raw field values, full headers, header values, credentials, provider request/response objects, URLs, stack traces, harness objects, session transcripts, or private paths. Logs and errors follow the same rule.

## Decision

No Weave harness adapter has a complete request-plus-response seam that can prove `applied` under the official first-party provider contracts. One adapter-owned transport is now the single exception, and it is capped below `applied`:

- Pi hook seam: unsupported (`harness-seam-unavailable`); request hooks exist, but no hook binds an effective transport or a response proof to one prepared request. The adapter registers no acceleration hook.
- Pi wrapped-provider seam, OpenAI Codex subscription mapping only: supported for `requested`, capped at `not-confirmed`. The adapter's registered `openai-codex` override holds the effective transport, the resolved credential shape, the final body, the outgoing headers, and the same attempt's response. `applied` stays reachable in code only from same-attempt `service_tier: "priority"`; the pinned host returned `"default"` for fast and control alike, so the observed terminal state is `not-confirmed` with evidence outcome `standard`.
- Pi public OpenAI API (`openai` provider) and every other Pi provider: unsupported (`harness-seam-unavailable`).
- OpenCode: unsupported (`response-proof-unavailable`); request option/header hooks exist, but no success evidence does.
- Claude Code materialization: unsupported (`harness-seam-unavailable`); native fast controls exist outside the adapter's owned surface.

Outside the Pi Codex subscription mapping, every adapter still declares `provider-fast-activation` as `unsupported`, sends no acceleration control, and leaves provider requests untouched, so `fast true` stays inert neutral intent end to end and leaves those requests byte-identical to the same config without it. The Pi adapter's shipped build reports `unsupported` until the mapping is implemented; this note authorizes that implementation and fixes its rules and ceiling in advance.

Within the Pi Codex subscription mapping, a request that fails any rule in [Pi Codex subscription mapping rules](#pi-codex-subscription-mapping-rules) is also byte-identical passthrough. `requested` is not a success alias, and the adapter must not describe this mapping as making anything faster.

Any change to these ceilings requires new evidence. Raising an adapter to `requested` requires a proven safe request seam under this note's contract; raising one to `applied` requires correlated response evidence carrying the exact positive value for that contract. Lowering is automatic: a failed [recheck](#recheck-obligation-for-this-transport) returns the Codex subscription mapping to `unsupported`.

## Appendix: Pi 0.84.2 provider-seam audit

Probe date: 2026-08-17.

Harness under test: `@earendil-works/pi-coding-agent` 0.84.2 and `@earendil-works/pi-ai` 0.84.2, installed globally and executed under Bun. Comparison versions read from the public npm registry: pi-ai 0.81.1, 0.82.0, 0.83.0, 0.84.0.

This appendix is the raw evidence for the [Codex subscription contract](#openai-codex-subscription-fast-mode-chatgpt-backend) and the [wrapped-provider verdict](#pi-0842-wrapped-provider-supported-for-the-codex-subscription-mapping). It records what the pinned host does. The [hook-seam verdict](#pi-0841-hook-seam-unsupported-for-this-adapter) still stands: the audit below tests a different seam, a Weave-registered provider override.

### Method

A disposable extension at `/tmp/weave-task1-probe/probe.ts` wrapped the native `openai-codex` provider and registered the wrapper through `pi.registerProvider(provider)`. The extension was never installed. Every run used `pi -ne -e <path> --no-session -nt`, so extension discovery was off, no session was written, and no tool ran. Runs used the real `~/.pi/agent` directory so the ChatGPT OAuth credential rotated in place.

Probe modes:

| Mode | Behavior |
| --- | --- |
| `record-only` | Delegate to the native implementation with the caller's options object unchanged. |
| `observe` | Force `transport: "sse"` and install an observing `fetch`. Write no body field and no header. |
| `tier-only` | Set `service_tier: "priority"` in the body. Write no header. |
| `fast` | Set `service_tier: "priority"`, then set `originator: codex_cli_rs` and `x-codex-routing-hint: model=<id>;tier=priority`. |
| `collision` | A second handler sets `service_tier` first. The wrapper must decline. |

Evidence files, sanitized, machine-readable: `/tmp/weave-task1-probe/evidence-summary.json` (SHA-256 `a63aec84afead450781ae8347afe9b8f9e05be79946be2ce2ddf4ca31f78e4f4`), consolidated from the per-run `report*.jsonl` and `timing-*.jsonl` files in the same directory. Probe source: `/tmp/weave-task1-probe/probe.ts` (SHA-256 `d5aa6882fb6bb5c20cdda5ca3a5cafbc928193884d06710d4f1af2accd47a43d`). The probe recorded only enums, booleans, small integers, header names, and the two non-secret literal values the adapter itself would write.

### Results

| # | Assumption | Result | Evidence |
| --- | --- | --- | --- |
| A1 | An extension can register a full `Provider` under the existing id `openai-codex`. | Pass | `pi.registerProvider` is a function; registration returned without error. |
| A2 | Pi routes real generations for existing codex models through the registered override. | Pass | Every live run recorded `wrappedInvoked: true` on entry `streamSimple` for `gpt-5.6-luna` and `gpt-5.6-sol`, api `openai-codex-responses`. |
| A3 | The coding agent calls `streamSimple`, not `stream`. | Pass | Entry `streamSimple` in all runs. `stream` was never observed. |
| A4 | OAuth and `/login` survive the override. | Pass, with one part untested | The wrapper preserves the native `auth` object by reference, the same id, name, and model list, and the `login`, `refresh`, and `toAuth` functions. `pi auth check --provider openai-codex` reported `ready` / `oauth` before and after the probe run set. Live generations succeeded on the stored subscription credential. An interactive `/login` was not run: it would replace the user's real credential, so it is not safely testable here. |
| A5 | `models.json` composes above a registered native provider. | Pass | With a temporary `openai-codex.baseUrl` override, the wrapper received `effectiveBaseUrlClass: "other"` instead of the first-party value. `models.json` wins, so a gateway override is detectable at the seam and must classify as `transport-not-first-party`. The file was restored and its SHA-256 verified. |
| A6 | `models.json` provider headers reach the seam as `options.headers`. | Pass | The wrapper observed the two configured header names on this machine in `options.headers`. |
| A7 | The wrapper receives the post-auth effective transport. | Pass | Without the override, `model.baseUrl` equaled the first-party ChatGPT backend exactly. |
| A8 | The wrapper receives the resolved credential. | Pass | `options.apiKey` parsed as a three-part JWT carrying a ChatGPT account claim. Neither the token nor the account id was recorded. |
| A9 | The caller's `onPayload` runs before the wrapper's, and its output is what the wrapper sees. | Pass | Caller hook order 1, wrapper order 2, `callerRanFirst: true`. In `collision` mode the wrapper observed the caller's `service_tier: "flex"`. |
| A10 | `transport: "sse"` is honored end to end. | Pass | Forced-SSE runs reached the wrapper `fetch` and completed normally. The host default is `transport: "auto"`, which prefers WebSocket. |
| A11 | `options.fetch` is honored on the codex SSE path. | Pass on 0.84.2 | `fetchInvoked: true`, method `POST`, first-party codex responses URL. |
| A12 | The wrapper owns `originator` at the fetch seam. | Pass | Before the write the header was `pi`. After the write it was `codex_cli_rs`, and `x-codex-routing-hint` carried `model=<id>;tier=priority`. Hook-based headers cannot do this, because the api sets `originator: "pi"` after applying extension headers. |
| A13 | The final body carries the wrapper's tier. | Pass | The outgoing zstd body decoded to `service_tier: "priority"` with a `model` field equal to the request model. |
| A14 | Collision handling can fail closed. | Pass | With a foreign `service_tier: "flex"`, the wrapper did not overwrite the value and activated no header. The backend answered `400` with `Unsupported service_tier: flex`, which also shows the backend validates the field rather than ignoring it. |
| A15 | The backend accepts the two-part fast contract. | Pass | HTTP 200 and a normal completed stream for `gpt-5.6-luna` and `gpt-5.6-sol`. No rejection, no warning, no changed stop reason. |
| A16 | The SSE response exposes `service_tier`. | Pass | `response.created` and `response.in_progress` reported `"auto"`; `response.completed` reported `"default"`. |
| A17 | The two-part contract produces positive response evidence. | **Fail** | `response.completed` reported `"default"` in every fast, tier-only, and control run. Fast and control were indistinguishable in the response evidence. |
| A18 | Passthrough stays out of the way. | Pass | `record-only` runs delegated with the same options reference and completed normally. |
| A19 | Forcing SSE does not regress latency here. | Pass, bounded sample | Three runs each on one prompt and one machine: `transport: "auto"` 2.14 s, 1.55 s, 1.68 s; forced SSE 1.32 s, 1.39 s, 1.19 s. |
| A20 | The seam exists at the declared peer floor. | **Fail** | `registerProvider(provider: Provider)` exists in pi-coding-agent 0.81.1. But `options.fetch` on the codex SSE path, and `fetch` in `buildBaseOptions`, first appear in pi-ai 0.83.0; 0.81.1 and 0.82.0 call `fetch` directly. Below 0.83.0 the wrapper could set the body tier but never the headers. |

### Open decision resolutions

The probe resolved OD-2, OD-3, and OD-4. OD-1, OD-5, and OD-6 are owner decisions, approved on 2026-08-17 and recorded in the body of this note: [provenance basis](#provenance-and-evidence-basis), [frozen allowlist](#frozen-allowlist-baseline-pinned-host-catalog), and the process-level activation window in the [wrapped-provider verdict](#pi-0842-wrapped-provider-supported-for-the-codex-subscription-mapping).

**OD-2 — does the ChatGPT backend expose `service_tier` in the SSE response objects?**

Resolved: yes, the field is exposed and readable, but it did not confirm acceleration.

The response channel exists. A bounded SSE sniffer read `response.created.service_tier`, `response.in_progress.service_tier`, and `response.completed.service_tier` without disturbing the stream. On the pinned host, `response.completed` reported `"default"` for the full two-part fast request, for a tier-only request, and for the untouched control. Under this contract's evidence rules, `"default"` is documented negative evidence.

Consequence for the implementation: the evidence kind `openai-service-tier` is available and must be read, and the evidence outcome must be reported honestly. The observed outcome is `standard`, not `absent` or `inaccessible`. Therefore the shipped ceiling for a successful eligible fast request on this host is `not-confirmed` with evidence outcome `standard`. `applied` stays reachable in code only through a genuine `"priority"` value on the same attempt, and no such value was observed. Request mutation must never be labeled `applied`.

Caveats that this probe cannot separate, all of which must be restated in Task 2:

- the backend may ignore the two-part control for this transport;
- the probed subscription may not be entitled to priority admission. The account's credit-balance response headers reported no available credits at probe time;
- the backend may report `"default"` while still routing the request differently.

Because these are indistinguishable from outside, the adapter must not infer acceleration from anything other than a positive `service_tier` value.

**OD-3 — is forcing `transport: "sse"` for fast requests acceptable?**

Resolved: yes. Force SSE for eligible fast requests only. Do not vendor the WebSocket transport.

The host default is `transport: "auto"`, which prefers WebSocket, so forcing SSE is a real change and must apply only to requests that pass every eligibility rule. The WebSocket path builds its own connection and exposes no request seam, so header authority is unprovable there. Forced SSE completed normally in every run and was not slower in a bounded three-run sample. Fast-off and ineligible requests keep the native transport untouched.

**OD-4 — peer floor or runtime gate?**

Resolved: keep the declared peer floor and gate on the host version, then fail closed per attempt.

Do not raise `@earendil-works/pi-coding-agent` beyond the current `>=0.81.1`. The rest of the Pi adapter works on those hosts, and this capability is optional. Instead:

1. Register the wrapped provider only when the host's public `VERSION` export from `@earendil-works/pi-coding-agent` is at least `0.83.0`. pi-coding-agent pins pi-ai in lockstep on the minor (`^0.81.1`, `^0.83.0`, `^0.84.2`), so this is a reliable proxy for `options.fetch` support and, unlike reading a package manifest, it is safe under Pi's extension loader.
2. Require the dynamic import of `@earendil-works/pi-ai/providers/openai-codex` to resolve and expose `openaiCodexProvider`, and require `pi.registerProvider` to be a function. Any failure means register nothing and report `unsupported` with `harness-seam-unavailable`.
3. Keep the per-attempt correlation as the backstop. Claim `requested` only when the wrapper's own `fetch` actually ran for that attempt and wrote both parts. Rule 8 stays both-or-nothing, so a host that silently drops `options.fetch` yields no partial mutation.

### Recheck obligations

Every finding above is host-specific and account-specific. Recheck A11, A12, A16, A17, and A20 on each Pi and pi-ai upgrade, and recheck A17 before any claim that the mapping accelerates anything. The `originator` and `x-codex-routing-hint` pair is not first-party API documentation and carries no stability guarantee.
