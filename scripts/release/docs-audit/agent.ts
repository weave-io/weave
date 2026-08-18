/**
 * Headless docs-audit agent.
 *
 * Isolated exact-model session over a caller-supplied content root. The model
 * may use confined read/grep/find/ls plus one typed submit tool. Findings
 * block only evidence-backed factual contradiction, missing-required docs,
 * and undocumented public behavior. Style warns. Patches are validated, never
 * applied here.
 */
import { dirname, join, relative, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_DEFAULT_THINKING,
  CHANGELOG_AGENT_MODEL,
  createDocsAuditSessionConfig,
  DOCS_AUDIT_FORBIDDEN_TOOLS,
  DOCS_AUDIT_READONLY_TOOLS,
  DOCS_AUDIT_TOOL_ALLOWLIST,
  type HeadlessSession,
  type HeadlessSessionConfigError,
  type HeadlessSessionDriver,
  type HeadlessSessionError,
  type HeadlessThinkingLevel,
  type IsolatedHeadlessSessionConfig,
  SUBMIT_DOCS_AUDIT_TOOL,
  toPiCreateAgentSessionOptions,
} from "../ai/headless-session.js";
import { DigestSchema, FullShaSchema } from "../model.js";
import { docsAuditBytesDigest, docsAuditDigest } from "./deterministic.js";
import { type DocsAuditPatch, validateDocsAuditPatch } from "./patches.js";
import {
  DOCS_AUDIT_KINDS,
  DOCS_AUDIT_LIMITS,
  DOCS_AUDIT_POLICY_VERSION,
  DOCS_AUDIT_SEVERITIES,
  type DocsAuditFinding,
  type DocsAuditIssue,
  docsAuditPolicyText,
  isAllowedDocsPatchPath,
  isBlockingKind,
  isSafeRelativePath,
  isWarningKind,
} from "./policy.js";

export const DOCS_AUDIT_PROMPT_VERSION = 1 as const;

export {
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_DEFAULT_THINKING,
  CHANGELOG_AGENT_MODEL,
  createDocsAuditSessionConfig,
  DOCS_AUDIT_FORBIDDEN_TOOLS,
  DOCS_AUDIT_LIMITS,
  DOCS_AUDIT_READONLY_TOOLS,
  DOCS_AUDIT_TOOL_ALLOWLIST,
  SUBMIT_DOCS_AUDIT_TOOL,
  toPiCreateAgentSessionOptions,
};

export const DocsAuditEvidenceSchema = z
  .object({
    path: z.string().min(1).max(DOCS_AUDIT_LIMITS.pathChars),
    excerpt: z.string().min(1).max(DOCS_AUDIT_LIMITS.excerptChars),
    excerptDigest: DigestSchema,
  })
  .strict();

export const DocsAuditFindingSchema = z
  .object({
    severity: z.enum(DOCS_AUDIT_SEVERITIES),
    kind: z.enum(DOCS_AUDIT_KINDS),
    evidence: DocsAuditEvidenceSchema,
    claim: z.string().min(1).max(DOCS_AUDIT_LIMITS.claimChars),
  })
  .strict();

export const DocsAuditPatchSchema = z
  .object({
    path: z.string().min(1).max(DOCS_AUDIT_LIMITS.pathChars),
    unifiedDiff: z.string().min(1).max(DOCS_AUDIT_LIMITS.diffBytes),
  })
  .strict();

export const DocsAuditSubmissionSchema = z
  .object({
    findings: z.array(DocsAuditFindingSchema).max(DOCS_AUDIT_LIMITS.findings),
    patches: z
      .array(DocsAuditPatchSchema)
      .max(DOCS_AUDIT_LIMITS.patches)
      .optional(),
  })
  .strict();

export type DocsAuditSubmission = z.infer<typeof DocsAuditSubmissionSchema>;

export type DocsAuditPathError =
  | { type: "DocsAuditPathEscapesContentRoot"; path: string }
  | { type: "DocsAuditPathNotFound"; path: string }
  | { type: "DocsAuditPathUnsafe"; path: string }
  | {
      type: "DocsAuditReadTooLarge";
      path: string;
      bytes: number;
      limit: number;
    }
  | { type: "DocsAuditGrepPatternInvalid"; pattern: string }
  | { type: "DocsAuditWorkspaceFailed"; message: string };

