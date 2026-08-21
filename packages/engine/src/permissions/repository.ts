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
export type PermissionRepositoryFailurePlan = {
  readonly save?: boolean | (() => boolean);
  readonly list?: boolean | (() => boolean);
  readonly match?: boolean | (() => boolean);
  readonly revoke?: boolean | (() => boolean);
};
type ObjectLike<T> = T & object;
type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type HydratedDisplay<T> = { summary: T; details?: T };
type HydratedRecord<T> = {
  grantId: T;
  identity: {
    projectIdentity: T;
    agentName: T;
    registrationOwner: T;
    toolIdentity: T;
    registrationRevision: T;
    policyFingerprint: T;
    requestSchemaVersion: T;
    requestDigest: T;
  };
  scope: T;
  display: HydratedDisplay<T>;
  createdAt: T;
  expiresAt?: T;
  revokedAt?: T;
  state: T;
};

type MutablePermissionGrantSummary = {
  project: string;
  grantId: string;
  agentName: string;
  toolIdentity: string;
  scope: "durable";
  display: PermissionGrantSummary["display"];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  state: "active" | "revoked";
};
type MutableDurableGrantRecord = {
  grantId: string;
  identity: GrantIdentityEnvelope;
  scope: "durable";
  display: DurablePermissionGrantRecord["display"];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  state: "active" | "revoked";
};

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

const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const primitiveTag = <T>(value: T): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Object(value) === value) return "object";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  return tagged.isOk() ? tagged.value : "[object Object]";
};

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && value !== undefined && Object(value) === value;

const parseText = <T>(
  value: T,
  maxBytes: number,
): Result<string, PermissionError> => {
  if (primitiveTag(value) !== "[object String]")
    return err(invalid("invalid text field"));
  const text = String(value);
  if (
    text.length === 0 ||
    encoder.encode(text).byteLength > maxBytes ||
    /[\uD800-\uDFFF]/u.test(text)
  )
    return err(invalid("invalid text field"));
  return ok(text);
};

const parseTimestamp = <T>(value: T): Result<number, PermissionError> => {
  if (primitiveTag(value) !== "[object Number]")
    return err(invalid("invalid timestamp"));
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    return err(invalid("invalid timestamp"));
  return ok(timestamp);
};

function readOwnData<T>(
  value: T,
  allowed: readonly string[],
): Result<SnapshotFields, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (!isObjectLike(value) || Array.isArray(value))
        return err(invalid("invalid repository object"));
      if (Object.getPrototypeOf(value) !== Object.prototype)
        return err(invalid("object has an unsafe prototype"));
      const allowedSet = new Set(allowed);
      const fields = new Map<string, PropertyDescriptor>();
      for (const key of Reflect.ownKeys(value)) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalid("object has unexpected fields"));
        const text = String(key);
        if (!allowedSet.has(text))
          return err(invalid("object has unexpected fields"));
        const descriptor = Object.getOwnPropertyDescriptor(value, text);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          return err(invalid("object contains an accessor or hidden field"));
        fields.set(text, descriptor);
      }
      return ok(fields);
    },
    () => invalid("invalid repository object"),
  )().andThen((result) => result);
}

