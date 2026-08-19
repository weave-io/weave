/**
 * Isolated headless Pi session contract for release AI agents.
 *
 * The changelog agent (Task 17) and the docs agent (Task 19) share this port
 * so a session cannot discover host skills, extensions, templates, themes, or
 * global settings, and so tests inject a fake driver instead of a live model.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { SUBMIT_CHANGELOG_TOOL } from "./submission-schema.js";

/** Typed docs-audit submission tool. Read-only repo tools may join it. */
export const SUBMIT_DOCS_AUDIT_TOOL = "submit_docs_audit" as const;

/** Exact changelog model. Thinking is configurable; this model is not. */
export const CHANGELOG_AGENT_MODEL = "opencode-go/gpt-5.6-luna" as const;
export const CHANGELOG_AGENT_PROVIDER = "opencode-go" as const;
export const CHANGELOG_AGENT_MODEL_ID = "gpt-5.6-luna" as const;

/** Env name the AI job injects. The value never leaves the process env. */
export const CHANGELOG_AGENT_API_KEY_ENV = "WEAVE_RELEASE_AI_API_KEY" as const;

export const HEADLESS_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type HeadlessThinkingLevel = (typeof HEADLESS_THINKING_LEVELS)[number];
export const CHANGELOG_AGENT_DEFAULT_THINKING =
  "medium" satisfies HeadlessThinkingLevel;

/** Built-in repo/shell tools the changelog session must never enable. */
export const FORBIDDEN_HEADLESS_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Built-in tools the docs-audit session may expose, plus the submit tool. */
export const DOCS_AUDIT_READONLY_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
] as const;
export type DocsAuditReadonlyTool = (typeof DOCS_AUDIT_READONLY_TOOLS)[number];

/** Built-in tools the docs-audit session must never enable. */
export const DOCS_AUDIT_FORBIDDEN_TOOLS = [
  "bash",
  "edit",
  "write",
] as const;

export const DOCS_AUDIT_TOOL_ALLOWLIST = [
  ...DOCS_AUDIT_READONLY_TOOLS,
  SUBMIT_DOCS_AUDIT_TOOL,
] as const;

export interface IsolatedHeadlessDiscovery {
  readonly skills: false;
  readonly extensions: false;
  readonly templates: false;
  readonly themes: false;
  readonly globalSettings: false;
}

export interface IsolatedHeadlessTools {
  readonly allowlist: readonly string[];
  readonly noTools: "all";
  readonly forbidden: readonly string[];
}

/**
 * Exact session configuration the changelog controller opens.
 *
 * Persistence is in-memory only. Resource discovery is off. The tool
 * allowlist is the typed submission tool and nothing else.
 */
export interface IsolatedHeadlessSessionConfig {
  readonly model: typeof CHANGELOG_AGENT_MODEL;
  readonly provider: typeof CHANGELOG_AGENT_PROVIDER;
  readonly modelId: typeof CHANGELOG_AGENT_MODEL_ID;
  readonly thinking: HeadlessThinkingLevel;
  readonly sessionManager: "in-memory";
  readonly persistSession: false;
  readonly settingsManager: "in-memory";
  readonly discovery: IsolatedHeadlessDiscovery;
  readonly tools: IsolatedHeadlessTools;
  readonly apiKeyEnv: typeof CHANGELOG_AGENT_API_KEY_ENV;
  readonly apiKeyPresent: true;
  /** Docs-audit sessions only: the caller-supplied read-only content root. */
  readonly contentRoot?: string;
}

/** Pi SDK options derived from {@link IsolatedHeadlessSessionConfig}. */
export interface IsolatedPiSessionOptions {
  readonly model: typeof CHANGELOG_AGENT_MODEL;
  readonly thinkingLevel: HeadlessThinkingLevel;
  readonly noTools: "all";
  readonly tools: readonly string[];
  readonly customTools: readonly string[];
  readonly sessionManager: "in-memory";
  readonly settingsManager: "in-memory";
  readonly persistSession: false;
  readonly loadGlobalSettings: false;
  readonly resourceLoader: {
    readonly extensions: readonly [];
    readonly skills: readonly [];
    readonly prompts: readonly [];
    readonly themes: readonly [];
    readonly agentsFiles: readonly [];
  };
}

export interface HeadlessToolSubmission {
  readonly toolName: string;
  readonly input: unknown;
}

export type HeadlessSessionError = {
  type: "HeadlessSessionFailed";
  reason: string;
};

export interface HeadlessSession {
  readonly config: IsolatedHeadlessSessionConfig;
  prompt(
    text: string,
  ): ResultAsync<HeadlessToolSubmission, HeadlessSessionError>;
  dispose(): void;
}

