import { okAsync, ResultAsync } from "neverthrow";
import {
  BunDetectionProbes,
  type DetectionProbes,
  type ProbeError,
} from "./probes.js";

export type SupportedHarnessId = "opencode" | "claude-code" | "pi";

export type DetectedHarness = {
  id: SupportedHarnessId;
  configPath: string;
  binaryPath?: string;
  version?: string;
  readable: boolean;
};

export type DetectionError =
  | { type: "ProbeFailed"; harness: SupportedHarnessId; error: ProbeError }
  | { type: "UnknownDetectionError"; cause: unknown };

type HarnessProbe = {
  id: SupportedHarnessId;
  configPath: string;
  binary: string;
};

const HARNESS_PROBES: HarnessProbe[] = [
  {
    id: "opencode",
    configPath: "~/.config/opencode/config.json",
    binary: "opencode",
  },
  {
    id: "claude-code",
    configPath: "~/.claude/settings.json",
    binary: "claude",
  },
  { id: "pi", configPath: "~/.pi/config.json", binary: "pi" },
];

export function detectHarnesses(
  probes: DetectionProbes = new BunDetectionProbes(),
): ResultAsync<DetectedHarness[], DetectionError> {
  return ResultAsync.fromPromise(detectAll(probes), (cause): DetectionError => {
    if (isDetectionError(cause)) return cause;
    return { type: "UnknownDetectionError", cause };
  }).andThen((detected) => okAsync(detected));
}

function isDetectionError(cause: unknown): cause is DetectionError {
  if (typeof cause !== "object" || cause === null) return false;
  if (!("type" in cause)) return false;
  const type = cause.type;
  return type === "ProbeFailed" || type === "UnknownDetectionError";
}

function probeFailed(
  harness: SupportedHarnessId,
  error: ProbeError,
): DetectionError {
  return { type: "ProbeFailed", harness, error };
}

async function detectAll(probes: DetectionProbes): Promise<DetectedHarness[]> {
  const detected: DetectedHarness[] = [];

  for (const harness of HARNESS_PROBES) {
    const configPath = probes.resolvePath(harness.configPath);
    const exists = await probes.exists(configPath);
    const binaryPath = await probes.binaryOnPath(harness.binary);

    if (exists.isErr()) throw probeFailed(harness.id, exists.error);
    if (binaryPath.isErr()) throw probeFailed(harness.id, binaryPath.error);
    if (!exists.value && binaryPath.value === undefined) continue;

    const readable = await probes.readable(configPath);
    const version = await probes.readVersion(harness.binary);

    detected.push({
      id: harness.id,
      configPath,
      binaryPath: binaryPath.value,
      version: version.isOk() ? version.value : undefined,
      readable: readable.isOk() ? readable.value : false,
    });
  }

  return detected;
}

export function formatDetectionSummary(harnesses: DetectedHarness[]): string[] {
  if (harnesses.length === 0) {
    return ["No supported harness config or PATH binaries detected."];
  }

  return harnesses.map((harness) => {
    const version = harness.version ? ` (${harness.version})` : "";
    const access = harness.readable ? "readable" : "unreadable config";
    return `${harness.id}${version}: ${access} at ${harness.configPath}`;
  });
}
