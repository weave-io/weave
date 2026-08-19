/**
 * Two-attempt headless changelog agent.
 *
 * The controller owns the prompt, the isolated session config, validation,
 * retry, and Task 7 rendering. The model writes prose through one typed
 * tool. A second invalid submission is a typed block with no fallback.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import {
  type ChangelogDocument,
  ChangelogDocumentSchema,
  type ChangelogEvidence,
  renderChangelog,
} from "../changelog-format.js";
import type { PublicPackageName } from "../constants.js";
import { StableVersionSchema } from "../model.js";
import { publishablePackageNames } from "../package-policy.js";
import type {
  BoundedEvidence,
  EvidenceDigest,
  PackageEvidence,
} from "./evidence.js";
import {
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_MODEL,
  createChangelogSessionConfig,
  type HeadlessSession,
  type HeadlessSessionConfigError,
  type HeadlessSessionDriver,
  type HeadlessSessionError,
  type HeadlessThinkingLevel,
  type IsolatedHeadlessSessionConfig,
} from "./headless-session.js";
import {
  type ChangelogSubmission,
  type ChangelogSubmissionError,
  type ChangelogSubmissionIssue,
  type ChangelogVersionDocument,
  SUBMIT_CHANGELOG_TOOL,
  type SubmissionIdentityRequirement,
  validateChangelogSubmission,
} from "./submission-schema.js";

/** Version of the controller-owned changelog prompt. */
export const CHANGELOG_PROMPT_VERSION = 1 as const;

export const CHANGELOG_AGENT_LIMITS = {
  promptBytes: 64 * 1024,
  retryErrorBytes: 4 * 1024,
  attempts: 2,
  versionCount: 4,
} as const;

export {
  CHANGELOG_AGENT_API_KEY_ENV,
  CHANGELOG_AGENT_DEFAULT_THINKING,
  CHANGELOG_AGENT_MODEL,
  CHANGELOG_AGENT_MODEL_ID,
  CHANGELOG_AGENT_PROVIDER,
  createChangelogSessionConfig,
  FORBIDDEN_HEADLESS_TOOLS,
  toPiCreateAgentSessionOptions,
} from "./headless-session.js";
export { SUBMIT_CHANGELOG_TOOL } from "./submission-schema.js";

export interface ChangelogAgentVersion {
  packageName: PublicPackageName;
  version: string;
}

export interface ChangelogAgentInput {
  evidence: BoundedEvidence;
  versions: readonly ChangelogAgentVersion[];
  driver: HeadlessSessionDriver;
  thinking?: string;
  refs?: ChangelogEvidence;
  history?: readonly ChangelogDocument[];
}

export interface RenderedPackageChangelog {
  packageName: PublicPackageName;
  markdown: string;
}

export interface ChangelogAgentResult {
  promptVersion: typeof CHANGELOG_PROMPT_VERSION;
  model: typeof CHANGELOG_AGENT_MODEL;
  thinking: HeadlessThinkingLevel;
  attempts: 1 | 2;
  evidenceDigest: EvidenceDigest;
  submission: ChangelogSubmission;
  changelogs: readonly RenderedPackageChangelog[];
  session: IsolatedHeadlessSessionConfig;
}

export type ChangelogAgentError =
  | { type: "InvalidChangelogThinking"; thinking: string }
  | { type: "ChangelogApiKeyMissing"; env: typeof CHANGELOG_AGENT_API_KEY_ENV }
  | { type: "InvalidChangelogAgentInput"; issues: readonly string[] }
  | {
      type: "ChangelogPromptOverflow";
      bytes: number;
      limit: number;
    }
  | {
      type: "ChangelogAgentBlocked";
      attempts: 2;
      issues: readonly ChangelogSubmissionIssue[];
    }
  | HeadlessSessionError
  | Extract<ChangelogSubmissionError, { type: "ChangelogSubmissionTooLarge" }>;

interface PreparedRun {
  config: IsolatedHeadlessSessionConfig;
  prompt: string;
  context: {
    required: readonly SubmissionIdentityRequirement[];
    refs: ChangelogEvidence;
    versions: ReadonlyMap<PublicPackageName, string>;
  };
  history: ReadonlyMap<PublicPackageName, ChangelogDocument>;
  evidenceDigest: EvidenceDigest;
  apiKey: string;
}

