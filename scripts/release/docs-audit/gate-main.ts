/**
 * Trusted controller entrypoint for the single terminal `docs-audit` check.
 *
 * It parses only bounded, descriptor-safe artifacts and delegates semantic
 * decisions to Task 19's `combineDocsAuditGate`. A workflow feeder may be
 * skipped or cancelled; this adapter turns that state into a typed gate input
 * instead of letting GitHub's job graph silently decide policy.
 */

import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { FullShaSchema } from "../model.js";
import { DocsAuditFindingSchema } from "./agent.js";
import {
  AgentAuditArtifactSchema,
  DeterministicAuditArtifactSchema,
} from "./audit-main.js";
import { docsAuditDigest } from "./deterministic.js";
import {
  createGitHubFollowUpApi,
  DOCS_AUDIT_CHECK_NAME,
  FOLLOWUP_APP_TOKEN_ENV,
  type FollowUpApi,
  FollowUpAuditResultSchema,
} from "./followup-main.js";
import {
  combineDocsAuditGate,
  type DocsAuditAiStatusInput,
  type DocsAuditFollowUpStatus,
  type DocsAuditGateError,
  type DocsAuditGateSuccess,
  type DocsAuditPublicImpactClassification,
  docsAuditOutcomeDigest,
} from "./gate.js";

const log = logger.child({ module: "docs-audit-gate-main" });

export const GATE_MAIN_SCHEMA_VERSION = 1 as const;
export const GATE_CHECK_NAME = DOCS_AUDIT_CHECK_NAME;

const GateStatusSchema = z.enum([
  "submitted",
  "not-required",
  "unavailable",
  "skipped",
  "cancelled",
  "missing",
]);
const FollowUpStatusSchema = z.enum([
  "not-applicable",
  "passed",
  "awaiting",
  "failed",
]);

export const DocsAuditGateInputSchema = z
  .object({
    schemaVersion: z.literal(GATE_MAIN_SCHEMA_VERSION),
    publicImpact: z
      .object({
        auditedSha: FullShaSchema,
        classification: z.enum(["public-impact", "no-impact"]),
      })
      .strict(),
    deterministic: z
      .object({
        auditedSha: FullShaSchema,
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        passed: z.boolean(),
      })
      .strict(),
    ai: z
      .object({
        auditedSha: FullShaSchema,
        status: GateStatusSchema,
        digest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/)
          .optional(),
        findings: z.array(DocsAuditFindingSchema).max(32).optional(),
      })
      .strict(),
    followUp: z
      .object({
        auditedSha: FullShaSchema,
        status: FollowUpStatusSchema,
      })
      .strict(),
  })
  .strict();
export type DocsAuditGateInputRecord = z.infer<typeof DocsAuditGateInputSchema>;

export type GateMainError =
  | {
      readonly type: "InvalidGateInput";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "GateSemanticFailure";
      readonly error: DocsAuditGateError;
    }
  | {
      readonly type: "GateArtifactReadFailed";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "GateArtifactInvalid";
      readonly path: string;
      readonly issues: readonly string[];
    }
  | {
      readonly type: "GateOutputWriteFailed";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "GateCheckPublishFailed";
      readonly message: string;
    };

export interface DocsAuditGateMainResult {
  readonly schemaVersion: typeof GATE_MAIN_SCHEMA_VERSION;
  readonly name: typeof GATE_CHECK_NAME;
  readonly auditedSha: string;
  readonly conclusion: "success" | "failure";
  readonly status: "pass" | "not-required" | "fail";
  readonly outcomeDigest?: string;
  readonly outcome?: DocsAuditGateSuccess["outcome"];
  readonly warnings: number;
  readonly errorType?: DocsAuditGateError["type"];
  readonly errorDetail?: string;
}

/**
 * Parses and evaluates one terminal input. The function never throws for a
 * hostile object, accessor, cycle, symbol, or malformed artifact.
 */
