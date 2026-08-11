import { describe, expect, it } from "bun:test";
import {
  type ChildOverlayView,
  createChildOverlayController,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import { latestWindowError } from "../child-overlay-telemetry.js";
import {
  CHILD_PROVIDER_ERROR_BOUNDS,
  CHILD_PROVIDER_ERROR_REPLAY_FIELD,
  historicalProviderErrorFacts,
  MAX_CHILD_ERROR_MESSAGE_LENGTH,
  PI_CHILD_ERROR_CLASSES,
  type PiChildProviderError,
  PiChildProviderErrorSchema,
  parsePiChildProviderError,
  projectAssistantProviderError,
} from "../child-provider-error.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";

/**
 * Bounded, sanitized child provider error projection (plan Task 12).
 *
 * The parsed shape is the pi-ai 0.84.1 `AssistantMessage` Pi emits on
 * `message_end`: `{ role: "assistant", api, provider, model, responseModel?,
 * stopReason, errorMessage?, rawStopReason? }` with
 * `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" |
 * "aborted" | "deferred"`.
 *
 * Every `errorMessage` fixture below is synthetic. No real credential, request
 * id, or endpoint appears anywhere in this file: secrets are represented by
 * obviously fake sentinel strings whose absence from the projection is the
 * assertion.
 */

const messageEnd = (message: Record<string, unknown>) => ({
  type: "message_end",
  message: {
    id: "msg_01HQ",
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    content: [],
    usage: { input: 10, output: 0 },
    timestamp: 1,
    ...message,
  },
});

/** Project through the real parser gate, exactly as the controller does. */
function project(
  event: unknown,
): ReturnType<typeof parsePiChildProviderError> | undefined {
  const parsed = parsePiChildSessionEvent(event);
  if (!parsed.success) return undefined;
  return parsePiChildProviderError(parsed.data);
}

function projectOk(event: unknown): PiChildProviderError {
  const result = project(event);
  expect(result).toBeDefined();
  if (result === undefined) throw new Error("unreachable");
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

const errorEnd = (errorMessage: string | undefined) =>
  messageEnd({
    stopReason: "error",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  });

/** Sentinels that must never reach the projection or its serialization. */
const SENTINELS = {
  requestId: "req_011SENTINELREQUESTIDVALUE",
  url: "https://api.example-provider.invalid/v1/messages?trace=SENTINELURL",
  authorization: "Authorization: Bearer SENTINELBEARERTOKENVALUE0001",
  apiKey: "x-api-key: sk-SENTINELAPIKEYVALUE000000002",
  cookie: "Cookie: session_id=SENTINELCOOKIEVALUE0003",
  token: "token=SENTINELTOKENVALUE0004",
  secret: "client_secret: SENTINELSECRETVALUE0005",
  path: "/Users/example/.local/share/weave/SENTINELPATHVALUE/session.jsonl",
  windowsPath: String.raw`C:\Users\example\SENTINELWINDOWSPATH\child.jsonl`,
  uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  prompt: "SENTINELPROMPTCONTENT",
  completion: "SENTINELCOMPLETIONCONTENT",
  email: "person@example.invalid",
} as const;

describe("child provider error model bounds", () => {
  it("pins the closed class list and the schema shape", () => {
    expect([...PI_CHILD_ERROR_CLASSES]).toEqual([
      "rate-limit",
      "auth",
      "timeout",
      "overload",
      "connection",
      "cancelled",
      "malformed-response",
      "provider-error",
      "unknown",
    ]);
    expect(MAX_CHILD_ERROR_MESSAGE_LENGTH).toBe(160);
    expect(CHILD_PROVIDER_ERROR_BOUNDS.minHttpStatus).toBe(100);
    expect(CHILD_PROVIDER_ERROR_BOUNDS.maxHttpStatus).toBe(599);
  });

  it("rejects out-of-model values: unknown class, bad status, raw code, extra keys", () => {
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "billing",
        message: "nope",
      }).success,
    ).toBe(false);
    for (const httpStatus of [0, 99, 600, 4290, 429.5]) {
      expect(
        PiChildProviderErrorSchema.safeParse({
          class: "rate-limit",
          message: "rate limited",
          httpStatus,
        }).success,
      ).toBe(false);
    }
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "provider-error",
        message: "failed",
        code: "acct_9911_SENTINEL",
      }).success,
    ).toBe(false);
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "provider-error",
        message: "failed",
        errorMessage: "raw provider text",
      }).success,
    ).toBe(false);
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "provider-error",
        message: "x".repeat(MAX_CHILD_ERROR_MESSAGE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("validates every projection it produces against the schema", () => {
    const projected = projectOk(
      errorEnd('429 {"type":"error","error":{"type":"rate_limit_error"}}'),
    );
    expect(PiChildProviderErrorSchema.safeParse(projected).success).toBe(true);
  });
});

