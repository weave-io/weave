import { err, ok, type Result } from "neverthrow";
import {
  blocked,
  type VerifyChildStreamingArgs,
  type VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

function requiredValue(
  argv: readonly string[],
  index: number,
): string | undefined {
  const value = argv[index + 1];
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseIdentityArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let pi: string | undefined;
  let requireCurrentBuild = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-current-build") {
      requireCurrentBuild = true;
      continue;
    }
    if (arg === "--pi") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      pi = value;
      index += 1;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (pi === undefined || !requireCurrentBuild) {
    return err(blocked("invalid-args"));
  }
  return ok({ command: "identity", pi, requireCurrentBuild });
}

function parseCaptureArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let pi: string | undefined;
  let requireHostVersion: string | undefined;
  let omitReasoningContent = false;
  let sanitize = false;
  let verifyBounds = false;
  let fixtureDir: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pi") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      pi = value;
      index += 1;
      continue;
    }
    if (arg === "--require-host-version") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      requireHostVersion = value;
      index += 1;
      continue;
    }
    if (arg === "--omit-reasoning-content") {
      omitReasoningContent = true;
      continue;
    }
    if (arg === "--sanitize") {
      sanitize = true;
      continue;
    }
    if (arg === "--verify-bounds") {
      verifyBounds = true;
      continue;
    }
    if (arg === "--fixture-dir") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      fixtureDir = value;
      index += 1;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (
    pi === undefined ||
    requireHostVersion === undefined ||
    !omitReasoningContent ||
    !sanitize ||
    !verifyBounds
  ) {
    return err(blocked("invalid-args"));
  }
  return ok({
    command: "capture",
    pi,
    requireHostVersion,
    omitReasoningContent: true,
    sanitize: true,
    verifyBounds: true,
    ...(fixtureDir === undefined ? {} : { fixtureDir }),
  });
}

function parseReplayArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let fixture: string | undefined;
  let injectControlledReasoningInMemory = false;
  let verifyManifest = false;
  let runRedControls = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      fixture = value;
      index += 1;
      continue;
    }
    if (arg === "--inject-controlled-reasoning-in-memory") {
      injectControlledReasoningInMemory = true;
      continue;
    }
    if (arg === "--verify-manifest") {
      verifyManifest = true;
      continue;
    }
    if (arg === "--run-red-controls") {
      runRedControls = true;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (
    !fixture ||
    !injectControlledReasoningInMemory ||
    !verifyManifest ||
    !runRedControls
  ) {
    return err(blocked("invalid-args"));
  }
  return ok({
    command: "replay",
    fixture,
    injectControlledReasoningInMemory: true,
    verifyManifest: true,
    runRedControls: true,
  });
}

export function parseVerifyChildStreamingArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  if (argv[0] === "identity") return parseIdentityArgs(argv);
  if (argv[0] === "capture") return parseCaptureArgs(argv);
  if (argv[0] === "replay") return parseReplayArgs(argv);
  return err(blocked("invalid-args"));
}
