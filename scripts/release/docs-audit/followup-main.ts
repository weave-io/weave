/**
 * Trusted-controller follow-up for fork pull requests.
 *
 * This module is the only code that reads a fork after the pull-request
 * workflow. The controller is checked out at `main`; the fork is downloaded as
 * a bounded gzip/tar byte string and materialised as regular files below a
 * separate quarantine root. Nothing in that root is installed, imported, or
 * executed.
 */
import { dirname, join, relative, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { z } from "zod";
import { FullShaSchema } from "../model.js";
import {
  type DocsAuditAgentError,
  type DocsAuditAgentInput,
  type DocsAuditAgentResult,
  DocsAuditFindingSchema,
  runDocsAuditAgent,
} from "./agent.js";
import {
  DeterministicAuditArtifactSchema,
  deterministicAuditArtifact,
} from "./audit-main.js";
import {
  type DeterministicDocsCheckError,
  type DeterministicDocsCheckResult,
  docsAuditDigest,
  runDeterministicDocsCheck,
} from "./deterministic.js";
import {
  type AppliedDocsAuditPatch,
  applyDocsAuditPatches,
  type DocsAuditPatch,
  type DocsAuditPatchApproval,
  writeAppliedDocsAuditPatches,
} from "./patches.js";
import {
  DOCS_AUDIT_LIMITS,
  isAllowedDocsPatchPath,
  isSafeRelativePath,
} from "./policy.js";

const log = logger.child({ module: "docs-audit-followup-main" });

export const FOLLOWUP_MAIN_SCHEMA_VERSION = 1 as const;
export const FOLLOWUP_CONTROLLER_REF = "refs/heads/main" as const;
export const DOCS_AUDIT_FOLLOWUP_CHECK_NAME = "docs-audit-followup" as const;
export const DOCS_AUDIT_CHECK_NAME = "docs-audit" as const;
export const FOLLOWUP_APP_TOKEN_ENV = "RELEASE_APP_INSTALLATION_TOKEN" as const;
export const FOLLOWUP_READ_TOKEN_ENV = "GITHUB_TOKEN" as const;
export const FOLLOWUP_REPOSITORY = "weave-io/weave" as const;

/** Limits apply before decompression, after decompression, and per file. */
export const FOLLOWUP_ARCHIVE_LIMITS = {
  compressedBytes: 32 * 1024 * 1024,
  uncompressedBytes: 128 * 1024 * 1024,
  compressionRatio: 200,
  entries: 4_096,
  fileBytes: 8 * 1024 * 1024,
  totalFileBytes: 96 * 1024 * 1024,
  pathChars: 512,
} as const;

export const FOLLOWUP_INPUT_LIMITS = {
  prNumber: { min: 1, max: 1_000_000 },
  pathChars: 1_024,
  files: 5_000,
  filePathChars: 512,
  responseBytes: 1 * 1024 * 1024,
  commentChars: 8_000,
  summaryChars: 8_000,
} as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const BoundedPathSchema = z
  .string()
  .min(1)
  .max(FOLLOWUP_INPUT_LIMITS.pathChars);

export const FollowUpMainInputSchema = z
  .object({
    schemaVersion: z.literal(FOLLOWUP_MAIN_SCHEMA_VERSION),
    phase: z.enum(["audit", "post", "apply-patches"]),
    prNumber: z
      .number()
      .int()
      .min(FOLLOWUP_INPUT_LIMITS.prNumber.min)
      .max(FOLLOWUP_INPUT_LIMITS.prNumber.max),
    controllerRef: z.literal(FOLLOWUP_CONTROLLER_REF),
    controllerRoot: BoundedPathSchema,
    dataRoot: BoundedPathSchema,
    outputPath: BoundedPathSchema.optional(),
    inputPath: BoundedPathSchema.optional(),
    approvedBy: z.string().min(1).max(256).optional(),
  })
  .strict();
export type FollowUpMainInput = z.infer<typeof FollowUpMainInputSchema>;

export const PullRequestMetadataSchema = z
  .object({
    number: z.number().int().min(1).max(FOLLOWUP_INPUT_LIMITS.prNumber.max),
    base: z
      .object({
        ref: z.literal("main"),
        sha: FullShaSchema,
        repo: z.object({ full_name: z.literal(FOLLOWUP_REPOSITORY) }).strict(),
      })
      .strict(),
    head: z
      .object({
        sha: FullShaSchema,
        repo: z.object({ full_name: z.string().min(1).max(256) }).strict(),
      })
      .strict(),
  })
  .strict();
export type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;

export const FollowUpAiStatusSchema = z.enum([
  "submitted",
  "not-required",
  "unavailable",
  "skipped",
  "cancelled",
  "missing",
]);
export type FollowUpAiStatus = z.infer<typeof FollowUpAiStatusSchema>;

export const FollowUpAuditResultSchema = z
  .object({
    schemaVersion: z.literal(FOLLOWUP_MAIN_SCHEMA_VERSION),
    kind: z.literal("follow-up"),
    prNumber: z.number().int().min(1).max(FOLLOWUP_INPUT_LIMITS.prNumber.max),
    controllerRef: z.literal(FOLLOWUP_CONTROLLER_REF),
    controllerSha: FullShaSchema,
    baseSha: FullShaSchema,
    auditedSha: FullShaSchema,
    headRepo: z.string().min(1).max(256),
    headSha: FullShaSchema,
    archiveDigest: DigestSchema,
    publicImpact: z.enum(["public-impact", "no-impact"]),
    deterministic: DeterministicAuditArtifactSchema,
    ai: z
      .object({
        status: FollowUpAiStatusSchema,
        auditedSha: FullShaSchema,
        digest: DigestSchema.optional(),
        findings: z
          .array(DocsAuditFindingSchema)
          .max(DOCS_AUDIT_LIMITS.findings),
        patches: z
          .array(
            z
              .object({
                path: z.string().min(1).max(DOCS_AUDIT_LIMITS.pathChars),
                unifiedDiff: z.string().min(1).max(DOCS_AUDIT_LIMITS.diffBytes),
              })
              .strict(),
          )
          .max(DOCS_AUDIT_LIMITS.patches),
      })
      .strict(),
    followUp: z
      .object({
        auditedSha: FullShaSchema,
        status: z.enum(["passed", "failed"]),
      })
      .strict(),
    resultDigest: DigestSchema,
  })
  .strict();
export type FollowUpAuditResult = z.infer<typeof FollowUpAuditResultSchema>;

export type FollowUpArchiveError =
  | { readonly type: "FollowUpArchiveTooLarge"; readonly bytes: number }
  | { readonly type: "FollowUpArchiveInvalidGzip" }
  | {
      readonly type: "FollowUpArchiveBomb";
      readonly compressedBytes: number;
      readonly uncompressedBytes: number;
    }
  | { readonly type: "FollowUpArchiveInvalidHeader"; readonly offset: number }
  | { readonly type: "FollowUpArchiveUnsafePath"; readonly path: string }
  | { readonly type: "FollowUpArchiveDuplicatePath"; readonly path: string }
  | {
      readonly type: "FollowUpArchiveUnsupportedEntry";
      readonly path: string;
      readonly entryType: string;
    }
  | { readonly type: "FollowUpArchiveInvalidSize"; readonly path: string }
  | { readonly type: "FollowUpArchiveTooManyEntries"; readonly count: number }
  | {
      readonly type: "FollowUpArchiveFileTooLarge";
      readonly path: string;
      readonly bytes: number;
    }
  | {
      readonly type: "FollowUpArchiveTotalTooLarge";
      readonly bytes: number;
    };

export type FollowUpMainError =
  | {
      readonly type: "InvalidFollowUpInput";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "FollowUpControllerNotMain";
      readonly ref: string;
    }
  | {
      readonly type: "FollowUpControllerRootInvalid";
      readonly controllerRoot: string;
      readonly dataRoot: string;
    }
  | {
      readonly type: "FollowUpControllerShaInvalid";
      readonly sha: string;
    }
  | {
      readonly type: "FollowUpControllerReadFailed";
      readonly message: string;
    }
  | {
      readonly type: "FollowUpApiFailed";
      readonly operation: string;
      readonly message: string;
    }
  | {
      readonly type: "FollowUpPullRequestInvalid";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "FollowUpPullRequestMismatch";
      readonly reason: string;
    }
  | {
      readonly type: "FollowUpArchiveFailed";
      readonly error: FollowUpArchiveError;
    }
  | {
      readonly type: "FollowUpQuarantineFailed";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "FollowUpDeterministicFailed";
      readonly error: DeterministicDocsCheckError;
    }
  | {
      readonly type: "FollowUpAgentFailed";
      readonly error: DocsAuditAgentError;
    }
  | {
      readonly type: "FollowUpArtifactInvalid";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "FollowUpArtifactWriteFailed";
      readonly path: string;
      readonly message: string;
    }
  | { readonly type: "FollowUpResultNotFound"; readonly path: string }
  | {
      readonly type: "FollowUpPatchFailed";
      readonly message: string;
    };

export interface FollowUpApi {
  readonly getPullRequest: (
    prNumber: number,
  ) => ResultAsync<PullRequestMetadata, FollowUpMainError>;
  readonly listPullRequestFiles: (
    prNumber: number,
  ) => ResultAsync<readonly string[], FollowUpMainError>;
  /** The URL is derived from the fixed repository and API-provided head SHA. */
  readonly downloadHeadArchive: (
    headSha: string,
  ) => ResultAsync<Uint8Array, FollowUpMainError>;
  readonly createCheckRun: (
    input: FollowUpCheckInput,
  ) => ResultAsync<void, FollowUpMainError>;
  readonly createComment?: (
    prNumber: number,
    body: string,
  ) => ResultAsync<void, FollowUpMainError>;
}

export interface FollowUpCheckInput {
  readonly name:
    | typeof DOCS_AUDIT_FOLLOWUP_CHECK_NAME
    | typeof DOCS_AUDIT_CHECK_NAME;
  readonly headSha: string;
  readonly conclusion: "success" | "failure" | "neutral";
  readonly resultDigest: string;
  readonly summary: string;
}

export interface FollowUpWriter {
  readonly writeFile: (
    root: string,
    path: string,
    contents: Uint8Array,
  ) => ResultAsync<void, { readonly type: "write"; readonly message: string }>;
}

export interface FollowUpMainDependencies {
  readonly api: FollowUpApi;
  readonly readControllerSha?: (
    controllerRoot: string,
  ) => ResultAsync<string, FollowUpMainError>;
  readonly writer?: FollowUpWriter;
  readonly deterministic?: (
    contentRoot: string,
  ) => ResultAsyncType<
    DeterministicDocsCheckResult,
    DeterministicDocsCheckError
  >;
  readonly agent?: (
    input: DocsAuditAgentInput,
  ) => ResultAsyncType<DocsAuditAgentResult, DocsAuditAgentError>;
  readonly driver?: DocsAuditAgentInput["driver"];
}

export interface FollowUpControllerContext {
  readonly controllerRef: typeof FOLLOWUP_CONTROLLER_REF;
  readonly controllerRoot: string;
  readonly dataRoot: string;
}

export interface FollowUpArchiveEntry {
  readonly path: string;
  readonly contents: Uint8Array;
}

/**
 * Validates the controller boundary before any API or archive operation. The
 * two roots must be disjoint so a fork path cannot shadow controller files.
 */
export function validateFollowUpControllerContext(input: {
  readonly controllerRef: string;
  readonly controllerRoot: string;
  readonly dataRoot: string;
}): Result<FollowUpControllerContext, FollowUpMainError> {
  if (input.controllerRef !== FOLLOWUP_CONTROLLER_REF)
    return err({
      type: "FollowUpControllerNotMain",
      ref: input.controllerRef,
    });
  const controllerRoot = resolve(input.controllerRoot);
  const dataRoot = resolve(input.dataRoot);
  if (
    controllerRoot === dataRoot ||
    isInside(controllerRoot, dataRoot) ||
    isInside(dataRoot, controllerRoot)
  )
    return err({
      type: "FollowUpControllerRootInvalid",
      controllerRoot,
      dataRoot,
    });
  return ok({
    controllerRef: FOLLOWUP_CONTROLLER_REF,
    controllerRoot,
    dataRoot,
  });
}

/** Parses a GitHub workflow-dispatch value without accepting floats or junk. */
export function parseFollowUpPrNumber(
  value: unknown,
): Result<
  number,
  Extract<FollowUpMainError, { type: "InvalidFollowUpInput" }>
> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidInput([cloned.error]));
  if (
    typeof cloned.value !== "number" ||
    !Number.isSafeInteger(cloned.value) ||
    cloned.value < FOLLOWUP_INPUT_LIMITS.prNumber.min ||
    cloned.value > FOLLOWUP_INPUT_LIMITS.prNumber.max
  )
    return err(
      invalidInput([
        `prNumber must be an integer from ${FOLLOWUP_INPUT_LIMITS.prNumber.min} through ${FOLLOWUP_INPUT_LIMITS.prNumber.max}`,
      ]),
    );
  return ok(cloned.value);
}

