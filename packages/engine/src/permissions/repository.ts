import { err, ok, Result, ResultAsync } from "neverthrow";
import { permissionDigest, sanitizePermissionDisplay } from "./canonical.js";
import type {
  Clock,
  DurablePermissionGrantRecord,
  GrantIdentityEnvelope,
  PermissionApprovalRepository,
  PermissionError,
  PermissionGrantSummary,
} from "./types.js";

type Operation = "save" | "list" | "match" | "revoke";
export type PermissionRepositoryFailurePlan = Partial<
  Record<Operation, boolean | (() => boolean)>
>;

const failure = (): PermissionError => ({ type: "repository_failure" });
const invalid = (message: string): PermissionError => ({
  type: "invalid_output",
  message,
});
const encoder = new TextEncoder();
const IDENTITY_FIELDS = [
  "projectIdentity",
  "agentName",
  "registrationOwner",
  "toolIdentity",
  "registrationRevision",
  "policyFingerprint",
  "requestSchemaVersion",
  "requestDigest",
] as const;
const RECORD_FIELDS = [
  "grantId",
  "identity",
  "scope",
  "display",
  "createdAt",
  "expiresAt",
  "revokedAt",
  "state",
] as const;
const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
const STORAGE_ROW_FIELDS = [
  "grant_id",
  "project_identity",
  "agent_name",
  "registration_owner",
  "tool_identity",
  "registration_revision",
  "policy_fingerprint",
  "request_schema_version",
  "request_digest",
  "display_summary",
  "display_details",
  "created_at",
  "expires_at",
  "revoked_at",
  "state",
] as const;

const readOwnData = (
  value: object,
  allowed: readonly string[],
): Result<Record<string, PropertyDescriptor>, PermissionError> =>
  Result.fromThrowable(
    () => {
      if (Object.getPrototypeOf(value) !== Object.prototype)
        return err(invalid("object has an unsafe prototype"));
      const allowedSet = new Set(allowed);
      const fields: Record<string, PropertyDescriptor> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedSet.has(key))
          return err(invalid("object has unexpected fields"));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return err(invalid("object contains an accessor or hidden field"));
        fields[key] = descriptor;
      }
      return ok(fields);
    },
    () => invalid("invalid repository object"),
  )().andThen((result) => result);

const scalar = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  encoder.encode(value).byteLength <= maxBytes &&
  !/[\uD800-\uDFFF]/u.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validateGrantIdentityUnsafe(
  value: unknown,
): Result<GrantIdentityEnvelope, PermissionError> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return err(invalid("invalid grant identity envelope"));
  const fields = readOwnData(value as object, IDENTITY_FIELDS);
  if (fields.isErr()) return err(fields.error);
  if (IDENTITY_FIELDS.some((field) => !fields.value[field]))
    return err(invalid("invalid grant identity envelope"));
  const values = IDENTITY_FIELDS.map((field) => fields.value[field].value);
  const limits = [256, 256, 128, 256, 64, 256, 64, 256];
  if (values.some((field, index) => !scalar(field, limits[index])))
    return err(invalid("invalid grant identity envelope"));
  return ok(
    Object.freeze({
      projectIdentity: values[0] as string,
      agentName: values[1] as string,
      registrationOwner: values[2] as string,
      toolIdentity: values[3] as string,
      registrationRevision: values[4] as string,
      policyFingerprint: values[5] as string,
      requestSchemaVersion: values[6] as string,
      requestDigest: values[7] as string,
    }),
  );
}

/** Result-returning strict identity validation for repository and hydration boundaries. */
export function validateGrantIdentityResult(
  value: unknown,
): Result<GrantIdentityEnvelope, PermissionError> {
  return Result.fromThrowable(
    () => validateGrantIdentityUnsafe(value),
    () => invalid("invalid grant identity envelope"),
  )().andThen((result) => result);
}

/** Compatibility type guard. It is deliberately trap-safe; use the Result form for errors. */
export function validateGrantIdentity(
  value: unknown,
): value is GrantIdentityEnvelope {
  return validateGrantIdentityResult(value).isOk();
}

