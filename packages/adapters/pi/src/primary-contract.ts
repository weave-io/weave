/**
 * Active-primary contract guard for the Pi adapter's config refresh.
 *
 * A refreshed catalog may only be published mid-generation while it leaves the
 * active primary's harness-visible contract exactly as committed. This module
 * answers that one question — and nothing else. It publishes nothing, reads
 * nothing, and holds no state: given the committed primary descriptor and an
 * unpublished candidate, it returns either `publishable` or
 * `primary-affecting` with the closed set of facets that differ.
 *
 * ## What "contract" means here
 *
 * Everything the harness has already been told about the primary, or would
 * resolve for it without a new activation:
 *
 * - **existence and eligibility** — the descriptor is still present, not
 *   disabled, and still eligible as a primary (`mode` other than `subagent`);
 * - **rendered prompt** — the exact block {@link PiPrimarySession} appends to
 *   Pi's system prompt, skills line included, rendered with the *candidate's*
 *   `disabled.skills`;
 * - **model intent order**, **thinking level**, **temperature**, and
 *   **`fast`** — everything activation applies to the host;
 * - **effective tool policy** — the five abstract capabilities;
 * - **delegation targets** — the runtime authority `weave_delegate` serves.
 *
 * ## Rendered output, not source
 *
 * The prompt facet compares rendered text. A config rewrite that moves a
 * prompt from an inline single-line string to a multiline `"""` block, or from
 * inline to `prompt_file`, is not primary-affecting when the rendered block is
 * byte-identical. Only what the harness would see counts.
 *
 * ## Delegation-target normalization
 *
 * Runtime delegation authority is a name lookup over the active descriptor's
 * `delegationTargets` (`resolveDelegationInvocationContext` hands those targets
 * to the tool, which resolves a request by exact name), and the model learns a
 * target from its name and description in the composed prompt. Comparison
 * therefore normalizes to name + description, sorted by name: reordering the
 * same targets does not change what may be delegated to, while adding,
 * removing, or re-describing one does.
 *
 * ## Diagnostics safety
 *
 * The result carries facet literals only — never prompt text, a path, an agent
 * name, or any config content — so it is safe to log, render in
 * `/weave:status`, or hand to a UI notification verbatim.
 *
 * Pure and synchronous: no I/O, no clock, no async. Every input is supplied by
 * the caller.
 */

import type { AgentDescriptor, ThinkingLevelDecl } from "@weaveio/weave-engine";
import { parseModelIntentEntry } from "@weaveio/weave-engine";
import { Result } from "neverthrow";
import type { PiConfigActivationResult } from "./config-activator.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiSkillResolutionPort,
  renderWeavePromptBlock,
  resolveDescriptorSkillResolution,
} from "./primary-session.js";

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/**
 * The closed set of contract facets, in the order they are reported.
 *
 * Eligibility facets come first because they are terminal: a candidate whose
 * primary is gone, disabled, or demoted can never be activated, so comparing
 * its remaining facets would describe a descriptor that cannot serve.
 */
export const PI_PRIMARY_CONTRACT_FACETS = [
  /** No descriptor under the primary's name in the candidate catalog. */
  "primary-missing",
  /** The candidate's `disabled.agents` lists the primary. */
  "primary-disabled",
  /** The candidate's descriptor is `mode: "subagent"` and cannot be primary. */
  "primary-demoted",
  /** The rendered Weave prompt block differs, skills line included. */
  "prompt",
  /** The ordered model intent differs, ignoring thinking-level suffixes. */
  "models",
  /** A model intent entry's thinking level differs. */
  "thinking",
  /** The declared temperature differs. */
  "temperature",
  /** The neutral provider-acceleration intent differs. */
  "fast",
  /** One of the five effective tool-policy capabilities differs. */
  "tool-policy",
  /** The normalized delegation-target set differs. */
  "delegation-targets",
] as const;

/** One reason a candidate would change the active primary's contract. */
export type PiPrimaryContractFacet =
  (typeof PI_PRIMARY_CONTRACT_FACETS)[number];

// ---------------------------------------------------------------------------
// Input and decision
// ---------------------------------------------------------------------------

/**
 * The unpublished candidate, reduced to what the guard reads.
 *
 * Build it from a candidate activation with
 * {@link toPiPrimaryContractCandidate}; the explicit shape keeps this module
 * independent of how the candidate was produced.
 */