/**
 * Runs the changelog agent. Expected failures are typed; the API key value
 * is never returned on either side of the result.
 */
export function runChangelogAgent(
  input: ChangelogAgentInput,
): ResultAsync<ChangelogAgentResult, ChangelogAgentError> {
  const prepared = prepareRun(input);
  if (prepared.isErr()) return errAsync(prepared.error);
  return input.driver
    .open(prepared.value.config)
    .andThen((session) =>
      finishSession(
        runAttempts(session, prepared.value),
        session,
        prepared.value.apiKey,
      ),
    )
    .mapErr((error) => scrubSecret(error, prepared.value.apiKey));
}

function finishSession(
  result: ResultAsync<ChangelogAgentResult, ChangelogAgentError>,
  session: HeadlessSession,
  apiKey: string,
): ResultAsync<ChangelogAgentResult, ChangelogAgentError> {
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
): ResultAsync<ChangelogAgentResult, ChangelogAgentError> {
  return session.prompt(prepared.prompt).andThen((first) => {
    const firstCheck = acceptSubmission(first, prepared, prepared.apiKey);
    if (firstCheck.isOk())
      return renderResult(prepared, session.config, firstCheck.value, 1);
    if (firstCheck.error.type === "ChangelogSubmissionTooLarge")
      return errAsync(firstCheck.error);
    const retryPrompt = appendRetryErrors(
      prepared.prompt,
      firstCheck.error.issues,
    );
    if (retryPrompt.isErr()) return errAsync(retryPrompt.error);
    return session.prompt(retryPrompt.value).andThen((second) => {
      const secondCheck = acceptSubmission(second, prepared, prepared.apiKey);
      if (secondCheck.isOk())
        return renderResult(prepared, session.config, secondCheck.value, 2);
      if (secondCheck.error.type === "ChangelogSubmissionTooLarge")
        return errAsync(secondCheck.error);
      return errAsync(changelogAgentBlocked(secondCheck.error.issues));
    });
  });
}

function changelogAgentBlocked(
  issues: readonly ChangelogSubmissionIssue[],
): Extract<ChangelogAgentError, { type: "ChangelogAgentBlocked" }> {
  return {
    type: "ChangelogAgentBlocked",
    attempts: CHANGELOG_AGENT_LIMITS.attempts,
    issues,
  };
}

function acceptSubmission(
  submission: { toolName: string; input: unknown },
  prepared: PreparedRun,
  apiKey: string,
): Result<
  {
    submission: ChangelogSubmission;
    versions: readonly ChangelogVersionDocument[];
  },
  Extract<
    ChangelogSubmissionError,
    { type: "InvalidChangelogSubmission" | "ChangelogSubmissionTooLarge" }
  >
> {
  if (submission.toolName !== SUBMIT_CHANGELOG_TOOL)
    return err({
      type: "InvalidChangelogSubmission",
      issues: [{ code: "wrong_tool", path: "toolName" }],
    });
  if (containsSecret(submission.input, apiKey))
    return err({
      type: "InvalidChangelogSubmission",
      issues: [{ code: "secret_in_submission", path: "" }],
    });
  return validateChangelogSubmission(submission.input, prepared.context);
}

function renderResult(
  prepared: PreparedRun,
  session: IsolatedHeadlessSessionConfig,
  validated: {
    submission: ChangelogSubmission;
    versions: readonly ChangelogVersionDocument[];
  },
  attempts: 1 | 2,
): ResultAsync<ChangelogAgentResult, ChangelogAgentError> {
  const changelogs: RenderedPackageChangelog[] = [];
  for (const entry of validated.versions) {
    const history = prepared.history.get(entry.packageName);
    const document: ChangelogDocument = {
      packageName: entry.packageName,
      versions: [entry.version, ...(history?.versions ?? [])],
    };
    const rendered = renderChangelog(document, prepared.context.refs);
    if (rendered.isErr())
      return errAsync({
        type: "InvalidChangelogAgentInput",
        issues: [rendered.error.type],
      });
    changelogs.push({
      packageName: entry.packageName,
      markdown: rendered.value,
    });
  }
  return okAsync({
    promptVersion: CHANGELOG_PROMPT_VERSION,
    model: CHANGELOG_AGENT_MODEL,
    thinking: session.thinking,
    attempts,
    evidenceDigest: prepared.evidenceDigest,
    submission: validated.submission,
    changelogs,
    session,
  });
}

