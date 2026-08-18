/**
 * Protected integrity-incident resolution: generate, never execute.
 *
 * `IntegrityIncident` has one exit. A maintainer-authorized run in the
 * protected `release` environment verifies immutable registry state, writes
 * a nonsecret authorization record and exact `npm deprecate` commands, and
 * halts `IncidentDeprecationPending`. A human runs those commands outside
 * CI. The next authorized dispatch reads each version's registry
 * `deprecated` field and only then writes the durable warning, refs, and
 * cleanup. This module never invokes `npm deprecate`, never unpublishes,
 * and never moves `latest`.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import type { ChangesetCleanupError } from "./changeset-cleanup.js";
import { type PublicPackageName, RELEASE_INPUT_LIMITS } from "./constants.js";
import type { GitHubError } from "./errors.js";
import { PackageNameSchema, SemVerSchema } from "./model.js";
import { releaseTagName } from "./notes-wrapper.js";
import type { ReleaseRefsError } from "./release-refs.js";
import {
  classifyPostMergeState,
  type PostMergeReleaseState,
  RELEASE_STATE_BOUNDS,
  type ReleaseAuthority,
  type ReleaseStateError,
} from "./release-state.js";

export const INCIDENT_RESOLUTION_SCHEMA_VERSION = 1 as const;
export const INCIDENT_CHECK_RUN_NAME = "release-integrity-incident" as const;
export const INCIDENT_ENVIRONMENT = "release" as const;

export const INCIDENT_RESOLUTION_BOUNDS = {
  messageBytes: RELEASE_STATE_BOUNDS.messageBytes,
  actorLength: 64,
  commandBytes: 1_024,
  members: RELEASE_INPUT_LIMITS.packageCount,
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const META = /[\n\r\0]/;

export type IncidentResolutionError =
  | {
      type: "IncidentUnauthorized";
      reason: "maintainer" | "environment" | "actor";
    }
  | { type: "IncidentNotActive"; primary: string }
  | {
      type: "IncidentRegistryDiverged";
      packageName: PublicPackageName;
      version: string;
      field: "digest" | "provenance" | "missing";
      expected?: string;
      actual?: string;
    }
  | { type: "IncidentMessageInvalid"; reason: string }
  | { type: "IncidentAuthorizationInvalid"; issues: readonly string[] }
  | {
      type: "IncidentDeprecationMismatch";
      packageName: PublicPackageName;
      version: string;
      expected: string;
      actual: string | null;
    }
  | { type: "IncidentDeprecationPending"; record: IncidentAuthorizationRecord }
  | { type: "IncidentCommandUnsafe"; command: string }
  | {
      type: "IncidentMustNotMutate";
      action: "deprecate" | "unpublish" | "latest";
    }
  | ReleaseStateError
  | ReleaseRefsError
  | ChangesetCleanupError
  | GitHubError;

export interface IncidentActor {
  actor: string;
  maintainerAuthorized: boolean;
  environment: string;
  environmentApproved: boolean;
}

export interface IncidentAffectedVersion {
  packageName: PublicPackageName;
  version: string;
  digest: string;
  provenanceSubjectDigest: string;
}

export interface IncidentAuthorizationRecord {
  schemaVersion: typeof INCIDENT_RESOLUTION_SCHEMA_VERSION;
  releasedSha: string;
  requiredMessage: string;
  affected: readonly IncidentAffectedVersion[];
  generatedAt: string;
}

export interface GeneratedDeprecationCommand {
  packageName: PublicPackageName;
  version: string;
  argv: readonly ["npm", "deprecate", string, string];
  command: string;
}

export interface IncidentGenerateResult {
  status: "IncidentDeprecationPending";
  record: IncidentAuthorizationRecord;
  commands: readonly GeneratedDeprecationCommand[];
}

export interface IncidentCompleteResult {
  status: "CompleteWithIncident";
  state: PostMergeReleaseState;
  record: IncidentAuthorizationRecord;
}

const AffectedSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    digest: z.string().regex(DIGEST),
    provenanceSubjectDigest: z.string().regex(DIGEST),
  })
  .strict();

export const IncidentAuthorizationRecordSchema = z
  .object({
    schemaVersion: z.literal(INCIDENT_RESOLUTION_SCHEMA_VERSION),
    releasedSha: z.string().regex(FULL_SHA),
    requiredMessage: z
      .string()
      .min(1)
      .max(INCIDENT_RESOLUTION_BOUNDS.messageBytes)
      .refine((value) => !META.test(value), "message must be a single line"),
    affected: z
      .array(AffectedSchema)
      .min(1)
      .max(INCIDENT_RESOLUTION_BOUNDS.members),
    generatedAt: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((record, context) => {
    const secretShaped = /token|password|secret|authorization/i;
    const serialized = JSON.stringify(record);
    if (secretShaped.test(serialized))
      context.addIssue({
        code: "custom",
        path: ["requiredMessage"],
        message: "authorization record must be nonsecret by construction",
      });
  });

export function validateIncidentAuthorizationRecord(
  input: unknown,
): Result<IncidentAuthorizationRecord, IncidentResolutionError> {
  const parsed = IncidentAuthorizationRecordSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "IncidentAuthorizationInvalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export function assertIncidentAuthorized(
  actor: IncidentActor,
): Result<void, IncidentResolutionError> {
  if (
    actor.actor.length === 0 ||
    actor.actor.length > INCIDENT_RESOLUTION_BOUNDS.actorLength
  )
    return err({ type: "IncidentUnauthorized", reason: "actor" });
  if (!actor.maintainerAuthorized)
    return err({ type: "IncidentUnauthorized", reason: "maintainer" });
  if (actor.environment !== INCIDENT_ENVIRONMENT || !actor.environmentApproved)
    return err({ type: "IncidentUnauthorized", reason: "environment" });
  return ok(undefined);
}

export function incidentNoticeFor(releasedSha: string): string {
  return `Weave integrity incident at ${releasedSha}: published bytes are unreproducible from merged source. Do not install this version. Await the fix-forward release.`;
}

export function shellEscapeDeprecatedMessage(
  message: string,
): Result<string, IncidentResolutionError> {
  if (
    message.length === 0 ||
    message.length > INCIDENT_RESOLUTION_BOUNDS.messageBytes
  )
    return err({
      type: "IncidentMessageInvalid",
      reason: "message exceeds the bounded incident input limit",
    });
  if (META.test(message))
    return err({
      type: "IncidentMessageInvalid",
      reason: "message must not contain control characters",
    });
  const escaped = message
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return ok(`"${escaped}"`);
}

export function generateDeprecationCommand(input: {
  packageName: PublicPackageName;
  version: string;
  message: string;
}): Result<GeneratedDeprecationCommand, IncidentResolutionError> {
  const target = `${input.packageName}@${input.version}`;
  if (target.length > RELEASE_INPUT_LIMITS.identifierLength + 64)
    return err({
      type: "IncidentMessageInvalid",
      reason: "package@version exceeds the bounded identifier limit",
    });
  const quoted = shellEscapeDeprecatedMessage(input.message);
  if (quoted.isErr()) return err(quoted.error);
  const command = `npm deprecate ${target} ${quoted.value}`;

  if (command.length > INCIDENT_RESOLUTION_BOUNDS.commandBytes)
    return err({
      type: "IncidentMessageInvalid",
      reason: "generated command exceeds the bounded command limit",
    });
  return ok({
    packageName: input.packageName,
    version: input.version,
    argv: ["npm", "deprecate", target, input.message],
    command,
  });
}

export interface IncidentRegistryPort {
  readPublishedVersion(input: {
    packageName: PublicPackageName;
    version: string;
  }): ResultAsync<
    {
      present: boolean;
      digest: string | null;
      provenanceSubjectDigest: string | null;
      deprecated: string | null;
    },
    GitHubError | IncidentResolutionError
  >;
}

export interface IncidentCompletionPorts {
  createIncidentRefs(input: {
    record: IncidentAuthorizationRecord;
    authority: ReleaseAuthority;
  }): ResultAsync<void, IncidentResolutionError>;
  createIncidentCheckRun(input: {
    releasedSha: string;
    record: IncidentAuthorizationRecord;
  }): ResultAsync<void, IncidentResolutionError>;
  completeChangesetCleanup(input: {
    releasedSha: string;
    record: IncidentAuthorizationRecord;
  }): ResultAsync<void, IncidentResolutionError>;
  rereadAuthority(): ResultAsync<ReleaseAuthority, ReleaseStateError>;
}

export interface IncidentResolutionRequest {
  actor: IncidentActor;
  authority: ReleaseAuthority;
  storedRecord?: unknown;
  now?: string;
}

/**
 * Phase (a): authorize, verify immutable registry bytes, emit commands, halt.
 * Never mutates the registry.
 */