/**
 * Validates an untrusted API response after a descriptor-safe bounded clone.
 * Accessors, symbols, cycles, exotic prototypes, and oversized graphs fail
 * before Zod can read them.
 */
export function parsePullRequestMetadata(
  value: unknown,
): Result<PullRequestMetadata, FollowUpMainError> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidPullRequest([cloned.error]));
  if (!isRecord(cloned.value))
    return err(invalidPullRequest(["response must be an object"]));
  const base = cloned.value.base;
  const head = cloned.value.head;
  if (!isRecord(base) || !isRecord(head))
    return err(invalidPullRequest(["base and head must be objects"]));
  const baseRepo = base.repo;
  const headRepo = head.repo;
  const projected = {
    number: cloned.value.number,
    base: {
      ref: base.ref,
      sha: base.sha,
      repo: {
        full_name: isRecord(baseRepo) ? baseRepo.full_name : undefined,
      },
    },
    head: {
      sha: head.sha,
      repo: {
        full_name: isRecord(headRepo) ? headRepo.full_name : undefined,
      },
    },
  };
  const parsed = PullRequestMetadataSchema.safeParse(projected);
  if (!parsed.success)
    return err(
      invalidPullRequest(
        parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      ),
    );
  return ok(parsed.data);
}

/**
 * Parses a GitHub source archive without ever writing archive-provided paths.
 * Symlinks, hard links, device entries, traversal, duplicate names, and
 * archive bombs are rejected.
 */
