/**
 * Unit tests for SdkOpenCodeClient session methods.
 *
 * All tests use a minimal mock OpencodeClient that returns controlled responses.
 * No live SDK calls are made.
 */

import { describe, expect, it } from "bun:test";

import { SdkOpenCodeClient } from "../opencode-client.js";
import type { OpencodeClient } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type SessionCreateResponse = {
  data?: { id: string; [key: string]: unknown };
  error?: unknown;
};

type SessionPromptResponse = {
  data?: {
    info: { error?: unknown; [key: string]: unknown };
    parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
  error?: unknown;
};

type SessionDeleteResponse = {
  data?: unknown;
  error?: unknown;
};

function makeMockClient(overrides: {
  sessionCreate?: () => Promise<SessionCreateResponse>;
  sessionPrompt?: () => Promise<SessionPromptResponse>;
  sessionDelete?: () => Promise<SessionDeleteResponse>;
}): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: [] }),
    },
    config: {
      update: async () => ({ data: undefined }),
    },
    session: {
      create:
        overrides.sessionCreate ?? (async () => ({ data: { id: "default" } })),
      prompt:
        overrides.sessionPrompt ??
        (async () => ({ data: { info: {}, parts: [] } })),
      delete: overrides.sessionDelete ?? (async () => ({ data: undefined })),
    },
  } as unknown as OpencodeClient;
}

// ---------------------------------------------------------------------------
// createReviewSession
// ---------------------------------------------------------------------------

describe("SdkOpenCodeClient.createReviewSession", () => {
  it("happy path: returns ok({ sessionId }) on success", async () => {
    const client = makeMockClient({
      sessionCreate: async () => ({
        data: { id: "session-1", title: "Review" },
      }),
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.createReviewSession("Review");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ sessionId: "session-1" });
  });

  it("error: returns err with type CreateSessionError when SDK throws", async () => {
    const client = makeMockClient({
      sessionCreate: async () => {
        throw new Error("network failure");
      },
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.createReviewSession("Review");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CreateSessionError");
    expect(error.message).toContain("SDK error");
  });
});

// ---------------------------------------------------------------------------
// promptSession
// ---------------------------------------------------------------------------

describe("SdkOpenCodeClient.promptSession", () => {
  it("happy path: extracts text parts and returns ok({ output, assistantMessage })", async () => {
    const assistantInfo = { id: "msg-1", role: "assistant" };
    const client = makeMockClient({
      sessionPrompt: async () => ({
        data: {
          info: assistantInfo,
          parts: [
            { type: "text", text: "Review approved" },
            { type: "tool", toolName: "some-tool" },
          ],
        },
      }),
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.promptSession(
      "session-1",
      "Please review.",
      "weft",
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.output).toBe("Review approved");
    expect(value.assistantMessage).toBe(assistantInfo);
  });

  it("multiple text parts: concatenates all text parts into output", async () => {
    const client = makeMockClient({
      sessionPrompt: async () => ({
        data: {
          info: { id: "msg-2" },
          parts: [
            { type: "text", text: "Part one. " },
            { type: "tool", toolName: "tool" },
            { type: "text", text: "Part two." },
          ],
        },
      }),
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.promptSession("session-1", "Go.", "weft");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().output).toBe("Part one. Part two.");
  });

  it("assistant error: returns err with type PromptSessionError when info.error is set", async () => {
    const client = makeMockClient({
      sessionPrompt: async () => ({
        data: {
          info: { error: { message: "context limit exceeded" } },
          parts: [],
        },
      }),
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.promptSession("session-1", "Go.", "weft");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PromptSessionError");
    if (error.type === "PromptSessionError") {
      expect(error.sessionId).toBe("session-1");
    }
  });

  it("SDK error: returns err with type PromptSessionError when SDK throws", async () => {
    const client = makeMockClient({
      sessionPrompt: async () => {
        throw new Error("timeout");
      },
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.promptSession("session-1", "Go.", "weft");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PromptSessionError");
    expect(error.message).toContain("SDK error");
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe("SdkOpenCodeClient.deleteSession", () => {
  it("happy path: returns ok(undefined) on success", async () => {
    const client = makeMockClient({
      sessionDelete: async () => ({ data: undefined }),
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.deleteSession("session-1");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("error: returns err with type DeleteSessionError when SDK throws", async () => {
    const client = makeMockClient({
      sessionDelete: async () => {
        throw new Error("forbidden");
      },
    });
    const facade = new SdkOpenCodeClient(client);

    const result = await facade.deleteSession("session-1");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("DeleteSessionError");
    expect(error.message).toContain("SDK error");
    if (error.type === "DeleteSessionError") {
      expect(error.sessionId).toBe("session-1");
    }
  });
});