function prepareRun(
  input: ChangelogAgentInput,
): Result<PreparedRun, ChangelogAgentError> {
  const config =
    input.thinking === undefined
      ? createChangelogSessionConfig()
      : createChangelogSessionConfig({ thinking: input.thinking });
  if (config.isErr()) return err(mapSessionConfigError(config.error));
  const versions = readVersions(input);
  if (versions.isErr()) return err(versions.error);
  const required = requiredIdentities(input.evidence.packages);
  if (required.isErr()) return err(required.error);
  const history = readHistory(input.history, versions.value);
  if (history.isErr()) return err(history.error);
  const refs = collectRefs(input.evidence.packages, input.refs);
  const prompt = buildChangelogPrompt({
    evidence: input.evidence,
    versions: versions.value,
    refs,
    required: required.value,
  });
  if (prompt.isErr()) return err(prompt.error);
  const apiKey = process.env[CHANGELOG_AGENT_API_KEY_ENV] ?? "";
  return ok({
    config: config.value,
    prompt: prompt.value,
    context: {
      required: required.value,
      refs,
      versions: versions.value,
    },
    history: history.value,
    evidenceDigest: input.evidence.digest,
    apiKey,
  });
}

function mapSessionConfigError(
  error: HeadlessSessionConfigError,
): ChangelogAgentError {
  switch (error.type) {
    case "InvalidChangelogThinking":
    case "ChangelogApiKeyMissing":
      return error;
    default:
      return {
        type: "InvalidChangelogAgentInput",
        issues: ["session-config"],
      };
  }
}

function readVersions(
  input: ChangelogAgentInput,
): Result<ReadonlyMap<PublicPackageName, string>, ChangelogAgentError> {
  if (
    input.versions.length === 0 ||
    input.versions.length > CHANGELOG_AGENT_LIMITS.versionCount
  )
    return err({
      type: "InvalidChangelogAgentInput",
      issues: ["versions"],
    });
  const versions = new Map<PublicPackageName, string>();
  const evidencePackages = new Set(
    input.evidence.packages.map((entry) => entry.packageName),
  );
  for (const entry of input.versions) {
    const parsed = StableVersionSchema.safeParse(entry.version);
    if (!parsed.success)
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`${entry.packageName}.version`],
      });
    if (versions.has(entry.packageName))
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`${entry.packageName}.duplicate`],
      });
    if (!evidencePackages.has(entry.packageName))
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`${entry.packageName}.extra`],
      });
    versions.set(entry.packageName, parsed.data);
  }
  for (const packageName of evidencePackages)
    if (!versions.has(packageName))
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`${packageName}.missing`],
      });
  return ok(versions);
}

function requiredIdentities(
  packages: readonly PackageEvidence[],
): Result<readonly SubmissionIdentityRequirement[], ChangelogAgentError> {
  const required: SubmissionIdentityRequirement[] = [];
  for (const entry of packages) {
    if (entry.changesets.length === 0)
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`${entry.packageName}.changesets`],
      });
    for (const changeset of entry.changesets)
      required.push({
        packageName: entry.packageName,
        identity: changeset.identity,
      });
  }
  return ok(required);
}

function readHistory(
  history: readonly ChangelogDocument[] | undefined,
  versions: ReadonlyMap<PublicPackageName, string>,
): Result<
  ReadonlyMap<PublicPackageName, ChangelogDocument>,
  ChangelogAgentError
> {
  const documents = new Map<PublicPackageName, ChangelogDocument>();
  for (const document of history ?? []) {
    const parsed = ChangelogDocumentSchema.safeParse(document);
    if (!parsed.success)
      return err({
        type: "InvalidChangelogAgentInput",
        issues: ["history"],
      });
    if (!versions.has(document.packageName))
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`history.${document.packageName}`],
      });
    if (documents.has(document.packageName))
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`history.${document.packageName}.duplicate`],
      });
    const nextVersion = versions.get(document.packageName);
    if (
      nextVersion !== undefined &&
      document.versions.some((entry) => entry.version === nextVersion)
    )
      return err({
        type: "InvalidChangelogAgentInput",
        issues: [`history.${document.packageName}.version`],
      });
    documents.set(document.packageName, document);
  }
  return ok(documents);
}