export interface PiPrimaryContractCandidate {
  /** Successfully composed candidate descriptors, indexed by stable name. */
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  /** The candidate's `disabled.agents`. */
  readonly disabledAgents: readonly string[];
  /** The candidate's `disabled.skills`, used to render the candidate prompt. */
  readonly disabledSkills: readonly string[];
}

export interface PiPrimaryContractInput {
  /**
   * The committed primary descriptor — `primarySession.getCurrent()?.descriptor`.
   *
   * `undefined` means no primary has been committed in this generation. There
   * is then no harness-visible contract to preserve, so only the default
   * primary's existence and eligibility are checked.
   */
  readonly primary: AgentDescriptor | undefined;
  /** The `disabled.skills` the committed primary was rendered with. */
  readonly disabledSkills: readonly string[];
  readonly candidate: PiPrimaryContractCandidate;
  /**
   * The rendering path: Pi's current skill-discovery snapshot, resolved
   * exactly as `PiPrimarySession.prepareComposedPrompt` resolves it.
   */
  readonly skills: PiSkillResolutionPort;
}

/**
 * Whether the candidate may be published without touching the active primary.
 *
 * `changedFacets` is non-empty, deduplicated, and ordered by
 * {@link PI_PRIMARY_CONTRACT_FACETS}.
 */
export type PiPrimaryContractDecision =
  | { readonly decision: "publishable" }
  | {
      readonly decision: "primary-affecting";
      readonly changedFacets: readonly PiPrimaryContractFacet[];
    };

const PUBLISHABLE: PiPrimaryContractDecision = Object.freeze({
  decision: "publishable",
});

function primaryAffecting(
  changedFacets: readonly PiPrimaryContractFacet[],
): PiPrimaryContractDecision {
  return Object.freeze({
    decision: "primary-affecting",
    changedFacets: Object.freeze([...changedFacets]),
  });
}

/**
 * Reduces a candidate activation to the guard's input.
 *
 * `disabled` is read defensively: a config value that predates the schema
 * default is treated as "nothing disabled" rather than crashing the guard.
 */
export function toPiPrimaryContractCandidate(
  activation: PiConfigActivationResult,
): PiPrimaryContractCandidate {
  return {
    descriptors: activation.descriptors.byName,
    disabledAgents: activation.config.disabled?.agents ?? [],
    disabledSkills: activation.config.disabled?.skills ?? [],
  };
}

// ---------------------------------------------------------------------------
// Facet comparisons
// ---------------------------------------------------------------------------

/**
 * Renders the exact block the harness would receive for this descriptor.
 *
 * Same catalog resolution and same renderer as activation
 * (`PiPrimarySession.prepareComposedPrompt` → `renderWeavePromptBlock`), so
 * equality here means the harness would see identical bytes. A hostile or
 * broken skill port that throws yields `err`, which the caller treats as
 * "cannot prove the prompt is unchanged".
 */
const renderPromptBlockSafely = Result.fromThrowable(
  (
    skills: PiSkillResolutionPort,
    descriptor: AgentDescriptor,
    disabledSkills: readonly string[],
  ): string =>
    renderWeavePromptBlock(
      descriptor,
      resolveDescriptorSkillResolution(skills, descriptor, disabledSkills)
        .resolvedSkills,
    ),
  () => undefined,
);

function promptChanged(
  input: PiPrimaryContractInput,
  primary: AgentDescriptor,
  next: AgentDescriptor,
): boolean {
  const current = renderPromptBlockSafely(
    input.skills,
    primary,
    input.disabledSkills,
  );
  const candidate = renderPromptBlockSafely(
    input.skills,
    next,
    input.candidate.disabledSkills,
  );
  // Fail closed: an unrenderable side is never proof of an unchanged prompt.
  if (current.isErr() || candidate.isErr()) return true;
  return current.value !== candidate.value;
}

interface PiModelIntent {
  readonly baseModel: string;
  readonly thinkingLevel: ThinkingLevelDecl | undefined;
}

/**
 * Splits one model intent entry into base model and thinking level.
 *
 * An entry whose suffix is not a valid thinking level is the base model in
 * full — the same reading `PiModelResolver.resolve` applies when it matches
 * against Pi's catalog.
 */
function splitModelIntent(entry: string): PiModelIntent {
  const parsed = parseModelIntentEntry(entry);
  if (parsed.isErr()) return { baseModel: entry, thinkingLevel: undefined };
  return {
    baseModel: parsed.value.baseModel,
    thinkingLevel: parsed.value.thinkingLevel,
  };
}

