import { posix } from "node:path";
import type {
  PlanTaskSnapshot,
  PlanTaskSnapshotError,
  PlanTaskSnapshotReader,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  type Result as NeverthrowResult,
  ok,
  Result,
  ResultAsync,
} from "neverthrow";
import { normalizePath } from "./normalize-path.js";
import {
  MAX_PLAN_BYTES,
  MAX_PLAN_NAME_LENGTH,
  parsePlanTasks,
} from "./plan-task-parser.js";

export type PlanTaskFileIoError =
  | { readonly type: "Missing" | "Unreadable"; readonly path: string }
  | {
      readonly type: "TooLarge";
      readonly path: string;
      readonly actual: number;
    };
export interface PlanTaskPathInfo {
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

export interface PlanTaskFileReader {
  readBytes(path: string): ResultAsync<Uint8Array, PlanTaskFileIoError>;
  realpath(path: string): ResultAsync<string, PlanTaskFileIoError>;
  lstat(path: string): ResultAsync<PlanTaskPathInfo, PlanTaskFileIoError>;
}

const runProcess = ResultAsync.fromThrowable(
  async (command: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    return { exitCode, stdout };
  },
  (): PlanTaskFileIoError => ({ type: "Unreadable", path: "<process>" }),
);

/** Bun-only default I/O. Tests and adapters can inject a stricter host reader. */
export class BunPlanTaskFileReader implements PlanTaskFileReader {
  readBytes(path: string): ResultAsync<Uint8Array, PlanTaskFileIoError> {
    return ResultAsync.fromThrowable(
      async () => {
        const file = Bun.file(path);
        if (file.size > MAX_PLAN_BYTES) {
          throw {
            type: "TooLarge",
            path,
            actual: file.size,
          } satisfies PlanTaskFileIoError;
        }
        return new Uint8Array(await file.arrayBuffer());
      },
      (cause): PlanTaskFileIoError => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "type" in cause &&
          cause.type === "TooLarge" &&
          "actual" in cause &&
          typeof cause.actual === "number"
        ) {
          return { type: "TooLarge", path, actual: cause.actual };
        }
        return { type: "Unreadable", path };
      },
    )();
  }

  realpath(path: string): ResultAsync<string, PlanTaskFileIoError> {
    return runProcess(["realpath", path]).andThen(({ exitCode, stdout }) => {
      if (exitCode !== 0) return err({ type: "Missing" as const, path });
      return ok(normalizePath(stdout.trim()));
    });
  }

  lstat(path: string): ResultAsync<PlanTaskPathInfo, PlanTaskFileIoError> {
    return runProcess(["test", "-L", path]).andThen(
      ({ exitCode: symlinkCode }) => {
        if (symlinkCode === 0) return ok({ isFile: false, isSymlink: true });
        return runProcess(["test", "-f", path]).map(
          ({ exitCode: fileCode }) => ({
            isFile: fileCode === 0,
            isSymlink: false,
          }),
        );
      },
    );
  }
}

function validatePlanName(
  planName: string,
): NeverthrowResult<void, PlanTaskSnapshotError> {
  if (
    planName.length > 0 &&
    planName.length <= MAX_PLAN_NAME_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(planName)
  )
    return ok();
  return err({
    type: "InvalidPlanName",
    planName,
    reason:
      "plan names must contain 1 to 128 letters, numbers, underscores, or hyphens",
  });
}

function isContained(parent: string, candidate: string): boolean {
  const relative = posix.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}

function decodePlan(
  bytes: Uint8Array,
  planName: string,
): NeverthrowResult<string, PlanTaskSnapshotError> {
  return Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    (): PlanTaskSnapshotError => ({
      type: "PlanMalformed",
      planName,
      reason: "plan is not valid UTF-8",
    }),
  )();
}

function hashPlan(
  bytes: Uint8Array,
  planName: string,
): NeverthrowResult<string, PlanTaskSnapshotError> {
  return Result.fromThrowable(
    () => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    (): PlanTaskSnapshotError => ({
      type: "PlanUnreadable",
      planName,
      reason: "could not hash plan bytes",
    }),
  )();
}

export class ConfigPlanTaskReader implements PlanTaskSnapshotReader {
  private readonly location: string;

  constructor(
    location: string,
    private readonly files: PlanTaskFileReader = new BunPlanTaskFileReader(),
  ) {
    this.location = normalizePath(location);
  }

  readSnapshot(
    planName: string,
  ): ResultAsync<PlanTaskSnapshot, PlanTaskSnapshotError> {
    const valid = validatePlanName(planName);
    if (valid.isErr()) return errAsync(valid.error);
    return ResultAsync.fromPromise(
      this.readContained(planName),
      (): PlanTaskSnapshotError => ({
        type: "PlanUnreadable",
        planName,
        reason: "unexpected plan read failure",
      }),
    ).andThen((result) => result);
  }

  private async readContained(
    planName: string,
  ): Promise<NeverthrowResult<PlanTaskSnapshot, PlanTaskSnapshotError>> {
    const weave = posix.join(this.location, ".weave");
    const plans = posix.join(weave, "plans");
    const candidate = posix.join(plans, `${planName}.md`);
    let candidateInfo: PlanTaskPathInfo | undefined;
    for (const path of [this.location, weave, plans, candidate]) {
      const info = await this.files.lstat(path);
      if (info.isErr()) return this.ioError(planName, info.error);
      if (info.value.isSymlink) {
        return err({
          type: "PlanPathUnsafe",
          planName,
          reason: "symbolic links are not allowed in the selected plan path",
        });
      }
      if (path === candidate) candidateInfo = info.value;
    }

    if (candidateInfo?.isFile !== true)
      return err({ type: "PlanMissing", planName });

    const canonicalLocation = await this.files.realpath(this.location);
    if (canonicalLocation.isErr())
      return this.ioError(planName, canonicalLocation.error);
    const canonicalCandidate = await this.files.realpath(candidate);
    if (canonicalCandidate.isErr())
      return this.ioError(planName, canonicalCandidate.error);
    if (!isContained(canonicalLocation.value, canonicalCandidate.value)) {
      return err({
        type: "PlanPathUnsafe",
        planName,
        reason: "the selected plan resolves outside its Location",
      });
    }

    const read = await this.files.readBytes(candidate);
    if (read.isErr()) return this.ioError(planName, read.error);
    if (read.value.byteLength > MAX_PLAN_BYTES) {
      return err({
        type: "PlanLimitExceeded",
        planName,
        limit: "bytes",
        actual: read.value.byteLength,
        maximum: MAX_PLAN_BYTES,
      });
    }
    const decoded = decodePlan(read.value, planName);
    if (decoded.isErr()) return err(decoded.error);
    const revision = hashPlan(read.value, planName);
    if (revision.isErr()) return err(revision.error);
    return parsePlanTasks({
      planName,
      contentRevision: revision.value,
      markdown: decoded.value,
    });
  }

  private ioError(
    planName: string,
    error: PlanTaskFileIoError,
  ): NeverthrowResult<never, PlanTaskSnapshotError> {
    if (error.type === "Missing") return err({ type: "PlanMissing", planName });
    if (error.type === "TooLarge") {
      return err({
        type: "PlanLimitExceeded",
        planName,
        limit: "bytes",
        actual: error.actual,
        maximum: MAX_PLAN_BYTES,
      });
    }
    return err({
      type: "PlanUnreadable",
      planName,
      reason: "plan path could not be read",
    });
  }
}