export function generateIncidentResolution(
  request: IncidentResolutionRequest,
  registry: IncidentRegistryPort,
): ResultAsync<IncidentGenerateResult, IncidentResolutionError> {
  const authorized = assertIncidentAuthorized(request.actor);
  if (authorized.isErr()) return errAsync(authorized.error);
  const classified = classifyPostMergeState(request.authority);
  if (classified.isErr()) return errAsync(classified.error);
  if (
    classified.value.primary !== "IntegrityIncident" &&
    request.storedRecord === undefined
  )
    return errAsync({
      type: "IncidentNotActive",
      primary: classified.value.primary,
    });
  const affected = affectedFromAuthority(request.authority);
  if (affected.isErr()) return errAsync(affected.error);
  return verifyImmutableRegistry(affected.value, registry).andThen(() => {
    const record = buildAuthorizationRecord(
      request.authority.releasedSha,
      affected.value,
      request.now ?? "1970-01-01T00:00:00.000Z",
    );
    const validated = validateIncidentAuthorizationRecord(record);
    if (validated.isErr()) return errAsync(validated.error);
    const commands: GeneratedDeprecationCommand[] = [];
    for (const member of validated.value.affected) {
      const command = generateDeprecationCommand({
        packageName: member.packageName,
        version: member.version,
        message: validated.value.requiredMessage,
      });
      if (command.isErr()) return errAsync(command.error);
      commands.push(command.value);
    }
    return okAsync({
      status: "IncidentDeprecationPending" as const,
      record: validated.value,
      commands,
    });
  });
}

