/**
 * Concrete Pi registered-tool policy enforcement (Spec 33 §12, Spec 34).
 *
 * `PiPermissionBridge` is the adapter-owned counterpart to the engine's
 * harness-neutral permission subsystem. It:
 *
 * - builds and seals a `PermissionRegistryGeneration` from a discovered Pi
 *   tool inventory (pure, no Pi mutation) and proves complete coverage via
 *   `verifyPermissionCoverage` (`planToolPolicy`);
 * - performs the *only* mutating step - registering Weave-owned tools with
 *   Pi after proving their names are free and re-verifying provenance
 *   (`registerWeaveOwnedTools`);
 * - activates a `PermissionSession` bound to that sealed registry
 *   (`activate`);
 * - is the single authoritative interception path for every governed tool
 *   call: resolve/evaluate/approve/permit/consume, or unmanaged passthrough
 *   for anything outside the sealed registry (`intercept`).
 *
 * Unregistered third-party tools are reported `unmanaged`: the bridge never
 * calls the engine for them, never blocks them, and never issues a permit.
 *
 * Nothing in this module logs or persists raw call inputs, constraints,
 * approval material, secrets, or tool results - only closed-set identifiers
 * (agent name, tool identity, outcome/error kind) ever reach the logger.
 *
 * @see docs/adapter-boundary.md
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md (Spec 33 §12)
 * @see docs/specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md
 */

import {
  createInMemoryRuntimeStore,
  createPermissionService,
  type EffectiveToolPolicy,
  type PermissionCallInput,
  type PermissionChallengeConsumeInput,
  type PermissionCoverageContext,
  type PermissionCoverageError,
  type PermissionCoverageProof,
  type PermissionError,
  type PermissionOutcome,
  type PermissionPermitConsumeInput,
  PermissionRegistryBuilder,
  type PermissionRegistryGeneration,
  type PermissionResolver,
  type PermissionSession,
  type RuntimeStore,
  verifyPermissionCoverage,
} from "@weaveio/weave-engine";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { isGenuineBuiltinSourceInfo, isOwnSourceInfo } from "./commands.js";
import {
  makeInvariantViolationFailure,
  makeRequiredCapabilityUnavailableFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  buildNativeToolResolver,
  classifyDiscoveredTools,
  PI_NATIVE_TOOL_CAPABILITY,
} from "./tool-governance.js";
import type {
  PiAdapterLogger,
  PiExtensionApi,
  PiToolInfo,
  PiToolRegistration,
} from "./types.js";

/**
 * Bounded approval prompt timeout, passed through to Pi's own
 * `ExtensionUIDialogOptions.timeout` (`dist/core/extensions/types.d.ts`).
 * Pi auto-dismisses the dialog (resolving `undefined`, the same signal as an
 * explicit user cancel) once this elapses, with a live countdown display.
 * Kept comfortably under the engine's own 5-minute challenge expiry so the
 * UI always resolves before the engine would have expired the challenge
 * out from under it.
 */
export const APPROVAL_UI_TIMEOUT_MS = 270_000;

/** A durable-grant-eligible approval scope offered to the user. */
export type PiApprovalScope = "once" | "session" | "durable";

/** The user's response to an approval prompt for one governed call. */
export type PiApprovalChoiceInput =
  | { readonly scope: PiApprovalScope; readonly expiresAt?: number }
  | { readonly scope: "reject" };

/** A single pending request rendered for an approval prompt. Sanitized display only. */
export interface PiApprovalPendingRequestView {
  readonly summary: string;
  readonly details?: string;
  readonly unresolved: boolean;
}

/** A full approval prompt for one governed tool call, possibly with several pending requests. */
export interface PiApprovalPromptRequest {
  readonly agentName: string;
  readonly toolIdentity: string;
  readonly requests: readonly PiApprovalPendingRequestView[];
  /** Restricted to `["once"]` when any pending request is unresolved (Spec 34 §5.1). */
  readonly allowedScopes: readonly PiApprovalScope[];
}

