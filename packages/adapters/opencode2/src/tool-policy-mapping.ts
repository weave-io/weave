/**
 * Abstract tool policy → V2 `permissions: Rule[]` mapping.
 *
 * Implements Spec 34 §4 (`docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`).
 * V2 represents an agent's permissions as an ordered array of `Rule` values,
 * evaluated last-match-wins (later entries override earlier ones for
 * overlapping scope) rather than a singular `permission` field or a `tools`
 * denial map. `toPermissionRules()` is a pure function producing
 * deterministic, byte-identical output for identical input.
 *
 * This module is implemented independently from any V1 tool-name mapping —
 * scope patterns below are derived only from the abstract capability
 * vocabulary and the V2 `Rule` shape (`{ action, resource, effect }`), not
 * copied from `packages/adapters/opencode/`.
 *
 * Ordering: rules are emitted in the fixed dimension order `read`, `write`,
 * `execute`, `delegate`, `network` so that last-match-wins semantics are
 * predictable when a caller later appends override rules.
 */

import type { V2Rule } from "./sdk-types.js";

/**
 * A fully-resolved tool policy where every abstract capability has an
 * explicit permission value. Mirrors the shape of
 * `EffectiveToolPolicy` from `@weaveio/weave-engine` (`packages/engine/src/tool-policy.ts`)
 * without introducing a runtime dependency on that package.
 */
export type ToolPolicyEffective = {
  read: "allow" | "deny" | "ask";
  write: "allow" | "deny" | "ask";
  execute: "allow" | "deny" | "ask";
  delegate: "allow" | "deny" | "ask";
  network: "allow" | "deny" | "ask";
};

/**
 * The fixed, documented dimension order in which rules are emitted.
 * Must match Spec 34 §4.3 exactly — do not reorder without a spec change.
 */
const DIMENSION_ORDER: readonly (keyof ToolPolicyEffective)[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
];

/**
 * Action scope pattern for each abstract capability dimension. These are
 * glob-style action identifiers scoped to the V2 tool/action categories
 * described in Spec 34 §4.3 — independently defined from any V1 tool-name
 * table.
 */
const DIMENSION_ACTION: Record<keyof ToolPolicyEffective, string> = {
  read: "read.*",
  write: "write.*",
  execute: "execute.*",
  delegate: "delegate.*",
  network: "network.*",
};

/**
 * Resource scope for each dimension. All dimensions currently scope to every
 * resource (`*`) — a single abstract capability maps to exactly one `Rule`
 * entry per Spec 34 §4.3.
 */
const DIMENSION_RESOURCE = "*";

/**
 * Maps an abstract `ToolPolicyEffective` to an ordered array of V2
 * `PermissionRule` (`V2Rule`) entries per Spec 34 §4.3.
 *
 * Pure function: deterministic, byte-identical output for identical input.
 * Emits exactly one rule per dimension, in the fixed order `read`, `write`,
 * `execute`, `delegate`, `network`.
 */
export function toPermissionRules(policy: ToolPolicyEffective): V2Rule[] {
  return DIMENSION_ORDER.map((dimension) => ({
    action: DIMENSION_ACTION[dimension],
    resource: DIMENSION_RESOURCE,
    effect: policy[dimension],
  }));
}
