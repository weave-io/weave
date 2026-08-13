# Fast intent and trigger simplification learnings

## Task 3 review remediation

- Gate findings: bare trigger identifiers and bare `fast` crossed the generic parser boundary; AST conversion used prototype-bearing records and overwrote duplicates; Zod diagnostics exposed attacker-controlled key text without global bounds.
- Resolution: preserve bare-flag provenance in the AST, then fail closed for agent/category `fast` unless the source says `fast true`; require trigger AST elements to be quoted strings; reject dangerous names and duplicate declarations/properties before conversion, including nested blocks, workflows, and steps.
- Conversion now uses null-prototype records with explicit own-property definitions. Validation diagnostics cap issues, path length, message length, and aggregate size, with a deterministic truncation marker.
- Intentional bare flags remain valid in their scoped grammar, including `extension_points { before-plan }`.

## Task 3 repeat-audit remediation

- Generated and normalized destinations are also ownership boundaries. Source properties must not target a field already supplied by declaration syntax or normalization. A reusable pre-conversion check now rejects workflow `steps`, step `name` plus `display_name`, and completion-block `method` when the named completion already generates it. This prevents silent overwrite before schema validation.
- Diagnostic bounds apply to the complete `ConfigError` union, not only Zod issues. One shared policy caps issue count, every source-controlled string field, and aggregate diagnostic size for direct lexer, parser, validator, and end-to-end parse boundaries. It uses deterministic truncation and a stable marker. A duplicate 20,000-character key now returns bounded, repeatable diagnostics.
- Exported agent, category, and root schemas now inspect the complete input graph through descriptors before Zod reads values. They accept ordinary own writable data properties on plain and null-prototype records. They reject inherited input, accessors, unexpected prototypes, symbols, and unsafe descriptors. Getter rejection occurs without getter execution.

## Task 3 final direct-export remediation

- Descriptor inspection alone was insufficient because the schema preprocessor returned the original plain object. Zod could still find an enumerable field on `Object.prototype`; an inherited category `description` getter executed once and entered validation. The schema boundary now passes a descriptor-copied graph to Zod. Objects use null prototypes, arrays are rebuilt from validated own index and length descriptors, and source values are obtained only from data descriptors.
- Direct crafted workflow and step ASTs could supply generic properties that conversion later overwrote with dedicated AST fields. Destination ownership now also reserves workflow `extends` and step `insert_before` plus `insert_after`, in addition to the prior workflow `steps`, step `name`/`display_name`, and completion `method` checks.
- Exported `validate()` previously traversed caller-owned AST objects before descriptor checks. Inherited `key` fields and accessor-backed `value` fields could enter conversion and execute getters. Schema and AST boundaries now share one descriptor-safe graph copier. `validate()` copies the complete AST before any AST property access and rejects inherited fields, accessors, symbols, unsafe descriptors, cycles, sparse or extended arrays, and unexpected prototypes as bounded `ValidationError` results. Valid parser ASTs and safe plain or null-prototype direct ASTs remain accepted.

## Task 3 callable-node remediation

- The safe graph copier treated every non-object `typeof` result as a primitive. Because JavaScript reports callables as `"function"`, a callable AST node with an own `type` getter bypassed the descriptor checks and reached exported `validate()`, where the getter ran repeatedly.
- `copyGraph()` now rejects callable values before its primitive return path. Direct `validate()` and exported-schema regressions prove that callable graph nodes fail without executing their getters, while the existing suite continues to cover valid primitive values and prior graph protections.

## Task 4 conversion boundary

- Legacy JSONC conversion must copy the parsed graph through own enumerable writable data descriptors before any field read. jsonc-parser output is untrusted even though it usually creates plain objects.
- Trigger conversion selects nonblank `routing_hint`, else nonblank `trigger`, preserves source order, and drops only exact duplicate strings. Every discarded structured field and every malformed or empty entry gets a warning.
- Valid category patterns are dropped with a warning; malformed patterns also warn. A category with a nonblank description still converts. Generated DSL must not emit `patterns`, trigger objects, or inferred `fast`.
- Task 5 owns engine descriptor, category-shuttle inheritance, and normalized pattern removal. This slice does not change engine production files.

## Task 4 review remediation

- Gate findings: `key in` on a prototype-bearing lookup table treated `toString`/`constructor` as members and threw on own `__proto__`; unvalidated custom names and scalars could emit invalid DSL; `jsonc-parser.parse()` collapsed duplicate keys; warnings interpolated discarded values, paths, names, and modes.
- Resolution: inspect the JSONC CST before parse for duplicate and dangerous keys, bound raw source length, and copy through the existing descriptor-safe graph. Lookup tables are Maps/Sets with own-property checks. Custom agent/category names must match the current identifier contract; temperatures must be finite and in `0..2`; models must pass current model-intent parsing. Generated blocks and the final document are validated with `parseConfig()` and omitted when invalid.
- Warnings report a bounded path (vocabulary keys, indices, or `<entry>`), a fixed reason, and a primitive type category. They never interpolate discarded values, prompt paths, invalid names, modes, or malformed scalars. Warning count, path/reason length, and aggregate bytes stay capped with a deterministic truncation marker.

## Task 5 descriptor boundary

- Engine descriptors now carry only `fast?: true` and `DelegationTarget.triggers: string[]`. Category metadata no longer has `patterns`. `generateCategoryShuttles()` copies category triggers, never base Shuttle triggers, and sets `fast true` when the category or the base Shuttle declares it. There is no `false` value.
- Descriptor outputs must copy trigger, model, and skill arrays. Sharing `targetConfig.triggers` or `category.triggers` leaks caller mutation into the normalized shape.
- Changing `DelegationTarget.triggers` to `string[]` immediately breaks later-task consumers that still validate object triggers, including the Pi bootstrap schema (Task 8) and template trigger projection (Task 6). This slice keeps a compile-only template-context bridge and does not migrate those owners.