export type DocsAuditSubmissionError =
  | {
      type: "InvalidDocsAuditSubmission";
      issues: readonly DocsAuditIssue[];
    }
  | { type: "DocsAuditSubmissionTooLarge"; bytes: number; limit: number }
  | { type: "DocsAuditEvidenceUnresolved"; issues: readonly DocsAuditIssue[] };

export type DocsAuditAgentError =
  | HeadlessSessionConfigError
  | HeadlessSessionError
  | DocsAuditPathError
  | DocsAuditSubmissionError
  | { type: "InvalidDocsAuditSha"; auditedSha: string }
  | { type: "DocsAuditPromptOverflow"; bytes: number; limit: number }
  | {
      type: "DocsAuditAgentBlocked";
      attempts: 2;
      issues: readonly DocsAuditIssue[];
    };

export interface DocsAuditAgentInput {
  contentRoot: string;
  auditedSha: string;
  driver: HeadlessSessionDriver;
  thinking?: string;
}

export interface DocsAuditAgentResult {
  promptVersion: typeof DOCS_AUDIT_PROMPT_VERSION;
  policyVersion: typeof DOCS_AUDIT_POLICY_VERSION;
  model: typeof CHANGELOG_AGENT_MODEL;
  thinking: HeadlessThinkingLevel;
  attempts: 1 | 2;
  auditedSha: string;
  submission: DocsAuditSubmission;
  findings: readonly DocsAuditFinding[];
  patches: readonly DocsAuditPatch[];
  digest: string;
  session: IsolatedHeadlessSessionConfig;
}

export interface DocsAuditReadResult {
  path: string;
  text: string;
  digest: string;
}

export interface DocsAuditGrepMatch {
  path: string;
  line: number;
  text: string;
}

interface PreparedRun {
  config: IsolatedHeadlessSessionConfig;
  prompt: string;
  workspace: DocsAuditWorkspace;
  auditedSha: string;
  apiKey: string;
}

type InvalidDocsAuditSubmissionError = Extract<
  DocsAuditSubmissionError,
  { type: "InvalidDocsAuditSubmission" }
>;
type DocsAuditEvidenceUnresolvedError = Extract<
  DocsAuditSubmissionError,
  { type: "DocsAuditEvidenceUnresolved" }
>;
type DocsAuditAgentBlockedError = Extract<
  DocsAuditAgentError,
  { type: "DocsAuditAgentBlocked" }
>;

export class DocsAuditWorkspace {
  private constructor(readonly contentRoot: string) {}

  static open(
    contentRoot: string,
  ): ResultAsync<DocsAuditWorkspace, DocsAuditPathError> {
    const resolved = resolve(contentRoot);
    return canonicalExisting(resolved).andThen((root) =>
      isDirectory(root).andThen((directory) => {
        if (!directory)
          return errAsync({
            type: "DocsAuditPathNotFound" as const,
            path: contentRoot,
          });
        return okAsync(new DocsAuditWorkspace(root));
      }),
    );
  }

  read(path: string): ResultAsync<DocsAuditReadResult, DocsAuditPathError> {
    return this.confineExisting(path).andThen((absolute) =>
      readBoundedFile(absolute, path),
    );
  }

  ls(path: string): ResultAsync<readonly string[], DocsAuditPathError> {
    const relativePath = path.length === 0 ? "." : path;
    return this.confineExistingDirectory(relativePath).andThen((absolute) =>
      listConfined(this.contentRoot, absolute),
    );
  }

  find(glob: string): ResultAsync<readonly string[], DocsAuditPathError> {
    if (glob.length === 0 || glob.length > DOCS_AUDIT_LIMITS.globChars)
      return errAsync({ type: "DocsAuditPathUnsafe", path: glob });
    if (glob.includes("\0") || glob.includes(".."))
      return errAsync({ type: "DocsAuditPathUnsafe", path: glob });
    return scanGlob(this.contentRoot, glob);
  }