function collectRefs(
  packages: readonly PackageEvidence[],
  extra: ChangelogEvidence | undefined,
): ChangelogEvidence {
  const pullRequests = new Set<number>(extra?.pullRequests ?? []);
  const commits = new Set<string>(extra?.commits ?? []);
  for (const entry of packages)
    for (const pullRequest of entry.pullRequests)
      pullRequests.add(pullRequest.number);
  return {
    pullRequests: [...pullRequests].sort((left, right) => left - right),
    commits: [...commits].sort(),
  };
}

export interface ChangelogPromptInput {
  evidence: BoundedEvidence;
  versions: ReadonlyMap<PublicPackageName, string>;
  refs: ChangelogEvidence;
  required: readonly SubmissionIdentityRequirement[];
}

/** Builds the versioned controller prompt from Task 16 evidence and Task 7. */
export function buildChangelogPrompt(
  input: ChangelogPromptInput,
): Result<string, ChangelogAgentError> {
  const lines = [
    `CHANGELOG_PROMPT_VERSION ${CHANGELOG_PROMPT_VERSION}`,
    `Model ${CHANGELOG_AGENT_MODEL}`,
    "Write user-impact changelog prose for this Weave stable release.",
    "You have no repository, shell, read, write, or edit tools.",
    `Submit exactly once with the ${SUBMIT_CHANGELOG_TOOL} tool.`,
    "Task 7 contract:",
    "- Sections, only when non-empty, in this order: Breaking Changes, Added, Changed, Fixed, Deprecated, Security",
    "- One-line user-impact prose; no dates; no HTML comments",
    "- sourceChangesets use complete identities {id, sourceDigest} from evidence",
    "- Every consumed identity appears at least once",
    "- Cite only supplied pull-request and commit refs",
    "- Do not invent packages, versions, identities, or refs",
    "Packages and versions:",
    ...versionLines(input.versions),
    "Consumed identities:",
    ...identityLines(input.required),
    "Supplied refs:",
    ...refLines(input.refs),
    "Evidence:",
    canonicalJson({
      schemaVersion: input.evidence.schemaVersion,
      digest: input.evidence.digest,
      packages: input.evidence.packages,
    }),
  ];
  const prompt = `${lines.join("\n")}\n`;
  const bytes = utf8ByteLength(prompt);
  if (bytes > CHANGELOG_AGENT_LIMITS.promptBytes)
    return err({
      type: "ChangelogPromptOverflow",
      bytes,
      limit: CHANGELOG_AGENT_LIMITS.promptBytes,
    });
  return ok(prompt);
}

function versionLines(
  versions: ReadonlyMap<PublicPackageName, string>,
): readonly string[] {
  return publishablePackageNames()
    .filter((packageName) => versions.has(packageName))
    .map((packageName) => `- ${packageName} ${versions.get(packageName)}`);
}

function identityLines(
  required: readonly SubmissionIdentityRequirement[],
): readonly string[] {
  return required.map(
    (item) =>
      `- ${item.packageName} ${item.identity.id} ${item.identity.sourceDigest}`,
  );
}

function refLines(refs: ChangelogEvidence): readonly string[] {
  const lines: string[] = [];
  for (const number of refs.pullRequests ?? []) lines.push(`- #${number}`);
  for (const commit of refs.commits ?? []) lines.push(`- ${commit}`);
  if (lines.length === 0) lines.push("- none");
  return lines;
}

function appendRetryErrors(
  prompt: string,
  issues: readonly ChangelogSubmissionIssue[],
): Result<string, ChangelogAgentError> {
  const block = [
    "Previous submission was rejected. Fix these issues and submit again with submit_changelog.",
    ...issues.map((issue) => `- ${issue.code} ${issue.path}`),
  ].join("\n");
  const bounded =
    utf8ByteLength(block) > CHANGELOG_AGENT_LIMITS.retryErrorBytes
      ? `${block.slice(0, CHANGELOG_AGENT_LIMITS.retryErrorBytes)}\n`
      : `${block}\n`;
  const retry = `${prompt}\n${bounded}`;
  const limit =
    CHANGELOG_AGENT_LIMITS.promptBytes + CHANGELOG_AGENT_LIMITS.retryErrorBytes;
  const bytes = utf8ByteLength(retry);
  if (bytes > limit)
    return err({
      type: "ChangelogPromptOverflow",
      bytes,
      limit,
    });
  return ok(retry);
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
