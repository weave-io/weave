/**
 * Durable, read-only source for `CreationCleanupPending`.
 *
 * A creation-phase cleanup record says: "this generation claimed the marker,
 * never got a pull request, and still owes a generation-verified delete." That
 * is operational state, so it lives in Weave's durable database and is read
 * back through a bounded query — never from a pull-request comment and never
 * from a workflow artifact, both of which are caches an attacker or a rerun can
 * rewrite.
 *
 * The reader is strictly read-only: it opens the database read-only, never
 * creates it, never migrates it, and never writes a row.
 *
 * Store presence rules are deliberate:
 *
 * - When `WEAVE_RELEASE_STATE_DB` names a database, that database must exist
 *   and be readable. An operator who asserts a store and does not have one is a
 *   misconfiguration, and the read fails closed.
 * - When it is unset, the default store path is used and a missing file is the
 *   store's *empty* state. That is a complete observation of the durable store,
 *   not an unverifiable read.
 *
 * Anything else — an unreadable file, a missing table, a malformed row, more
 * than one pending record, or a record for another ref — fails closed.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { type DoctorPortError, doctorPortError } from "./doctor-transports.js";
import {
  FULL_SHA,
  OWNER_GENERATION,
  RELEASE_PR_MARKER_REF,
  type ReleasePrOwnership,
} from "./release-pr-contract.js";

/** The table the release pipeline records creation-phase cleanup into. */
export const CREATION_CLEANUP_TABLE = "release_creation_cleanup" as const;

/** Environment variable that overrides the durable release-state database. */
export const RELEASE_STATE_DB_ENV = "WEAVE_RELEASE_STATE_DB" as const;

const OPERATION = "release.lifecycle.creation-cleanup";
const MAX_PENDING_ROWS = 4;
const MAX_PULL_REQUEST_NUMBER = 1_000_000;

/** A durable creation-cleanup record and the pull request it was bound to. */
export interface CreationCleanupRecord {
  readonly ownership: ReleasePrOwnership;
  /**
   * The pull request this creation attempt expected, when the attempt got far
   * enough to learn a number. `null` means creation never reached a pull
   * request, which is the ordinary `CreationCleanupPending` shape.
   */
  readonly pullRequestNumber: number | null;
}

/** Resolves the durable store path Weave's data directory owns. */
export function releaseStateDatabasePath(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): { readonly path: string; readonly explicit: boolean } {
  const explicit = environment[RELEASE_STATE_DB_ENV];
  if (explicit !== undefined && explicit.length > 0)
    return { path: explicit, explicit: true };
  const dataHome =
    environment.XDG_DATA_HOME !== undefined &&
    environment.XDG_DATA_HOME.length > 0
      ? environment.XDG_DATA_HOME
      : join(homedir(), ".local", "share");
  return {
    path: join(dataHome, "weave", "release-state.sqlite"),
    explicit: false,
  };
}

/**
 * Reads the single pending creation-cleanup record for the marker ref.
 *
 * The query is bounded: it selects at most `MAX_PENDING_ROWS + 1` unresolved
 * rows for exactly one ref, and more than one pending record is a contradiction
 * rather than a value to choose from.
 */
export function readDurableCreationCleanup(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): ResultAsync<CreationCleanupRecord | null, DoctorPortError> {
  const location = releaseStateDatabasePath(environment);
  return ResultAsync.fromPromise(
    Bun.file(location.path).exists(),
    (cause): DoctorPortError =>
      doctorPortError(
        OPERATION,
        `release-state database ${location.path} could not be stat'ed: ${String(cause)}`,
      ),
  ).andThen((exists) => {
    if (!exists)
      return location.explicit
        ? errAsync<CreationCleanupRecord | null, DoctorPortError>(
            doctorPortError(
              OPERATION,
              `${RELEASE_STATE_DB_ENV} names ${location.path}, which does not exist`,
            ),
          )
        : okAsync<CreationCleanupRecord | null, DoctorPortError>(null);
    const queried = queryCreationCleanup(location.path);
    return queried.isErr()
      ? errAsync<CreationCleanupRecord | null, DoctorPortError>(queried.error)
      : okAsync<CreationCleanupRecord | null, DoctorPortError>(queried.value);
  });
}

function queryCreationCleanup(
  path: string,
): Result<CreationCleanupRecord | null, DoctorPortError> {
  const opened = Result.fromThrowable(
    () => new Database(path, { readonly: true }),
    (cause): DoctorPortError =>
      doctorPortError(
        OPERATION,
        `release-state database ${path} could not be opened read-only: ${String(cause)}`,
      ),
  )();
  if (opened.isErr()) return err(opened.error);
  const database = opened.value;
  try {
    const rows = Result.fromThrowable(
      () =>
        database
          .query(
            `SELECT ref, owner_generation, expected_marker_sha, planned_base_sha, pull_request_number
             FROM ${CREATION_CLEANUP_TABLE}
             WHERE ref = ? AND resolved_at IS NULL
             ORDER BY rowid ASC
             LIMIT ?`,
          )
          .all(RELEASE_PR_MARKER_REF, MAX_PENDING_ROWS + 1) as unknown[],
      (cause): DoctorPortError =>
        doctorPortError(
          OPERATION,
          `release-state database ${path} has no readable ${CREATION_CLEANUP_TABLE}: ${String(cause)}`,
        ),
    )();
    if (rows.isErr()) return err(rows.error);
    if (rows.value.length === 0) return ok(null);
    if (rows.value.length > 1)
      return err(
        doctorPortError(
          OPERATION,
          `release-state database ${path} holds ${rows.value.length} pending creation-cleanup records for ${RELEASE_PR_MARKER_REF}`,
        ),
      );
    return parseRow(rows.value[0], path);
  } finally {
    database.close(false);
  }
}

function parseRow(
  value: unknown,
  path: string,
): Result<CreationCleanupRecord, DoctorPortError> {
  const row =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (row === undefined)
    return err(
      doctorPortError(
        OPERATION,
        `release-state database ${path} returned a malformed creation-cleanup row`,
      ),
    );
  const ref = row.ref;
  const ownerGeneration = row.owner_generation;
  const expectedMarkerSha = row.expected_marker_sha;
  const plannedBaseSha = row.planned_base_sha;
  if (
    ref !== RELEASE_PR_MARKER_REF ||
    typeof ownerGeneration !== "string" ||
    !OWNER_GENERATION.test(ownerGeneration) ||
    typeof expectedMarkerSha !== "string" ||
    !FULL_SHA.test(expectedMarkerSha) ||
    typeof plannedBaseSha !== "string" ||
    !FULL_SHA.test(plannedBaseSha)
  )
    return err(
      doctorPortError(
        OPERATION,
        `release-state database ${path} holds an invalid creation-cleanup identity`,
      ),
    );
  const pullRequestNumber = parsePullRequestNumber(row.pull_request_number);
  if (pullRequestNumber === undefined)
    return err(
      doctorPortError(
        OPERATION,
        `release-state database ${path} holds an invalid creation-cleanup pull request number`,
      ),
    );
  return ok({
    ownership: {
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration,
      expectedMarkerSha,
      plannedBaseSha,
    },
    pullRequestNumber,
  });
}

function parsePullRequestNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_PULL_REQUEST_NUMBER
  )
    return undefined;
  return value;
}