function validateDurableGrantRecordUnsafe(
  value: unknown,
): Result<DurablePermissionGrantRecord, PermissionError> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return err(invalid("invalid durable grant record"));
  const fields = readOwnData(value as object, RECORD_FIELDS);
  if (fields.isErr()) return err(fields.error);
  const requiredRecordFields = [
    "grantId",
    "identity",
    "scope",
    "display",
    "createdAt",
    "state",
  ];
  if (requiredRecordFields.some((field) => !fields.value[field]))
    return err(invalid("invalid durable grant record"));
  const identity = validateGrantIdentityResult(fields.value.identity.value);
  if (identity.isErr()) return err(invalid("invalid durable grant record"));
  const display = sanitizePermissionDisplay(fields.value.display.value);
  if (display.isErr()) return err(invalid("invalid durable grant display"));
  const grantId = fields.value.grantId.value;
  const scope = fields.value.scope.value;
  const createdAt = fields.value.createdAt.value;
  const expiresAt = fields.value.expiresAt?.value;
  const revokedAt = fields.value.revokedAt?.value;
  const state = fields.value.state.value;
  if (
    !scalar(grantId, 256) ||
    scope !== "durable" ||
    !timestamp(createdAt) ||
    (expiresAt !== undefined &&
      (!timestamp(expiresAt) || expiresAt <= createdAt)) ||
    (revokedAt !== undefined &&
      (!timestamp(revokedAt) || revokedAt < createdAt)) ||
    (state !== "active" && state !== "revoked") ||
    (state === "active" && revokedAt !== undefined) ||
    (state === "revoked" && revokedAt === undefined)
  )
    return err(invalid("invalid durable grant record"));
  return ok(
    Object.freeze({
      grantId,
      identity: identity.value,
      scope: "durable" as const,
      display: display.value,
      createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
      state,
    }),
  );
}

/** Result-returning strict record validation used before every repository mutation. */
export function validateDurableGrantRecordResult(
  value: unknown,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return Result.fromThrowable(
    () => validateDurableGrantRecordUnsafe(value),
    () => invalid("invalid durable grant record"),
  )().andThen((result) => result);
}

/** Compatibility type guard. It never inspects a getter or lets a proxy escape. */
export function validateDurableGrantRecord(
  value: unknown,
): value is DurablePermissionGrantRecord {
  return validateDurableGrantRecordResult(value).isOk();
}

export function hydrateDurableGrant(
  row: unknown,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        return err(invalid("invalid permission grant row"));
      const fields = readOwnData(row as object, STORAGE_ROW_FIELDS);
      if (fields.isErr()) return err(invalid("invalid permission grant row"));
      if (STORAGE_ROW_FIELDS.some((field) => !fields.value[field]))
        return err(invalid("invalid permission grant row"));
      const value = (field: (typeof STORAGE_ROW_FIELDS)[number]): unknown =>
        fields.value[field].value;
      const record = {
        grantId: value("grant_id"),
        identity: {
          projectIdentity: value("project_identity"),
          agentName: value("agent_name"),
          registrationOwner: value("registration_owner"),
          toolIdentity: value("tool_identity"),
          registrationRevision: value("registration_revision"),
          policyFingerprint: value("policy_fingerprint"),
          requestSchemaVersion: value("request_schema_version"),
          requestDigest: value("request_digest"),
        },
        scope: "durable",
        display: {
          summary: value("display_summary"),
          ...(value("display_details") === null
            ? {}
            : { details: value("display_details") }),
        },
        createdAt: value("created_at"),
        ...(value("expires_at") === null
          ? {}
          : { expiresAt: value("expires_at") }),
        ...(value("revoked_at") === null
          ? {}
          : { revokedAt: value("revoked_at") }),
        state: value("state"),
      };
      return validateDurableGrantRecordResult(record);
    },
    () => invalid("invalid permission grant row"),
  )().andThen((result) => result);
}

/**
 * Stable structural identity digest. Field order is fixed by IDENTITY_FIELDS,
 * so object insertion order cannot change the key, and the digest never exposes
 * raw identity fields or returns a fabricated empty fallback.
 */
