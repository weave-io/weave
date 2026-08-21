import { resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  createCleanupClock,
  runBoundedCommand,
  signalPidQuietly,
  waitForHandles,
} from "./command-runner.js";
import {
  CLEANUP_FORCE_TIMEOUT_MS,
  CLEANUP_GRACE_TIMEOUT_MS,
  CLEANUP_PROBE_TIMEOUT_MS,
  CLEANUP_ROOT_MAX_ATTEMPTS,
  CLEANUP_ROOT_TIMEOUT_MS,
  CLEANUP_VERIFICATION_KEYS,
  type CleanupDiagnosticCode,
  type CleanupResourceTracker,
  type CleanupRootOptions,
  type CleanupVerification,
  failure,
  isRecord,
  type ScenarioObservation,
  type SmokeFailure,
} from "./contract.js";
import { isEphemeralPath } from "./environment.js";
import { defaultObserveProcesses } from "./process-observer.js";
export function verifiedCleanup(
  observation: ScenarioObservation,
): Result<CleanupVerification, SmokeFailure> {
  if (observation.cleanup === undefined)
    return err(
      failure("CaptureMalformed", "cleanup has no independent verification"),
    );
  const verified = Result.fromThrowable(
    () => {
      const value: unknown = observation.cleanup;
      if (!isRecord(value)) return undefined;
      const keys = Object.keys(value);
      if (
        keys.length !== CLEANUP_VERIFICATION_KEYS.length ||
        CLEANUP_VERIFICATION_KEYS.some((key) => !keys.includes(key))
      )
        return undefined;
      for (const key of CLEANUP_VERIFICATION_KEYS)
        if (typeof value[key] !== "boolean") return undefined;
      return {
        noChildProcess: value.noChildProcess as boolean,
        noNativeChild: value.noNativeChild as boolean,
        noActiveLease: value.noActiveLease as boolean,
        noTemporaryPane: value.noTemporaryPane as boolean,
        noFixtureProcess: value.noFixtureProcess as boolean,
        noPiProcess: value.noPiProcess as boolean,
        noHelperProcess: value.noHelperProcess as boolean,
        temporaryRootRemoved: value.temporaryRootRemoved as boolean,
        timersDisposed: value.timersDisposed as boolean,
        resourcesDisposed: value.resourcesDisposed as boolean,
      };
    },
    () => undefined,
  )();
  if (verified.isErr() || verified.value === undefined)
    return err(failure("CaptureMalformed", "cleanup verification is invalid"));
  return ok(verified.value);
}
async function defaultObserveLease(input: {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly tracker: CleanupResourceTracker;
  readonly runtimeStatusCommand?: CleanupRootOptions["runtimeStatusCommand"];
}): Promise<Result<boolean, CleanupDiagnosticCode>> {
  if (input.runtimeStatusCommand === undefined)
    return err("lease-observation-failed");
  const status = await runBoundedCommand(input.runtimeStatusCommand.args, {
    cwd: input.runtimeStatusCommand.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, CLEANUP_PROBE_TIMEOUT_MS),
    resources: input.tracker,
    processKind: "helper",
  });
  if (status.isErr()) return err("lease-observation-failed");
  const output = `${status.value.stdout}\n${status.value.stderr}`;
  if (
    output.includes("No active lease.") ||
    output.includes("No runtime store found")
  )
    return ok(true);
  if (output.includes("Active Lease")) return ok(false);
  return err("lease-observation-failed");
}

async function defaultRemoveRoot(input: {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly tracker: CleanupResourceTracker;
}): Promise<Result<void, CleanupDiagnosticCode>> {
  const removed = await runBoundedCommand(["rm", "-rf", "--", input.root], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, CLEANUP_ROOT_TIMEOUT_MS),
    resources: input.tracker,
    processKind: "helper",
  });
  return removed.isErr() ? err("root-remove-failed") : ok(undefined);
}

