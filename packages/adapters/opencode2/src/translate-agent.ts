/**
 * Pure descriptor → V2 `Agent.Info` translation.
 *
 * Implements Spec 34 §3 (`docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`).
 * `translateAgent()` takes a Weave `AgentDescriptor` (`@weaveio/weave-engine`,
 * `packages/engine/src/compose.ts`) plus an already-resolved model, and
 * produces a V2 `Agent.Info`-shaped object. Model catalog resolution
 * (matching a resolved model string against `ctx.catalog.model.list()`) is
 * owned by task C8 and happens upstream of this function — this module only
 * structures the already-resolved `{ providerID, modelID, variant? }` triple
 * into V2's `model` field.
 *
 * **`request` is deliberately left unset.** Per `.weave/learnings/opencode2-adapter.md`
 * and Phase A findings, `agent.request` is ignored by the V2 runtime — Weave
 * does not populate it to avoid implying it has an effect.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — the ownership marker and field mapping here are defined
 * independently for the V2 package. See Spec 34 and the module header in
 * `./sdk-types.ts` for the sealed-SDK-boundary rule this module respects
 * (it imports only `./sdk-types` and `./tool-policy-mapping`, never
 * `@opencode-ai/*` directly).
 */

import type { V2AgentInfo } from "./sdk-types.js";
import {
  type ToolPolicyEffective,
  toPermissionRules,
} from "./tool-policy-mapping.js";

/**
 * Ownership marker prepended to every Weave-managed V2 agent's `description`
 * field. Defined locally to this package only — do NOT import an
 * equivalent constant from `packages/adapters/opencode/`. The V1 and V2
 * adapters are independent, parallel implementations (Spec 34) and must not
 * share this marker's value or source.
 */
export const WEAVE_OWNERSHIP_MARKER = "[weave-managed]";

/**
 * Minimal shape this module depends on from `@weaveio/weave-engine`'s
 * `AgentDescriptor` (`packages/engine/src/compose.ts`). Declared as a local
 * structural type (rather than importing the engine package at the type
 * level in the function signature) so this module's contract is explicit
 * and reviewable; callers passing a real `AgentDescriptor` satisfy this
 * structurally.
 */
export interface TranslatableAgentDescriptor {
  name: string;
  description?: string;
  composedPrompt: string;
  mode: "primary" | "subagent" | "all";
  effectiveToolPolicy: ToolPolicyEffective;
  hidden?: boolean;
  color?: string;
  disabled?: boolean;
}

/** An already-resolved model triple, produced upstream (task C8's catalog match). */
export interface ResolvedAgentModel {
  providerID: string;
  modelID: string;
  variant?: string;
}

/**
 * V2 `Agent.Info.mode` only distinguishes `primary` / `subagent` / `all`
 * (matches Weave's own vocabulary 1:1) — no translation table needed beyond
 * a passthrough, but this helper keeps the mapping named and explicit in
 * case V2's vocabulary diverges in a future SDK version.
 */
function translateMode(
  mode: TranslatableAgentDescriptor["mode"],
): V2AgentInfo["mode"] {
  return mode;
}

/**
 * Prepend the package-local ownership marker to a descriptor's description.
 * When no description is present, the marker alone becomes the description.
 */
function translateDescription(description: string | undefined): string {
  if (description === undefined || description.length === 0) {
    return WEAVE_OWNERSHIP_MARKER;
  }
  return `${WEAVE_OWNERSHIP_MARKER} ${description}`;
}

/**
 * Translate a composed Weave `AgentDescriptor` plus a resolved model into a
 * V2 `Agent.Info`-shaped object.
 *
 * Pure function — no I/O, no SDK calls, deterministic for identical input.
 * `id`/`name` are both set to `descriptor.name`; `Agent.ID` is a branded
 * string type in the V2 schema, so the value is cast via `as unknown as`.
 */
export function translateAgent(
  descriptor: TranslatableAgentDescriptor,
  resolvedModel: ResolvedAgentModel,
): V2AgentInfo {
  const model: V2AgentInfo["model"] = {
    providerID: resolvedModel.providerID,
    id: resolvedModel.modelID,
    ...(resolvedModel.variant !== undefined
      ? { variant: resolvedModel.variant }
      : {}),
  } as unknown as V2AgentInfo["model"];

  const info: V2AgentInfo = {
    id: descriptor.name as unknown as V2AgentInfo["id"],
    name: descriptor.name,
    description: translateDescription(descriptor.description),
    system: descriptor.composedPrompt,
    model,
    permissions: toPermissionRules(descriptor.effectiveToolPolicy),
    mode: translateMode(descriptor.mode),
  } as unknown as V2AgentInfo;

  if (descriptor.hidden !== undefined) {
    (info as Record<string, unknown>).hidden = descriptor.hidden;
  }
  if (descriptor.color !== undefined) {
    (info as Record<string, unknown>).color = descriptor.color;
  }
  if (descriptor.disabled !== undefined) {
    (info as Record<string, unknown>).disabled = descriptor.disabled;
  }

  return info;
}