export function evaluateDocsAuditGate(
  value: unknown,
): Result<DocsAuditGateMainResult, GateMainError> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidInput([cloned.error]));
  const parsed = DocsAuditGateInputSchema.safeParse(cloned.value);
  if (!parsed.success)
    return err(
      invalidInput(
        parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      ),
    );
  return evaluateParsedGate(parsed.data);
}

export function evaluateParsedGate(
  input: DocsAuditGateInputRecord,
): Result<DocsAuditGateMainResult, GateMainError> {
  const gate = combineDocsAuditGate(input);
  if (gate.isOk()) {
    const outcomeDigest = docsAuditOutcomeDigest(gate.value.outcome);
    return ok({
      schemaVersion: GATE_MAIN_SCHEMA_VERSION,
      name: GATE_CHECK_NAME,
      auditedSha: gate.value.outcome.auditedSha,
      conclusion: "success",
      status: gate.value.type,
      outcomeDigest,
      outcome: gate.value.outcome,
      warnings: gate.value.type === "pass" ? gate.value.warnings.length : 0,
    });
  }
  return ok({
    schemaVersion: GATE_MAIN_SCHEMA_VERSION,
    name: GATE_CHECK_NAME,
    auditedSha: input.publicImpact.auditedSha,
    conclusion: "failure",
    status: "fail",
    errorType: gate.error.type,
    errorDetail: gateErrorDetail(gate.error),
    warnings: 0,
  });
}

/** Converts a GitHub feeder result into the closed AI status vocabulary. */
export function aiStatusFromJob(
  jobResult: string | undefined,
  artifactPresent: boolean,
): DocsAuditAiStatusInput {
  if (artifactPresent && jobResult === "success") return "submitted";
  switch (jobResult) {
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "failure":
      return "unavailable";
    default:
      return "missing";
  }
}

export function followUpStatusFromJob(
  jobResult: string | undefined,
  artifactPresent: boolean,
): DocsAuditFollowUpStatus {
  if (artifactPresent && jobResult === "success") return "passed";
  if (jobResult === "failure" || jobResult === "cancelled") return "failed";
  if (jobResult === "skipped" || jobResult === undefined) return "awaiting";
  return "failed";
}

/** Creates the bounded input used by the primary PR terminal job. */
export function buildPrimaryGateInput(input: {
  readonly auditedSha: string;
  readonly classification: DocsAuditPublicImpactClassification;
  readonly deterministic?: {
    readonly auditedSha: string;
    readonly digest: string;
    readonly passed: boolean;
  };
  readonly deterministicJobResult?: string;
  readonly ai?: {
    readonly auditedSha: string;
    readonly status: DocsAuditAiStatusInput;
    readonly digest?: string;
    readonly findings?: readonly z.infer<typeof DocsAuditFindingSchema>[];
  };
  readonly aiJobResult?: string;
  readonly aiArtifactPresent?: boolean;
  readonly followUpStatus?: DocsAuditFollowUpStatus;
}): Result<DocsAuditGateInputRecord, GateMainError> {
  const deterministic = input.deterministic ?? {
    auditedSha: input.auditedSha,
    digest: docsAuditDigest({
      type: "deterministic-missing",
      jobResult: input.deterministicJobResult ?? "missing",
    }),
    passed: false,
  };
  const ai = input.ai ?? {
    auditedSha: input.auditedSha,
    status: aiStatusFromJob(
      input.aiJobResult,
      input.aiArtifactPresent === true,
    ),
    findings: [],
  };
  const record = {
    schemaVersion: GATE_MAIN_SCHEMA_VERSION,
    publicImpact: {
      auditedSha: input.auditedSha,
      classification: input.classification,
    },
    deterministic,
    ai,
    followUp: {
      auditedSha: input.auditedSha,
      status:
        input.followUpStatus ??
        (input.classification === "no-impact" ? "not-applicable" : "awaiting"),
    },
  };
  const parsed = DocsAuditGateInputSchema.safeParse(record);
  if (!parsed.success)
    return err(
      invalidInput(
        parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
      ),
    );
  return ok(parsed.data);
}