export function inspectForkArchive(
  archive: Uint8Array,
): Result<readonly FollowUpArchiveEntry[], FollowUpArchiveError> {
  if (archive.byteLength > FOLLOWUP_ARCHIVE_LIMITS.compressedBytes)
    return err({
      type: "FollowUpArchiveTooLarge",
      bytes: archive.byteLength,
    });
  if (archive.byteLength < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b)
    return err({ type: "FollowUpArchiveInvalidGzip" });
  const advertised = new DataView(
    archive.buffer,
    archive.byteOffset + archive.byteLength - 4,
    4,
  ).getUint32(0, true);
  if (advertised > FOLLOWUP_ARCHIVE_LIMITS.uncompressedBytes)
    return err({
      type: "FollowUpArchiveBomb",
      compressedBytes: archive.byteLength,
      uncompressedBytes: advertised,
    });
  const decompressed = Result.fromThrowable(
    () => Bun.gunzipSync(new Uint8Array(archive)),
    () => ({ type: "FollowUpArchiveInvalidGzip" as const }),
  )();
  if (decompressed.isErr()) return err(decompressed.error);
  if (
    decompressed.value.byteLength > FOLLOWUP_ARCHIVE_LIMITS.uncompressedBytes ||
    decompressed.value.byteLength >
      archive.byteLength * FOLLOWUP_ARCHIVE_LIMITS.compressionRatio
  )
    return err({
      type: "FollowUpArchiveBomb",
      compressedBytes: archive.byteLength,
      uncompressedBytes: decompressed.value.byteLength,
    });
  return parseTar(decompressed.value);
}

/** Materialises only validated regular files into the caller's quarantine. */
export function materializeForkArchive(
  archive: Uint8Array,
  dataRoot: string,
  writer: FollowUpWriter = defaultWriter(),
): ResultAsync<readonly string[], FollowUpMainError> {
  const inspected = inspectForkArchive(archive);
  if (inspected.isErr())
    return errAsync({ type: "FollowUpArchiveFailed", error: inspected.error });
  const entries = stripArchiveRoot(inspected.value);
  let chain: ResultAsync<readonly string[], FollowUpMainError> = okAsync([]);
  for (const entry of entries) {
    chain = chain.andThen((paths) =>
      writer
        .writeFile(dataRoot, entry.path, entry.contents)
        .mapErr((error) => ({
          type: "FollowUpQuarantineFailed" as const,
          path: entry.path,
          message: error.message,
        }))
        .map(() => [...paths, entry.path]),
    );
  }
  return chain;
}

/** Classifies exactly the paths covered by the PR workflow filter. */
export function classifyPublicImpact(
  paths: readonly string[],
): "public-impact" | "no-impact" {
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (
      normalized === "README.md" ||
      normalized.startsWith("docs/") ||
      normalized.startsWith("packages/cli/") ||
      normalized.startsWith("packages/adapters/") ||
      normalized.startsWith("packages/docs/") ||
      normalized.startsWith(".changeset/")
    )
      return "public-impact";
  }
  return "no-impact";
}

/** Runs the complete follow-up from a trusted main checkout. */
export function runFollowUpMain(
  input: FollowUpMainInput,
  dependencies: FollowUpMainDependencies,
): ResultAsync<FollowUpAuditResult, FollowUpMainError> {
  const validated = parseFollowUpInput(input);
  if (validated.isErr()) return errAsync(validated.error);
  if (validated.value.phase !== "audit")
    return errAsync({
      type: "InvalidFollowUpInput",
      issues: ["runFollowUpMain only executes the audit phase"],
    });
  const context = validateFollowUpControllerContext(validated.value);
  if (context.isErr()) return errAsync(context.error);
  const readSha = dependencies.readControllerSha ?? defaultReadControllerSha;
  return readSha(context.value.controllerRoot).andThen((controllerSha) => {
    const parsedSha = FullShaSchema.safeParse(controllerSha);
    if (!parsedSha.success)
      return errAsync<FollowUpAuditResult, FollowUpMainError>({
        type: "FollowUpControllerShaInvalid",
        sha: controllerSha,
      });
    return dependencies.api
      .getPullRequest(validated.value.prNumber)
      .andThen((pull) => validatePullAgainstController(pull, controllerSha))
      .andThen((pull) =>
        dependencies.api
          .listPullRequestFiles(validated.value.prNumber)
          .andThen((paths) =>
            validateFilePaths(paths).map(() => ({ pull, paths })),
          ),
      )
      .andThen(({ pull, paths }) =>
        dependencies.api
          .downloadHeadArchive(pull.head.sha)
          .andThen((archive) =>
            materializeForkArchive(
              archive,
              context.value.dataRoot,
              dependencies.writer,
            ).map(() => ({ pull, paths, archive })),
          ),
      )
      .andThen(({ pull, paths, archive }) =>
        runFollowUpChecks(
          validated.value,
          context.value,
          controllerSha,
          pull,
          paths,
          archive,
          dependencies,
        ),
      )
      .andThen((result) =>
        writeFollowUpResult(result, validated.value.outputPath),
      );
  });
}

