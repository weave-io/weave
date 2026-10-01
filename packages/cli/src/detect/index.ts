import { okAsync, ResultAsync } from "neverthrow";
import {
  BunDetectionProbes,
  type DetectionProbes,
  type ProbeError,
} from "./probes.js";

export type SupportedHarnessId =
  | "opencode"
  | "opencode2"
  | "claude-code"
  | "pi";

export const HARNESS_IDS: SupportedHarnessId[] = [
  "opencode",
  "opencode2",
  "claude-code",
  "pi",
];

export function isHarnessId(value: string): value is SupportedHarnessId {
  return HARNESS_IDS.includes(value as SupportedHarnessId);
}

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
  configPaths: (probes: DetectionProbes) => string[];
  binary: string;
  /**
   * Detect the harness only by its binary. OpenCode 1 and OpenCode 2 read the
   * same `opencode.json(c)` files, so a config file cannot tell them apart.
   */
  requiresBinary?: boolean;
  /** Whether the binary's `--version` output belongs to this harness. */
  acceptsVersion?: (version: string | undefined) => boolean;
};

function openCodeConfigPaths(probes: DetectionProbes): string[] {
  const root = probes.xdgConfigHome() ?? `${probes.home()}/.config`;
  return [`${root}/opencode/opencode.jsonc`, `${root}/opencode/opencode.json`];
}

function majorVersion(version: string | undefined): number | undefined {
  const match = version?.match(/(\d+)\.\d+\.\d+/);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

const HARNESS_PROBES: HarnessProbe[] = [
  {
    // `@opencode/cli` (OpenCode 2) also links an `opencode` binary; only a
    // 1.x `opencode` is OpenCode 1.
    id: "opencode",
    configPaths: openCodeConfigPaths,
    binary: "opencode",
    requiresBinary: true,
    acceptsVersion: (version) => (majorVersion(version) ?? 1) < 2,
  },
  {
    id: "opencode2",
    configPaths: openCodeConfigPaths,
    binary: "opencode2",
    requiresBinary: true,
  },
  {
    id: "claude-code",
    configPaths: () => ["~/.claude/settings.json"],
    binary: "claude",
  },
  { id: "pi", configPaths: () => ["~/.pi/config.json"], binary: "pi" },
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
    const configPaths = harness
      .configPaths(probes)
      .map((path) => probes.resolvePath(path));
    let configPath = configPaths[0] ?? probes.resolvePath("~");
    let configExists = false;
    for (const candidate of configPaths) {
      const exists = await probes.exists(candidate);
      if (exists.isErr()) throw probeFailed(harness.id, exists.error);
      if (!exists.value) continue;
      configPath = candidate;
      configExists = true;
      break;
    }
    const binaryPath = await probes.binaryOnPath(harness.binary);

    if (binaryPath.isErr()) throw probeFailed(harness.id, binaryPath.error);
    const found = binaryPath.value !== undefined;
    if (!found && (harness.requiresBinary || !configExists)) continue;

    const version = found
      ? await probes.readVersion(harness.binary)
      : undefined;
    const versionText = version?.isOk() ? version.value : undefined;
    if (harness.acceptsVersion && !harness.acceptsVersion(versionText))
      continue;
    const readable = await probes.readable(configPath);

    detected.push({
      id: harness.id,
      configPath,
      binaryPath: binaryPath.value,
      version: versionText,
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
