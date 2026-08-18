/**
 * Isolated headless Pi session contract for release AI agents.
 *
 * The changelog agent (Task 17) and the docs agent (Task 19) share this port
 * so a session cannot discover host skills, extensions, templates, themes, or
 * global settings, and so tests inject a fake driver instead of a live model.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { SUBMIT_CHANGELOG_TOOL } from "./submission-schema.js";

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

export interface IsolatedHeadlessDiscovery {
  readonly skills: false;
  readonly extensions: false;
  readonly templates: false;
  readonly themes: false;
  readonly globalSettings: false;
}

export interface IsolatedHeadlessTools {
  readonly allowlist: readonly [typeof SUBMIT_CHANGELOG_TOOL];
  readonly noTools: "all";
  readonly forbidden: typeof FORBIDDEN_HEADLESS_TOOLS;
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
}

/** Pi SDK options derived from {@link IsolatedHeadlessSessionConfig}. */
export interface IsolatedPiSessionOptions {
  readonly model: typeof CHANGELOG_AGENT_MODEL;
  readonly thinkingLevel: HeadlessThinkingLevel;
  readonly noTools: "all";
  readonly tools: readonly [typeof SUBMIT_CHANGELOG_TOOL];
  readonly customTools: readonly [typeof SUBMIT_CHANGELOG_TOOL];
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
  | { type: "ChangelogApiKeyMissing"; env: typeof CHANGELOG_AGENT_API_KEY_ENV };

export interface CreateSessionConfigInput {
  thinking?: string;
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

/** Maps the isolated config onto the Pi SDK option shape tests assert. */
export function toPiCreateAgentSessionOptions(
  config: IsolatedHeadlessSessionConfig,
): IsolatedPiSessionOptions {
  return {
    model: config.model,
    thinkingLevel: config.thinking,
    noTools: "all",
    tools: [SUBMIT_CHANGELOG_TOOL],
    customTools: [SUBMIT_CHANGELOG_TOOL],
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