/** Posts only a validated, digest-bound result using the App-token API port. */
export function postFollowUpResult(
  result: unknown,
  api: Pick<FollowUpApi, "createCheckRun" | "createComment">,
): ResultAsync<void, FollowUpMainError> {
  const parsed = parseFollowUpResult(result);
  if (parsed.isErr()) return errAsync(parsed.error);
  const gateConclusion = followUpConclusion(parsed.value);
  const summary = followUpSummary(parsed.value, gateConclusion);
  const check = api.createCheckRun({
    name: DOCS_AUDIT_FOLLOWUP_CHECK_NAME,
    headSha: parsed.value.headSha,
    conclusion: gateConclusion,
    resultDigest: parsed.value.resultDigest,
    summary,
  });
  return check.andThen(() => {
    if (api.createComment === undefined) return okAsync(undefined);
    return api
      .createComment(
        parsed.value.prNumber,
        `${summary}\n\nResult digest: ${parsed.value.resultDigest}`,
      )
      .map(() => undefined);
  });
}

/**
 * Patch application is intentionally a separate, approval-gated operation.
 * It can only target the trusted main controller root and consumes proposals
 * produced by a prior result; it never receives an AI or Git credential.
 */
export function applyFollowUpResultPatches(input: {
  readonly result: unknown;
  readonly controllerRef: string;
  readonly controllerRoot: string;
  readonly dataRoot: string;
  readonly controllerSha: string;
  readonly approvedBy?: string;
}): ResultAsync<readonly AppliedDocsAuditPatch[], FollowUpMainError> {
  const context = validateFollowUpControllerContext({
    controllerRef: input.controllerRef,
    controllerRoot: input.controllerRoot,
    dataRoot: input.dataRoot,
  });
  if (context.isErr()) return errAsync(context.error);
  const parsed = parseFollowUpResult(input.result);
  if (parsed.isErr()) return errAsync(parsed.error);
  if (parsed.value.controllerSha !== input.controllerSha)
    return errAsync({
      type: "FollowUpPatchFailed",
      message: "proposal controller SHA does not match protected main",
    });
  for (const patch of parsed.value.ai.patches)
    if (!isAllowedDocsPatchPath(patch.path))
      return errAsync({
        type: "FollowUpPatchFailed",
        message: `proposal path is not an allowed docs path: ${patch.path}`,
      });
  const approval =
    input.approvedBy === undefined
      ? ({ approved: false } as const)
      : ({ approved: true, approvedBy: input.approvedBy } as const);
  const originals = new Map<string, string | undefined>();
  let reads: ResultAsync<void, FollowUpMainError> = okAsync(undefined);
  for (const patch of parsed.value.ai.patches) {
    reads = reads.andThen(() =>
      ResultAsync.fromPromise(
        Bun.file(join(context.value.controllerRoot, patch.path)).exists(),
        () => ({
          type: "FollowUpPatchFailed" as const,
          message: "could not read protected main",
        }),
      ).andThen((exists) => {
        if (!exists) {
          originals.set(patch.path, undefined);
          return okAsync(undefined);
        }
        return ResultAsync.fromPromise(
          Bun.file(join(context.value.controllerRoot, patch.path)).text(),
          () => ({
            type: "FollowUpPatchFailed" as const,
            message: "could not read protected main",
          }),
        ).map((text) => {
          originals.set(patch.path, text);
          return undefined;
        });
      }),
    );
  }
  return reads.andThen(() =>
    applyFollowUpPatches({
      controllerRef: context.value.controllerRef,
      controllerRoot: context.value.controllerRoot,
      dataRoot: context.value.dataRoot,
      patches: parsed.value.ai.patches,
      originals,
      approval,
    }),
  );
}

export function applyFollowUpPatches(input: {
  readonly controllerRef: string;
  readonly controllerRoot: string;
  readonly dataRoot: string;
  readonly patches: readonly DocsAuditPatch[];
  readonly originals: ReadonlyMap<string, string | undefined>;
  readonly approval: DocsAuditPatchApproval | { readonly approved: false };
}): ResultAsync<readonly AppliedDocsAuditPatch[], FollowUpMainError> {
  const context = validateFollowUpControllerContext(input);
  if (context.isErr()) return errAsync(context.error);
  const applied = applyDocsAuditPatches({
    contentRoot: context.value.controllerRoot,
    patches: input.patches,
    originals: input.originals,
    approval: input.approval,
  });
  if (applied.isErr())
    return errAsync({
      type: "FollowUpPatchFailed",
      message: applied.error.type,
    });
  return writeAppliedDocsAuditPatches({
    contentRoot: context.value.controllerRoot,
    applied: applied.value,
  })
    .map(() => applied.value)
    .mapErr((error) => ({
      type: "FollowUpPatchFailed" as const,
      message: error.type,
    }));
}

export function parseFollowUpInput(
  value: unknown,
): Result<FollowUpMainInput, FollowUpMainError> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidInput([cloned.error]));
  const parsed = FollowUpMainInputSchema.safeParse(cloned.value);
  if (!parsed.success)
    return err(
      invalidInput(
        parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      ),
    );
  return ok(parsed.data);
}

export function parseFollowUpResult(
  value: unknown,
): Result<FollowUpAuditResult, FollowUpMainError> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidInput([cloned.error]));
  const parsed = FollowUpAuditResultSchema.safeParse(cloned.value);
  if (!parsed.success)
    return err({
      type: "FollowUpArtifactInvalid",
      issues: parsed.error.issues.map((issue) =>
        issue.path.map(String).join("."),
      ),
    });
  const bindingIssues = followUpResultBindingIssues(parsed.data);
  if (bindingIssues.length > 0)
    return err({
      type: "FollowUpArtifactInvalid",
      issues: bindingIssues,
    });
  if (followUpResultDigest(parsed.data) !== parsed.data.resultDigest)
    return err({
      type: "FollowUpArtifactInvalid",
      issues: ["resultDigest"],
    });
  return ok(parsed.data);
}