export interface HeadlessSessionDriver {
  open(
    config: IsolatedHeadlessSessionConfig,
  ): ResultAsync<HeadlessSession, HeadlessSessionError>;
}

export type HeadlessSessionConfigError =
  | { type: "InvalidChangelogThinking"; thinking: string }
  | { type: "ChangelogApiKeyMissing"; env: typeof CHANGELOG_AGENT_API_KEY_ENV }
  | { type: "InvalidDocsAuditThinking"; thinking: string }
  | { type: "DocsAuditApiKeyMissing"; env: typeof CHANGELOG_AGENT_API_KEY_ENV };

export interface CreateSessionConfigInput {
  thinking?: string;
}

export interface CreateDocsAuditSessionConfigInput {
  thinking?: string;
  contentRoot: string;
}

/**
 * Builds the isolated session config after checking thinking and the API key
 * env name. The key value is never copied onto the config.
 */
export function createChangelogSessionConfig(
  input: CreateSessionConfigInput = {},
): Result<IsolatedHeadlessSessionConfig, HeadlessSessionConfigError> {
  const thinking = input.thinking ?? CHANGELOG_AGENT_DEFAULT_THINKING;
  if (!isThinkingLevel(thinking))
    return err({ type: "InvalidChangelogThinking", thinking });
  if (!hasApiKey(CHANGELOG_AGENT_API_KEY_ENV))
    return err({
      type: "ChangelogApiKeyMissing",
      env: CHANGELOG_AGENT_API_KEY_ENV,
    });
  return ok({
    model: CHANGELOG_AGENT_MODEL,
    provider: CHANGELOG_AGENT_PROVIDER,
    modelId: CHANGELOG_AGENT_MODEL_ID,
    thinking,
    sessionManager: "in-memory",
    persistSession: false,
    settingsManager: "in-memory",
    discovery: {
      skills: false,
      extensions: false,
      templates: false,
      themes: false,
      globalSettings: false,
    },
    tools: {
      allowlist: [SUBMIT_CHANGELOG_TOOL],
      noTools: "all",
      forbidden: FORBIDDEN_HEADLESS_TOOLS,
    },
    apiKeyEnv: CHANGELOG_AGENT_API_KEY_ENV,
    apiKeyPresent: true,
  });
}

/**
 * Builds the isolated docs-audit session config. Read-only tools plus one
 * typed submit tool; bash/edit/write stay forbidden. The key value is never
 * copied onto the config.
 */
export function createDocsAuditSessionConfig(
  input: CreateDocsAuditSessionConfigInput,
): Result<IsolatedHeadlessSessionConfig, HeadlessSessionConfigError> {
  const thinking = input.thinking ?? CHANGELOG_AGENT_DEFAULT_THINKING;
  if (!isThinkingLevel(thinking))
    return err({ type: "InvalidDocsAuditThinking", thinking });
  if (!hasApiKey(CHANGELOG_AGENT_API_KEY_ENV))
    return err({
      type: "DocsAuditApiKeyMissing",
      env: CHANGELOG_AGENT_API_KEY_ENV,
    });
  return ok({
    model: CHANGELOG_AGENT_MODEL,
    provider: CHANGELOG_AGENT_PROVIDER,
    modelId: CHANGELOG_AGENT_MODEL_ID,
    thinking,
    sessionManager: "in-memory",
    persistSession: false,
    settingsManager: "in-memory",
    discovery: {
      skills: false,
      extensions: false,
      templates: false,
      themes: false,
      globalSettings: false,
    },
    tools: {
      allowlist: [...DOCS_AUDIT_TOOL_ALLOWLIST],
      noTools: "all",
      forbidden: [...DOCS_AUDIT_FORBIDDEN_TOOLS],
    },
    apiKeyEnv: CHANGELOG_AGENT_API_KEY_ENV,
    apiKeyPresent: true,
    contentRoot: input.contentRoot,
  });
}

/** Maps the isolated config onto the Pi SDK option shape tests assert. */
export function toPiCreateAgentSessionOptions(
  config: IsolatedHeadlessSessionConfig,
): IsolatedPiSessionOptions {
  return {
    model: config.model,
    thinkingLevel: config.thinking,
    noTools: "all",
    tools: [...config.tools.allowlist],
    customTools: [...config.tools.allowlist],
    sessionManager: "in-memory",
    settingsManager: "in-memory",
    persistSession: false,
    loadGlobalSettings: false,
    resourceLoader: {
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      agentsFiles: [],
    },
  };
}

export function isThinkingLevel(value: string): value is HeadlessThinkingLevel {
  return (HEADLESS_THINKING_LEVELS as readonly string[]).includes(value);
}

function hasApiKey(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
}
