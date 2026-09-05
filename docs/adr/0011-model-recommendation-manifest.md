# ADR 0011: Advisory Model Recommendation Manifest

**Status**: Proposed
**Date**: 2026-09-05
**Related**: [Adapter Boundary](../adapter-boundary.md) · [Product Vision](../product-vision.md) · [DSL Reference](../dsl-reference.md)

---

## Context

Weave ships hardcoded baseline model preferences for its built-in agents. Every built-in agent in [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts) currently declares a single-element `models` array (`["claude-sonnet-4-5"]`). Model resolution is deterministic and local: [`packages/config/src/merge.ts`](../../packages/config/src/merge.ts) union-merges built-in, global, and project preferences, and [`packages/engine/src/model-resolution.ts`](../../packages/engine/src/model-resolution.ts) resolves intent via a pure priority chain against adapter-supplied availability.

There is no mechanism for Weave to communicate updated model guidance to users between package releases. Two forces make this a growing problem:

1. **Model release cadence outpaces Weave's release cadence.** New frontier models, new price/quality tiers, and new provider options appear frequently. Users who track releases manually diverge from users who do not.
2. **Multi-model orchestration is emerging as a first-class technique.** GitHub's [Project HydraFusion](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) (Sept 2026) shows that routing between models — via patterns such as *single*, *cascade*, and *draft-critique-revise* — can reach frontier quality at substantially lower cost. Static per-agent model lists cannot express that intent.

Weave needs a way to publish guidance about which models to use for which roles, and eventually about how models should cooperate, without turning a remote document into an implicit configuration channel that overrides user intent.

A naive approach — automatically opting users into "recommended" models via a remote fetch — is rejected up front. It violates the principle that Weave's runtime behavior is deterministic from local configuration, and it creates a remote-control surface over agent execution.

---

## Decision

Weave will publish a **versioned, advisory Model Recommendation Manifest** from an official Weave-controlled HTTPS origin. The manifest is **read, previewed, and explicitly applied by the user**. It never alters Weave's runtime configuration automatically.

Key constraints on the decision:

- **Advisory, not authoritative.** The manifest is guidance. Applying a recommendation writes to the user's local `.weave/config.weave` (project) or `~/.weave/config.weave` (global) with an explicit diff shown beforehand. No runtime code path fetches the manifest during agent execution or model resolution.
- **Versioned and pinned.** Every manifest carries a `schemaVersion`, a `revision` identifier, and a `minimumWeaveVersion`. Users adopt a specific revision; upgrades require an explicit action.
- **Availability-aware.** Recommendations are filtered against adapter-reported available models before being surfaced. A recommendation for a model the user's harness cannot reach is never shown as applicable.
- **Never trumps explicit user intent.** Recommendations sit below project and global user declarations in effective priority. They are equivalent to updating the built-in defaults — which the merge pipeline already treats as the lowest layer.
- **Not routed through `overrideModel`.** The engine's `overrideModel` input in `ModelResolutionInput` has the highest priority in the resolution chain. Reusing it for recommendations would silently override user config, which is exactly what this ADR forbids.
- **Fetched and cached by the CLI/adapter layer, not the engine.** Network I/O and consent flows belong at the harness boundary. The engine remains pure and deterministic.
- **Phased.** The first release is a static list of model preferences per agent. Capability metadata and orchestration policies are deferred to later phases.

### Manifest shape (schema version 1)

```json
{
  "schemaVersion": 1,
  "revision": "2026-09-05",
  "minimumWeaveVersion": "0.8.0",
  "profiles": {
    "balanced": {
      "description": "Balanced quality and cost for most workloads",
      "agents": {
        "loom":    ["provider/model-a", "provider/model-b"],
        "shuttle": ["provider/model-b"],
        "pattern": ["provider/model-a"],
        "weft":    ["provider/model-c", "provider/model-a"]
      }
    },
    "quality":  { "description": "...", "agents": { } },
    "economy":  { "description": "...", "agents": { } }
  },
  "notesUrl": "https://github.com/weaveio/weave/releases/tag/models-2026-09-05"
}
```

Model identifiers in the manifest are abstract (e.g. `provider/model-a`). Adapters map them to concrete harness-specific model names, exactly as they do for user-declared models today.

### User-facing surface

