# ADR 0008: Harness Trajectory Evals via Two-Channel Observation

**Status**: Accepted (2026-09-03)
**Date**: 2026-09-03
**Related**: [Agent Evals](../agent-evals.md) · [Product Vision](../product-vision.md) · [Adapter Boundary](../adapter-boundary.md) · [Spec 33: Harness Trajectory Evals](../specs/33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md)

**Acceptance note (2026-09-03)**: Phase 1 shipped per the rollout plan below: Channel A only, one case (`loom-route-shuttle-implement-utility-trajectory`), one model (`openai/gpt-4o-mini`), one sandbox (`opencode-default`). Publishable fields (`harnessDelegatedCorrectly`, `observedSpawns`, `observedToolCalls`, `harnessCompletedWithoutError`) are live in the published bundle schema (version 2). Channel B migration (step 6) remains a follow-up, not required for acceptance.

---

## Context

The current eval surface (`weave eval run`, `packages/cli/src/evals/`) is intentionally **text-only**: each case sends one chat completion to OpenRouter and extracts signals by regex over assistant text. This is documented as the "text-only contract" in `docs/agent-evals.md` and as an "explicit non-goal" for runtime-backed trajectory evals.

The consequence is a stated blind spot. When the published dashboard shows `Loom Routing: 89%`, it means the model's *text output* named the correct delegate 89% of the time. It does **not** mean that any real harness — OpenCode, Claude Code, Pi — actually spawned a `shuttle` subagent, actually called the right tools, or actually produced the expected file changes. All the runtime behavior our product story depends on remains unproven by our own evals.

Two questions drove this ADR:

1. **Is runtime observation of a real harness technically viable at reasonable cost?** The prior estimate was ~1.5 weeks of work, dominated by building a harness plugin, a runtime schema, and a sandbox from scratch.
2. **If viable, how should the observation be structured so that it does not couple the eval engine to a specific harness?**

