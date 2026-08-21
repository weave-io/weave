/**
 * Bounded, read-only Pi child doctor (Spec 33 §15.4, plan Task 15).
 *
 * Runs isolated capability / permission / session / ref / cache / stale /
 * orphan checks and returns one strict, sanitized JSON report. Never writes
 * log files, never repairs, and never embeds prompt or transcript content.
 */

import { okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  looksLikeFilesystemPath,
  type PiAdapterCommandPortError,
  type PiAdapterDoctorPort,
  type PiDoctorResult,
  PiDoctorResultSchema,
} from "./adapter-cli-commands.js";
import { PiDiagnosticCodeSchema } from "./errors.js";
import { sanitizeDiagnosticValue } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Bounds and check ids
// ---------------------------------------------------------------------------

export const PI_DOCTOR_BOUNDS = Object.freeze({
  /** Orphan / stale rows inspected in one doctor run. */
  orphanPageSize: 50,
  /** Ceiling on each check detail string. */
  maxDetailCharacters: 2_048,
  /** Fixed check count for this pipeline. */
  checkCount: 7,
});

export const PI_DOCTOR_CHECK_IDS = Object.freeze({
  capabilities: "doctor.capabilities",
  permissions: "doctor.permissions",
  sessions: "doctor.sessions",
  refs: "doctor.refs",
  cache: "doctor.cache",
  stale: "doctor.stale",
  orphans: "doctor.orphans",
} as const);

export type PiDoctorCheckId =
  (typeof PI_DOCTOR_CHECK_IDS)[keyof typeof PI_DOCTOR_CHECK_IDS];

export const PiDoctorCheckIdSchema = z.enum([
  PI_DOCTOR_CHECK_IDS.capabilities,
  PI_DOCTOR_CHECK_IDS.permissions,
  PI_DOCTOR_CHECK_IDS.sessions,
  PI_DOCTOR_CHECK_IDS.refs,
  PI_DOCTOR_CHECK_IDS.cache,
  PI_DOCTOR_CHECK_IDS.stale,
  PI_DOCTOR_CHECK_IDS.orphans,
]);

const DoctorCheckStatusSchema = z.enum(["pass", "fail", "skip"]);

export const PiDoctorCheckSchema = z
  .object({
    id: PiDoctorCheckIdSchema,
    status: DoctorCheckStatusSchema,
    detail: z.string().max(PI_DOCTOR_BOUNDS.maxDetailCharacters).optional(),
    code: PiDiagnosticCodeSchema.optional(),
  })
  .strict();

export type PiDoctorCheck = z.infer<typeof PiDoctorCheckSchema>;
type PiDoctorCheckDraft = {
  id: PiDoctorCheckId;
  status: z.infer<typeof DoctorCheckStatusSchema>;
  detail?: string;
  code?: z.infer<typeof PiDiagnosticCodeSchema>;
};
type PiDoctorResultCheck = PiDoctorResult["checks"][number];

/** Closed outcome one isolated check may return. */
export type PiDoctorCheckOutcome = {
  readonly status: "pass" | "fail" | "skip";
  readonly detail?: string;
  readonly code?: z.infer<typeof PiDiagnosticCodeSchema>;
};

export type PiDoctorCheckFailure = {
  readonly type: "CheckFailed";
  readonly message: string;
  readonly code?: z.infer<typeof PiDiagnosticCodeSchema>;
};

/**
 * Injected check ports. Each returns ResultAsync so failures stay values;
 * {@link runChildDoctor} isolates them so one Err never stops the others.
 */
export interface PiDoctorCheckPorts {
  readonly capabilities: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
  readonly permissions: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
  readonly sessions: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
  readonly refs: () => ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure>;
  readonly cache: () => ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure>;
  readonly stale: () => ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure>;
  readonly orphans: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
}

export interface RunChildDoctorInput {
  readonly ports: PiDoctorCheckPorts;
  readonly diagnostic?: boolean;
  /** When true, report remains available; never blocks the pipeline. */
  readonly healthOnly?: boolean;
}