/** Builds a terminal check payload for either primary or follow-up workflow. */
export interface GateArtifactSourceInput {
  readonly auditedSha: string;
  readonly classification: DocsAuditPublicImpactClassification;
  readonly deterministic?: unknown;
  readonly ai?: unknown;
  readonly followUp?: unknown;
  readonly deterministicJobResult?: string;
  readonly aiJobResult?: string;
  readonly aiStatus?: DocsAuditAiStatusInput;
  readonly followUpStatus?: DocsAuditFollowUpStatus;
}

/** Builds the terminal input from bounded feeder artifacts and job states. */
export function buildGateInputFromArtifacts(
  source: GateArtifactSourceInput,
): Result<DocsAuditGateInputRecord, GateMainError> {
  let deterministic: DocsAuditGateInputRecord["deterministic"] | undefined;
  let ai: DocsAuditGateInputRecord["ai"] | undefined;
  let followUpStatus = source.followUpStatus;

  if (source.deterministic !== undefined) {
    const parsed = parseGateArtifact(source.deterministic, "deterministic");
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.kind !== "deterministic")
      return err(invalidArtifact("deterministic", ["wrong artifact kind"]));
    deterministic = {
      auditedSha: parsed.value.auditedSha,
      digest: parsed.value.digest,
      passed:
        source.deterministicJobResult === undefined ||
        source.deterministicJobResult === "success"
          ? parsed.value.passed
          : false,
    };
  }

  if (source.ai !== undefined) {
    const parsed = parseGateArtifact(source.ai, "ai");
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.kind !== "ai")
      return err(invalidArtifact("ai", ["wrong artifact kind"]));
    const status =
      source.aiStatus ??
      (source.aiJobResult === undefined
        ? "submitted"
        : aiStatusFromJob(source.aiJobResult, true));
    ai = {
      auditedSha: parsed.value.auditedSha,
      status,
      digest: parsed.value.digest,
      findings: parsed.value.findings,
    };
  }

  if (ai === undefined && source.aiStatus !== undefined)
    ai = {
      auditedSha: source.auditedSha,
      status: source.aiStatus,
      findings: [],
    };

  if (source.followUp !== undefined) {
    const parsed = parseGateArtifact(source.followUp, "follow-up");
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.kind !== "follow-up")
      return err(invalidArtifact("follow-up", ["wrong artifact kind"]));
    deterministic = {
      auditedSha: parsed.value.deterministic.auditedSha,
      digest: parsed.value.deterministic.digest,
      passed: parsed.value.deterministic.passed,
    };
    ai = {
      auditedSha: parsed.value.ai.auditedSha,
      status: parsed.value.ai.status,
      digest: parsed.value.ai.digest,
      findings: parsed.value.ai.findings,
    };
    followUpStatus = source.followUpStatus ?? parsed.value.followUp.status;
  }

  return buildPrimaryGateInput({
    auditedSha: source.auditedSha,
    classification: source.classification,
    deterministic,
    ai,
    aiJobResult: source.aiJobResult,
    aiArtifactPresent: source.ai !== undefined,
    followUpStatus,
  });
}

export function gateCheckInput(result: DocsAuditGateMainResult): {
  readonly name: typeof GATE_CHECK_NAME;
  readonly headSha: string;
  readonly conclusion: "success" | "failure";
  readonly resultDigest: string;
  readonly summary: string;
} {
  const resultDigest =
    result.outcomeDigest ??
    docsAuditDigest({
      type: result.errorType ?? "gate-failed",
      auditedSha: result.auditedSha,
      detail: result.errorDetail ?? "",
    });
  return {
    name: GATE_CHECK_NAME,
    headSha: result.auditedSha,
    conclusion: result.conclusion,
    resultDigest,
    summary: gateSummary(result, resultDigest),
  };
}

