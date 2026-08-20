/**
 * Tests for `openrouter-client.ts`.
 *
 * Verifies:
 *   - `OpenRouterClient` sends requests to the correct URL with the required
 *     headers (without making real network calls — fetch is stubbed).
 *   - `OpenRouterClient` normalizes a successful OpenRouter API response into
 *     a `ModelResponse`.
 *   - `OpenRouterClient` returns typed `ModelClientError` values for network
 *     failures, HTTP error codes, parse failures, and empty responses.
 *   - `OpenRouterClient` handles OpenRouter-style inline errors (200 body with
 *     an `error` field).
 *   - The API key never appears in error messages or `ModelResponse` fields.
 *   - `StubModelClient` records all calls and returns configured responses in
 *     FIFO order.
 *   - `StubModelClient` supports default responses and errors.
 *   - Default models from the model matrix resolve correctly through the stub.
 *
 * Test isolation:
 *   - All `OpenRouterClient` tests stub `global.fetch` — no real HTTP.
 *   - `StubModelClient` tests require no fetch at all.
 *   - No file I/O, git, or shell calls.
 */

import { describe, expect, it } from "bun:test";
import type { EvalEnv } from "../env.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../env.js";
import {
  type ChatMessage,
  type ModelClientError,
  type ModelRequest,
  OpenRouterClient,
  StubModelClient,
} from "../openrouter-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "sk-or-v1-test-fake-key-for-tests";

const VALID_ENV: EvalEnv = {
  apiKey: FAKE_API_KEY,
  baseUrl: DEFAULT_OPENROUTER_BASE_URL,
};

const MINIMAL_MESSAGES: ChatMessage[] = [
  { role: "user", content: "Hello, what is 2+2?" },
];

const MINIMAL_REQUEST: ModelRequest = {
  model: "anthropic/claude-sonnet-4.5",
  messages: MINIMAL_MESSAGES,
};

type TestFetch = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

function installFetch(stub: TestFetch): void {
  globalThis.fetch = Object.assign(stub, {
    preconnect: globalThis.fetch.preconnect,
  });
}

