/**
 * OpenRouter inference client for `weave eval run`.
 *
 * Provides a narrow, injectable interface (`ModelClient`) that eval runners
 * use to send chat completion requests. The concrete implementation
 * (`OpenRouterClient`) targets the OpenRouter API at
 * `https://openrouter.ai/api/v1/chat/completions` using the global `fetch`
 * (Bun-native, no Node HTTP imports required).
 *
 * Transport concerns (headers, retries, error normalization) are fully
 * isolated inside `OpenRouterClient`. Runners and scoring logic only see the
 * `ModelClient` interface and `ModelResponse` / `ModelClientError` types.
 * Tests substitute `StubModelClient` (exported from this module) to exercise
 * runner logic without any real network calls.
 *
 * # OpenRouter API notes
 *
 * Base URL:  https://openrouter.ai/api/v1
 * Endpoint:  POST /chat/completions
 *
 * Required headers:
 *   - Authorization: Bearer <OPENROUTER_API_KEY>
 *   - Content-Type: application/json
 *
 * Recommended headers (used by this client for attribution / ranking):
 *   - HTTP-Referer: https://github.com/weave-ai/weave   (site URL)
 *   - X-Title: Weave Eval                               (app name shown in rankings)
 *
 * The request body follows the OpenAI Chat Completions schema.
 * See https://openrouter.ai/docs for the full reference.
 *
 * # Security
 *
 * The `apiKey` field of `EvalEnv` is a secret and must NEVER appear in logs,
 * error messages, or serialized output. This module places it only in the
 * `Authorization` header and never reads it back.
 */

import { err, ok, ResultAsync } from "neverthrow";
import type { EvalEnv } from "./env.js";

// ---------------------------------------------------------------------------
// Chat message types (OpenAI-compatible)
// ---------------------------------------------------------------------------

/**
 * A single message in a chat completion request.
 * Follows the OpenAI / OpenRouter chat message schema.
 */
export interface ChatMessage {
  /** The role of the message author. */
  role: "system" | "user" | "assistant";
  /** The message content (plain text). */
  content: string;
}

// ---------------------------------------------------------------------------
// Model client request / response types
// ---------------------------------------------------------------------------

/**
 * A chat completion request sent to a model.
 *
 * All fields are optional beyond `messages` so callers can start with minimal
 * configuration and the client applies sensible defaults.
 */
export interface ModelRequest {
  /** The model identifier (e.g. `"anthropic/claude-sonnet-4.5"`). */
  model: string;
  /** The ordered list of messages forming the conversation. */
  messages: ChatMessage[];
  /**
   * Maximum number of tokens to generate in the response.
   * Defaults to `2048` when omitted.
   */
  maxTokens?: number;
  /**
   * Sampling temperature (0.0–2.0). Lower values are more deterministic.
   * Defaults to `0.2` when omitted — appropriate for structured eval tasks.
   */
  temperature?: number;
}

/**
 * The normalized response from a successful model completion call.
 *
 * Only the fields relevant to eval runners are surfaced here.
 * Raw provider response fields are not forwarded to keep the interface stable
 * across model providers.
 */
