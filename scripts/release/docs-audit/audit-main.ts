/**
 * Workflow adapter for the Task 19 docs-audit contracts.
 *
 * This module is deliberately thin. It runs the deterministic checker or the
 * already-isolated Task 19 agent and serializes a bounded, digestable result.
 * It does not decide whether a result is required; gate-main owns that rule.
 */
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
  type DeterministicDocsCheckError,
  type DeterministicDocsCheckResult,
  runDeterministicDocsCheck,
} from "./deterministic.js";
import { DOCS_AUDIT_LIMITS } from "./policy.js";

const log = logger.child({ module: "docs-audit-main" });

export const AUDIT_MAIN_SCHEMA_VERSION = 1 as const;
export const AUDIT_MAIN_PHASES = ["deterministic", "agent"] as const;
export type AuditMainPhase = (typeof AUDIT_MAIN_PHASES)[number];

const BOUNDED_TEXT = z.string().max(16_384);

/** The artifact emitted by the no-secret deterministic job. */
export const DeterministicAuditArtifactSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_MAIN_SCHEMA_VERSION),
    kind: z.literal("deterministic"),
    auditedSha: FullShaSchema,
    passed: z.boolean(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    issues: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            path: z.string().min(1).max(DOCS_AUDIT_LIMITS.issuePathChars),
            detail: z.string().max(DOCS_AUDIT_LIMITS.issuePathChars),
          })
          .strict(),
      )
      .max(DOCS_AUDIT_LIMITS.issues),
  })
  .strict();
export type DeterministicAuditArtifact = z.infer<
  typeof DeterministicAuditArtifactSchema
>;

/** The secret-bearing same-repository AI artifact. It contains no key. */
export const AgentAuditArtifactSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_MAIN_SCHEMA_VERSION),
    kind: z.literal("ai"),
    auditedSha: FullShaSchema,
    status: z.literal("submitted"),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    findings: z.array(DocsAuditFindingSchema).max(DOCS_AUDIT_LIMITS.findings),
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
    attempts: z.union([z.literal(1), z.literal(2)]),
    model: z.string().min(1).max(256),
    thinking: z.string().min(1).max(32),
  })
  .strict();
export type AgentAuditArtifact = z.infer<typeof AgentAuditArtifactSchema>;

export type AuditMainArtifact = DeterministicAuditArtifact | AgentAuditArtifact;

export type AuditMainError =
  | {
      readonly type: "InvalidAuditMainInput";
      readonly issues: readonly string[];
    }
  | { readonly type: "InvalidAuditMainPhase"; readonly phase: string }
  | { readonly type: "AuditContentRootMissing"; readonly path: string }
  | {
      readonly type: "AuditDeterministicFailed";
      readonly error: DeterministicDocsCheckError;
    }
  | { readonly type: "AuditAgentFailed"; readonly error: DocsAuditAgentError }
  | { readonly type: "AuditAgentDriverMissing" }
  | {
      readonly type: "AuditArtifactWriteFailed";
      readonly path: string;
      readonly message: string;
    };

export interface AuditMainInput {
  readonly phase: AuditMainPhase;
  readonly contentRoot: string;
  readonly auditedSha: string;
  readonly outputPath?: string;
  readonly thinking?: string;
  /** The workflow injects the already-isolated Task 19 driver at this seam. */
  readonly driver?: DocsAuditAgentInput["driver"];
}

export interface AuditMainDependencies {
  readonly deterministic?: (
    contentRoot: string,
  ) => ResultAsyncType<
    DeterministicDocsCheckResult,
    DeterministicDocsCheckError
  >;
  readonly agent?: (
    input: DocsAuditAgentInput,
  ) => ResultAsyncType<DocsAuditAgentResult, DocsAuditAgentError>;
  readonly write?: (
    path: string,
    content: string,
  ) => ResultAsyncType<
    void,
    { readonly type: "write"; readonly message: string }
  >;
}

/** Runs one Task 19 phase and optionally writes its bounded artifact. */
export function runAuditMain(
  input: AuditMainInput,
  dependencies: AuditMainDependencies = {},
): ResultAsync<AuditMainArtifact, AuditMainError> {
  const validated = validateAuditMainInput(input);
  if (validated.isErr()) return errAsync(validated.error);

  const run: ResultAsync<AuditMainArtifact, AuditMainError> =
    validated.value.phase === "deterministic"
      ? runDeterministicPhase(validated.value, dependencies)
      : runAgentPhase(validated.value, dependencies);
  return run.andThen((artifact: AuditMainArtifact) => {
    const outputPath = validated.value.outputPath;
    if (outputPath === undefined) return okAsync(artifact);
    const content = `${canonicalJson(artifact)}\n`;
    const write = dependencies.write ?? defaultWrite;
    const invoked = Result.fromThrowable(
      () => write(outputPath, content),
      (cause) => ({
        type: "AuditArtifactWriteFailed" as const,
        path: outputPath,
        message: String(cause),
      }),
    )();
    if (invoked.isErr()) return errAsync(invoked.error);
    return invoked.value
      .mapErr((error) => ({
        type: "AuditArtifactWriteFailed" as const,
        path: outputPath,
        message: error.message,
      }))
      .map(() => artifact);
  });
}

