/**
 * Adapter-owned artifact file I/O and digest computation (Pi adapter contract;
 * docs/architecture/adapter-boundary.md "Artifact Integrity Metadata"). The engine only
 * owns `ArtifactIntegrityMetadata`'s type/format/fail-closed comparison; it
 * never reads artifact contents. This module reads bytes from a verified,
 * contained, no-follow-checked path under the canonical project root and
 * hashes those exact bytes - never a lexical-check-then-reopen. All
 * filesystem side effects are Bun-native (`Bun.file`) or routed through the
 * injected `PathContainmentPort` (`path-containment.ts`) - no `node:fs`.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import { MAX_FINAL_OUTPUT_BYTES } from "./child-history-schema.js";
import type { PiChildStatus, PiChildUsageAggregate } from "./child-tree.js";
import {
  makeArtifactDigestFailedFailure,
  makeArtifactReadFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  BunSecureRelativeFileProvider,
  isLexicallyContained,
  type SecureRelativeFileProvider,
} from "./path-containment.js";

export const MAX_SANITIZED_CHILD_INDEX_ENTRIES = 1_024;
export const MAX_SANITIZED_CHILD_EXPORT_BYTES = 256 * 1_024;
const MAX_SANITIZED_IDENTIFIER_BYTES = 256;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;

const boundedString = (maxBytes: number) =>
  z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `string exceeds ${maxBytes} UTF-8 bytes`,
    );
const boundedIdentifier = boundedString(MAX_SANITIZED_IDENTIFIER_BYTES).min(1);
const boundedName = boundedIdentifier;
const safeNumber = z.number().finite().nonnegative().max(MAX_SAFE_NUMBER);
const safeInteger = safeNumber.refine(
  Number.isSafeInteger,
  "must be a safe integer",
);
const statusSchema = z.enum([
  "queued",
  "spawning",
  "handshaking",
  "bootstrapping",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
]);
const kindSchema = z.enum(["ordinary", "nested", "workflow-step"]);

export const PiSanitizedChildIndexEntrySchema = z
  .object({
    id: boundedIdentifier,
    parentId: boundedIdentifier.optional(),
    name: boundedName,
    kind: kindSchema,
    status: statusSchema,
    workflow: z
      .object({
        workflow: boundedIdentifier.optional(),
        step: boundedIdentifier.optional(),
      })
      .strict()
      .optional(),
    currentTurn: safeInteger,
    startedAtMs: safeInteger,
    elapsedMs: safeInteger,
    usage: z
      .object({
        inputTokens: safeInteger,
        outputTokens: safeInteger,
        cacheReadTokens: safeInteger,
        cacheWriteTokens: safeInteger,
        cost: safeNumber,
      })
      .strict(),
    finalOutput: boundedString(MAX_FINAL_OUTPUT_BYTES).optional(),
    interventionCount: safeInteger,
  })
  .strict();

export const PiSanitizedChildIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    children: z
      .array(PiSanitizedChildIndexEntrySchema)
      .max(MAX_SANITIZED_CHILD_INDEX_ENTRIES),
  })
  .strict();

export type PiSanitizedChildIndexEntry = z.infer<
  typeof PiSanitizedChildIndexEntrySchema
>;
export type PiSanitizedChildIndex = z.infer<typeof PiSanitizedChildIndexSchema>;

export interface PiArtifactReadInput {
  readonly projectRoot: string;
  readonly relativePath: string;
}

export interface PiArtifactDigest {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly byteLength: number;
}

export type PiSanitizedChildIndexError =
  | {
      readonly type: "invalid-child-index";
      readonly reason: "invalid-number" | "invalid-string" | "invalid-entry";
    }
  | { readonly type: "child-index-too-large" }
  | { readonly type: "child-export-too-large" };

/** Input is a projection source, never a PiChildHistoryIndexV1 record. */
export interface PiSanitizedChildIndexInput {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly kind: "ordinary" | "nested" | "workflow-step";
  readonly status: PiChildStatus;
  readonly workflow?: { readonly workflow?: string; readonly step?: string };
  readonly currentTurn: number;
  readonly startedAtMs: number;
  readonly elapsedMs: number;
  readonly usage: PiChildUsageAggregate;
  readonly finalOutput?: string;
  readonly interventionCount: number;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let low = 0;
  let high = maxBytes;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    try {
      decoder.decode(bytes.subarray(0, end));
      low = end;
    } catch {
      high = end - 1;
    }
  }
  return decoder.decode(bytes.subarray(0, low));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicitly projects allowlisted fields before Zod validation. */
function projectEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const usage = isRecord(value.usage)
    ? {
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        cacheReadTokens: value.usage.cacheReadTokens,
        cacheWriteTokens: value.usage.cacheWriteTokens,
        cost: value.usage.cost,
      }
    : value.usage;
  const workflow = isRecord(value.workflow)
    ? { workflow: value.workflow.workflow, step: value.workflow.step }
    : value.workflow;
  return {
    id: value.id,
    parentId: value.parentId,
    name: value.name,
    kind: value.kind,
    status: value.status,
    workflow,
    currentTurn: value.currentTurn,
    startedAtMs: value.startedAtMs,
    elapsedMs: value.elapsedMs,
    usage,
    finalOutput:
      typeof value.finalOutput === "string"
        ? truncateUtf8(value.finalOutput, MAX_FINAL_OUTPUT_BYTES)
        : value.finalOutput,
    interventionCount: value.interventionCount,
  };
}