  grep(input: {
    pattern: string;
    glob?: string;
  }): ResultAsync<readonly DocsAuditGrepMatch[], DocsAuditPathError> {
    if (
      input.pattern.length === 0 ||
      input.pattern.length > DOCS_AUDIT_LIMITS.grepPatternChars
    )
      return errAsync({
        type: "DocsAuditGrepPatternInvalid",
        pattern: input.pattern,
      });
    const compiled = Result.fromThrowable(
      () => new RegExp(input.pattern),
      () => ({
        type: "DocsAuditGrepPatternInvalid" as const,
        pattern: input.pattern,
      }),
    )();
    if (compiled.isErr()) return errAsync(compiled.error);
    const glob = input.glob ?? "**/*.{md,mdx}";
    return this.find(glob).andThen((paths) =>
      grepPaths(this, paths, compiled.value),
    );
  }

  resolveEvidence(
    finding: DocsAuditFinding,
  ): ResultAsync<void, DocsAuditIssue> {
    if (!isSafeRelativePath(finding.evidence.path))
      return errAsync({
        code: "unsafe_evidence_path",
        path: finding.evidence.path,
      });
    return this.read(finding.evidence.path)
      .mapErr(() => ({
        code: "unresolved_evidence_path",
        path: finding.evidence.path,
      }))
      .andThen((file) => {
        if (!file.text.includes(finding.evidence.excerpt))
          return errAsync({
            code: "unresolved_evidence_excerpt",
            path: finding.evidence.path,
          });
        const digest = docsAuditBytesDigest(finding.evidence.excerpt);
        if (digest !== finding.evidence.excerptDigest)
          return errAsync({
            code: "unresolved_evidence_digest",
            path: finding.evidence.path,
          });
        return okAsync(undefined);
      });
  }

  readOptional(
    path: string,
  ): ResultAsync<string | undefined, DocsAuditPathError> {
    if (!isSafeRelativePath(path))
      return errAsync({ type: "DocsAuditPathUnsafe", path });
    return this.confine(path).asyncAndThen((absolute) =>
      ResultAsync.fromPromise(
        Bun.file(absolute).exists(),
        (cause) =>
          ({
            type: "DocsAuditWorkspaceFailed",
            message: String(cause),
          }) as const,
      ).andThen((exists) => {
        if (!exists) return okAsync(undefined);
        return this.read(path).map((file) => file.text);
      }),
    );
  }

  confine(path: string): Result<string, DocsAuditPathError> {
    if (path === "." || path === "") return ok(this.contentRoot);
    if (!isSafeRelativePath(path))
      return err({ type: "DocsAuditPathUnsafe", path });
    const absolute = resolve(this.contentRoot, path);
    if (!isInsideRoot(this.contentRoot, absolute))
      return err({ type: "DocsAuditPathEscapesContentRoot", path });
    return ok(absolute);
  }

  private confineExisting(
    path: string,
  ): ResultAsync<string, DocsAuditPathError> {
    const lexical = this.confine(path);
    if (lexical.isErr()) return errAsync(lexical.error);
    return canonicalExisting(lexical.value).andThen((canonical) => {
      if (!isInsideRoot(this.contentRoot, canonical))
        return errAsync({
          type: "DocsAuditPathEscapesContentRoot" as const,
          path,
        });
      if (isSymlink(lexical.value) && canonical !== lexical.value) {
        if (!isInsideRoot(this.contentRoot, canonical))
          return errAsync({
            type: "DocsAuditPathEscapesContentRoot" as const,
            path,
          });
      }
      return okAsync(canonical);
    });
  }

  private confineExistingDirectory(
    path: string,
  ): ResultAsync<string, DocsAuditPathError> {
    return this.confineExisting(path).andThen((absolute) =>
      isDirectory(absolute).andThen((directory) => {
        if (!directory)
          return errAsync({
            type: "DocsAuditPathNotFound" as const,
            path,
          });
        return okAsync(absolute);
      }),
    );
  }
}

