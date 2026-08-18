# Pi OpenAI Codex Subscription Fast Mode

## TL;DR
Teach the Pi adapter to translate the neutral `fast true` intent into the ChatGPT-backed OpenAI Codex subscription Fast Mode contract (`service_tier: "priority"` body + `originator: codex_cli_rs` + `x-codex-routing-hint` headers), through a Weave-owned wrapped-provider seam that finally gives the adapter the effective-transport and correlated-response proofs the current hook-based audit said were missing. Core and engine stay untouched.

## Context

### Reference behavior (ground truth)

Reference: https://github.com/IgorWarzocha/howaboua-pi-stuff, commit `bde69c3dfd83bb6dab01961dd9c75b1e814105df` ("fix(pi-codex-conversion): activate Codex Fast Mode"), verified at reference HEAD `4b4e42f7659e42854ec81cb502bf69a48422d9eb` in:

- `packages/pi-codex-conversion/src/providers/openai-codex/headers.ts` — `resolveCodexRequestRouting({ model, fast, serviceTier, normalOriginator })` returns `{ originator: "codex_cli_rs", routingHint: "model=<model>;tier=priority" }` **only when** `fast === true && serviceTier === "priority"`; otherwise `{ originator: normalOriginator }` with **no** routing hint. `buildBaseCodexHeaders` sets `x-codex-routing-hint` only when a hint exists, so fast-off requests carry no inherited hint.
- `packages/pi-codex-conversion/src/providers/openai-codex/request-body.ts` — `options.serviceTier` writes `body.service_tier`; the runtime injects `serviceTier: "priority"` only when `config.openai.fast === true` (`extension/runtime.ts:168`).
- `packages/pi-codex-conversion/src/providers/openai-codex/transport-recovery.ts` and `openai-codex-custom-provider.ts` — SSE, WebSocket, and prewarm paths all resolve routing once from the **final** body (`body.model`, `body.service_tier`) and pass the same `originator`/`routingHint` pair to both header builders.
- `packages/pi-codex-conversion/tests/openai-codex-request.test.ts` — "Fast Mode request identity is opt-in and transport invariant": fast+priority ⇒ both headers on both transports; fast-off ⇒ normal originator and `x-codex-routing-hint` absent; fast without a resolved priority tier ⇒ normal originator.

The reference can do this because it **owns the whole Codex transport** as a registered custom provider. Account identity (`chatgpt-account-id` from the OAuth JWT) and the ChatGPT backend (`https://chatgpt.com/backend-api`) are intrinsic to that transport.

### Audit / parity matrix

| Concern | Reference (`pi-codex-conversion`) | Weave core/config/engine (current) | Weave Pi adapter (current) |
| --- | --- | --- | --- |
| Fast intent | Global `config.openai.fast` boolean | Neutral literal `fast true` on agent/category → `AgentDescriptor.fast?: true`; no provider terms (`docs/architecture/adapter-boundary.md`) | Carried on primary session state, child bootstrap (`child-control-bodies.ts:204`), and direct-step input (`direct-dispatch.ts:59`); never translated |
| Body control | `body.service_tier = "priority"` via own `buildRequestBody` | N/A (must never appear here) | None; tests assert zero payload mutation |
| Header contract | `originator: codex_cli_rs` + `x-codex-routing-hint: model=<m>;tier=priority`, conditional on final tier | N/A | None; `extension-impl.ts` registers no `before_provider_request` / `before_provider_headers` / `after_provider_response` handler |
| Transport ownership | Full custom provider (SSE + WebSocket + prewarm) | N/A | None; Pi's native `openai-codex` provider (`@earendil-works/pi-ai` 0.84.2) hardcodes `originator: "pi"` after all extension headers |
| Eligibility proof | Implicit (provider *is* the ChatGPT transport) | N/A | `docs/specs/fast-provider-acceleration-contract.md` audit: hooks cannot bind effective transport or response proof to one prepared request ⇒ terminal `unsupported` / `harness-seam-unavailable` |
| Runtime state | Config toggle, no state machine | Engine already exports `PROVIDER_FAST_ACTIVATION_STATUSES = ["declared","requested","applied","not-confirmed","unsupported"]` and evidence kind `openai-service-tier` (`packages/engine/src/capability-contract.ts`) | `provider-fast-activation.ts` allows only `unsupported`; `capability-declarations.ts` declares `unsupported`; telemetry journals only that terminal snapshot |
| Public OpenAI API Fast/Priority | Out of scope for the reference | Documented as a distinct first-party API contract in the fast spec | `unsupported` (unchanged by this plan) |

