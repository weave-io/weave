import { join, resolve } from "node:path";
import { Result } from "neverthrow";
import { verifyCurrentBuildIdentity } from "./child-stream-identity-probe.js";
import { renderIdentityVerification } from "./child-stream-identity-report.js";
import { runLiveProofCommand } from "./child-stream-live-proof-command.js";
import { LIVE_PROOF_COMMAND } from "./child-stream-live-proof-contract.js";
import { parseVerifyChildStreamingArgs } from "./child-stream-verify-args.js";
import {
  runCaptureCommand,
  runReplayCommand,
} from "./child-stream-verify-capture-command.js";
import type { VerifyChildStreamingArgs } from "./child-stream-verify-types.js";

function writeLine(line: string): Result<void, undefined> {
  return Result.fromThrowable(
    () => {
      const written = Bun.stdout.write(`${line}\n`);
      if (written instanceof Promise) void written;
    },
    () => undefined,
  )();
}

function repoRoot(): string {
  return resolve(import.meta.dir, "../..");
}

/** Run the live command. It is the only command that owns real resources. */
async function runLiveCommandLine(argv: readonly string[]): Promise<void> {
  const outcome = await runLiveProofCommand({
    argv,
    repoRoot: repoRoot(),
  });
  outcome.match(
    (value) => {
      writeLine(value.line);
      if (value.exitCode !== 0) process.exitCode = value.exitCode;
    },
    () => undefined,
  );
}

async function runIdentityCommand(
  args: Extract<VerifyChildStreamingArgs, { readonly command: "identity" }>,
): Promise<void> {
  const result = await verifyCurrentBuildIdentity({
    repoRoot: repoRoot(),
    pi: args.pi,
    requireCurrentBuild: args.requireCurrentBuild,
  });
  writeLine(renderIdentityVerification(result));
  if (result.isErr()) process.exitCode = 1;
}

async function runCaptureCommandLine(
  args: Extract<VerifyChildStreamingArgs, { readonly command: "capture" }>,
): Promise<void> {
  const root = repoRoot();
  const result = await runCaptureCommand({
    pi: args.pi,
    requireHostVersion: args.requireHostVersion,
    fixtureDir:
      args.fixtureDir ?? join(root, "packages/adapters/pi/src/__fixtures__"),
  });
  if (result.isErr()) {
    writeLine(
      `capture: blocked; evidence=${result.error.evidence}; reason=${result.error.type}`,
    );
    process.exitCode = 1;
    return;
  }
  writeLine(
    `capture: verified; evidence=content-free; event-count=${result.value.eventCount}; manifest=independent`,
  );
}

async function runReplayCommandLine(
  args: Extract<VerifyChildStreamingArgs, { readonly command: "replay" }>,
): Promise<void> {
  const result = await runReplayCommand(args);
  if (result.isErr()) {
    writeLine(
      `replay: blocked; evidence=content-free; reason=${result.error.type}`,
    );
    process.exitCode = 1;
    return;
  }
  writeLine(
    `replay: verified; evidence=content-free; red-controls=${result.value.redControls}; lanes=4`,
  );
}

/** Dispatch the documented verifier commands without embedding process logic. */
export async function runCommandLine(argv: readonly string[]): Promise<void> {
  if (argv[0] === LIVE_PROOF_COMMAND) {
    await runLiveCommandLine(argv);
    return;
  }
  const parsed = parseVerifyChildStreamingArgs(argv);
  if (parsed.isErr()) {
    writeLine(
      "child-streaming: blocked; evidence=blocked; reason=invalid-args",
    );
    process.exitCode = 1;
    return;
  }
  if (parsed.value.command === "identity") {
    await runIdentityCommand(parsed.value);
    return;
  }
  if (parsed.value.command === "capture") {
    await runCaptureCommandLine(parsed.value);
    return;
  }
  await runReplayCommandLine(parsed.value);
}
