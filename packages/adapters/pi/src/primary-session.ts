import type {
  AgentDescriptor,
  ResolvedSkill,
  SkillResolutionResult,
} from "@weaveio/weave-engine";
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
// Shared skill resolution
// ---------------------------------------------------------------------------

/**
 * The single {@link PiSkillCatalog} method prompt rendering needs.
 *
 * Kept narrow so a pure caller — the primary-contract guard — can render a
 * descriptor's prompt exactly as activation would without holding session
 * state or any part of the catalog it does not read.
 */
export type PiSkillResolutionPort = Pick<PiSkillCatalog, "resolveForAgent">;

/**
 * Resolves one descriptor's skills against Pi's current discovery snapshot.
 *
 * The one place that answers "which skills would this descriptor's prompt
 * render": {@link PiPrimarySession} uses it for activation (and then reports
 * the warnings as deduplicated capability warnings), and the primary-contract
 * guard uses it to render a candidate descriptor the same way. Warnings are
 * returned rather than recorded, because only the session surfaces them.
 */
export function resolveDescriptorSkillResolution(
  skills: PiSkillResolutionPort,
  descriptor: AgentDescriptor,
  disabledSkills: readonly string[] = [],
): SkillResolutionResult {
  return skills
    .resolveForAgent(descriptor.name, descriptor.skills, disabledSkills)
    .match(
      (value) => value,
      (impossible) => impossible,
    );
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
      /**
       * The **stable persisted** identity of this parent session: the id
       * written into the session file's own header when the host exposes it.
       *
       * This is the single origin authority for child refs. It survives a
       * restart that reopens the same file, and it is newly minted for a
       * fork, clone, or genuinely new session, so refs imported from a source
       * session stay origin-mismatched and excluded.
       */
      readonly sessionId: string;
      /**
       * The host's *runtime* session id at probe time. Diagnostics only: it
       * can differ from `sessionId` on a resume, and is never used as origin
       * authority.
       */
      readonly runtimeSessionId: string;
      /** Where `sessionId` came from. */
      readonly identitySource: "session-header" | "runtime";
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

/** Upper bound on a host-reported session identity, mirroring ref id bounds. */
const MAX_PARENT_SESSION_ID_LENGTH = 256;

/**
 * Reads the persisted header id of the file the host is actually serving.
 *
 * Returns `undefined` when the host exposes no header, the header is absent,
 * or the header id is not a bounded non-empty string. It never invents an
 * identity and never accepts an arbitrary prior origin: exactly one id, taken
 * from this session's own header, is eligible.
 */
function readPersistedHeaderSessionId(
  probe: PiParentSessionProbePort,
): string | undefined {
  if (typeof probe.getHeader !== "function") return undefined;
  const header = probe.getHeader();
  if (header === null || typeof header !== "object") return undefined;
  const id = (header as { readonly id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  if (id.length === 0 || id.length > MAX_PARENT_SESSION_ID_LENGTH) {
    return undefined;
  }
  return id;
}

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
    const runtimeSessionId = probe.getSessionId();
    if (typeof runtimeSessionId !== "string" || runtimeSessionId.length === 0) {
      return { persistence: "ephemeral", reason: "no-session-file" };
    }
    // Prefer the identity persisted in the session file's own header. On a
    // restart that reopens the same parent session the runtime id can be a
    // freshly minted value, and using it as origin authority would
    // origin-mismatch every historical ref this session itself wrote.
    const headerSessionId = readPersistedHeaderSessionId(probe);
    return headerSessionId === undefined
      ? {
          persistence: "persistent",
          sessionId: runtimeSessionId,
          runtimeSessionId,
          identitySource: "runtime",
          sessionFile,
        }
      : {
          persistence: "persistent",
          sessionId: headerSessionId,
          runtimeSessionId,
          identitySource: "session-header",
          sessionFile,
        };
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
 * source, applied model, resolved skills, and optional `fast?: true`.
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

/**
 * Neutral fast intent committed with one primary activation.
 * Present only as `true`. Omission means no fast intent.
 */
export type PiPrimaryFastIntent = true;

/**
 * Request-scoped copy of the committed primary. A later `activate()` bumps
 * `generation`, so a stale token cannot describe the later primary.
 */
export interface PiPrimaryRequestSnapshot {
  readonly generation: number;
  readonly primaryName: string;
  readonly modelIntent: readonly string[];
  readonly selectedModel: PiModelInfo | undefined;
  readonly fast?: PiPrimaryFastIntent;
}

export interface PiActivePrimary {
  readonly descriptor: AgentDescriptor;
  readonly promptBlock: string;
  readonly modelActivation: PiPrimaryModelActivationOutcome;
  readonly resolvedSkills: readonly ResolvedSkill[];
  readonly temperatureDegraded: boolean;
  readonly fast?: PiPrimaryFastIntent;
  readonly generation: number;
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
  private activationGeneration = 0;
  private appliedModelOverride: PiModelInfo | undefined;
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
    return this.current === undefined
      ? undefined
      : copyActivePrimary(this.current);
  }

  /**
   * Immutable copy of the committed primary for one later request.
   * Returns `undefined` before the first successful activation. A later
   * successful `activate()` increments `generation`, so this token cannot
   * describe that later primary.
   */
  captureRequestSnapshot(): PiPrimaryRequestSnapshot | undefined {
    if (this.current === undefined) return undefined;
    return copyRequestSnapshot(this.current, this.appliedModelOverride);
  }

  /**
   * Stable id of the current explicit Weave agent activation. Ordinary turns
   * and native model changes do not mint a new id.
   */
  getActivationId(): string | undefined {
    if (this.current === undefined) return undefined;
    return `activation-${this.current.generation}`;
  }

  /**
   * The model actually applied on the host. After a proven failover `setModel`
   * this is the fallback candidate, not the originally activated intent.
   */
  getAppliedModel(): PiModelInfo | undefined {
    if (this.appliedModelOverride !== undefined) {
      return copyModelInfo(this.appliedModelOverride);
    }
    if (this.current === undefined) return undefined;
    const selected = selectedModelFromActivation(this.current.modelActivation);
    return selected === undefined ? undefined : copyModelInfo(selected);
  }

  /**
   * Record a host-proven applied model without minting a new activation.
   * Explicit `activate()` remains the only path that clears this override.
   */
  noteAppliedModel(model: PiModelInfo): Result<void, never> {
    if (this.current === undefined) return ok(undefined);
    this.appliedModelOverride = copyModelInfo(model);
    return ok(undefined);
  }

  /**
   * Accepts a previously captured snapshot only when every request-scoped
   * field still matches this instance's committed state.
   */
  resolveRequestSnapshot(
    snapshot: PiPrimaryRequestSnapshot,
  ): Result<PiPrimaryRequestSnapshot, PiPrimarySnapshotStale> {
    const current = this.current;
    if (current === undefined) {
      return err({ type: "StalePrimaryRequestSnapshot" });
    }

    const currentSnapshot = copyRequestSnapshot(
      current,
      this.appliedModelOverride,
    );
    const matches = Result.fromThrowable(
      () => requestSnapshotsMatch(snapshot, currentSnapshot),
      () => false,
    )();
    if (matches.isErr() || !matches.value) {
      return err({ type: "StalePrimaryRequestSnapshot" });
    }
    return ok(currentSnapshot);
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
    return this.warnings.map((warning) => ({ ...warning }));
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
    const resolution = resolveDescriptorSkillResolution(
      this.deps.skillCatalog,
      descriptor,
      disabledSkills,
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

      const committedDescriptor = copyAgentDescriptor(descriptor);
      const committedResolvedSkills = copyResolvedSkills(resolvedSkills);
      const committedModelActivation =
        copyPrimaryModelActivationOutcome(modelActivation);
      const activePrimary: PiActivePrimary = Object.freeze({
        descriptor: committedDescriptor,
        promptBlock: renderWeavePromptBlock(
          committedDescriptor,
          committedResolvedSkills,
        ),
        modelActivation: committedModelActivation,
        resolvedSkills: committedResolvedSkills,
        temperatureDegraded: temperatureDeclared,
        generation: this.activationGeneration + 1,
        ...(committedDescriptor.fast === true ? { fast: true as const } : {}),
      });

      this.previousDescriptorName = this.current?.descriptor.name;
      this.activationGeneration = activePrimary.generation;
      this.appliedModelOverride = undefined;
      this.current = activePrimary;
      return copyActivePrimary(activePrimary);
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

export type PiPrimarySnapshotStale = {
  readonly type: "StalePrimaryRequestSnapshot";
};

const MAX_MODEL_API_LENGTH = 128;

/**
 * Copy a host-reported API family only when it is a bounded nonblank string.
 * Blank, oversized, and non-string values are omitted so ordinary catalog
 * models without `api` keep activating.
 */
function copyOptionalBoundedApi(
  api: unknown,
): { readonly api: string } | Record<string, never> {
  if (typeof api !== "string") return {};
  if (api.length === 0 || api.length > MAX_MODEL_API_LENGTH) return {};
  if (api.trim().length === 0) return {};
  return { api };
}

/**
 * Copy the adapter-owned model identity. The Pi model catalog is supplied by
 * the host and its records remain mutable at runtime even though their
 * TypeScript fields are readonly. Host `api` is copied exactly when valid
 * and never inferred from provider or model ids.
 */
function copyModelInfo(model: PiModelInfo): PiModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...copyOptionalBoundedApi(model.api),
  };
}

function copyOptionalModelInfo(
  model: PiModelInfo | undefined,
): PiModelInfo | undefined {
  return model === undefined ? undefined : copyModelInfo(model);
}

function copyEffectiveToolPolicy(
  policy: AgentDescriptor["effectiveToolPolicy"],
): AgentDescriptor["effectiveToolPolicy"] {
  return {
    read: policy.read,
    write: policy.write,
    execute: policy.execute,
    delegate: policy.delegate,
    network: policy.network,
  };
}

function copyRawToolPolicy(
  policy: AgentDescriptor["rawToolPolicy"],
): AgentDescriptor["rawToolPolicy"] {
  if (policy === undefined) return undefined;
  return {
    ...(policy.read === undefined ? {} : { read: policy.read }),
    ...(policy.write === undefined ? {} : { write: policy.write }),
    ...(policy.execute === undefined ? {} : { execute: policy.execute }),
    ...(policy.delegate === undefined ? {} : { delegate: policy.delegate }),
    ...(policy.network === undefined ? {} : { network: policy.network }),
  };
}

function copyCategory(
  category: AgentDescriptor["category"],
): AgentDescriptor["category"] {
  return category === undefined
    ? undefined
    : { name: category.name, description: category.description };
}

function copyDelegationTarget(
  target: AgentDescriptor["delegationTargets"][number],
): AgentDescriptor["delegationTargets"][number] {
  return {
    name: target.name,
    ...(target.description === undefined
      ? {}
      : { description: target.description }),
    triggers: [...target.triggers],
    isCategory: target.isCategory,
  };
}

const MAX_SKILL_METADATA_DEPTH = 8;
const MAX_SKILL_METADATA_NODES = 128;
const MAX_SKILL_METADATA_PROPERTIES = 64;
const OMIT_NESTED_VALUE = Symbol("omit-nested-value");

type NestedCopyResult = unknown | typeof OMIT_NESTED_VALUE;

interface NestedCopyContext {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function readOwnDataProperty(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  const result = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(value, key),
    () => undefined,
  )();
  if (result.isErr() || result.value === undefined) return undefined;
  return "value" in result.value ? result.value : undefined;
}

function copyNestedValue(
  value: unknown,
): { readonly value: unknown } | undefined {
  const copied = copyNestedValueAt(value, 0, {
    ancestors: new WeakSet<object>(),
    nodes: 0,
  });
  return copied === OMIT_NESTED_VALUE ? undefined : { value: copied };
}

function copyNestedValueAt(
  value: unknown,
  depth: number,
  context: NestedCopyContext,
): NestedCopyResult {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value !== "object") return OMIT_NESTED_VALUE;
  if (depth >= MAX_SKILL_METADATA_DEPTH) return OMIT_NESTED_VALUE;
  if (context.nodes >= MAX_SKILL_METADATA_NODES) return OMIT_NESTED_VALUE;
  if (context.ancestors.has(value)) return OMIT_NESTED_VALUE;

  context.nodes += 1;
  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return copyNestedArray(value, depth, context);
    }

    const prototype = Result.fromThrowable(
      () => Object.getPrototypeOf(value),
      () => undefined,
    )().unwrapOr(undefined);
    if (prototype !== Object.prototype && prototype !== null) {
      return OMIT_NESTED_VALUE;
    }

    const keys = Result.fromThrowable(
      () => Reflect.ownKeys(value),
      () => undefined,
    )().unwrapOr(undefined);
    if (keys === undefined) return OMIT_NESTED_VALUE;

    const copy: Record<string, unknown> = {};
    let inspectedProperties = 0;
    for (const key of keys) {
      if (inspectedProperties >= MAX_SKILL_METADATA_PROPERTIES) break;
      inspectedProperties += 1;
      if (typeof key !== "string") continue;

      const property = readOwnDataProperty(value, key);
      if (property === undefined || !property.enumerable) continue;
      const child = copyNestedValueAt(property.value, depth + 1, context);
      if (child === OMIT_NESTED_VALUE) continue;
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    return copy;
  } finally {
    context.ancestors.delete(value);
  }
}

function copyNestedArray(
  value: object,
  depth: number,
  context: NestedCopyContext,
): NestedCopyResult {
  const lengthProperty = readOwnDataProperty(value, "length");
  if (
    lengthProperty === undefined ||
    !Number.isSafeInteger(lengthProperty.value) ||
    (lengthProperty.value as number) > MAX_SKILL_METADATA_PROPERTIES
  ) {
    return OMIT_NESTED_VALUE;
  }

  const length = lengthProperty.value as number;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const property = readOwnDataProperty(value, String(index));
    if (property === undefined || !property.enumerable) {
      return OMIT_NESTED_VALUE;
    }
    const child = copyNestedValueAt(property.value, depth + 1, context);
    if (child === OMIT_NESTED_VALUE) continue;
    Object.defineProperty(copy, String(index), {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  copy.length = length;
  return copy;
}

function copyResolvedSkill(skill: ResolvedSkill): ResolvedSkill {
  const skillName = readOwnDataProperty(skill, "name")?.value;
  const skillInfoValue = readOwnDataProperty(skill, "skillInfo")?.value;
  const safeSkillName = typeof skillName === "string" ? skillName : "";
  if (!isObjectRecord(skillInfoValue)) {
    return { name: safeSkillName, skillInfo: { name: safeSkillName } };
  }

  const skillInfoName = readOwnDataProperty(skillInfoValue, "name")?.value;
  const skillInfo: { name: string; metadata?: unknown } = {
    name: typeof skillInfoName === "string" ? skillInfoName : safeSkillName,
  };
  const metadataProperty = readOwnDataProperty(skillInfoValue, "metadata");
  if (metadataProperty !== undefined) {
    const metadata = copyNestedValue(metadataProperty.value);
    if (metadata !== undefined) skillInfo.metadata = metadata.value;
  }
  return { name: safeSkillName, skillInfo };
}

function copyResolvedSkills(skills: readonly ResolvedSkill[]): ResolvedSkill[] {
  return skills.map(copyResolvedSkill);
}

function copyAgentDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  const copy: AgentDescriptor = {
    name: descriptor.name,
    composedPrompt: descriptor.composedPrompt,
    models: [...descriptor.models],
    mode: descriptor.mode,
    effectiveToolPolicy: copyEffectiveToolPolicy(
      descriptor.effectiveToolPolicy,
    ),
    rawToolPolicy: copyRawToolPolicy(descriptor.rawToolPolicy),
    delegationTargets: descriptor.delegationTargets.map(copyDelegationTarget),
    skills: [...descriptor.skills],
  };

  if (descriptor.displayName !== undefined)
    copy.displayName = descriptor.displayName;
  if (descriptor.description !== undefined)
    copy.description = descriptor.description;
  if (descriptor.category !== undefined)
    copy.category = copyCategory(descriptor.category);
  if (descriptor.temperature !== undefined)
    copy.temperature = descriptor.temperature;
  if (descriptor.fast === true) copy.fast = true;
  return copy;
}

function copyPrimaryModelActivationOutcome(
  outcome: PiPrimaryModelActivationOutcome,
): PiPrimaryModelActivationOutcome {
  if (outcome.status === "preserved") {
    return {
      status: "preserved",
      currentModel: copyOptionalModelInfo(outcome.currentModel),
      reason: outcome.reason,
    };
  }
  if (outcome.status === "degraded") {
    return {
      status: "degraded",
      reason: outcome.reason,
      currentModel: copyOptionalModelInfo(outcome.currentModel),
    };
  }
  return {
    status: "applied",
    model: copyModelInfo(outcome.model),
    intentEntry: outcome.intentEntry,
    source: outcome.source,
    ...(outcome.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: outcome.thinkingLevel }),
    ...(outcome.thinkingApplied === undefined
      ? {}
      : { thinkingApplied: outcome.thinkingApplied }),
  };
}

function copyActivePrimary(active: PiActivePrimary): PiActivePrimary {
  return {
    descriptor: copyAgentDescriptor(active.descriptor),
    promptBlock: active.promptBlock,
    modelActivation: copyPrimaryModelActivationOutcome(active.modelActivation),
    resolvedSkills: copyResolvedSkills(active.resolvedSkills),
    temperatureDegraded: active.temperatureDegraded,
    generation: active.generation,
    ...(active.fast === true ? { fast: true as const } : {}),
  };
}

function selectedModelFromActivation(
  modelActivation: PiPrimaryModelActivationOutcome,
): PiModelInfo | undefined {
  if (modelActivation.status === "applied") return modelActivation.model;
  return modelActivation.currentModel;
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function hasSameOwnKeys(left: object, right: object): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => rightKeys.includes(key))
  );
}