### Decisive host findings (pinned Pi 0.84.2 / pi-ai 0.84.2, inspected locally)

1. **Hooks alone cannot satisfy the contract.** `pi-ai/dist/api/openai-codex-responses.js` builds headers as: model headers → extension headers (`before_provider_headers` output) → then hardcodes `Authorization`, `chatgpt-account-id`, **`originator: "pi"`**, `User-Agent`. An extension header named `originator` is always overwritten. Also `before_provider_headers` fires during auth resolution, before the body exists, so header activation cannot be conditioned on the final `service_tier`. The existing spec verdict for the hook seam stays true.
2. **A provider seam fixes both proofs.** `Models.streamSimple` (pi-ai `models.js`) resolves auth first and calls `provider.streamSimple(requestModel, context, requestOptions)` where `requestModel.baseUrl` is the **effective** post-auth transport and `requestOptions.apiKey` is the resolved credential. A Weave-registered provider therefore holds the effective transport, the account credential shape, the final body (via its own `onPayload` chain, which pi-ai calls before serializing for both SSE and WebSocket), the outgoing request (via `options.fetch`, SSE path only, `openai-codex-responses.js:265`), and the same attempt's response — a complete, per-request correlation the hook audit lacked.
3. **The pieces are importable.** `@earendil-works/pi-ai` (already a peer dependency) exports subpaths `./providers/openai-codex` (`openaiCodexProvider()`) and `./api/openai-codex-responses`, and `createProvider` accepts a full `ProviderStreams` api. Pi's `ExtensionAPI.registerProvider(provider: Provider)` accepts a complete provider object (`pi-coding-agent/dist/core/extensions/types.d.ts:1014`; `docs/custom-provider.md`).
4. **`options.fetch` exists only on the SSE path.** The WebSocket path builds its own connection with no injection seam, so header authority is only provable when the fast request is forced to `transport: "sse"`.
5. **`serviceTier` survives only on the raw `stream` options.** `streamSimple`'s `buildBaseOptions` drops `serviceTier`, so the wrapper must inject the tier through its own `onPayload` step (which pi-ai applies to both transports) rather than through the option.

### Chosen architecture (minimal correct seam)

Register a Weave-owned override of the `openai-codex` provider that wraps `openaiCodexProvider()` from pi-ai: identical `id`, `name`, `auth`, and model catalog; only `stream`/`streamSimple` are wrapped. Per request:

- **No fast intent, or any eligibility failure ⇒ byte-identical passthrough** to the native implementation (no option, payload, header, or transport change).
- **Eligible fast request ⇒** delegate to the native codex api with three adapter-owned request-scoped injections: (a) an `onPayload` chain that runs the caller's `onPayload` (Pi's `before_provider_request` extensions) first, then sets `service_tier: "priority"` under the collision policy and records the final `{ model, service_tier }`; (b) `transport: "sse"` so the header seam is provable; (c) an adapter `fetch` that, only when the recorded final tier is `"priority"` and no collision occurred, sets `originator: codex_cli_rs` and `x-codex-routing-hint: model=<model>;tier=priority` on the outgoing request, and observes the same attempt's response for bounded evidence.

Each new abstraction is tied to a concrete need: the provider override exists because hooks cannot own `originator`; the `onPayload` chain exists because the tier must reflect the *final* body after other extensions run; the fetch wrapper exists because it is the only point that holds request headers and response for the same attempt; the SSE forcing exists because WebSocket has no such point. Nothing else is added. Core, config, and engine already carry everything needed (`fast?: true`, the five activation statuses, `openai-service-tier` evidence kind), so **no DSL, core, config, or engine change is planned**.

### Key current-code anchors

- `packages/adapters/pi/src/provider-fast-activation.ts` — single-state (`unsupported`) vocabulary to be widened.
- `packages/adapters/pi/src/extension-impl.ts` — `activeProviderFastIntentOwner()` (~line 2920), `resolveProviderFastState()`, `reportProviderFastIntent()`, child-mode bootstrap state; the same extension runs in parent, ordinary-child, and direct-step child processes.
- `packages/adapters/pi/src/telemetry.ts` — `PiProviderFastJournalEvent`, `recordProviderFastTransition`, `renderProviderFastStatusLine`.
- `packages/adapters/pi/src/capability-declarations.ts` — `provider-fast-activation` entry (`readiness: "unsupported"`).
- `packages/adapters/pi/src/__tests__/provider-fast-activation.test.ts`, `__tests__/extension.test.ts` — assert the no-mutation contract today.
- `scripts/release/acceptance-manifest-data.ts:520` — "declares provider-fast-activation as unsupported, never requested or applied".
- Docs: `docs/specs/fast-provider-acceleration-contract.md`, `docs/adapters/pi.md` (§ fast), `docs/reference/adapter-capabilities.md`, `docs/reference/configuration.md`, `docs/reference/dsl.md`, `docs/architecture/adapter-boundary.md` ("Today every adapter reports `unsupported`"), `packages/docs/src/content/docs/docs/reference/adapters/pi.mdx`.