function validateGrantIdentityUnsafe<T>(
  value: T,
): Result<GrantIdentityEnvelope, PermissionError> {
  const fields = readOwnData(value, IDENTITY_FIELDS);
  if (fields.isErr()) return err(invalid("invalid grant identity envelope"));
  for (const field of IDENTITY_FIELDS) {
    if (!fields.value.has(field))
      return err(invalid("invalid grant identity envelope"));
  }
  const projectIdentity = parseText(
    fields.value.get("projectIdentity")?.value,
    256,
  );
  const agentName = parseText(fields.value.get("agentName")?.value, 256);
  const registrationOwner = parseText(
    fields.value.get("registrationOwner")?.value,
    128,
  );
  const toolIdentity = parseText(fields.value.get("toolIdentity")?.value, 256);
  const registrationRevision = parseText(
    fields.value.get("registrationRevision")?.value,
    64,
  );
  const policyFingerprint = parseText(
    fields.value.get("policyFingerprint")?.value,
    256,
  );
  const requestSchemaVersion = parseText(
    fields.value.get("requestSchemaVersion")?.value,
    64,
  );
  const requestDigest = parseText(
    fields.value.get("requestDigest")?.value,
    256,
  );
  if (
    projectIdentity.isErr() ||
    agentName.isErr() ||
    registrationOwner.isErr() ||
    toolIdentity.isErr() ||
    registrationRevision.isErr() ||
    policyFingerprint.isErr() ||
    requestSchemaVersion.isErr() ||
    requestDigest.isErr()
  )
    return err(invalid("invalid grant identity envelope"));
  return ok(
    Object.freeze({
      projectIdentity: projectIdentity.value,
      agentName: agentName.value,
      registrationOwner: registrationOwner.value,
      toolIdentity: toolIdentity.value,
      registrationRevision: registrationRevision.value,
      policyFingerprint: policyFingerprint.value,
      requestSchemaVersion: requestSchemaVersion.value,
      requestDigest: requestDigest.value,
    }),
  );
}

/** Result-returning strict identity validation for repository boundaries. */
export function validateGrantIdentityResult<T>(
  value: T,
): Result<GrantIdentityEnvelope, PermissionError> {
  return Result.fromThrowable(
    () => validateGrantIdentityUnsafe(value),
    () => invalid("invalid grant identity envelope"),
  )().andThen((result) => result);
}

/** Compatibility type guard backed by the Result validator. */
export function validateGrantIdentity<T>(
  value: T,
): value is T & GrantIdentityEnvelope {
  return validateGrantIdentityResult(value).isOk();
}

function validateDurableGrantRecordUnsafe<T>(
  value: T,
): Result<DurablePermissionGrantRecord, PermissionError> {
  const fields = readOwnData(value, RECORD_FIELDS);
  if (fields.isErr()) return err(invalid("invalid durable grant record"));
  for (const field of [
    "grantId",
    "identity",
    "scope",
    "display",
    "createdAt",
    "state",
  ] as const) {
    if (!fields.value.has(field))
      return err(invalid("invalid durable grant record"));
  }
  const identity = validateGrantIdentityResult(
    fields.value.get("identity")?.value,
  );
  if (identity.isErr()) return err(invalid("invalid durable grant record"));
  const display = sanitizePermissionDisplay(fields.value.get("display")?.value);
  if (display.isErr()) return err(invalid("invalid durable grant display"));
  const grantId = parseText(fields.value.get("grantId")?.value, 256);
  const createdAt = parseTimestamp(fields.value.get("createdAt")?.value);
  const expiresDescriptor = fields.value.get("expiresAt");
  const revokedDescriptor = fields.value.get("revokedAt");
  const expiresAt = expiresDescriptor
    ? parseTimestamp(expiresDescriptor.value)
    : ok<number | undefined>(void 0);
  const revokedAt = revokedDescriptor
    ? parseTimestamp(revokedDescriptor.value)
    : ok<number | undefined>(void 0);
  const scope = fields.value.get("scope")?.value;
  const state = fields.value.get("state")?.value;
  if (
    grantId.isErr() ||
    createdAt.isErr() ||
    expiresAt.isErr() ||
    revokedAt.isErr() ||
    scope !== "durable" ||
    (state !== "active" && state !== "revoked") ||
    (expiresAt.value !== undefined && expiresAt.value <= createdAt.value) ||
    (revokedAt.value !== undefined && revokedAt.value < createdAt.value) ||
    (state === "active" && revokedAt.value !== undefined) ||
    (state === "revoked" && revokedAt.value === undefined)
  )
    return err(invalid("invalid durable grant record"));

  const base: MutableDurableGrantRecord = {
    grantId: grantId.value,
    identity: identity.value,
    scope: "durable",
    display: display.value,
    createdAt: createdAt.value,
    state,
  };
  let safe = base;
  if (expiresAt.value !== undefined)
    safe = Object.assign(safe, { expiresAt: expiresAt.value });
  if (revokedAt.value !== undefined)
    safe = Object.assign(safe, { revokedAt: revokedAt.value });
  return ok(Object.freeze(safe));
}