export function runDocsAuditAgent(
  input: DocsAuditAgentInput,
): ResultAsync<DocsAuditAgentResult, DocsAuditAgentError> {
  return prepareRun(input).andThen((prepared) =>
    input.driver
      .open(prepared.config)
      .andThen((session) =>
        finishSession(runAttempts(session, prepared), session, prepared.apiKey),
      )
      .mapErr((error) => scrubSecret(error, prepared.apiKey)),
  );
}

function prepareRun(
  input: DocsAuditAgentInput,
): ResultAsync<PreparedRun, DocsAuditAgentError> {
  const sha = FullShaSchema.safeParse(input.auditedSha);
  if (!sha.success)
    return errAsync({
      type: "InvalidDocsAuditSha",
      auditedSha: input.auditedSha,
    });
  const config = createDocsAuditSessionConfig({
    thinking: input.thinking,
    contentRoot: input.contentRoot,
  });
  if (config.isErr()) return errAsync(config.error);
  return DocsAuditWorkspace.open(input.contentRoot).andThen((workspace) => {
    const bound: IsolatedHeadlessSessionConfig = {
      ...config.value,
      contentRoot: workspace.contentRoot,
    };
    const prompt = buildDocsAuditPrompt({
      contentRoot: workspace.contentRoot,
      auditedSha: sha.data,
    });
    if (prompt.isErr()) return errAsync(prompt.error);
    return okAsync({
      config: bound,
      prompt: prompt.value,
      workspace,
      auditedSha: sha.data,
      apiKey: process.env[CHANGELOG_AGENT_API_KEY_ENV] ?? "",
    });
  });
}

function finishSession(
  result: ResultAsync<DocsAuditAgentResult, DocsAuditAgentError>,
  session: HeadlessSession,
  apiKey: string,
): ResultAsync<DocsAuditAgentResult, DocsAuditAgentError> {
  return result
    .andThen((value) => {
      session.dispose();
      return okAsync(scrubSecret(value, apiKey));
    })
    .orElse((error) => {
      session.dispose();
      return errAsync(scrubSecret(error, apiKey));
    });
}

function runAttempts(
  session: HeadlessSession,
  prepared: PreparedRun,
): ResultAsync<DocsAuditAgentResult, DocsAuditAgentError> {
  return session.prompt(prepared.prompt).andThen((first) =>
    inspectSubmission(first, prepared).andThen((firstCheck) => {
      if (firstCheck.isOk())
        return renderResult(prepared, session.config, firstCheck.value, 1);
      if (firstCheck.error.type === "DocsAuditSubmissionTooLarge")
        return errAsync(firstCheck.error);
      const retryPrompt = appendRetryErrors(
        prepared.prompt,
        firstCheck.error.issues,
      );
      if (retryPrompt.isErr()) return errAsync(retryPrompt.error);
      return session.prompt(retryPrompt.value).andThen((second) =>
        inspectSubmission(second, prepared).andThen((secondCheck) => {
          if (secondCheck.isOk())
            return renderResult(prepared, session.config, secondCheck.value, 2);
          if (secondCheck.error.type === "DocsAuditSubmissionTooLarge")
            return errAsync(secondCheck.error);
          return errAsync(docsAuditAgentBlocked(secondCheck.error.issues));
        }),
      );
    }),
  );
}

function inspectSubmission(
  submission: { toolName: string; input: unknown },
  prepared: PreparedRun,
): ResultAsync<Result<DocsAuditSubmission, DocsAuditSubmissionError>, never> {
  return acceptSubmission(submission, prepared)
    .map((value) => ok<DocsAuditSubmission, DocsAuditSubmissionError>(value))
    .orElse((error) =>
      okAsync(err<DocsAuditSubmission, DocsAuditSubmissionError>(error)),
    );
}

function docsAuditAgentBlocked(
  issues: readonly DocsAuditIssue[],
): DocsAuditAgentBlockedError {
  return {
    type: "DocsAuditAgentBlocked",
    attempts: DOCS_AUDIT_LIMITS.attempts,
    issues: boundIssues(issues),
  };
}

function acceptSubmission(
  submission: { toolName: string; input: unknown },
  prepared: PreparedRun,
): ResultAsync<
  DocsAuditSubmission,
  Extract<
    DocsAuditSubmissionError,
    | { type: "InvalidDocsAuditSubmission" }
    | { type: "DocsAuditSubmissionTooLarge" }
    | { type: "DocsAuditEvidenceUnresolved" }
  >
