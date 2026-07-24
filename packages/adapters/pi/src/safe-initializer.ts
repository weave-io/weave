import type {
  AdapterCapabilityContract,
  AdapterHealthReport,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { buildAdapterHealthReport } from "@weaveio/weave-engine";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "./capability-declarations.js";
import {
  buildBlockedProbeSet,
  type PiCapabilityProbeSource,
  sanitizeCapabilityProbeResults,
} from "./capability-prober.js";
import {
  makeInvariantViolationFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  type HostPackageInfo,
  type HostPackageReader,
} from "./host-compatibility.js";
import type {
  PiCommandInfo,
  PiMode,
  PiSessionContext,
  PiTrustState,
} from "./types.js";

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
 */
export interface PiPreflightResult {
  readonly mode: PiMode;
  readonly modeSupported: boolean;
  readonly host?: HostPackageInfo;
  readonly hostSupported: boolean;
  readonly trust: PiTrustState;
  readonly healthReport: AdapterHealthReport;
  readonly healthOnlyMode: boolean;
}

export interface PiSafeInitializerDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly capabilityContract?: AdapterCapabilityContract;
}

interface HostOutcome {
  readonly info?: HostPackageInfo;
  readonly compatibility: Result<HostPackageInfo, PiAdapterFailure>;
}

export class PiSafeInitializer {
  private readonly contract: AdapterCapabilityContract;

  constructor(private readonly deps: PiSafeInitializerDeps) {
    this.contract = deps.capabilityContract ?? PI_ADAPTER_CAPABILITY_CONTRACT;
  }

  preflight(
    session: Pick<PiSessionContext, "mode" | "isProjectTrusted">,
    commands: readonly PiCommandInfo[],
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

      return this.computeProbes(blocked, blockedReason, {
        mode,
        trust,
        commands,
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
          healthReport,
          healthOnlyMode:
            blocked || trust === "withheld" || healthReport.healthOnlyMode,
        };
        return ok(result);
      });
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

  private computeProbes(
    blocked: boolean,
    blockedReason: string,
    context: {
      mode: PiMode;
      trust: PiTrustState;
      commands: readonly PiCommandInfo[];
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
