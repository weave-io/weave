import type { AgentDescriptor, ResolvedSkill } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import {
  makePersistentParentSessionRequiredFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type {
  PiModelActivationOutcome,
  PiModelApplyPort,
  PiThinkingApplyPort,
} from "./model-resolution.js";
import { PiModelActivator } from "./model-resolution.js";
import type { PiSkillCatalog } from "./skill-catalog.js";
import type {
  PiAdapterLogger,
  PiModelInfo,
  PiSessionManagerPort,
  PiSkillInfo,
} from "./types.js";

const WEAVE_BLOCK_START = "weave:agent:start";
const WEAVE_BLOCK_END = "weave:agent:end";

/**
 * Renders the single delimited Weave block required by the Pi adapter contract: the
 * active descriptor's stable identity plus its final `composedPrompt`,
 * verbatim. Descriptors' `composedPrompt` is already final (Pi adapter contract) —
 * this function never re-renders or re-templates it.
 */
export function renderRequiredSkillsPrompt(
  composedPrompt: string,
  resolvedSkills: readonly ResolvedSkill[],
): string {
  const requiredSkillNames = resolvedSkills.map((skill) => skill.name);
  if (requiredSkillNames.length === 0) return composedPrompt;
  return [
    `Required skill names to load before work: ${JSON.stringify(requiredSkillNames)}`,
    "Load each required skill with Pi's skill-loading mechanism before you start the task.",
    composedPrompt,
  ].join("\n");
}

export function renderWeavePromptBlock(
  descriptor: AgentDescriptor,
  resolvedSkills: readonly ResolvedSkill[] = [],
): string {
  return [
    `<!-- ${WEAVE_BLOCK_START} name="${descriptor.name}" -->`,
    renderRequiredSkillsPrompt(descriptor.composedPrompt, resolvedSkills),
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
  resolvedSkills: readonly ResolvedSkill[] = [],
): string {
  if (hasWeaveBlockFor(systemPrompt, descriptor.name)) return systemPrompt;
  const block = renderWeavePromptBlock(descriptor, resolvedSkills);
  if (systemPrompt.length === 0) return block;
  return `${systemPrompt}\n\n${block}`;
}

// ---------------------------------------------------------------------------
// Parent session persistence
// ---------------------------------------------------------------------------

/**
 * The narrow slice of Pi's parent `SessionManager` this module probes. Only
 * the host answers whether the parent session is persisted; persistence is
 * never inferred from an id, a path shape, or any other guess.
 */
export type PiParentSessionProbePort = PiSessionManagerPort;

/**
 * The parent TUI's host-probed session identity and persistence.
 *
 * `persistent` carries the real host-reported identity of a durable parent
 * session. `ephemeral` is a parent Pi started without persistence (for
 * example `--no-session`): it has no durable file for child sessions, parent
 * refs, or leases to belong to. `unknown` means no probe was available or the
 * probe threw — mutation boundaries fail closed until persistence is proven.
 */
export type PiParentSessionState =
  | {
      readonly persistence: "persistent";
      readonly sessionId: string;
      readonly sessionFile: string;
    }
  | {
      readonly persistence: "ephemeral";
      readonly reason: "host-reports-not-persisted" | "no-session-file";
    }
  | {
      readonly persistence: "unknown";
      readonly reason: "no-probe" | "probe-failed";
    };

export const UNKNOWN_PARENT_SESSION: PiParentSessionState = {
  persistence: "unknown",
  reason: "no-probe",
};

const probeParentSessionSafely = Result.fromThrowable(
  (probe: PiParentSessionProbePort): PiParentSessionState => {
    if (!probe.isPersisted()) {
      return {
        persistence: "ephemeral",
        reason: "host-reports-not-persisted",
      };
    }
    const sessionFile = probe.getSessionFile();
    if (sessionFile === undefined || sessionFile.length === 0) {
      return { persistence: "ephemeral", reason: "no-session-file" };
    }
    const sessionId = probe.getSessionId();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { persistence: "ephemeral", reason: "no-session-file" };
    }
    return { persistence: "persistent", sessionId, sessionFile };
  },
  () => undefined,
);

/**
 * Reads the host's own answer for the parent session. A throwing or absent
 * probe yields `unknown`, never a fabricated identity.
 */
export function probeParentSession(
  probe: PiParentSessionProbePort | undefined,
): PiParentSessionState {
  if (probe === undefined) return UNKNOWN_PARENT_SESSION;
  return probeParentSessionSafely(probe).unwrapOr({
    persistence: "unknown",
    reason: "probe-failed",
  });
}

/** The mutation boundaries that require a durable parent session. */
export type PiParentMutationOperation =
  | "delegate"
  | "steer"
  | "follow-up"
  | "retry"
  | "continue"
  | "delete";

/**
 * The single guard every child-owning mutation runs before it creates a child
 * process, a native child session file, an execution lease, or a parent ref.
 *
 * Only a host-proven `persistent` parent may mutate. `ephemeral` and
 * `unknown` (no probe / probe failed) both reject with
 * `PersistentParentSessionRequired` — persistence cannot be assumed.
 */
export function requirePersistentParentSession(
  state: PiParentSessionState,
  operation: PiParentMutationOperation,
): Result<PiParentSessionState, PiAdapterFailure> {
  if (state.persistence === "persistent") {
    return ok(state);
  }
  return err(
    makePersistentParentSessionRequiredFailure(operation, state.reason),
  );
}

/**
 * Read-only child access (picker, history, doctor, source resolution over
 * already-resolvable prior data) never depends on the current parent's
 * persistence: prior child sessions and refs stay inspectable even from a
 * `--no-session` parent, or with no parent identity at all.
 */
export function isReadOnlyChildAccessAllowed(
  _state: PiParentSessionState,
): boolean {
  return true;
}

export type PiPrimaryActivationError =
  | {
      readonly type: "NotEligiblePrimary";
      readonly agentName: string;
      readonly mode: string;
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
  readonly capability: "temperature" | "model" | "skill";
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
  /** Host probe for the parent session's identity and persistence. */
  readonly parentSessionProbe?: PiParentSessionProbePort;
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
 * committed. Missing skills emit warnings while available skills remain
 * usable. A `NotEligiblePrimary` error never mutates `getCurrent()`.
 */
export class PiPrimarySession {
  private readonly modelActivator: PiModelActivator;
  private current: PiActivePrimary | undefined;
  private previousDescriptorName: string | undefined;
  private readonly warnedKeys = new Set<string>();
  private readonly warnings: PiPrimaryCapabilityWarning[] = [];
  private parentSession: PiParentSessionState = UNKNOWN_PARENT_SESSION;

  constructor(private readonly deps: PiPrimarySessionDeps) {
    this.modelActivator = deps.modelActivator ?? new PiModelActivator();
    if (deps.parentSessionProbe !== undefined) {
      this.parentSession = probeParentSession(deps.parentSessionProbe);
    }
  }

  getCurrent(): PiActivePrimary | undefined {
    return this.current;
  }

  /** The last host-probed parent session identity and persistence. */
  getParentSession(): PiParentSessionState {
    return this.parentSession;
  }

  /**
   * Re-probes the parent session from the host. Session transitions (new,
   * resume, fork) replace the parent identity, so the recorded state is
   * refreshed from the host rather than cached from activation time.
   */
  refreshParentSession(
    probe: PiParentSessionProbePort | undefined = this.deps.parentSessionProbe,
  ): PiParentSessionState {
    this.parentSession = probeParentSession(probe);
    return this.parentSession;
  }

  /** Runs the shared persistent-parent guard against the recorded state. */
  requirePersistentParent(
    operation: PiParentMutationOperation,
  ): Result<PiParentSessionState, PiAdapterFailure> {
    return requirePersistentParentSession(this.parentSession, operation);
  }

  /**
   * Replaces the Pi-owned skill discovery snapshot used by the next
   * `activate()` call. Boot activation reads this snapshot from
   * `PiSessionContext.getSystemPromptOptions()`; explicit later switches
   * refresh it from the same current session context.
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

  private resolveDescriptorSkills(
    descriptor: AgentDescriptor,
    disabledSkills: readonly string[] = [],
  ): readonly ResolvedSkill[] {
    const resolution = this.deps.skillCatalog
      .resolveForAgent(descriptor.name, descriptor.skills, disabledSkills)
      .match(
        (value) => value,
        (impossible) => impossible,
      );
    for (const warning of resolution.warnings) {
      this.recordWarning({
        capability: "skill",
        agentName: warning.agentName,
        detail: `required skill ${JSON.stringify(warning.skillName)} is unavailable in Pi; continuing without it`,
      });
    }
    return resolution.resolvedSkills;
  }

  /**
   * Adds Pi skill-loading instructions to a delegated agent's prompt.
   * Missing skills produce the same visible, deduplicated warnings as primary
   * activation and are omitted from the required list.
   */
  prepareComposedPrompt(
    descriptor: AgentDescriptor,
    disabledSkills: readonly string[] = [],
  ): string {
    return renderRequiredSkillsPrompt(
      descriptor.composedPrompt,
      this.resolveDescriptorSkills(descriptor, disabledSkills),
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
   * activation (Pi adapter contract). Missing skills emit warnings and do
   * not prevent activation; an ineligible mode leaves the prior primary
   * untouched.
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

    const resolvedSkills = this.resolveDescriptorSkills(
      descriptor,
      context.disabledSkills,
    );

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
        promptBlock: renderWeavePromptBlock(descriptor, resolvedSkills),
        modelActivation,
        resolvedSkills,
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
    return appendWeaveBlockOnce(
      systemPrompt,
      this.current.descriptor,
      this.current.resolvedSkills,
    );
  }
}

function errAsyncActivation(
  error: PiPrimaryActivationError,
): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
  return errAsync(error);
}