A short empirical spike (Podman + OpenCode 1.18.27 + OpenRouter, ~2 hours, well under $0.01 of live spend) resolved both questions. The spike is preserved outside the repo at `C:\Users\piete\AppData\Local\Temp\opencode\spike-tier2\`. It ran a real Loom-then-Shuttle delegation twice, on a real model, in a real container, and produced two independent, ground-truth observations of the delegation. Notably, OpenCode already emits enough structured runtime information to reconstruct the full trajectory without any Weave-side plugin at all.

That result reshaped the cost estimate downward and made a specific architectural boundary attractive: keep the trajectory runner harness-agnostic, but let each adapter choose *how* it exposes trajectory events to the runner.

---

## Decision

Weave adds a second eval track — **harness trajectory evals** — alongside the existing text-only track, and defines observation as a two-channel contract owned by the adapter.

**Track structure.**

- The existing text-only suites keep their current runners, their current fixtures, and their current publishable contract. They continue to prove prompt and model quality on assistant text.
- A parallel `harness_trajectory` track is introduced through a new `expected_outcome.kind: "harness_trajectory"` in the case schema. Trajectory cases are gated by the shared suite registry (`packages/cli/src/evals/types.ts`) to trajectory-capable suites only, exactly the way the current registry gates `tool_call` outcomes.
- Trajectory cases and text-only cases coexist in the same suite family (e.g. `loom-routing` can hold both), but they are scored by different runners and reported as separate dashboard rows so they cannot be conflated.

**Observation contract.**

The engine defines a normalized `TrajectoryEvent` union and asserts against it. The adapter is responsible for producing that event stream. The adapter is free to choose either of two channels — or a hybrid — as long as the final stream conforms:

- **Channel A — Runtime log parsing.** The adapter parses the harness's own structured stderr/stdout output (e.g. OpenCode's `--print-logs --log-level DEBUG` `key=value` stream) into `TrajectoryEvent` records. Zero coupling into the harness itself.
- **Channel B — Harness plugin.** The adapter registers a harness-native plugin (e.g. the existing `@weaveio/weave-adapter-opencode` plugin) that subscribes to typed hooks (`tool.execute.before`, `chat.message`, `event`) and emits `TrajectoryEvent` records directly.

Weave-core knows only about the normalized event stream. Whether a specific adapter uses Channel A, Channel B, or both is an adapter-internal detail. This preserves the boundary rules in `docs/adapter-boundary.md`: the engine does not scan harness-owned directories, does not register concrete harness callbacks, and does not know which channel any particular adapter chose.

**Sandbox model.**

Trajectory eval sessions run in a Podman container with:

- Per-case ephemeral workspace mounted at `/workspace`
- Trajectory event JSONL mounted at `/artifacts/trajectory.jsonl`
- Wall-clock timeout enforced by the runner
- `--auto` (auto-approve permissions) inside the container
- No network egress beyond the model provider endpoint

The sandbox is defined per adapter (each adapter ships its own Containerfile against a stable engine interface). The engine treats the container as a black box that takes `(workspace, prompt, model)` and returns `trajectory.jsonl`.

**Publishable surface.**

The trajectory JSONL is **raw data** and is written to the local-only `raw/` subdirectory, the same boundary that `RawCaseResultArtifact` already enforces for text-only cases. The publishable `CaseResultSummary` gains a small, bounded set of trajectory-derived fields:

- `harnessDelegatedCorrectly: boolean`
- `observedSpawns: string[]` (child agent names, ordered)
- `observedToolCalls: number` (count only, no arguments)
- `harnessCompletedWithoutError: boolean`

The dashboard renders a "Runtime-verified" badge on affected suites and reports these fields alongside the existing dimensions. Session transcripts, tool arguments, file contents, and error text never appear in the publishable bundle.

---

## Consequences

### Positive

- **The product story becomes provable.** "Loom delegated to Shuttle" stops being a claim about assistant text and becomes an observation of the actual OpenCode session, with a public artifact behind it.
- **The 1000-line text extractor stops being load-bearing** for the runtime story. It still serves the text-only suites, but claims about harness behavior no longer route through prose parsing.
- **Adapter independence is preserved.** OpenCode can use Channel A today (the spike confirmed the stderr log stream contains every needed event), and migrate to Channel B for richer typed events later. Claude Code, Pi, and future adapters make their own choice against the same engine contract.
- **The `tapestry-category-routing` 0% story becomes debuggable.** A trajectory case for that suite could distinguish "the harness fanned out to two category shuttles" from "the model's text mentioned one shuttle" — currently indistinguishable in the published data.

### Negative

- **Two runner surfaces to maintain.** Text-only cases and trajectory cases have different runners, different scorers, and different publishable fields. Duplication is real; the mitigation is to keep the shared suite registry as the single source of truth for suite IDs, allowed outcomes, and short aliases, so drift is caught by the existing sync tests.
- **Cost per case rises.** A trajectory case is a full agentic session (many turns × many tokens × sandbox setup), not a single chat completion. The spike came in under one cent per session on `openai/gpt-4o-mini`, so this is manageable at the current scale (single-digit dozens of trajectory cases), but it does not scale to hundreds of cases per model in a nightly matrix without a cost policy.
- **Sandbox operational surface.** Container images must be maintained, pinned, and refreshed as OpenCode and other harnesses release. This is real ongoing work, though CI already carries similar burdens for other tooling.
- **Model choice is constrained.** Trajectory suites need models that reliably use tools. Some models in the current text-only matrix would score poorly on trajectory suites for reasons unrelated to Weave. The suite registry must be able to declare per-suite model matrices, not one global matrix.

### Deferred (explicit non-goals of this ADR)

- **Semantic correctness of the produced code.** A trajectory case can prove that `edit` was called and the file was modified, but not that the modification is correct. Case-shipped verifier scripts run against the sandbox are a plausible next ADR, not this one.
- **Sandbox hardening beyond Podman defaults.** No custom seccomp profile, no network egress filtering beyond "point the model provider at OpenRouter." Hardening is deferred until the first suite ships and threat modeling has real usage to reason about.
- **Cross-harness trajectory comparison.** Trajectory results are scored per-adapter. Cross-harness pass-rate matrices are a reporting question for the dashboard team, not an engine concern.

---

## Alternatives considered

**Alternative 1: Ship only Channel B (plugin-only observation).** Rejected. The spike proved Channel A already works today, at zero adapter-integration cost, using OpenCode's existing log output. Requiring a plugin path for every harness raises the per-harness integration cost and delays the first shippable trajectory suite by weeks. Plugin observation is still valuable as a richer alternative, but it should not be the entry ticket.

**Alternative 2: Ship only Channel A (log-parsing only).** Rejected. Log parsing is fragile against harness output changes and provides less structured data than a plugin hook. Foreclosing Channel B would mean each future release of OpenCode/Claude Code/Pi could quietly break our runners. The two-channel contract lets each adapter pick the sturdier of the two paths for its situation.

**Alternative 3: Extend the current text-only runners with tool-call assertions.** Rejected. The current runners have no runtime signal to assert against — they read one chat completion. Adding tool-call assertions to those runners would either require inventing fake tool telemetry (which is what the text-only contract explicitly disallows in `docs/agent-evals.md`) or reshaping the runners into trajectory runners, which is what this ADR proposes as a parallel track.

**Alternative 4: Delay until an in-house eval harness exists.** Rejected. There is no roadmap for an in-house harness, and the spike showed a real one can be observed today for essentially zero marginal work. Delaying trades a present, cheap capability for a hypothetical future one.

---

## Rollout

Delivery is staged so each step lands a shippable artifact without requiring the next step to exist.

1. **Spec.** Write `docs/specs/<N>-spec-harness-trajectory-evals/` describing the `TrajectoryEvent` union, the `expected_outcome.kind: "harness_trajectory"` schema addition, and the runner contract. Include the two-channel adapter guidance and the publishable field set. (~1 day.)
2. **Engine surface.** Add the normalized event types to `@weaveio/weave-core` and the new expected-outcome kind to the case schema and validator. Update the registry gate so trajectory outcomes are only allowed on trajectory-capable suites. (~1 day.)
3. **First adapter, Channel A.** Ship a Channel-A trajectory runner in `@weaveio/weave-adapter-opencode`: Podman-driven session, stderr log parser, JSONL emitter. Include the Containerfile in the adapter package. (~2 days.)
4. **First trajectory case.** Add one `loom-routing` trajectory case (`loom-route-shuttle-implement-utility-trajectory`) with an expected spawn of `shuttle` and an expected `edit` tool call, and wire it into the existing suite. Update the dashboard renderer to show a "Runtime-verified" badge on suites that contain any trajectory cases. (~half day.)
5. **Documentation.** Update `docs/agent-evals.md` and `packages/docs/src/content/docs/docs/evals.mdx` to describe the two tracks, cross-link this ADR, and note that runtime-backed evals are no longer an explicit non-goal. (~half day.)
6. **Channel B follow-up (optional).** Once (3)-(5) are live, migrate the OpenCode adapter to consume the plugin hooks documented in `packages/adapters/opencode/src/plugin.ts` as a second event source, and prove parity with Channel A on the same case set before removing the log-parsing path. Tracked as a follow-up ADR if the migration produces material changes to the observation contract.

Total to a shippable first trajectory suite on OpenCode: **~4 working days**. Each step is independently mergeable and independently useful.