async function performCleanupRoot(
  root: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options: CleanupRootOptions,
  tracker: CleanupResourceTracker,
): Promise<Result<CleanupVerification, SmokeFailure>> {
  if (tracker.root !== resolve(root) || !isEphemeralPath(root))
    return err(failure("CleanupFailed", "root-not-owned"));

  const hooks = options.hooks ?? {};
  const clock = hooks.clock ?? createCleanupClock();
  const observe = hooks.observeProcesses ?? defaultObserveProcesses;
  const lease =
    hooks.observeLease ??
    ((input) =>
      defaultObserveLease({
        ...input,
        runtimeStatusCommand: options.runtimeStatusCommand,
      }));
  const removeRoot = hooks.removeRoot ?? defaultRemoveRoot;
  const exists =
    hooks.pathExists ??
    (async (path: string) => {
      const result = await runBoundedCommand(["test", "-e", path], {
        cwd,
        env,
        timeoutMs: Math.min(timeoutMs, CLEANUP_PROBE_TIMEOUT_MS),
        resources: tracker,
        processKind: "helper",
        allowExitCodes: [1],
      });
      if (result.isErr()) return err("root-still-present");
      return ok(result.value.code === 0);
    });

  const initiallyDisposed = await tracker.disposeResources();
  const initialHandles = [...tracker.processHandles];
  for (const handle of initialHandles) handle.terminate?.("SIGTERM");
  const initial = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (initial.isErr()) {
    await waitForHandles(initialHandles, CLEANUP_GRACE_TIMEOUT_MS, clock);
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", initial.error));
  }
  const initialPids = new Set(initial.value.pids);
  for (const pid of initialPids) signalPidQuietly(pid, "SIGTERM");
  await waitForHandles(initialHandles, CLEANUP_GRACE_TIMEOUT_MS, clock);
  tracker.pruneExited();
  const afterGrace = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (afterGrace.isErr()) {
    for (const pid of initialPids) signalPidQuietly(pid, "SIGKILL");
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", afterGrace.error));
  }
  const gracefulSurvivors = new Set(afterGrace.value.pids);
  for (const handle of tracker.processHandles) {
    if (handle.pid !== undefined) gracefulSurvivors.add(handle.pid);
  }
  for (const handle of tracker.processHandles) handle.terminate?.("SIGKILL");
  for (const pid of gracefulSurvivors) signalPidQuietly(pid, "SIGKILL");
  await waitForHandles(
    [...tracker.processHandles],
    CLEANUP_FORCE_TIMEOUT_MS,
    clock,
  );
  tracker.pruneExited();
  const finalProcesses = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (finalProcesses.isErr()) {
    for (const pid of gracefulSurvivors) signalPidQuietly(pid, "SIGKILL");
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", finalProcesses.error));
  }
  if (
    tracker.processHandles.length > 0 ||
    finalProcesses.value.pids.length > 0
  ) {
    return err(failure("CleanupFailed", "process-survivor"));
  }

  const leaseResult = await lease({ cwd, env, timeoutMs, tracker });
  if (leaseResult.isErr())
    return err(failure("CleanupFailed", leaseResult.error));
  if (!leaseResult.value) return err(failure("CleanupFailed", "active-lease"));

  const resourceDisposed =
    initiallyDisposed && (await tracker.disposeResources());
  if (!resourceDisposed || tracker.activeResourceCount !== 0)
    return err(failure("CleanupFailed", "resource-still-open"));

  // Root removal is the expensive operation. Give each attempt its own
  // bounded budget and let the existence probe, not the command exit status,
  // decide whether an idempotent attempt succeeded. A timed-out `rm` may have
  // finished deleting the tree before its wrapper observed the timeout.
  let rootRemoved = false;
  for (let attempt = 0; attempt < CLEANUP_ROOT_MAX_ATTEMPTS; attempt += 1) {
    const removed = await ResultAsync.fromThrowable(
      () =>
        removeRoot({
          root,
          cwd,
          env,
          timeoutMs: Math.min(timeoutMs, CLEANUP_ROOT_TIMEOUT_MS),
          tracker,
        }),
      () => "root-remove-failed" as const,
    )();
    const rootExists = await exists(root);
    if (rootExists.isErr())
      return err(failure("CleanupFailed", rootExists.error));
    if (!rootExists.value) {
      // A remove error is acceptable only because the independent probe proves
      // that the owned root is gone. Any helper survivor still fails closed.
      if (removed.isErr()) tracker.pruneExited();
      if (tracker.processHandles.length > 0)
        return err(failure("CleanupFailed", "process-survivor"));
      rootRemoved = true;
      break;
    }
  }
  if (!rootRemoved) return err(failure("CleanupFailed", "root-still-present"));
  for (const ownedPath of tracker.ownedPaths) {
    const present = await exists(ownedPath);
    if (present.isErr()) return err(failure("CleanupFailed", present.error));
    if (present.value)
      return err(failure("CleanupFailed", "root-still-present"));
  }

  const verification: CleanupVerification = {
    noChildProcess: finalProcesses.value.childPids.length === 0,
    noNativeChild: finalProcesses.value.childPids.length === 0,
    noActiveLease: leaseResult.value,
    noTemporaryPane: finalProcesses.value.panePids.length === 0,
    noFixtureProcess: finalProcesses.value.fixturePids.length === 0,
    noPiProcess: finalProcesses.value.piTuiPids.length === 0,
    noHelperProcess: finalProcesses.value.helperPids.length === 0,
    temporaryRootRemoved: true,
    timersDisposed: true,
    resourcesDisposed: true,
  };
  return ok(verification);
}

export async function cleanupRoot(
  root: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options: CleanupRootOptions = {},
): Promise<Result<CleanupVerification, SmokeFailure>> {
  if (options.tracker === undefined)
    return err(failure("CleanupFailed", "root-not-owned"));
  const tracker = options.tracker;
  const remembered = tracker.rememberedCleanup();
  if (remembered !== undefined) return remembered;
  const inFlight = tracker.cleanupInFlight();
  if (inFlight !== undefined) return inFlight;
  const promise = (async (): Promise<
    Result<CleanupVerification, SmokeFailure>
  > => {
    const result = await ResultAsync.fromThrowable(
      () => performCleanupRoot(root, cwd, env, timeoutMs, options, tracker),
      () => failure("CleanupFailed", "resource-dispose-failed"),
    )();
    return result.isErr() ? err(result.error) : result.value;
  })();
  tracker.rememberCleanupInFlight(promise);
  const result = await promise;
  tracker.rememberCleanup(result);
  return result;
}