export function publishGateCheck(
  result: DocsAuditGateMainResult,
  api: Pick<FollowUpApi, "createCheckRun">,
): ResultAsync<void, GateMainError> {
  const payload = gateCheckInput(result);
  return api.createCheckRun(payload).mapErr((error) => ({
    type: "GateCheckPublishFailed" as const,
    message: error.type,
  }));
}

export function parseGateArtifact(
  value: unknown,
  path: string,
): Result<
  | z.infer<typeof DeterministicAuditArtifactSchema>
  | z.infer<typeof AgentAuditArtifactSchema>
  | z.infer<typeof FollowUpAuditResultSchema>,
  GateMainError
> {
  const cloned = cloneBounded(value);
  if (cloned.isErr()) return err(invalidArtifact(path, [cloned.error]));
  const parsed = DeterministicAuditArtifactSchema.safeParse(cloned.value);
  if (parsed.success) return ok(parsed.data);
  const ai = AgentAuditArtifactSchema.safeParse(cloned.value);
  if (ai.success) return ok(ai.data);
  const followUp = FollowUpAuditResultSchema.safeParse(cloned.value);
  if (followUp.success) return ok(followUp.data);
  return err(
    invalidArtifact(path, ["artifact does not match a docs-audit schema"]),
  );
}

export function runGateMain(
  input: unknown,
  outputPath?: string,
): ResultAsync<DocsAuditGateMainResult, GateMainError> {
  const evaluated = evaluateDocsAuditGate(input);
  if (evaluated.isErr()) return errAsync(evaluated.error);
  if (outputPath === undefined) return okAsync(evaluated.value);
  return ResultAsync.fromPromise(
    Bun.write(outputPath, `${canonicalJson(evaluated.value)}\n`).then(
      () => evaluated.value,
    ),
    () => ({
      type: "GateOutputWriteFailed" as const,
      path: outputPath,
      message: "gate output write failed",
    }),
  );
}

function gateSummary(result: DocsAuditGateMainResult, digest: string): string {
  return [
    `${GATE_CHECK_NAME}: ${result.status}`,
    `audited SHA: ${result.auditedSha}`,
    `result digest: ${digest}`,
    result.errorType === undefined
      ? "No blocking docs-audit error."
      : `blocking error: ${result.errorType}`,
    result.warnings === 0
      ? "No style warnings."
      : `style warnings: ${result.warnings}`,
  ].join("\n");
}