The CLI (and adapter UIs where appropriate) exposes:

- `weave models check` — fetch latest manifest, compare against effective local config, report available profiles and pending changes.
- `weave models recommendations` — show the raw manifest and per-agent diffs against the local effective config.
- `weave models apply <profile> [--global | --project]` — write the selected profile's preferences into the chosen config scope, with an interactive preview and confirmation step. Records the applied `revision` in the config.

Applied recommendations are written as ordinary DSL config, so the resulting state is fully inspectable, diffable in git, and independent of the manifest server after application.

### Ownership boundaries

| Concern                                   | Owner                       |
| ----------------------------------------- | --------------------------- |
| Manifest schema and validated types       | `@weaveio/weave-core`       |
| Diff computation vs. effective config     | `@weaveio/weave-config`     |
| Availability filtering                    | Adapter (supplies context)  |
| Fetch, cache, TTL, offline fallback       | CLI / adapter               |
| Consent flow, preview, config writing     | CLI                         |
| Runtime model resolution                  | Engine (unchanged, pure)    |

The engine gains no new remote responsibilities. The manifest is consumed at edit time, not at run time.

### Phased rollout

1. **Phase 1 — Advisory catalog.** Static per-agent model preferences per profile (`quality`, `balanced`, `economy`). CLI-driven preview and apply.
2. **Phase 2 — Capability metadata.** Manifest describes models via capability vectors (reasoning, coding, review, tool-use, cost tier, latency tier). Weave selects models by matching agent role to capabilities against adapter availability, reducing the need to hardcode every future model into every built-in agent.
3. **Phase 3 — Orchestration policies.** Opt-in execution strategies (`single`, `cascade`, `draft-critique-revise`) expressed as first-class DSL constructs, informed by HydraFusion's operating principles: bounded execution per leg, isolated (read-only) critic contexts, complete cost accounting across every leg, and validated routing before execution.

Each phase is independently shippable and independently opt-in.

### Security and integrity

- Fetch only from a fixed HTTPS origin controlled by the Weave project. The origin is compiled into the CLI, not configurable via `.weave` DSL, to prevent third-party manifests from becoming a supply-chain vector.
- Validate the manifest against a strict Zod schema before use. Unknown fields are ignored; invalid structure is rejected without applying anything.
- Manifest content is treated as data, never executed. It cannot introduce prompts, tools, hooks, or workflows — only model identifiers within a fixed schema.
- Optional future work: signed manifests (e.g. Sigstore) and revision pinning by immutable commit SHA. Not part of Phase 1.
- Cache the manifest locally with a conservative TTL; degrade cleanly to the cached copy (or to no recommendations) when offline. Never block agent execution on manifest fetches.

---

## Consequences

**Positive**

- Weave can communicate up-to-date model guidance to users between releases without shipping new packages.
- Users retain full control: no remote document changes runtime behavior without an explicit local action.
- The engine remains deterministic and offline-capable. Runtime model resolution is unchanged.
- Applied recommendations are ordinary DSL config, so they are diffable, reviewable in PRs, and easy to revert.
- The phased design leaves room for HydraFusion-style orchestration without committing to it prematurely.

**Negative / Trade-offs**

- Weave now maintains a public manifest as an ongoing artifact. Stale, incorrect, or missing manifests become a user-visible failure mode; the manifest becomes an SLA-relevant surface.
- Users who never run `weave models check` will not benefit from recommendations. The feature's value depends on discoverability in the CLI and adapter UIs.
- Introduces a new CLI surface (`weave models …`) and a new config-writing code path, both of which need thorough testing to avoid corrupting existing user config.
- Capability metadata (Phase 2) requires a defensible scoring methodology. Vendor-reported benchmark deltas — as HydraFusion itself illustrates — are not always reproducible; Weave must be transparent about the provenance of any capability scores it publishes.
- Orchestration policies (Phase 3) will require substantial DSL and engine work and will interact with workflows, tool policies, and cost accounting. This ADR does not commit to that work; it only reserves conceptual space for it.

**Explicitly out of scope**

- Any runtime path that fetches the manifest during model resolution or agent execution.
- Any mechanism that lets the manifest override an explicit user model declaration.
- Third-party or user-configurable manifest origins.
- Automatic upgrades between manifest revisions without user confirmation.