/**
 * Phase (c): read back `deprecated`, then write warnings/refs/cleanup.
 * Verification strictly precedes every mutation of GitHub evidence.
 */
export function completeIncidentResolution(
  request: IncidentResolutionRequest,
  registry: IncidentRegistryPort,
  completion: IncidentCompletionPorts,
): ResultAsync<IncidentCompleteResult, IncidentResolutionError> {
  const authorized = assertIncidentAuthorized(request.actor);
  if (authorized.isErr()) return errAsync(authorized.error);
  const record = validateIncidentAuthorizationRecord(request.storedRecord);
  if (record.isErr()) return errAsync(record.error);
  return verifyImmutableRegistry(record.value.affected, registry)
    .andThen(() => verifyDeprecatedReadback(record.value, registry))
    .andThen(() =>
      completion.createIncidentRefs({
        record: record.value,
        authority: request.authority,
      }),
    )
    .andThen(() =>
      completion.createIncidentCheckRun({
        releasedSha: record.value.releasedSha,
        record: record.value,
      }),
    )
    .andThen(() =>
      completion.completeChangesetCleanup({
        releasedSha: record.value.releasedSha,
        record: record.value,
      }),
    )
    .andThen(() => completion.rereadAuthority())
    .andThen((authority) => {
      const classified = classifyPostMergeState(authority);
      if (classified.isErr())
        return errAsync<IncidentCompleteResult, IncidentResolutionError>(
          classified.error,
        );
      if (classified.value.primary !== "CompleteWithIncident")
        return errAsync<IncidentCompleteResult, IncidentResolutionError>({
          type: "IncidentNotActive",
          primary: classified.value.primary,
        });
      return okAsync({
        status: "CompleteWithIncident" as const,
        state: classified.value,
        record: record.value,
      });
    });
}