/**
 * Adapter-owned approval UI port. A direct parent-TUI implementation prompts
 * `ctx.ui` directly; a private-child session instead wraps
 * {@link PiChildApprovalRelayPort} via {@link createChildRelayApprovalPort}
 * so `intercept()` never needs to know whether it is governing a parent or
 * child call. `undefined` means cancelled or unavailable - always a
 * reject-equivalent, never an implicit choice.
 */
export interface PiApprovalUiPort {
  promptApproval(
    request: PiApprovalPromptRequest,
  ): Promise<PiApprovalChoiceInput | undefined>;
}

/**
 * Injected port a private child session uses to relay an approval prompt to
 * the sole parent TUI, preserving the child's identity (`childId`) in the
 * relay call. This is a port shape only - task 9 supplies the real private
 * control-channel transport; this task proves the abstraction and identity
 * preservation via fakes.
 */
export interface PiChildApprovalRelayPort {
  relay(
    childId: string,
    request: PiApprovalPromptRequest,
  ): Promise<PiApprovalChoiceInput | undefined>;
}

/** Wraps a child relay port + child identity into a plain {@link PiApprovalUiPort}. */
export function createChildRelayApprovalPort(
  relay: PiChildApprovalRelayPort,
  childId: string,
): PiApprovalUiPort {
  return {
    promptApproval: (request) => relay.relay(childId, request),
  };
}

/**
 * Registration input for a Weave-owned governed tool (Spec 33 §12.2). The
 * `resolver` is supplied by the caller and is the sole authority over what
 * a given call authorizes - this bridge never synthesizes a generic
 * resolver on the caller's behalf, so distinct calls only ever share a
 * grant when the caller's own resolver intentionally maps them to the same
 * normalized request (Spec 34 §5).
 */
export interface PiWeaveToolRegistration {
  readonly tool: PiToolRegistration;
  readonly owner: string;
  readonly revision: string;
  readonly summary: string;
  readonly details?: string;
  readonly resolver: PermissionResolver;
}

/** The sealed, coverage-proven tool-policy plan for one controller generation. */
export interface PiToolPolicyPlan {
  readonly registry: PermissionRegistryGeneration;
  /** Every discovered name matching a native capability, regardless of provenance (the required set). */
  readonly native: readonly string[];
  /** Subset of `native` genuinely built-in-sourced, registered, and intercepted. */
  readonly verifiedNative: readonly string[];
  readonly weaveOwned: readonly string[];
  readonly unmanaged: readonly string[];
  readonly policies: Readonly<Record<string, EffectiveToolPolicy>>;
  readonly coverage: Result<PermissionCoverageProof, PermissionCoverageError>;
}

/** Outcome of intercepting one governed tool call. Never throws to produce this. */
export type PiToolCallDecision =
  | { readonly kind: "allow-unmanaged" }
  | { readonly kind: "allow"; readonly call: unknown }
  | { readonly kind: "block"; readonly reason: string };

export interface PiPermissionBridgeDeps {
  /**
   * A genuinely durable `RuntimeStore` (e.g. the SQLite-backed store task 11
   * activates for a trusted project). When omitted, this bridge falls back
   * to an in-memory store for the constructor's convenience, but NEVER
   * offers `"durable"` as an approval scope in that case - advertising
   * project-durable persistence backed only by process memory would be
   * dishonest to the user. Tests that want to exercise the durable-grant
   * code path should inject `createInMemoryRuntimeStore()` explicitly here
   * as a fake durable repository; that is a deliberate test choice, not the
   * bridge's own default.
   */
  readonly runtimeStore?: RuntimeStore;
  readonly logger: PiAdapterLogger;
}

/** Bounded, closed-set reasons only - never raw call/display/constraint content. */
function permissionErrorReason(error: PermissionError): string {
  return `permission-error:${error.type}`;
}

function coverageErrorReason(error: PermissionCoverageError): string {
  if (error.type === "incomplete_coverage") {
    return `tool-policy-coverage-incomplete:${error.reason}`;
  }
  return "tool-policy-coverage-invalid";
}

