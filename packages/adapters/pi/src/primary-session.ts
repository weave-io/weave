import type {
  AgentDescriptor,
  ResolvedSkill,
  SkillResolutionError,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  PiModelActivationOutcome,
  PiModelApplyPort,
  PiThinkingApplyPort,
} from "./model-resolution.js";
import { PiModelActivator } from "./model-resolution.js";
import type { PiSkillCatalog } from "./skill-catalog.js";
import type { PiAdapterLogger, PiModelInfo, PiSkillInfo } from "./types.js";

const WEAVE_BLOCK_START = "weave:agent:start";
const WEAVE_BLOCK_END = "weave:agent:end";

/**
 * Renders the single delimited Weave block required by the Pi adapter contract: the
 * active descriptor's stable identity plus its final `composedPrompt`,
 * verbatim. Descriptors' `composedPrompt` is already final (Pi adapter contract) —
 * this function never re-renders or re-templates it.
 */
export function renderWeavePromptBlock(descriptor: AgentDescriptor): string {
  return [
    `<!-- ${WEAVE_BLOCK_START} name="${descriptor.name}" -->`,
    descriptor.composedPrompt,
    `<!-- ${WEAVE_BLOCK_END} name="${descriptor.name}" -->`,
  ].join("\n");
}

function hasWeaveBlockFor(
  systemPrompt: string,
  descriptorName: string,
): boolean {
  return systemPrompt.includes(
    `<!-- ${WEAVE_BLOCK_START} name="${descriptorName}" -->`,
  );
}

/**
 * Appends the active descriptor's composed-prompt block to Pi's
 * already-chained system prompt exactly once (Pi adapter contract). Preserves
 * everything already in `systemPrompt` (Pi's own context, native
 * tool/skill guidance, other extensions' additions) and is idempotent: if
 * this exact descriptor's block is already present, the prompt is returned
 * unchanged rather than appended twice.
 */
export function appendWeaveBlockOnce(
  systemPrompt: string,
  descriptor: AgentDescriptor,
): string {
  if (hasWeaveBlockFor(systemPrompt, descriptor.name)) return systemPrompt;
  const block = renderWeavePromptBlock(descriptor);
  if (systemPrompt.length === 0) return block;
  return `${systemPrompt}\n\n${block}`;
}

export type PiPrimaryActivationError =
  | {
      readonly type: "NotEligiblePrimary";
      readonly agentName: string;
      readonly mode: string;
    }
  | {
      readonly type: "SkillResolutionFailed";
      readonly agentName: string;
      readonly errors: readonly SkillResolutionError[];
    }
  | { readonly type: "DescriptorNotFound"; readonly agentName: string }
  | { readonly type: "NoPriorPrimary" };

/**
 * A visible, deduplicated capability degradation surfaced by primary
 * activation (Pi adapter contract): a temperature that had to be ignored, or
 * a model that could not be resolved/applied. Callers (e.g. `/weave:health`,
 * capability probing) read this instead of relying on log lines alone.
 */
export interface PiPrimaryCapabilityWarning {
  readonly capability: "temperature" | "model";
  readonly agentName: string;
  readonly detail: string;
}

/**
 * The atomically-activated primary descriptor and every piece of state that
 * must change together with it (Pi adapter contract): descriptor identity, prompt
 * source, applied model, and resolved skills.
 *
 * Registered tools and recovery correlation are not tracked here.
 */
export type PiPrimaryModelActivationOutcome =
  | PiModelActivationOutcome
  | {
      readonly status: "preserved";
      readonly currentModel: PiModelInfo | undefined;
      readonly reason: "user-selected";
    };

export interface PiActivePrimary {
  readonly descriptor: AgentDescriptor;
  readonly promptBlock: string;
  readonly modelActivation: PiPrimaryModelActivationOutcome;
  readonly resolvedSkills: readonly ResolvedSkill[];
  readonly temperatureDegraded: boolean;
}

export interface PiPrimaryActivationContext {
  readonly availableModels: readonly PiModelInfo[];
  readonly currentModel: PiModelInfo | undefined;
  readonly modelApplier: PiModelApplyPort;
  readonly thinkingApplier?: PiThinkingApplyPort;
  readonly disabledSkills?: readonly string[];
  /** Keep a native Pi model selection instead of applying descriptor intent. */
  readonly preserveCurrentModel?: boolean;
}

export interface PiPrimarySessionDeps {
  readonly skillCatalog: PiSkillCatalog;
  readonly modelActivator?: PiModelActivator;
  readonly logger: PiAdapterLogger;
}

export const DEFAULT_PRIMARY_AGENT_NAME = "loom";

/**
 * Pi adapter contract `PiPrimarySession`: owns the parent TUI's single active
 * primary descriptor and activates it atomically.
 *
 * Activation either commits every piece of `PiActivePrimary` together, or
 * leaves the session at its prior valid state (Pi adapter contract). Skill
 * resolution and model application must both *settle* — succeed, or (for
 * the model) settle into an accepted degraded state — before anything is
 * committed; a `SkillResolutionFailed`/`NotEligiblePrimary` error never
 * mutates `getCurrent()`.
 */