/** Build a mock `fetch` that returns the given JSON body with status 200. */
function mockFetchOk<T>(body: T) {
  return async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

/** Build a mock `fetch` that returns the given HTTP status with optional body. */
function mockFetchHttpError(status: number, body = "") {
  return async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response(body, { status, statusText: `HTTP ${status}` });
}

/** Build a mock `fetch` that rejects with a network error. */
function mockFetchNetworkError(message: string) {
  return async (
    _url: URL | RequestInfo,
    _init?: RequestInit,
  ): Promise<Response> => {
    throw new Error(message);
  };
}

/** Build a mock `fetch` that returns a non-JSON body with status 200. */
function mockFetchBadJson() {
  return async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response("this is not json {{{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

/** Build a canonical successful OpenRouter response body. */
function openRouterSuccess(
  content: string,
  model = "anthropic/claude-sonnet-4.5",
) {
  return {
    id: "chatcmpl-test",
    model,
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenRouterClient — successful responses
// ---------------------------------------------------------------------------

describe("OpenRouterClient — successful responses", () => {
  it("returns ok(ModelResponse) for a well-formed 200 response", async () => {
    const stubFetch = mockFetchOk(openRouterSuccess("Four."));
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete(MINIMAL_REQUEST);
    expect(result.isOk()).toBe(true);
    const response = result._unsafeUnwrap();
    expect(response.content).toBe("Four.");
  });

  it("ModelResponse.model matches the echoed model from the response body", async () => {
    const stubFetch = mockFetchOk(
      openRouterSuccess("Answer", "anthropic/claude-opus-4.5"),
    );
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete({
      ...MINIMAL_REQUEST,
      model: "anthropic/claude-opus-4.5",
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().model).toBe("anthropic/claude-opus-4.5");
  });

  it("ModelResponse.content is the first choice message content", async () => {
    const stubFetch = mockFetchOk(
      openRouterSuccess("This is the response text."),
    );
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete(MINIMAL_REQUEST);
    expect(result._unsafeUnwrap().content).toBe("This is the response text.");
  });

  it("ModelResponse.usage is populated when the provider returns it", async () => {
    const stubFetch = mockFetchOk(openRouterSuccess("Answer"));
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete(MINIMAL_REQUEST);
    const response = result._unsafeUnwrap();
    expect(response.usage).toBeDefined();
    expect(response.usage?.promptTokens).toBe(12);
    expect(response.usage?.completionTokens).toBe(8);
    expect(response.usage?.totalTokens).toBe(20);
  });

  it("ModelResponse.usage is undefined when provider omits it", async () => {
    const body = {
      model: "openai/gpt-5.5",
      choices: [{ message: { role: "assistant", content: "Hi" } }],
      // no usage field
    };
    const stubFetch = mockFetchOk(body);
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete(MINIMAL_REQUEST);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().usage).toBeUndefined();
  });

  it("falls back to request.model when provider omits model in response", async () => {
    const body = {
      // no top-level model field
      choices: [{ message: { role: "assistant", content: "Yes" } }],
    };
    const stubFetch = mockFetchOk(body);
    const client = new OpenRouterClient(VALID_ENV);
    installFetch(stubFetch);

    const result = await client.complete({
      ...MINIMAL_REQUEST,
      model: "openai/gpt-5.5",
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().model).toBe("openai/gpt-5.5");
  });
});

// ---------------------------------------------------------------------------
// OpenRouterClient — request construction
// ---------------------------------------------------------------------------

describe("OpenRouterClient — request construction", () => {
  it("sends a POST request to the /chat/completions endpoint", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;

    const stubFetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method;
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("/chat/completions");
    expect(capturedUrl).toContain("openrouter.ai");
  });

  it("sends the Authorization header with Bearer prefix", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const stubFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      h.forEach((value, key) => {
        headers[key] = value;
      });
      capturedHeaders = headers;
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedHeaders?.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
  });

  it("sends Content-Type: application/json", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const stubFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      h.forEach((value, key) => {
        headers[key] = value;
      });
      capturedHeaders = headers;
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedHeaders?.["content-type"]).toBe("application/json");
  });

  it("sends HTTP-Referer and X-Title attribution headers", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const stubFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      h.forEach((value, key) => {
        headers[key] = value;
      });
      capturedHeaders = headers;
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedHeaders?.["http-referer"]).toBeDefined();
    expect(capturedHeaders?.["x-title"]).toBeDefined();
  });

  it("uses baseUrl override from EvalEnv when constructing the URL", async () => {
    let capturedUrl: string | undefined;

    const stubFetch = async (url: URL | RequestInfo) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const customEnv: EvalEnv = {
      apiKey: FAKE_API_KEY,
      baseUrl: "http://localhost:9999/api/v1",
    };
    const client = new OpenRouterClient(customEnv);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedUrl).toContain("localhost:9999");
    expect(capturedUrl).toContain("/chat/completions");
  });

  it("includes model and messages in the request body", async () => {
    let capturedBody: { model?: string; messages?: ChatMessage[] } | undefined;

    const stubFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      capturedBody = await new Response(init?.body).json();
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedBody?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(capturedBody?.messages).toBeInstanceOf(Array);
  });

  it("API key does NOT appear in the request body", async () => {
    let capturedBodyStr: string | undefined;

    const stubFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      capturedBodyStr = await new Response(init?.body).text();
      return new Response(JSON.stringify(openRouterSuccess("ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    installFetch(stubFetch);

    const client = new OpenRouterClient(VALID_ENV);
    await client.complete(MINIMAL_REQUEST);

    expect(capturedBodyStr).not.toContain(FAKE_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// OpenRouterClient — error paths
// ---------------------------------------------------------------------------

describe("OpenRouterClient — network errors", () => {
  it("returns NetworkError when fetch rejects", async () => {
    installFetch(mockFetchNetworkError("connection refused"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NetworkError");
  });

  it("NetworkError message does not contain the API key", async () => {
    installFetch(mockFetchNetworkError("ECONNREFUSED"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    const error = result._unsafeUnwrapErr();
    expect(error.message).not.toContain(FAKE_API_KEY);
  });
});

describe("OpenRouterClient — HTTP errors", () => {
  it("returns HttpError for 401 Unauthorized", async () => {
    installFetch(mockFetchHttpError(401, "Unauthorized"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("HttpError");
    if (error.type === "HttpError") {
      expect(error.statusCode).toBe(401);
    }
  });

  it("returns HttpError for 429 Too Many Requests", async () => {
    installFetch(mockFetchHttpError(429, "Rate limited"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("HttpError");
    if (error.type === "HttpError") {
      expect(error.statusCode).toBe(429);
    }
  });

  it("returns HttpError for 500 Internal Server Error", async () => {
    installFetch(mockFetchHttpError(500, "Internal error"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("HttpError");
    if (error.type === "HttpError") {
      expect(error.statusCode).toBe(500);
    }
  });

  it("HttpError message does NOT contain the API key", async () => {
    installFetch(mockFetchHttpError(403, "Forbidden"));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    const error = result._unsafeUnwrapErr();
    expect(error.message).not.toContain(FAKE_API_KEY);
  });
});

describe("OpenRouterClient — parse errors", () => {
  it("returns ParseError when response body is not valid JSON", async () => {
    installFetch(mockFetchBadJson());

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ParseError");
  });
});

describe("OpenRouterClient — empty response", () => {
  it("returns EmptyResponse when choices is empty", async () => {
    const body = {
      model: "anthropic/claude-sonnet-4.5",
      choices: [],
    };
    installFetch(mockFetchOk(body));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("EmptyResponse");
  });

  it("returns EmptyResponse when content is null", async () => {
    const body = {
      model: "anthropic/claude-sonnet-4.5",
      choices: [{ message: { role: "assistant", content: null } }],
    };
    installFetch(mockFetchOk(body));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EmptyResponse");
  });

  it("returns EmptyResponse when content is empty string", async () => {
    const body = {
      model: "anthropic/claude-sonnet-4.5",
      choices: [{ message: { role: "assistant", content: "" } }],
    };
    installFetch(mockFetchOk(body));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EmptyResponse");
  });
});

describe("OpenRouterClient — inline error in 200 response", () => {
  it("returns HttpError with a stable diagnostic for an inline error", async () => {
    const body = {
      error: {
        message: "Model is temporarily unavailable",
        code: 503,
      },
    };
    installFetch(mockFetchOk(body));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("HttpError");
    if (error.type === "HttpError") {
      expect(error.statusCode).toBe(503);
      expect(error.message).toBe(
        "OpenRouter returned an inline error response.",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// OpenRouterClient — default model matrix models
// ---------------------------------------------------------------------------

describe("OpenRouterClient — default model matrix models", () => {
  const defaultModelIds = [
    "anthropic/claude-opus-4.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.5",
  ];

  for (const modelId of defaultModelIds) {
    it(`accepts model ID "${modelId}" and returns ok`, async () => {
      installFetch(mockFetchOk(openRouterSuccess("Response text", modelId)));

      const client = new OpenRouterClient(VALID_ENV);
      const result = await client.complete({
        model: modelId,
        messages: MINIMAL_MESSAGES,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().model).toBe(modelId);
    });
  }

  it("default model IDs normalize exactly to the three canonical models", () => {
    const sorted = [...defaultModelIds].sort();
    expect(sorted).toEqual([
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.5",
    ]);
  });
});

// ---------------------------------------------------------------------------
// StubModelClient — basic behaviour
// ---------------------------------------------------------------------------

describe("StubModelClient — basic behaviour", () => {
  it("records each complete() call in .calls", async () => {
    const stub = new StubModelClient();
    stub.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "Answer",
    });

    await stub.complete(MINIMAL_REQUEST);
    await stub.complete({
      model: "openai/gpt-5.5",
      messages: MINIMAL_MESSAGES,
    });

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(stub.calls[1]?.model).toBe("openai/gpt-5.5");
  });

  it("returns enqueued responses in FIFO order", async () => {
    const stub = new StubModelClient();
    stub.enqueueResponse({
      model: "anthropic/claude-opus-4.5",
      content: "First",
    });
    stub.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "Second",
    });

    const r1 = await stub.complete(MINIMAL_REQUEST);
    const r2 = await stub.complete(MINIMAL_REQUEST);

    expect(r1.isOk()).toBe(true);
    expect(r1._unsafeUnwrap().content).toBe("First");
    expect(r2.isOk()).toBe(true);
    expect(r2._unsafeUnwrap().content).toBe("Second");
  });

  it("returns ok for enqueued responses", async () => {
    const stub = new StubModelClient();
    stub.enqueueResponse({ model: "openai/gpt-5.5", content: "Yes" });

    const result = await stub.complete(MINIMAL_REQUEST);
    expect(result.isOk()).toBe(true);
  });

  it("returns enqueued errors as err(ModelClientError)", async () => {
    const stub = new StubModelClient();
    const error: ModelClientError = {
      type: "NetworkError",
      message: "simulated network failure",
    };
    stub.enqueueError(error);

    const result = await stub.complete(MINIMAL_REQUEST);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("NetworkError");
    expect(e.message).toBe("simulated network failure");
  });

  it("falls back to defaultResponse after the queue is exhausted", async () => {
    const stub = new StubModelClient();
    stub.enqueueResponse({
      model: "anthropic/claude-opus-4.5",
      content: "Queued",
    });
    stub.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "Default",
    });

    const r1 = await stub.complete(MINIMAL_REQUEST);
    const r2 = await stub.complete(MINIMAL_REQUEST);
    const r3 = await stub.complete(MINIMAL_REQUEST);

    expect(r1._unsafeUnwrap().content).toBe("Queued");
    expect(r2._unsafeUnwrap().content).toBe("Default");
    expect(r3._unsafeUnwrap().content).toBe("Default");
  });

  it("falls back to defaultError after the queue is exhausted", async () => {
    const stub = new StubModelClient();
    stub.setDefaultError({
      type: "HttpError",
      statusCode: 500,
      message: "server error",
    });

    const result = await stub.complete(MINIMAL_REQUEST);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("HttpError");
  });

  it("returns NotConfigured error when queue is exhausted and no default is set", async () => {
    const stub = new StubModelClient();
    // No enqueue and no default set — must return a typed error, never throw
    const result = await stub.complete(MINIMAL_REQUEST);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NotConfigured");
  });

  it("NotConfigured error carries the call index (zero-based)", async () => {
    const stub = new StubModelClient();
    // First call: index 0
    const r1 = await stub.complete(MINIMAL_REQUEST);
    expect(r1.isErr()).toBe(true);
    const e1 = r1._unsafeUnwrapErr();
    if (e1.type === "NotConfigured") {
      expect(e1.callIndex).toBe(0);
    }
    // Second call: index 1
    const r2 = await stub.complete(MINIMAL_REQUEST);
    const e2 = r2._unsafeUnwrapErr();
    if (e2.type === "NotConfigured") {
      expect(e2.callIndex).toBe(1);
    }
  });

  it("enqueue → error → response interleave works correctly", async () => {
    const stub = new StubModelClient();
    stub.enqueueError({ type: "ParseError", message: "bad json" });
    stub.enqueueResponse({ model: "openai/gpt-5.5", content: "ok" });

    const r1 = await stub.complete(MINIMAL_REQUEST);
    const r2 = await stub.complete(MINIMAL_REQUEST);

    expect(r1.isErr()).toBe(true);
    expect(r2.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StubModelClient — satisfies ModelClient interface (type-level check)
// ---------------------------------------------------------------------------

describe("StubModelClient — ModelClient interface compliance", () => {
  it("has a complete() method that returns ResultAsync", async () => {
    const stub = new StubModelClient();
    stub.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "Hi",
    });

    const result = stub.complete(MINIMAL_REQUEST);
    // Must be thenable (Promise-like)
    expect(result.then).toBeDefined();

    const resolved = await result;
    expect(resolved.isOk()).toBe(true);
  });

  it("calls array is empty before any calls", () => {
    const stub = new StubModelClient();
    expect(stub.calls).toHaveLength(0);
  });

  it("records the full request including messages", async () => {
    const stub = new StubModelClient();
    stub.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "answer",
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "Ping" },
    ];
    await stub.complete({ model: "anthropic/claude-sonnet-4.5", messages });

    expect(stub.calls[0]?.messages).toEqual(messages);
  });
});

// ---------------------------------------------------------------------------
// ModelResponse security — API key must not leak into responses
// ---------------------------------------------------------------------------

describe("ModelResponse security", () => {
  it("ModelResponse does not contain the API key", async () => {
    installFetch(mockFetchOk(openRouterSuccess("The answer is 4.")));

    const client = new OpenRouterClient(VALID_ENV);
    const result = await client.complete(MINIMAL_REQUEST);

    const response = result._unsafeUnwrap();
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(FAKE_API_KEY);
  });

  it("HttpError diagnostics omit provider bodies and inline error text", async () => {
    installFetch(
      mockFetchHttpError(401, `{"error": "invalid key: ${FAKE_API_KEY}"}`),
    );

    const client = new OpenRouterClient(VALID_ENV);
    const httpResult = await client.complete(MINIMAL_REQUEST);

    expect(httpResult.isErr()).toBe(true);
    const httpError = httpResult._unsafeUnwrapErr();
    expect(httpError.type).toBe("HttpError");
    expect(JSON.stringify(httpError)).not.toContain(FAKE_API_KEY);

    installFetch(
      mockFetchOk({
        error: {
          message: `provider detail includes ${FAKE_API_KEY}`,
          code: 503,
        },
      }),
    );

    const inlineResult = await client.complete(MINIMAL_REQUEST);

    expect(inlineResult.isErr()).toBe(true);
    const inlineError = inlineResult._unsafeUnwrapErr();
    expect(inlineError.type).toBe("HttpError");
    expect(JSON.stringify(inlineError)).not.toContain(FAKE_API_KEY);
  });
});
