import type { AgentDescriptor, PermissionSession } from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
} from "./capability-prober.js";
import { WEAVE_COMMAND_NAMES, type WeaveCommandName } from "./commands.js";
import {
  logMaterializationErrors,
  PiConfigActivator,
} from "./config-activator.js";
import {
  PiExtensionController,
  type PiExtensionControllerDeps,
} from "./controller.js";
import { makeRequiredCapabilityUnavailableFailure } from "./errors.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
} from "./host-compatibility.js";
import { readValidatedCommands, readValidatedTools } from "./host-inventory.js";
import type { PiModelApplyPort } from "./model-resolution.js";
import {
  APPROVAL_UI_TIMEOUT_MS,
  type PiApprovalChoiceInput,
  type PiApprovalPromptRequest,
  type PiApprovalScope,
  type PiApprovalUiPort,
  PiPermissionBridge,
  type PiToolPolicyPlan,
} from "./permission-bridge.js";
import { safelyListAvailableModels } from "./port-safety.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiPrimaryActivationError,
  PiPrimarySession,
} from "./primary-session.js";
import { PiSafeInitializer } from "./safe-initializer.js";
import { PiSkillCatalog } from "./skill-catalog.js";
import { PI_NATIVE_TOOL_CAPABILITY } from "./tool-governance.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiSkillInfo,
  PiToolCallEvent,
} from "./types.js";

/** Every dependency this extension needs beyond what Pi hands it directly. Fully injectable for tests. */
export interface PiExtensionDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
  readonly configActivator: PiConfigActivator;
  readonly permissionBridge: PiPermissionBridge;
}

class CryptoIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Production dependency set. No I/O happens here - everything is deferred to `session_start`. */
export function createDefaultPiExtensionDeps(): PiExtensionDeps {
  const log = logger.child({ module: "adapter-pi" });
  return {
    hostPackageReader: new BunHostPackageReader(),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    logger: log,
    configActivator: new PiConfigActivator(),
    permissionBridge: new PiPermissionBridge({ logger: log }),
  };
}

/**
 * The materialized descriptor catalog and primary-activation state for one
 * generation (Spec 33 §7.2 steps 5-8, 13-14). Kept out of
 * `PiExtensionController`'s own `PiGeneration` type for this task so the
 * task-6 controller contract stays stable; a future task may fold this in.
 *
 * Primary activation (skills + model, together) is deferred from
 * `session_start` to the *first* `before_agent_start` on purpose: Pi only
 * exposes its loaded skill catalog via `systemPromptOptions.skills` at that
 * point (not at `session_start`), and Spec 33 §8.2/§28 requires activation
 * to be atomic across skills and model together - so neither can be
 * committed before both are knowable.
 */
interface PiActiveSession {
  readonly generationId: string;
  readonly primarySession: PiPrimarySession;
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  readonly disabledSkills: readonly string[];
  pendingPrimaryName: string | undefined;
  primaryActivationAttempted: boolean;
  primaryActivationFailure: PiPrimaryActivationError | undefined;
  /**
   * The active, sealed tool-policy plan and its bound permission session for
   * this generation (Spec 33 §12) - both `undefined` when the coverage proof
   * did not succeed this generation. `tool_call` interception is health-only
   * in that case: every governance-relevant name (native-capability-shaped
   * or Weave-owned) blocks rather than falling back to native behavior;
   * only genuinely unrelated third-party tools keep passing through
   * untouched (Spec 33 §12.1, §21).
   */
  readonly toolPolicy: PiToolPolicyPlan | undefined;
  readonly permissionSession: PermissionSession | undefined;
  /**
   * True when the coverage proof itself succeeded (the injected capability
   * prober reported `tool-policy-mapping` as `ok`) but the subsequent
   * mutating registration/activation step failed anyway (Spec 33 §21). The
   * static generation's `healthOnlyMode` cannot reflect this - it was
   * computed from the read-only probe, before this mutation ran - so
   * command gating and health/status output must consult this flag
   * directly rather than trusting `healthOnlyMode` alone.
   */
  readonly permissionActivationFailed: boolean;
}

