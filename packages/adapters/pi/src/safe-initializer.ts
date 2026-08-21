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
  type PiDelegationAuthorityReadiness,
  sanitizeCapabilityProbeResults,
} from "./capability-prober.js";
import {
  DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  effectivePiChildInspectionSettings,
  type PiChildInspectionEffectiveSettings,
  type PiChildInspectionSettingsChoice,
  type PiChildInspectionSettingsIssue,
} from "./child-inspection-settings.js";
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
  type HostCapabilityGapDiagnostic,
  type HostPackageInfo,
  type HostPackageReader,
  UNKNOWN_HOST_VERSION,
} from "./host-compatibility.js";
import {
  buildHostSurfaceGapDiagnostics,
  defaultHostSurfaceReport,
  type PiHostSurfaceReport,
  selectsCustomEditorFallback,
} from "./host-inventory.js";
import { PiModelResolver } from "./model-resolution.js";
import {
  isDirectoryContainmentSafeWith,
  NullPathContainmentPort,
  type PathContainmentPort,
} from "./path-containment.js";
import {
  safelyAwaitPortResult,
  safelyListAvailableModels,
} from "./port-safety.js";
import { DEFAULT_PRIMARY_AGENT_NAME } from "./primary-session.js";
import {
  collectRequiredCapabilityGaps,
  type PiRequiredCapabilityGap,
} from "./required-capability-gate.js";
import type {
  PiCommandInfo,
  PiMode,
  PiModelRegistry,
  PiSessionContext,
  PiToolRegistration,
  PiTrustState,
} from "./types.js";

/**
 * Result of the read-only preflight sequence (Pi adapter contract,).
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
 * capabilities (Pi adapter contract) -- reports success. That narrow `ok` proves
 * only that project-path access was correctly withheld; it never proves the
 * underlying capability is usable, so it MUST NOT be able to promote the
 * adapter into a ready (non-health-only) state while trust is absent.
 *
 * `configActivation` is `undefined` when config activation never ran
 * (mode/host blocked - Pi adapter contract "wrong mode/host/version -\> health-only"
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
  /** Weave-owned tools prepared during read-only preflight. */
  readonly toolRegistrations: readonly PiToolRegistration[];
  readonly healthReport: AdapterHealthReport;
  readonly healthOnlyMode: boolean;
  /**
   * Every required capability that is not effective for this generation,
   * with a sanitized reason. Mutating routes consult this through the
   * session-mutation gate before touching any downstream service.
   */
  readonly requiredCapabilityGaps: readonly PiRequiredCapabilityGap[];
  /** One immutable object shared by the store, inspector, and recovery seams. */
  readonly childInspection: PiChildInspectionEffectiveSettings;
  readonly hostSurface: PiHostSurfaceReport;
  /**
   * One strong-debug diagnostic per host-surface gap (Spec 33 §16). Every
   * entry names the capability, host version, contract, probe result,
   * resulting mode, and remediation. Empty when no surface is missing.
   */
  readonly hostSurfaceGapDiagnostics: readonly HostCapabilityGapDiagnostic[];
  /**
   * Which child-inspection implementation this generation must use.
   * `custom-editor` when an overlay-only host surface is missing; Task 12's
   * overlay reads this instead of re-probing the host.
   */
  readonly childInspectionFallback: "native-overlay" | "custom-editor";
}