export function grantIdentityKey(
  identity: GrantIdentityEnvelope,
): Result<string, PermissionError> {
  return validateGrantIdentityResult(identity).andThen((safe) =>
    permissionDigest(IDENTITY_FIELDS.map((field) => safe[field])),
  );
}

export function grantIdentitiesEqual(
  a: GrantIdentityEnvelope,
  b: GrantIdentityEnvelope,
): Result<boolean, PermissionError> {
  return grantIdentityKey(a).andThen((left) =>
    grantIdentityKey(b).map((right) => left === right),
  );
}

const frozen = <T extends object>(value: T): Readonly<T> =>
  Object.freeze(value);

export function cloneDurableGrant(
  record: DurablePermissionGrantRecord,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return validateDurableGrantRecordResult(record);
}

export function summarizeDurableGrant(
  record: DurablePermissionGrantRecord,
): Result<PermissionGrantSummary, PermissionError> {
  return validateDurableGrantRecordResult(record).map((checked) =>
    frozen({
      project: checked.identity.projectIdentity,
      grantId: checked.grantId,
      agentName: checked.identity.agentName,
      toolIdentity: checked.identity.toolIdentity,
      scope: "durable" as const,
      display: frozen({ ...checked.display }),
      createdAt: checked.createdAt,
      ...(checked.expiresAt === undefined
        ? {}
        : { expiresAt: checked.expiresAt }),
      ...(checked.revokedAt === undefined
        ? {}
        : { revokedAt: checked.revokedAt }),
      state: checked.state,
    }),
  );
}