function followUpResultBindingIssues(
  result: FollowUpAuditResult,
): readonly string[] {
  const issues: string[] = [];
  if (result.baseSha !== result.controllerSha) issues.push("baseSha");
  if (result.auditedSha !== result.headSha) issues.push("auditedSha");
  if (result.deterministic.auditedSha !== result.auditedSha)
    issues.push("deterministic.auditedSha");
  if (result.ai.auditedSha !== result.auditedSha) issues.push("ai.auditedSha");
  if (result.followUp.auditedSha !== result.auditedSha)
    issues.push("followUp.auditedSha");
  return issues;
}

/** Returns the digest over the complete result payload except its digest field. */
export function followUpResultDigest(result: FollowUpAuditResult): string {
  const payload: Record<string, unknown> = { ...result };
  delete payload.resultDigest;
  return docsAuditDigest(payload);
}

export function followUpConclusion(
  result: FollowUpAuditResult,
): "success" | "failure" | "neutral" {
  if (result.publicImpact === "no-impact") return "neutral";
  if (
    result.followUp.status !== "passed" ||
    !result.deterministic.passed ||
    result.ai.status !== "submitted" ||
    result.ai.digest === undefined
  )
    return "failure";
  if (result.ai.findings.some((finding) => isBlockFinding(finding)))
    return "failure";
  return "success";
}

export function followUpSummary(
  result: FollowUpAuditResult,
  conclusion: "success" | "failure" | "neutral" = followUpConclusion(result),
): string {
  const warningCount = result.ai.findings.filter(
    (finding) => isRecord(finding) && finding.severity === "warn",
  ).length;
  return boundText(
    [
      `docs-audit follow-up: ${conclusion}`,
      `PR #${result.prNumber} head ${result.headSha}`,
      `controller main ${result.controllerSha}`,
      `archive ${result.archiveDigest}`,
      `result ${result.resultDigest}`,
      result.publicImpact === "no-impact"
        ? "No public-impact paths require the AI audit."
        : `AI status ${result.ai.status}; deterministic ${result.deterministic.passed ? "pass" : "fail"}; warnings ${warningCount}.`,
      "Fork content was treated as quarantined data; no fork command, install, or checkout was performed.",
    ].join("\n"),
    FOLLOWUP_INPUT_LIMITS.summaryChars,
  );
}

export function createGitHubFollowUpApi(
  token: string,
  fetcher: typeof fetch = fetch,
): FollowUpApi {
  const headers = {
    accept: "application/vnd.github+json",
    ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
    "x-github-api-version": "2022-11-28",
  };
  const requestJson = (
    operation: string,
    path: string,
    init?: RequestInit,
  ): ResultAsync<unknown, FollowUpMainError> =>
    ResultAsync.fromThrowable(
      () =>
        fetcher(`https://api.github.com${path}`, {
          ...init,
          headers: { ...headers, ...(init?.headers ?? {}) },
        }),
      () => ({
        type: "FollowUpApiFailed" as const,
        operation,
        message: "request failed",
      }),
    )().andThen((response) =>
      ResultAsync.fromThrowable(
        () => response.arrayBuffer(),
        () => ({
          type: "FollowUpApiFailed" as const,
          operation,
          message: "response read failed",
        }),
      )().andThen((body) => {
        if (body.byteLength > FOLLOWUP_INPUT_LIMITS.responseBytes)
          return errAsync({
            type: "FollowUpApiFailed" as const,
            operation,
            message: "response too large",
          });
        const text = new TextDecoder().decode(body);
        if (!response.ok)
          return errAsync({
            type: "FollowUpApiFailed" as const,
            operation,
            message: `HTTP ${response.status}`,
          });
        const parsed = Result.fromThrowable(
          () => JSON.parse(text) as unknown,
          () => ({
            type: "FollowUpApiFailed" as const,
            operation,
            message: "invalid JSON response",
          }),
        )();
        return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
      }),
    );

  const requestBytes = (
    operation: string,
    path: string,
  ): ResultAsync<Uint8Array, FollowUpMainError> =>
    ResultAsync.fromThrowable(
      () => fetcher(`https://api.github.com${path}`, { headers }),
      () => ({
        type: "FollowUpApiFailed" as const,
        operation,
        message: "request failed",
      }),
    )().andThen((response) =>
      ResultAsync.fromThrowable(
        () => response.arrayBuffer(),
        () => ({
          type: "FollowUpApiFailed" as const,
          operation,
          message: "response read failed",
        }),
      )().andThen((body) => {
        if (!response.ok)
          return errAsync({
            type: "FollowUpApiFailed" as const,
            operation,
            message: `HTTP ${response.status}`,
          });
        if (body.byteLength > FOLLOWUP_ARCHIVE_LIMITS.compressedBytes)
          return errAsync({
            type: "FollowUpApiFailed" as const,
            operation,
            message: "archive response too large",
          });
        return okAsync(new Uint8Array(body));
      }),
    );

  return {
    getPullRequest: (prNumber) =>
      requestJson(
        "get-pull-request",
        `/repos/${FOLLOWUP_REPOSITORY}/pulls/${prNumber}`,
      ).andThen(parsePullRequestMetadata),
    listPullRequestFiles: (prNumber) => {
      const pageSize = 100;
      const maxPages = Math.floor(FOLLOWUP_INPUT_LIMITS.files / pageSize) + 1;
      const readPage = (
        page: number,
        collected: readonly string[],
      ): ResultAsync<readonly string[], FollowUpMainError> =>
        requestJson(
          "list-pull-request-files",
          `/repos/${FOLLOWUP_REPOSITORY}/pulls/${prNumber}/files?per_page=${pageSize}&page=${page}`,
        )
          .andThen((value) => parseFileList(value))
          .andThen((paths) => {
            const next = [...collected, ...paths];
            if (next.length > FOLLOWUP_INPUT_LIMITS.files)
              return errAsync({
                type: "FollowUpApiFailed" as const,
                operation: "list-pull-request-files",
                message: "too many changed files",
              });
            if (paths.length < pageSize || page >= maxPages)
              return okAsync(next);
            return readPage(page + 1, next);
          });
      return readPage(1, []);
    },
    downloadHeadArchive: (headSha) => {
      const parsed = FullShaSchema.safeParse(headSha);
      if (!parsed.success)
        return errAsync({
          type: "FollowUpApiFailed",
          operation: "download-head-archive",
          message: "invalid head SHA",
        });
      return requestBytes(
        "download-head-archive",
        `/repos/${FOLLOWUP_REPOSITORY}/tarball/${parsed.data}`,
      );
    },
    createCheckRun: (input) =>
      requestJson(
        "create-check-run",
        `/repos/${FOLLOWUP_REPOSITORY}/check-runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            head_sha: input.headSha,
            status: "completed",
            conclusion: input.conclusion,
            output: {
              title: input.name,
              summary: `${input.summary}\n\nResult digest: ${input.resultDigest}`,
            },
          }),
        },
      ).map(() => undefined),
    createComment: (prNumber, body) =>
      requestJson(
        "create-comment",
        `/repos/${FOLLOWUP_REPOSITORY}/issues/${prNumber}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: boundText(body, FOLLOWUP_INPUT_LIMITS.commentChars),
          }),
        },
      ).map(() => undefined),
  };
}

