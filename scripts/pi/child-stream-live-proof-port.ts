import { join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
  type ExtensionBuildIdentityProof,
  parseExtensionBuildIdentityProof,
} from "../../packages/adapters/pi/src/extension-build-identity.js";
import type {
  LiveProofFailureCode,
  LiveProofIdentityCurrentResult,
} from "./child-stream-live-proof-contract.js";
import {
  createLiveProofObserver,
  type LiveProofObserver,
} from "./child-stream-live-proof-observer.js";
import type {
  LiveProofChildHandle,
  LiveProofCurrentIdentityObservation,
  LiveProofDiagnosticsObservation,
  LiveProofFreshParentLaunch,
  LiveProofInspectorHandle,
  LiveProofIsolationObservation,
  LiveProofLaneSignal,
  LiveProofParentHandle,
  LiveProofPort,
  LiveProofPortFailure,
  LiveProofPortResult,
  LiveProofRegistryObservation,
  LiveProofSettlementObservation,
} from "./child-stream-live-proof-runner.js";
import {
  createLiveProofSystem,
  type LiveProofProcess,
  type LiveProofSystem,
  type LiveProofTimer,
  safeProofEnvironment,
} from "./child-stream-live-proof-system.js";
import {
  type IdentityVerificationSuccess,
  type VerifyChildStreamingFailure,
  verifyCurrentBuildIdentity,
} from "./verify-child-streaming.js";

const EXTENSION_RELATIVE_PATH =
  "packages/adapters/pi/dist/extension.js" as const;
const PARENT_PROOF_TIMEOUT_MS = 30_000;
const CHILD_RUN_TIMEOUT_MS = 60_000;
const LEASE_WAIT_TIMEOUT_MS = 15_000;
const LEASE_POLL_INTERVAL_MS = 500;
const STREAM_CLEANUP_TIMEOUT_MS = 1_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 2_500;
const NO_ACTIVE_LEASE_MARKER = "No active lease.";
const CHILD_PROMPT_TEXT = "go";

/**
 * Host resources the live proof must never leave modified. The port does not
 * write any of them; it snapshots their exact bytes before launch and
 * restores those bytes if anything in the run changed them.
 */
export interface LiveProofGuardedResource {
  readonly path: string;
}

export interface LiveProofPortConfig {
  readonly repoRoot: string;
  readonly system?: LiveProofSystem;
  readonly guardedResources?: readonly LiveProofGuardedResource[];
  readonly childRunTimeoutMs?: number;
  readonly parentProofTimeoutMs?: number;
  readonly leaseWaitTimeoutMs?: number;
  /** Test seam. Production proves identity with the real verifier. */
  readonly verifyIdentity?: (input: {
    readonly repoRoot: string;
    readonly pi: string;
  }) => ResultAsync<IdentityVerificationSuccess, VerifyChildStreamingFailure>;
}

function portFailure(code: LiveProofFailureCode): LiveProofPortFailure {
  return { code };
}

function identityResult(
  failure: VerifyChildStreamingFailure,
): LiveProofIdentityCurrentResult {
  if (failure.state === "stale-on-disk") return "stale-on-disk";
  if (failure.state === "manifest-mismatch") return "manifest-mismatch";
  return "unverifiable";
}