export interface ModelResponse {
  /** The model identifier echoed from the provider response. */
  model: string;
  /** The text content of the first (and usually only) choice. */
  content: string;
  /**
   * Token usage reported by the provider.
   * Present when the provider returns it; `undefined` otherwise.
   */
  usage?: {
    /** Tokens in the input prompt. */
    promptTokens: number;
    /** Tokens in the generated completion. */
    completionTokens: number;
    /** Total tokens (prompt + completion). */
    totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Typed errors returned by `ModelClient.complete()`.
 *
 * All variants carry a human-readable `message`. None of them include the
 * `apiKey` value.
 */
export type ModelClientError =
  | {
      type: "NetworkError";
      /** Human-readable description of the network failure. */
      message: string;
      /** The underlying error, if available. */
      cause?: unknown;
    }
  | {
      type: "HttpError";
      /** HTTP status code returned by the provider. */
      statusCode: number;
      /** Human-readable description. */
      message: string;
      /** Raw response body, if available. Never contains the API key. */
      body?: string;
    }
  | {
      type: "ParseError";
      /** Human-readable description of the parse failure. */
      message: string;
    }
  | {
      type: "EmptyResponse";
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * Returned by `StubModelClient` when a `complete()` call is made but
       * no response has been configured (neither queued nor a default set).
       *
       * This is a programming error in the test setup — the variant exists so
       * tests can assert on a typed error rather than catching a thrown
       * exception. Use `enqueueResponse()`, `enqueueError()`,
       * `setDefaultResponse()`, or `setDefaultError()` to configure the stub.
       */
      type: "NotConfigured";
      /** Zero-based index of the call that was not configured. */
      callIndex: number;
      /** Human-readable description. */
      message: string;
    };

// ---------------------------------------------------------------------------
// ModelClient interface
// ---------------------------------------------------------------------------

/**
 * Narrow interface for sending a chat completion request to a model.
 *
 * Eval runners depend on this interface — not on `OpenRouterClient` directly.
 * Tests provide `StubModelClient` to exercise runner logic without network.
 */
export interface ModelClient {
  /**
   * Send a chat completion request and return the normalized response.
   *
   * @param request - The chat completion request parameters.
   * @returns `ResultAsync<ModelResponse, ModelClientError>`.
   */
  complete(request: ModelRequest): ResultAsync<ModelResponse, ModelClientError>;
}

// ---------------------------------------------------------------------------
// OpenRouter API response shape (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the OpenRouter chat completion response body.
 * Only fields consumed by this client are typed; extras are ignored.
 */
interface OpenRouterChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: number | string;
  };
}

// ---------------------------------------------------------------------------
// OpenRouter client implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `ModelClient` that targets the OpenRouter Chat Completions API.
 *
 * Uses the global `fetch` (Bun-native). No Node HTTP libraries.
 *
 * ## Usage
 *
 * ```ts
 * const envResult = readEvalEnv();
 * if (envResult.isErr()) { return; } // handle error
 * const client = new OpenRouterClient(envResult.value);
 * const result = await client.complete({ model: "anthropic/claude-sonnet-4.5", messages: [...] });
 * ```
 *
 * ## Security
 *
 * The API key from `EvalEnv.apiKey` is placed only in the `Authorization`
 * header and is never logged, stored, or included in error messages.
 */
export class OpenRouterClient implements ModelClient {
  /** @internal */
  private readonly apiKey: string;
  /** @internal */
  private readonly baseUrl: string;
  /** @internal */
  private readonly completionsUrl: string;

  constructor(env: EvalEnv) {
    this.apiKey = env.apiKey;
    this.baseUrl = env.baseUrl;
    this.completionsUrl = `${this.baseUrl}/chat/completions`;
  }