function runFollowUpChecks(
  input: FollowUpMainInput,
  context: FollowUpControllerContext,
  controllerSha: string,
  pull: PullRequestMetadata,
  paths: readonly string[],
  archive: Uint8Array,
  dependencies: FollowUpMainDependencies,
): ResultAsync<FollowUpAuditResult, FollowUpMainError> {
  const publicImpact = classifyPublicImpact(paths);
  const deterministicProvider =
    dependencies.deterministic ?? runDeterministicDocsCheck;
  const deterministicRun = invokeResultAsync(
    () => deterministicProvider(context.dataRoot),
    (error): FollowUpMainError => ({
      type: "FollowUpDeterministicFailed",
      error,
    }),
  );
  const deterministic: ResultAsync<DeterministicDocsCheckResult, never> =
    deterministicRun.orElse((error) =>
      okAsync<DeterministicDocsCheckResult, never>({
        schemaVersion: 1,
        passed: false,
        issues: [
          {
            kind: "missing-readme",
            path: "quarantine",
            detail: error.type,
          },
        ],
        digest: docsAuditDigest({ type: "deterministic-error", error }),
      }),
    );
  return deterministic.andThen((deterministicResult) => {
    if (publicImpact === "no-impact")
      return buildFollowUpResult(
        input.prNumber,
        context,
        controllerSha,
        pull,
        archive,
        publicImpact,
        deterministicResult,
        {
          status: "not-required",
          auditedSha: pull.head.sha,
          findings: [],
          patches: [],
        },
      );
    const agentProvider = dependencies.agent ?? runDocsAuditAgent;
    if (dependencies.driver === undefined)
      return buildFollowUpResult(
        input.prNumber,
        context,
        controllerSha,
        pull,
        archive,
        publicImpact,
        deterministicResult,
        {
          status: "unavailable",
          auditedSha: pull.head.sha,
          findings: [],
          patches: [],
        },
      );
    const agentRun = invokeResultAsync(
      () =>
        agentProvider({
          contentRoot: context.dataRoot,
          auditedSha: pull.head.sha,
          driver: dependencies.driver as DocsAuditAgentInput["driver"],
        }),
      (error): FollowUpMainError => ({ type: "FollowUpAgentFailed", error }),
    );
    return agentRun
      .map((agentResult) => ({ status: "submitted" as const, agentResult }))
      .orElse((error) => {
        log.warn({ error: error.type }, "follow-up AI audit unavailable");
        return okAsync({
          status: "unavailable" as const,
          agentResult: undefined,
        });
      })
      .andThen(({ status, agentResult }) =>
        buildFollowUpResult(
          input.prNumber,
          context,
          controllerSha,
          pull,
          archive,
          publicImpact,
          deterministicResult,
          {
            status,
            auditedSha: pull.head.sha,
            ...(agentResult === undefined
              ? {}
              : { digest: agentResult.digest }),
            findings: agentResult?.findings ?? [],
            patches: agentResult?.patches ?? [],
          },
        ),
      );
  });
}

function buildFollowUpResult(
  prNumber: number,
  context: FollowUpControllerContext,
  controllerSha: string,
  pull: PullRequestMetadata,
  archive: Uint8Array,
  publicImpact: "public-impact" | "no-impact",
  deterministic: DeterministicDocsCheckResult,
  ai: {
    readonly status: FollowUpAiStatus;
    readonly auditedSha: string;
    readonly digest?: string;
    readonly findings: readonly unknown[];
    readonly patches: readonly DocsAuditPatch[];
  },
): ResultAsync<FollowUpAuditResult, FollowUpMainError> {
  const deterministicArtifact = deterministicAuditArtifact(
    pull.head.sha,
    deterministic,
  );
  const aiCandidate = {
    status: ai.status,
    auditedSha: ai.auditedSha,
    ...(ai.digest === undefined ? {} : { digest: ai.digest }),
    findings: ai.findings.slice(0, DOCS_AUDIT_LIMITS.findings),
    patches: ai.patches.slice(0, DOCS_AUDIT_LIMITS.patches),
  };
  const payload = {
    schemaVersion: FOLLOWUP_MAIN_SCHEMA_VERSION,
    kind: "follow-up" as const,
    prNumber,
    controllerRef: context.controllerRef,
    controllerSha,
    baseSha: pull.base.sha,
    auditedSha: pull.head.sha,
    headRepo: pull.head.repo.full_name,
    headSha: pull.head.sha,
    archiveDigest: bytesDigest(archive),
    publicImpact,
    deterministic: deterministicArtifact,
    ai: aiCandidate,
    followUp: { auditedSha: pull.head.sha, status: "passed" as const },
  };
  const resultDigest = docsAuditDigest(payload);
  const parsed = FollowUpAuditResultSchema.safeParse({
    ...payload,
    resultDigest,
  });
  if (!parsed.success)
    return errAsync({
      type: "FollowUpArtifactInvalid",
      issues: parsed.error.issues.map((issue) =>
        issue.path.map(String).join("."),
      ),
    });
  return okAsync(parsed.data);
}

function writeFollowUpResult(
  result: FollowUpAuditResult,
  outputPath: string | undefined,
): ResultAsync<FollowUpAuditResult, FollowUpMainError> {
  if (outputPath === undefined) return okAsync(result);
  return ResultAsync.fromPromise(
    Bun.write(outputPath, `${canonicalJson(result)}\n`).then(() => result),
    () => ({
      type: "FollowUpArtifactWriteFailed" as const,
      path: outputPath,
      message: "artifact write failed",
    }),
  );
}

