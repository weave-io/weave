/**
 * Direct workflow-step dispatch (Pi adapter contract).
 *
 * Ordinary delegation (`weave_delegate`) returns a structured result to the
 * *invoking agent* and never creates/advances workflow state. Direct
 * workflow-step dispatch is a distinct engine effect: the
 * `PiWorkflowController` is the sole caller, and every dispatched child
 * carries workflow instance/lease/step correlation plus structured
 * completion semantics that ordinary delegation never has.
 *
 * The production implementation reuses the same private child transport as
 * ordinary delegation (`PiDelegationController`/`PiRpcChild`) rather than a
 * second protocol implementation, under the Pi adapter contract ("Direct dispatch may
 * reuse private child transport"). The child settles through the existing
 * `PiChildSettlement` channel; its `completionCandidate` carries a bounded JSON
 * completion candidate (produced by the child's governed
 * `weave_complete_step` tool) rather than free text, and this module is the
 * only place that ever interprets that payload as a structured completion
 * candidate - ordinary delegation settlements are never parsed this way.
 */
import type { DelegationTarget } from "@weaveio/weave-engine";
import { err, type Result, ResultAsync } from "neverthrow";
import {
  makeChildSpawnFailedFailure,
  makeCompletionSignalDuplicateFailure,
  makeCompletionSignalLateFailure,
  makeCompletionSignalMalformedFailure,
  makeCompletionSignalMissingFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  parseStructuredCompletionCandidate,
  tryParseCompletionCandidateJson,
} from "./structured-completion.js";

export interface PiDirectDispatchInput {
  readonly workflowInstanceId: string;
  readonly leaseId: string;
  readonly stepName: string;
  readonly agentName: string;
  /** Activated descriptor prompt installed as the child's system context. */
  readonly composedPrompt: string;
  /** Rendered workflow-step instructions sent as the RPC task. */
  readonly taskPrompt: string;
  readonly cwd: string;
  /** Pre-generated so the caller can pin it into the bootstrap/prompt correlation before spawning. */
  readonly correlationId: string;
  /**
   * The direct-step agent's OWN resolved descriptor fields (Pi adapter contract,
   *), resolved by the caller against its own activated descriptor
   * catalog by `agentName` - never the engine-emitted `RunAgentEffect`'s
   * own `agentDescriptor`, whose `composedPrompt` and `models` are
   * deliberately always empty/minimal (a security invariant: the engine
   * never carries raw prompt text in an effect).
   */
  readonly models: readonly string[];
  readonly delegationTargets: readonly DelegationTarget[];
}

export interface PiDirectDispatchCandidate {
  readonly outcome: "success" | "blocked" | "failed" | "paused";
  readonly method?:
    | "agent_signal"
    | "user_confirm"
    | "review_verdict"
    | "plan_created"
    | "plan_complete";
  readonly approved?: boolean;
  readonly message?: string;
  readonly artifacts?: readonly {
    readonly name: string;
    readonly path: string;
    readonly mimeType?: string;
    readonly description?: string;
  }[];
  readonly nextStepHint?: string;
}

/**
 * Adapter-owned direct-dispatch port. `PiWorkflowController` depends only
 * on this narrow interface, never on the delegation transport directly, so
 * it stays testable against a fully scripted fake with no real Pi/child
 * processes (Pi adapter contract).
 */
export interface PiDirectDispatchPort {
  dispatch(
    input: PiDirectDispatchInput,
  ): ResultAsync<PiDirectDispatchCandidate, PiAdapterFailure>;
}

/** The underlying settlement shape shared with ordinary delegation (`PiChildSettlement`). Declared structurally here so this module has no import-time dependency on `rpc-child.ts`. */
export interface DirectDispatchSettlement {
  readonly outcome: "completed" | "failed";
  readonly completionCandidate?: string;
  /** Authenticated count of accepted parent interventions. */
  readonly interventionCount?: number;
  readonly reason?: string;
}

export type DirectDispatchTransport = (
  input: PiDirectDispatchInput,
) => ResultAsync<DirectDispatchSettlement, PiAdapterFailure>;

/**
 * Production implementation: delegates the actual spawn/settle/cleanup
 * mechanics to an injected transport function (in practice, a thin wrapper
 * around `PiDelegationController`'s private child transport tagged with
 * this step's correlation), then interprets the settlement as a structured
 * completion candidate - the one place ordinary delegation and direct
 * dispatch diverge in meaning.
 */
export class TransportDirectDispatchPort implements PiDirectDispatchPort {
  constructor(private readonly transport: DirectDispatchTransport) {}

  dispatch(
    input: PiDirectDispatchInput,
  ): ResultAsync<PiDirectDispatchCandidate, PiAdapterFailure> {
    return this.transport(input).andThen((settlement) =>
      this.interpretSettlement(settlement, input.stepName),
    );
  }

  private interpretSettlement(
    settlement: DirectDispatchSettlement,
    stepName: string,
  ): Result<PiDirectDispatchCandidate, PiAdapterFailure> {
    if (settlement.outcome === "failed") {
      // The child's own `weave_complete_step` recorder distinguishes
      // missing/duplicate/late/malformed completion attempts (Pi adapter contract
      //) via these fixed, closed reason strings - never free text -
      // so this is the one place that maps them to the exact typed
      // failure the engine/UI expect, instead of one generic
      // child-failed code for every distinct cause.
      const reason = settlement.reason ?? "child-failed";
      if (reason === "missing") {
        return err(makeCompletionSignalMissingFailure(stepName));
      }
      if (reason === "duplicate") {
        return err(makeCompletionSignalDuplicateFailure(stepName));
      }
      if (reason === "late") {
        return err(makeCompletionSignalLateFailure(stepName));
      }
      if (reason.startsWith("malformed:")) {
        return err(
          makeCompletionSignalMalformedFailure(
            stepName,
            reason.slice("malformed:".length),
          ),
        );
      }
      return err(makeChildSpawnFailedFailure(stepName, reason));
    }
    const raw = tryParseCompletionCandidateJson(
      settlement.completionCandidate ?? "",
    );
    return parseStructuredCompletionCandidate(raw, stepName).map(
      (signal) => signal as PiDirectDispatchCandidate,
    );
  }
}

/** Scripted fake for isolated `PiWorkflowController` tests - no real child process, no network. */
export class FakeDirectDispatchPort implements PiDirectDispatchPort {
  private readonly scripted: Array<
    Result<PiDirectDispatchCandidate, PiAdapterFailure>
  > = [];
  readonly calls: PiDirectDispatchInput[] = [];

  enqueue(result: Result<PiDirectDispatchCandidate, PiAdapterFailure>): void {
    this.scripted.push(result);
  }

  dispatch(
    input: PiDirectDispatchInput,
  ): ResultAsync<PiDirectDispatchCandidate, PiAdapterFailure> {
    this.calls.push(input);
    const next = this.scripted.shift();
    if (next === undefined) {
      return ResultAsync.fromPromise(
        Promise.reject(
          makeChildSpawnFailedFailure(input.stepName, "no-scripted-response"),
        ),
        (cause) => cause as PiAdapterFailure,
      );
    }
    return ResultAsync.fromSafePromise(Promise.resolve(next)).andThen(
      (result) => result,
    );
  }
}