export class PiPermissionBridge {
  private store: RuntimeStore;
  private readonly logger: PiAdapterLogger;
  /**
   * True only when activation has a caller-supplied durable Runtime Store.
   * Gates whether `"durable"` is ever offered as an approval scope.
   */
  private durableCapable: boolean;

  constructor(deps: PiPermissionBridgeDeps) {
    this.durableCapable = deps.runtimeStore !== undefined;
    this.store = deps.runtimeStore ?? createInMemoryRuntimeStore();
    this.logger = deps.logger;
  }

  /**
   * Pure, read-only planning step (Spec 33 §7.2 step 9): classifies the
   * discovered tool inventory, seals a candidate registry (native governed
   * tools + the caller's desired Weave-owned tools), and proves complete
   * coverage. Performs no Pi mutation and no `pi.registerTool()` calls.
   */
  planToolPolicy(input: {
    readonly allTools: readonly PiToolInfo[];
    readonly weaveOwnedRegistrations: readonly PiWeaveToolRegistration[];
    readonly policies: Readonly<Record<string, EffectiveToolPolicy>>;
    readonly diagnostics?: { readonly includeToolIdentities: boolean };
  }): Result<PiToolPolicyPlan, PiAdapterFailure> {
    const weaveOwnedNames = input.weaveOwnedRegistrations.map(
      (r) => r.tool.name,
    );
    const classification = classifyDiscoveredTools(
      input.allTools,
      weaveOwnedNames,
    );

    const builder = new PermissionRegistryBuilder();
    // Only genuinely built-in-sourced entries are registered and claimed as
    // intercepted. A name matching a native capability but shadowed by a
    // foreign extension is never registered here, so `verifyPermissionCoverage`
    // reports `missing_registration` for it below instead of silently
    // treating a shadowed name as Pi-native (Spec 33 §7.1, §12.1).
    for (const name of classification.verifiedNative) {
      const capability = PI_NATIVE_TOOL_CAPABILITY[name];
      if (capability === undefined) continue;
      const registered = builder.register({
        toolIdentity: name,
        owner: "pi-native",
        revision: "1",
        summary: `${name} (Pi built-in)`,
        resolver: buildNativeToolResolver(name, capability),
      });
      if (registered.isErr()) {
        return err(
          makeInvariantViolationFailure(
            `native-tool-registration-failed:${registered.error.type}`,
          ),
        );
      }
    }
    for (const registration of input.weaveOwnedRegistrations) {
      const registered = builder.register({
        toolIdentity: registration.tool.name,
        owner: registration.owner,
        revision: registration.revision,
        summary: registration.summary,
        // Only present the `details` key at all when a value was actually
        // supplied - an explicit `details: undefined` own-property is
        // treated by the engine's registration validator as an invalid
        // (non-string) details field, not as "omitted".
        ...(registration.details === undefined
          ? {}
          : { details: registration.details }),
        // Authoritative, caller-supplied resolver (Spec 34 §4/§5) - this
        // bridge never synthesizes a generic resolver on the registration's
        // behalf, so distinct calls only share a grant when the caller's own
        // resolver intentionally maps them to the same normalized request.
        resolver: registration.resolver,
      });
      if (registered.isErr()) {
        return err(
          makeInvariantViolationFailure(
            `weave-tool-registration-failed:${registered.error.type}`,
          ),
        );
      }
    }

    const sealed = builder.seal();
    if (sealed.isErr()) {
      return err(
        makeInvariantViolationFailure(
          `tool-registry-seal-failed:${sealed.error.type}`,
        ),
      );
    }
    const registry = sealed.value;

    const coverageContext: PermissionCoverageContext = {
      registry,
      nativeToolIdentities: classification.native,
      weaveOwnedToolIdentities: classification.weaveOwned,
      interceptedToolIdentities: [
        ...classification.verifiedNative,
        ...classification.weaveOwned,
      ],
      bypassableToolIdentities: [],
      unmanagedThirdPartyToolIdentities: classification.unmanaged,
      diagnostics: input.diagnostics ?? { includeToolIdentities: false },
    };
    const coverage = verifyPermissionCoverage(coverageContext);
    if (coverage.isErr()) {
      this.logger.warn(
        { reason: coverageErrorReason(coverage.error) },
        "tool-policy coverage incomplete",
      );
    }

    return ok({
      registry,
      native: classification.native,
      verifiedNative: classification.verifiedNative,
      weaveOwned: classification.weaveOwned,
      unmanaged: classification.unmanaged,
      policies: input.policies,
      coverage,
    });
  }