function validatePullAgainstController(
  pull: PullRequestMetadata,
  controllerSha: string,
): Result<PullRequestMetadata, FollowUpMainError> {
  if (
    pull.base.repo.full_name !== FOLLOWUP_REPOSITORY ||
    pull.base.ref !== "main"
  )
    return err({
      type: "FollowUpPullRequestMismatch",
      reason: "pull request base is not weave-io/weave main",
    });
  if (pull.base.sha !== controllerSha)
    return err({
      type: "FollowUpPullRequestMismatch",
      reason: "pull request base SHA is not the checked-out controller main",
    });
  return ok(pull);
}

function validateFilePaths(
  paths: readonly string[],
): Result<readonly string[], FollowUpMainError> {
  if (paths.length > FOLLOWUP_INPUT_LIMITS.files)
    return err({
      type: "FollowUpApiFailed",
      operation: "list-pull-request-files",
      message: "too many changed files",
    });
  for (const path of paths)
    if (
      path.length === 0 ||
      path.length > FOLLOWUP_INPUT_LIMITS.filePathChars ||
      path.includes("\0")
    )
      return err({
        type: "FollowUpApiFailed",
        operation: "list-pull-request-files",
        message: "unsafe changed-file path",
      });
  return ok(paths);
}

function parseFileList(
  value: unknown,
): Result<readonly string[], FollowUpMainError> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidInput([cloned.error]));
  if (!Array.isArray(cloned.value))
    return err({
      type: "FollowUpApiFailed",
      operation: "list-pull-request-files",
      message: "invalid files response",
    });
  const paths: string[] = [];
  for (const item of cloned.value) {
    if (!isRecord(item) || typeof item.filename !== "string")
      return err({
        type: "FollowUpApiFailed",
        operation: "list-pull-request-files",
        message: "invalid file entry",
      });
    paths.push(item.filename);
  }
  return validateFilePaths(paths);
}

function parseTar(
  contents: Uint8Array,
): Result<readonly FollowUpArchiveEntry[], FollowUpArchiveError> {
  const entries: FollowUpArchiveEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let total = 0;
  while (offset + 512 <= contents.byteLength) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return ok(entries);
    const path = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const archivePath = prefix.length === 0 ? path : `${prefix}/${path}`;
    const size = tarOctal(header, 124, 12);
    if (size === undefined)
      return err({ type: "FollowUpArchiveInvalidHeader", offset });
    const entryType = String.fromCharCode(header[156] ?? 0);
    if (entryType !== "\0" && entryType !== "0" && entryType !== "5")
      return err({
        type: "FollowUpArchiveUnsupportedEntry",
        path: archivePath,
        entryType,
      });
    const normalizedPath =
      entryType === "5" ? archivePath.replace(/\/+$/, "") : archivePath;
    if (!isSafeArchivePath(normalizedPath))
      return err({ type: "FollowUpArchiveUnsafePath", path: archivePath });
    if (names.has(normalizedPath))
      return err({
        type: "FollowUpArchiveDuplicatePath",
        path: normalizedPath,
      });
    const dataStart = offset + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (next > contents.byteLength)
      return err({ type: "FollowUpArchiveInvalidSize", path: archivePath });
    names.add(normalizedPath);
    if (entries.length + 1 > FOLLOWUP_ARCHIVE_LIMITS.entries)
      return err({
        type: "FollowUpArchiveTooManyEntries",
        count: entries.length + 1,
      });
    if (entryType === "0" || entryType === "\0") {
      if (size > FOLLOWUP_ARCHIVE_LIMITS.fileBytes)
        return err({
          type: "FollowUpArchiveFileTooLarge",
          path: archivePath,
          bytes: size,
        });
      total += size;
      if (total > FOLLOWUP_ARCHIVE_LIMITS.totalFileBytes)
        return err({ type: "FollowUpArchiveTotalTooLarge", bytes: total });
      entries.push({
        path: normalizedPath,
        contents: contents.slice(dataStart, dataStart + size),
      });
    }
    offset = next;
  }
  return err({ type: "FollowUpArchiveInvalidHeader", offset });
}

function stripArchiveRoot(
  entries: readonly FollowUpArchiveEntry[],
): readonly FollowUpArchiveEntry[] {
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined || first.length === 0) return entries;
  if (
    !entries.every(
      (entry) => entry.path === first || entry.path.startsWith(`${first}/`),
    )
  )
    return entries;
  return entries.flatMap((entry) => {
    const path = entry.path.slice(first.length + 1);
    return path.length === 0 ? [] : [{ ...entry, path }];
  });
}

function isSafeArchivePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > FOLLOWUP_ARCHIVE_LIMITS.pathChars ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return false;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function tarString(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder()
    .decode(bytes.subarray(start, start + length))
    .replace(/\0.*$/s, "");
}

function tarOctal(
  bytes: Uint8Array,
  start: number,
  length: number,
): number | undefined {
  const value = tarString(bytes, start, length).trim();
  if (!/^[0-7]*$/.test(value)) return undefined;
  const parsed = Number.parseInt(value || "0", 8);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function defaultWriter(): FollowUpWriter {
  return {
    writeFile: (root, path, contents) => {
      const destination = resolve(root, path);
      if (!isInside(resolve(root), destination) || !isSafeRelativePath(path))
        return errAsync({
          type: "write" as const,
          message: "path escapes quarantine",
        });
      const parent = dirname(destination);
      const made = Result.fromThrowable(
        () => Bun.spawnSync(["mkdir", "-p", "--", parent]),
        () => ({
          type: "write" as const,
          message: "quarantine directory failed",
        }),
      )();
      if (made.isErr()) return errAsync(made.error);
      if (made.value.exitCode !== 0)
        return errAsync({
          type: "write" as const,
          message: "quarantine directory failed",
        });
      return ResultAsync.fromPromise(
        Bun.write(destination, contents).then(() => undefined),
        () => ({ type: "write" as const, message: "quarantine write failed" }),
      );
    },
  };
}

function defaultReadControllerSha(
  controllerRoot: string,
): ResultAsync<string, FollowUpMainError> {
  const result = Result.fromThrowable(
    () =>
      Bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: controllerRoot,
        stdout: "pipe",
        stderr: "pipe",
      }),
    () => ({
      type: "FollowUpControllerReadFailed" as const,
      message: "git read failed",
    }),
  )();
  if (result.isErr()) return errAsync(result.error);
  if (result.value.exitCode !== 0)
    return errAsync({
      type: "FollowUpControllerReadFailed",
      message: "controller is not a readable git checkout",
    });
  const sha = new TextDecoder().decode(result.value.stdout).trim();
  return okAsync(sha);
}