## Task 6 prompt and capability boundary

- Template context now copies `DelegationTarget.triggers` as ordered `string[]`. Domains, trigger objects, and `CategoryInput.patterns` are gone. Loom renders exact strings with `{{.}}` and routes category shuttles by description plus listed triggers only.
- The optional capability ID is `provider-fast-activation`. Bounded `runtimeStatus` values reuse existing readiness: no `fast true` emits no state; `declared`/`requested`/`not-confirmed` stay at or below `degraded`; `applied` may only accompany `native`; `unsupported` cannot be raised. Static declarations are ceilings.
- Task 1 ceilings: Pi and OpenCode are `degraded`/`not-confirmed` (request-capable, not applied/native). Claude Code static materialization is `unsupported`. Optional gaps do not enter health-only mode.
- Immediate leftover type consumers needed count updates (`ALL_CAPABILITY_IDS.length` is 22) and leftover `patterns` fixture deletions. Root typecheck still fails in `packages/adapters/pi/src/extension.ts` `parseChildBootstrapBody` because Task 8 still owns converting authenticated child bootstrap triggers from objects to `string[]`.
- Exported `CapabilityEntrySchema` must discriminate `provider-fast-activation` and reuse `ProviderFastActivationStatusSchema` for present `runtimeStatus`. A standalone status enum is not an enforcement boundary; `applied-with-secret-payload` parsed until the exported contract reused that enum.

## Task 7 primary activation boundary

- Pi primary activation now copies `fast?: true` onto `PiActivePrimary` with identity, prompt, model, and skills. Omission means no intent. Never store `false`, and never infer from model or provider IDs.
- Request snapshots are instance-owned and frozen. They carry activation `generation`, primary name, copied model intent, selected model when available, and `fast?: true`. A later successful `activate()` increments generation, so a stale snapshot cannot describe the later primary.
- `projectPiProviderEvent` copies only hook name and integer response status. Payload, headers, and response bodies stay behind this projection. Task 9 owns mutation and evidence.
- Failed `activate()` still returns typed `NotEligiblePrimary` and leaves `getCurrent()` unchanged. Health-only, unsupported, and failed boot paths have no snapshot. Task 8 still owns authenticated child bootstrap trigger conversion; that remains the known Pi typecheck failure.
- Provider events now fail closed from own safe data descriptors without executing accessors.

## Task 7 snapshot authentication remediation

- Pi request snapshot resolution now authenticates exact generation, primary identity, fast presence/value, ordered model intent, and selected model. Forged, omitted, extra, reordered, or mutated model fields return the typed stale result; capture and resolve return normalized copies.
- Committed active-primary state uses bounded descriptor-safe copy-on-commit and copy-on-read; hostile skill metadata accessors and cycles are omitted without execution, so source mutation and reads cannot alter the prompt, snapshot, or state.

## Task 8 child bootstrap fast and trigger boundary

- Pi ordinary and direct-step bootstraps carry optional literal `fast: true` and ordered `DelegationTarget.triggers: string[]`; direct dispatch forwards the selected descriptor intent, copies nested model/target data, and omits absent fast to preserve provider defaults.
- `parseControlBody` copies hostile graphs through a descriptor-only bounded copier before canonicalization and Zod: depth 64, 4,096 nodes, 4,096 aggregate properties, 512 properties per object, 256 KiB string budget, and 512-element arrays. It rejects cycles, accessors, symbols, callables, unsafe prototypes, and sparse arrays without executing getters; bootstrap canonical bytes remain capped at 64 KiB.
- Child fast and delegation state commits only after required bootstrap application and before acknowledgement. Signed body construction omits undefined optional keys.

## Task 9 slice D sanitized telemetry and status

- The `provider-fast` journal family accepts only the public tracker snapshot: provider family, API family, rule ID, bounded sequence/pending count, collision, state, evidence kind/outcome, and a fixed reason. Extra keys, raw model/provider strings, payloads, headers, credentials, prompts, URLs, paths, and stacks are rejected at the projection boundary.
- Lifecycle events persist once per sequence/state (`declared`, `requested`, `not-confirmed`, `unsupported`). No-intent never writes. Session replacement clears in-memory reporting dedupe only. Telemetry write failure degrades through the existing journal path and does not change request mutation.
- `/weave:status` may add one concise line: `fast: requested`, `fast: not-confirmed`, `fast: unsupported (<fixed reason>)`, or `fast: declared`. It never says applied/active/confirmed. HTTP 2xx remains not-confirmed.

## Task 9 slice E abandoned-attempt settlement

- `requested` is transient attempt state, so an attempt that never receives `after_provider_response` must not keep reporting it. Expiring a `requested` attempt now terminates it as `not-confirmed` with `none`/`none` evidence and the fixed expire reason; expiring a `declared` attempt stays `declared`. Both keep the sequence and free the tracker slot, so a late or forged token cannot revive them.
- `ProviderFastCoordinator.cancelActive(reason)` is the only cancellation seam. It reports `no-state` when nothing is active, keeps the settled snapshot in `latest()`, and fails closed on a malformed reason.
- Pi's `agent_settled` is the abandonment signal for a cancelled or aborted turn. Session replacement, primary switch, and hook-detected generation/primary mismatch now settle with `session-replaced`, `primary-switched`, or `generation-superseded` instead of a silent reset, so the journal keeps one terminal record per sequence.
- The `sequence:state` journal dedupe key already separates a cancelled `requested` attempt from its earlier `requested` event. A cancelled `declared` attempt intentionally records nothing new.