describe("child provider error classification", () => {
  it("keeps a safe useful message from an Anthropic-style HTTP 429", () => {
    const projected = projectOk(
      errorEnd(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      ),
    );
    expect(projected).toEqual({
      source: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5",
      class: "rate-limit",
      httpStatus: 429,
      code: "rate_limit_error",
      message:
        "Number of request tokens has exceeded your per-minute rate limit",
    });
  });

  it("classifies an HTTP 500 with no body as a provider error with honest copy", () => {
    const projected = projectOk(errorEnd("500 "));
    expect(projected.class).toBe("provider-error");
    expect(projected.httpStatus).toBe(500);
    expect(projected.code).toBeUndefined();
    expect(projected.message).toBe("provider request failed");
  });

  it("classifies auth failures from 401, 403, and clear text", () => {
    expect(projectOk(errorEnd("401 unauthorized")).class).toBe("auth");
    expect(projectOk(errorEnd("403 forbidden")).class).toBe("auth");
    const text = projectOk(
      errorEnd('{"type":"error","error":{"type":"authentication_error"}}'),
    );
    expect(text.class).toBe("auth");
    expect(text.code).toBe("authentication_error");
    expect(text.message).toBe("provider rejected the credentials");
  });

  it("classifies timeout, overload, connection, cancellation, and malformed", () => {
    expect(projectOk(errorEnd("request timed out after 60s")).class).toBe(
      "timeout",
    );
    expect(projectOk(errorEnd("504 gateway_timeout")).class).toBe("timeout");
    expect(projectOk(errorEnd("529 overloaded_error")).class).toBe("overload");
    expect(projectOk(errorEnd("503 service unavailable")).class).toBe(
      "overload",
    );
    expect(projectOk(errorEnd("connection reset by peer")).class).toBe(
      "connection",
    );
    expect(projectOk(errorEnd("ECONNREFUSED")).class).toBe("connection");
    const cancelled = projectOk(errorEnd("The operation was aborted"));
    expect(cancelled.class).toBe("cancelled");
    expect(cancelled.message).toBe("The operation was aborted");
    // With nothing safe to preserve, the canonical copy stands in.
    expect(projectOk(errorEnd('{"error":{"type":"abort_err"}}')).message).toBe(
      "request was cancelled",
    );
    expect(projectOk(errorEnd("unexpected end of JSON input")).class).toBe(
      "malformed-response",
    );
  });

  it("reports unknown when the failure carries no evidence at all", () => {
    const projected = projectOk(errorEnd(undefined));
    expect(projected.class).toBe("unknown");
    expect(projected.httpStatus).toBeUndefined();
    expect(projected.code).toBeUndefined();
    expect(projected.message).toBe("details unavailable");
  });

  it("pins precedence: rate limit outranks the other classes it co-occurs with", () => {
    const projected = projectOk(
      errorEnd("429 rate limit reached; connection reset; timed out"),
    );
    expect(projected.class).toBe("rate-limit");
  });

  it("drops an ambiguous status rather than guessing one", () => {
    const projected = projectOk(errorEnd("500 upstream returned status 503"));
    expect(projected.httpStatus).toBeUndefined();
    // With no unambiguous status and no class-specific text, nothing more
    // specific than a provider failure is claimed.
    expect(projected.class).toBe("provider-error");
  });

  it("never invents a status from an out-of-range or unmarked number", () => {
    expect(projectOk(errorEnd("999 weird")).httpStatus).toBeUndefined();
    expect(
      projectOk(errorEnd("retry after 42 seconds")).httpStatus,
    ).toBeUndefined();
  });
});