  /**
   * The only mutating step (Spec 33 §7.1, §7.2 step 13): registers each
   * Weave-owned tool with Pi only after proving its name is free, then
   * immediately re-reads `getAllTools()` to verify this package's
   * `sourceInfo` owns the new entry before treating it as governed.
   *
   * Registration is one-way: Pi's public API has no `unregisterTool()` or
   * registration receipt (`docs/extensions.md`, `dist/core/extensions/types.d.ts`
   * - `registerTool()` returns `void`). If a later registration in this
   * batch fails its name-free preflight or its post-registration provenance
   * check, any tool already mutated into Pi's live table by an earlier
   * registration in this same batch CANNOT be undone - there is no rollback.
   * This method never claims such a partially-mutated batch as covered:
   * on any single failure it returns `Err`, the caller must not activate
   * governance for this generation, and the plan's coverage proof will
   * independently fail to report the unverified name(s) as registered.
   */
  registerWeaveOwnedTools(
    pi: Pick<PiExtensionApi, "registerTool" | "getAllTools">,
    registrations: readonly PiWeaveToolRegistration[],
  ): Result<readonly string[], PiAdapterFailure> {
    if (registrations.length === 0) return ok([]);

    const before = Result.fromThrowable(
      () => pi.getAllTools(),
      () =>
        makeRequiredCapabilityUnavailableFailure(
          "tool-policy-mapping",
          "get-all-tools-threw",
        ),
    )();
    if (before.isErr()) return err(before.error);

    for (const registration of registrations) {
      const collision = before.value.find(
        (tool) => tool.name === registration.tool.name,
      );
      if (collision !== undefined) {
        return err(
          makeRequiredCapabilityUnavailableFailure(
            "tool-policy-mapping",
            `tool-name-not-free:${registration.tool.name}`,
          ),
        );
      }
    }

    // Best-effort: `registerTool()` gives no receipt, so a thrown call does
    // not prove the tool was *not* registered - only the post-state re-read
    // below is authoritative. We still attempt every registration rather
    // than aborting the batch on the first throw, since aborting would not
    // undo anything already mutated either.
    for (const registration of registrations) {
      const attempt = Result.fromThrowable(
        () => pi.registerTool(registration.tool),
        () => registration.tool.name,
      )();
      if (attempt.isErr()) {
        this.logger.warn(
          { toolIdentity: attempt.error },
          "registerTool threw; post-registration provenance check is authoritative",
        );
      }
    }

    const after = Result.fromThrowable(
      () => pi.getAllTools(),
      () =>
        makeRequiredCapabilityUnavailableFailure(
          "tool-policy-mapping",
          "get-all-tools-threw",
        ),
    )();
    if (after.isErr()) return err(after.error);

    const verified: string[] = [];
    for (const registration of registrations) {
      const matches = after.value.filter(
        (tool) => tool.name === registration.tool.name,
      );
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (entry === undefined || !isOwnSourceInfo(entry.sourceInfo)) {
        return err(
          makeRequiredCapabilityUnavailableFailure(
            "tool-policy-mapping",
            `tool-provenance-unverified:${registration.tool.name}`,
          ),
        );
      }
      verified.push(entry.name);
    }
    return ok(verified);
  }

