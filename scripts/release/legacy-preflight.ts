import {
  LEGACY_PREFLIGHT_RUN_NAME,
  RELEASE_CONTROL_REF,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
} from "./constants.js";

export { LEGACY_PREFLIGHT_RUN_NAME };

const PROTECTED_REF = RELEASE_CONTROL_REF;
const REQUIRED_MAIN_CHECK = "Lint, Typecheck, Build & Test" as const;
const MAX_RESPONSE_BYTES = 256 * 1024;
const GITHUB_API_ORIGIN = "https://api.github.com";

export interface LegacyPublisherPreflightSuccess {
  readonly type: "LegacyPublisherPreflightPassed";
  readonly repository: typeof RELEASE_REPOSITORY;
  readonly workflowPath: typeof RELEASE_WORKFLOW_PATH;
  readonly event: "workflow_dispatch";
  readonly operation: "preflight";
  readonly ref: typeof PROTECTED_REF;
  readonly subjectSha: string;
  readonly publicationEnabled: true;
  readonly readOnly: true;
  readonly sideEffects: "none";
}

export interface LegacyPublisherPreflightFailure {
  readonly type: "LegacyPublisherPreflightFailed";
  readonly reason: string;
}

export type LegacyPublisherPreflightResult =
  | { readonly ok: true; readonly value: LegacyPublisherPreflightSuccess }
  | {
      readonly ok: false;
      readonly error: LegacyPublisherPreflightFailure;
    };

export interface LegacyPublisherPreflightEnvironment
  extends Readonly<Record<string, string | undefined>> {
  readonly GITHUB_TOKEN?: string;
  readonly RELEASE_REPOSITORY?: string;
  readonly RELEASE_WORKFLOW_PATH?: string;
  readonly RELEASE_EVENT_NAME?: string;
  readonly RELEASE_OPERATION?: string;
  readonly RELEASE_REF?: string;
  readonly RELEASE_SHA?: string;
  readonly RELEASE_WORKFLOW_REF?: string;
  readonly RELEASE_PUBLISH_ENABLED?: string;
  readonly GITHUB_OUTPUT?: string;
  readonly GITHUB_STEP_SUMMARY?: string;
}

export type LegacyPublisherPreflightFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type JsonReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Proves that the retained publisher is enabled without installing any
 * dependency, reading npm, minting credentials, or writing repository state.
 * The standalone shape is intentional: this path must run before `bun install`
 * so a preflight cannot contact the npm registry.
 */
export async function runLegacyPublisherPreflight(
  environment: LegacyPublisherPreflightEnvironment = Bun.env,
  requestFetch: LegacyPublisherPreflightFetch = fetch,
): Promise<LegacyPublisherPreflightResult> {
  const identityFailure = validateIdentity(environment);
  if (identityFailure !== undefined) return failure(identityFailure);
  if (environment.RELEASE_PUBLISH_ENABLED !== "true")
    return failure("RELEASE_PUBLISH_ENABLED must be exactly true");

  const token = environment.GITHUB_TOKEN;
  if (token === undefined || token.length === 0)
    return failure("GITHUB_TOKEN is required for the read-only GitHub checks");

  const subjectSha = environment.RELEASE_SHA;
  if (subjectSha === undefined || !/^[0-9a-f]{40}$/.test(subjectSha))
    return failure("RELEASE_SHA must be a full lowercase commit SHA");

  const mainResponse = await readJson(
    requestFetch,
    `${GITHUB_API_ORIGIN}/repos/${RELEASE_REPOSITORY}/git/ref/heads/main`,
    token,
  );
  if (!mainResponse.ok) return failure(mainResponse.reason);
  const mainSha = mainRefSha(mainResponse.value);
  if (mainSha === undefined)
    return failure(
      "GitHub main ref response is not an exact protected-main commit ref",
    );
  if (mainSha !== subjectSha)
    return failure("workflow SHA is stale relative to protected main");

  const checksResponse = await readJson(
    requestFetch,
    `${GITHUB_API_ORIGIN}/repos/${RELEASE_REPOSITORY}/commits/${mainSha}/check-runs?per_page=100`,
    token,
  );
  if (!checksResponse.ok) return failure(checksResponse.reason);
  if (!hasGreenRequiredCheck(checksResponse.value))
    return failure(`protected main check ${REQUIRED_MAIN_CHECK} is not green`);

  const value: LegacyPublisherPreflightSuccess = {
    type: "LegacyPublisherPreflightPassed",
    repository: RELEASE_REPOSITORY,
    workflowPath: RELEASE_WORKFLOW_PATH,
    event: "workflow_dispatch",
    operation: "preflight",
    ref: PROTECTED_REF,
    subjectSha,
    publicationEnabled: true,
    readOnly: true,
    sideEffects: "none",
  };
  const output = await writeOutputs(environment, value);
  if (!output) return failure("unable to write the read-only preflight result");
  return { ok: true, value };
}

