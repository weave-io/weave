import type {
  AdapterCapabilityContract,
  AdapterHealthReport,
  AgentDescriptor,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { buildAdapterHealthReport } from "@weaveio/weave-engine";
import { err, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "./capability-declarations.js";
import {
  buildBlockedProbeSet,
  type PiCandidatePlanContext,
  type PiCapabilityProbeSource,
  sanitizeCapabilityProbeResults,
} from "./capability-prober.js";
import type {
  PiConfigActivationResult,
  PiConfigActivator,
} from "./config-activator.js";
import {
  makeActivationFailedFailure,
  makeInvariantViolationFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  type HostPackageInfo,
  type HostPackageReader,
} from "./host-compatibility.js";
import { PiModelResolver } from "./model-resolution.js";
import {
  isDirectoryContainmentSafeWith,
  NullPathContainmentPort,
  type PathContainmentPort,
} from "./path-containment.js";
import type {
  PiToolPolicyPlan,
  PiWeaveToolRegistration,
} from "./permission-bridge.js";
import { PiPermissionBridge } from "./permission-bridge.js";
import {
  safelyAwaitPortResult,
  safelyListAvailableModels,
} from "./port-safety.js";
import { DEFAULT_PRIMARY_AGENT_NAME } from "./primary-session.js";
import type {
  PiAdapterLogger,
  PiCommandInfo,
  PiMode,
  PiModelRegistry,
  PiSessionContext,
  PiToolInfo,
  PiTrustState,
} from "./types.js";

/** Silent default logger used only when no `permissionBridge` is injected. */
const noopLogger: PiAdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Reduces a `planToolPolicy` result to the bounded `toolPolicyCoverage` fact
 * the capability prober needs - never raises a declared ceiling.
 */
function toolPolicyCoverageFromPlan(
  planned: Result<PiToolPolicyPlan, PiAdapterFailure>,
): "ok" | { reason: string } {
  if (planned.isErr()) return { reason: "tool-policy-plan-failed" };
  if (planned.value.coverage.isOk()) return "ok";
  return { reason: coverageFailureReason(planned.value.coverage.error) };
}

/**
 * Result of the read-only preflight sequence (Spec 33 §7.2, steps 2-11).
 * Never mutates harness state, opens the Runtime Store, starts a timer, or
 * launches a process. `healthOnlyMode` is a *computed fact*, not a
 * rejection of activation - `preflight` still succeeds (returns `Ok`) when
 * the adapter must enter health-only mode. `preflight` only returns `Err`
 * for a genuine internal invariant violation (e.g. an injected prober
 * throwing).
 *
 * Withheld project trust always forces `healthOnlyMode: true` (fail
 * closed), even when every probe -- including the narrow
 * `project-trust-withheld` `ok` status for project-path-dependent
 * capabilities (Spec 33 §7.3) -- reports success. That narrow `ok` proves
 * only that project-path access was correctly withheld; it never proves the
 * underlying capability is usable, so it MUST NOT be able to promote the
 * adapter into a ready (non-health-only) state while trust is absent.
 *
 * `configActivation` is `undefined` when config activation never ran
 * (mode/host blocked - Spec 33 §28 "wrong mode/host/version -\> health-only"
 * means config is never loaded/materialized). `configActivationFailure` is
 * set instead when activation was attempted but the config itself failed to
 * load/parse. Callers (e.g. `extension.ts`'s `session_start`) reuse this
 * single computed result rather than calling `PiConfigActivator` again.
 */
export interface PiPreflightResult {
  readonly mode: PiMode;
  readonly modeSupported: boolean;
  readonly host?: HostPackageInfo;
  readonly hostSupported: boolean;
  readonly trust: PiTrustState;
  readonly configActivation?: PiConfigActivationResult;
  readonly configActivationFailure?: PiAdapterFailure;
  /**
   * Sealed, coverage-proven tool-policy plan (Spec 33 §7.2 step 9, §12),
   * computed once here and reused unchanged at real activation - `undefined`
   * only when it never ran (mode/host blocked or config activation failed).
   */
  readonly toolPolicy?: PiToolPolicyPlan;
  /**
   * The exact Weave-owned registrations threaded into `toolPolicy`'s
   * coverage proof above (Spec 33 §11.1) - `extension.ts` MUST reuse this
   * identical array at real registration time (`registerWeaveOwnedTools`)
   * rather than recomputing a different one, or the sealed coverage proof
   * would no longer describe what was actually registered.
   */
  readonly weaveOwnedRegistrations: readonly PiWeaveToolRegistration[];
  readonly healthReport: AdapterHealthReport;
  readonly healthOnlyMode: boolean;
}

export interface PiSafeInitializerDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly configActivator: PiConfigActivator;
  readonly permissionBridge?: PiPermissionBridge;
  readonly capabilityContract?: AdapterCapabilityContract;
  /**
   * Caller-supplied builder for the ordinary-delegation Weave-owned tool
   * (Spec 33 §11.1) - mirrors the existing caller-supplied-resolver pattern
   * so this foundational module never depends on the concrete delegation
   * controller. Receives the eligible default-primary descriptor and the
   * successful config activation; returns zero or one registrations. Not
   * called at all when there is no eligible primary this generation.
   */
  readonly buildDelegationToolRegistrations?: (
    primary: AgentDescriptor,
    activation: PiConfigActivationResult,
  ) => readonly PiWeaveToolRegistration[];
  /**
   * Real, no-follow-safe containment proof for `.weave/runtime`/`.weave/plans`
   * (Spec 33 §18, §21, §28) - gates `workflow-persistence`/
   * `workflow-step-dispatch`/`plan-file-compatibility` on more than
   * `configLoaded`. Defaults to `NullPathContainmentPort` (always
   * fail-closed, never spawns a process) so omitting this dependency never
   * silently promotes those capabilities to `ok` and no test accidentally
   * spawns a real process (Spec 33 §24 layer D) - production wiring in
   * `extension.ts` MUST supply `BunPathContainmentPort` explicitly.
   */
  readonly pathContainmentPort?: PathContainmentPort;
}

interface HostOutcome {
  readonly info?: HostPackageInfo;
  readonly compatibility: Result<HostPackageInfo, PiAdapterFailure>;
}

interface CandidatePlanOutcome {
  readonly probeContext?: PiCandidatePlanContext;
  readonly activation?: PiConfigActivationResult;
  readonly failure?: PiAdapterFailure;
  readonly toolPolicy?: PiToolPolicyPlan;
  readonly weaveOwnedRegistrations: readonly PiWeaveToolRegistration[];
}

/** Bounded, closed-set reason for a coverage-proof failure - never raw context content. */
function coverageFailureReason(
  error: import("@weaveio/weave-engine").PermissionCoverageError,
): string {
  if (error.type === "incomplete_coverage") return `incomplete:${error.reason}`;
  return "invalid-coverage-context";
}

export class PiSafeInitializer {
  private readonly contract: AdapterCapabilityContract;
  private readonly permissionBridge: PiPermissionBridge;
  private readonly pathContainmentPort: PathContainmentPort;

  constructor(private readonly deps: PiSafeInitializerDeps) {
    this.contract = deps.capabilityContract ?? PI_ADAPTER_CAPABILITY_CONTRACT;
    this.permissionBridge =
      deps.permissionBridge ?? new PiPermissionBridge({ logger: noopLogger });
    this.pathContainmentPort =
      deps.pathContainmentPort ?? new NullPathContainmentPort();
  }

  preflight(
    session: Pick<
      PiSessionContext,
      "mode" | "isProjectTrusted" | "cwd" | "modelRegistry"
    >,
    commands: readonly PiCommandInfo[],
    tools: readonly PiToolInfo[],
  ): ResultAsync<PiPreflightResult, PiAdapterFailure> {
    const mode = session.mode;
    const modeSupported = mode === "tui";
    const trust: PiTrustState = session.isProjectTrusted()
      ? "trusted"
      : "withheld";

    return this.readHost().andThen((hostOutcome) => {
      const hostSupported = hostOutcome.compatibility.isOk();
      const blocked = !modeSupported || !hostSupported;
      const blockedReason = !modeSupported
        ? "interactive-tui-required"
        : "host-incompatible";

      return this.buildCandidatePlan(
        blocked,
        session.cwd,
        trust,
        session.modelRegistry,
        tools,
      ).andThen((candidate) =>
        this.computeProbes(blocked, blockedReason, {
          mode,
          trust,
          commands,
          candidatePlan: candidate.probeContext,
        }).andThen((probes) => {
          const healthReport = buildAdapterHealthReport({
            harness: HOST_PACKAGE_NAME,
            capabilityContract: this.contract,
            probeResults: probes,
          });

          const result: PiPreflightResult = {
            mode,
            modeSupported,
            host: hostOutcome.info,
            hostSupported,
            trust,
            configActivation: candidate.activation,
            configActivationFailure: candidate.failure,
            toolPolicy: candidate.toolPolicy,
            weaveOwnedRegistrations: candidate.weaveOwnedRegistrations,
            healthReport,
            healthOnlyMode:
              blocked || trust === "withheld" || healthReport.healthOnlyMode,
          };
          return ok(result);
        }),
      );
    });
  }

  /**
   * Reads the host package without ever short-circuiting the rest of
   * preflight: a failed read still produces a `HostOutcome` carrying the
   * failure, so preflight can still emit a health report and remain
   * inspectable.
   */
  private readHost(): ResultAsync<HostOutcome, PiAdapterFailure> {
    return ResultAsync.fromSafePromise(
      this.deps.hostPackageReader.read().match(
        (info): HostOutcome => ({
          info,
          compatibility: checkHostCompatibility(info),
        }),
        (failure): HostOutcome => ({
          info: undefined,
          compatibility: err(failure),
        }),
      ),
    );
  }

  /**
   * Spec 33 §7.2 steps 5-8: loads the permitted config and materializes it
   * into candidate descriptors - but only when mode/host are not blocked
   * (Spec 33 §28 "wrong mode/host/version -\> health-only" means config MUST
   * NOT be loaded or materialized at all in that state). Also performs a
   * *pure, dry-run* model resolution for the default primary purely to
   * inform capability probing; it never applies a model (`pi.setModel`) -
   * that only happens later, atomically, in `PiPrimarySession.activate`.
   */
  private buildCandidatePlan(
    blocked: boolean,
    projectRoot: string,
    trust: PiTrustState,
    modelRegistry: PiModelRegistry,
    tools: readonly PiToolInfo[],
  ): ResultAsync<CandidatePlanOutcome, never> {
    if (blocked) {
      return okAsync({ weaveOwnedRegistrations: [] });
    }

    // `configActivator` is an injected port - even though it is *typed* as
    // `ResultAsync<..., PiAdapterFailure>`, a misbehaving concrete
    // implementation could still throw synchronously or reject its promise.
    // `safelyAwaitPortResult` fails closed instead of letting that become an
    // unhandled rejection or a synchronous throw escaping this method
    // (neverthrow-wrap-exceptions). The failure reason below is a fixed,
    // closed-set literal - never anything derived from the thrown/rejected
    // value, since Spec 33's closed-failure contract bans private paths,
    // environment values, and secrets from public failures.
    return ResultAsync.fromSafePromise(
      (async (): Promise<CandidatePlanOutcome> => {
        return await safelyAwaitPortResult(
          () => this.deps.configActivator.activate({ projectRoot, trust }),
          (): PiAdapterFailure =>
            makeActivationFailedFailure("config-activation-threw"),
        ).match(
          async (activation): Promise<CandidatePlanOutcome> => {
            const primary = activation.descriptors.byName.get(
              DEFAULT_PRIMARY_AGENT_NAME,
            );
            const primaryEligible =
              primary !== undefined && primary.mode !== "subagent";
            const weaveOwnedRegistrations =
              primaryEligible && primary !== undefined
                ? (this.deps.buildDelegationToolRegistrations?.(
                    primary as NonNullable<typeof primary>,
                    activation,
                  ) ?? [])
                : [];
            // `modelRegistry` is an injected port; a throwing
            // `getAvailable()` must not crash preflight - Spec 33 §9.2's own
            // fail-closed behavior for model resolution is to degrade rather
            // than fail, so an unreadable catalog is treated as an empty one.
            const availableModels = safelyListAvailableModels(
              modelRegistry,
            ).unwrapOr([]);
            const modelResolution = primaryEligible
              ? new PiModelResolver().resolve(
                  (primary as NonNullable<typeof primary>).models,
                  availableModels,
                )
              : { resolved: false as const };

            const policies = Object.fromEntries(
              [...activation.descriptors.byName].map(([name, descriptor]) => [
                name,
                descriptor.effectiveToolPolicy,
              ]),
            );
            // `permissionBridge.planToolPolicy` is pure/read-only and already
            // returns a `Result`, but it is an injected port - `Result.fromThrowable`
            // catches a misbehaving implementation throwing synchronously
            // instead of letting that escape as an unhandled exception
            // (neverthrow-wrap-exceptions).
            const planned = Result.fromThrowable(
              () =>
                this.permissionBridge.planToolPolicy({
                  allTools: tools,
                  weaveOwnedRegistrations,
                  policies,
                }),
              () => makeInvariantViolationFailure("tool-policy-plan-threw"),
            )().andThen((result) => result);

            // Project-path containment (Spec 33 §18, §21, §28) is only ever
            // computed under confirmed project trust - probing `.weave/runtime`/
            // `.weave/plans` is itself project-path access, which withheld
            // trust must never perform even though config can still load in a
            // narrow builtin/global-only way under withheld trust.
            const containment =
              trust === "trusted"
                ? await Promise.all([
                    isDirectoryContainmentSafeWith(
                      this.pathContainmentPort,
                      projectRoot,
                      ".weave/runtime",
                    ),
                    isDirectoryContainmentSafeWith(
                      this.pathContainmentPort,
                      projectRoot,
                      ".weave/plans",
                    ),
                  ])
                : undefined;
            const runtimeDirectoryContained = containment
              ? containment[0].unwrapOr(false)
              : undefined;
            const plansDirectoryContained = containment
              ? containment[1].unwrapOr(false)
              : undefined;

            return {
              activation,
              toolPolicy: planned.isOk() ? planned.value : undefined,
              weaveOwnedRegistrations,
              probeContext: {
                configLoaded: true,
                materializationErrorCount: activation.descriptors.errors.length,
                primaryDescriptorFound: primaryEligible,
                primaryModelDryResolved: modelResolution.resolved,
                toolPolicyCoverage: toolPolicyCoverageFromPlan(planned),
                runtimeDirectoryContained,
                plansDirectoryContained,
              },
            };
          },
          (failure): CandidatePlanOutcome => ({
            failure,
            weaveOwnedRegistrations: [],
            probeContext: {
              configLoaded: false,
              materializationErrorCount: 0,
              primaryDescriptorFound: false,
              primaryModelDryResolved: false,
              toolPolicyCoverage: { reason: "config-not-loaded" },
            },
          }),
        );
      })(),
    );
  }

  private computeProbes(
    blocked: boolean,
    blockedReason: string,
    context: {
      mode: PiMode;
      trust: PiTrustState;
      commands: readonly PiCommandInfo[];
      candidatePlan?: PiCandidatePlanContext;
    },
  ): Result<CapabilityProbeResult[], PiAdapterFailure> {
    return Result.fromThrowable(
      () =>
        blocked
          ? buildBlockedProbeSet(blockedReason)
          : sanitizeCapabilityProbeResults(
              this.deps.capabilityProber.probe(context),
            ),
      () => makeInvariantViolationFailure("capability-prober-threw"),
    )();
  }
}
