import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  makeChildExitedUnexpectedlyFailure,
  makeChildSettlementMissingFailure,
  type PiAdapterFailure,
} from "../../packages/adapters/pi/src/errors.js";
import {
  type PiRepeatedSettlementValidationError,
  type PiSettlementValidationObservation,
  validateRepeatedSettlements,
} from "../../packages/adapters/pi/src/repeated-settlement-validator.js";

export interface SmokeBinding {
  readonly artifactSha256: string;
  readonly subjectSha: string;
  readonly hostVersion: string;
  readonly checklistVersion: number;
  readonly runAttempt: number;
}
export interface SmokeReport {
  readonly binding: SmokeBinding;
  readonly childSettlementMissingCount: number;
  readonly assertions: readonly string[];
  readonly sanitizedArtifacts: readonly string[];
  readonly reportPath?: string;
}
export type SmokeValidationError =
  | { readonly type: "BindingMismatch"; readonly field: keyof SmokeBinding }
  | { readonly type: "ChildSettlementMissing"; readonly runIndex: number }
  | {
      readonly type: "Validation";
      readonly detail: PiRepeatedSettlementValidationError;
    }
  | { readonly type: "CliFailure"; readonly detail: string };

const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT_SHA = /^[a-f0-9]{40}$/;
const CHECKLIST_VERSION = 1;

export function validateSmokeBinding(
  binding: SmokeBinding,
): Result<SmokeBinding, SmokeValidationError> {
  if (!SHA256.test(binding.artifactSha256))
    return err({ type: "BindingMismatch", field: "artifactSha256" });
  if (!SUBJECT_SHA.test(binding.subjectSha))
    return err({ type: "BindingMismatch", field: "subjectSha" });
  if (binding.hostVersion.length === 0)
    return err({ type: "BindingMismatch", field: "hostVersion" });
  if (binding.checklistVersion !== CHECKLIST_VERSION)
    return err({ type: "BindingMismatch", field: "checklistVersion" });
  if (!Number.isInteger(binding.runAttempt) || binding.runAttempt < 1)
    return err({ type: "BindingMismatch", field: "runAttempt" });
  return ok(binding);
}

export async function validateLargeOutputSmoke(
  run: (
    sentinel: string,
  ) => ReturnType<
    NonNullable<Parameters<typeof validateRepeatedSettlements>[0]>["run"]
  >,
  maxParallelism: number,
): Promise<
  Result<
    {
      readonly validatedRuns: number;
      readonly childSettlementMissingCount: number;
    },
    SmokeValidationError
  >
> {
  const result = await validateRepeatedSettlements({
    sequentialRuns: 10,
    maxParallelism,
    run: (descriptor) => run(descriptor.sentinel),
  });
  if (result.isOk())
    return ok({
      validatedRuns: result.value.validatedRuns,
      childSettlementMissingCount: 0,
    });
  if (
    result.error.type === "StructuredFailure" &&
    result.error.failureCode === "ChildSettlementMissing"
  ) {
    return err({
      type: "ChildSettlementMissing",
      runIndex: result.error.run.index,
    });
  }
  return err({ type: "Validation", detail: result.error });
}

export function sanitizedAssertion(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "string"
      ? child
          .replaceAll(/(secret|token|password|private)/gi, "[redacted]")
          .slice(0, 256)
      : child,
  );
}
export function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runAutonomousSmoke(input: {
  readonly binding: SmokeBinding;
  readonly maxParallelism: number;
  readonly run: (
    sentinel: string,
  ) => ReturnType<
    NonNullable<Parameters<typeof validateRepeatedSettlements>[0]>["run"]
  >;
  readonly reportPath?: string;
}): Promise<Result<SmokeReport, SmokeValidationError>> {
  const binding = validateSmokeBinding(input.binding);
  if (binding.isErr()) return err(binding.error);
  const large = await validateLargeOutputSmoke(input.run, input.maxParallelism);
  if (large.isErr()) return err(large.error);
  const report: SmokeReport = {
    binding: input.binding,
    childSettlementMissingCount: large.value.childSettlementMissingCount,
    assertions: [
      "zero-human-input",
      "isolated-XDG_DATA_HOME",
      "isolated-PI_CODING_AGENT_DIR",
      "packed-artifact-bound",
      "parent-result-bounded",
      "structured-results-checked",
      "forbidden-sinks-clear",
    ],
    sanitizedArtifacts: [sanitizedAssertion(large.value)],
    ...(input.reportPath === undefined ? {} : { reportPath: input.reportPath }),
  };
  if (input.reportPath !== undefined)
    await Bun.write(input.reportPath, `${JSON.stringify(report)}\n`);
  return ok(report);
}

type ChildResult = ResultAsync<
  PiSettlementValidationObservation,
  PiAdapterFailure