interface GuardedSnapshot {
  readonly path: string;
  readonly bytes: Uint8Array | undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function deterministicExtensionSource(sentinel: string): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const SENTINEL = ${JSON.stringify(sentinel)};

export default function (pi: ExtensionAPI) {
  let turn = 0;
  pi.registerProvider("weave-live-proof-deterministic", {
    name: "Weave Live Proof Deterministic",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "unused",
    api: "openai-completions",
    models: [{
      id: "live-proof-deterministic-1",
      name: "Weave Live Proof Deterministic Model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model: any, _context: any) {
      turn += 1;
      const thisTurn = turn;
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      (async () => {
        stream.push({ type: "start", partial: output });
        output.content.push({ type: "thinking", thinking: "" });
        const thinkIdx = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: output });
        let thinking = "";
        for (const fragment of [SENTINEL + "-a ", SENTINEL + "-b "]) {
          thinking += fragment;
          (output.content[thinkIdx] as any).thinking = thinking;
          stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: fragment, partial: output });
        }
        stream.push({ type: "thinking_end", contentIndex: thinkIdx, content: thinking, partial: output });

        if (thisTurn === 1) {
          output.content.push({ type: "toolCall", id: "weave-live-proof-bash-call", name: "bash", arguments: {} });
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          const args = { command: "echo weave-live-proof-ok" };
          (output.content[idx] as any).arguments = args;
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: "weave-live-proof-bash-call", name: "bash", arguments: args }, partial: output });
          output.stopReason = "toolUse";
        } else {
          output.content.push({ type: "text", text: "" });
          const idx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          let text = "";
          for (const fragment of ["Weave live ", "proof deterministic ", "answer."]) {
            text += fragment;
            (output.content[idx] as any).text = text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: fragment, partial: output });
          }
          stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
          output.stopReason = "stop";
        }
        stream.push({ type: "done", reason: output.stopReason as any, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
`;
}

type StreamStep =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "done" }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" }
  | { readonly kind: "error" };

interface StreamSession {
  readonly iterator: AsyncIterator<string>;
  closed: boolean;
  timer?: LiveProofTimer;
  cancelActiveStep?: () => void;
  closePromise?: Promise<boolean>;
}

interface RunState {
  pi?: string;
  identityVerifiedAtMs?: number;
  artifactSha256?: string;
  workspaceRoot?: string;
  providerExtension?: string;
  workspaceDir?: string;
  parentProcess?: LiveProofProcess;
  childProcess?: LiveProofProcess;
  parentStream?: StreamSession;
  childStream?: StreamSession;
  streamCleanupFailed: boolean;
  processTerminationFailed: boolean;
  childCount: number;
  observer?: LiveProofObserver;
  childRun?: Promise<Result<void, LiveProofPortFailure>>;
  guarded: GuardedSnapshot[];
  parentHandle?: LiveProofParentHandle;
  childHandle?: LiveProofChildHandle;
  inspectorHandle?: LiveProofInspectorHandle;
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  const parsed = Result.fromThrowable(
    () => JSON.parse(line) as unknown,
    () => undefined,
  )();
  if (parsed.isErr()) return undefined;
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * The production `LiveProofPort`.
 *
 * It proves the complete current runtime identity, starts a genuinely fresh
 * Pi parent that loads the verified artifact, runs exactly one deterministic
 * child through real Pi machinery, observes the four lanes at the content-free
 * observation source, and cleans up everything it created. No host string,
 * path, identifier, or exception ever leaves this module: every failure is one
 * closed code.
 */
export function createLiveProofPort(
  config: LiveProofPortConfig,
): LiveProofPort {
  const system = config.system ?? createLiveProofSystem();
  const verifyIdentity =
    config.verifyIdentity ??
    ((input) =>
      verifyCurrentBuildIdentity({
        repoRoot: input.repoRoot,
        pi: input.pi,
        requireCurrentBuild: true,
      }));
  const childRunTimeoutMs = config.childRunTimeoutMs ?? CHILD_RUN_TIMEOUT_MS;
  const parentProofTimeoutMs =
    config.parentProofTimeoutMs ?? PARENT_PROOF_TIMEOUT_MS;
  const leaseWaitTimeoutMs = config.leaseWaitTimeoutMs ?? LEASE_WAIT_TIMEOUT_MS;
  const sentinel = `WEAVE-LIVE-PROOF-${system.uniqueToken()}`;

  const state: RunState = {
    childCount: 0,
    guarded: [],
    streamCleanupFailed: false,
    processTerminationFailed: false,
  };

  const snapshotGuarded = (): ResultAsync<void, LiveProofPortFailure> => {
    const resources = config.guardedResources ?? [];
    let chain = okAsync<void, LiveProofPortFailure>(undefined);
    for (const resource of resources) {
      chain = chain.andThen(() =>
        system
          .readBytes(resource.path)
          .andThen((bytes) => {
            state.guarded.push({ path: resource.path, bytes });
            return okAsync<void, LiveProofPortFailure>(undefined);
          })
          .orElse(() => {
            state.guarded.push({ path: resource.path, bytes: undefined });
            return okAsync<void, LiveProofPortFailure>(undefined);
          }),
      );
    }
    return chain;
  };

  const restoreGuarded = (): ResultAsync<void, LiveProofPortFailure> => {
    let chain = okAsync<void, LiveProofPortFailure>(undefined);
    for (const snapshot of state.guarded) {
      const bytes = snapshot.bytes;
      if (bytes === undefined) continue;
      chain = chain.andThen(() =>
        system
          .readBytes(snapshot.path)
          .andThen((current) =>
            bytesEqual(current, bytes)
              ? okAsync<void, LiveProofPortFailure>(undefined)
              : system
                  .writeBytes(snapshot.path, bytes)
                  .mapErr(() => portFailure("cleanup-failed")),
          )
          .mapErr(() => portFailure("cleanup-failed")),
      );
    }
    return chain;
  };

  const prepareWorkspace = (): ResultAsync<void, LiveProofPortFailure> => {
    const root = join(
      system.temporaryRoot(),
      `weave-pi-live-proof-${system.uniqueToken()}`,
    );
    const workspaceDir = join(root, "workspace");
    const providerExtension = join(root, "deterministic-extension.ts");
    state.workspaceRoot = root;
    state.workspaceDir = workspaceDir;
    state.providerExtension = providerExtension;
    return system
      .makeDirectory(workspaceDir)
      .andThen(() =>
        system.writeText(
          providerExtension,
          deterministicExtensionSource(sentinel),
        ),
      )
      .mapErr(() => portFailure("spawn-failed"));
  };

  const safeCancelTimer = (timer: LiveProofTimer): void => {
    Result.fromThrowable(
      () => timer.cancel(),
      () => undefined,
    )();
  };

  type BoundedPromiseOutcome<T> =
    | { readonly kind: "resolved"; readonly value: T }
    | { readonly kind: "rejected" }
    | { readonly kind: "timeout" };

  /**
   * Observe both sides of a deadline race. The losing promise always gets a
   * rejection handler, so a late process or iterator failure cannot become an
   * unhandled rejection after the proof has already closed.
   */
  const waitBounded = <T>(
    promiseLike: PromiseLike<T>,
    timeoutMs: number,
  ): Promise<BoundedPromiseOutcome<T>> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: LiveProofTimer | undefined;
      const finish = (outcome: BoundedPromiseOutcome<T>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          safeCancelTimer(timer);
          timer = undefined;
        }
        resolve(outcome);
      };

      const observed = Result.fromThrowable(
        () => Promise.resolve(promiseLike),
        () => undefined,
      )();
      if (observed.isErr()) {
        finish({ kind: "rejected" });
        return;
      }
      observed.value.then(
        (value) => finish({ kind: "resolved", value }),
        () => finish({ kind: "rejected" }),
      );

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        finish({ kind: "timeout" });
        return;
      }
      const scheduled = Result.fromThrowable(
        () => system.setTimer(() => finish({ kind: "timeout" }), timeoutMs),
        () => undefined,
      )();
      if (scheduled.isErr()) {
        finish({ kind: "timeout" });
        return;
      }
      timer = scheduled.value;
      // A deterministic test timer may invoke its callback synchronously.
      if (settled) safeCancelTimer(timer);
    });

  const openStream = (
    process: LiveProofProcess,
  ): Result<StreamSession, LiveProofPortFailure> => {
    const iterable = Result.fromThrowable(
      () => process.lines(),
      () => portFailure("spawn-failed"),
    )();
    if (iterable.isErr()) return err(iterable.error);
    const iterator = Result.fromThrowable(
      () => iterable.value[Symbol.asyncIterator](),
      () => portFailure("spawn-failed"),
    )();
    if (iterator.isErr()) return err(iterator.error);
    return ok({
      iterator: iterator.value,
      closed: false,
    });
  };

  const closeStream = (session: StreamSession): Promise<boolean> => {
    if (session.closePromise !== undefined) return session.closePromise;
    session.closed = true;
    const cancelActiveStep = session.cancelActiveStep;
    session.cancelActiveStep = undefined;
    if (cancelActiveStep !== undefined) {
      Result.fromThrowable(cancelActiveStep, () => undefined)();
    }
    if (session.timer !== undefined) {
      safeCancelTimer(session.timer);
      session.timer = undefined;
    }

    const returned = Result.fromThrowable(
      () => session.iterator.return?.(),
      () => undefined,
    )();
    if (returned.isErr() || returned.value === undefined) {
      session.closePromise = Promise.resolve(returned.isOk());
      return session.closePromise;
    }
    session.closePromise = waitBounded(
      returned.value,
      STREAM_CLEANUP_TIMEOUT_MS,
    ).then((outcome) => outcome.kind === "resolved");
    return session.closePromise;
  };

  const nextStreamStep = (
    session: StreamSession,
    deadlineMs: number,
  ): Promise<StreamStep> => {
    if (session.closed) return Promise.resolve({ kind: "closed" });
    const now = Result.fromThrowable(
      () => system.now(),
      () => undefined,
    )();
    if (now.isErr()) return Promise.resolve({ kind: "error" });
    const remainingMs = deadlineMs - now.value;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return Promise.resolve({ kind: "timeout" });
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: LiveProofTimer | undefined;
      const finish = (step: StreamStep): void => {
        if (settled) return;
        settled = true;
        session.cancelActiveStep = undefined;
        if (session.timer === timer) session.timer = undefined;
        if (timer !== undefined) {
          safeCancelTimer(timer);
          timer = undefined;
        }
        resolve(step);
      };
      session.cancelActiveStep = () => finish({ kind: "closed" });

      const scheduled = Result.fromThrowable(
        () => system.setTimer(() => finish({ kind: "timeout" }), remainingMs),
        () => undefined,
      )();
      if (scheduled.isErr()) {
        finish({ kind: "error" });
        return;
      }
      timer = scheduled.value;
      session.timer = timer;
      // Keep the timer-first order so a line arriving at the deadline loses
      // the race deterministically.
      if (settled) {
        safeCancelTimer(timer);
        return;
      }

      const next = Result.fromThrowable(
        () => session.iterator.next(),
        () => undefined,
      )();
      if (next.isErr()) {
        finish({ kind: "error" });
        return;
      }
      const observed = Result.fromThrowable(
        () => Promise.resolve(next.value),
        () => undefined,
      )();
      if (observed.isErr()) {
        finish({ kind: "error" });
        return;
      }
      observed.value.then(
        (result) => {
          if (settled) return;
          const normalized = Result.fromThrowable(
            (): StreamStep => {
              if (typeof result !== "object" || result === null) {
                return { kind: "error" };
              }
              if (result.done === true) return { kind: "done" };
              return typeof result.value === "string"
                ? { kind: "value", value: result.value }
                : { kind: "error" };
            },
            (): undefined => undefined,
          )();
          finish(normalized.isOk() ? normalized.value : { kind: "error" });
        },
        () => finish({ kind: "error" }),
      );
    });
  };

  const terminatedProcesses = new WeakSet<LiveProofProcess>();
  const terminate = (
    process: LiveProofProcess | undefined,
  ): ResultAsync<void, LiveProofPortFailure> => {
    if (process === undefined || terminatedProcesses.has(process)) {
      return okAsync<void, LiveProofPortFailure>(undefined);
    }
    // Mark before invoking the boundary. A throwing or hanging terminate
    // implementation must not be retried by later cleanup stages.
    terminatedProcesses.add(process);
    const failedTermination = (): ResultAsync<void, LiveProofPortFailure> => {
      state.processTerminationFailed = true;
      return errAsync(portFailure("cleanup-failed"));
    };
    const invoked = Result.fromThrowable(
      () => process.terminate(),
      (): LiveProofPortFailure => portFailure("cleanup-failed"),
    )();
    if (invoked.isErr()) {
      state.processTerminationFailed = true;
      return errAsync(invoked.error);
    }
    return ResultAsync.fromPromise(
      waitBounded(invoked.value, PROCESS_TERMINATION_TIMEOUT_MS),
      (): LiveProofPortFailure => portFailure("cleanup-failed"),
    ).andThen((outcome) =>
      outcome.kind === "resolved" && outcome.value.isOk()
        ? okAsync<void, LiveProofPortFailure>(undefined)
        : failedTermination(),
    );
  };

  const timeoutOwnedStream = async (
    process: LiveProofProcess,
    session: StreamSession,
  ): Promise<void> => {
    // Start both owned cleanup operations before awaiting either one. The
    // stream may only be allowed to resolve after its process is being closed.
    const termination = terminate(process).match(
      () => undefined,
      () => undefined,
    );
    const streamClosed = closeStream(session);
    await termination;
    await streamClosed;
  };

  const readParentProofValue = async (
    parent: LiveProofProcess,
  ): Promise<
    Result<ExtensionBuildIdentityProof | undefined, LiveProofPortFailure>
  > => {
    const opened = openStream(parent);
    if (opened.isErr()) return err(portFailure("fresh-parent-failed"));
    const session = opened.value;
    state.parentStream = session;
    try {
      const started = Result.fromThrowable(
        () => system.now(),
        () => undefined,
      )();
      if (started.isErr()) return err(portFailure("fresh-parent-failed"));
      const deadline = started.value + parentProofTimeoutMs;
      while (true) {
        const step = await nextStreamStep(session, deadline);
        if (step.kind === "timeout") {
          await timeoutOwnedStream(parent, session);
          return err(portFailure("timeout"));
        }
        if (step.kind === "closed" || step.kind === "error") {
          return err(portFailure("fresh-parent-failed"));
        }
        if (step.kind === "done") return ok(undefined);
        if (!step.value.includes("weaveExtensionBuildIdentity")) continue;
        const record = parseJsonRecord(step.value);
        if (record === undefined) continue;
        const proof = parseExtensionBuildIdentityProof(record);
        if (proof.isOk()) return ok(proof.value);
      }
    } finally {
      const closed = await closeStream(session);
      if (!closed) state.streamCleanupFailed = true;
      if (state.parentStream === session) state.parentStream = undefined;
    }
  };

  const readParentProof = (
    parent: LiveProofProcess,
  ): ResultAsync<ExtensionBuildIdentityProof, LiveProofPortFailure> =>
    ResultAsync.fromPromise(
      readParentProofValue(parent),
      (): LiveProofPortFailure => portFailure("fresh-parent-failed"),
    )
      .andThen((result) => result)
      .andThen((proof) =>
        proof === undefined
          ? errAsync(portFailure("fresh-parent-failed"))
          : okAsync(proof),
      );

  const runChild = async (
    child: LiveProofProcess,
    observer: LiveProofObserver,
  ): Promise<Result<void, LiveProofPortFailure>> => {
    const opened = openStream(child);
    if (opened.isErr()) return err(portFailure("spawn-failed"));
    const session = opened.value;
    state.childStream = session;
    try {
      const started = Result.fromThrowable(
        () => system.now(),
        () => undefined,
      )();
      if (started.isErr()) return err(portFailure("lane-failed"));
      const deadline = started.value + childRunTimeoutMs;
      while (true) {
        const step = await nextStreamStep(session, deadline);
        if (step.kind === "timeout") {
          await timeoutOwnedStream(child, session);
          return err(portFailure("timeout"));
        }
        // A broken or cancelled stream is not a deadline: it must not claim
        // the child failed to settle within its budget.
        if (step.kind === "closed" || step.kind === "error") {
          return err(portFailure("lane-failed"));
        }
        if (step.kind === "done") return ok(undefined);
        if (step.value.length === 0) continue;
        const record = parseJsonRecord(step.value);
        if (record === undefined) continue;
        const ingested = Result.fromThrowable(
          () => observer.ingest(record),
          () => undefined,
        )();
        if (ingested.isErr()) return err(portFailure("lane-failed"));
        if (observer.settled()) return ok(undefined);
      }
    } finally {
      const closed = await closeStream(session);
      if (!closed) state.streamCleanupFailed = true;
      if (state.childStream === session) state.childStream = undefined;
    }
  };

  /**
   * Event consumption starts only after both live surfaces are attached, so
   * the inspector cannot miss the opening of the child's first thinking
   * block. The child process is already spawned and prompted by then.
   */
  const startChildRun = (): void => {
    const child = state.childProcess;
    const observer = state.observer;
    if (child === undefined || observer === undefined) return;
    if (state.childRun !== undefined) return;
    state.childRun = runChild(child, observer);
  };

  const awaitChildRun = (): ResultAsync<
    LiveProofObserver,
    LiveProofPortFailure
  > => {
    startChildRun();
    const observer = state.observer;
    const run = state.childRun;
    if (observer === undefined || run === undefined) {
      return errAsync(portFailure("spawn-failed"));
    }
    return ResultAsync.fromPromise(
      run,
      (): LiveProofPortFailure => portFailure("timeout"),
    )
      .andThen((result) => result)
      .map(() => observer);
  };

  const laneFrom = (
    read: (observer: LiveProofObserver) => LiveProofLaneSignal,
  ): LiveProofPortResult<LiveProofLaneSignal> =>
    awaitChildRun().map((observer) => read(observer));

  const waitForEmptyRuntime = (): ResultAsync<void, LiveProofPortFailure> => {
    const poll = (): ResultAsync<void, LiveProofPortFailure> =>
      system
        .run({
          cmd: ["bun", "packages/cli/src/main.ts", "runtime", "status"],
          cwd: config.repoRoot,
        })
        .mapErr(() => portFailure("cleanup-failed"))
        .andThen((output) =>
          output.exitCode === 0 &&
          output.stdout.includes(NO_ACTIVE_LEASE_MARKER)
            ? okAsync<void, LiveProofPortFailure>(undefined)
            : errAsync(portFailure("cleanup-failed")),
        );
    const attempt = (
      remainingMs: number,
    ): ResultAsync<void, LiveProofPortFailure> =>
      poll().orElse((failure) =>
        remainingMs <= 0
          ? errAsync(failure)
          : system
              .delay(LEASE_POLL_INTERVAL_MS)
              .mapErr(() => portFailure("cleanup-failed"))
              .andThen(() => attempt(remainingMs - LEASE_POLL_INTERVAL_MS)),
      );
    return attempt(leaseWaitTimeoutMs);
  };

  return {
    readCurrentIdentity: (
      input,
    ): LiveProofPortResult<LiveProofCurrentIdentityObservation> =>
      snapshotGuarded().andThen(() =>
        verifyIdentity({ repoRoot: config.repoRoot, pi: input.pi })
          .map((success) => {
            state.pi = input.pi;
            state.identityVerifiedAtMs = system.now();
            state.artifactSha256 = success.artifactSha256;
            return {
              currentBuild: "current" as const,
              runtimeLoaded: true,
              artifactComplete: true,
            };
          })
          .orElse((failure) =>
            okAsync<LiveProofCurrentIdentityObservation, LiveProofPortFailure>({
              currentBuild: identityResult(failure),
              runtimeLoaded: false,
              artifactComplete: false,
            }),
          ),
      ),

    launchFreshParent: (
      input,
    ): LiveProofPortResult<LiveProofFreshParentLaunch> => {
      const verifiedAtMs = state.identityVerifiedAtMs;
      const artifactSha256 = state.artifactSha256;
      if (verifiedAtMs === undefined || artifactSha256 === undefined) {
        return errAsync(portFailure("identity-current-failed"));
      }
      return prepareWorkspace().andThen(() => {
        const workspaceDir = state.workspaceDir;
        const providerExtension = state.providerExtension;
        if (workspaceDir === undefined || providerExtension === undefined) {
          return errAsync(portFailure("spawn-failed"));
        }
        const environment = safeProofEnvironment(system.environment());
        environment[EXTENSION_BUILD_IDENTITY_PROOF_ENV] = "1";
        const spawned = system.spawn({
          cmd: [
            input.pi,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "-e",
            join(config.repoRoot, EXTENSION_RELATIVE_PATH),
          ],
          cwd: config.repoRoot,
          env: environment,
        });
        if (spawned.isErr())
          return errAsync(portFailure("fresh-parent-failed"));
        state.parentProcess = spawned.value;
        return readParentProof(spawned.value).andThen((proof) => {
          const parent: LiveProofParentHandle = Object.freeze({
            kind: "live-proof-parent",
          });
          state.parentHandle = parent;
          const loadedOutputs = proof.loadedOutputs ?? [];
          const runtimeLoaded =
            loadedOutputs.length > 0 &&
            loadedOutputs.every((output) =>
              /^[0-9a-f]{64}$/u.test(output.sha256),
            );
          const artifactComplete = proof.artifactSha256 === artifactSha256;
          // A reload inside an already-open parent cannot satisfy this: the
          // process must have started after the verified artifact was proven.
          const startedAfterArtifact =
            typeof proof.processStartMs === "number" &&
            Number.isSafeInteger(proof.processStartMs) &&
            proof.processStartMs >= verifiedAtMs;
          const loadedAfterStart =
            typeof proof.loadTimeMs === "number" &&
            Number.isSafeInteger(proof.loadTimeMs) &&
            typeof proof.processStartMs === "number" &&
            proof.loadTimeMs >= proof.processStartMs;
          return okAsync({
            parent,
            freshParent:
              startedAfterArtifact && loadedAfterStart && artifactComplete
                ? ("fresh" as const)
                : ("stale" as const),
            runtimeLoaded,
            artifactComplete,
          });
        });
      });
    },

    delegateDeterministicChild:
      (): LiveProofPortResult<LiveProofChildHandle> => {
        // Exactly one child per run. A second request is a proof defect, not a
        // recoverable condition.
        if (state.childCount > 0) return errAsync(portFailure("spawn-failed"));
        const workspaceDir = state.workspaceDir;
        const providerExtension = state.providerExtension;
        const pi = state.pi;
        if (
          workspaceDir === undefined ||
          providerExtension === undefined ||
          pi === undefined
        ) {
          return errAsync(portFailure("spawn-failed"));
        }
        const spawned = system.spawn({
          cmd: [
            pi,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "-e",
            providerExtension,
            "--provider",
            "weave-live-proof-deterministic",
            "--model",
            "live-proof-deterministic-1",
          ],
          cwd: workspaceDir,
          env: safeProofEnvironment(system.environment()),
        });
        if (spawned.isErr()) return errAsync(portFailure("spawn-failed"));
        const child = spawned.value;
        state.childProcess = child;
        state.childCount += 1;
        const observer = createLiveProofObserver(sentinel);
        state.observer = observer;
        const prompted = child.writeLine(
          JSON.stringify({ type: "prompt", message: CHILD_PROMPT_TEXT }),
        );
        if (prompted.isErr()) return errAsync(portFailure("spawn-failed"));
        const handle: LiveProofChildHandle = Object.freeze({
          kind: "live-proof-child",
        });
        state.childHandle = handle;
        return okAsync(handle);
      },

    selectLiveInspector: (): LiveProofPortResult<LiveProofInspectorHandle> => {
      const observer = state.observer;
      if (
        observer === undefined ||
        state.childProcess?.running() !== true ||
        !observer.selectInspector()
      ) {
        return errAsync(portFailure("lane-failed"));
      }
      const inspector: LiveProofInspectorHandle = Object.freeze({
        kind: "live-proof-inspector",
      });
      state.inspectorHandle = inspector;
      startChildRun();
      return okAsync(inspector);
    },

    observeParentRawReasoning: () =>
      laneFrom((observer) => observer.parentReasoningLane()),
    observeInspectorRawReasoning: () =>
      laneFrom((observer) => observer.inspectorReasoningSignal()),
    observeInspectorToolDetails: () =>
      laneFrom((observer) => observer.inspectorToolSignal()),
    observeInspectorAssistantReply: () =>
      laneFrom((observer) => observer.inspectorAssistantSignal()),

    readSettlement: (): LiveProofPortResult<LiveProofSettlementObservation> =>
      awaitChildRun().map((observer) => observer.settlement(state.childCount)),
    readIsolation: (): LiveProofPortResult<LiveProofIsolationObservation> =>
      awaitChildRun().map((observer) => observer.isolation()),
    readRegistry: (): LiveProofPortResult<LiveProofRegistryObservation> =>
      awaitChildRun().map((observer) => observer.registrySnapshot()),
    readDiagnostics: (): LiveProofPortResult<LiveProofDiagnosticsObservation> =>
      awaitChildRun().map((observer) => observer.diagnosticsSnapshot()),

    cleanupRuntime: (): LiveProofPortResult<void> => {
      state.observer?.release();
      const closeStreams = Promise.all(
        [state.parentStream, state.childStream]
          .filter((session): session is StreamSession => session !== undefined)
          .map((session) => closeStream(session)),
      ).then((results) => results.every(Boolean));
      const cleanup = (async (): Promise<
        Result<void, LiveProofPortFailure>
      > => {
        const streamsClosed = await closeStreams;
        const child = await terminate(state.childProcess);
        const parent = await terminate(state.parentProcess);
        if (
          streamsClosed &&
          child.isOk() &&
          parent.isOk() &&
          !state.streamCleanupFailed &&
          !state.processTerminationFailed
        ) {
          return ok(undefined);
        }
        return err(portFailure("cleanup-failed"));
      })();
      return ResultAsync.fromPromise(
        cleanup,
        (): LiveProofPortFailure => portFailure("cleanup-failed"),
      ).andThen((result) => result);
    },
    cleanupProcess: (): LiveProofPortResult<void> => {
      const stillRunning =
        state.childProcess?.running() === true ||
        state.parentProcess?.running() === true;
      return stillRunning
        ? errAsync(portFailure("cleanup-failed"))
        : okAsync<void, LiveProofPortFailure>(undefined);
    },
    cleanupTemp: (): LiveProofPortResult<void> => {
      const root = state.workspaceRoot;
      if (root === undefined) return okAsync(undefined);
      return system
        .removePath(root)
        .mapErr(() => portFailure("cleanup-failed"));
    },
    cleanupPane: (): LiveProofPortResult<void> =>
      // This command owns no Herdr pane: it never opens one. Restoring the
      // guarded host resources is the last owned effect to release.
      waitForEmptyRuntime().andThen(() => restoreGuarded()),
  };
}