function modelIntentsMatch(
  candidate: unknown,
  committed: readonly string[],
): boolean {
  if (
    !Array.isArray(candidate) ||
    !hasSameOwnKeys(candidate, committed) ||
    candidate.length !== committed.length
  ) {
    return false;
  }
  for (let index = 0; index < committed.length; index += 1) {
    if (!hasOwn(candidate, index) || candidate[index] !== committed[index]) {
      return false;
    }
  }
  return true;
}

function selectedModelsMatch(
  candidate: unknown,
  committed: PiModelInfo | undefined,
): boolean {
  if (candidate === undefined || committed === undefined) {
    return candidate === committed;
  }
  if (!isObjectRecord(candidate) || !hasSameOwnKeys(candidate, committed)) {
    return false;
  }
  return (
    candidate.provider === committed.provider &&
    candidate.id === committed.id &&
    candidate.name === committed.name &&
    candidate.api === committed.api
  );
}

function requestSnapshotsMatch(
  candidate: unknown,
  committed: PiPrimaryRequestSnapshot,
): boolean {
  if (!isObjectRecord(candidate) || !hasSameOwnKeys(candidate, committed)) {
    return false;
  }
  for (const key of [
    "generation",
    "primaryName",
    "modelIntent",
    "selectedModel",
  ]) {
    if (!hasOwn(candidate, key)) return false;
  }
  const candidateFastPresent = hasOwn(candidate, "fast");
  const committedFastPresent = hasOwn(committed, "fast");
  return (
    candidate.generation === committed.generation &&
    candidate.primaryName === committed.primaryName &&
    modelIntentsMatch(candidate.modelIntent, committed.modelIntent) &&
    selectedModelsMatch(candidate.selectedModel, committed.selectedModel) &&
    candidateFastPresent === committedFastPresent &&
    (!candidateFastPresent || candidate.fast === committed.fast)
  );
}

function copySelectedModel(model: PiModelInfo): PiModelInfo {
  return Object.freeze({
    provider: model.provider,
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...copyOptionalBoundedApi(model.api),
  });
}

function copyRequestSnapshot(
  current: PiActivePrimary,
  appliedModelOverride?: PiModelInfo,
): PiPrimaryRequestSnapshot {
  const selectedModel =
    appliedModelOverride ??
    selectedModelFromActivation(current.modelActivation);
  return Object.freeze({
    generation: current.generation,
    primaryName: current.descriptor.name,
    modelIntent: Object.freeze([...current.descriptor.models]),
    selectedModel:
      selectedModel === undefined
        ? undefined
        : copySelectedModel(selectedModel),
    ...(current.fast === true ? { fast: true as const } : {}),
  });
}

function errAsyncActivation(
  error: PiPrimaryActivationError,
): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
  return errAsync(error);
}