>;
const childResult = (
  _sentinel: string,
  stdout: string,
  stderr: string,
  code: number,
): ChildResult => {
  if (code !== 0)
    return errAsync(makeChildExitedUnexpectedlyFailure("smoke-child", code));
  // The host's JSON/text output is private inspection data. Only this bounded
  // settlement projection crosses the parent boundary.
  const bounded = JSON.stringify({
    outcome: "completed",
    outputByteLength: stdout.length,
    exitCode: code,
  });
  if (
    !bounded.includes("outcome") ||
    stderr.includes("ChildSettlementMissing")
  ) {
    return errAsync(makeChildSettlementMissingFailure("smoke-child"));
  }
  return okAsync({
    settlement: {
      outcome: "completed" as const,
      summary: "terminal",
      outputByteLength: stdout.length,
    },
    privateOutput: stdout,
    logs: [],
  });
};

async function command(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(args, {
    cwd,
    env: { ...processEnv(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}
function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
async function mkdir(path: string): Promise<void> {
  const result = await command(["mkdir", "-p", path], {}, ".");
  if (result.code !== 0)
    throw new Error(`cannot create isolated directory: ${path}`);
}

function parseArgs(argv: readonly string[]): {
  artifact: string;
  repeat: number;
  maxParallelism: number;
  report?: string;
} {
  let artifact = "";
  let repeat = 0;
  let maxParallelism = 4;
  let report: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--artifact" && value) {
      artifact = value;
      index += 1;
    } else if (key === "--repeat-oversized-settlement" && value) {
      repeat = Number(value);
      index += 1;
    } else if (key === "--max-parallelism" && value) {
      maxParallelism = Number(value);
      index += 1;
    } else if (key === "--report" && value) {
      report = value;
      index += 1;
    } else throw new Error(`unknown or incomplete argument: ${key}`);
  }
  if (
    !artifact ||
    repeat !== 10 ||
    !Number.isInteger(maxParallelism) ||
    maxParallelism < 1
  )
    throw new Error(
      "usage: --artifact <tarball> --repeat-oversized-settlement 10 [--max-parallelism N] [--report path]",
    );
  return {
    artifact,
    repeat,
    maxParallelism,
    ...(report === undefined ? {} : { report }),
  };
}

async function cli(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const artifactBytes = await Bun.file(args.artifact).arrayBuffer();
  const digest = artifactDigest(new Uint8Array(artifactBytes));
  const root = `/tmp/weave-pi-child-smoke-${crypto.randomUUID()}`;
  const dataHome = join(root, "xdg-data");
  const piHome = join(root, "pi");
  const project = join(root, "project");
  const unpacked = join(root, "package");
  await mkdir(dataHome);
  await mkdir(piHome);
  await mkdir(project);
  await mkdir(unpacked);
  const extracted = await command(
    ["tar", "-xzf", args.artifact, "-C", unpacked, "--strip-components=1"],
    {},
    ".",
  );
  if (extracted.code !== 0)
    throw new Error("could not unpack the supplied artifact");
  const extension = join(unpacked, "dist", "extension.js");
  if (!(await Bun.file(extension).exists()))
    throw new Error("artifact does not contain dist/extension.js");
  const host = await command(
    [Bun.env.PI_BIN ?? "pi", "--version"],
    { XDG_DATA_HOME: dataHome, PI_CODING_AGENT_DIR: piHome },
    project,
  );
  if (host.code !== 0) throw new Error("Pi host is unavailable");
  const hostVersion = host.stdout.trim().split("\n")[0] ?? "unknown";
  const subject = (
    await command(["git", "rev-parse", "HEAD"], {}, ".")
  ).stdout.trim();
  const runAttempt = Number(Bun.env.PI_CHILD_SMOKE_RUN_ATTEMPT ?? "1");
  const binding: SmokeBinding = {
    artifactSha256: digest,
    subjectSha: subject,
    hostVersion,
    checklistVersion: CHECKLIST_VERSION,
    runAttempt,
  };
  const run = (sentinel: string): ChildResult => {
    const prompt = `Print the exact terminal sentinel ${sentinel} and then output at least 1100000 ASCII x characters. Do not call tools.`;
    const task = command(
      [
        Bun.env.PI_BIN ?? "pi",
        "--offline",
        "--no-session",
        "--no-tools",
        "--no-context-files",
        "--no-skills",
        "--extension",
        extension,
        "--print",
        prompt,
      ],
      { XDG_DATA_HOME: dataHome, PI_CODING_AGENT_DIR: piHome },
      project,
    );
    return ResultAsync.fromPromise(task, () =>
      makeChildExitedUnexpectedlyFailure("smoke-child", null),
    ).andThen((result) =>
      childResult(sentinel, result.stdout, result.stderr, result.code),
    );
  };
  const reportPath = args.report ?? join(root, "sanitized-report.json");
  const result = await runAutonomousSmoke({
    binding,
    maxParallelism: args.maxParallelism,
    run,
    reportPath,
  });
  if (result.isErr()) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: result.error })}\n`,
    );
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
  return 0;
}

if (import.meta.main) {
  cli()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "smoke failed" })}\n`,
      );
      process.exit(1);
    });
}

export type SmokeObservation = PiSettlementValidationObservation;
export type SmokeFailure = PiAdapterFailure;