export class InMemoryPermissionApprovalRepository
  implements PermissionApprovalRepository
{
  private records = new Map<string, DurablePermissionGrantRecord>();
  private tail: Promise<void> = Promise.resolve();
  /**
   * Engine-internal nondecreasing wall-clock high-water. Not public. Once a
   * durable expiry boundary is observed, rollback of the source clock cannot
   * resurrect matching authority.
   */
  #wallHighWater = 0;
  constructor(
    private readonly plan: PermissionRepositoryFailurePlan = {},
    private readonly clock: Clock = () => Date.now(),
  ) {}
  private shouldFail(operation: Operation): boolean {
    const value = this.plan[operation];
    return typeof value === "function" ? value() : value === true;
  }
  /**
   * Observe a validated wall timestamp and advance the high-water mark.
   * Throwing clocks map to `repository_failure`. Never extends TTL backward.
   */
  private observeWallNow(
    now: number | undefined,
  ): Result<number, PermissionError> {
    const supplied =
      now === undefined
        ? Result.fromThrowable(
            () => this.clock(),
            () => failure(),
          )()
        : ok(now);
    if (supplied.isErr()) return err(supplied.error);
    if (!timestamp(supplied.value)) return err(failure());
    const effective =
      supplied.value > this.#wallHighWater
        ? supplied.value
        : this.#wallHighWater;
    this.#wallHighWater = effective;
    return ok(effective);
  }
  private run<T>(
    operation: Operation,
    work: () => Result<T, PermissionError>,
  ): ResultAsync<T, PermissionError> {
    const result = this.tail.then(() =>
      Result.fromThrowable(
        () => {
          if (this.shouldFail(operation)) return err(failure());
          return work();
        },
        () => invalid("invalid repository operation"),
      )().andThen((value) => value),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return ResultAsync.fromPromise(result, () => failure()).andThen(
      (value) => value,
    );
  }
  saveMany(
    records: readonly DurablePermissionGrantRecord[],
  ): ResultAsync<readonly DurablePermissionGrantRecord[], PermissionError> {
    return this.run("save", () => {
      // Advance high-water even when save does not consume a caller `now`.
      const observed = this.observeWallNow(undefined);
      if (observed.isErr()) return err(observed.error);
      if (!Array.isArray(records) || records.length === 0)
        return err(invalid("saveMany requires at least one record"));
      const copies: DurablePermissionGrantRecord[] = [];
      for (const record of records) {
        const checked = validateDurableGrantRecordResult(record);
        if (checked.isErr()) return err(checked.error);
        copies.push(checked.value);
      }
      const ids = new Set<string>();
      const identities = new Set<string>();
      for (const record of copies) {
        const identity = grantIdentityKey(record.identity);
        if (identity.isErr()) return err(identity.error);
        if (ids.has(record.grantId) || identities.has(identity.value))
          return err(invalid("duplicate grant identity"));
        ids.add(record.grantId);
        identities.add(identity.value);
      }
      const next = new Map(this.records);
      for (const record of copies) {
        if (next.has(record.grantId))
          return err(invalid("duplicate grant identity"));
        for (const existing of next.values()) {
          if (existing.grantId === record.grantId) continue;
          const equal = grantIdentitiesEqual(
            existing.identity,
            record.identity,
          );
          if (equal.isErr()) return err(failure());
          if (equal.value) return err(invalid("duplicate grant identity"));
        }
        next.set(record.grantId, record);
      }
      this.records = next;
      return ok(frozen(copies));
    });
  }
  list(
    project: string,
    now?: number,
  ): ResultAsync<readonly PermissionGrantSummary[], PermissionError> {
    return this.run("list", () => {
      if (!scalar(project, 256))
        return err(invalid("invalid repository list input"));
      if (now !== undefined && !timestamp(now))
        return err(invalid("invalid repository list input"));
      const observed = this.observeWallNow(now);
      if (observed.isErr()) return err(observed.error);
      // Listing is not expiry-filtered; high-water still advances.
      void observed.value;
      const sorted = [...this.records.values()]
        .filter((r) => r.identity.projectIdentity === project)
        .sort((a, b) => compareCodeUnits(a.grantId, b.grantId));
      const summaries: PermissionGrantSummary[] = [];
      for (const record of sorted) {
        const summary = summarizeDurableGrant(record);
        if (summary.isErr()) return err(failure());
        summaries.push(summary.value);
      }
      return ok(frozen(summaries));
    });
  }
  match(
    identity: GrantIdentityEnvelope,
    now?: number,
  ): ResultAsync<PermissionGrantSummary | undefined, PermissionError> {
    return this.run("match", () => {
      const checked = validateGrantIdentityResult(identity);
      if (checked.isErr())
        return err(invalid("invalid grant identity envelope"));
      if (now !== undefined && !timestamp(now))
        return err(invalid("invalid grant identity envelope"));
      const observed = this.observeWallNow(now);
      if (observed.isErr()) return err(observed.error);
      const effectiveNow = observed.value;
      for (const record of this.records.values()) {
        if (record.identity.projectIdentity !== checked.value.projectIdentity)
          continue;
        const equal = grantIdentitiesEqual(record.identity, checked.value);
        if (equal.isErr()) return err(failure());
        if (
          !equal.value ||
          record.state !== "active" ||
          (record.expiresAt !== undefined && record.expiresAt <= effectiveNow)
        )
          continue;
        const summary = summarizeDurableGrant(record);
        if (summary.isErr()) return err(failure());
        return ok(summary.value);
      }
      return ok(undefined);
    });
  }
  revoke(project: string, grantId: string): ResultAsync<void, PermissionError> {
    return this.run("revoke", () => {
      if (!scalar(project, 256) || !scalar(grantId, 256))
        return err(invalid("invalid revoke input"));
      const record = this.records.get(grantId);
      // Unknown/wrong-project never observes wall high-water — random revoke
      // attempts must not let callers poison the mark.
      if (!record || record.identity.projectIdentity !== project)
        return err({
          type: "unknown_grant" as const,
          message: "grant not found",
        });
      // Observe BEFORE the already-revoked early return so idempotent revokes
      // still advance high-water and cannot resurrect later expiries after
      // wall rollback.
      const observed = this.observeWallNow(undefined);
      if (observed.isErr()) return err(observed.error);
      if (record.state === "revoked") return ok(undefined);
      const revokedAt = observed.value;
      if (revokedAt < record.createdAt)
        return err(invalid("invalid revoke timestamp"));
      const cloned = cloneDurableGrant({
        ...record,
        state: "revoked",
        revokedAt,
      });
      if (cloned.isErr()) return err(failure());
      this.records.set(grantId, cloned.value);
      return ok(undefined);
    });
  }
}