function validateIdentity(
  environment: LegacyPublisherPreflightEnvironment,
): string | undefined {
  if (environment.RELEASE_REPOSITORY !== RELEASE_REPOSITORY)
    return "workflow repository is not weave-io/weave";
  if (environment.RELEASE_WORKFLOW_PATH !== RELEASE_WORKFLOW_PATH)
    return "workflow path is not the retained publish.yml workflow";
  if (environment.RELEASE_EVENT_NAME !== "workflow_dispatch")
    return "preflight requires the workflow_dispatch event";
  if (environment.RELEASE_OPERATION !== "preflight")
    return "preflight requires operation=preflight";
  if (environment.RELEASE_REF !== PROTECTED_REF)
    return "preflight must run from refs/heads/main";
  if (
    environment.RELEASE_WORKFLOW_REF !==
    `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@${PROTECTED_REF}`
  )
    return "workflow source is not the protected-main publish.yml identity";
  return undefined;
}

async function readJson(
  requestFetch: LegacyPublisherPreflightFetch,
  url: string,
  token: string,
): Promise<JsonReadResult> {
  let response: Response;
  try {
    response = await requestFetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "read-only GitHub request failed" };
  }
  if (!response.ok)
    return {
      ok: false,
      reason: `read-only GitHub request returned ${response.status}`,
    };
  const body = await boundedText(response);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.value) as unknown };
  } catch {
    return {
      ok: false,
      reason: "read-only GitHub response was not valid JSON",
    };
  }
}

type TextReadResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

async function boundedText(response: Response): Promise<TextReadResult> {
  if (response.body === null) {
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES)
        return {
          ok: false,
          reason: "read-only GitHub response exceeded its bound",
        };
      return { ok: true, value: text };
    } catch {
      return { ok: false, reason: "unable to read read-only GitHub response" };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          reason: "read-only GitHub response exceeded its bound",
        };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, reason: "unable to read read-only GitHub response" };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: new TextDecoder().decode(bytes) };
}

function mainRefSha(value: unknown): string | undefined {
  const record = asRecord(value);
  const object = asRecord(record?.object);
  if (record?.ref !== PROTECTED_REF || object?.type !== "commit")
    return undefined;
  const sha = object.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)
    ? sha
    : undefined;
}

function hasGreenRequiredCheck(value: unknown): boolean {
  const record = asRecord(value);
  const checks = record?.check_runs;
  if (!Array.isArray(checks) || checks.length > 100) return false;
  return checks.some((check) => {
    const item = asRecord(check);
    return item?.name === REQUIRED_MAIN_CHECK && item.conclusion === "success";
  });
}

async function writeOutputs(
  environment: LegacyPublisherPreflightEnvironment,
  value: LegacyPublisherPreflightSuccess,
): Promise<boolean> {
  const output = [
    "legacy_preflight=passed",
    "legacy_preflight_operation=preflight",
    "legacy_publication_enabled=true",
    "legacy_preflight_read_only=true",
    "legacy_preflight_side_effects=none",
    `legacy_preflight_repository=${value.repository}`,
    `legacy_preflight_workflow=${value.workflowPath}`,
    `legacy_preflight_ref=${value.ref}`,
    `legacy_preflight_sha=${value.subjectSha}`,
  ].join("\n");
  try {
    if (environment.GITHUB_OUTPUT !== undefined)
      await Bun.write(environment.GITHUB_OUTPUT, `${output}\n`);
    if (environment.GITHUB_STEP_SUMMARY !== undefined)
      await Bun.write(
        environment.GITHUB_STEP_SUMMARY,
        [
          "## Legacy publisher read-only preflight",
          "",
          "- Result: `passed`",
          `- Repository: \`${value.repository}\``,
          `- Workflow: \`${value.workflowPath}\``,
          `- Ref: \`${value.ref}\``,
          `- Protected-main SHA: \`${value.subjectSha}\``,
          "- Publication enablement: `true`",
          "- Read-only: `true`",
          "- Side effects: `none`",
          "",
        ].join("\n"),
      );
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function failure(reason: string): LegacyPublisherPreflightResult {
  return {
    ok: false,
    error: { type: "LegacyPublisherPreflightFailed", reason },
  };
}

if (import.meta.main) {
  const result = await runLegacyPublisherPreflight();
  process.exitCode = result.ok ? 0 : 1;
}
