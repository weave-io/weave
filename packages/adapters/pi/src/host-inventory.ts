import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  makeInvariantViolationFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
import type { PiCommandInfo, PiExtensionApi, PiUiPort } from "./types.js";

const PiSourceInfoSchema = z.object({
  path: z.string(),
  source: z.string(),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
  baseDir: z.string().optional(),
});
const PiCommandInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(["extension", "prompt", "skill"]),
  sourceInfo: PiSourceInfoSchema,
});

export function readValidatedCommands(
  api: Pick<PiExtensionApi, "getCommands">,
): Result<PiCommandInfo[], PiAdapterFailure> {
  const raw = Result.fromThrowable(
    () => api.getCommands(),
    () => makeInvariantViolationFailure("getCommands-threw"),
  )();
  if (raw.isErr()) return err(raw.error);
  const parsed = z.array(PiCommandInfoSchema).safeParse(raw.value);
  return parsed.success
    ? ok(parsed.data)
    : err(makeInvariantViolationFailure("getCommands-malformed"));
}

export {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
export type PiHostSurfaceStatus = "native" | "fallback" | "unavailable";
export interface PiHostSurfaceProbe {
  readonly surfaceId: PiHostSurfaceId;
  readonly status: PiHostSurfaceStatus;
  readonly details: string;
}
export interface PiHostSurfaceReport {
  readonly probes: readonly PiHostSurfaceProbe[];
  readonly requiredGaps: readonly PiHostSurfaceId[];
}
export interface PiHostSurfaceReadInput {
  readonly api: PiExtensionApi;
  readonly ui: PiUiPort;
  /** Public root exports imported by the extension loader. Never package.json. */
  readonly rootExports?: Readonly<Record<string, unknown>>;
}
export type PiHostSurfaceReadError =
  | { readonly type: "ReaderThrew" }
  | { readonly type: "ReaderRejected" }
  | { readonly type: "ReaderMalformed" };
export interface PiHostSurfaceReader {
  read(
    input: PiHostSurfaceReadInput,
  ): ResultAsync<readonly unknown[], PiHostSurfaceReadError>;
}

const MAX_DETAILS = 120;
const safeDetails = (value: unknown): string =>
  typeof value === "string" &&
  /^[\x20-\x7e]*$/.test(value) &&
  value.length <= MAX_DETAILS
    ? value
    : "surface-invalid";
const required = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.required === true;
const fallback = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.fallback === "pi-default";

export function readHostSurfaceReport(
  raw: readonly unknown[],
): PiHostSurfaceReport {
  const byId = new Map<string, PiHostSurfaceProbe[]>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (
      typeof value.surfaceId !== "string" ||
      !PI_HOST_SURFACE_IDS.includes(value.surfaceId as PiHostSurfaceId)
    )
      continue;
    const status =
      value.status === "native" ||
      value.status === "fallback" ||
      value.status === "unavailable"
        ? value.status
        : "unavailable";
    const bucket = byId.get(value.surfaceId) ?? [];
    bucket.push(
      Object.freeze({
        surfaceId: value.surfaceId as PiHostSurfaceId,
        status,
        details: safeDetails(value.details),
      }),
    );
    byId.set(value.surfaceId, bucket);
  }
  const makeProbe = (
    surfaceId: PiHostSurfaceId,
    status: PiHostSurfaceStatus,
    details: string,
  ): PiHostSurfaceProbe => Object.freeze({ surfaceId, status, details });
  const probes = PI_HOST_SURFACE_IDS.map((surfaceId): PiHostSurfaceProbe => {
    const rows = byId.get(surfaceId);
    if (rows === undefined)
      return makeProbe(
        surfaceId,
        required(surfaceId) ? "unavailable" : "fallback",
        required(surfaceId) ? "surface-missing" : "pi-default-fallback",
      );
    if (rows.length !== 1)
      return makeProbe(
        surfaceId,
        required(surfaceId) ? "unavailable" : "fallback",
        "surface-duplicate",
      );
    const row = rows[0];
    if (row === undefined)
      return makeProbe(
        surfaceId,
        required(surfaceId) ? "unavailable" : "fallback",
        "surface-missing",
      );
    if (!required(surfaceId) && row.status === "unavailable")
      return makeProbe(surfaceId, "fallback", "pi-default-fallback");
    if (required(surfaceId) && row.status !== "native")
      return makeProbe(
        surfaceId,
        "unavailable",
        row.details === "surface-invalid" ? "surface-invalid" : row.details,
      );
    return makeProbe(surfaceId, row.status, row.details);
  });
  const requiredGaps = probes
    .filter(
      (probe) => required(probe.surfaceId) && probe.status === "unavailable",
    )
    .map((probe) => probe.surfaceId);
  return Object.freeze({
    probes: Object.freeze(probes),
    requiredGaps: Object.freeze(requiredGaps),
  });
}