describe("child provider error absence", () => {
  it("is unavailable for non-terminal events and non-assistant messages", () => {
    expect(project({ type: "text", text: "hello" })?.isErr()).toBe(true);
    const user = project({
      type: "message_end",
      message: { role: "user", content: "hi", stopReason: "error" },
    });
    expect(user?._unsafeUnwrapErr()).toEqual({
      type: "ProviderErrorUnavailable",
    });
  });

  it("clears a stale error on an authoritative terminal success", () => {
    const cleared = project(messageEnd({ stopReason: "stop" }));
    expect(cleared?._unsafeUnwrapErr()).toEqual({
      type: "ProviderErrorCleared",
    });
    // `aborted` is Pi's own interruption path, not a provider failure.
    expect(
      project(messageEnd({ stopReason: "aborted" }))?._unsafeUnwrapErr(),
    ).toEqual({ type: "ProviderErrorCleared" });
  });

  it("is unavailable for malformed, missing, and non-object messages", () => {
    for (const message of [undefined, null, 42, "boom", [], { role: 7 }]) {
      const result = projectAssistantProviderError(message);
      expect(result.isErr()).toBe(true);
    }
    expect(
      projectAssistantProviderError({
        role: "assistant",
        stopReason: 500,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "ProviderErrorUnavailable" });
  });

  it("treats a throwing descriptor as absent instead of throwing", () => {
    const hostile = {
      role: "assistant",
      get stopReason(): string {
        throw new Error("hostile getter");
      },
    };
    expect(projectAssistantProviderError(hostile).isErr()).toBe(true);

    const hostileMessage = {
      role: "assistant",
      stopReason: "error",
      get errorMessage(): string {
        throw new Error("hostile getter");
      },
      get api(): string {
        throw new Error("hostile getter");
      },
    };
    const projected = projectAssistantProviderError(hostileMessage);
    expect(projected.isOk()).toBe(true);
    const value = projected._unsafeUnwrap();
    expect(value.class).toBe("unknown");
    expect(value.source).toBeUndefined();
    expect(value.message).toBe("details unavailable");
  });

  it("does not retain an oversized or unsafe identity label", () => {
    const projected = projectAssistantProviderError({
      role: "assistant",
      stopReason: "error",
      api: "a".repeat(CHILD_PROVIDER_ERROR_BOUNDS.maxLabelLength + 1),
      provider: "anthropic evil\u0007 name",
      model: "m".repeat(CHILD_PROVIDER_ERROR_BOUNDS.maxLabelLength + 1),
      errorMessage: "429 rate limit",
    })._unsafeUnwrap();
    expect(projected.source).toBeUndefined();
    expect(projected.provider).toBeUndefined();
    expect(projected.model).toBeUndefined();
    expect(projected.class).toBe("rate-limit");
  });

  it("replaces an oversized provider message with canonical copy", () => {
    const projected = projectAssistantProviderError({
      role: "assistant",
      stopReason: "error",
      errorMessage: `429 rate limit exceeded. ${"padding text ".repeat(600)}`,
    })._unsafeUnwrap();
    expect(projected.class).toBe("rate-limit");
    expect(projected.message).toBe("provider rate limit exceeded");
    expect(projected.message.length).toBeLessThanOrEqual(
      MAX_CHILD_ERROR_MESSAGE_LENGTH,
    );
  });

  it("rejects a tampered pre-projected historical payload", () => {
    const tampered = projectAssistantProviderError({
      role: "assistant",
      stopReason: "error",
      [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: {
        class: "rate-limit",
        message: "rate limited",
        errorMessage: SENTINELS.requestId,
      },
    });
    expect(tampered._unsafeUnwrapErr()).toEqual({
      type: "ProviderErrorUnavailable",
    });
  });
});

describe("child provider error sanitization", () => {
  const projectMessage = (errorMessage: string): PiChildProviderError =>
    projectOk(errorEnd(errorMessage));

  const assertClean = (projected: PiChildProviderError): void => {
    const serialized = JSON.stringify(projected);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
    // Structural leaks anywhere in the projection.
    for (const fragment of [
      "SENTINEL",
      "Bearer",
      "bearer",
      "sk-",
      "uthorization",
      "Cookie",
      "://",
      "/Users/",
      "C:\\",
      "errorMessage",
      "{\\",
      "\u0007",
      "\u202e",
      "\u200b",
    ]) {
      expect(serialized).not.toContain(fragment);
    }
    // The free-text field additionally carries no protocol or brace residue.
    for (const fragment of ["http", "{", "}", "[", "]", "<", ">", "\\", "/"]) {
      expect(projected.message).not.toContain(fragment);
    }
    expect(projected.message.length).toBeLessThanOrEqual(
      MAX_CHILD_ERROR_MESSAGE_LENGTH,
    );
  };

  it("strips every prohibited construct from one hostile payload", () => {
    const hostile = [
      "429",
      SENTINELS.url,
      SENTINELS.authorization,
      SENTINELS.apiKey,
      SENTINELS.cookie,
      SENTINELS.token,
      SENTINELS.secret,
      `request-id: ${SENTINELS.requestId}`,
      SENTINELS.path,
      SENTINELS.windowsPath,
      SENTINELS.uuid,
      SENTINELS.email,
      `{"prompt":"${SENTINELS.prompt}","completion":"${SENTINELS.completion}"}`,
      "trailing\u0007\u202econtrol\u200btext",
    ].join(" ");
    const projected = projectMessage(hostile);
    expect(projected.class).toBe("rate-limit");
    expect(projected.message).toBe("provider rate limit exceeded");
    assertClean(projected);
  });

  it("removes each prohibited construct on its own", () => {
    const vectors: readonly string[] = [
      `503 overloaded, see ${SENTINELS.url}`,
      `500 ${SENTINELS.authorization}`,
      `500 ${SENTINELS.apiKey}`,
      `500 ${SENTINELS.cookie}`,
      `500 ${SENTINELS.token}`,
      `500 ${SENTINELS.secret}`,
      `500 request-id: ${SENTINELS.requestId}`,
      `500 failed writing ${SENTINELS.path}`,
      `500 failed writing ${SENTINELS.windowsPath}`,
      `500 correlation ${SENTINELS.uuid}`,
      `500 contact ${SENTINELS.email}`,
      `500 \u0007\u202e\u200b\u2066garbled\u2069`,
    ];
    for (const vector of vectors) {
      assertClean(projectMessage(vector));
    }
  });

  it("does not mine prompt or completion content for display copy", () => {
    const projected = projectMessage(
      `400 {"error":{"type":"invalid_request_error","message":"bad"},"messages":[{"role":"user","content":"${SENTINELS.prompt}"}],"completion":"${SENTINELS.completion}"}`,
    );
    expect(projected.class).toBe("provider-error");
    expect(projected.code).toBe("invalid_request_error");
    expect(projected.message).toBe("provider request failed");
    assertClean(projected);
  });

  it("never keeps nested provider JSON as free text", () => {
    const projected = projectMessage(
      '500 {"raw":{"nested":{"deeper":["a","b"]}},"note":"opaque"}',
    );
    expect(projected.message).toBe("provider request failed");
    expect(JSON.stringify(projected)).not.toContain("nested");
  });

  it("keeps a plain safe provider sentence verbatim", () => {
    const projected = projectMessage(
      "429 Rate limit reached for requests, please slow down.",
    );
    expect(projected.class).toBe("rate-limit");
    expect(projected.message).toBe(
      "429 Rate limit reached for requests, please slow down",
    );
  });
});

describe("child provider error retention in the overlay", () => {
  const liveChild = (
    childId: string,
    entries: readonly { readonly id: string; readonly payload: unknown }[] = [],
  ): MemoryOverlaySourceChild => ({
    childId,
    threadId: childId,
    status: "live",
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries,
  });

  const settledChild = (
    childId: string,
    entries: readonly { readonly id: string; readonly payload: unknown }[],
  ): MemoryOverlaySourceChild => ({
    ...liveChild(childId, entries),
    status: "settled",
  });

  const nativeAssistant = (
    id: string,
    message: Record<string, unknown>,
  ): { readonly id: string; readonly payload: unknown } => ({
    id,
    payload: {
      type: "message",
      id,
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "historical answer" }],
        usage: { input: 5, output: 6 },
        timestamp: 1,
        ...message,
      },
    },
  });

  async function open(
    children: readonly MemoryOverlaySourceChild[],
    childId: string,
  ): Promise<{
    controller: ReturnType<typeof createChildOverlayController>;
    view: ChildOverlayView;
  }> {
    const controller = createChildOverlayController(
      createMemoryChildOverlaySource(children),
    );
    const opened = await controller.open(childId);
    expect(opened.isOk()).toBe(true);
    return { controller, view: opened._unsafeUnwrap() };
  }

  const apply = (
    controller: ReturnType<typeof createChildOverlayController>,
    event: unknown,
  ): ChildOverlayView => {
    const applied = controller.applyLiveEvent(event);
    expect(applied.isOk()).toBe(true);
    return applied._unsafeUnwrap();
  };

  it("exposes no terminal error before one is observed", async () => {
    const { view } = await open([liveChild("child-a")], "child-a");
    expect(view.terminalError).toBeUndefined();
  });

  it("retains only the latest terminal error, replacing the prior one", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    const first = apply(controller, errorEnd("429 rate limit reached"));
    expect(first.terminalError?.class).toBe("rate-limit");
    const second = apply(controller, errorEnd("503 overloaded_error"));
    expect(second.terminalError?.class).toBe("overload");
    expect(second.terminalError?.httpStatus).toBe(503);
  });

  it("clears the retained error when a later turn succeeds", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    expect(
      apply(controller, errorEnd("429 rate limit reached")).terminalError,
    ).toBeDefined();
    const success = apply(controller, messageEnd({ stopReason: "stop" }));
    expect(success.terminalError).toBeUndefined();
  });

  it("isolates the error per child", async () => {
    const { controller } = await open(
      [liveChild("child-a"), liveChild("child-b")],
      "child-a",
    );
    apply(controller, errorEnd("429 rate limit reached"));
    const other = await controller.open("child-b");
    expect(other.isOk()).toBe(true);
    expect(other._unsafeUnwrap().terminalError).toBeUndefined();
    const back = await controller.open("child-a");
    expect(back._unsafeUnwrap().terminalError?.class).toBe("rate-limit");
  });

  it("keeps the error on a settled view rebuilt from history", async () => {
    const { view } = await open(
      [
        settledChild("child-h", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: `429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}} ${SENTINELS.requestId}`,
          }),
        ]),
      ],
      "child-h",
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    expect(view.terminalError?.httpStatus).toBe(429);
    expect(view.terminalError?.code).toBe("rate_limit_error");
    expect(JSON.stringify(view)).not.toContain(SENTINELS.requestId);
  });

  it("takes the newest historical error inside the loaded window", async () => {
    const { view } = await open(
      [
        settledChild("child-h", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: "429 rate limit reached",
          }),
          nativeAssistant("entry-2", {
            stopReason: "error",
            errorMessage: "503 overloaded_error",
          }),
        ]),
      ],
      "child-h",
    );
    expect(view.terminalError?.class).toBe("overload");
  });

  it("reports no historical error when the newest terminal turn succeeded", async () => {
    const { view } = await open(
      [
        settledChild("child-h", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: "429 rate limit reached",
          }),
          nativeAssistant("entry-2", { stopReason: "stop" }),
        ]),
      ],
      "child-h",
    );
    expect(view.terminalError).toBeUndefined();
  });

  it("lets a live error replace a historical one", async () => {
    const { controller, view } = await open(
      [
        liveChild("child-m", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: "429 rate limit reached",
          }),
        ]),
      ],
      "child-m",
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    const live = apply(controller, errorEnd("ECONNRESET"));
    expect(live.terminalError?.class).toBe("connection");
  });

  it("never stores a raw errorMessage in the view or its serialization", async () => {
    const { controller, view } = await open(
      [
        liveChild("child-r", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: `500 ${SENTINELS.authorization} ${SENTINELS.path}`,
          }),
        ]),
      ],
      "child-r",
    );
    const live = apply(
      controller,
      errorEnd(`500 ${SENTINELS.apiKey} ${SENTINELS.url}`),
    );
    for (const state of [view, live]) {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain("errorMessage");
      expect(serialized).not.toContain("SENTINEL");
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("://");
    }
  });
});

describe("historical replay projection helpers", () => {
  it("carries the authoritative stop reason and the sanitized projection", () => {
    const facts = historicalProviderErrorFacts({
      role: "assistant",
      stopReason: "error",
      errorMessage: `429 rate limit reached ${SENTINELS.requestId}`,
    });
    expect(facts?.stopReason).toBe("error");
    expect(facts?.providerError?.class).toBe("rate-limit");
    expect(JSON.stringify(facts)).not.toContain(SENTINELS.requestId);
  });

  it("carries a successful stop reason with no projection", () => {
    expect(historicalProviderErrorFacts({ stopReason: "stop" })).toEqual({
      stopReason: "stop",
    });
  });

  it("is absent for a message with no authoritative stop reason", () => {
    expect(historicalProviderErrorFacts({ role: "assistant" })).toBeUndefined();
    expect(
      historicalProviderErrorFacts({ stopReason: "not-a-reason" }),
    ).toBeUndefined();
  });

  it("finds nothing in an empty window", () => {
    expect(latestWindowError([])).toBeUndefined();
  });
});
