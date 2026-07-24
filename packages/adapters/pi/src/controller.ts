import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { classifyWeaveCommand, type WeaveCommandName } from "./commands.js";
import {
  makeActivationFailedFailure,
  makeControllerGenerationStaleFailure,
  type PiAdapterFailure,
} from "./errors.js";
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
  PiToolInfo,
} from "./types.js";

/**
 * One controller generation: the atomic bundle of state created by a single
 * `session_start` activation (Spec 33 §7.2/§7.4). Replaced wholesale on
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
 * a callback captured before a replacement can detect it is stale (Spec
 * Spec 33 §7.4) instead of silently acting on behalf of a generation that no
 * longer exists.
 */
export interface PiOperationHandle {
  readonly generationId: string;
  assertStillCurrent(): Result<void, PiAdapterFailure>;
}

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

  constructor(private readonly deps: PiExtensionControllerDeps) {}

  activate(
    session: Pick<
      PiSessionContext,
      "mode" | "isProjectTrusted" | "cwd" | "modelRegistry"
    >,
    commands: readonly PiCommandInfo[],
    tools: readonly PiToolInfo[],
  ): ResultAsync<PiGeneration, PiAdapterFailure> {
    const id = this.deps.idGenerator.next();
    return this.deps.safeInitializer
      .preflight(session, commands, tools)
      .map((preflight) => {
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
        return generation;
      });
  }

  getCurrentGeneration(): PiGeneration | undefined {
    return this.currentGeneration;
  }

  /**
   * Snapshots the current generation identity so async work can prove, once
   * it resumes, whether a replacement happened in between (Spec 33 §7.4).
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
   * The health-only gate (Spec 33 §21): blocks `mutating` commands while a
   * required capability is degraded/unsupported, but always allows
   * `read-only` and `idempotent-cleanup` commands regardless of health.
   */
  evaluateCommandGate(
    commandName: WeaveCommandName,
  ): Result<PiCommandGateDecision, PiAdapterFailure> {
    const generation = this.currentGeneration;
    if (generation === undefined) {
      return err(makeActivationFailedFailure("no-active-generation"));
    }
    const classification = classifyWeaveCommand(commandName);
    if (generation.healthOnlyMode && classification === "mutating") {
      return ok({
        allowed: false,
        classification,
        reason: "health-only-mode",
      });
    }
    return ok({ allowed: true, classification });
  }

  /** Idempotent: safe to call more than once, e.g. from repeated shutdown events. */
  shutdown(): Result<void, PiAdapterFailure> {
    this.currentGeneration = undefined;
    return ok(undefined);
  }
}