/**
 * The trust boundary for host probes. A reader is extension-provided code, so
 * its synchronous throws, rejected results, typed errors, and malformed values
 * all become the same conservative report.
 */
export function safeReadHostSurfaceReport(
  reader: PiHostSurfaceReader,
  input: PiHostSurfaceReadInput,
): ResultAsync<PiHostSurfaceReport, never> {
  const read = ResultAsync.fromThrowable(
    async (): Promise<readonly unknown[]> => {
      const candidate = (await reader.read(input)) as unknown;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("isErr" in candidate) ||
        typeof candidate.isErr !== "function" ||
        !("value" in candidate)
      ) {
        throw new Error("host-surface-reader-malformed-result");
      }
      if (candidate.isErr()) throw new Error("host-surface-reader-error");
      if (!Array.isArray(candidate.value))
        throw new Error("host-surface-reader-malformed-value");
      return candidate.value;
    },
    () => ({ type: "ReaderMalformed" as const }),
  )();
  return read
    .andThen(
      (rows): ResultAsync<PiHostSurfaceReport, PiHostSurfaceReadError> => {
        const normalized = Result.fromThrowable(
          () => readHostSurfaceReport(rows),
          () => ({ type: "ReaderMalformed" as const }),
        )();
        return normalized.isOk()
          ? okAsync(normalized.value)
          : errAsync(normalized.error);
      },
    )
    .orElse(() => okAsync(emptyHostSurfaceReport()));
}

export const emptyHostSurfaceReport = (): PiHostSurfaceReport =>
  readHostSurfaceReport([]);

/** Conservative built-in contract used only when no reader was injected. */
export const defaultHostSurfaceReport = (): PiHostSurfaceReport =>
  readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: required(surfaceId) ? "native" : "fallback",
      details: required(surfaceId)
        ? "validated-native-host-surface"
        : "pi-default-fallback",
    })),
  );

function hostVersionIsValid(
  rootExports: Readonly<Record<string, unknown>>,
): boolean {
  const version = rootExports.VERSION;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    return false;
  const [major, minor, patch] = version.split(".").map(Number);
  const [floorMajor, floorMinor, floorPatch] =
    PI_HOST_COMPATIBILITY_MATRIX.floorVersion.split(".").map(Number);
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    (major > floorMajor ||
      (major === floorMajor &&
        (minor > floorMinor || (minor === floorMinor && patch >= floorPatch))))
  );
}

/** Read-only production probe. Required protocol surfaces come from the validated root VERSION and matrix, never from look-alike public methods. */
export class DefaultPiHostSurfaceReader implements PiHostSurfaceReader {
  read(
    input: PiHostSurfaceReadInput,
  ): ResultAsync<readonly unknown[], PiHostSurfaceReadError> {
    return ResultAsync.fromThrowable(
      async () => {
        const root = input.rootExports ?? {};
        const versionValid = hostVersionIsValid(root);
        const has = (name: string): boolean => typeof root[name] === "function";
        const native = (
          id: PiHostSurfaceId,
          supported: boolean,
        ): PiHostSurfaceProbe => {
          if (supported)
            return {
              surfaceId: id,
              status: "native",
              details: "validated-native-host-surface",
            };
          if (required(id))
            return {
              surfaceId: id,
              status: "unavailable",
              details: "required-surface-missing",
            };
          return {
            surfaceId: id,
            status: "fallback",
            details: fallback(id)
              ? "pi-default-fallback"
              : "required-surface-missing",
          };
        };
        return [
          native("assistant-rendering", has("AssistantMessageComponent")),
          native("tool-rendering", has("ToolExecutionComponent")),
          native("markdown-rendering", has("Markdown")),
          native("image-rendering", has("Image")),
          native("usage-rendering", has("FooterComponent")),
          native("queue-rendering", has("BorderedLoader")),
          native("status-rendering", typeof input.ui.setStatus === "function"),
          native(
            "editor-composition",
            typeof input.ui.setEditorComponent === "function" &&
              has("CustomEditor"),
          ),
          native("rpc-steer", versionValid && matrixNative("rpc-steer")),
          native(
            "rpc-follow-up",
            versionValid && matrixNative("rpc-follow-up"),
          ),
          native(
            "rpc-get-entries",
            versionValid && matrixNative("rpc-get-entries"),
          ),
          native(
            "session-restore",
            versionValid && matrixNative("session-restore"),
          ),
          native(
            "extension-ui-response",
            versionValid && matrixNative("extension-ui-response"),
          ),
        ];
      },
      () => ({ type: "ReaderThrew" as const }),
    )();
  }
}

function matrixNative(id: PiHostSurfaceId): boolean {
  return (
    PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
      ?.nativeSupport === true
  );
}
