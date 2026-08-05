import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
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
export const CHECKLIST_VERSION = 2;
const MAX_EVIDENCE_BYTES = 256_000;
const SMOKE_ROWS = [
  "S024-native-and-fallback-rendering",
  "S025-narrow-width",
  "S026-steer",
  "S027-follow-up-and-extension-ui",
  "S028-interrupt-and-restart",
  "S029-isolated-persistence",
  "S030-private-projection",
  "S031-bounded-result",
  "S032-oversized-native-record",
  "S033-explicit-cleanup-tombstone",
  "S034-invalid-settings",
  "S035-fresh-resume",
  "S036-structured-settlement-failure",
] as const;

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

/** Keep evidence bounded and remove private child material before it is persisted. */
export function sanitizedAssertion(value: unknown): string {
  const text = JSON.stringify(value, (_key, child) =>
    typeof child === "string"
      ? child
          .replaceAll(/(secret|token|password|private|canary)/gi, "[redacted]")
          .slice(0, 256)
      : child,
  );
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
}
export function artifactDigest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
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
      "real-pty",
      "zero-human-input",
      "isolated-XDG_DATA_HOME",
      "isolated-PI_CODING_AGENT_DIR",
      "exact-packed-artifact",
      "extension-ui-and-commands",
      ...SMOKE_ROWS,
      "forbidden-sinks-clear",
    ],
    sanitizedArtifacts: [
      sanitizedAssertion({
        validatedRuns: large.value.validatedRuns,
        childSettlementMissingCount: 0,
      }),
    ],
    ...(input.reportPath === undefined ? {} : { reportPath: input.reportPath }),
  };
  return ok(report);
}

type ChildResult = ResultAsync<
  PiSettlementValidationObservation,
  PiAdapterFailure
>;

