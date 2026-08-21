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
import { z } from "zod";
import {
  makePersistentParentSessionRequiredFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type {
  PiModelActivationOutcome,
  PiModelApplyPort,
  PiThinkingApplyPort,
} from "./model-resolution.js";
import { observePiModel, PiModelActivator } from "./model-resolution.js";
import type { PiSkillCatalog } from "./skill-catalog.js";
import type {
  PiAdapterLogger,
  PiModelInfo,
  PiSessionManagerPort,
  PiSkillInfo,
} from "./types.js";

const WEAVE_BLOCK_START = "weave:agent:start";
const WEAVE_BLOCK_END = "weave:agent:end";
const PI_SESSION_INPUT_SCHEMA = z.unknown();
type PiSessionObservedValue = z.input<typeof PI_SESSION_INPUT_SCHEMA>;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;
const OMIT_NESTED_VALUE = Symbol("omit-nested-value");

interface PiSessionInspectableObject {
  readonly piSessionObjectMarker?: never;
}

const PI_SESSION_OBJECT_SCHEMA = z.custom<PiSessionInspectableObject>((value) =>
  Result.fromThrowable(
    () =>
      value !== null && Object(value) === value && !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);

const PI_SESSION_STRING_SCHEMA = z.string();
const PI_SESSION_BOOLEAN_SCHEMA = z.boolean();
const PI_SESSION_NUMBER_SCHEMA = z.number();

function parseSessionObject(
  value: PiSessionObservedValue,
): PiSessionInspectableObject | undefined {
  const parsed = PI_SESSION_OBJECT_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readOwnDataProperty(
  value: PiSessionInspectableObject,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  const result = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(value, key),
    (): null => null,
  )();
  if (result.isErr() || result.value === undefined) return undefined;
  if (!hasOwnPropertyFn.call(result.value, "value")) return undefined;
  return result.value;
}

type PiSkillMetadataPrimitive = string | number | boolean | null;
interface PiSkillMetadataObject {
  [key: string]: PiSkillMetadataValue;
}
type PiSkillMetadataValue =
  | PiSkillMetadataPrimitive
  | PiSkillMetadataValue[]
  | PiSkillMetadataObject;

type PiNestedCopyResult = PiSkillMetadataValue | typeof OMIT_NESTED_VALUE;

interface PiCopiedSkillInfo {
  name: string;
  metadata?: PiSkillMetadataValue;
}

interface PiMutableModelInfo {
  provider: string;
  id: string;
  name?: string;
  api?: string;
}

interface PiMutableRawToolPolicy {
  read?: NonNullable<AgentDescriptor["rawToolPolicy"]>["read"];
  write?: NonNullable<AgentDescriptor["rawToolPolicy"]>["write"];
  execute?: NonNullable<AgentDescriptor["rawToolPolicy"]>["execute"];
  delegate?: NonNullable<AgentDescriptor["rawToolPolicy"]>["delegate"];
  network?: NonNullable<AgentDescriptor["rawToolPolicy"]>["network"];
}

interface PiMutableDelegationTarget {
  name: string;
  description?: string;
  triggers: string[];
  isCategory: boolean;
}

interface PiMutableActivePrimary {
  descriptor: AgentDescriptor;
  promptBlock: string;
  modelActivation: PiPrimaryModelActivationOutcome;
  resolvedSkills: readonly ResolvedSkill[];
  temperatureDegraded: boolean;
  fast?: PiPrimaryFastIntent;
  generation: number;
}

interface PiMutableRequestSnapshot {
  generation: number;
  primaryName: string;
  modelIntent: readonly string[];
  selectedModel: PiModelInfo | undefined;
  fast?: PiPrimaryFastIntent;
}

type PiAppliedModelActivation = Extract<
  PiModelActivationOutcome,
  { readonly status: "applied" }
>;

interface PiMutableAppliedActivation {
  status: "applied";
  model: PiModelInfo;
  intentEntry: string;
  source: PiAppliedModelActivation["source"];
  thinkingLevel?: PiAppliedModelActivation["thinkingLevel"];
  thinkingApplied?: boolean;
}

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
 * Returns `null` when the host exposes no header, the header is absent, or
 * the header id is not a bounded non-empty string. It never invents an
 * identity and never accepts an arbitrary prior origin: exactly one id, taken
 * from this session's own header, is eligible.
 */
function readPersistedHeaderSessionId(
  probe: PiParentSessionProbePort,
): Result<string | null, "header-probe-failed"> {
  if (probe.getHeader === undefined) return ok(null);
  const header = Result.fromThrowable(
    () => probe.getHeader?.(),
    (): "header-probe-failed" => "header-probe-failed",
  )();
  if (header.isErr()) return err("header-probe-failed");
  const headerObject = parseSessionObject(header.value);
  if (headerObject === undefined) return ok(null);
  const idDescriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(headerObject, "id"),
    (): "header-probe-failed" => "header-probe-failed",
  )();
  if (idDescriptor.isErr()) return err("header-probe-failed");
  if (idDescriptor.value === undefined) return ok(null);
  if (!hasOwnPropertyFn.call(idDescriptor.value, "value")) {
    return err("header-probe-failed");
  }
  const parsedId = PI_SESSION_STRING_SCHEMA.safeParse(idDescriptor.value.value);
  if (!parsedId.success) return ok(null);
  if (
    parsedId.data.length === 0 ||
    parsedId.data.length > MAX_PARENT_SESSION_ID_LENGTH
  ) {
    return ok(null);
  }
  return ok(parsedId.data);
}

const probeParentSessionSafely = Result.fromThrowable(
  (probe: PiParentSessionProbePort): PiParentSessionState => {
    if (!probe.isPersisted()) {
      return {
        persistence: "ephemeral",
        reason: "host-reports-not-persisted",
      };
    }
    const sessionFile = PI_SESSION_STRING_SCHEMA.safeParse(
      probe.getSessionFile(),
    );
    if (!sessionFile.success || sessionFile.data.length === 0) {
      return { persistence: "ephemeral", reason: "no-session-file" };
    }
    const runtimeSessionId = PI_SESSION_STRING_SCHEMA.safeParse(
      probe.getSessionId(),
    );
    if (!runtimeSessionId.success || runtimeSessionId.data.length === 0) {
      return { persistence: "ephemeral", reason: "no-session-file" };
    }
    // Prefer the identity persisted in the session file's own header. On a
    // restart that reopens the same parent session the runtime id can be a
    // freshly minted value, and using it as origin authority would
    // origin-mismatch every historical ref this session itself wrote.
    const headerSessionId = readPersistedHeaderSessionId(probe);
    if (headerSessionId.isErr()) {
      return { persistence: "unknown", reason: "probe-failed" };
    }
    return headerSessionId.value === null
      ? {
          persistence: "persistent",
          sessionId: runtimeSessionId.data,
          runtimeSessionId: runtimeSessionId.data,
          identitySource: "runtime",
          sessionFile: sessionFile.data,
        }
      : {
          persistence: "persistent",
          sessionId: headerSessionId.value,
          runtimeSessionId: runtimeSessionId.data,
          identitySource: "session-header",
          sessionFile: sessionFile.data,
        };
  },
  (): null => null,
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
    return copyRequestSnapshot(this.current);
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

    const currentSnapshot = copyRequestSnapshot(current);
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
      const activePrimary: PiMutableActivePrimary = {
        descriptor: committedDescriptor,
        promptBlock: renderWeavePromptBlock(
          committedDescriptor,
          committedResolvedSkills,
        ),
        modelActivation: committedModelActivation,
        resolvedSkills: committedResolvedSkills,
        temperatureDegraded: temperatureDeclared,
        generation: this.activationGeneration + 1,
      };
      if (committedDescriptor.fast === true) activePrimary.fast = true;
      const committedPrimary = Object.freeze(activePrimary);

      this.previousDescriptorName = this.current?.descriptor.name;
      this.activationGeneration = committedPrimary.generation;
      this.current = committedPrimary;
      return copyActivePrimary(committedPrimary);
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
  api: PiSessionObservedValue,
): string | undefined {
  const parsedApi = PI_SESSION_STRING_SCHEMA.safeParse(api);
  if (!parsedApi.success) return undefined;
  if (
    parsedApi.data.length === 0 ||
    parsedApi.data.length > MAX_MODEL_API_LENGTH ||
    parsedApi.data.trim().length === 0
  ) {
    return undefined;
  }
  return parsedApi.data;
}

/**
 * Copy the adapter-owned model identity. The Pi model catalog is supplied by
 * the host and its records remain mutable at runtime even though their
 * TypeScript fields are readonly. Host `api` is copied exactly when valid
 * and never inferred from provider or model ids.
 */
function copyModelInfo(model: PiModelInfo): PiModelInfo | undefined {
  const observed = observePiModel(model);
  if (observed.isErr()) return undefined;
  const copy: PiMutableModelInfo = {
    provider: observed.value.provider,
    id: observed.value.id,
  };
  if (observed.value.name !== undefined) copy.name = observed.value.name;
  const api = copyOptionalBoundedApi(observed.value.api);
  if (api !== undefined) copy.api = api;
  return copy;
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
  const copy: PiMutableRawToolPolicy = {};
  if (policy.read !== undefined) copy.read = policy.read;
  if (policy.write !== undefined) copy.write = policy.write;
  if (policy.execute !== undefined) copy.execute = policy.execute;
  if (policy.delegate !== undefined) copy.delegate = policy.delegate;
  if (policy.network !== undefined) copy.network = policy.network;
  return copy;
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
  const copy: PiMutableDelegationTarget = {
    name: target.name,
    triggers: [...target.triggers],
    isCategory: target.isCategory,
  };
  if (target.description !== undefined) copy.description = target.description;
  return copy;
}

const MAX_SKILL_METADATA_DEPTH = 8;
const MAX_SKILL_METADATA_NODES = 128;
const MAX_SKILL_METADATA_PROPERTIES = 64;

interface NestedCopyContext {
  readonly ancestors: WeakSet<PiSessionInspectableObject>;
  nodes: number;
}

function copyNestedValue(
  value: PiSessionObservedValue,
): { readonly value: PiSkillMetadataValue } | undefined {
  const copied = Result.fromThrowable(
    () =>
      copyNestedValueAt(value, 0, {
        ancestors: new WeakSet<PiSessionInspectableObject>(),
        nodes: 0,
      }),
    (): "copy-failed" => "copy-failed",
  )();
  if (copied.isErr() || copied.value === OMIT_NESTED_VALUE) return undefined;
  return { value: copied.value };
}

function copyNestedValueAt(
  value: PiSessionObservedValue,
  depth: number,
  context: NestedCopyContext,
): PiNestedCopyResult {
  const parsedString = PI_SESSION_STRING_SCHEMA.safeParse(value);
  if (parsedString.success) return parsedString.data;
  const parsedNumber = PI_SESSION_NUMBER_SCHEMA.safeParse(value);
  if (parsedNumber.success) return parsedNumber.data;
  const parsedBoolean = PI_SESSION_BOOLEAN_SCHEMA.safeParse(value);
  if (parsedBoolean.success) return parsedBoolean.data;
  if (value === null) return null;
  if (value === undefined) return OMIT_NESTED_VALUE;

  const object = parseSessionObject(value);
  if (object === undefined) return OMIT_NESTED_VALUE;
  if (depth >= MAX_SKILL_METADATA_DEPTH) return OMIT_NESTED_VALUE;
  if (context.nodes >= MAX_SKILL_METADATA_NODES) return OMIT_NESTED_VALUE;
  if (context.ancestors.has(object)) return OMIT_NESTED_VALUE;

  context.nodes += 1;
  context.ancestors.add(object);
  try {
    const isArray = Result.fromThrowable(
      () => Array.isArray(object),
      (): boolean => false,
    )().unwrapOr(false);
    if (isArray) return copyNestedArray(object, depth, context);

    const prototype = Result.fromThrowable(
      () => Object.getPrototypeOf(object),
      (): "unreadable" => "unreadable",
    )();
    if (prototype.isErr()) return OMIT_NESTED_VALUE;
    if (prototype.value !== Object.prototype && prototype.value !== null) {
      return OMIT_NESTED_VALUE;
    }

    const keys = Result.fromThrowable(
      () => Reflect.ownKeys(object),
      (): "unreadable" => "unreadable",
    )();
    if (keys.isErr()) return OMIT_NESTED_VALUE;

    const copy: PiSkillMetadataObject = {};
    let inspectedProperties = 0;
    for (const key of keys.value) {
      if (inspectedProperties >= MAX_SKILL_METADATA_PROPERTIES) break;
      inspectedProperties += 1;
      const parsedKey = PI_SESSION_STRING_SCHEMA.safeParse(key);
      if (!parsedKey.success) continue;

      const property = readOwnDataProperty(object, parsedKey.data);
      if (property === undefined || !property.enumerable) continue;
      const child = copyNestedValueAt(property.value, depth + 1, context);
      if (child === OMIT_NESTED_VALUE) continue;
      Object.defineProperty(copy, parsedKey.data, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    return copy;
  } finally {
    context.ancestors.delete(object);
  }
}

function copyNestedArray(
  value: PiSessionInspectableObject,
  depth: number,
  context: NestedCopyContext,
): PiNestedCopyResult {
  const lengthProperty = readOwnDataProperty(value, "length");
  if (lengthProperty === undefined) return OMIT_NESTED_VALUE;
  const parsedLength = PI_SESSION_NUMBER_SCHEMA.safeParse(lengthProperty.value);
  if (
    !parsedLength.success ||
    !Number.isSafeInteger(parsedLength.data) ||
    parsedLength.data < 0 ||
    parsedLength.data > MAX_SKILL_METADATA_PROPERTIES
  ) {
    return OMIT_NESTED_VALUE;
  }

  const length = parsedLength.data;
  const copy: PiSkillMetadataValue[] = [];
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
  const skillObject = parseSessionObject(skill);
  const skillNameValue =
    skillObject === undefined
      ? undefined
      : readOwnDataProperty(skillObject, "name")?.value;
  const parsedSkillName = PI_SESSION_STRING_SCHEMA.safeParse(skillNameValue);
  const safeSkillName = parsedSkillName.success ? parsedSkillName.data : "";

  const skillInfoValue =
    skillObject === undefined
      ? undefined
      : readOwnDataProperty(skillObject, "skillInfo")?.value;
  const skillInfoObject = parseSessionObject(skillInfoValue);
  const skillInfo: PiCopiedSkillInfo = { name: safeSkillName };
  if (skillInfoObject === undefined) {
    return { name: safeSkillName, skillInfo };
  }

  const skillInfoName = readOwnDataProperty(skillInfoObject, "name")?.value;
  const parsedSkillInfoName = PI_SESSION_STRING_SCHEMA.safeParse(skillInfoName);
  if (parsedSkillInfoName.success) skillInfo.name = parsedSkillInfoName.data;

  const metadataProperty = readOwnDataProperty(skillInfoObject, "metadata");
  if (metadataProperty?.enumerable === true) {
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

  const model = copyModelInfo(outcome.model);
  if (model === undefined) {
    return {
      status: "degraded",
      reason: "apply-failed",
      currentModel: undefined,
    };
  }
  const copy: PiMutableAppliedActivation = {
    status: "applied",
    model,
    intentEntry: outcome.intentEntry,
    source: outcome.source,
  };
  if (outcome.thinkingLevel !== undefined)
    copy.thinkingLevel = outcome.thinkingLevel;
  if (outcome.thinkingApplied !== undefined)
    copy.thinkingApplied = outcome.thinkingApplied;
  return copy;
}

function copyActivePrimary(active: PiActivePrimary): PiActivePrimary {
  const copy: PiMutableActivePrimary = {
    descriptor: copyAgentDescriptor(active.descriptor),
    promptBlock: active.promptBlock,
    modelActivation: copyPrimaryModelActivationOutcome(active.modelActivation),
    resolvedSkills: copyResolvedSkills(active.resolvedSkills),
    temperatureDegraded: active.temperatureDegraded,
    generation: active.generation,
  };
  if (active.fast === true) copy.fast = true;
  return copy;
}

function selectedModelFromActivation(
  modelActivation: PiPrimaryModelActivationOutcome,
): PiModelInfo | undefined {
  if (modelActivation.status === "applied") return modelActivation.model;
  return modelActivation.currentModel;
}

function hasOwn(value: PiSessionInspectableObject, key: PropertyKey): boolean {
  return Result.fromThrowable(
    () => hasOwnPropertyFn.call(value, key),
    (): boolean => false,
  )().unwrapOr(false);
}

function ownKeys(
  value: PiSessionInspectableObject,
): readonly PropertyKey[] | undefined {
  const result = Result.fromThrowable(
    () => Reflect.ownKeys(value),
    (): null => null,
  )();
  return result.isErr() || result.value === null ? undefined : result.value;
}

function hasSameOwnKeys(
  left: PiSessionInspectableObject,
  right: PiSessionInspectableObject,
): boolean {
  const leftKeys = ownKeys(left);
  const rightKeys = ownKeys(right);
  if (leftKeys === undefined || rightKeys === undefined) return false;
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => rightKeys.includes(key))
  );
}

function asObservedArray(
  value: PiSessionObservedValue,
): PiSessionInspectableObject | undefined {
  const object = parseSessionObject(value);
  if (object === undefined) return undefined;
  const isArray = Result.fromThrowable(
    () => Array.isArray(object),
    (): boolean => false,
  )().unwrapOr(false);
  return isArray ? object : undefined;
}

function readObservedArrayLength(
  value: PiSessionInspectableObject,
): number | undefined {
  const lengthProperty = readOwnDataProperty(value, "length");
  if (lengthProperty === undefined) return undefined;
  const parsedLength = PI_SESSION_NUMBER_SCHEMA.safeParse(lengthProperty.value);
  if (
    !parsedLength.success ||
    !Number.isSafeInteger(parsedLength.data) ||
    parsedLength.data < 0
  ) {
    return undefined;
  }
  return parsedLength.data;
}

function readObservedString(
  value: PiSessionInspectableObject,
  key: PropertyKey,
): string | undefined {
  const property = readOwnDataProperty(value, key);
  if (property === undefined) return undefined;
  const parsed = PI_SESSION_STRING_SCHEMA.safeParse(property.value);
  return parsed.success ? parsed.data : undefined;
}

function modelIntentsMatch(
  candidate: PiSessionObservedValue,
  committed: readonly string[],
): boolean {
  const candidateArray = asObservedArray(candidate);
  const committedArray = asObservedArray(committed);
  if (candidateArray === undefined || committedArray === undefined) {
    return false;
  }
  if (!hasSameOwnKeys(candidateArray, committedArray)) return false;
  const candidateLength = readObservedArrayLength(candidateArray);
  const committedLength = readObservedArrayLength(committedArray);
  if (
    candidateLength === undefined ||
    committedLength === undefined ||
    candidateLength !== committedLength ||
    candidateLength !== committed.length
  ) {
    return false;
  }
  for (let index = 0; index < committed.length; index += 1) {
    const candidateValue = readObservedString(candidateArray, String(index));
    if (candidateValue === undefined || candidateValue !== committed[index]) {
      return false;
    }
  }
  return true;
}

function selectedModelsMatch(
  candidate: PiSessionObservedValue,
  committed: PiModelInfo | undefined,
): boolean {
  if (candidate === undefined || committed === undefined) {
    return candidate === committed;
  }
  const candidateObject = parseSessionObject(candidate);
  const committedObject = parseSessionObject(committed);
  if (candidateObject === undefined || committedObject === undefined) {
    return false;
  }
  if (!hasSameOwnKeys(candidateObject, committedObject)) return false;
  const committedObservation = observePiModel(committed);
  if (committedObservation.isErr()) return false;
  const candidateProvider = readObservedString(candidateObject, "provider");
  const candidateId = readObservedString(candidateObject, "id");
  if (
    candidateProvider !== committedObservation.value.provider ||
    candidateId !== committedObservation.value.id
  ) {
    return false;
  }

  const candidateName = readObservedString(candidateObject, "name");
  const candidateApi = readObservedString(candidateObject, "api");
  return (
    candidateName === committedObservation.value.name &&
    candidateApi === committedObservation.value.api
  );
}

function requestSnapshotsMatch(
  candidate: PiSessionObservedValue,
  committed: PiPrimaryRequestSnapshot,
): boolean {
  const candidateObject = parseSessionObject(candidate);
  const committedObject = parseSessionObject(committed);
  if (candidateObject === undefined || committedObject === undefined) {
    return false;
  }
  if (!hasSameOwnKeys(candidateObject, committedObject)) return false;
  const generationProperty = readOwnDataProperty(candidateObject, "generation");
  const primaryNameProperty = readOwnDataProperty(
    candidateObject,
    "primaryName",
  );
  const modelIntentProperty = readOwnDataProperty(
    candidateObject,
    "modelIntent",
  );
  const selectedModelProperty = readOwnDataProperty(
    candidateObject,
    "selectedModel",
  );
  if (
    generationProperty === undefined ||
    primaryNameProperty === undefined ||
    modelIntentProperty === undefined ||
    selectedModelProperty === undefined
  ) {
    return false;
  }
  const generation = PI_SESSION_NUMBER_SCHEMA.safeParse(
    generationProperty.value,
  );
  const primaryName = PI_SESSION_STRING_SCHEMA.safeParse(
    primaryNameProperty.value,
  );
  if (
    !generation.success ||
    !Number.isSafeInteger(generation.data) ||
    !primaryName.success
  ) {
    return false;
  }
  if (
    generation.data !== committed.generation ||
    primaryName.data !== committed.primaryName ||
    !modelIntentsMatch(modelIntentProperty.value, committed.modelIntent) ||
    !selectedModelsMatch(selectedModelProperty.value, committed.selectedModel)
  ) {
    return false;
  }

  const candidateFastPresent = hasOwn(candidateObject, "fast");
  const committedFastPresent = hasOwn(committedObject, "fast");
  if (candidateFastPresent !== committedFastPresent) return false;
  if (!candidateFastPresent) return true;
  const fastProperty = readOwnDataProperty(candidateObject, "fast");
  if (fastProperty === undefined) return false;
  const fast = PI_SESSION_BOOLEAN_SCHEMA.safeParse(fastProperty.value);
  return fast.success && fast.data === true && committed.fast === true;
}

function copySelectedModel(model: PiModelInfo): PiModelInfo | undefined {
  const copy = copyModelInfo(model);
  return copy === undefined ? undefined : Object.freeze(copy);
}

function copyRequestSnapshot(
  current: PiActivePrimary,
): PiPrimaryRequestSnapshot {
  const selectedModel = selectedModelFromActivation(current.modelActivation);
  const snapshot: PiMutableRequestSnapshot = {
    generation: current.generation,
    primaryName: current.descriptor.name,
    modelIntent: Object.freeze([...current.descriptor.models]),
    selectedModel:
      selectedModel === undefined
        ? undefined
        : copySelectedModel(selectedModel),
  };
  if (current.fast === true) snapshot.fast = true;
  return Object.freeze(snapshot);
}

function errAsyncActivation(
  error: PiPrimaryActivationError,
): ResultAsync<PiActivePrimary, PiPrimaryActivationError> {
  return errAsync(error);
}
