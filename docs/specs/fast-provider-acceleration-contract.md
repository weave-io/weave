# Fast provider acceleration contract

Date: 2026-08-12

Status: Approved and shipped; every adapter declares `provider-fast-activation` as `unsupported` and mutates no provider request

Retrieval date for web sources: 2026-08-12

## Purpose

This note fixes the evidence threshold for provider acceleration before Weave maps the neutral `fast` intent. It records current provider contracts and harness seams. Provider and harness behavior is volatile. Recheck every linked contract before an allowlist change.

Normative provider facts below come from first-party API documentation. Harness facts come from public documentation, tagged public source, and installed public types. Examples confirm shape but do not extend an allowlist.

## Neutral Weave boundary

Core and engine may carry only the user's neutral acceleration intent and bounded outcome state. They must not carry provider request fields, request or response headers, credentials, raw payloads, raw responses, harness event objects, or arbitrary provider metadata. Each adapter owns provider recognition, the exact allowlist, request mutation, response interpretation, and safe diagnostics.

The only acceleration declaration is the literal `fast true` on an agent or category. Omission preserves the provider default. `fast false` is invalid, and there is no unset operator. The names `service_class`, `speed`, `variant`, and `priority` are invalid aliases in the DSL. Intent alone does not select a provider, model, endpoint, or credential.

For a category-generated agent, an explicit category `fast true` takes precedence over the base `shuttle` value. If the category omits `fast`, the generated agent inherits the base `shuttle` intent. Because the only valid value is `true`, a higher-priority config layer cannot cancel an inherited declaration; it can only omit the field and leave the lower declaration in place.

## Official provider contracts

### OpenAI

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

## Harness seam audit

Versions inspected on 2026-08-12: Pi 0.84.1, OpenCode 1.18.9, and Claude Code 2.1.220. A public seam can support Weave only if the adapter can set the request without replacing unrelated values and can observe the provider's documented response proof for the same attempt.

### Pi 0.84.1 — unsupported for this adapter

Pi's [extension documentation at tag v0.84.1](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md) and [public extension types](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/types.ts) define these seams:

- `before_provider_request` receives the assembled provider payload. Handlers run in extension order; a returned payload becomes the input to later handlers.
- `before_provider_headers` mutates assembled request headers. It runs once for the provider operation; Pi retries reuse the result.
- `after_provider_response` exposes HTTP status and normalized response headers before stream consumption.

Those hooks can mutate a request, but a mutation alone is not a truthful `requested` state. `requested` requires an exact allowlist match, and the allowlist is a first-party provider contract, so the adapter must know the transport of the request it is holding.

The hook context's `ctx.model.baseUrl` is declared configuration, not the request transport. Pi prepares each request as `resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model`, so auth resolution can replace a first-party declaration with a gateway. The only documented alternative, `ctx.modelRegistry.getProviderAuth(provider)`, performs a *fresh* auth resolution. Its result describes what a new resolution would return; it is not the resolution the held request was prepared with, and awaiting it also lets an asynchronous hook cross a session generation. No public Pi seam reports the effective transport of one prepared request.

The hooks also do not expose the response body or streamed usage event. Pi's public finalized-message type does not expose OpenAI `service_tier` or Anthropic `usage.speed`. Response status and Anthropic limit headers are not positive application proof. Custom provider transports can also omit these callbacks.

**Outcome:** unsupported for this adapter. With neither an effective-transport proof nor a response proof bound to the same prepared request, any acceleration control the adapter sent would be a guess. The adapter therefore registers no provider request or header hook, leaves every provider payload and header exactly unchanged, and reports declared intent as terminal `unsupported` with the reason `harness-seam-unavailable`. Agent activation, prompts, models, tools, and delegation are unaffected. Supporting `requested` requires a documented seam that reports the effective transport of one prepared request; `applied` additionally requires correlated official response-body evidence for that same request.

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
- An adapter may enter `requested` only for an exact mapping in this contract, proven against the transport of the same prepared request. Pi and OpenCode cannot prove that today, so both enter `unsupported` and send no control.
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
- bounded reason code, such as `harness-seam-unavailable`, `model-not-allowed`, `endpoint-not-allowed`, `transport-not-first-party`, `request-collision`, `response-proof-unavailable`, `attempt-uncorrelated`, `rate-limited`, `capacity-limited`, `canceled`, or `timed-out`;
- event time and bounded duration, if already part of the neutral runtime contract.

Do not emit model prompts, completions, payload fragments, raw field values, full headers, header values, credentials, provider request/response objects, URLs, stack traces, harness objects, session transcripts, or private paths. Logs and errors follow the same rule.

## Decision

No current Weave harness adapter has a complete request-plus-response seam that can prove `applied` under the official provider contracts:

- Pi: unsupported (`harness-seam-unavailable`); request hooks exist, but no seam binds an effective transport or a response proof to one prepared request.
- OpenCode: unsupported (`response-proof-unavailable`); request option/header hooks exist, but no success evidence does.
- Claude Code materialization: unsupported (`harness-seam-unavailable`); native fast controls exist outside the adapter's owned surface.

All three adapters therefore ship with `provider-fast-activation` declared `unsupported`, send no acceleration control, and leave provider requests untouched. `fast true` remains inert neutral intent end to end.

This is the shipped result, not a staging point: Pi reports `harness-seam-unavailable`, OpenCode reports `response-proof-unavailable`, and Claude Code materialization reports `harness-seam-unavailable`. No adapter adds a provider field, header, or service-tier control, so `fast true` leaves every request byte-identical to the same config without it.

Any change to these ceilings requires new evidence. Raising an adapter to `requested` requires a proven safe request seam under this note's contract; raising one to `applied` requires an official harness response seam and tests against the exact provider evidence contract.

## Appendix: Pi 0.84.2 provider-seam audit

Probe date: 2026-08-17.

Harness under test: `@earendil-works/pi-coding-agent` 0.84.2 and `@earendil-works/pi-ai` 0.84.2, installed globally and executed under Bun. Comparison versions read from the public npm registry: pi-ai 0.81.1, 0.82.0, 0.83.0, 0.84.0.

This appendix is evidence only. It records what the pinned host does. It does not change the Decision section above. The hook-seam verdict in "Pi 0.84.1 — unsupported for this adapter" still stands: the audit below tests a different seam, a Weave-registered provider override.

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