> {
  if (submission.toolName !== SUBMIT_DOCS_AUDIT_TOOL)
    return errAsync(
      invalidDocsAuditSubmission([{ code: "wrong_tool", path: "toolName" }]),
    );
  if (containsSecret(submission.input, prepared.apiKey))
    return errAsync(
      invalidDocsAuditSubmission([{ code: "secret_in_submission", path: "" }]),
    );
  return validateDocsAuditSubmission(submission.input, prepared.workspace);
}

function renderResult(
  prepared: PreparedRun,
  session: IsolatedHeadlessSessionConfig,
  submission: DocsAuditSubmission,
  attempts: 1 | 2,
): ResultAsync<DocsAuditAgentResult, DocsAuditAgentError> {
  return okAsync({
    promptVersion: DOCS_AUDIT_PROMPT_VERSION,
    policyVersion: DOCS_AUDIT_POLICY_VERSION,
    model: CHANGELOG_AGENT_MODEL,
    thinking: session.thinking,
    attempts,
    auditedSha: prepared.auditedSha,
    submission,
    findings: submission.findings,
    patches: submission.patches ?? [],
    digest: docsAuditDigest(submission),
    session,
  });
}

export function validateDocsAuditSubmission(
  input: unknown,
  workspace: DocsAuditWorkspace,
): ResultAsync<
  DocsAuditSubmission,
  Extract<
    DocsAuditSubmissionError,
    | { type: "InvalidDocsAuditSubmission" }
    | { type: "DocsAuditSubmissionTooLarge" }
    | { type: "DocsAuditEvidenceUnresolved" }
  >
> {
  const cloned = cloneSubmission(input);
  if (cloned.isErr()) return errAsync(cloned.error);
  const parsed = DocsAuditSubmissionSchema.safeParse(cloned.value);
  if (!parsed.success)
    return errAsync(
      invalidDocsAuditSubmission(
        parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        })),
      ),
    );
  const issues: DocsAuditIssue[] = [];
  collectFindingIssues(parsed.data.findings, issues);
  collectPatchShapeIssues(parsed.data.patches ?? [], issues);
  if (issues.length > 0) return errAsync(invalidDocsAuditSubmission(issues));
  return resolveAllEvidence(parsed.data.findings, workspace).andThen(
    (evidenceIssues) => {
      if (evidenceIssues.length > 0)
        return errAsync(docsAuditEvidenceUnresolved(evidenceIssues));
      return validatePatchBodies(parsed.data, workspace);
    },
  );
}

function collectFindingIssues(
  findings: readonly DocsAuditFinding[],
  issues: DocsAuditIssue[],
): void {
  for (const [index, finding] of findings.entries()) {
    if (finding.severity === "block" && !isBlockingKind(finding.kind))
      issues.push({
        code: "style_must_not_block",
        path: `findings.${index}.severity`,
      });
    if (isWarningKind(finding.kind) && finding.severity !== "warn")
      issues.push({
        code: "style_must_not_block",
        path: `findings.${index}.kind`,
      });
    if (!isSafeRelativePath(finding.evidence.path))
      issues.push({
        code: "unsafe_evidence_path",
        path: `findings.${index}.evidence.path`,
      });
  }
}

function collectPatchShapeIssues(
  patches: readonly DocsAuditPatch[],
  issues: DocsAuditIssue[],
): void {
  const seen = new Set<string>();
  for (const [index, patch] of patches.entries()) {
    if (!isAllowedDocsPatchPath(patch.path))
      issues.push({
        code: "patch_path_rejected",
        path: `patches.${index}.path`,
      });
    if (seen.has(patch.path))
      issues.push({
        code: "duplicate_patch_path",
        path: `patches.${index}.path`,
      });
    seen.add(patch.path);
  }
}