  /**
   * Activates a `PermissionSession` bound to the plan's sealed registry.
   * Production passes the trusted project's opened Runtime Store here so
   * durable grants use the same durable repository as workflow state. The
   * constructor store remains the isolated-test and pre-runtime fallback.
   */
  activate(input: {
    readonly project: string;
    readonly controllerSession: string;
    readonly plan: PiToolPolicyPlan;
    readonly runtimeStore?: RuntimeStore;
  }): ResultAsync<PermissionSession, PiAdapterFailure> {
    if (input.runtimeStore !== undefined) {
      this.store = input.runtimeStore;
      this.durableCapable = true;
    }
    const service = createPermissionService(this.store);
    return ResultAsync.fromPromise(
      service.activate({
        project: input.project,
        controllerSession: input.controllerSession,
        registry: input.plan.registry,
        policies: input.plan.policies,
        requestSchemaVersion: "1",
      }),
      () =>
        makeRequiredCapabilityUnavailableFailure(
          "tool-policy-mapping",
          "permission-session-activate-threw",
        ),
    ).andThen((result) => {
      if (result.isErr()) {
        this.logger.warn(
          { reason: permissionErrorReason(result.error) },
          "permission session activation failed",
        );
        return err(
          makeRequiredCapabilityUnavailableFailure(
            "tool-policy-mapping",
            "permission-session-activate-failed",
          ),
        );
      }
      return ok(result.value);
    });
  }

  /**
   * The single authoritative interception path for a governed tool call
   * (Spec 33 §12.1). Never rejects - every failure resolves to
   * `{ kind: "block" }` with a bounded, closed-set reason. Unmanaged tools
   * never reach the engine at all and never receive a permit.
   *
   * Re-reads and re-validates the live tool inventory for this exact
   * `toolIdentity` before ever calling the engine (Spec 33 §7.2, §12.1) -
   * a name that was genuinely native or Weave-owned at plan time but has
   * since been displaced (a foreign extension registered over it after
   * activation) blocks here rather than silently authorizing against a
   * provenance the host no longer honors.
   */
  intercept(input: {
    readonly session: PermissionSession;
    readonly plan: PiToolPolicyPlan;
    readonly project: string;
    readonly controllerSession: string;
    readonly agentName: string;
    readonly toolIdentity: string;
    readonly call: unknown;
    readonly approvalUiAvailable: boolean;
    readonly approvalUi: PiApprovalUiPort;
    readonly pi: Pick<PiExtensionApi, "getAllTools">;
  }): ResultAsync<PiToolCallDecision, PiAdapterFailure> {
    const isVerifiedNative = input.plan.verifiedNative.includes(
      input.toolIdentity,
    );
    const isWeaveOwned = input.plan.weaveOwned.includes(input.toolIdentity);
    if (!isVerifiedNative && !isWeaveOwned) {
      return ResultAsync.fromSafePromise(
        Promise.resolve({ kind: "allow-unmanaged" } as const),
      );
    }

    const revalidated = this.revalidateProvenance(
      input.pi,
      input.toolIdentity,
      isVerifiedNative ? "native" : "weave-owned",
    );
    if (revalidated.isErr()) {
      this.logger.warn(
        { reason: revalidated.error },
        "tool provenance changed since activation; blocking",
      );
      return ResultAsync.fromSafePromise(
        Promise.resolve({ kind: "block", reason: revalidated.error } as const),
      );
    }

    const callInput: PermissionCallInput = {
      project: input.project,
      session: input.controllerSession,
      agentName: input.agentName,
      toolIdentity: input.toolIdentity,
      registryGeneration: input.plan.registry.id,
      call: input.call,
      approvalUiAvailable: input.approvalUiAvailable,
    };

    // `runIntercept` never throws by construction, but `input.session` and
    // `input.approvalUi` are caller-injected ports - a hostile or buggy
    // implementation could still reject the promise it returns. Wrap the
    // rejection explicitly with neverthrow rather than letting it escape as
    // an unhandled rejection through the `tool_call` event handler. This is
    // a genuine operational failure, not a policy decision - it surfaces as
    // a real `Err(PiAdapterFailure)` rather than being folded into a
    // synthetic `Ok({kind:"block"})`, so the error channel stays honest and
    // callers block on it explicitly instead of inspecting an
    // always-succeeds type.
    return ResultAsync.fromPromise(
      this.runIntercept(input.session, callInput, input.approvalUi),
      () => "intercept-rejected" as const,
    ).mapErr((reason) => {
      this.logger.warn({ reason }, "intercept rejected unexpectedly; blocking");
      return makeRequiredCapabilityUnavailableFailure(
        "tool-policy-mapping",
        reason,
      );
    });
  }