/** Reads `event.systemPrompt` (Spec 33 §8.3) without assuming any other event shape. */
function readSystemPrompt(event: unknown): string {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Reads `event.systemPromptOptions.skills` (Pi's real, already-loaded skill
 * catalog for this turn - Spec 33 §9.1) without assuming any other shape.
 * Malformed or missing entries are dropped rather than throwing.
 */
function readBeforeAgentStartSkills(event: unknown): readonly PiSkillInfo[] {
  if (typeof event !== "object" || event === null) return [];
  const options = (event as { systemPromptOptions?: unknown })
    .systemPromptOptions;
  if (typeof options !== "object" || options === null) return [];
  const skills = (options as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter(
    (skill): skill is PiSkillInfo =>
      typeof skill === "object" &&
      skill !== null &&
      typeof (skill as { name?: unknown }).name === "string",
  );
}

/**
 * Wraps Pi's real `ExtensionAPI.setModel(model)` (Spec 33 §9.2) so a
 * throwing or rejecting host call never escapes as an unhandled exception -
 * it is captured and reported as a degraded model activation instead.
 */
function createPiModelApplyPort(pi: PiExtensionApi): PiModelApplyPort {
  return {
    applyModel: (model: PiModelInfo) =>
      ResultAsync.fromThrowable(
        async () => {
          const applied = await pi.setModel(model);
          // `setModel` may resolve to `false` without throwing (the host
          // declined the selection) - that is a failed application, not a
          // success, and must not be silently treated as one.
          if (applied === false) {
            throw new Error("Pi declined the model selection");
          }
        },
        (cause): Error =>
          cause instanceof Error ? cause : new Error(String(cause)),
      )(),
  };
}

const APPROVAL_SCOPE_LABELS: Readonly<Record<PiApprovalScope, string>> = {
  once: "Allow once",
  session: "Allow for this session",
  durable: "Allow always for this project",
};
const APPROVAL_REJECT_LABEL = "Reject";

/**
 * Direct parent-TUI approval port (Spec 33 §12.4): prompts `ctx.ui.select`
 * with the sanitized pending-request summaries and maps the chosen label
 * back to a scope choice. A private child instead wraps
 * {@link createChildRelayApprovalPort} with the same request shape - this
 * function is never used for a child call.
 */
function createParentUiApprovalPort(ctx: PiSessionContext): PiApprovalUiPort {
  return {
    promptApproval: async (
      request: PiApprovalPromptRequest,
    ): Promise<PiApprovalChoiceInput | undefined> => {
      const title = `${request.agentName} wants to use "${request.toolIdentity}"`;
      const details = request.requests.map((r) => `- ${r.summary}`).join("\n");
      const options = [
        ...request.allowedScopes.map((scope) => APPROVAL_SCOPE_LABELS[scope]),
        APPROVAL_REJECT_LABEL,
      ];
      const choice = await ctx.ui.select(`${title}\n${details}`, options, {
        timeout: APPROVAL_UI_TIMEOUT_MS,
      });
      if (choice === undefined || choice === APPROVAL_REJECT_LABEL) {
        return { scope: "reject" };
      }
      const scope = request.allowedScopes.find(
        (candidate) => APPROVAL_SCOPE_LABELS[candidate] === choice,
      );
      return scope === undefined ? { scope: "reject" } : { scope };
    },
  };
}

function commandDescription(name: WeaveCommandName): string {
  switch (name) {
    case "weave:start":
      return "Start an explicit Weave plan";
    case "weave:run":
      return "Start a configured Weave workflow";
    case "weave:status":
      return "Show the current Weave adapter and execution status";
    case "weave:abort":
      return "Cancel the active Weave execution and its child tree";
    case "weave:advance":
      return "Apply an explicit user confirmation to the current step";
    case "weave:health":
      return "Show Weave adapter capability and readiness diagnostics";
    case "weave:resume":
      return "Explicitly resume a paused or recoverable execution";
    case "weave:plan":
      return "Show the full read-only plan task tree";
    case "weave:artifact":
      return "Approve or reject a pending artifact revision";
  }
}

function renderHealthOnlyBlockedMessage(name: WeaveCommandName): string {
  return `Weave is in health-only mode; ${name} is unavailable until required capabilities recover. Run /weave:health for details.`;
}

/**
 * A post-preflight permission activation/registration failure must be
 * visible as health-only even when the injected capability prober reported
 * `tool-policy-mapping` as `ok` (Spec 33 §21) - the static generation's
 * `healthOnlyMode` was computed before that mutation ran and cannot reflect
 * it. Command gating and health/status output MUST consult both signals.
 */
function effectiveHealthOnly(
  generation: { readonly healthOnlyMode: boolean; readonly id: string },
  activeSession: PiActiveSession | undefined,
): boolean {
  if (generation.healthOnlyMode) return true;
  if (activeSession === undefined) return false;
  if (activeSession.generationId !== generation.id) return false;
  return activeSession.permissionActivationFailed;
}

function renderHealthMessage(
  controller: PiExtensionController,
  activeSession: PiActiveSession | undefined,
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  const { healthReport } = generation.preflight;
  const lines = healthReport.effectiveCapabilities.map(
    (capability) =>
      `${capability.id}: ${capability.effectiveReadiness} (declared ${capability.declaredReadiness})`,
  );
  const mode = effectiveHealthOnly(generation, activeSession)
    ? "health-only"
    : "ready";
  const result = [`Weave adapter mode: ${mode}`, ...lines];

  if (activeSession?.generationId === generation.id) {
    for (const warning of activeSession.primarySession.getCapabilityWarnings()) {
      result.push(
        `warning [${warning.capability}] ${warning.agentName}: ${warning.detail}`,
      );
    }
    if (activeSession.primaryActivationFailure !== undefined) {
      result.push(
        `primary activation failed: ${activeSession.primaryActivationFailure.type}`,
      );
    }
  }
  return result.join("\n");
}

function renderStatusMessage(
  controller: PiExtensionController,
  activeSession: PiActiveSession | undefined,
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  return [
    `generation: ${generation.id}`,
    `trust: ${generation.preflight.trust}`,
    `mode: ${generation.preflight.mode}`,
    `health-only: ${effectiveHealthOnly(generation, activeSession)}`,
  ].join("\n");
}

/**
 * The one compiled extension entry (Spec 33 §5/§7.1). The returned factory is
 * synchronous and, per Spec 33 §7.1, only: constructs the controller, registers the
 * nine inert `/weave:*` command shells and the lifecycle delegates, and
 * returns. It never loads project config, opens the Runtime Store, starts a
 * timer, or launches a child process at factory time.
 */
export function createPiExtension(
  overrides: Partial<PiExtensionDeps> = {},
): (pi: PiExtensionApi) => void {
  const deps: PiExtensionDeps = {
    ...createDefaultPiExtensionDeps(),
    ...overrides,
  };
  const controllerDeps: PiExtensionControllerDeps = {
    safeInitializer: new PiSafeInitializer({
      hostPackageReader: deps.hostPackageReader,
      capabilityProber: deps.capabilityProber,
      configActivator: deps.configActivator,
      permissionBridge: deps.permissionBridge,
    }),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    logger: deps.logger,
  };
  const controller = new PiExtensionController(controllerDeps);
  let activeSession: PiActiveSession | undefined;

  return function piAdapterExtension(pi: PiExtensionApi): void {
    for (const name of WEAVE_COMMAND_NAMES) {
      pi.registerCommand(name, {
        description: commandDescription(name),
        handler: (_rawArgs: string, ctx: PiSessionContext) => {
          const gate = controller.evaluateCommandGate(name);
          if (gate.isErr()) {
            ctx.ui.notify(gate.error.safeMessage, "error");
            return;
          }
          // A post-preflight permission activation/registration failure
          // (Spec 33 §21) must also block mutating commands, even when the
          // static generation's `healthOnlyMode` (computed from the
          // read-only probe alone) reports `false`.
          const generation = controller.getCurrentGeneration();
          const blockedByPermissionFailure =
            gate.value.classification === "mutating" &&
            generation !== undefined &&
            effectiveHealthOnly(generation, activeSession);
          if (!gate.value.allowed || blockedByPermissionFailure) {
            ctx.ui.notify(renderHealthOnlyBlockedMessage(name), "warning");
            return;
          }
          if (name === "weave:health") {
            ctx.ui.notify(
              renderHealthMessage(controller, activeSession),
              "info",
            );
            return;
          }
          if (name === "weave:status") {
            ctx.ui.notify(
              renderStatusMessage(controller, activeSession),
              "info",
            );
            return;
          }
          if (name === "weave:abort") {
            ctx.ui.notify("No active Weave execution to abort.", "info");
            return;
          }
          ctx.ui.notify(
            `${name} is not yet implemented in this Weave adapter build.`,
            "info",
          );
        },
      });
    }

    pi.on("session_start", async (_event, ctx: PiSessionContext) => {
      const commands = readValidatedCommands(pi);
      if (commands.isErr()) {
        ctx.ui.notify(commands.error.safeMessage, "error");
        return;
      }
      const tools = readValidatedTools(pi);
      if (tools.isErr()) {
        ctx.ui.notify(tools.error.safeMessage, "error");
        return;
      }
      const activation = await controller.activate(
        ctx,
        commands.value,
        tools.value,
      );
      if (activation.isErr()) {
        ctx.ui.notify(activation.error.safeMessage, "error");
        return;
      }
      const generation = activation.value;
      ctx.ui.setStatus(
        "weave",
        generation.healthOnlyMode
          ? "health-only - run /weave:health for details"
          : "ready",
      );

      // Spec 33 §28: wrong mode/host/version blocks config activation
      // entirely - `PiSafeInitializer.preflight` never calls
      // `PiConfigActivator` in that state, so `configActivation` below is
      // always `undefined` here. This check makes that guarantee explicit
      // at the call site too.
      if (
        !generation.preflight.modeSupported ||
        !generation.preflight.hostSupported
      ) {
        return;
      }

      if (generation.preflight.configActivationFailure !== undefined) {
        const failure = generation.preflight.configActivationFailure;
        deps.logger.warn(
          { code: failure.code, safeMessage: failure.safeMessage },
          "config activation failed",
        );
        return;
      }

      const configActivation = generation.preflight.configActivation;
      if (configActivation === undefined) return;

      logMaterializationErrors(
        configActivation.descriptors.errors,
        deps.logger,
      );

      // Registration/activation only proceeds once the sealed tool-policy
      // plan's coverage proof succeeded this generation (Spec 33 §7.2 step
      // 13, §12.1). An incomplete/invalid coverage proof leaves
      // `permissionSession` undefined below - the `tool_call` handler then
      // treats this as health-only for tool policy and BLOCKS every
      // governance-relevant name (Spec 33 §21); it does not fall back to
      // native behavior for those names, only genuinely unrelated
      // third-party tools keep passing through untouched.
      const toolPolicy = generation.preflight.toolPolicy;
      let permissionSession: PermissionSession | undefined;
      // Absent or failed coverage is itself a runtime permission-activation
      // failure - never rely solely on an injected/misbehaving capability
      // prober's optimism. This starts `true` whenever there is no sealed,
      // coverage-proven plan to activate against, and registration/session
      // activation failures below can only add to it, never clear it.
      let permissionActivationFailed =
        toolPolicy === undefined || toolPolicy.coverage.isErr();
      if (toolPolicy?.coverage.isOk()) {
        const registered = deps.permissionBridge.registerWeaveOwnedTools(
          pi,
          [],
        );
        if (registered.isErr()) {
          permissionActivationFailed = true;
          deps.logger.warn(
            { code: registered.error.code },
            "weave-owned tool registration failed; tool policy governance disabled this generation",
          );
        } else {
          const activated = await deps.permissionBridge.activate({
            project: ctx.cwd,
            controllerSession: generation.id,
            plan: toolPolicy,
          });
          if (activated.isErr()) {
            permissionActivationFailed = true;
            deps.logger.warn(
              { code: activated.error.code },
              "permission session activation failed; tool policy governance disabled this generation",
            );
          } else {
            permissionSession = activated.value;
          }
        }
      }

      activeSession = {
        generationId: generation.id,
        primarySession: new PiPrimarySession({
          skillCatalog: new PiSkillCatalog([]),
          logger: deps.logger,
        }),
        descriptors: configActivation.descriptors.byName,
        disabledSkills: configActivation.config.disabled?.skills ?? [],
        pendingPrimaryName: DEFAULT_PRIMARY_AGENT_NAME,
        primaryActivationAttempted: false,
        primaryActivationFailure: undefined,
        toolPolicy,
        permissionSession,
        permissionActivationFailed,
      };

      // The footer status set above (before this activation ran) can go
      // stale the moment registration/activation fails after an otherwise
      // healthy preflight - correct it now so the visible status always
      // reflects the adapter's true effective health for this generation
      // (Spec 33 §21).
      ctx.ui.setStatus(
        "weave",
        effectiveHealthOnly(generation, activeSession)
          ? "health-only - run /weave:health for details"
          : "ready",
      );
    });

    pi.on("tool_call", async (event, ctx: PiSessionContext) => {
      const toolCallEvent = event as PiToolCallEvent;
      const toolIdentity = toolCallEvent.toolName;
      // Structurally always-governance-relevant: Pi's closed native-capability
      // set. A name outside this set is only governance-relevant when this
      // generation's plan explicitly claims it as Weave-owned; every other
      // discovered name is a genuine, unrelated third-party tool (Spec 33
      // §12.1) that must keep its owner's behavior untouched even when we
      // cannot presently govern anything at all.
      const isNativeCapabilityName = Object.hasOwn(
        PI_NATIVE_TOOL_CAPABILITY,
        toolIdentity,
      );

      if (activeSession === undefined) {
        if (isNativeCapabilityName) {
          return { block: true, reason: "tool-policy-unavailable" };
        }
        return undefined;
      }
      const generation = controller.getCurrentGeneration();
      if (activeSession.generationId !== generation?.id) {
        // A stale generation must never silently allow a governed call: the
        // activation this decision would be based on has already been
        // superseded (Spec 33 §7.2's generation-gate re-check applies here
        // exactly as it does after the async approval round-trip below).
        const isGovernanceRelevantStale =
          isNativeCapabilityName ||
          (activeSession.toolPolicy?.weaveOwned.includes(toolIdentity) ??
            false);
        if (isGovernanceRelevantStale) {
          return { block: true, reason: "tool-policy-generation-stale" };
        }
        return undefined;
      }
      const session = activeSession;
      const { permissionSession, toolPolicy } = session;

      if (toolPolicy === undefined) {
        if (isNativeCapabilityName) {
          return { block: true, reason: "tool-policy-unavailable" };
        }
        return undefined;
      }

      const isGovernanceRelevant =
        isNativeCapabilityName || toolPolicy.weaveOwned.includes(toolIdentity);
      if (!isGovernanceRelevant) return undefined;

      // Health-only for tool policy (coverage never activated a session this
      // generation, Spec 33 §21): block every governance-relevant name -
      // never fall back to allow just because governance is unavailable.
      if (permissionSession === undefined) {
        return { block: true, reason: "tool-policy-unavailable" };
      }

      // Overall health-only mode (Spec 33 §21) must disable approval,
      // regardless of why the adapter is health-only - even an unrelated
      // degraded/unsupported capability. A policy-allow call still needs no
      // UI and proceeds normally; only the approval-prompt path is
      // disabled, so an ask-policy call blocks via the existing
      // no-UI-available path rather than opening a dialog while the
      // adapter is otherwise degraded.
      const approvalUiAvailable =
        ctx.hasUI && generation !== undefined
          ? !effectiveHealthOnly(generation, session)
          : false;

      // Recheck authority at the tool boundary (Spec 33 §7.2): capture a
      // staleness handle before the async approval/interception round-trip
      // and assert it is still current afterward. A registry/generation
      // replacement mid-approval must never let a decision computed against
      // a superseded generation take effect.
      const handle = controller.beginOperation();
      if (handle.isErr()) {
        return { block: true, reason: "tool-policy-generation-stale" };
      }

      const agentName =
        session.primarySession.getCurrent()?.descriptor.name ??
        DEFAULT_PRIMARY_AGENT_NAME;
      // `deps.permissionBridge` is an injected dependency - its `intercept`
      // return type promises `ResultAsync<PiToolCallDecision,
      // PiAdapterFailure>`, but a hostile or misbehaving implementation
      // could still return a rejecting promise despite that contract. Wrap
      // the call explicitly rather than let a rejection escape this event
      // handler as an unhandled promise rejection - mapped to the same
      // closed `PiAdapterFailure` shape `intercept()` itself already uses
      // for a genuine internal failure, so there is exactly one downstream
      // error channel to check, not a folded-away one plus a separate
      // always-Ok convention.
      const result = await ResultAsync.fromPromise(
        deps.permissionBridge.intercept({
          session: permissionSession,
          plan: toolPolicy,
          project: ctx.cwd,
          controllerSession: session.generationId,
          agentName,
          toolIdentity,
          call: toolCallEvent.input,
          approvalUiAvailable,
          approvalUi: createParentUiApprovalPort(ctx),
          pi,
        }),
        () => "tool-policy-bridge-rejected",
      ).andThen((decision) => decision);

      if (handle.value.assertStillCurrent().isErr()) {
        return { block: true, reason: "tool-policy-generation-stale" };
      }

      // A genuine `intercept()` failure (rejection at either layer above)
      // blocks - a governance decision is never treated as an allow unless
      // a real decision came back.
      if (result.isErr()) {
        const failure =
          typeof result.error === "string"
            ? makeRequiredCapabilityUnavailableFailure(
                "tool-policy-mapping",
                result.error,
              )
            : result.error;
        deps.logger.warn(
          { code: failure.code },
          "permission bridge intercept failed unexpectedly; blocking",
        );
        return { block: true, reason: "tool-policy-intercept-failed" };
      }
      const outcome = result.value;

      if (outcome.kind === "block" || outcome.kind === "allow-unmanaged") {
        // A governance-relevant name that the bridge itself reports
        // `allow-unmanaged` indicates a plan/session mismatch (e.g. a
        // shadowed native tool) - never treat that as an allow here.
        return outcome.kind === "block"
          ? { block: true, reason: outcome.reason }
          : { block: true, reason: "tool-policy-unexpected-unmanaged" };
      }
      if (
        outcome.kind === "allow" &&
        typeof outcome.call === "object" &&
        outcome.call !== null
      ) {
        // Write back exactly the engine's consumed snapshot - never the
        // caller's own `call` object reference (Spec 34 §8: "Adapters MUST
        // execute only this value").
        for (const key of Object.keys(toolCallEvent.input)) {
          delete toolCallEvent.input[key];
        }
        Object.assign(
          toolCallEvent.input,
          outcome.call as Record<string, unknown>,
        );
      }
      return undefined;
    });

    pi.on("before_agent_start", async (event, ctx: PiSessionContext) => {
      if (activeSession === undefined) return undefined;
      if (
        activeSession.generationId !== controller.getCurrentGeneration()?.id
      ) {
        return undefined;
      }

      const session = activeSession;
      const systemPrompt = readSystemPrompt(event);

      // Already committed this generation: just append. Re-resolving here
      // would silently override a native mid-session user model change
      // (Spec 33 §9.2 "a native user model change governs the current
      // active period"), so activation only happens once per generation.
      if (session.primarySession.getCurrent() !== undefined) {
        return {
          systemPrompt:
            session.primarySession.appendToSystemPrompt(systemPrompt),
        };
      }

      if (session.primaryActivationAttempted) return undefined;
      session.primaryActivationAttempted = true;

      const pendingName = session.pendingPrimaryName;
      if (pendingName === undefined) return undefined;
      const descriptor = session.descriptors.get(pendingName);
      if (descriptor === undefined) {
        deps.logger.warn(
          { agentName: pendingName },
          "default primary descriptor unavailable; ordinary chat has no active Weave primary",
        );
        return undefined;
      }

      // Pi only exposes its loaded skill catalog here, at the first turn
      // (Spec 33 §9.1) - refresh the catalog immediately before the
      // atomic activation that depends on it.
      session.primarySession.refreshSkills(readBeforeAgentStartSkills(event));

      // Capture a staleness handle *before* the await below: activation
      // (including `pi.setModel`) can take an arbitrary amount of time, and
      // a session replacement (reload/fork/switch/new session_start) can
      // install a fresh generation and a fresh `activeSession` while this
      // call is still in flight.
      const operation = controller.beginOperation();
      if (operation.isErr()) return undefined;
      const handle = operation.value;

      // `ctx.modelRegistry` is host-supplied; a throwing `getAvailable()`
      // must not crash this turn - fall back to an empty catalog, which
      // safely degrades model resolution rather than failing activation.
      const availableModelsResult = safelyListAvailableModels(
        ctx.modelRegistry,
      );
      if (availableModelsResult.isErr()) {
        // `availableModelsResult.error` is always the fixed, closed-set
        // `MODEL_REGISTRY_THREW_REASON` literal - never anything derived
        // from what the host actually threw, since that content cannot be
        // trusted not to contain private paths, environment values, or
        // secrets (Spec 33 closed-failure contract).
        deps.logger.warn(
          {
            agentName: descriptor.name,
            reason: availableModelsResult.error,
          },
          "ctx.modelRegistry.getAvailable() threw; treating as no available models this turn",
        );
      }

      const activationResult = await session.primarySession.activate(
        descriptor,
        {
          availableModels: availableModelsResult.unwrapOr([]),
          currentModel: ctx.model,
          modelApplier: createPiModelApplyPort(pi),
          disabledSkills: session.disabledSkills,
        },
      );

      if (handle.assertStillCurrent().isErr()) {
        // A newer generation replaced this one while we were awaiting
        // skill/model activation. `pi.setModel` may already have been
        // applied against a session that is no longer current and cannot
        // safely be undone - surface that as a visible degradation rather
        // than silently dropping it, but never return this stale call's
        // descriptor prompt as authoritative for the new generation.
        if (activationResult.isOk()) {
          deps.logger.warn(
            { agentName: descriptor.name, generationId: session.generationId },
            "primary activation settled after session replacement; discarding stale authority (a model change may already be applied and cannot be safely restored)",
          );
        }
        return undefined;
      }

      if (activationResult.isErr()) {
        session.primaryActivationFailure = activationResult.error;
        deps.logger.warn(
          { agentName: descriptor.name, error: activationResult.error.type },
          "primary activation failed; prompt not appended this turn",
        );
        return undefined;
      }

      return {
        systemPrompt: session.primarySession.appendToSystemPrompt(systemPrompt),
      };
    });

    pi.on("session_shutdown", () => {
      activeSession = undefined;
      controller.shutdown();
    });
  };
}

export default createPiExtension();