function resolveAllEvidence(
  findings: readonly DocsAuditFinding[],
  workspace: DocsAuditWorkspace,
): ResultAsync<readonly DocsAuditIssue[], never> {
  if (findings.length === 0) return okAsync([]);
  const issues: DocsAuditIssue[] = [];
  let chain: ResultAsync<void, never> = okAsync(undefined);
  for (const finding of findings) {
    chain = chain.andThen(() =>
      workspace
        .resolveEvidence(finding)
        .map(() => undefined)
        .orElse((issue) => {
          issues.push(issue);
          return okAsync(undefined);
        }),
    );
  }
  return chain.map(() => issues);
}

function validatePatchBodies(
  submission: DocsAuditSubmission,
  workspace: DocsAuditWorkspace,
): ResultAsync<
  DocsAuditSubmission,
  Extract<DocsAuditSubmissionError, { type: "InvalidDocsAuditSubmission" }>
> {
  const patches = submission.patches ?? [];
  if (patches.length === 0) return okAsync(submission);
  const issues: DocsAuditIssue[] = [];
  let chain: ResultAsync<void, never> = okAsync(undefined);
  for (const [index, patch] of patches.entries()) {
    chain = chain.andThen(() =>
      workspace
        .readOptional(patch.path)
        .map((original) => {
          const validated = validateDocsAuditPatch(patch, original);
          if (validated.isErr())
            issues.push({
              code: validated.error.type,
              path: `patches.${index}`,
            });
          return undefined;
        })
        .orElse(() => {
          issues.push({
            code: "patch_read_failed",
            path: `patches.${index}.path`,
          });
          return okAsync(undefined);
        }),
    );
  }
  return chain.andThen(() => {
    if (issues.length > 0) return errAsync(invalidDocsAuditSubmission(issues));
    return okAsync(submission);
  });
}

export function buildDocsAuditPrompt(input: {
  contentRoot: string;
  auditedSha: string;
}): Result<string, DocsAuditAgentError> {
  const lines = [
    `DOCS_AUDIT_PROMPT_VERSION ${DOCS_AUDIT_PROMPT_VERSION}`,
    `Model ${CHANGELOG_AGENT_MODEL}`,
    `Audited SHA ${input.auditedSha}`,
    `Content root is supplied by the caller and is the only readable tree.`,
    docsAuditPolicyText(),
    `Submit exactly once with the ${SUBMIT_DOCS_AUDIT_TOOL} tool.`,
  ];
  const prompt = `${lines.join("\n")}\n`;
  const bytes = utf8ByteLength(prompt);
  if (bytes > DOCS_AUDIT_LIMITS.promptBytes)
    return err({
      type: "DocsAuditPromptOverflow",
      bytes,
      limit: DOCS_AUDIT_LIMITS.promptBytes,
    });
  return ok(prompt);
}

function appendRetryErrors(
  prompt: string,
  issues: readonly DocsAuditIssue[],
): Result<string, DocsAuditAgentError> {
  const block = [
    "Previous submission was rejected. Fix these issues and submit again with submit_docs_audit.",
    ...issues.map((issue) => `- ${issue.code} ${issue.path}`),
  ].join("\n");
  const bounded =
    utf8ByteLength(block) > DOCS_AUDIT_LIMITS.retryErrorBytes
      ? `${block.slice(0, DOCS_AUDIT_LIMITS.retryErrorBytes)}\n`
      : `${block}\n`;
  const retry = `${prompt}\n${bounded}`;
  const limit =
    DOCS_AUDIT_LIMITS.promptBytes + DOCS_AUDIT_LIMITS.retryErrorBytes;
  const bytes = utf8ByteLength(retry);
  if (bytes > limit)
    return err({
      type: "DocsAuditPromptOverflow",
      bytes,
      limit,
    });
  return ok(retry);
}

function invalidDocsAuditSubmission(
  issues: readonly DocsAuditIssue[],
): InvalidDocsAuditSubmissionError {
  return {
    type: "InvalidDocsAuditSubmission",
    issues: boundIssues(issues),
  };
}

function docsAuditEvidenceUnresolved(
  issues: readonly DocsAuditIssue[],
): DocsAuditEvidenceUnresolvedError {
  return {
    type: "DocsAuditEvidenceUnresolved",
    issues: boundIssues(issues),
  };
}