  /**
   * Re-reads `getAllTools()` right now and re-checks this exact tool's
   * provenance against its expected ownership. Pure defense-in-depth
   * against post-activation displacement (Spec 33 §7.2's generation-gate
   * re-check requirement, applied per registered tool call rather than only
   * at session start).
   */
  private revalidateProvenance(
    pi: Pick<PiExtensionApi, "getAllTools">,
    toolIdentity: string,
    expectedOwnership: "native" | "weave-owned",
  ): Result<void, string> {
    const read = Result.fromThrowable(
      () => pi.getAllTools(),
      () => "tool-inventory-read-threw",
    )();
    if (read.isErr()) return err(read.error);
    const matches = read.value.filter((tool) => tool.name === toolIdentity);
    if (matches.length !== 1) return err("tool-inventory-ambiguous-or-missing");
    const entry = matches[0];
    const ownershipVerified =
      expectedOwnership === "native"
        ? isGenuineBuiltinSourceInfo(entry.sourceInfo, toolIdentity)
        : isOwnSourceInfo(entry.sourceInfo);
    if (!ownershipVerified) return err("tool-provenance-changed");
    return ok(undefined);
  }

  private async runIntercept(
    session: PermissionSession,
    callInput: PermissionCallInput,
    approvalUi: PiApprovalUiPort,
  ): Promise<PiToolCallDecision> {
    const outcomeResult = await session.authorizeCall(callInput);
    if (outcomeResult.isErr()) {
      this.logger.warn(
        { reason: permissionErrorReason(outcomeResult.error) },
        "tool call authorization failed",
      );
      return {
        kind: "block",
        reason: permissionErrorReason(outcomeResult.error),
      };
    }

    const outcome = outcomeResult.value;
    if (outcome.kind === "unmanaged") {
      // The bridge never calls authorizeCall for a tool it did not just
      // classify as governed, so this indicates a plan/session mismatch.
      this.logger.warn({}, "unexpected unmanaged outcome for governed call");
      return { kind: "block", reason: "unexpected-unmanaged-outcome" };
    }
    if (outcome.kind === "denied") {
      return { kind: "block", reason: "policy-denied" };
    }
    if (outcome.kind === "authorized") {
      return this.consume(session, callInput, outcome.permit);
    }

    return this.approve(session, callInput, outcome, approvalUi);
  }

  /**
   * Unresolved requests only ever permit a once-only approval (Spec 34
   * §5.1); "durable" is only ever offered when this bridge was constructed
   * with an explicitly injected durable-capable `RuntimeStore` (Spec 34 §7
   * boundary note, see `PiPermissionBridgeDeps.runtimeStore`).
   */
  private approvalScopesFor(
    anyUnresolved: boolean,
  ): readonly PiApprovalScope[] {
    if (anyUnresolved) return ["once"];
    if (this.durableCapable) return ["once", "session", "durable"];
    return ["once", "session"];
  }