/** Builds a bounded, versioned child export without reading or accepting raw history. */
export function createPiSanitizedChildIndex(
  entries: readonly PiSanitizedChildIndexInput[],
): Result<PiSanitizedChildIndex, PiSanitizedChildIndexError> {
  if (entries.length > MAX_SANITIZED_CHILD_INDEX_ENTRIES)
    return err({ type: "child-index-too-large" });

  const parsedEntries = entries.map((entry) =>
    PiSanitizedChildIndexEntrySchema.safeParse(projectEntry(entry)),
  );
  const invalid = parsedEntries.find((parsed) => !parsed.success);
  if (invalid !== undefined) {
    const issue = invalid.success ? undefined : invalid.error.issues[0];
    const field = issue?.path.at(-1);
    const numericField =
      typeof field === "string" &&
      [
        "currentTurn",
        "startedAtMs",
        "elapsedMs",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "cost",
        "interventionCount",
      ].includes(field);
    const numberIssue =
      numericField ||
      (issue?.code === "invalid_type" && issue.expected === "number");
    const stringIssue =
      !numericField &&
      issue?.code === "invalid_type" &&
      issue.expected === "string";
    let reason: "invalid-number" | "invalid-string" | "invalid-entry";
    if (numberIssue) reason = "invalid-number";
    else if (
      stringIssue ||
      issue?.code === "too_big" ||
      issue?.code === "custom"
    )
      reason = "invalid-string";
    else reason = "invalid-entry";
    return err({ type: "invalid-child-index", reason });
  }

  const result: PiSanitizedChildIndex = {
    schemaVersion: 1,
    children: parsedEntries.map((parsed) => {
      const data = (
        parsed as { success: true; data: PiSanitizedChildIndexEntry }
      ).data;
      return Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      ) as PiSanitizedChildIndexEntry;
    }),
  };
  const serializedBytes = new TextEncoder().encode(
    JSON.stringify(result),
  ).byteLength;
  if (serializedBytes > MAX_SANITIZED_CHILD_EXPORT_BYTES)
    return err({ type: "child-export-too-large" });
  return ok(result);
}

export class PiSanitizedChildIndexExporter {
  export(
    entries: readonly PiSanitizedChildIndexInput[],
  ): Result<PiSanitizedChildIndex, PiSanitizedChildIndexError> {
    return createPiSanitizedChildIndex(entries);
  }
}

/**
 * Adapter-owned artifact port (docs/architecture/adapter-boundary.md: "artifact digest
 * computation ... = Adapter"). Production and fakes both implement this;
 * `PiWorkflowController` never reads files itself.
 */
export interface PiArtifactProvider {
  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure>;
}

/** Hashes bytes already read from the exact no-follow-verified path - pure, no reopen. */
function hashBytes(
  bytes: Uint8Array,
  relativePath: string,
): Result<PiArtifactDigest, PiAdapterFailure> {
  // Fixed, bounded reason only - never the raw thrown `Error.message`/stack,
  // which could otherwise carry absolute filesystem paths or other
  // internal detail into a failure's `correlation` field.
  const digestResult = Result.fromThrowable(
    () => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    (): string => "digest-computation-failed",
  )();
  if (digestResult.isErr()) {
    return err(
      makeArtifactDigestFailedFailure(relativePath, digestResult.error),
    );
  }
  return ok({
    algorithm: "sha256" as const,
    digest: digestResult.value,
    byteLength: bytes.byteLength,
  });
}

export class BunPiArtifactProvider implements PiArtifactProvider {
  private readonly provider: SecureRelativeFileProvider;

  constructor(
    provider: SecureRelativeFileProvider = new BunSecureRelativeFileProvider(),
  ) {
    this.provider = provider;
  }

  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure> {
    if (!isLexicallyContained(input.relativePath)) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path escapes the project root",
        ),
      );
    }
    // Reads bytes and computes identity from one no-follow-verified
    // descriptor chain (`SecureRelativeFileProvider.readFile`) - never a
    // lexical check followed by a separate path-based reopen (Pi adapter contract
    //).
    return this.provider
      .readFile(input.projectRoot, input.relativePath)
      .mapErr((reason) =>
        makeArtifactReadFailedFailure(input.relativePath, reason),
      )
      .andThen(({ bytes }) => hashBytes(bytes, input.relativePath));
  }
}

/** In-memory fake for isolated tests - no real filesystem access. */
export class FakePiArtifactProvider implements PiArtifactProvider {
  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure> {
    if (!isLexicallyContained(input.relativePath)) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path escapes the project root",
        ),
      );
    }
    const bytes = this.files.get(input.relativePath);
    if (bytes === undefined) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path-component-missing",
        ),
      );
    }
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return okAsync({
      algorithm: "sha256" as const,
      digest,
      byteLength: bytes.byteLength,
    });
  }
}