export interface PiSafeInitializerDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly configActivator: PiConfigActivator;
  readonly capabilityContract?: AdapterCapabilityContract;
  /**
   * Caller-supplied builder for the ordinary-delegation Weave-owned tool
   * (Pi adapter contract) - mirrors the existing caller-supplied-resolver pattern
   * so this foundational module never depends on the concrete delegation
   * controller. Receives the eligible default-primary descriptor and the
   * successful config activation; returns zero or one registrations. Not
   * called at all when there is no eligible primary this generation.
   */
  readonly buildDelegationToolRegistrations?: (
    primary: AgentDescriptor,
    activation: PiConfigActivationResult,
  ) => readonly PiToolRegistration[];
  /**
   * Real, no-follow-safe containment proof for `.weave/runtime`/`.weave/plans`
   * (Pi adapter contract) - gates `workflow-persistence`/
   * `workflow-step-dispatch`/`plan-file-compatibility` on more than
   * `configLoaded`. Defaults to `NullPathContainmentPort` (always
   * fail-closed, never spawns a process) so omitting this dependency never
   * silently promotes those capabilities to `ok` and no test accidentally
   * spawns a real process (Pi adapter contract) - production wiring in
   * `extension.ts` MUST supply `BunPathContainmentPort` explicitly.
   */
  readonly pathContainmentPort?: PathContainmentPort;
  /**
   * Resolves invalid Pi-local settings exactly once for this activation. A
   * missing resolver fails closed to health-only mode; it never applies
   * defaults implicitly.
   */
  readonly chooseInvalidChildInspectionSettings?: (
    issues: readonly PiChildInspectionSettingsIssue[],
  ) => ResultAsync<PiChildInspectionSettingsChoice, never>;
  /**
   * Reads this generation's real spawn-authority verdict from the single
   * session authority every launch path consumes (Spec 33 §5.6).
   *
   * Mandatory. While it was optional, an embedding that wired no authority
   * kept the candidate-plan verdict, so `delegated-specialist-execution`
   * could report ready in a generation where every spawn would refuse -
   * exactly the disagreement the single authority exists to remove. An
   * embedding that genuinely cannot delegate says so by returning
   * `{ status: "unavailable", reason }`.
   */
  readonly delegationAuthority: () => PiDelegationAuthorityReadiness;
}

interface HostOutcome {
  readonly info?: HostPackageInfo;
  readonly compatibility: Result<HostPackageInfo, PiAdapterFailure>;
}

interface CandidatePlanOutcome {
  readonly probeContext?: PiCandidatePlanContext;
  readonly activation?: PiConfigActivationResult;
  readonly failure?: PiAdapterFailure;
  readonly toolRegistrations: readonly PiToolRegistration[];
}

export class PiSafeInitializer {
  private readonly contract: AdapterCapabilityContract;
  private readonly pathContainmentPort: PathContainmentPort;

  constructor(private readonly deps: PiSafeInitializerDeps) {
    this.contract = deps.capabilityContract ?? PI_ADAPTER_CAPABILITY_CONTRACT;
    this.pathContainmentPort =
      deps.pathContainmentPort ?? new NullPathContainmentPort();
  }