function cloneSubmission(
  input: unknown,
): Result<
  unknown,
  Extract<
    DocsAuditSubmissionError,
    { type: "InvalidDocsAuditSubmission" | "DocsAuditSubmissionTooLarge" }
  >
> {
  const encoded = Result.fromThrowable(
    () => JSON.stringify(input),
    () => invalidDocsAuditSubmission([{ code: "unserializable", path: "" }]),
  )();
  if (encoded.isErr()) return err(encoded.error);
  const bytes = utf8ByteLength(encoded.value);
  if (bytes > DOCS_AUDIT_LIMITS.jsonBytes)
    return err({
      type: "DocsAuditSubmissionTooLarge",
      bytes,
      limit: DOCS_AUDIT_LIMITS.jsonBytes,
    });
  return Result.fromThrowable(
    () => JSON.parse(encoded.value) as unknown,
    () => invalidDocsAuditSubmission([{ code: "unparseable", path: "" }]),
  )();
}

function boundIssues(
  issues: readonly DocsAuditIssue[],
): readonly DocsAuditIssue[] {
  return issues.slice(0, DOCS_AUDIT_LIMITS.issues).map((issue) => ({
    code: boundText(issue.code, DOCS_AUDIT_LIMITS.issueCodeChars),
    path: boundText(issue.path, DOCS_AUDIT_LIMITS.issuePathChars),
  }));
}

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

function containsSecret(value: unknown, apiKey: string): boolean {
  if (apiKey.length === 0) return false;
  const encoded = Result.fromThrowable(
    () => JSON.stringify(value),
    () => false,
  )();
  if (encoded.isErr() || encoded.value === undefined) return false;
  return encoded.value.includes(apiKey);
}

function scrubSecret<T>(value: T, apiKey: string): T {
  if (apiKey.length === 0) return value;
  const encoded = Result.fromThrowable(
    () => JSON.stringify(value),
    () => "",
  )();
  if (encoded.isErr() || encoded.value === undefined || encoded.value === "")
    return value;
  if (!encoded.value.includes(apiKey)) return value;
  const parsed = Result.fromThrowable(
    () => JSON.parse(encoded.value.replaceAll(apiKey, "[redacted]")) as T,
    () => value,
  )();
  return parsed.isOk() ? parsed.value : value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  if (relativePath === "") return true;
  return !relativePath.startsWith("..") && !relativePath.startsWith("/");
}

function canonicalExisting(
  path: string,
): ResultAsync<string, DocsAuditPathError> {
  return runCommand(["realpath", path]).andThen((output) => {
    if (output.exitCode !== 0)
      return errAsync({
        type: "DocsAuditPathNotFound" as const,
        path,
      });
    const canonical = output.stdout.trim();
    if (canonical.length === 0)
      return errAsync({
        type: "DocsAuditPathNotFound" as const,
        path,
      });
    return okAsync(canonical);
  });
}

function isDirectory(path: string): ResultAsync<boolean, DocsAuditPathError> {
  return runCommand(["test", "-d", path]).andThen((output) => {
    if (output.exitCode === 0) return okAsync(true);
    if (output.exitCode === 1) return okAsync(false);
    return errAsync({
      type: "DocsAuditWorkspaceFailed" as const,
      message: "test -d failed",
    });
  });
}