async function command(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function copyPrivateMaterial(
  source: string,
  destination: string,
): Promise<void> {
  // These are the only caller-owned Pi files copied. Their bytes are never read by
  // this process and they never enter stdout, stderr, reports, or proof artifacts.
  for (const name of [
    "auth.json",
    "models.json",
    "models-store.json",
  ] as const) {
    const from = join(source, name);
    if (!(await Bun.file(from).exists())) continue;
    const to = join(destination, name);
    await Bun.write(to, await Bun.file(from).bytes());
    const chmod = Bun.spawn(["chmod", "600", to]);
    if ((await chmod.exited) !== 0)
      throw new Error("could not restrict Pi auth material");
  }
}

async function writeFixture(path: string): Promise<void> {
  await Bun.write(
    path,
    `export default function(pi) {\n  pi.registerCommand("smoke-fixture", { description: "release smoke fixture", handler: async (args, ctx) => {\n    const sentinel = String(args || "").trim();\n    const nativeRecord = JSON.stringify({ type: "message_end", message: { role: "assistant", content: "x".repeat(1_100_000) } });\n    if (new TextEncoder().encode(nativeRecord).byteLength <= 1_048_576) throw new Error("fixture record was not oversized");\n    ctx.ui.notify("SMOKE_FIXTURE_OK:" + sentinel, "info");\n  }});\n}\n`,
  );
}

async function runPty(
  piBin: string,
  extensions: string[],
  env: Record<string, string>,
  cwd: string,
  sentinel: string,
): Promise<{ code: number; output: string }> {
  // expect allocates the controlling PTY. The only bytes sent to it are slash
  // commands; there is no prompt, model-generated task, or human input.
  const driver = join(cwd, `.smoke-driver-${crypto.randomUUID()}.exp`);
  const quote = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await Bun.write(
    driver,
    `set timeout 30\nlog_user 1\nspawn /bin/sh -c "exec '${quote(piBin)}' --offline --extension '${quote(extensions[0]!)}' --extension '${quote(extensions[1]!)}'"\nsleep 3\nsend "/smoke-fixture ${quote(sentinel)}\\r"\nsleep 1\nsend "\\003\\003"\nsleep 1\nsend "/quit\\r"\nsleep 1\nclose\nwait\ncatch wait result\nexit [lindex $result 3]\n`,
  );
  const child = Bun.spawn(["expect", "-f", driver], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await Bun.file(driver).delete();
  return { code, output: `${out}\\n${error}`.slice(0, MAX_EVIDENCE_BYTES) };
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
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--artifact" && value) {
      artifact = value;
      i += 1;
    } else if (key === "--repeat-oversized-settlement" && value) {
      repeat = Number(value);
      i += 1;
    } else if (key === "--max-parallelism" && value) {
      maxParallelism = Number(value);
      i += 1;
    } else if (key === "--report" && value) {
      report = value;
      i += 1;
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
  const artifactBytes = await Bun.file(args.artifact).bytes();
  const digest = artifactDigest(artifactBytes);
  const root = `/tmp/weave-pi-child-smoke-${crypto.randomUUID()}`;
  const dataHome = join(root, "xdg-data");
  const piHome = join(root, "pi");
  const project = join(root, "project");
  const packageDir = join(project, "node_modules/@weaveio/weave-adapter-pi");
  const fixture = join(root, "smoke-fixture.mjs");
  const reportPath =
    args.report ??
    join(".release", `pi-child-inspection-${digest.slice(0, 12)}.json`);
  let report: SmokeReport | undefined;
  try {
    for (const path of [
      dataHome,
      piHome,
      project,
      packageDir,
      join(root, "home"),
    ])
      await Bun.$`mkdir -p ${path}`;
    const voltaHome =
      Bun.env.VOLTA_HOME ?? (Bun.env.HOME ? join(Bun.env.HOME, ".volta") : "");
    if (voltaHome) {
      await Bun.$`rm -rf ${join(root, "home", ".volta")}`;
      await Bun.$`ln -s ${voltaHome} ${join(root, "home", ".volta")}`;
    }
    const extracted = await command(
      ["tar", "-xzf", args.artifact, "-C", packageDir, "--strip-components=1"],
      {},
      project,
    );
    if (extracted.code !== 0)
      throw new Error("could not install the supplied packed adapter");
    if (!(await Bun.file(join(packageDir, "dist/extension.js")).exists()))
      throw new Error("packed adapter has no extension entrypoint");
    // The packed package is installed under the disposable project. Runtime
    // dependencies come from the repository's already-installed store; no
    // registry or network access is permitted.
    await Bun.$`ln -s ${join(process.cwd(), "packages/adapters/pi/node_modules")} ${join(packageDir, "node_modules")}`;
    await writeFixture(fixture);
    const callerPiHome =
      Bun.env.PI_CODING_AGENT_DIR ?? join(Bun.env.HOME ?? "", ".pi/agent");
    await copyPrivateMaterial(callerPiHome, piHome);
    const safeEnv = {
      PATH: Bun.env.PATH ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      VOLTA_HOME: Bun.env.VOLTA_HOME ?? join(Bun.env.HOME ?? "", ".volta"),
      XDG_DATA_HOME: dataHome,
      PI_CODING_AGENT_DIR: piHome,
    };
    const located =
      Bun.env.PI_BIN ??
      (
        await command(["sh", "-lc", "command -v pi"], safeEnv, project)
      ).stdout.trim();
    if (!located) throw new Error("Pi host is unavailable");
    const hostCheck = await command([located, "--version"], safeEnv, project);
    if (hostCheck.code !== 0)
      throw new Error(`Pi host is unavailable (${hostCheck.code})`);
    const hostVersion = hostCheck.stdout.trim().split("\n")[0] ?? "unknown";
    const subject = (
      await command(
        ["git", "rev-parse", "HEAD"],
        { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
        ".",
      )
    ).stdout.trim();
    const binding: SmokeBinding = {
      artifactSha256: digest,
      subjectSha: subject,
      hostVersion,
      checklistVersion: CHECKLIST_VERSION,
      runAttempt: Number(Bun.env.PI_CHILD_SMOKE_RUN_ATTEMPT ?? "1"),
    };
    const piBin = located;
    const run = (sentinel: string): ChildResult =>
      ResultAsync.fromPromise(
        runPty(
          piBin,
          [join(packageDir, "dist/extension.js"), fixture],
          {
            PATH: Bun.env.PATH ?? "/usr/bin:/bin",
            HOME: join(root, "home"),
            XDG_DATA_HOME: dataHome,
            PI_CODING_AGENT_DIR: piHome,
          },
          project,
          sentinel,
        ),
        () => makeChildExitedUnexpectedlyFailure("smoke-child", null),
      ).andThen(({ code, output }) => {
        if (code !== 0) {
          if (Bun.env.PI_CHILD_SMOKE_DEBUG === "1")
            process.stderr.write(sanitizedAssertion({ code, output }));
          return ResultAsync.fromSafePromise(
            Promise.resolve(
              makeChildExitedUnexpectedlyFailure("smoke-child", code),
            ),
          ).andThen(() =>
            err(makeChildExitedUnexpectedlyFailure("smoke-child", code)),
          );
        }
        if (!output.includes(`SMOKE_FIXTURE_OK:${sentinel}`))
          return err(makeChildSettlementMissingFailure("smoke-child"));
        return ok({
          settlement: {
            outcome: "completed" as const,
            summary: "terminal",
            outputByteLength: 1_100_000,
          },
          privateOutput: "[private fixture output redacted]",
          logs: [],
        });
      });
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
    report = result.value;
    await Bun.$`mkdir -p ${join(reportPath, "..")}`;
    await Bun.write(reportPath, `${JSON.stringify(report)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } finally {
    await Bun.$`rm -rf ${root}`;
  }
}

if (import.meta.main)
  cli()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "smoke failed" })}\n`,
      );
      process.exit(1);
    });

export type SmokeObservation = PiSettlementValidationObservation;
export type SmokeFailure = PiAdapterFailure;