export class PiPrimarySession {
  private readonly modelActivator: PiModelActivator;
  private current: PiActivePrimary | undefined;
  private previousDescriptorName: string | undefined;
  private readonly warnedKeys = new Set<string>();
  private readonly warnings: PiPrimaryCapabilityWarning[] = [];

  constructor(private readonly deps: PiPrimarySessionDeps) {
    this.modelActivator = deps.modelActivator ?? new PiModelActivator();
  }

  getCurrent(): PiActivePrimary | undefined {
    return this.current;
  }

  /**
   * Replaces the Pi-owned skill discovery snapshot used by the next
   * `activate()` call (Pi adapter contract). Pi only exposes its loaded skill
   * catalog via `before_agent_start`'s `systemPromptOptions.skills`, so
   * callers refresh this immediately before activating.
   */
  refreshSkills(availableSkills: readonly PiSkillInfo[]): void {
    this.deps.skillCatalog.refresh(availableSkills);
  }

  /** Every deduplicated temperature/model capability warning raised so far this session. */
  getCapabilityWarnings(): readonly PiPrimaryCapabilityWarning[] {
    return this.warnings;
  }

  private recordWarning(warning: PiPrimaryCapabilityWarning): void {
    const key = `${warning.capability}:${warning.agentName}:${warning.detail}`;
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.warnings.push(warning);
    this.deps.logger.warn(
      { agentName: warning.agentName, capability: warning.capability },
      `capability degraded: ${warning.detail}`,
    );
  }

  /**
   * Activates `descriptor` as the primary. `mode: "primary"` and
   * `mode: "all"` descriptors are eligible; `mode: "subagent"` is rejected
   * (Pi adapter contract — category shuttles and subagents remain delegated only).
   *
   * Resolves skills and applies the resolved model through
   * `context.modelApplier` (Pi's real `setModel`) before committing
   * anything. A resolved-but-unresolvable model, or a model the host
   * rejects, degrades this descriptor's model health but does not fail the
   * activation (Pi adapter contract); only an ineligible mode or a missing
   * skill fails it, leaving the prior primary untouched.
   */
  activate(
    descriptor: AgentDescriptor,
    context: PiPrimaryActivationContext,
  ): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
    if (descriptor.mode === "subagent") {
      return errAsyncActivation({
        type: "NotEligiblePrimary",
        agentName: descriptor.name,
        mode: descriptor.mode,
      });
    }

    const skillsResult = this.deps.skillCatalog.resolveForAgent(
      descriptor.name,
      descriptor.skills,
      context.disabledSkills,
    );
    if (skillsResult.isErr()) {
      return errAsyncActivation({
        type: "SkillResolutionFailed",
        agentName: descriptor.name,
        errors: skillsResult.error,
      });
    }

    const temperatureDeclared = descriptor.temperature !== undefined;
    if (temperatureDeclared) {
      this.recordWarning({
        capability: "temperature",
        agentName: descriptor.name,
        detail:
          "declared temperature is ignored: Pi has no stable sampling API yet (Pi adapter contract)",
      });
    }

    const modelActivation = context.preserveCurrentModel
      ? okAsync<PiPrimaryModelActivationOutcome, never>({
          status: "preserved",
          currentModel: context.currentModel,
          reason: "user-selected",
        })
      : this.modelActivator.activate(
          descriptor.models,
          context.availableModels,
          context.currentModel,
          context.modelApplier,
          context.thinkingApplier,
        );

    return modelActivation.map((modelActivation) => {
        if (modelActivation.status === "degraded") {
          this.recordWarning({
            capability: "model",
            agentName: descriptor.name,
            detail:
              modelActivation.reason === "unresolved"
                ? "no entry in the descriptor's model intent resolved against the authenticated Pi catalog"
                : "the host rejected applying the resolved model",
          });
        }

        const activePrimary: PiActivePrimary = {
          descriptor,
          promptBlock: renderWeavePromptBlock(descriptor),
          modelActivation,
          resolvedSkills: skillsResult.value,
          temperatureDegraded: temperatureDeclared,
        };

        this.previousDescriptorName = this.current?.descriptor.name;
        this.current = activePrimary;
        return activePrimary;
      });
  }

  /**
   * Re-activates the descriptor that was active immediately before the
   * current one (Pi adapter contract "plan exit restores the prior valid
   * primary"). Re-runs full atomic activation rather than replaying stale
   * state, so skills/models are re-resolved and re-applied against the
   * current context.
   */
  restorePrevious(
    descriptors: ReadonlyMap<string, AgentDescriptor>,
    context: PiPrimaryActivationContext,
  ): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
    if (this.previousDescriptorName === undefined) {
      return errAsyncActivation({ type: "NoPriorPrimary" });
    }
    const prior = descriptors.get(this.previousDescriptorName);
    if (prior === undefined) {
      return errAsyncActivation({
        type: "DescriptorNotFound",
        agentName: this.previousDescriptorName,
      });
    }
    return this.activate(prior, context);
  }

  /** Appends the current primary's composed-prompt block (Pi adapter contract). No-op if there is no active primary. */
  appendToSystemPrompt(systemPrompt: string): string {
    if (this.current === undefined) return systemPrompt;
    return appendWeaveBlockOnce(systemPrompt, this.current.descriptor);
  }
}

function errAsyncActivation(
  error: PiPrimaryActivationError,
): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
  return errAsync(error);
}