  complete(
    request: ModelRequest,
  ): ResultAsync<ModelResponse, ModelClientError> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.2,
    });

    // Build headers. The API key is placed here and nowhere else.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // Attribution headers per OpenRouter docs. These are recommended (not
      // required) and help identify traffic in the OpenRouter dashboard.
      "HTTP-Referer": "https://github.com/weave-ai/weave",
      "X-Title": "Weave Eval",
    };

    const fetchResult = ResultAsync.fromPromise(
      fetch(this.completionsUrl, {
        method: "POST",
        headers,
        body,
      }),
      (cause): ModelClientError => ({
        type: "NetworkError",
        message: `Network request to OpenRouter failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
    );

    return fetchResult.andThen((response) => {
      if (!response.ok) {
        return ResultAsync.fromPromise(
          response.text().catch((): string => "(unreadable)"),
          (cause): ModelClientError => ({
            type: "NetworkError",
            message: `Failed to read error response body: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        ).andThen((body): ResultAsync<ModelResponse, ModelClientError> => {
          return new ResultAsync(
            Promise.resolve(
              err<ModelResponse, ModelClientError>({
                type: "HttpError",
                statusCode: response.status,
                message: `OpenRouter returned HTTP ${response.status}: ${response.statusText}`,
                body: body.slice(0, 512), // cap body to avoid leaking secrets in verbose bodies
              }),
            ),
          );
        });
      }

      return ResultAsync.fromPromise(
        response.json() as Promise<OpenRouterChatCompletionResponse>,
        (cause): ModelClientError => ({
          type: "ParseError",
          message: `Failed to parse OpenRouter response as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      ).andThen((data): ResultAsync<ModelResponse, ModelClientError> => {
        // OpenRouter may embed an error object inside a 200 response
        if (data.error !== undefined) {
          return new ResultAsync(
            Promise.resolve(
              err<ModelResponse, ModelClientError>({
                type: "HttpError",
                statusCode:
                  typeof data.error.code === "number" ? data.error.code : 0,
                message: `OpenRouter error: ${data.error.message ?? "unknown error"}`,
              }),
            ),
          );
        }

        const content = data.choices?.[0]?.message?.content;
        if (content === undefined || content === null || content === "") {
          return new ResultAsync(
            Promise.resolve(
              err<ModelResponse, ModelClientError>({
                type: "EmptyResponse",
                message:
                  "OpenRouter returned a response with no content in choices[0].message.content",
              }),
            ),
          );
        }

        const modelId = data.model ?? request.model;

        const usage =
          data.usage !== undefined
            ? {
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
                totalTokens: data.usage.total_tokens ?? 0,
              }
            : undefined;

        return new ResultAsync(
          Promise.resolve(
            ok<ModelResponse, ModelClientError>({
              model: modelId,
              content,
              usage,
            }),
          ),
        );
      });
    });
  }
}

// ---------------------------------------------------------------------------
// StubModelClient — test double for runners
// ---------------------------------------------------------------------------

/**
 * A configurable `ModelClient` stub for use in tests.
 *
 * Allows tests to specify per-call responses (or errors) without any real
 * network calls. Responses are consumed in FIFO order; after the queue is
 * exhausted, subsequent calls return the `defaultResponse` (or a typed
 * `NotConfigured` error if neither a default response nor a default error
 * has been set — this signals a test setup mistake without throwing).
 *
 * ## Usage in tests
 *
 * ```ts
 * const stub = new StubModelClient();
 * stub.enqueueResponse({ model: "anthropic/claude-sonnet-4.5", content: "Answer" });
 * stub.enqueueError({ type: "NetworkError", message: "simulated failure" });
 *
 * const result = await stub.complete({ model: "anthropic/claude-sonnet-4.5", messages: [] });
 * expect(result.isOk()).toBe(true);
 * expect(stub.calls).toHaveLength(1);
 * ```
 */
export class StubModelClient implements ModelClient {
  /**
   * Ordered record of all `complete()` calls received.
   * Inspect in tests to assert call count and request payloads.
   */
  readonly calls: ModelRequest[] = [];

  /** @internal */
  private readonly queue: Array<
    | { ok: true; response: ModelResponse }
    | { ok: false; error: ModelClientError }
  > = [];

  /** @internal */
  private defaultEntry:
    | { ok: true; response: ModelResponse }
    | { ok: false; error: ModelClientError }
    | undefined = undefined;

  /**
   * Enqueue a successful response. Consumed on the next `complete()` call.
   */
  enqueueResponse(response: ModelResponse): void {
    this.queue.push({ ok: true, response });
  }

  /**
   * Enqueue an error result. Consumed on the next `complete()` call.
   */
  enqueueError(error: ModelClientError): void {
    this.queue.push({ ok: false, error });
  }

  /**
   * Set the default response used when the queue is exhausted.
   * If not set and the queue is empty, `complete()` returns a typed
   * `NotConfigured` error — it never throws.
   */
  setDefaultResponse(response: ModelResponse): void {
    this.defaultEntry = { ok: true, response };
  }

  /**
   * Set the default error used when the queue is exhausted.
   */
  setDefaultError(error: ModelClientError): void {
    this.defaultEntry = { ok: false, error };
  }

  complete(
    request: ModelRequest,
  ): ResultAsync<ModelResponse, ModelClientError> {
    this.calls.push(request);

    const entry = this.queue.shift() ?? this.defaultEntry;

    if (entry === undefined) {
      // No response configured for this call. Return a typed error rather than
      // throwing so callers using neverthrow never encounter an uncaught exception.
      const callIndex = this.calls.length - 1;
      return new ResultAsync(
        Promise.resolve(
          err<ModelResponse, ModelClientError>({
            type: "NotConfigured",
            callIndex,
            message:
              `StubModelClient: no response configured for call ${callIndex + 1}. ` +
              `Use enqueueResponse() / enqueueError() or setDefaultResponse() / setDefaultError().`,
          }),
        ),
      );
    }

    if (entry.ok) {
      return new ResultAsync(Promise.resolve(ok(entry.response)));
    }
    return new ResultAsync(Promise.resolve(err(entry.error)));
  }
}