function gateErrorDetail(error: DocsAuditGateError): string {
  switch (error.type) {
    case "DocsAuditShaMismatch":
      return "all docs-audit inputs must name the same head SHA";
    case "DocsAuditDeterministicFailed":
      return "deterministic docs check failed";
    case "DocsAuditMissingRequiredAiResult":
      return `required AI result is ${error.status}`;
    case "DocsAuditHardFinding":
      return `${error.findings.length} blocking finding(s)`;
    case "DocsAuditFollowUpFailed":
      return `fork follow-up is ${error.status}`;
  }
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
      return bytes > 512 * 1024
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
    if (nodes > 8_192) return err("input graph has too many nodes");
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
      const output: unknown[] = [];
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
        output.push(child.value);
      }
      seen.delete(candidate);
      return ok(output);
    }
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(candidate),
    )) {
      if (
        key.length > 1_024 ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        return err("input contains an unsafe property");
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
): Extract<GateMainError, { type: "InvalidGateInput" }> {
  return { type: "InvalidGateInput", issues: issues.slice(0, 32) };
}

function invalidArtifact(
  path: string,
  issues: readonly string[],
): Extract<GateMainError, { type: "GateArtifactInvalid" }> {
  return { type: "GateArtifactInvalid", path, issues: issues.slice(0, 32) };
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

function readOptionalJson(
  path: string | undefined,
): ResultAsync<unknown | undefined, GateMainError> {
  if (path === undefined) return okAsync(undefined);
  return ResultAsync.fromPromise(Bun.file(path).exists(), () => ({
    type: "GateArtifactReadFailed" as const,
    path,
    message: "artifact existence check failed",
  })).andThen((exists) => {
    if (!exists) return okAsync(undefined);
    return ResultAsync.fromPromise(Bun.file(path).json(), () => ({
      type: "GateArtifactReadFailed" as const,
      path,
      message: "artifact JSON read failed",
    }));
  });
}

if (import.meta.main) {
  const values = new Map<string, string>();
  const args = Bun.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      log.error("invalid docs-audit gate arguments");
      process.exitCode = 2;
      break;
    }
    values.set(flag.slice(2), value);
  }
  if (process.exitCode === undefined) {
    const inputPath = values.get("input");
    const outputPath = values.get("output");
    let input: ResultAsync<unknown, GateMainError>;
    if (inputPath !== undefined) {
      input = readOptionalJson(inputPath).andThen((value) =>
        value === undefined
          ? errAsync<unknown, GateMainError>({
              type: "GateArtifactReadFailed",
              path: inputPath,
              message: "input artifact is missing",
            })
          : okAsync<unknown, GateMainError>(value),
      );
    } else {
      const auditedSha = values.get("audited-sha");
      const classification = values.get("classification");
      if (
        auditedSha === undefined ||
        (classification !== "public-impact" && classification !== "no-impact")
      ) {
        log.error("--input or --audited-sha with --classification is required");
        process.exitCode = 2;
        input = errAsync({
          type: "InvalidGateInput",
          issues: ["missing gate input arguments"],
        });
      } else {
        input = readOptionalJson(values.get("deterministic")).andThen(
          (deterministic) =>
            readOptionalJson(values.get("ai")).andThen((ai) =>
              readOptionalJson(values.get("follow-up")).andThen((followUp) => {
                const built = buildGateInputFromArtifacts({
                  auditedSha,
                  classification,
                  deterministic,
                  ai,
                  followUp,
                  deterministicJobResult: values.get(
                    "deterministic-job-result",
                  ),
                  aiJobResult: values.get("ai-job-result"),
                  aiStatus: parseAiStatus(values.get("ai-status")),
                  followUpStatus: parseFollowUpStatus(
                    values.get("follow-up-status"),
                  ),
                });
                return built.isErr()
                  ? errAsync(built.error)
                  : okAsync(built.value);
              }),
            ),
        );
      }
    }
    if (process.exitCode === undefined) {
      const result = await input.andThen((value) =>
        runGateMain(value, outputPath),
      );
      if (result.isErr()) {
        log.error({ error: result.error }, "docs-audit gate failed to execute");
        process.exitCode = 1;
      } else if (values.get("post") === "true") {
        const api = createGitHubFollowUpApi(
          Bun.env[FOLLOWUP_APP_TOKEN_ENV] ?? Bun.env.GITHUB_TOKEN ?? "",
        );
        const published = await publishGateCheck(result.value, api);
        if (published.isErr()) {
          log.error(
            { error: published.error },
            "docs-audit check publication failed",
          );
          process.exitCode = 1;
        }
      }
      if (result.isOk() && result.value.conclusion === "failure")
        process.exitCode = 1;
    }
  }
}

function parseAiStatus(
  value: string | undefined,
): DocsAuditAiStatusInput | undefined {
  const statuses: readonly DocsAuditAiStatusInput[] = [
    "submitted",
    "not-required",
    "unavailable",
    "skipped",
    "cancelled",
    "missing",
  ];
  return value !== undefined &&
    statuses.includes(value as DocsAuditAiStatusInput)
    ? (value as DocsAuditAiStatusInput)
    : undefined;
}

function parseFollowUpStatus(
  value: string | undefined,
): DocsAuditFollowUpStatus | undefined {
  const statuses: readonly DocsAuditFollowUpStatus[] = [
    "not-applicable",
    "passed",
    "awaiting",
    "failed",
  ];
  return value !== undefined &&
    statuses.includes(value as DocsAuditFollowUpStatus)
    ? (value as DocsAuditFollowUpStatus)
    : undefined;
}