/** Result-returning strict record validation used before repository mutation. */
export function validateDurableGrantRecordResult<T>(
  value: T,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return Result.fromThrowable(
    () => validateDurableGrantRecordUnsafe(value),
    () => invalid("invalid durable grant record"),
  )().andThen((result) => result);
}

/** Compatibility type guard backed by the Result validator. */
export function validateDurableGrantRecord<T>(
  value: T,
): value is T & DurablePermissionGrantRecord {
  return validateDurableGrantRecordResult(value).isOk();
}

const optionalHydrated = <T>(
  summary: T,
  details: T | null,
): HydratedDisplay<T> => {
  const display: HydratedDisplay<T> = { summary };
  if (details !== null) display.details = details;
  return display;
};

export function hydrateDurableGrant<T>(
  row: T,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return Result.fromThrowable(
    () => {
      const fields = readOwnData(row, STORAGE_ROW_FIELDS);
      if (fields.isErr()) return err(invalid("invalid permission grant row"));
      for (const field of STORAGE_ROW_FIELDS) {
        if (!fields.value.has(field))
          return err(invalid("invalid permission grant row"));
      }
      const descriptor = (field: (typeof STORAGE_ROW_FIELDS)[number]) =>
        fields.value.get(field);
      const display = optionalHydrated(
        descriptor("display_summary")?.value,
        descriptor("display_details")?.value,
      );
      const hydrated: HydratedRecord<PropertyDescriptor["value"]> = {
        grantId: descriptor("grant_id")?.value,
        identity: {
          projectIdentity: descriptor("project_identity")?.value,
          agentName: descriptor("agent_name")?.value,
          registrationOwner: descriptor("registration_owner")?.value,
          toolIdentity: descriptor("tool_identity")?.value,
          registrationRevision: descriptor("registration_revision")?.value,
          policyFingerprint: descriptor("policy_fingerprint")?.value,
          requestSchemaVersion: descriptor("request_schema_version")?.value,
          requestDigest: descriptor("request_digest")?.value,
        },
        scope: "durable",
        display,
        createdAt: descriptor("created_at")?.value,
        state: descriptor("state")?.value,
      };
      const expires = descriptor("expires_at")?.value;
      const revoked = descriptor("revoked_at")?.value;
      let withOptional = hydrated;
      if (expires !== null)
        withOptional = Object.assign(withOptional, { expiresAt: expires });
      if (revoked !== null)
        withOptional = Object.assign(withOptional, { revokedAt: revoked });
      return validateDurableGrantRecordResult(withOptional);
    },
    () => invalid("invalid permission grant row"),
  )().andThen((result) => result);
}

/** Stable structural identity digest with fixed field order. */
export function grantIdentityKey<T>(
  identity: T,
): Result<string, PermissionError> {
  return validateGrantIdentityResult(identity).andThen((safe) =>
    permissionDigest(IDENTITY_FIELDS.map((field) => safe[field])),
  );
}

export function grantIdentitiesEqual<T, U>(
  a: T,
  b: U,
): Result<boolean, PermissionError> {
  return grantIdentityKey(a).andThen((left) =>
    grantIdentityKey(b).map((right) => left === right),
  );
}

export function cloneDurableGrant<T>(
  record: T,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return validateDurableGrantRecordResult(record);
}

export function summarizeDurableGrant<T>(
  record: T,
): Result<PermissionGrantSummary, PermissionError> {
  return validateDurableGrantRecordResult(record).map((checked) => {
    const summary: MutablePermissionGrantSummary = {
      project: checked.identity.projectIdentity,
      grantId: checked.grantId,
      agentName: checked.identity.agentName,
      toolIdentity: checked.identity.toolIdentity,
      scope: "durable",
      display: Object.freeze({ ...checked.display }),
      createdAt: checked.createdAt,
      state: checked.state,
    };
    if (checked.expiresAt !== undefined) summary.expiresAt = checked.expiresAt;
    if (checked.revokedAt !== undefined) summary.revokedAt = checked.revokedAt;
    return Object.freeze(summary);
  });
}