const CHECK_ORDER = [
  {
    id: PI_DOCTOR_CHECK_IDS.capabilities,
    run: (ports: PiDoctorCheckPorts) => ports.capabilities(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.permissions,
    run: (ports: PiDoctorCheckPorts) => ports.permissions(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.sessions,
    run: (ports: PiDoctorCheckPorts) => ports.sessions(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.refs,
    run: (ports: PiDoctorCheckPorts) => ports.refs(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.cache,
    run: (ports: PiDoctorCheckPorts) => ports.cache(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.stale,
    run: (ports: PiDoctorCheckPorts) => ports.stale(),
  },
  {
    id: PI_DOCTOR_CHECK_IDS.orphans,
    run: (ports: PiDoctorCheckPorts) => ports.orphans(),
  },
] as const;

function truncateDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  if (detail.length <= PI_DOCTOR_BOUNDS.maxDetailCharacters) return detail;
  return detail.slice(0, PI_DOCTOR_BOUNDS.maxDetailCharacters);
}

function sanitizeCheck(check: PiDoctorCheckDraft): PiDoctorCheck {
  const parsed = PiDoctorCheckSchema.safeParse(sanitizeDiagnosticValue(check));
  if (!parsed.success) {
    return {
      id: check.id,
      status: "fail",
      detail: "check outcome failed sanitization",
    };
  }
  const cleaned: PiDoctorCheckDraft = {
    id: parsed.data.id,
    status: parsed.data.status,
  };
  const detail = truncateDetail(parsed.data.detail);
  if (detail !== undefined) cleaned.detail = detail;
  if (parsed.data.code !== undefined) cleaned.code = parsed.data.code;
  const validated = PiDoctorCheckSchema.safeParse(cleaned);
  return validated.success
    ? validated.data
    : {
        id: check.id,
        status: "fail",
        detail: "check outcome failed sanitization",
      };
}

function aggregateStatus(
  checks: readonly PiDoctorCheck[],
): PiDoctorResult["status"] {
  if (checks.some((check) => check.status === "fail")) return "degraded";
  if (checks.every((check) => check.status === "skip")) return "unavailable";
  return "ok";
}

function runIsolatedCheck(
  id: PiDoctorCheckId,
  run: () => ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure>,
): Promise<PiDoctorCheck> {
  return Promise.resolve(run()).then(
    (result) =>
      result.match(
        (outcome): PiDoctorCheck => {
          const draft: PiDoctorCheckDraft = { id, status: outcome.status };
          const detail = truncateDetail(outcome.detail);
          if (detail !== undefined) draft.detail = detail;
          if (outcome.code !== undefined) draft.code = outcome.code;
          return sanitizeCheck(draft);
        },
        (failure): PiDoctorCheck => {
          const draft: PiDoctorCheckDraft = {
            id,
            status: "fail",
          };
          const detail = truncateDetail(failure.message);
          if (detail !== undefined) draft.detail = detail;
          if (failure.code !== undefined) draft.code = failure.code;
          return sanitizeCheck(draft);
        },
      ),
    (): PiDoctorCheck => ({
      id,
      status: "fail",
      detail: "check rejected",
    }),
  );
}

/**
 * Runs every doctor check in isolation and returns a strict sanitized report.
 * The report is returned to the caller only — no standalone log file is written.
 */
export function runChildDoctor(
  input: RunChildDoctorInput,
): ResultAsync<PiDoctorResult, PiAdapterCommandPortError> {
  return ResultAsync.fromSafePromise(
    Promise.all(
      CHECK_ORDER.map((entry) =>
        runIsolatedCheck(entry.id, () => entry.run(input.ports)),
      ),
    ),
  ).map((settled) => {
    const checks = settled.map((check): PiDoctorResultCheck => {
      const result: PiDoctorResultCheck = {
        id: check.id,
        status: check.status,
      };
      if (check.detail !== undefined) result.detail = check.detail;
      return result;
    });
    const report: PiDoctorResult = {
      kind: "doctor",
      status: aggregateStatus(settled),
      checks,
    };
    if (input.diagnostic === true) {
      report.diagnostics = {
        healthOnly: input.healthOnly === true ? "true" : "false",
        orphanPageSize: String(PI_DOCTOR_BOUNDS.orphanPageSize),
        checkCount: String(settled.length),
      };
    }
    const sanitized = sanitizeDiagnosticValue(report);
    const parsed = PiDoctorResultSchema.safeParse(sanitized);
    if (!parsed.success) {
      return {
        kind: "doctor",
        status: "unavailable",
        checks: [
          {
            id: PI_DOCTOR_CHECK_IDS.capabilities,
            status: "fail",
            detail: "doctor report failed schema validation",
          },
        ],
      };
    }
    if (input.diagnostic === true && parsed.data.diagnostics !== undefined) {
      const diagnostics: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.data.diagnostics)) {
        diagnostics[key] = looksLikeFilesystemPath(value)
          ? "[path omitted]"
          : value;
      }
      return { ...parsed.data, diagnostics };
    }
    if (parsed.data.diagnostics !== undefined) {
      const { diagnostics: _omit, ...rest } = parsed.data;
      return rest;
    }
    return parsed.data;
  });
}

/** Builds the Task 14 {@link PiAdapterDoctorPort} over injectable checks. */
export function createPiDoctorPort(options: {
  readonly ports: PiDoctorCheckPorts;
  readonly healthOnly?: () => boolean;
}): PiAdapterDoctorPort {
  return {
    run(input) {
      const healthOnly = options.healthOnly?.() === true;
      if (input.diagnostic === undefined) {
        return runChildDoctor({ ports: options.ports, healthOnly });
      }
      return runChildDoctor({
        ports: options.ports,
        diagnostic: input.diagnostic,
        healthOnly,
      });
    },
  };
}

/** Skip outcome used when a store or probe is not wired this generation. */
export function skippedDoctorCheck(detail: string): PiDoctorCheckOutcome {
  return { status: "skip", detail };
}

/** Pass outcome with a bounded detail. */
export function passedDoctorCheck(detail: string): PiDoctorCheckOutcome {
  return { status: "pass", detail: truncateDetail(detail) ?? detail };
}

/** Fail outcome with an optional Spec §14 diagnostic code. */
export function failedDoctorCheck(
  detail: string,
  code?: z.infer<typeof PiDiagnosticCodeSchema>,
): PiDoctorCheckOutcome {
  const bounded = truncateDetail(detail) ?? detail;
  if (code === undefined) return { status: "fail", detail: bounded };
  return { status: "fail", detail: bounded, code };
}

/**
 * Default check ports: every check skips until the caller binds real probes.
 * Safe for health-only registration before thread sources open.
 */
export function createSkippedDoctorCheckPorts(
  reason = "doctor source not wired",
): PiDoctorCheckPorts {
  const skip = () => okAsync(skippedDoctorCheck(reason));
  return {
    capabilities: skip,
    permissions: skip,
    sessions: skip,
    refs: skip,
    cache: skip,
    stale: skip,
    orphans: skip,
  };
}

/**
 * Capability probe summary → doctor check. Accepts already-sanitized probe
 * rows (`probeStatus` only); never reads prompt/transcript fields.
 */
export function doctorCapabilitiesFromProbes(
  probes: readonly {
    readonly capabilityId: string;
    readonly probeStatus: string;
  }[],
): ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure> {
  return okAsync(
    (() => {
      let ok = 0;
      let degraded = 0;
      let unavailable = 0;
      for (const probe of probes) {
        if (probe.probeStatus === "ok") ok += 1;
        else if (probe.probeStatus === "degraded") degraded += 1;
        else unavailable += 1;
      }
      const detail = `ok=${ok} degraded=${degraded} unavailable=${unavailable}`;
      if (probes.length === 0) {
        return failedDoctorCheck(
          "no capability probes",
          "RequiredCapabilityUnavailable",
        );
      }
      if (unavailable > 0 || degraded > 0) {
        return failedDoctorCheck(detail, "RequiredCapabilityUnavailable");
      }
      return passedDoctorCheck(detail);
    })(),
  );
}

/** Bounded counters for orphan/stale scans — never child text. */
export interface PiDoctorOrphanScanInput {
  readonly liveParentSessionId: string;
  readonly rows: readonly {
    readonly childId: string;
    readonly originParentSessionId: string;
    readonly stale?: boolean;
    readonly tombstoned?: boolean;
  }[];
}

export function doctorOrphanCheckFromRows(
  input: PiDoctorOrphanScanInput,
): ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure> {
  return okAsync(
    (() => {
      const page = input.rows.slice(0, PI_DOCTOR_BOUNDS.orphanPageSize);
      let orphans = 0;
      for (const row of page) {
        if (row.originParentSessionId !== input.liveParentSessionId) {
          orphans += 1;
        }
      }
      const detail = `scanned=${page.length} orphans=${orphans} bound=${PI_DOCTOR_BOUNDS.orphanPageSize}`;
      return passedDoctorCheck(detail);
    })(),
  );
}

export function doctorStaleCheckFromRows(
  rows: readonly {
    readonly stale?: boolean;
    readonly tombstoned?: boolean;
  }[],
): ResultAsync<PiDoctorCheckOutcome, PiDoctorCheckFailure> {
  return okAsync(
    (() => {
      const page = rows.slice(0, PI_DOCTOR_BOUNDS.orphanPageSize);
      let stale = 0;
      let tombstoned = 0;
      for (const row of page) {
        if (row.stale === true) stale += 1;
        if (row.tombstoned === true) tombstoned += 1;
      }
      const detail = `scanned=${page.length} stale=${stale} tombstoned=${tombstoned}`;
      return stale > 0
        ? failedDoctorCheck(detail, "ChildCacheStale")
        : passedDoctorCheck(detail);
    })(),
  );
}

/**
 * Builds store-backed check ports from duck-typed Task 4/5/6 sources.
 * Missing methods become skips so health-only generations still report.
 */
export function createStoreBackedDoctorCheckPorts(options: {
  readonly capabilities?: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
  readonly permissions?: () => ResultAsync<
    PiDoctorCheckOutcome,
    PiDoctorCheckFailure
  >;
  readonly readRefs?: () => ResultAsync<
    {
      readonly counts: {
        readonly scannedEntries: number;
        readonly malformedEntries: number;
        readonly conflictingChildren: number;
        readonly originMismatchedChildren: number;
        readonly usableRefs: number;
        readonly unusableSourceChildren: number;
      };
      readonly refs: readonly {
        readonly childId: string;
        readonly sessionRef: string;
        readonly originParentSessionId: string;
        readonly status: string;
      }[];
    },
    unknown
  >;
  readonly listSessionsByRef?: (
    refs: readonly string[],
  ) => ResultAsync<readonly { readonly state: string }[], unknown>;
  readonly cacheMode?: "active" | "degraded";
  readonly listMetadata?: () => ResultAsync<
    readonly {
      readonly childId: string;
      readonly originParentSessionId: string;
      readonly stale: boolean;
      readonly tombstoned: boolean;
    }[],
    unknown
  >;
  readonly liveParentSessionId?: string;
}): PiDoctorCheckPorts {
  const skipped = createSkippedDoctorCheckPorts();
  return {
    capabilities: options.capabilities ?? skipped.capabilities,
    permissions: options.permissions ?? skipped.permissions,
    sessions: () => {
      const readRefs = options.readRefs;
      const listSessionsByRef = options.listSessionsByRef;
      if (readRefs === undefined || listSessionsByRef === undefined) {
        return skipped.sessions();
      }
      return readRefs()
        .mapErr(
          (): PiDoctorCheckFailure => ({
            type: "CheckFailed",
            message: "session ref scan failed",
            code: "ChildRefInvalid",
          }),
        )
        .andThen((scan) => {
          const refs = scan.refs
            .slice(0, PI_DOCTOR_BOUNDS.orphanPageSize)
            .map((row) => row.sessionRef);
          return listSessionsByRef(refs).mapErr(
            (): PiDoctorCheckFailure => ({
              type: "CheckFailed",
              message: "session list failed",
              code: "ChildSessionMissing",
            }),
          );
        })
        .map((states) => {
          let available = 0;
          let missing = 0;
          let corrupt = 0;
          let unavailable = 0;
          for (const state of states) {
            if (state.state === "available") available += 1;
            else if (state.state === "missing") missing += 1;
            else if (state.state === "corrupt") corrupt += 1;
            else unavailable += 1;
          }
          const detail = `available=${available} missing=${missing} corrupt=${corrupt} unavailable=${unavailable}`;
          if (corrupt > 0) {
            return failedDoctorCheck(detail, "ChildSessionCorrupt");
          }
          if (missing > 0) {
            return failedDoctorCheck(detail, "ChildSessionMissing");
          }
          return passedDoctorCheck(detail);
        });
    },
    refs: () => {
      if (options.readRefs === undefined) return skipped.refs();
      return options
        .readRefs()
        .mapErr(
          (): PiDoctorCheckFailure => ({
            type: "CheckFailed",
            message: "ref scan failed",
            code: "ChildRefInvalid",
          }),
        )
        .map((scan) => {
          const c = scan.counts;
          const detail = `scanned=${c.scannedEntries} usable=${c.usableRefs} malformed=${c.malformedEntries} conflict=${c.conflictingChildren} originMismatch=${c.originMismatchedChildren} unusable=${c.unusableSourceChildren}`;
          if (c.malformedEntries > 0 || c.conflictingChildren > 0) {
            return failedDoctorCheck(detail, "ChildRefInvalid");
          }
          if (c.originMismatchedChildren > 0) {
            return failedDoctorCheck(detail, "ChildRefOriginMismatch");
          }
          return passedDoctorCheck(detail);
        });
    },
    cache: () => {
      if (options.cacheMode === undefined) return skipped.cache();
      if (options.cacheMode === "degraded") {
        return okAsync(
          failedDoctorCheck("cache mode degraded", "ChildCacheDegraded"),
        );
      }
      return okAsync(passedDoctorCheck("cache mode active"));
    },
    stale: () => {
      if (options.listMetadata === undefined) return skipped.stale();
      return options
        .listMetadata()
        .mapErr(
          (): PiDoctorCheckFailure => ({
            type: "CheckFailed",
            message: "stale list failed",
            code: "ChildCacheStale",
          }),
        )
        .andThen((rows) => doctorStaleCheckFromRows(rows));
    },
    orphans: () => {
      if (
        options.listMetadata === undefined ||
        options.liveParentSessionId === undefined
      ) {
        return skipped.orphans();
      }
      const parentId = options.liveParentSessionId;
      return options
        .listMetadata()
        .mapErr(
          (): PiDoctorCheckFailure => ({
            type: "CheckFailed",
            message: "orphan list failed",
          }),
        )
        .andThen((rows) =>
          doctorOrphanCheckFromRows({
            liveParentSessionId: parentId,
            rows,
          }),
        );
    },
  };
}