## Scope

- In scope:
  - Pi adapter only: a wrapped `openai-codex` provider seam, per-request fast routing, bounded evidence, widened runtime states, telemetry, capability declaration, docs/spec/changeset updates, and real-harness verification.
  - Two distinct adapter-local mappings under one neutral intent: (a) ChatGPT Codex subscription mapping (implemented here); (b) public OpenAI API Fast/Priority mapping (explicitly remains `unsupported` on Pi, documented as distinct).
  - Primary sessions, ordinary delegated children, and direct workflow steps (all run this extension; children receive `fast` via authenticated bootstrap).
- Out of scope:
  - Any DSL, core, config, or engine schema change. `fast true` stays neutral end to end.
  - Public OpenAI API (`api.openai.com`, API-key auth) acceleration on Pi; OpenCode and Claude Code adapters; Anthropic fast mode.
  - WebSocket fast transport and any Codex WebSocket prewarm (Pi 0.84.2's coding agent has no codex prewarm surface; the reference's prewarm is its own feature). Fast requests force SSE; fast-off requests keep the native transport untouched.
  - Compaction/branch-summarizer special-casing beyond the model+intent rule defined below.
  - General transcript DLP for tool output (explicitly excluded by prior owner decision).
- Constraints / assumptions:
  - Pinned host: Pi 0.84.2 / pi-ai 0.84.2 (peer floor `>=0.81.1` — Task 1 decides whether the seam needs a raised floor or a version gate).
  - The `originator`/`x-codex-routing-hint` contract is **not** first-party public API documentation; it is derived from the Codex CLI via the reference. Open decision OD-1 must be accepted before Task 2 lands.
  - Fail closed everywhere: any doubt ⇒ native passthrough and a bounded reason, never a guessed header.
  - Adapter test rules: never start a real harness in `bun test`; mock the native provider and fetch (`packages/adapters/AGENTS.md`).

## Objectives

- `fast true` on an agent whose resolved model is an allowlisted `openai-codex` subscription model produces requests carrying the exact two-part Codex Fast Mode contract, proven per attempt.
- Requests without intent, or failing any eligibility rule, remain byte-identical to today.
- Runtime state is honest: `requested` only after an exact match plus applied controls; `applied` only from correlated same-attempt response evidence; otherwise `not-confirmed`/`unsupported` with bounded reasons.
- All existing validation (`bun test`, typecheck, lint, docs links) passes, and the change is proven in a fresh real Pi TUI per `docs/testing/adapter-verification.md`.

## Eligibility, collision, and state rules (normative for this plan)

The wrapper computes one eligibility verdict per stream call, before any mutation. Every failure is a bounded reason and forces native passthrough:

1. **Provider identity**: the request reached the Weave-wrapped provider registered under id `openai-codex`. No other provider (including `openai`) ever gets this mapping — this keeps the subscription mapping and the public-API mapping distinct.
2. **Intent**: the process-local active owner declares `fast: true` — committed primary descriptor in parent mode; authenticated applied bootstrap in child/direct-step mode (reuse `activeProviderFastIntentOwner()` semantics). No owner or no intent ⇒ passthrough with no acceleration state.
3. **Model**: `requestModel.id` is an exact member of a frozen adapter-local allowlist (Task 3 freezes it from the pinned pi-ai `openai-codex` catalog) **and** equals the active owner's resolved model id. Ambient calls for other models pass through. `requestModel.id` must also match `^[A-Za-z0-9._-]{1,64}$` before it may be embedded in the routing hint (header-injection guard).
4. **Transport proof**: effective `requestModel.baseUrl` is absent or exactly the first-party ChatGPT backend (`https://chatgpt.com/backend-api`). A gateway/proxy baseUrl (for example a local `models.json` override) ⇒ `transport-not-first-party`, passthrough. Note: the local firekeeper/gateway setup on this machine is deliberately ineligible.
5. **Auth proof**: the resolved credential parses as a ChatGPT OAuth token whose JWT claim yields an account id (same check pi-ai's `extractAccountId` performs); parse failure ⇒ ineligible. The raw token and account id never enter state, logs, or evidence.
6. **Body collision**: after the caller's `onPayload` chain, if `service_tier` is absent ⇒ set `"priority"`; if already exactly `"priority"` ⇒ keep; if present with any other value, non-string, or the payload is not a plain object ⇒ `request-collision`, do not touch the payload, and do not activate headers.
7. **Header collision**: at fetch time, a preexisting `x-codex-routing-hint` (any casing) not written by this attempt ⇒ `request-collision`, send the request unmodified. A preexisting `originator` is always Pi's hardcoded `"pi"`; the wrapper replaces it only under full activation. Never touch `Authorization`, `chatgpt-account-id`, `session-id`, or any other credential/routing header.
8. **Two-part conditionality**: headers activate only when fast intent held **and** the recorded final body `service_tier === "priority"` for this same attempt. Fast-off or ineligible requests never gain either header, so no stale routing hint can persist (headers are request-scoped; nothing is cached between attempts).
9. **Retry/fallback**: pi-ai's SSE retry loop reuses the same headers/body per logical call; the wrapper's fetch observes each attempt and records evidence per attempt, with the terminal snapshot taken from the final attempt. Wrapper adds no retries of its own. Abort/timeout ⇒ `canceled`/`timed-out`, never `applied`. If provider registration itself fails at startup, the adapter logs a bounded degradation, leaves the native provider in place, and reports `unsupported`; agent activation is unaffected (rollback behavior = remove/revert the registration, native behavior returns).
10. **Evidence**: `applied` requires same-attempt positive evidence of kind `openai-service-tier` extracted by a bounded sniffer on the SSE response (first `response.created`/`response.completed` event's `service_tier`, bounded scan window, pure passthrough after resolution). If the backend does not expose it (OD-2 unresolved or probe negative), the terminal state for a successful fast request is `not-confirmed` with outcome `inaccessible`/`absent` — request/header mutation alone is never labeled `applied`.

## Dependencies and Order

1. Task 1 (host-seam spike) gates everything: it converts the architecture above from "believed" to "proven" on the pinned host, and resolves OD-2/OD-3 evidence questions.
2. Task 2 (spec amendment) must land before implementation because the shipped spec currently *forbids* any mutation; OD-1 must be accepted here.
3. Tasks 3 → 4 → 5 build pure modules bottom-up, test-first; each is independently verifiable.
4. Task 6 (state vocabulary + telemetry) can proceed in parallel with 4–5 but must precede 7.
5. Task 7 (wiring) depends on 3–6. Task 8 (declarations/manifest/test updates) depends on 7. Task 9 (docs/changeset) depends on 7–8. Task 10 (full validation) depends on all code tasks. Task 11 (real-harness proof) is last and blocks completion claims.

## Tasks

- [x] 1. Prove the host seam on pinned Pi 0.84.2 (spike, evidence only)
  - **What**: In a disposable local extension (not committed to `src/`), prove or refute each seam assumption against the real host, and record findings.
  - **Files**: `docs/specs/fast-provider-acceleration-contract.md` (appendix "Pi 0.84.2 provider-seam audit"), scratch extension under `/tmp` only.
  - **Depends on**: None.
  - **Implementation outline**:
    1. Register a full-`Provider` override with id `openai-codex` wrapping `openaiCodexProvider()`; confirm Pi routes existing codex models through it, `/login` OAuth still works, and confirm the composition order against a `models.json` override of the same provider (expected: models.json wins, making a user gateway ineligible by rule 4).
    2. Prove `provider.streamSimple` receives the post-auth `requestModel.baseUrl` and resolved `apiKey`, and that `onPayload`, `transport: "sse"`, and `options.fetch` are honored end-to-end by the codex api.
    3. With a live subscription credential, send one fast-shaped request (tier + both headers) and one control request; capture whether the SSE `response.created`/`response.completed` events expose `service_tier`, and whether the backend accepts/ignores/rejects the routing headers. Record sanitized results only (no tokens, no account ids, no raw payloads).
    4. Confirm which pi/pi-ai versions expose the needed surfaces and decide the peer floor / version gate (see OD-4).
  - **Pitfalls / non-goals**:
    - Do not leave the scratch extension installed; restore the launcher state.
    - A negative finding on any assumption converts the affected later task into a fail-closed staged variant (state capped at `not-confirmed` or the whole feature stays `unsupported`); do not improvise a different seam without updating this plan.
  - **Acceptance**:
    - Appendix records pass/fail per assumption with harness versions and dates.
    - OD-2, OD-3, and OD-4 each have a written resolution.

- [ ] 2. Amend the fast provider acceleration spec for the Codex subscription contract
  - **What**: Add an "OpenAI Codex subscription (ChatGPT backend)" provider contract distinct from public OpenAI Priority, and update the Decision/harness-audit sections so the spec permits exactly the seam this plan builds.
  - **Files**: `docs/specs/fast-provider-acceleration-contract.md`.
  - **Depends on**: Task 1; OD-1 accepted.
  - **Implementation outline**:
    1. Document the two-part contract, its provenance (reference commit `bde69c3`, Codex CLI derivation, Task 1 live probe), and an explicit "not first-party API documentation" caveat with a recheck obligation.
    2. Write the eligibility/collision/state rules from this plan into the spec as the normative mapping; keep the public-OpenAI section unchanged and cross-link the distinction.
    3. Replace "Pi: unsupported (`harness-seam-unavailable`)" in the Decision with the wrapped-provider verdict and its ceilings (`applied` only if Task 1 proved response evidence; else ceiling `not-confirmed`).
  - **Pitfalls / non-goals**:
    - Do not weaken the public-OpenAI or Anthropic evidence thresholds; the provenance relaxation applies only to the subscription transport the adapter itself owns.
  - **Acceptance**:
    - Spec builds a coherent story: hook seam still unsupported; provider seam supported with exact rules; states table unchanged in vocabulary.
    - `bun run docs:check-links` passes.

- [ ] 3. Pure routing + eligibility module (test-first)
  - **What**: A pure module for routing resolution, the frozen model allowlist, and eligibility classification with bounded reasons.
  - **Files**: `packages/adapters/pi/src/codex-fast/routing.ts`, `packages/adapters/pi/src/__tests__/codex-fast-routing.test.ts`.
  - **Depends on**: Task 2.
  - **Implementation outline**:
    1. Export `CODEX_FAST_ORIGINATOR = "codex_cli_rs"`, `CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint"`, `CODEX_FIRST_PARTY_BASE_URL`, frozen `CODEX_FAST_MODEL_ALLOWLIST` (exact ids from the pinned pi-ai `openai-codex` catalog chosen in OD-5, each with an allowlist rule id).
    2. `resolveCodexFastRouting({ modelId, fast, serviceTier })` mirroring the reference: both parts or nothing; reject model ids failing `^[A-Za-z0-9._-]{1,64}$`.
    3. `classifyCodexFastEligibility(...)` returning a discriminated union over bounded reasons (`model-not-allowed`, `transport-not-first-party`, `auth-not-subscription`, `request-collision`, ...), taking only already-extracted scalars (never the raw token or payload).
  - **Pitfalls / non-goals**:
    - Tests first: fast+priority ⇒ both parts; fast-off ⇒ neither; fast without priority ⇒ neither (transport-invariant, mirroring the reference test).
    - Malicious inputs: model id with `\r\n`, `;`, unicode, 65+ chars ⇒ ineligible; gateway/localhost/lookalike (`chatgpt.com.evil.tld`) baseUrls ⇒ `transport-not-first-party`; exact-string URL comparison, no substring matching.
    - Secret-shaped inputs must never be echoed in returned values (follow the existing `SECRET_SHAPED_INPUT` test pattern).
  - **Acceptance**:
    - `bun test packages/adapters/pi/src/__tests__/codex-fast-routing.test.ts` passes; module has no imports from pi-ai, engine, or Node.

- [ ] 4. Request-scoped attempt correlator (test-first)
  - **What**: A small state machine correlating one stream call's payload decision, header activation, per-attempt fetches, and response evidence into one sanitized terminal snapshot.
  - **Files**: `packages/adapters/pi/src/codex-fast/attempt.ts`, `packages/adapters/pi/src/__tests__/codex-fast-attempt.test.ts`.
  - **Depends on**: Task 3.
  - **Implementation outline**:
    1. `createCodexFastAttempt(eligibility)` with transitions: payload-resolved (`tier`, collision flag) → header-activation decision → per-attempt evidence (`confirmed` / `standard` / `absent` / `ambiguous` / `inaccessible`) → terminal snapshot in the engine status vocabulary (`requested`, `applied`, `not-confirmed`, `unsupported`) plus bounded reason and attempt count.
    2. Enforce rule 8 (both-or-nothing) and rule 10 (`applied` only from same-attempt confirmed evidence); cap attempt counters.
  - **Pitfalls / non-goals**:
    - An attempt aborted before any fetch ⇒ `canceled`, not `not-confirmed`.
    - Out-of-order or duplicate evidence callbacks must not double-count or upgrade a terminal state.
    - No timers, no I/O, no raw values stored — enum tokens and small integers only.
  - **Acceptance**:
    - Property-style tests cover every transition and prove `applied` is unreachable without confirmed evidence; mutation-without-evidence yields exactly `requested`→`not-confirmed`.

- [ ] 5. Wrapped provider (test-first, mocked native provider)
  - **What**: `wrapCodexProviderForFast(native, intentPort, attemptSink)` producing a `Provider` identical to the native one except for wrapped `stream`/`streamSimple`, implementing passthrough, injection, SSE forcing, header authority, and the bounded evidence sniffer.
  - **Files**: `packages/adapters/pi/src/codex-fast/provider.ts`, `packages/adapters/pi/src/codex-fast/evidence-sniffer.ts`, `packages/adapters/pi/src/__tests__/codex-fast-provider.test.ts`.
  - **Depends on**: Tasks 3–4.
  - **Implementation outline**:
    1. Ineligible/fast-off path: delegate with the caller's options object unchanged (assert referential identity in tests) — byte-identical behavior.
    2. Eligible path: chain `onPayload` (caller first, then rule-6 mutation + recording), force `transport: "sse"`, install the wrapper `fetch` implementing rule 7/8 header writes and per-attempt evidence capture, pass everything else through.
    3. Evidence sniffer: a `TransformStream` passthrough that scans only until the first `response.created`/`response.completed` SSE event or a fixed byte budget (e.g. 64 KiB), extracts `service_tier`, then becomes pure passthrough; on parse trouble report `ambiguous`/`inaccessible`, never disturb the stream.
    4. On any thrown/rejected wrapper-internal step, fail closed to native behavior for that call and record a bounded degradation (neverthrow at every seam per repo rules).
  - **Pitfalls / non-goals**:
    - Never buffer the full response; never clone the response body.
    - The wrapper must not capture a stale intent snapshot: eligibility is computed per call from the intent port.
    - Preserve pi-ai's zstd request compression path untouched (headers are mutated on the `fetch` init, not the body).
    - Proxy/malicious cases in tests: hostile `onPayload` from another extension returning a poisoned payload (getter traps, `service_tier` accessor) ⇒ collision/ineligible, no throw; hostile response streams (no SSE framing, giant first event, binary) ⇒ bounded outcome.
  - **Acceptance**:
    - Tests with a mocked native provider + mocked fetch prove: exact header/body writes for eligible calls on both header casing variants; zero mutation otherwise; per-attempt evidence wiring; no real process or network (`packages/adapters/AGENTS.md` rules).

- [ ] 6. Widen the adapter's fast state vocabulary and telemetry
  - **What**: Replace the single-state `unsupported` contract in `provider-fast-activation.ts` with the full bounded vocabulary, keeping the hook-audit `unsupported` outcome for every non-codex mapping, and extend telemetry to journal and render the new snapshots.
  - **Files**: `packages/adapters/pi/src/provider-fast-activation.ts`, `packages/adapters/pi/src/telemetry.ts`, `packages/adapters/pi/src/__tests__/provider-fast-activation.test.ts`, `packages/adapters/pi/src/__tests__/telemetry.test.ts` (or the existing telemetry test file).
  - **Depends on**: Task 2 (vocabulary), parallel with 4–5.
  - **Implementation outline**:
    1. Extend `PROVIDER_FAST_STATES` to the five engine statuses and `PROVIDER_FAST_UNSUPPORTED_REASONS` to the bounded set used by Tasks 3–4; keep `ProviderFastPublicSnapshot` enum-only.
    2. Keep `classifyProviderFastIntent` as the no-mapping fallback (intent without an eligible codex mapping ⇒ `unsupported`), add the codex-mapping snapshot constructor fed by Task 4 terminals.
    3. Update journal dedupe so distinct terminal `(state, reason, evidenceOutcome)` tuples each persist once per session, still bounded; update `renderProviderFastStatusLine` for the new states (e.g. `fast: requested (codex-subscription)`, `fast: applied`, `fast: not-confirmed (response-proof-unavailable)`).
  - **Pitfalls / non-goals**:
    - Rewrite the existing tests that pin the single-state contract deliberately (they exist to force this conversation); preserve the secret-shaped-input assertions.
    - Snapshots still carry no provider string, model text, URL, or header value; the allowlist **rule id** is the only model-adjacent token.
  - **Acceptance**:
    - Adapter tests pass; engine capability tests (`capability-contract.test.ts`, `capability-effective.test.ts`) pass unchanged, proving no engine edit was needed.

- [ ] 7. Wire the wrapped provider into the extension (all three surfaces)
  - **What**: Register the wrapped provider at extension init in parent, ordinary-child, and direct-step-child processes; connect the intent port to the existing owner resolution; report attempt terminals through telemetry and `/weave:status`.
  - **Files**: `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/codex-fast/register.ts` (thin registration seam for testability), `packages/adapters/pi/src/__tests__/extension.test.ts`.
  - **Depends on**: Tasks 3–6.
  - **Implementation outline**:
    1. In `runWeaveExtension` startup (after trust/mode gating), build the wrapper from `openaiCodexProvider()` and call `pi.registerProvider(provider)` guarded by a `Result`; on failure log a bounded degradation and continue (capability stays `unsupported` for that process).
    2. Intent port: parent mode reads the committed primary generation owner (`activeProviderFastIntentOwner()` + the owner's resolved model id); child mode reads the authenticated applied bootstrap (`childModeState`, `child-control-bodies.ts` `fast` field; direct steps arrive via `direct-dispatch.ts` bootstrap). Fast intent must never apply before bootstrap authentication completes.
    3. Route Task 4 terminal snapshots into `recordProviderFastTransition` and the status line; reset reporting on generation/session replacement as today.
    4. Update `resolveProviderFastState()` so `/weave:status` reflects the latest codex-mapping terminal instead of the hardcoded unsupported snapshot when a mapping attempt exists.
  - **Pitfalls / non-goals**:
    - Registration happens once per process; hot-reload (`/reload`) must not double-wrap (wrap the freshly obtained native provider, never a previously wrapped instance).
    - The generic `openai` provider and every other provider remain untouched — no `before_provider_*` hook is registered anywhere.
    - Ambient host requests (branch summaries, title generation) using the same eligible model while a fast owner is active will also be accelerated; this coarse process-level window is accepted and documented (OD-6).
  - **Acceptance**:
    - Extension tests prove: registration in parent and child mode with mocked `PiExtensionApi`; no registration when host lacks `registerProvider` (version gate from OD-4); passthrough when health-only; status line renders new states.

- [ ] 8. Reconcile capability declaration, acceptance manifest, and stale no-mutation assertions
  - **What**: Raise the static ceiling honestly and update every artifact that pins the old "never requested or applied" claim.
  - **Files**: `packages/adapters/pi/src/capability-declarations.ts`, `scripts/release/acceptance-manifest-data.ts`, remaining `packages/adapters/pi/src/__tests__/*` no-mutation assertions.
  - **Depends on**: Task 7.
  - **Implementation outline**:
    1. Declare `provider-fast-activation` readiness `degraded` (one provider mapping, capped evidence; `native` would be a lie while public OpenAI stays unmapped), with notes naming the codex-subscription-only scope and the OD-2 evidence ceiling; runtime status flows from the live snapshot via `providerFastActivationState` / `effectiveProviderFastReadiness` (evidence may lower, never raise).
    2. Update the acceptance manifest entry at `scripts/release/acceptance-manifest-data.ts:520` to assert the new truthful ceiling (e.g. "requests codex-subscription fast only under the exact eligibility rules; never reports applied without correlated evidence").
  - **Pitfalls / non-goals**:
    - This is an optional capability: it must never affect health-only mode or activation regardless of state.
  - **Acceptance**:
    - `bun run lint` and the release acceptance data checks pass; capability tests reflect `degraded` + runtime statuses.

- [ ] 9. Documentation and changeset
  - **What**: Update all user-facing docs to the new truthful behavior and add the changeset.
  - **Files**: `docs/adapters/pi.md`, `docs/reference/adapter-capabilities.md`, `docs/reference/configuration.md`, `docs/reference/dsl.md` (the "changes nothing about your requests" caveat), `docs/architecture/adapter-boundary.md` ("Today every adapter reports `unsupported`" sentence), `packages/docs/src/content/docs/docs/reference/adapters/pi.mdx`, `.changeset/<new>.md`.
  - **Depends on**: Tasks 7–8.
  - **Implementation outline**:
    1. Describe the two distinct mappings, the exact eligibility rules, the SSE-only fast transport, the evidence ceiling, and the fail-closed behaviors (gateway baseUrl, collisions, registration failure).
    2. Changeset: `patch` for `@weaveio/weave-adapter-pi` (feature is adapter-internal, no public API change) — or `minor` if the exported adapter surface grows; state which in the changeset body.
  - **Pitfalls / non-goals**:
    - Do not promise acceleration outcomes; document that `requested` ≠ faster.
  - **Acceptance**:
    - `bun run docs:check-links` passes; docs and spec tell the same story; OpenCode/Claude Code docs remain unchanged.

- [ ] 10. Full validation
  - **What**: Run the complete repo validation suite.
  - **Depends on**: Tasks 3–9.
  - **Implementation outline**:
    1. `bun test` (workspace-wide), `bun run typecheck`, `bun run lint`, `bun run build`, `bun run docs:check-links`, `bun run validate-config`.
  - **Pitfalls / non-goals**:
    - No test may spawn a real Pi process or perform network I/O.
  - **Acceptance**:
    - All commands exit 0 with no new warnings attributable to this change.

- [ ] 11. Real-harness verification (adapter-verification five stages)
  - **What**: Prove install, load, readiness, and live fast behavior in a fresh interactive Pi TUI per `docs/testing/adapter-verification.md`, and record the evidence.
  - **Depends on**: Task 10.
  - **Implementation outline**:
    1. Build `packages/adapters/pi/dist/extension.js`, record digests; `bun run verify:pi-host-singleton` must print `PASS`.
    2. Load via the approved local path (symlinked extension + `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` in the local launcher only; npm provenance for release proof).
    3. Fresh TUI: `/weave:health` ready, `/weave:status` `health-only: false`; with a `fast true` agent on an allowlisted codex model and a first-party subscription credential, run one generation and confirm the terminal state (`requested`/`not-confirmed`/`applied` per OD-2) in `/weave:status` and the telemetry journal; run one control generation without intent and confirm no acceleration state and unchanged behavior.
    4. Negative controls: a gateway `models.json` baseUrl override ⇒ `transport-not-first-party` passthrough; fast-off after fast-on ⇒ no routing headers on the wire (verify via a local capture or the host's request debug surface, not log grep alone).
    5. Run one ordinary delegation and one direct workflow step with a fast child and verify child settlement, zero leases, and the child-side state.
  - **Pitfalls / non-goals**:
    - Print/RPC modes are not valid substitutes for the interactive proof.
    - If live verification cannot run, report the missing proof as a blocker; do not claim completion.
  - **Acceptance**:
    - Evidence bundle (digests, health output, sanitized wire/headers proof, terminal states, lease check) recorded; completion claim only with all five stages.

## Open decisions (resolve before implementation)

- **OD-1 (blocks Task 2)**: Accept reverse-engineered provenance (Codex CLI + reference + live probe) as the evidence basis for the subscription mapping, relaxing the spec's first-party-docs rule for the transport the adapter itself owns. Owner must approve.
- **OD-2 (resolved by Task 1)**: Does the ChatGPT backend expose `service_tier` in the SSE response objects? Yes ⇒ `applied` reachable; no ⇒ ship with ceiling `not-confirmed` and evidence outcome `inaccessible`.
- **OD-3 (resolved by Task 1)**: Confirm forcing `transport: "sse"` for fast requests is acceptable (latency/behavior trade-off vs. vendoring the WebSocket transport). Recommended: SSE-only now; WebSocket support only if a later need justifies owning that transport.
- **OD-4 (resolved by Task 1)**: Peer/version gate — raise `@earendil-works/pi-coding-agent` peer floor, or keep the floor and gate registration on a runtime capability probe (`registerProvider` + subpath import success). Recommended: runtime gate, fail closed to `unsupported`.
- **OD-5 (blocks Task 3)**: Exact frozen model allowlist from the pinned pi-ai `openai-codex` catalog (candidates observed: `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, plus the current gpt-5.6 family entries). Owner picks the initial set; additions require the spec's allowlist procedure.
- **OD-6 (blocks Task 7)**: Accept the coarse process-level activation window (ambient host calls on the same eligible model are accelerated while a fast owner is active), since no per-request agent identity exists at the provider seam. Alternative (rejected as over-engineering): none currently available without harness changes.

## Verification

```bash
bun test
bun run typecheck
bun run lint
bun run build
bun run docs:check-links
bun run validate-config
bun run verify:pi-host-singleton   # must print PASS
```

Then the Task 11 live-harness bundle: fresh interactive TUI shows `/weave:health` ready; a fast-declared codex agent yields the agreed terminal state with sanitized evidence; a no-intent control run is byte-identical passthrough; gateway and fast-off negative controls hold; one delegation and one direct step settle with zero remaining leases. The plan is complete only when all commands pass **and** the five-stage real-harness proof is recorded.