function invokeResultAsync<T, E>(
  provider: () => ResultAsync<T, E>,
  onThrow: (error: E) => FollowUpMainError,
): ResultAsync<T, FollowUpMainError> {
  const invoked = Result.fromThrowable(provider, (cause) =>
    onThrow(cause as E),
  )();
  return invoked.isErr()
    ? errAsync(invoked.error)
    : invoked.value.mapErr(onThrow);
}

function cloneBounded(value: unknown): Result<unknown, string> {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const walk = (candidate: unknown, depth: number): Result<unknown, string> => {
    if (depth > 32) return err("input graph is too deep");
    if (candidate === null || candidate === undefined) return ok(candidate);
    if (typeof candidate === "string") {
      if (candidate.length > 16_384) return err("input string is too long");
      bytes += candidate.length;
      return bytes > 256 * 1024
        ? err("input graph is too large")
        : ok(candidate);
    }
    if (typeof candidate === "number" || typeof candidate === "boolean")
      return ok(candidate);
    if (typeof candidate !== "object")
      return err("input contains an unsupported value");
    if (seen.has(candidate)) return err("input graph contains a cycle");
    seen.add(candidate);
    nodes += 1;
    if (nodes > 4_096) return err("input graph has too many nodes");
    const prototype = Object.getPrototypeOf(candidate);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      prototype !== Array.prototype
    )
      return err("input contains an exotic prototype");
    if (Object.getOwnPropertySymbols(candidate).length > 0)
      return err("input contains symbols");
    if (Array.isArray(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== candidate.length ||
        keys.some((key, index) => key !== String(index))
      )
        return err("input array is sparse or has extra properties");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(
        candidate,
        "length",
      );
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.value !== candidate.length
      )
        return err("input array has an invalid length descriptor");
      const result: unknown[] = [];
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          return err("input array contains an accessor");
        const child = walk(descriptor.value, depth + 1);
        if (child.isErr()) return err(child.error);
        result.push(child.value);
      }
      seen.delete(candidate);
      return ok(result);
    }
    const output: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        key.length > FOLLOWUP_INPUT_LIMITS.pathChars ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        return err("input contains an accessor");
      const child = walk(descriptor.value, depth + 1);
      if (child.isErr()) return err(child.error);
      output[key] = child.value;
    }
    seen.delete(candidate);
    return ok(output);
  };
  const inspected = Result.fromThrowable(
    () => walk(value, 0),
    () => "input graph could not be inspected",
  )();
  if (inspected.isErr()) return err(inspected.error);
  return inspected.value;
}

function invalidInput(
  issues: readonly string[],
): Extract<FollowUpMainError, { type: "InvalidFollowUpInput" }> {
  return { type: "InvalidFollowUpInput", issues: issues.slice(0, 32) };
}

function invalidPullRequest(
  issues: readonly string[],
): Extract<FollowUpMainError, { type: "FollowUpPullRequestInvalid" }> {
  return { type: "FollowUpPullRequestInvalid", issues: issues.slice(0, 32) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isBlockFinding(value: unknown): boolean {
  return isRecord(value) && value.severity === "block";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !child.startsWith("/");
}

function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function bytesDigest(value: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

if (import.meta.main) {
  const values = new Map<string, string>();
  const args = Bun.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      log.error("invalid docs-audit follow-up arguments");
      process.exitCode = 2;
      break;
    }
    values.set(flag.slice(2), value);
  }
  if (process.exitCode === undefined) {
    const pr = parseFollowUpPrNumber(Number(values.get("pr-number")));
    const controllerRoot = values.get("controller-root");
    const dataRoot = values.get("data-root");
    const controllerRef =
      values.get("controller-ref") ?? FOLLOWUP_CONTROLLER_REF;
    const phase = values.get("phase") ?? "audit";
    if (pr.isErr() || controllerRoot === undefined || dataRoot === undefined) {
      log.error(
        { error: pr.isErr() ? pr.error : "missing root" },
        "invalid follow-up input",
      );
      process.exitCode = 2;
    } else {
      const input: FollowUpMainInput = {
        schemaVersion: FOLLOWUP_MAIN_SCHEMA_VERSION,
        phase: phase === "post" || phase === "apply-patches" ? phase : "audit",
        prNumber: pr.value,
        controllerRef: controllerRef as typeof FOLLOWUP_CONTROLLER_REF,
        controllerRoot,
        dataRoot,
        ...(values.get("output") === undefined
          ? {}
          : { outputPath: values.get("output") }),
        ...(values.get("input") === undefined
          ? {}
          : { inputPath: values.get("input") }),
      };
      const api = createGitHubFollowUpApi(
        Bun.env[
          phase === "post" ? FOLLOWUP_APP_TOKEN_ENV : FOLLOWUP_READ_TOKEN_ENV
        ] ??
          Bun.env.GH_TOKEN ??
          "",
      );
      let run: ResultAsync<FollowUpAuditResult, FollowUpMainError>;
      if (phase === "audit") {
        run = runFollowUpMain(input, { api });
      } else if (phase === "post") {
        const resultPath = input.inputPath ?? "";
        run = ResultAsync.fromPromise(Bun.file(resultPath).json(), () => ({
          type: "FollowUpResultNotFound" as const,
          path: resultPath,
        })).andThen((value) =>
          postFollowUpResult(value, api).map(
            () => value as FollowUpAuditResult,
          ),
        );
      } else {
        const resultPath = input.inputPath ?? "";
        const approvedBy = values.get("approved-by");
        run = ResultAsync.fromPromise(Bun.file(resultPath).json(), () => ({
          type: "FollowUpResultNotFound" as const,
          path: resultPath,
        })).andThen((value) =>
          parseFollowUpResult(value).asyncAndThen((parsed) =>
            defaultReadControllerSha(input.controllerRoot).andThen(
              (controllerSha) =>
                applyFollowUpResultPatches({
                  result: parsed,
                  controllerRef: input.controllerRef,
                  controllerRoot: input.controllerRoot,
                  dataRoot: input.dataRoot,
                  controllerSha,
                  approvedBy,
                }).map(() => parsed),
            ),
          ),
        );
      }
      const result = await run;
      if (result.isErr()) {
        log.error({ error: result.error }, "docs-audit follow-up failed");
        process.exitCode = 1;
      }
    }
  }
}