  preflight(
    session: Pick<
      PiSessionContext,
      "mode" | "isProjectTrusted" | "cwd" | "modelRegistry"
    >,
    commands: readonly PiCommandInfo[],
    hostSurface?: PiHostSurfaceReport,
  ): ResultAsync<PiPreflightResult, PiAdapterFailure> {
    const mode = session.mode;
    const modeSupported = mode === "tui";
    const normalizedHostSurface = hostSurface ?? defaultHostSurfaceReport();
    const trust: PiTrustState = session.isProjectTrusted()
      ? "trusted"
      : "withheld";
    // Read once per preflight, from the same authority object the delegation
    // controller, direct dispatch, and every RPC child will consume.
    const delegationAuthority = Result.fromThrowable(
      () => this.deps.delegationAuthority(),
      (): PiDelegationAuthorityReadiness => ({
        status: "unavailable",
        reason: "pi-session-api-unavailable",
      }),
    )().match(
      (readiness) => readiness,
      (fallback) => fallback,
    );

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
      ).andThen((candidate) =>
        this.resolveChildInspectionSettings(candidate.activation).andThen(
          (childInspection) =>
            this.computeProbes(blocked, blockedReason, {
              mode,
              trust,
              commands,
              candidatePlan: candidate.probeContext,
              hostSurface: normalizedHostSurface,
              delegationAuthority,
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
                toolRegistrations: candidate.toolRegistrations,
                healthReport,
                requiredCapabilityGaps:
                  collectRequiredCapabilityGaps(healthReport),
                healthOnlyMode:
                  blocked ||
                  trust === "withheld" ||
                  healthReport.healthOnlyMode ||
                  childInspection.mode === "health-only" ||
                  normalizedHostSurface.requiredGaps.length > 0,
                childInspection,
                hostSurface: normalizedHostSurface,
                hostSurfaceGapDiagnostics: buildHostSurfaceGapDiagnostics(
                  normalizedHostSurface,
                  hostOutcome.info?.version ?? UNKNOWN_HOST_VERSION,
                ),
                childInspectionFallback: selectsCustomEditorFallback(
                  normalizedHostSurface,
                )
                  ? "custom-editor"
                  : "native-overlay",
              };
              return ok(result);
            }),
        ),
      );
    });
  }

  private resolveChildInspectionSettings(
    activation: PiConfigActivationResult | undefined,
  ): ResultAsync<PiChildInspectionEffectiveSettings, never> {
    if (activation === undefined) {
      return okAsync(
        effectivePiChildInspectionSettings({
          status: "valid",
          settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
        }),
      );
    }

    const resolution = activation.childInspectionSettings;
    if (resolution.status === "valid") {
      return okAsync(effectivePiChildInspectionSettings(resolution));
    }

    const choose = this.deps.chooseInvalidChildInspectionSettings;
    if (choose === undefined) {
      return okAsync(effectivePiChildInspectionSettings(resolution));
    }

    return safelyAwaitPortResult(
      () => choose(resolution.issues),
      (): PiChildInspectionSettingsChoice => "health-only",
    )
      .map((choice) => effectivePiChildInspectionSettings(resolution, choice))
      .orElse(() => okAsync(effectivePiChildInspectionSettings(resolution)));
  }

  /**
   * Reads the host package without ever short-circuiting the rest of
   * preflight: a failed read still produces a `HostOutcome` carrying the
   * failure, so preflight can still emit a health report and remain
   * inspectable.
   */
  private readHost(): ResultAsync<HostOutcome, PiAdapterFailure> {
    return safelyAwaitPortResult(
      () => this.deps.hostPackageReader.read(),
      (): PiAdapterFailure =>
        makeInvariantViolationFailure("host-package-reader-threw"),
    )
      .map(
        (info): HostOutcome => ({
          info,
          compatibility: checkHostCompatibility(info),
        }),
      )
      .orElse((failure) =>
        okAsync<HostOutcome, never>({
          info: undefined,
          compatibility: err(failure),
        }),
      );
  }

  /**
   * Pi adapter contract: loads the permitted config and materializes it
   * into candidate descriptors - but only when mode/host are not blocked
   * (Pi adapter contract "wrong mode/host/version -\> health-only" means config MUST
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
  ): ResultAsync<CandidatePlanOutcome, never> {
    if (blocked) {
      return okAsync({ toolRegistrations: [] });
    }

    // `configActivator` is an injected port - even though it is *typed* as
    // `ResultAsync<..., PiAdapterFailure>`, a misbehaving concrete
    // implementation could still throw synchronously or reject its promise.
    // `safelyAwaitPortResult` fails closed instead of letting that become an
    // unhandled rejection or a synchronous throw escaping this method
    // (neverthrow-wrap-exceptions). The failure reason below is a fixed,
    // closed-set literal - never anything derived from the thrown/rejected
    // value, since Pi adapter closed-failure contract bans private paths,
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
            const eligiblePrimary =
              primary !== undefined && primary.mode !== "subagent"
                ? primary
                : undefined;
            const toolRegistrations =
              eligiblePrimary === undefined
                ? []
                : (this.deps.buildDelegationToolRegistrations?.(
                    eligiblePrimary,
                    activation,
                  ) ?? []);
            // `modelRegistry` is an injected port; a throwing
            // `getAvailable()` must not crash preflight - Pi adapter contract's own
            // fail-closed behavior for model resolution is to degrade rather
            // than fail, so an unreadable catalog is treated as an empty one.
            const availableModels = safelyListAvailableModels(
              modelRegistry,
            ).unwrapOr([]);
            const modelResolution =
              eligiblePrimary === undefined
                ? { resolved: false as const }
                : new PiModelResolver().resolve(
                    eligiblePrimary.models,
                    availableModels,
                  );

            // Project-path containment (Pi adapter contract) is only ever
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
              toolRegistrations,
              probeContext: {
                configLoaded: true,
                materializationErrorCount: activation.descriptors.errors.length,
                primaryDescriptorFound: eligiblePrimary !== undefined,
                primaryModelDryResolved: modelResolution.resolved,
                delegationToolPlanned: toolRegistrations.some(
                  (registration) => registration.name === "weave_delegate",
                ),
                eventLoggingPlanned:
                  trust === "trusted" && runtimeDirectoryContained === true,
                runtimeDirectoryContained,
                plansDirectoryContained,
              },
            };
          },
          (failure): CandidatePlanOutcome => ({
            failure,
            toolRegistrations: [],
            probeContext: {
              configLoaded: false,
              materializationErrorCount: 0,
              primaryDescriptorFound: false,
              primaryModelDryResolved: false,
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
      hostSurface?: PiHostSurfaceReport;
      delegationAuthority?: PiDelegationAuthorityReadiness;
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