function isSymlink(path: string): boolean {
  const result = Bun.spawnSync(["test", "-L", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0;
}

function runCommand(
  args: readonly string[],
): ResultAsync<{ exitCode: number; stdout: string }, DocsAuditPathError> {
  return ResultAsync.fromPromise(
    Promise.resolve(
      Bun.spawnSync({
        cmd: [...args],
        stdout: "pipe",
        stderr: "pipe",
      }),
    ),
    (cause) =>
      ({
        type: "DocsAuditWorkspaceFailed",
        message: String(cause),
      }) as const,
  ).map((result) => ({
    exitCode: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
  }));
}

function readBoundedFile(
  absolute: string,
  requested: string,
): ResultAsync<DocsAuditReadResult, DocsAuditPathError> {
  return ResultAsync.fromPromise(
    Bun.file(absolute).arrayBuffer(),
    (cause) =>
      ({
        type: "DocsAuditWorkspaceFailed",
        message: String(cause),
      }) as const,
  ).andThen((buffer) => {
    const bytes = buffer.byteLength;
    if (bytes > DOCS_AUDIT_LIMITS.readBytes)
      return errAsync({
        type: "DocsAuditReadTooLarge" as const,
        path: requested,
        bytes,
        limit: DOCS_AUDIT_LIMITS.readBytes,
      });
    const text = new TextDecoder().decode(buffer);
    return okAsync({
      path: requested,
      text,
      digest: docsAuditBytesDigest(text),
    });
  });
}

function listConfined(
  root: string,
  directory: string,
): ResultAsync<readonly string[], DocsAuditPathError> {
  return ResultAsync.fromPromise(
    collectGlob(directory, "*"),
    (cause) =>
      ({
        type: "DocsAuditWorkspaceFailed",
        message: String(cause),
      }) as const,
  ).andThen((entries) => {
    const confined: string[] = [];
    for (const entry of entries) {
      const absolute = resolve(directory, entry);
      if (isSymlink(absolute)) {
        const linked = Bun.spawnSync(["realpath", absolute], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const canonical = new TextDecoder().decode(linked.stdout).trim();
        if (
          linked.exitCode !== 0 ||
          canonical.length === 0 ||
          !isInsideRoot(root, canonical)
        )
          continue;
      } else if (!isInsideRoot(root, absolute)) continue;
      confined.push(entry.replaceAll("\\", "/"));
      if (confined.length >= DOCS_AUDIT_LIMITS.listEntries) break;
    }
    confined.sort();
    return okAsync(confined);
  });
}

function scanGlob(
  root: string,
  glob: string,
): ResultAsync<readonly string[], DocsAuditPathError> {
  return ResultAsync.fromPromise(
    collectGlob(root, glob),
    (cause) =>
      ({
        type: "DocsAuditWorkspaceFailed",
        message: String(cause),
      }) as const,
  ).andThen((entries) => {
    const confined: string[] = [];
    for (const entry of entries) {
      if (!isSafeRelativePath(entry.replaceAll("\\", "/"))) continue;
      const absolute = resolve(root, entry);
      if (isSymlink(absolute)) {
        const linked = Bun.spawnSync(["realpath", absolute], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const canonical = new TextDecoder().decode(linked.stdout).trim();
        if (
          linked.exitCode !== 0 ||
          canonical.length === 0 ||
          !isInsideRoot(root, canonical)
        )
          continue;
      } else if (!isInsideRoot(root, absolute)) continue;
      confined.push(entry.replaceAll("\\", "/"));
      if (confined.length >= DOCS_AUDIT_LIMITS.listEntries) break;
    }
    confined.sort();
    return okAsync(confined);
  });
}

async function collectGlob(
  cwd: string,
  glob: string,
): Promise<readonly string[]> {
  const entries: string[] = [];
  for await (const path of new Bun.Glob(glob).scan({
    cwd,
    onlyFiles: false,
    dot: false,
  }))
    entries.push(path);
  return entries;
}

function grepPaths(
  workspace: DocsAuditWorkspace,
  paths: readonly string[],
  pattern: RegExp,
): ResultAsync<readonly DocsAuditGrepMatch[], DocsAuditPathError> {
  const matches: DocsAuditGrepMatch[] = [];
  let chain: ResultAsync<void, DocsAuditPathError> = okAsync(undefined);
  for (const path of paths) {
    if (matches.length >= DOCS_AUDIT_LIMITS.grepMatches) break;
    chain = chain.andThen(() =>
      workspace.read(path).andThen((file) => {
        const lines = file.text.split("\n");
        for (const [index, line] of lines.entries()) {
          if (matches.length >= DOCS_AUDIT_LIMITS.grepMatches) break;
          if (pattern.test(line))
            matches.push({ path, line: index + 1, text: line });
        }
        return okAsync(undefined);
      }),
    );
  }
  return chain.map(() => matches);
}

export function docsAuditToolNames(): readonly string[] {
  return DOCS_AUDIT_TOOL_ALLOWLIST;
}

export function dirnameOf(path: string): string {
  return dirname(join(".", path));
}