export class InMemoryPermissionApprovalRepository
  implements PermissionApprovalRepository
{
  private records = new Map<string, DurablePermissionGrantRecord>();
  private tail: Promise<void> = Promise.resolve();
  #wallHighWater = 0;
  constructor(
    private readonly plan: PermissionRepositoryFailurePlan = {},
    private readonly clock: Clock = () => Date.now(),
  ) {}
  private shouldFail(operation: Operation): boolean {
    const value = this.plan[operation];
    if (value === true) return true;
    if (value === false || value === undefined) return false;
    return value();
  }
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
    const checked = parseTimestamp(supplied.value);
    if (checked.isErr()) return err(failure());
    const effective =
      checked.value > this.#wallHighWater ? checked.value : this.#wallHighWater;
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
      () => void 0,
      () => void 0,
    );
    return ResultAsync.fromPromise(result, () => failure()).andThen(
      (value) => value,
    );
  }
  saveMany<T>(
    records: readonly T[],
  ): ResultAsync<readonly DurablePermissionGrantRecord[], PermissionError> {
    return this.run("save", () => {
      const observed = this.observeWallNow(void 0);
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
      return ok(Object.freeze(copies));
    });
  }
  list(
    project: string,
    now?: number,
  ): ResultAsync<readonly PermissionGrantSummary[], PermissionError> {
    return this.run("list", () => {
      const checkedProject = parseText(project, 256);
      if (checkedProject.isErr())
        return err(invalid("invalid repository list input"));
      if (now !== undefined && parseTimestamp(now).isErr())
        return err(invalid("invalid repository list input"));
      const observed = this.observeWallNow(now);
      if (observed.isErr()) return err(observed.error);
      void observed.value;
      const sorted = [...this.records.values()]
        .filter(
          (record) => record.identity.projectIdentity === checkedProject.value,
        )
        .sort((a, b) => compareCodeUnits(a.grantId, b.grantId));
      const summaries: PermissionGrantSummary[] = [];
      for (const record of sorted) {
        const summary = summarizeDurableGrant(record);
        if (summary.isErr()) return err(failure());
        summaries.push(summary.value);
      }
      return ok(Object.freeze(summaries));
    });
  }
  match<T>(
    identity: T,
    now?: number,
  ): ResultAsync<PermissionGrantSummary | undefined, PermissionError> {
    return this.run("match", () => {
      const checked = validateGrantIdentityResult(identity);
      if (checked.isErr())
        return err(invalid("invalid grant identity envelope"));
      if (now !== undefined && parseTimestamp(now).isErr())
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
      return ok(void 0);
    });
  }
  revoke(project: string, grantId: string): ResultAsync<void, PermissionError> {
    return this.run("revoke", () => {
      const checkedProject = parseText(project, 256);
      const checkedGrantId = parseText(grantId, 256);
      if (checkedProject.isErr() || checkedGrantId.isErr())
        return err(invalid("invalid revoke input"));
      const record = this.records.get(checkedGrantId.value);
      if (!record || record.identity.projectIdentity !== checkedProject.value)
        return err({
          type: "unknown_grant" as const,
          message: "grant not found",
        });
      const observed = this.observeWallNow(void 0);
      if (observed.isErr()) return err(observed.error);
      if (record.state === "revoked") return ok(void 0);
      const revokedAt = observed.value;
      if (revokedAt < record.createdAt)
        return err(invalid("invalid revoke timestamp"));
      const replacement: MutableDurableGrantRecord = {
        ...record,
        state: "revoked",
        revokedAt,
      };
      const cloned = cloneDurableGrant(replacement);
      if (cloned.isErr()) return err(failure());
      this.records.set(checkedGrantId.value, cloned.value);
      return ok(void 0);
    });
  }
}
