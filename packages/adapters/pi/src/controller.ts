import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { classifyWeaveCommand, type WeaveCommandName } from "./commands.js";
import {
  makeActivationFailedFailure,
  makeControllerGenerationStaleFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiHostSurfaceReport } from "./host-inventory.js";
import {
  createBlockedSessionMutationGate,
  createSessionMutationGate,
  findSessionMutationGap,
  type PiRequiredCapabilityGap,
  type PiSessionMutationGate,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
} from "./required-capability-gate.js";
import type {
  PiPreflightResult,
  PiSafeInitializer,
} from "./safe-initializer.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiCommandInfo,
  PiSessionContext,
} from "./types.js";

/**
 * One controller generation: the atomic bundle of state created by a single
 * `session_start` activation (Pi adapter contract). Replaced wholesale on
 * reload/new/resume/fork/session replacement - never mutated in place.
 */
export interface PiGeneration {
  readonly id: string;
  readonly createdAt: number;
  readonly preflight: PiPreflightResult;
  readonly healthOnlyMode: boolean;
}

/**
 * A capability to check generation identity across an `await` boundary, so
 * a callback captured before a replacement can detect that it is stale under the
 * Pi adapter contract instead of silently acting on behalf of a generation that no
 * longer exists.
 */
export interface PiOperationHandle {
  readonly generationId: string;
  assertStillCurrent(): Result<void, PiAdapterFailure>;
}

/**
 * The gap set used when no generation is active. Fail-closed: absence of a
 * generation is not proof that the host provides descriptor-relative session
 * I/O, so the session-mutation gate must still block.
 */
const BLOCKED_NO_GENERATION_GAPS: readonly PiRequiredCapabilityGap[] =
  Object.freeze([
    {
      capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
      reason: "no-active-generation",
    },
  ]);

export interface PiCommandGateDecision {
  readonly allowed: boolean;
  readonly classification: ReturnType<typeof classifyWeaveCommand>;
  readonly reason?: string;
}

export interface PiExtensionControllerDeps {
  readonly safeInitializer: PiSafeInitializer;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
}

/**
 * Owns exactly one active generation at a time. `activate` always creates a
 * brand-new generation (fresh ID, fresh preflight); it never mutates a prior
 * generation. `shutdown` idempotently clears the active generation. Command
 * shells call `evaluateCommandGate` fresh on every invocation, so ordinary
 * dispatch is never stale by construction - staleness only matters for work
 * that spans an `await` boundary via `beginOperation`.
 */
export class PiExtensionController {
  private currentGeneration: PiGeneration | undefined;
  private activationSequence = 0;

  constructor(private readonly deps: PiExtensionControllerDeps) {}

  activate(
    session: Pick<
      PiSessionContext,
      "mode" | "isProjectTrusted" | "cwd" | "modelRegistry"
    >,
    commands: readonly PiCommandInfo[],
    hostSurface?: PiHostSurfaceReport,
  ): ResultAsync<PiGeneration, PiAdapterFailure> {
    const id = this.deps.idGenerator.next();
    const activationSequence = ++this.activationSequence;
    return this.deps.safeInitializer
      .preflight(session, commands, hostSurface)
      .andThen((preflight) => {
        if (activationSequence !== this.activationSequence) {
          return err(makeControllerGenerationStaleFailure(id));
        }
        const generation: PiGeneration = {
          id,
          createdAt: this.deps.clock.now(),
          preflight,
          healthOnlyMode: preflight.healthOnlyMode,
        };
        this.currentGeneration = generation;
        this.deps.logger.info(
          {
            generationId: id,
            healthOnlyMode: generation.healthOnlyMode,
            trust: preflight.trust,
            mode: preflight.mode,
          },
          "pi-adapter generation activated",
        );
        return ok(generation);
      });
  }

  getCurrentGeneration(): PiGeneration | undefined {
    return this.currentGeneration;
  }

  /**
   * Snapshots the current generation identity so async work can prove, once
   * it resumes, whether a replacement happened in between (Pi adapter contract).
   */
  beginOperation(): Result<PiOperationHandle, PiAdapterFailure> {
    const generation = this.currentGeneration;
    if (generation === undefined) {
      return err(makeActivationFailedFailure("no-active-generation"));
    }
    const generationId = generation.id;
    const assertStillCurrent = (): Result<void, PiAdapterFailure> => {
      const current = this.currentGeneration;
      if (current === undefined || current.id !== generationId) {
        return err(makeControllerGenerationStaleFailure(generationId));
      }
      return ok(undefined);
    };
    return ok({ generationId, assertStillCurrent });
  }

  /**
   * The health-only gate (Pi adapter contract): blocks `mutating` commands while a
   * required capability is degraded/unsupported, and always allows `read-only`
   * commands regardless of health.
   *
   * `idempotent-cleanup` commands stay available under ordinary health-only
   * mode, exactly as before. They are blocked only when the required
   * `descriptor-relative-native-session-io` capability is unavailable, because
   * cleanup still performs a persistent session mutation and the host cannot
   * prove where that mutation would land.
   */
  evaluateCommandGate(
    commandName: WeaveCommandName,
  ): Result<PiCommandGateDecision, PiAdapterFailure> {
    const generation = this.currentGeneration;
    if (generation === undefined) {
      return err(makeActivationFailedFailure("no-active-generation"));
    }
    const classification = classifyWeaveCommand(commandName);
    if (classification !== "read-only") {
      const gap = findSessionMutationGap(
        generation.preflight.requiredCapabilityGaps,
      );
      if (gap !== undefined) {
        return ok({
          allowed: false,
          classification,
          reason: `required-capability-unavailable:${gap.capabilityId}`,
        });
      }
    }
    if (generation.healthOnlyMode && classification === "mutating") {
      return ok({
        allowed: false,
        classification,
        reason: "health-only-mode",
      });
    }
    return ok({ allowed: true, classification });
  }

  /**
   * The gate every persistent-session mutation route calls before it reaches
   * a controller, service, filesystem, cache, lease, or child process.
   *
   * With no active generation the gate is blocked: absence of a generation is
   * not proof that the host is descriptor-safe.
   */
  sessionMutationGate(): PiSessionMutationGate {
    return createSessionMutationGate(() => {
      const generation = this.currentGeneration;
      if (generation === undefined) return BLOCKED_NO_GENERATION_GAPS;
      return generation.preflight.requiredCapabilityGaps;
    });
  }

  /** One-shot evaluation of the session-mutation gate. */
  evaluateSessionMutationGate(): Result<void, PiAdapterFailure> {
    const generation = this.currentGeneration;
    if (generation === undefined)
      return createBlockedSessionMutationGate().evaluate();
    return this.sessionMutationGate().evaluate();
  }

  /** Idempotent: safe to call more than once, e.g. from repeated shutdown events. */
  shutdown(): Result<void, PiAdapterFailure> {
    this.activationSequence += 1;
    this.currentGeneration = undefined;
    return ok(undefined);
  }
}
