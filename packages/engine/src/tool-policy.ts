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