export function refuseRegistryMutation(
  action: "deprecate" | "unpublish" | "latest",
): Result<never, IncidentResolutionError> {
  return err({ type: "IncidentMustNotMutate", action });
}

function affectedFromAuthority(
  authority: ReleaseAuthority,
): Result<readonly IncidentAffectedVersion[], IncidentResolutionError> {
  const members = authority.members.filter((member) => member.published);
  if (members.length === 0)
    return err({
      type: "IncidentAuthorizationInvalid",
      issues: ["no published members to resolve"],
    });
  const affected: IncidentAffectedVersion[] = [];
  for (const member of members) {
    if (
      member.registryDigest === null ||
      member.provenanceSubjectDigest === null
    )
      return err({
        type: "IncidentRegistryDiverged",
        packageName: member.packageName,
        version: member.version,
        field: "missing",
      });
    affected.push({
      packageName: member.packageName,
      version: member.version,
      digest: member.recordedDigest ?? member.registryDigest,
      provenanceSubjectDigest: member.provenanceSubjectDigest,
    });
  }
  return ok(affected);
}

function buildAuthorizationRecord(
  releasedSha: string,
  affected: readonly IncidentAffectedVersion[],
  generatedAt: string,
): IncidentAuthorizationRecord {
  return {
    schemaVersion: INCIDENT_RESOLUTION_SCHEMA_VERSION,
    releasedSha,
    requiredMessage: incidentNoticeFor(releasedSha),
    affected,
    generatedAt,
  };
}

function verifyImmutableRegistry(
  affected: readonly IncidentAffectedVersion[],
  registry: IncidentRegistryPort,
): ResultAsync<void, IncidentResolutionError> {
  return affected.reduce<ResultAsync<void, IncidentResolutionError>>(
    (chain, member) =>
      chain.andThen(() =>
        registry.readPublishedVersion(member).andThen((observed) => {
          if (!observed.present || observed.digest === null)
            return errAsync({
              type: "IncidentRegistryDiverged" as const,
              packageName: member.packageName,
              version: member.version,
              field: "missing" as const,
            });
          if (observed.digest !== member.digest)
            return errAsync({
              type: "IncidentRegistryDiverged" as const,
              packageName: member.packageName,
              version: member.version,
              field: "digest" as const,
              expected: member.digest,
              actual: observed.digest,
            });
          if (
            observed.provenanceSubjectDigest !== member.provenanceSubjectDigest
          )
            return errAsync({
              type: "IncidentRegistryDiverged" as const,
              packageName: member.packageName,
              version: member.version,
              field: "provenance" as const,
              expected: member.provenanceSubjectDigest,
              actual: observed.provenanceSubjectDigest ?? undefined,
            });
          return okAsync(undefined);
        }),
      ),
    okAsync(undefined),
  );
}

function verifyDeprecatedReadback(
  record: IncidentAuthorizationRecord,
  registry: IncidentRegistryPort,
): ResultAsync<void, IncidentResolutionError> {
  return record.affected.reduce<ResultAsync<void, IncidentResolutionError>>(
    (chain, member) =>
      chain.andThen(() =>
        registry.readPublishedVersion(member).andThen((observed) => {
          if (observed.deprecated !== record.requiredMessage)
            return errAsync({
              type: "IncidentDeprecationMismatch" as const,
              packageName: member.packageName,
              version: member.version,
              expected: record.requiredMessage,
              actual: observed.deprecated,
            });
          return okAsync(undefined);
        }),
      ),
    okAsync(undefined),
  );
}

export function incidentReleaseNotes(input: {
  packageName: PublicPackageName;
  version: string;
  record: IncidentAuthorizationRecord;
  changelog: string;
}): string {
  const tag = releaseTagName(input.packageName, input.version);
  return [
    input.record.requiredMessage,
    "",
    `Package: ${input.packageName}`,
    `Version: ${input.version}`,
    `Tag: ${tag}`,
    `Released SHA: ${input.record.releasedSha}`,
    "",
    input.changelog,
  ].join("\n");
}
