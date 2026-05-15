/**
 * Abstract tool-policy vocabulary for the Weave engine.
 *
 * This module defines the engine-level effective policy model. It imports
 * `ToolPermission` and `ToolPolicy` from `@weave/core` and does NOT redefine
 * the `allow` / `deny` / `ask` literals — those are owned by core.
 *
 * No harness-specific tool names appear here. Adapters are responsible for
 * mapping abstract capabilities to concrete harness tool names.
 */

import type { ToolPermission, ToolPolicy } from "@weave/core";

// ---------------------------------------------------------------------------
// Abstract capability list
// ---------------------------------------------------------------------------

/**
 * The ordered set of abstract capabilities recognised by the Weave engine.
 *
 * This list is the single source of truth for which capabilities exist.
 * Adapters iterate this list to materialise concrete tool permissions.
 *
 * Only an approved spec change may add or remove entries.
 */
export const ABSTRACT_CAPABILITIES: (keyof ToolPolicy)[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
];

// ---------------------------------------------------------------------------
// Effective policy model
// ---------------------------------------------------------------------------

/**
 * A fully-resolved tool policy where every abstract capability has an
 * explicit `ToolPermission` value.
 *
 * Unlike `ToolPolicy` (from `@weave/core`), which allows optional fields to
 * represent "not declared", `EffectiveToolPolicy` requires all five
 * capabilities. Adapters compute this by merging declared policy with
 * `DEFAULT_PERMISSION` for any missing capability.
 */
export type EffectiveToolPolicy = {
  [K in keyof Required<ToolPolicy>]: ToolPermission;
};

// ---------------------------------------------------------------------------
// Default permission
// ---------------------------------------------------------------------------

/**
 * The fallback permission applied to any capability not explicitly declared
 * in an agent or category `tool_policy` block.
 *
 * Value: `"ask"` — requires explicit user approval before the harness grants
 * the capability. This is the safest default and must not be changed without
 * an approved spec update (see `docs/specs/08-spec-abstract-tool-policy-evaluation/`).
 */
export const DEFAULT_PERMISSION: ToolPermission = "ask";

// ---------------------------------------------------------------------------
// Effective policy evaluation
// ---------------------------------------------------------------------------

/**
 * Resolves a raw (possibly partial or undefined) `ToolPolicy` into a fully
 * populated `EffectiveToolPolicy`.
 *
 * Rules:
 * - If `policy` is `undefined`, every capability defaults to `DEFAULT_PERMISSION`.
 * - For each capability, the configured value is preserved when present;
 *   otherwise `DEFAULT_PERMISSION` is applied.
 *
 * This function is **pure and deterministic** — it has no side effects, no
 * I/O, no adapter calls, and no harness-specific knowledge. It never throws.
 *
 * @param policy - The raw tool policy from a `.weave` agent or category block,
 *   or `undefined` when no `tool_policy` block was declared.
 * @returns A complete `EffectiveToolPolicy` with all five capabilities set.
 */
export function evaluateEffectiveToolPolicy(
  policy: ToolPolicy | undefined,
): EffectiveToolPolicy {
  return {
    read: policy?.read ?? DEFAULT_PERMISSION,
    write: policy?.write ?? DEFAULT_PERMISSION,
    execute: policy?.execute ?? DEFAULT_PERMISSION,
    delegate: policy?.delegate ?? DEFAULT_PERMISSION,
    network: policy?.network ?? DEFAULT_PERMISSION,
  };
}

// ---------------------------------------------------------------------------
// Adapter-facing concrete tool classification contract
// ---------------------------------------------------------------------------
//
// This section defines the input shape adapters use to supply concrete tool
// identifiers and their abstract capability classification, plus the per-tool
// decision union the engine returns after combining those classifications with
// an EffectiveToolPolicy.
//
// Alignment: this contract maps directly to the `tool-policy-mapping`
// capability defined in Spec 07 (docs/specs/07-spec-adapter-capability-contract/).
// Adapters that declare `tool-policy-mapping` as `native` or `emulated` are
// expected to supply ConcreteToolClassification entries and consume ToolDecision
// results to enforce Weave policy using harness-specific mechanisms.
//
// Concrete tool identifiers are opaque strings owned by adapters. The engine
// never inspects, hard-codes, or branches on specific harness tool names.