export function validateAuditMainInput(
  input: AuditMainInput,
): Result<AuditMainInput, AuditMainError> {
  const phase = AUDIT_MAIN_PHASES.find(
    (candidate) => candidate === input.phase,
  );
  if (phase === undefined)
    return err({ type: "InvalidAuditMainPhase", phase: String(input.phase) });
  const sha = FullShaSchema.safeParse(input.auditedSha);
  if (!sha.success)
    return err({
      type: "InvalidAuditMainInput",
      issues: ["auditedSha must be a forty-character hexadecimal SHA"],
    });
  if (input.contentRoot.length === 0 || input.contentRoot.length > 512)
    return err({
      type: "InvalidAuditMainInput",
      issues: ["contentRoot must be bounded and non-empty"],
    });
  if (input.outputPath !== undefined && input.outputPath.length > 512)
    return err({
      type: "InvalidAuditMainInput",
      issues: ["outputPath is too long"],
    });
  return ok({ ...input, phase, auditedSha: sha.data });
}

export function deterministicAuditArtifact(
  auditedSha: string,
  result: DeterministicDocsCheckResult,
): DeterministicAuditArtifact {
  return {
    schemaVersion: AUDIT_MAIN_SCHEMA_VERSION,
    kind: "deterministic",
    auditedSha,
    passed: result.passed,
    digest: result.digest,
    issues: result.issues.slice(0, DOCS_AUDIT_LIMITS.issues).map((issue) => ({
      kind: issue.kind,
      path: issue.path,
      detail: issue.detail,
    })),
  };
}

export function agentAuditArtifact(
  auditedSha: string,
  result: DocsAuditAgentResult,
): AgentAuditArtifact {
  return {
    schemaVersion: AUDIT_MAIN_SCHEMA_VERSION,
    kind: "ai",
    auditedSha,
    status: "submitted",
    digest: result.digest,
    findings: result.findings.slice(0, DOCS_AUDIT_LIMITS.findings),
    patches: result.patches.slice(0, DOCS_AUDIT_LIMITS.patches),
    attempts: result.attempts,
    model: result.model,
    thinking: result.thinking,
  };
}

function runDeterministicPhase(
  input: AuditMainInput,
  dependencies: AuditMainDependencies,
): ResultAsync<DeterministicAuditArtifact, AuditMainError> {
  const provider = dependencies.deterministic ?? runDeterministicDocsCheck;
  const invoked = Result.fromThrowable(
    () => provider(input.contentRoot),
    (cause) => ({
      type: "AuditDeterministicFailed" as const,
      error: {
        type: "DeterministicDocsIoFailed" as const,
        path: input.contentRoot,
        message: String(cause),
      },
    }),
  )();
  if (invoked.isErr()) return errAsync(invoked.error);
  return invoked.value
    .mapErr((error) => ({ type: "AuditDeterministicFailed" as const, error }))
    .map((result) => deterministicAuditArtifact(input.auditedSha, result));
}

function runAgentPhase(
  input: AuditMainInput,
  dependencies: AuditMainDependencies,
): ResultAsync<AgentAuditArtifact, AuditMainError> {
  if (input.driver === undefined)
    return errAsync({ type: "AuditAgentDriverMissing" });
  const provider = dependencies.agent ?? runDocsAuditAgent;
  const agentInput: DocsAuditAgentInput = {
    contentRoot: input.contentRoot,
    auditedSha: input.auditedSha,
    driver: input.driver,
    thinking: input.thinking,
  };
  const invoked = Result.fromThrowable(
    () => provider(agentInput),
    (cause) => ({
      type: "AuditAgentFailed" as const,
      error: {
        type: "HeadlessSessionFailed" as const,
        reason: String(cause),
      },
    }),
  )();
  if (invoked.isErr()) return errAsync(invoked.error);
  return invoked.value
    .mapErr((error) => ({ type: "AuditAgentFailed" as const, error }))
    .map((result) => agentAuditArtifact(input.auditedSha, result));
}

function defaultWrite(
  path: string,
  content: string,
): ResultAsync<void, { readonly type: "write"; readonly message: string }> {
  return ResultAsync.fromPromise(
    Bun.write(path, content).then(() => undefined),
    (cause) => ({ type: "write" as const, message: String(cause) }),
  );
}

export function parseAuditMainArgs(
  argv: readonly string[],
): Result<AuditMainInput, AuditMainError> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--"))
      return err({
        type: "InvalidAuditMainInput",
        issues: [
          "usage: audit-main --phase <deterministic|agent> --content-root <path> --audited-sha <sha> [--output <path>]",
        ],
      });
    values.set(flag.slice(2), value);
    index += 1;
  }
  const phase = values.get("phase");
  const contentRoot = values.get("content-root");
  const auditedSha = values.get("audited-sha");
  if (
    phase === undefined ||
    contentRoot === undefined ||
    auditedSha === undefined
  )
    return err({
      type: "InvalidAuditMainInput",
      issues: ["phase, content-root, and audited-sha are required"],
    });
  const thinking = values.get("thinking");
  if (thinking !== undefined) {
    const parsedThinking = BOUNDED_TEXT.safeParse(thinking);
    if (!parsedThinking.success)
      return err({
        type: "InvalidAuditMainInput",
        issues: ["thinking is too long"],
      });
  }
  return validateAuditMainInput({
    phase: phase as AuditMainPhase,
    contentRoot,
    auditedSha,
    outputPath: values.get("output"),
    thinking,
  });
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

if (import.meta.main) {
  const parsed = parseAuditMainArgs(Bun.argv.slice(2));
  if (parsed.isErr()) {
    log.error({ error: parsed.error }, "invalid docs-audit command");
    process.exitCode = 2;
  } else {
    const result = await runAuditMain(parsed.value);
    if (result.isErr()) {
      log.error({ error: result.error }, "docs-audit phase failed");
      process.exitCode = 1;
    }
  }
}