function sequenceChanged<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (leftItem: T, rightItem: T) => boolean,
): boolean {
  if (left.length !== right.length) return true;
  return left.some((leftItem, index) => {
    const rightItem = right[index];
    return rightItem === undefined || !equal(leftItem, rightItem);
  });
}

const TOOL_POLICY_CAPABILITIES = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
] as const;

function toolPolicyChanged(
  current: AgentDescriptor["effectiveToolPolicy"],
  candidate: AgentDescriptor["effectiveToolPolicy"],
): boolean {
  return TOOL_POLICY_CAPABILITIES.some(
    (capability) => current[capability] !== candidate[capability],
  );
}

/** One delegation target reduced to what runtime authority and the model use. */
interface NormalizedDelegationTarget {
  readonly name: string;
  readonly description: string | undefined;
}

/**
 * Normalizes delegation targets to a name-sorted list of name + description.
 *
 * Order carries no authority — the tool resolves a request by exact name — so
 * sorting makes an ordering-only difference invisible while keeping every
 * added, removed, or re-described target visible. Same-name duplicates are
 * ordered by description so the comparison stays deterministic.
 */
function normalizeDelegationTargets(
  targets: AgentDescriptor["delegationTargets"],
): readonly NormalizedDelegationTarget[] {
  return targets
    .map((target) => ({ name: target.name, description: target.description }))
    .sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      const leftDescription = left.description ?? "";
      const rightDescription = right.description ?? "";
      if (leftDescription === rightDescription) return 0;
      return leftDescription < rightDescription ? -1 : 1;
    });
}

function delegationTargetsChanged(
  current: AgentDescriptor["delegationTargets"],
  candidate: AgentDescriptor["delegationTargets"],
): boolean {
  return sequenceChanged(
    normalizeDelegationTargets(current),
    normalizeDelegationTargets(candidate),
    (left, right) =>
      left.name === right.name && left.description === right.description,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decides whether an unpublished candidate preserves the active primary's
 * harness-visible contract.
 *
 * Eligibility is checked first and short-circuits: `primary-missing`,
 * `primary-disabled`, and `primary-demoted` are each reported alone, because a
 * candidate primary that cannot be activated has no further contract to
 * compare. Otherwise every facet is compared and all differences are reported
 * together.
 *
 * With no committed primary the subject is {@link DEFAULT_PRIMARY_AGENT_NAME}
 * and only its existence and eligibility are checked — nothing has been shown
 * to the harness yet, so no other facet can regress.
 *
 * Total, pure, and synchronous: it never throws, never performs I/O, and
 * returns the same decision for the same inputs.
 */
export function decidePiPrimaryContract(
  input: PiPrimaryContractInput,
): PiPrimaryContractDecision {
  const primary = input.primary;
  const primaryName = primary?.name ?? DEFAULT_PRIMARY_AGENT_NAME;

  if (input.candidate.disabledAgents.includes(primaryName)) {
    return primaryAffecting(["primary-disabled"]);
  }

  const next = input.candidate.descriptors.get(primaryName);
  if (next === undefined) return primaryAffecting(["primary-missing"]);
  if (next.mode === "subagent") return primaryAffecting(["primary-demoted"]);

  if (primary === undefined) return PUBLISHABLE;

  const currentIntent = primary.models.map(splitModelIntent);
  const candidateIntent = next.models.map(splitModelIntent);
  const changedFacets: PiPrimaryContractFacet[] = [];

  if (promptChanged(input, primary, next)) changedFacets.push("prompt");
  if (
    sequenceChanged(
      currentIntent,
      candidateIntent,
      (left, right) => left.baseModel === right.baseModel,
    )
  ) {
    changedFacets.push("models");
  }
  if (
    sequenceChanged(
      currentIntent,
      candidateIntent,
      (left, right) => left.thinkingLevel === right.thinkingLevel,
    )
  ) {
    changedFacets.push("thinking");
  }
  if (!Object.is(primary.temperature, next.temperature)) {
    changedFacets.push("temperature");
  }
  if ((primary.fast === true) !== (next.fast === true)) {
    changedFacets.push("fast");
  }
  if (
    toolPolicyChanged(primary.effectiveToolPolicy, next.effectiveToolPolicy)
  ) {
    changedFacets.push("tool-policy");
  }
  if (
    delegationTargetsChanged(primary.delegationTargets, next.delegationTargets)
  ) {
    changedFacets.push("delegation-targets");
  }

  return changedFacets.length === 0
    ? PUBLISHABLE
    : primaryAffecting(changedFacets);
}