  private async approve(
    session: PermissionSession,
    callInput: PermissionCallInput,
    outcome: Extract<PermissionOutcome, { kind: "approval_required" }>,
    approvalUi: PiApprovalUiPort,
  ): Promise<PiToolCallDecision> {
    // Explicit source+reason check (Spec 34 §6): the engine sets
    // `source: "resolver"` exactly when `reason === "unresolved_request"`,
    // but this checks both fields rather than relying on one alone.
    const isUnresolvedRequest = (
      r: (typeof outcome.requests)[number],
    ): boolean => r.source === "resolver" && r.reason === "unresolved_request";
    const anyUnresolved = outcome.requests.some(isUnresolvedRequest);
    const allowedScopes = this.approvalScopesFor(anyUnresolved);

    const promptRequest: PiApprovalPromptRequest = {
      agentName: callInput.agentName,
      toolIdentity: callInput.toolIdentity,
      requests: outcome.requests.map((r) => ({
        summary: r.display.summary,
        details: r.display.details,
        unresolved: isUnresolvedRequest(r),
      })),
      allowedScopes,
    };

    if (!callInput.approvalUiAvailable) {
      const cancel = await session.cancelChallenge({
        challenge: outcome.challenge,
        project: callInput.project,
        session: callInput.session,
        agentName: callInput.agentName,
        toolIdentity: callInput.toolIdentity,
        registryGeneration: callInput.registryGeneration,
      });
      if (cancel.isErr()) {
        this.logger.warn(
          { reason: permissionErrorReason(cancel.error) },
          "approval cancellation failed",
        );
      }
      return { kind: "block", reason: "approval-ui-unavailable" };
    }

    const choice = await approvalUiPromptSafely(
      approvalUi,
      promptRequest,
      this.logger,
    );
    if (choice === undefined || choice.scope === "reject") {
      const cancelInput: PermissionChallengeConsumeInput = {
        challenge: outcome.challenge,
        project: callInput.project,
        session: callInput.session,
        agentName: callInput.agentName,
        toolIdentity: callInput.toolIdentity,
        registryGeneration: callInput.registryGeneration,
      };
      const cancel = await session.cancelChallenge(cancelInput);
      if (cancel.isErr()) {
        this.logger.warn(
          { reason: permissionErrorReason(cancel.error) },
          "approval cancellation failed",
        );
      }
      return { kind: "block", reason: "approval-cancelled-or-rejected" };
    }

    if (!allowedScopes.includes(choice.scope)) {
      const cancel = await session.cancelChallenge({
        challenge: outcome.challenge,
        project: callInput.project,
        session: callInput.session,
        agentName: callInput.agentName,
        toolIdentity: callInput.toolIdentity,
        registryGeneration: callInput.registryGeneration,
      });
      if (cancel.isErr()) {
        this.logger.warn(
          { reason: permissionErrorReason(cancel.error) },
          "approval cancellation failed",
        );
      }
      return { kind: "block", reason: "approval-scope-not-permitted" };
    }

    const answered = await session.answerChallenge(
      {
        challenge: outcome.challenge,
        project: callInput.project,
        session: callInput.session,
        agentName: callInput.agentName,
        toolIdentity: callInput.toolIdentity,
        registryGeneration: callInput.registryGeneration,
      },
      {
        challenge: outcome.challenge,
        choices: outcome.requests.map((r) => ({
          requestId: r.requestId,
          decision: "allow" as const,
          scope: choice.scope,
          expiresAt: choice.expiresAt,
        })),
      },
    );
    if (answered.isErr()) {
      this.logger.warn(
        { reason: permissionErrorReason(answered.error) },
        "approval answer failed",
      );
      return { kind: "block", reason: permissionErrorReason(answered.error) };
    }
    if (answered.value.kind !== "authorized") {
      return { kind: "block", reason: "approval-not-authorized" };
    }
    return this.consume(session, callInput, answered.value.permit);
  }

  private async consume(
    session: PermissionSession,
    callInput: PermissionCallInput,
    permit: string,
  ): Promise<PiToolCallDecision> {
    const permitInput: PermissionPermitConsumeInput = {
      permit,
      project: callInput.project,
      session: callInput.session,
      agentName: callInput.agentName,
      toolIdentity: callInput.toolIdentity,
      registryGeneration: callInput.registryGeneration,
      call: callInput.call,
    };
    const consumed = await session.consumePermit(permitInput);
    if (consumed.isErr()) {
      this.logger.warn(
        { reason: permissionErrorReason(consumed.error) },
        "permit consumption failed",
      );
      return { kind: "block", reason: permissionErrorReason(consumed.error) };
    }
    return { kind: "allow", call: consumed.value };
  }
}

async function approvalUiPromptSafely(
  approvalUi: PiApprovalUiPort,
  request: PiApprovalPromptRequest,
  logger: PiAdapterLogger,
): Promise<PiApprovalChoiceInput | undefined> {
  const result = await ResultAsync.fromPromise(
    approvalUi.promptApproval(request),
    () => "approval-ui-threw" as const,
  );
  if (result.isErr()) {
    logger.warn({ reason: result.error }, "approval UI prompt threw");
    return undefined;
  }
  return result.value;
}