/**
 * A single adapter-supplied classification entry that pairs a concrete tool
 * identifier (opaque string, harness-owned) with the abstract capability it
 * maps to.
 *
 * Adapters construct these entries during their initialisation phase and pass
 * them to `resolveToolDecisions` together with an `EffectiveToolPolicy`.
 *
 * @example
 * // Adapter-internal — concrete id is opaque to the engine
 * const entry: ConcreteToolClassification = {
 *   toolId: "synthetic.read-tool",
 *   capability: "read",
 * };
 */
export type ConcreteToolClassification = {
  /** Opaque concrete tool identifier supplied by the adapter. */
  readonly toolId: string;
  /** The abstract capability this tool maps to. */
  readonly capability: keyof ToolPolicy;
};

// ---------------------------------------------------------------------------
// Per-tool decision union
// ---------------------------------------------------------------------------

/**
 * A mapped tool decision: the concrete tool was classified against a known
 * abstract capability and the effective policy for that capability has been
 * resolved.
 *
 * Adapters should use `permission` to enforce the Weave intent using
 * harness-specific mechanisms (e.g. allow-list, deny-list, prompt-for-approval).
 */
export type MappedToolDecision = {
  readonly kind: "mapped";
  /** The concrete tool identifier as supplied by the adapter. */
  readonly toolId: string;
  /** The abstract capability this tool was classified under. */
  readonly capability: keyof ToolPolicy;
  /** The effective permission resolved from the agent's EffectiveToolPolicy. */
  readonly permission: ToolPermission;
};

/**
 * An unmapped tool decision: the concrete tool identifier was not present in
 * the adapter-supplied classification list.
 *
 * This outcome is **explicit** — the engine never silently allows an
 * unclassified tool. Adapters must decide how to handle unmapped tools
 * (typically: deny or ask) using their own harness-specific logic.
 */
export type UnmappedToolDecision = {
  readonly kind: "unmapped";
  /** The concrete tool identifier that had no classification entry. */
  readonly toolId: string;
};

/**
 * A per-tool decision produced by `resolveToolDecisions`.
 *
 * The `kind` discriminant distinguishes classified tools (`"mapped"`) from
 * tools the adapter did not classify (`"unmapped"`). Adapters must handle
 * both variants — there is no implicit `allow` for unmapped tools.
 */
export type ToolDecision = MappedToolDecision | UnmappedToolDecision;

// ---------------------------------------------------------------------------
// Classification helper
// ---------------------------------------------------------------------------

/**
 * Combines adapter-supplied concrete tool classifications with an
 * `EffectiveToolPolicy` to produce a deterministic per-tool decision for
 * every tool identifier in `toolIds`.
 *
 * **Pure and deterministic** — no I/O, no harness names, no adapter calls.
 * Aligned with Spec 07 `tool-policy-mapping` capability
 * (see `docs/specs/07-spec-adapter-capability-contract/`).
 *
 * Rules:
 * - A tool id present in `classifications` → `MappedToolDecision` with the
 *   effective permission for its abstract capability.
 * - A tool id absent from `classifications` → `UnmappedToolDecision` (no
 *   permission value; adapters must not treat this as implicit `allow`).
 *
 * @param toolIds - The concrete tool identifiers to resolve decisions for.
 *   Supplied by the adapter; opaque strings to the engine.
 * @param classifications - Adapter-supplied mappings from concrete tool id to
 *   abstract capability. May be a subset of `toolIds`.
 * @param effectivePolicy - The fully-resolved effective tool policy for the
 *   agent being materialised.
 * @returns An array of `ToolDecision` entries in the same order as `toolIds`.
 */
export function resolveToolDecisions(
  toolIds: readonly string[],
  classifications: readonly ConcreteToolClassification[],
  effectivePolicy: EffectiveToolPolicy,
): ToolDecision[] {
  const classificationMap = new Map<string, keyof ToolPolicy>();
  for (const entry of classifications) {
    classificationMap.set(entry.toolId, entry.capability);
  }

  return toolIds.map((toolId): ToolDecision => {
    const capability = classificationMap.get(toolId);
    if (capability === undefined) {
      return { kind: "unmapped", toolId };
    }
    return {
      kind: "mapped",
      toolId,
      capability,
      permission: effectivePolicy[capability],
    };
  });
}
