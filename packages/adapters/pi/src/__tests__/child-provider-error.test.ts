import { describe, expect, it } from "bun:test";
import { errAsync } from "neverthrow";
import {
  type ChildOverlayFallbackRequired,
  type ChildOverlaySourcePort,
  type ChildOverlayView,
  createChildOverlayController,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import {
  adoptNewerEvidence,
  adoptOlderEvidence,
  applyProviderErrorEvent,
  CLEARED_TERMINAL_ERROR_EVIDENCE,
  latestWindowError,
  latestWindowErrorEvidence,
  NO_TERMINAL_ERROR_EVIDENCE,
  pageEvidence,
  terminalErrorOf,
  terminalErrorView,
} from "../child-overlay-telemetry.js";
import {
  CHILD_ERROR_CANONICAL_MESSAGE,
  CHILD_PROVIDER_ERROR_BOUNDS,
  CHILD_PROVIDER_ERROR_REPLAY_FIELD,
  historicalAssistantMessageFields,
  historicalProviderErrorFacts,
  MAX_CHILD_ERROR_MESSAGE_LENGTH,
  PI_CHILD_ERROR_CLASSES,
  PI_CHILD_ERROR_MESSAGES,
  type PiChildErrorClass,
  type PiChildProviderError,
  PiChildProviderErrorSchema,
  parsePiChildProviderError,
  projectAssistantProviderError,
  redactProviderErrorFromEvent,
  SAFE_ASSISTANT_MESSAGE_FIELDS,
} from "../child-provider-error.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";

/**
 * Bounded, canonical child provider error projection (plan Task 12).
 *
 * The parsed shape is the pi-ai 0.84.1 `AssistantMessage` Pi emits on
 * `message_end`: `{ role: "assistant", api, provider, model, responseModel?,
 * stopReason, errorMessage?, rawStopReason?, responseId?, diagnostics? }` with
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

const CANON = CHILD_ERROR_CANONICAL_MESSAGE;

/** Sentinels that must never reach the projection or its serialization. */
const SENTINELS = {
  requestId: "req_011SENTINELREQUESTIDVALUE",
  responseId: "resp_011SENTINELRESPONSEIDVALUE",
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
  diagnostic: "SENTINELDIAGNOSTICDETAIL",
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
    expect(CHILD_PROVIDER_ERROR_BOUNDS.minEvidenceStatus).toBe(400);
    expect(CHILD_PROVIDER_ERROR_BOUNDS.maxEvidenceStatus).toBe(599);
  });

  it("pins one canonical message per class, all inside the bound", () => {
    const messages = PI_CHILD_ERROR_CLASSES.map((cls) => CANON[cls]);
    expect(messages).toEqual([...PI_CHILD_ERROR_MESSAGES]);
    expect(new Set(messages).size).toBe(PI_CHILD_ERROR_CLASSES.length);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(
        MAX_CHILD_ERROR_MESSAGE_LENGTH,
      );
    }
    expect(CANON["rate-limit"]).toBe(
      "Provider rate limit exceeded. Retry later.",
    );
    expect(CANON.auth).toBe("Provider rejected the credentials.");
    expect(CANON.timeout).toBe("Provider request timed out.");
    expect(CANON.overload).toBe("Provider is overloaded. Retry later.");
    expect(CANON.connection).toBe("Connection to the provider failed.");
    expect(CANON.cancelled).toBe("Request was cancelled.");
    expect(CANON["malformed-response"]).toBe(
      "Provider returned a malformed response.",
    );
    expect(CANON["provider-error"]).toBe("Provider request failed.");
    expect(CANON.unknown).toBe("Provider failure details unavailable.");
  });

  it("rejects out-of-model values: unknown class, bad status, raw code, extra keys", () => {
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "billing",
        message: CANON.unknown,
      }).success,
    ).toBe(false);
    for (const httpStatus of [0, 99, 600, 4290, 429.5]) {
      expect(
        PiChildProviderErrorSchema.safeParse({
          class: "rate-limit",
          message: CANON["rate-limit"],
          httpStatus,
        }).success,
      ).toBe(false);
    }
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "provider-error",
        message: CANON["provider-error"],
        code: "acct_9911_SENTINEL",
      }).success,
    ).toBe(false);
    expect(
      PiChildProviderErrorSchema.safeParse({
        class: "provider-error",
        message: CANON["provider-error"],
        errorMessage: "raw provider text",
      }).success,
    ).toBe(false);
  });

  it("rejects any message that is not one of the canonical strings", () => {
    for (const message of [
      "Rate limit reached for requests, please slow down.",
      "provider rate limit exceeded",
      `${CANON["rate-limit"]} req_0001`,
      "",
      "x".repeat(MAX_CHILD_ERROR_MESSAGE_LENGTH + 1),
    ]) {
      expect(
        PiChildProviderErrorSchema.safeParse({
          class: "rate-limit",
          message,
        }).success,
      ).toBe(false);
    }
  });

  it("validates every projection it produces against the schema", () => {
    const projected = projectOk(
      errorEnd('429 {"type":"error","error":{"type":"rate_limit_error"}}'),
    );
    expect(PiChildProviderErrorSchema.safeParse(projected).success).toBe(true);
  });
});

describe("child provider error canonicalization", () => {
  it("replaces useful-looking provider prose with the canonical class message", () => {
    const projected = projectOk(
      errorEnd(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      ),
    );
    expect(projected).toEqual({
      class: "rate-limit",
      httpStatus: 429,
      message: CANON["rate-limit"],
    });
  });

  it("canonicalizes arbitrary short safe-looking prose instead of preserving it", () => {
    for (const prose of [
      "429 Rate limit reached for requests, please slow down.",
      "Rate limit reached for requests, please slow down.",
      "the model is currently overloaded, try again",
      "request timed out after 60s",
      "connection reset by peer",
      "The operation was aborted",
      "unexpected end of JSON input",
      "plain english sentence with nothing dangerous in it",
    ]) {
      const projected = projectOk(errorEnd(prose));
      expect([...PI_CHILD_ERROR_MESSAGES]).toContain(projected.message);
      expect(projected.message).toBe(CANON[projected.class]);
      expect(prose).not.toContain(projected.message);
    }
  });

  it("classifies an HTTP 500 with no body as a provider error with honest copy", () => {
    const projected = projectOk(errorEnd("500 "));
    expect(projected.class).toBe("provider-error");
    expect(projected.httpStatus).toBe(500);
    expect(projected.code).toBeUndefined();
    expect(projected.message).toBe(CANON["provider-error"]);
  });

  it("reports unknown when the failure carries no evidence at all", () => {
    const projected = projectOk(errorEnd(undefined));
    expect(projected.class).toBe("unknown");
    expect(projected.httpStatus).toBeUndefined();
    expect(projected.code).toBeUndefined();
    expect(projected.message).toBe(CANON.unknown);
    expect(projectOk(errorEnd("   ")).class).toBe("unknown");
  });
});

describe("child provider error anchored evidence", () => {
  it("reads an HTTP status only from offset zero", () => {
    expect(projectOk(errorEnd("429 rate limit reached")).httpStatus).toBe(429);
    expect(projectOk(errorEnd('503 {"error":{}}')).httpStatus).toBe(503);
    // Unanchored numbers, marked or not, are prose and contribute nothing.
    expect(
      projectOk(errorEnd("upstream returned status 503")).httpStatus,
    ).toBeUndefined();
    expect(projectOk(errorEnd("HTTP 429 too many")).httpStatus).toBeUndefined();
    expect(
      projectOk(errorEnd("retry after 42 seconds")).httpStatus,
    ).toBeUndefined();
    // Only the anchored status is read; a second number later is ignored.
    const mixed = projectOk(errorEnd("500 upstream returned status 503"));
    expect(mixed.httpStatus).toBe(500);
    expect(mixed.class).toBe("provider-error");
  });

  it("keeps only 4xx and 5xx statuses as failure evidence", () => {
    expect(projectOk(errorEnd("999 weird")).httpStatus).toBeUndefined();
    expect(projectOk(errorEnd("200 ok body")).httpStatus).toBeUndefined();
    expect(projectOk(errorEnd("399 odd")).httpStatus).toBeUndefined();
    expect(projectOk(errorEnd("400 bad")).httpStatus).toBe(400);
    expect(projectOk(errorEnd("599 bad")).httpStatus).toBe(599);
    // A number that is not a standalone anchored token is not a status.
    expect(projectOk(errorEnd("4290 tokens")).httpStatus).toBeUndefined();
  });

  it("maps unambiguous statuses to classes and everything else to provider-error", () => {
    const cases: readonly [string, PiChildErrorClass][] = [
      ["429 x", "rate-limit"],
      ["401 x", "auth"],
      ["403 x", "auth"],
      ["407 x", "auth"],
      ["408 x", "timeout"],
      ["504 x", "timeout"],
      ["524 x", "timeout"],
      ["503 x", "overload"],
      ["529 x", "overload"],
      ["400 x", "provider-error"],
      ["404 x", "provider-error"],
      ["500 x", "provider-error"],
      ["502 x", "provider-error"],
    ];
    for (const [raw, cls] of cases) {
      expect(projectOk(errorEnd(raw)).class).toBe(cls);
    }
  });

  it("treats every JSON-shaped body as untrusted generic unknown", () => {
    const anthropic = projectOk(
      errorEnd('{"type":"error","error":{"type":"authentication_error"}}'),
    );
    expect(anthropic.code).toBeUndefined();
    expect(anthropic.class).toBe("unknown");
    expect(anthropic.message).toBe(CANON.unknown);

    const openai = projectOk(
      errorEnd(
        '{"error":{"message":"bad key","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}',
      ),
    );
    expect(openai.code).toBeUndefined();
    expect(openai.class).toBe("unknown");
    expect(openai.message).toBe(CANON.unknown);

    const bare = projectOk(errorEnd('{"error":{"type":"abort_err"}}'));
    expect(bare.code).toBeUndefined();
    expect(bare.class).toBe("unknown");
  });

  it("classifies leading HTTP status beside JSON from the status alone", () => {
    const later = projectOk(
      errorEnd(
        '400 {"error":{"message":"bad request","type":"invalid_request_error"}}',
      ),
    );
    expect(later.httpStatus).toBe(400);
    expect(later.code).toBeUndefined();
    expect(later.class).toBe("provider-error");
    expect(later.message).toBe(CANON["provider-error"]);

    const rateLimited = projectOk(
      errorEnd(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"exceeded"}}',
      ),
    );
    expect(rateLimited.httpStatus).toBe(429);
    expect(rateLimited.code).toBeUndefined();
    expect(rateLimited.class).toBe("rate-limit");
    expect(rateLimited.message).toBe(CANON["rate-limit"]);
  });

  it("reads an allowlisted code when the whole body is one errno token", () => {
    expect(projectOk(errorEnd("ECONNREFUSED")).code).toBe("econnrefused");
    expect(projectOk(errorEnd("ECONNRESET")).class).toBe("connection");
    expect(projectOk(errorEnd("504 gateway_timeout")).code).toBe(
      "gateway_timeout",
    );
    expect(projectOk(errorEnd("529 overloaded_error")).code).toBe(
      "overloaded_error",
    );
    expect(projectOk(errorEnd("etimedout.")).class).toBe("timeout");
  });

  it("never accepts a code that is not allowlisted", () => {
    for (const raw of [
      "acct_9911_sentinel",
      '{"error":{"type":"acct_9911_sentinel"}}',
      `{"error":{"type":"${SENTINELS.requestId}"}}`,
      "500 weird_provider_specific_thing",
    ]) {
      expect(projectOk(errorEnd(raw)).code).toBeUndefined();
    }
  });

  it("does not mine JSON or prefixed JSON for a code", () => {
    for (const raw of [
      '{"data":{"error":{"type":"rate_limit_error"}}}',
      '{"raw":{"nested":{"type":"rate_limit_error"}}}',
      'prefix {"error":{"type":"rate_limit_error"}}',
      `{"error":{${`"note":"${"p".repeat(300)}",`}"type":"rate_limit_error"}}`,
    ]) {
      const projected = projectOk(errorEnd(raw));
      expect(projected.code).toBeUndefined();
      expect(projected.class).toBe("unknown");
    }
  });

  it("pins precedence when status and bare code disagree", () => {
    // Status says rate limit, bare code says connection: rate-limit outranks.
    expect(projectOk(errorEnd("429 econnreset")).class).toBe("rate-limit");
    // Auth outranks timeout, timeout outranks overload.
    expect(projectOk(errorEnd("504 authentication_error")).class).toBe("auth");
    expect(projectOk(errorEnd("503 gateway_timeout")).class).toBe("timeout");
    // JSON beside a status never supplies a competing code.
    const statusOnly = projectOk(
      errorEnd('500 {"error":{"type":"rate_limit_error"}}'),
    );
    expect(statusOnly.class).toBe("provider-error");
    expect(statusOnly.httpStatus).toBe(500);
    expect(statusOnly.code).toBeUndefined();
  });

  it("does not let prompt or completion content influence the class", () => {
    for (const raw of [
      `{"messages":[{"role":"user","content":"HTTP 429 rate_limit_error ${SENTINELS.prompt}"}]}`,
      `{"completion":"429 {\\"error\\":{\\"type\\":\\"rate_limit_error\\"}} ${SENTINELS.completion}"}`,
      `{"choices":[{"text":"401 unauthorized invalid_api_key"}]}`,
      `{"prompt":"ECONNRESET"}`,
    ]) {
      const projected = projectOk(errorEnd(raw));
      expect(projected.class).toBe("unknown");
      expect(projected.httpStatus).toBeUndefined();
      expect(projected.code).toBeUndefined();
      expect(projected.message).toBe(CANON.unknown);
    }
  });

  it("classifies leading HTTP beside trailing JSON and prose from status alone", () => {
    const projected = projectOk(
      errorEnd(
        `429 {"type":"error","error":{"type":"rate_limit_error"}} messages ${SENTINELS.prompt}`,
      ),
    );
    expect(projected.class).toBe("rate-limit");
    expect(projected.httpStatus).toBe(429);
    expect(projected.code).toBeUndefined();
  });
});

describe("child provider error JSON-shaped bodies", () => {
  /**
   * Every JSON-shaped body is untrusted generic unknown. Nested, sibling,
   * direct, malformed, oversized, array, and proxy shapes never contribute
   * type/code evidence and never throw.
   */
  const noForge = (raw: string): void => {
    const projected = projectOk(errorEnd(raw));
    expect(projected.code).toBeUndefined();
    expect(projected.class).toBe("unknown");
    expect(projected.message).toBe(CANON.unknown);
  };

  it("ignores nested, sibling, and direct JSON members", () => {
    noForge('{"error":{"completion":{"type":"rate_limit_error"}}}');
    noForge('{"error":{"details":{"code":"invalid_api_key"}}}');
    noForge(
      '{"error":{"message":"failed","details":[{"code":"invalid_api_key"}]}}',
    );
    noForge('{"type":"error","error":{"cause":{"type":"econnreset"}}}');
    noForge('{"error":{"a":{"b":{"c":{"d":{"type":"rate_limit_error"}}}}}}');
    noForge('{"error":{},"completion":{"code":"invalid_api_key"}}');
    noForge('{"error":{"message":"failed"},"code":"rate_limit_error"}');
    noForge(
      `{"error":{},"completion":"${SENTINELS.completion} rate_limit_error"}`,
    );
    noForge('{"error":{},"diagnostics":{"type":"overloaded_error"}}');
    noForge('{"prompt":{"type":"rate_limit_error"},"error":{}}');
    noForge('{"error":{"type":"rate_limit_error"}}');
    noForge('{"type":"error","error":{"type":"overloaded_error"}}');
    noForge('{"error":{"type":"rate_limit_error","code":"invalid_api_key"}}');
    noForge('{ "error" : { "type" : "permission_error" } }');
    noForge('{"id":"x","error":{"type":"etimedout"}}');
  });

  it("ignores arrays and non-object error values", () => {
    noForge('{"error":["rate_limit_error"]}');
    noForge('{"error":"rate_limit_error"}');
    noForge('{"error":429}');
    noForge('{"error":null}');
    noForge('["rate_limit_error"]');
    noForge('[{"type":"rate_limit_error"}]');
    noForge('{"error":{"type":{"value":"rate_limit_error"}}}');
    noForge('{"error":{"code":["invalid_api_key"]}}');
  });

  it("never reads an inherited or prototype-injected member", () => {
    noForge('{"error":{"__proto__":{"type":"rate_limit_error"}}}');
    noForge('{"__proto__":{"error":{"type":"rate_limit_error"}}}');
    noForge('{"error":{"constructor":{"type":"invalid_api_key"}}}');

    const inherited = Object.create({
      errorMessage: '{"error":{"type":"rate_limit_error"}}',
    }) as Record<string, unknown>;
    inherited.role = "assistant";
    inherited.stopReason = "error";
    const projected = projectAssistantProviderError(inherited);
    expect(projected.isOk()).toBe(true);
    expect(projected._unsafeUnwrap().class).toBe("unknown");
    expect(projected._unsafeUnwrap().code).toBeUndefined();
    expect(projected._unsafeUnwrap().message).toBe(CANON.unknown);
  });

  it("keeps duplicates, escapes, and trailing content unknown", () => {
    noForge('{"error":{"type":"rate_limit_error","type":"econnreset"}}');
    noForge('{"error":{"code":"invalid_api_key","code":"invalid_api_key"}}');
    noForge('{"error":{"type":{},"type":"rate_limit_error"}}');
    noForge('{"error":{"code":"not_allowlisted_x","code":"invalid_api_key"}}');
    noForge(
      '{"error":{"type":"rate_limit_error","type":"rate_limit_error","details":{"code":"invalid_api_key"}}}',
    );
    noForge(String.raw`{"error":{"type":"rate_limit\u005Ferror"}}`);
    noForge(String.raw`{"error":{"typ\u0065":"rate_limit_error"}}`);
    noForge(`{"error":{"type":"${"z".repeat(80)}"}}`);
    noForge('{"error":{"type":"rate_limit_error"},}');
  });

  it("yields unknown for malformed, truncated, or oversized JSON", () => {
    noForge('{"error":{"type":"rate_limit_error"');
    noForge('{"error":{"type" "rate_limit_error"}}');
    noForge('{"error"{"type":"rate_limit_error"}}');
    const padding = "q".repeat(CHILD_PROVIDER_ERROR_BOUNDS.maxScanLength);
    noForge(`{"note":"${padding}","error":{"type":"rate_limit_error"}}`);
    const many = Array.from(
      { length: 40 },
      (_unused, index) => `"k${index}":${index}`,
    ).join(",");
    noForge(`{${many},"error":{"type":"rate_limit_error"}}`);
  });

  it("stays typed and quiet for a hostile JSON proxy", () => {
    const forged = '{"error":{"completion":{"type":"rate_limit_error"}}}';
    const proxy = new Proxy(
      { role: "assistant", stopReason: "error", errorMessage: forged },
      {
        get(target, key): unknown {
          if (typeof key === "symbol") throw new Error("hostile symbol trap");
          return Reflect.get(target, key);
        },
        getOwnPropertyDescriptor(): never {
          throw new Error("hostile descriptor trap");
        },
        ownKeys(): never {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    expect(() => projectAssistantProviderError(proxy)).not.toThrow();
    const projected = projectAssistantProviderError(proxy);
    expect(projected.isOk()).toBe(true);
    expect(projected._unsafeUnwrap().code).toBeUndefined();
    expect(projected._unsafeUnwrap().class).toBe("unknown");

    const throwing = new Proxy(
      { role: "assistant", stopReason: "error" },
      {
        get(target, key): unknown {
          if (key === "errorMessage") throw new Error("hostile get trap");
          return Reflect.get(target, key);
        },
      },
    );
    expect(() => projectAssistantProviderError(throwing)).not.toThrow();
    expect(projectAssistantProviderError(throwing).isOk()).toBe(true);
    expect(projectAssistantProviderError(throwing)._unsafeUnwrap().class).toBe(
      "unknown",
    );
  });

  it("never classifies from JSON members even when they look authoritative", () => {
    expect(
      projectOk(errorEnd('{"error":{"type":"rate_limit_error"}}')).class,
    ).toBe("unknown");
    expect(
      projectOk(
        errorEnd('{"type":"error","error":{"type":"overloaded_error"}}'),
      ).class,
    ).toBe("unknown");
    const openai = projectOk(
      errorEnd(
        '401 {"error":{"message":"bad key","param":null,"code":"invalid_api_key"}}',
      ),
    );
    expect(openai.code).toBeUndefined();
    expect(openai.class).toBe("auth");
    expect(openai.httpStatus).toBe(401);
  });
});

describe("child provider error identity labels", () => {
  it("never takes source, provider, or model from the event", () => {
    const projected = projectOk(
      errorEnd('429 {"error":{"type":"rate_limit_error"}}'),
    );
    expect(projected.source).toBeUndefined();
    expect(projected.provider).toBeUndefined();
    expect(projected.model).toBeUndefined();
    expect(Object.keys(projected).sort()).toEqual([
      "class",
      "httpStatus",
      "message",
    ]);
  });

  it("omits secret-shaped labels supplied through the event", () => {
    for (const label of [
      "sk-live-SENTINELKEY0001",
      "sk-SENTINELAPIKEYVALUE0002",
      "bearer-SENTINELTOKEN0003",
      "api_key",
      "session",
    ]) {
      const projected = projectAssistantProviderError({
        role: "assistant",
        stopReason: "error",
        api: label,
        provider: label,
        model: label,
        responseModel: label,
        errorMessage: "429 x",
      })._unsafeUnwrap();
      expect(projected.source).toBeUndefined();
      expect(projected.provider).toBeUndefined();
      expect(projected.model).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain("sk-");
      expect(JSON.stringify(projected)).not.toContain("SENTINEL");
    }
  });

  it("omits an arbitrary short ASCII label supplied through the event", () => {
    const projected = projectAssistantProviderError({
      role: "assistant",
      stopReason: "error",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5",
      errorMessage: "429 x",
    })._unsafeUnwrap();
    expect(projected.source).toBeUndefined();
    expect(projected.provider).toBeUndefined();
    expect(projected.model).toBeUndefined();
  });

  it("accepts labels only through the trusted controller descriptor seam", () => {
    const projected = projectAssistantProviderError(
      { role: "assistant", stopReason: "error", errorMessage: "429 x" },
      {
        source: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    )._unsafeUnwrap();
    expect(projected.source).toBe("anthropic-messages");
    expect(projected.provider).toBe("anthropic");
    expect(projected.model).toBe("claude-sonnet-5");
  });

  it("rejects secret-shaped and oversized labels even from the trusted seam", () => {
    const projected = projectAssistantProviderError(
      { role: "assistant", stopReason: "error", errorMessage: "429 x" },
      {
        source: "sk-live-SENTINELKEY0001",
        provider: "anthropic evil\u0007 name",
        model: "m".repeat(CHILD_PROVIDER_ERROR_BOUNDS.maxLabelLength + 1),
      },
    )._unsafeUnwrap();
    expect(projected.source).toBeUndefined();
    expect(projected.provider).toBeUndefined();
    expect(projected.model).toBeUndefined();
    expect(projected.class).toBe("rate-limit");
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
    for (const stopReason of [
      "stop",
      "length",
      "toolUse",
      "aborted",
      "pending",
      "deferred",
    ]) {
      expect(project(messageEnd({ stopReason }))?._unsafeUnwrapErr()).toEqual({
        type: "ProviderErrorCleared",
      });
    }
  });

  it("clears a valid carried error for every authoritative non-error stop reason", () => {
    for (const stopReason of [
      "stop",
      "length",
      "toolUse",
      "aborted",
      "pending",
      "deferred",
    ]) {
      expect(
        projectAssistantProviderError({
          role: "assistant",
          stopReason,
          weaveProviderError: {
            class: "auth",
            message: CANON.auth,
          },
        })._unsafeUnwrapErr(),
      ).toEqual({ type: "ProviderErrorCleared" });
    }
  });

  it("is unavailable for malformed, missing, and non-object messages", () => {
    for (const message of [undefined, null, 42, "boom", [], { role: 7 }]) {
      expect(projectAssistantProviderError(message).isErr()).toBe(true);
    }
    expect(
      projectAssistantProviderError({
        role: "assistant",
        stopReason: 500,
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "ProviderErrorUnavailable" });
  });

  it("rejects a tampered pre-projected historical payload", () => {
    for (const carried of [
      {
        class: "rate-limit",
        message: CANON["rate-limit"],
        errorMessage: SENTINELS.requestId,
      },
      { class: "rate-limit", message: `rate limited ${SENTINELS.requestId}` },
      { class: "rate-limit", message: CANON["rate-limit"], code: "sentinel" },
      { class: "sentinel", message: CANON.unknown },
      "not an object",
    ]) {
      expect(
        projectAssistantProviderError({
          role: "assistant",
          stopReason: "error",
          [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: carried,
        })._unsafeUnwrapErr(),
      ).toEqual({ type: "ProviderErrorUnavailable" });
    }
  });
});

describe("child provider error hostile boundary", () => {
  it("treats a throwing descriptor as absent instead of throwing", () => {
    const hostile = {
      role: "assistant",
      get stopReason(): string {
        throw new Error("hostile getter");
      },
    };
    expect(projectAssistantProviderError(hostile).isErr()).toBe(true);

    const partiallyHostile = {
      role: "assistant",
      stopReason: "error",
      get errorMessage(): string {
        throw new Error("hostile getter");
      },
    };
    const projected = projectAssistantProviderError(partiallyHostile);
    expect(projected.isOk()).toBe(true);
    expect(projected._unsafeUnwrap().class).toBe("unknown");
    expect(projected._unsafeUnwrap().message).toBe(CANON.unknown);
  });

  it("returns unavailable for a Proxy whose get trap throws", () => {
    const proxy = new Proxy(
      { role: "assistant", stopReason: "error" },
      {
        get(): never {
          throw new Error("hostile get trap");
        },
      },
    );
    const projected = projectAssistantProviderError(proxy);
    expect(projected.isErr()).toBe(true);
    expect(projected._unsafeUnwrapErr()).toEqual({
      type: "ProviderErrorUnavailable",
    });
  });

  it("returns unavailable for a Proxy whose ownKeys trap throws", () => {
    const proxy = new Proxy(
      { role: "assistant", stopReason: "error", errorMessage: "429 x" },
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    // Projection itself only needs `get`, so it still succeeds...
    expect(projectAssistantProviderError(proxy).isOk()).toBe(true);
    // ...and the allowlist copy never enumerates keys, so ownKeys is unused.
    const redacted = redactProviderErrorFromEvent({
      type: "message_end",
      message: proxy,
    } as never) as unknown as {
      type: string;
      message: Record<string, unknown>;
      secret?: unknown;
    };
    expect(redacted.type).toBe("message_end");
    expect(Object.keys(redacted).sort()).toEqual(["message", "type"]);
    expect(redacted.message.role).toBe("assistant");
    expect(redacted.message.stopReason).toBe("error");
    expect(redacted.message.errorMessage).toBeUndefined();
    expect(redacted.secret).toBeUndefined();
  });

  it("never throws on hostile top-level or nested getter/proxy message_end inputs", () => {
    const nestedThrowing = new Proxy(
      {
        role: "assistant",
        stopReason: "error",
        text: "kept",
        errorMessage: "429 x",
      },
      {
        get(target, key): unknown {
          if (key === "diagnostics") throw new Error("nested get");
          return Reflect.get(target, key);
        },
        getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
          if (key === "secret") throw new Error("nested descriptor");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const topLevelHostile = new Proxy(
      {
        type: "message_end",
        secret: SENTINELS.secret,
        diagnostics: { detail: SENTINELS.diagnostic },
        path: SENTINELS.path,
        responseId: SENTINELS.responseId,
        message: nestedThrowing,
      },
      {
        get(target, key): unknown {
          if (key === "headers") throw new Error("top-level get");
          return Reflect.get(target, key);
        },
        ownKeys(): never {
          throw new Error("top-level ownKeys");
        },
      },
    );
    expect(() =>
      redactProviderErrorFromEvent(topLevelHostile as never),
    ).not.toThrow();
    const redacted = redactProviderErrorFromEvent(
      topLevelHostile as never,
    ) as unknown as Record<string, unknown>;
    expect(redacted).toEqual({
      type: "message_end",
      message: expect.objectContaining({
        role: "assistant",
        stopReason: "error",
        text: "kept",
        [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: {
          class: "rate-limit",
          httpStatus: 429,
          message: CANON["rate-limit"],
        },
      }),
    });
    expect(Object.keys(redacted).sort()).toEqual(["message", "type"]);
    const serialized = JSON.stringify(redacted);
    for (const sentinel of [
      SENTINELS.secret,
      SENTINELS.diagnostic,
      SENTINELS.path,
      SENTINELS.responseId,
      "SENTINEL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("returns unavailable when a pre-projected payload throws during validation", () => {
    const carried = {
      get class(): string {
        throw new Error("hostile getter");
      },
    };
    const hostile = {
      role: "assistant",
      stopReason: "error",
      [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: carried,
    };
    expect(projectAssistantProviderError(hostile)._unsafeUnwrapErr()).toEqual({
      type: "ProviderErrorUnavailable",
    });
  });

  it("never throws on a hostile symbol or accessor descriptor", () => {
    const hostile: Record<string | symbol, unknown> = {};
    Object.defineProperty(hostile, "role", { value: "assistant" });
    Object.defineProperty(hostile, "stopReason", {
      get(): never {
        throw new Error("hostile accessor");
      },
      enumerable: true,
    });
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      get(): never {
        throw new Error("hostile symbol");
      },
    });
    expect(() => projectAssistantProviderError(hostile)).not.toThrow();
    expect(projectAssistantProviderError(hostile).isErr()).toBe(true);
    expect(() => historicalProviderErrorFacts(hostile)).not.toThrow();
    expect(historicalProviderErrorFacts(hostile)).toBeUndefined();
    expect(() => historicalAssistantMessageFields(hostile)).not.toThrow();
  });
});

describe("child provider error safe message copy", () => {
  const hostileMessage = {
    id: "msg_01HQ",
    role: "assistant",
    stopReason: "error",
    text: "final text",
    content: [{ type: "text", text: "final text" }],
    usage: { input: 3, output: 4 },
    model: "claude-sonnet-5",
    responseModel: "claude-sonnet-5-20260101",
    timestamp: 7,
    errorMessage: `500 ${SENTINELS.authorization} ${SENTINELS.path}`,
    rawStopReason: `raw ${SENTINELS.requestId}`,
    responseId: SENTINELS.responseId,
    diagnostics: { detail: SENTINELS.diagnostic, url: SENTINELS.url },
    api: "anthropic-messages",
    provider: "anthropic",
    deferred: { token: SENTINELS.token },
    weaveFutureExtension: { nested: { deep: SENTINELS.secret } },
  } as const;

  const redactedMessage = (): Record<string, unknown> => {
    const parsed = parsePiChildSessionEvent({
      type: "message_end",
      message: hostileMessage,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const redacted = redactProviderErrorFromEvent(parsed.data) as unknown as {
      message: Record<string, unknown>;
    };
    return redacted.message;
  };

  it("keeps only the allowlisted reducer-required fields", () => {
    const message = redactedMessage();
    const kept = Object.keys(message).filter(
      (key) => key !== CHILD_PROVIDER_ERROR_REPLAY_FIELD,
    );
    const allowlist: readonly string[] = [
      ...SAFE_ASSISTANT_MESSAGE_FIELDS,
      "usage",
      "contextUsage",
      "model",
    ];
    for (const key of kept) {
      expect(allowlist).toContain(key);
    }
    // The facts every reducer needs survive.
    expect(message.id).toBe("msg_01HQ");
    expect(message.role).toBe("assistant");
    expect(message.stopReason).toBe("error");
    expect(message.text).toBe("final text");
    expect(message.content).toEqual([{ type: "text", text: "final text" }]);
    expect(message.usage).toEqual({ input: 3, output: 4 });
    expect(message.model).toBe("claude-sonnet-5");
    expect(message.timestamp).toBe(7);
  });

  it("excludes responseId, diagnostics, raw error text, and extension fields", () => {
    const message = redactedMessage();
    for (const key of [
      "errorMessage",
      "rawStopReason",
      "responseId",
      "diagnostics",
      "api",
      "provider",
      "deferred",
      "weaveFutureExtension",
    ]) {
      expect(message).not.toHaveProperty(key);
    }
  });

  it("leaves no sentinel anywhere in the serialized redacted event", () => {
    const serialized = JSON.stringify(redactedMessage());
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
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
      "responseId",
      "diagnostics",
    ]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("attaches the canonical projection in place of the raw text", () => {
    const message = redactedMessage();
    expect(message[CHILD_PROVIDER_ERROR_REPLAY_FIELD]).toEqual({
      class: "provider-error",
      httpStatus: 500,
      message: CANON["provider-error"],
    });
  });

  it("returns non-terminal events unchanged and drops catchall on empty message_end", () => {
    const text = { type: "text", text: "hello" } as const;
    expect(redactProviderErrorFromEvent(text as never)).toBe(text as never);
    const empty = {
      type: "message_end",
      secret: SENTINELS.secret,
      path: SENTINELS.path,
    } as const;
    const redacted = redactProviderErrorFromEvent(empty as never);
    expect(redacted).toEqual({ type: "message_end" });
    expect(JSON.stringify(redacted)).not.toContain("SENTINEL");
  });

  it("never spreads parser catchall top-level fields on message_end", () => {
    const parsed = parsePiChildSessionEvent({
      type: "message_end",
      secret: SENTINELS.secret,
      diagnostics: { detail: SENTINELS.diagnostic },
      path: SENTINELS.path,
      responseId: SENTINELS.responseId,
      headers: { authorization: SENTINELS.authorization },
      weaveFutureExtension: { nested: SENTINELS.token },
      message: {
        ...hostileMessage,
        contextUsage: { tokens: 11, contextWindow: 100, percent: 11 },
        context: { tokens: 11, contextWindow: 100 },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    // Parser catchall may retain unknowns; this sanitizer must not.
    expect(
      Object.keys(parsed.data as unknown as Record<string, unknown>),
    ).toEqual(
      expect.arrayContaining([
        "type",
        "message",
        "secret",
        "diagnostics",
        "path",
        "responseId",
      ]),
    );
    const redacted = redactProviderErrorFromEvent(parsed.data) as unknown as {
      type: string;
      message: Record<string, unknown>;
    };
    expect(Object.keys(redacted).sort()).toEqual(["message", "type"]);
    expect(redacted.type).toBe("message_end");
    expect(redacted.message.text).toBe("final text");
    expect(redacted.message.content).toEqual([
      { type: "text", text: "final text" },
    ]);
    expect(redacted.message.stopReason).toBe("error");
    expect(redacted.message.usage).toEqual({ input: 3, output: 4 });
    expect(redacted.message.model).toBe("claude-sonnet-5");
    expect(redacted.message.contextUsage).toEqual({
      tokens: 11,
      contextWindow: 100,
    });
    expect(redacted.message.context).toBeUndefined();
    expect(redacted.message[CHILD_PROVIDER_ERROR_REPLAY_FIELD]).toEqual({
      class: "provider-error",
      httpStatus: 500,
      message: CANON["provider-error"],
    });
    const serialized = JSON.stringify(redacted);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
    for (const key of [
      "secret",
      "diagnostics",
      "path",
      "responseId",
      "headers",
      "errorMessage",
      "weaveFutureExtension",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });
});

describe("child provider error sanitization sentinels", () => {
  const assertClean = (projected: PiChildProviderError): void => {
    const serialized = JSON.stringify(projected);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
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
    for (const fragment of ["http", "{", "}", "[", "]", "<", ">", "\\", "/"]) {
      expect(projected.message).not.toContain(fragment);
    }
    expect([...PI_CHILD_ERROR_MESSAGES]).toContain(projected.message);
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
    const projected = projectOk(errorEnd(hostile));
    expect(projected.class).toBe("rate-limit");
    expect(projected.message).toBe(CANON["rate-limit"]);
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
      "500 \u0007\u202e\u200b\u2066garbled\u2069",
      `500 {"raw":{"nested":{"deeper":["a","b"]}},"note":"opaque"}`,
      `400 {"error":{"type":"invalid_request_error","message":"bad"},"messages":[{"role":"user","content":"${SENTINELS.prompt}"}]}`,
    ];
    for (const vector of vectors) {
      assertClean(projectOk(errorEnd(vector)));
    }
  });

  it("keeps an oversized payload out entirely", () => {
    const projected = projectOk(
      errorEnd(`429 rate limit exceeded. ${"padding text ".repeat(600)}`),
    );
    expect(projected.class).toBe("rate-limit");
    expect(projected.message).toBe(CANON["rate-limit"]);
    assertClean(projected);
  });
});

describe("terminal error evidence semantics", () => {
  const anError = projectOk(errorEnd("429 x"));

  const errorEvidence = { kind: "error", error: anError } as const;

  it("exposes only the error to callers, never the tri-state", () => {
    expect(terminalErrorOf(errorEvidence)).toEqual(anError);
    expect(terminalErrorOf(CLEARED_TERMINAL_ERROR_EVIDENCE)).toBeUndefined();
    expect(terminalErrorOf(NO_TERMINAL_ERROR_EVIDENCE)).toBeUndefined();
  });

  it("lets newer evidence win in both directions", () => {
    expect(
      adoptNewerEvidence(NO_TERMINAL_ERROR_EVIDENCE, errorEvidence),
    ).toEqual(errorEvidence);
    expect(
      adoptNewerEvidence(errorEvidence, CLEARED_TERMINAL_ERROR_EVIDENCE),
    ).toEqual(CLEARED_TERMINAL_ERROR_EVIDENCE);
    expect(
      adoptNewerEvidence(CLEARED_TERMINAL_ERROR_EVIDENCE, errorEvidence),
    ).toEqual(errorEvidence);
    // Newer side proves nothing: nothing changes.
    expect(
      adoptNewerEvidence(errorEvidence, NO_TERMINAL_ERROR_EVIDENCE),
    ).toEqual(errorEvidence);
    expect(
      adoptNewerEvidence(
        CLEARED_TERMINAL_ERROR_EVIDENCE,
        NO_TERMINAL_ERROR_EVIDENCE,
      ),
    ).toEqual(CLEARED_TERMINAL_ERROR_EVIDENCE);
  });

  it("lets older evidence fill only an unknown state", () => {
    expect(
      adoptOlderEvidence(NO_TERMINAL_ERROR_EVIDENCE, errorEvidence),
    ).toEqual(errorEvidence);
    // A newer success is never overwritten by an older error: the bug fix.
    expect(
      adoptOlderEvidence(CLEARED_TERMINAL_ERROR_EVIDENCE, errorEvidence),
    ).toEqual(CLEARED_TERMINAL_ERROR_EVIDENCE);
    expect(
      adoptOlderEvidence(errorEvidence, CLEARED_TERMINAL_ERROR_EVIDENCE),
    ).toEqual(errorEvidence);
  });

  it("treats an unauthoritative live event as no evidence", () => {
    const parsed = parsePiChildSessionEvent({ type: "text", text: "hi" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const applied = applyProviderErrorEvent(errorEvidence, parsed.data);
    expect(applied.evidence).toEqual(errorEvidence);
    expect(applied.event).toBe(parsed.data);
  });

  it("finds no evidence in an empty window", () => {
    expect(latestWindowErrorEvidence([])).toEqual(NO_TERMINAL_ERROR_EVIDENCE);
    expect(latestWindowError([])).toBeUndefined();
  });

  it("adopts page evidence in the direction the page travels", () => {
    // A forward or replacement page is the authoritative newest view.
    expect(pageEvidence(errorEvidence, [], "newer")).toEqual(errorEvidence);
    expect(pageEvidence(errorEvidence, [], "older")).toEqual(errorEvidence);
    expect(pageEvidence(CLEARED_TERMINAL_ERROR_EVIDENCE, [], "older")).toEqual(
      CLEARED_TERMINAL_ERROR_EVIDENCE,
    );
    expect(pageEvidence(NO_TERMINAL_ERROR_EVIDENCE, [], "newer")).toEqual(
      NO_TERMINAL_ERROR_EVIDENCE,
    );
  });

  it("exposes an optional terminalError fragment and nothing else", () => {
    expect(terminalErrorView(errorEvidence)).toEqual({
      terminalError: anError,
    });
    expect(terminalErrorView(CLEARED_TERMINAL_ERROR_EVIDENCE)).toEqual({});
    expect(terminalErrorView(NO_TERMINAL_ERROR_EVIDENCE)).toEqual({});
    expect(
      Object.hasOwn(
        terminalErrorView(CLEARED_TERMINAL_ERROR_EVIDENCE),
        "terminalError",
      ),
    ).toBe(false);
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

  const nativeUser = (
    id: string,
  ): { readonly id: string; readonly payload: unknown } => ({
    id,
    payload: {
      type: "message",
      id,
      message: { role: "user", content: [{ type: "text", text: "ask" }] },
    },
  });

  const historicalError = (id: string, errorMessage: string) =>
    nativeAssistant(id, { stopReason: "error", errorMessage });

  const historicalSuccess = (id: string) =>
    nativeAssistant(id, { stopReason: "stop" });

  async function open(
    children: readonly MemoryOverlaySourceChild[],
    childId: string,
    config?: { readonly pageSize?: number; readonly windowCap?: number },
  ): Promise<{
    controller: ReturnType<typeof createChildOverlayController>;
    view: ChildOverlayView;
  }> {
    const controller = createChildOverlayController(
      createMemoryChildOverlaySource(children),
      config,
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

  const older = async (
    controller: ReturnType<typeof createChildOverlayController>,
  ): Promise<ChildOverlayView> => {
    const loaded = await controller.loadOlder();
    expect(loaded.isOk()).toBe(true);
    return loaded._unsafeUnwrap();
  };

  const newer = async (
    controller: ReturnType<typeof createChildOverlayController>,
  ): Promise<ChildOverlayView> => {
    const loaded = await controller.loadNewer();
    expect(loaded.isOk()).toBe(true);
    return loaded._unsafeUnwrap();
  };

  it("exposes no terminal error before one is observed", async () => {
    const { view } = await open([liveChild("child-a")], "child-a");
    expect(view.terminalError).toBeUndefined();
    expect(Object.hasOwn(view, "terminalError")).toBe(false);
  });

  it("consumes a hostile live event without throwing or corrupting state", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    const established = apply(controller, errorEnd("429 rate limit reached"));
    expect(established.terminalError?.class).toBe("rate-limit");

    const hostile: readonly unknown[] = [
      {
        get type(): string {
          throw new Error("hostile type getter");
        },
      },
      new Proxy(
        { type: "message_end", message: { role: "assistant" } },
        {
          get(): never {
            throw new Error("hostile get trap");
          },
        },
      ),
      new Proxy(
        { type: "definitely_unknown_kind", payload: { a: 1 } },
        {
          ownKeys(): never {
            throw new Error("hostile ownKeys trap");
          },
        },
      ),
      {
        type: "message_end",
        get message(): unknown {
          throw new Error("hostile nested getter");
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          get usage(): unknown {
            throw new Error("hostile usage getter");
          },
        },
      },
    ];

    for (const event of hostile) {
      expect(() => controller.applyLiveEvent(event)).not.toThrow();
      const view = apply(controller, event);
      // The event is ignored outright: the retained error is neither replaced
      // nor cleared, and no entry is admitted from an unreadable event.
      expect(view.terminalError).toEqual(established.terminalError);
      expect(view.entries).toEqual(established.entries);
      expect(JSON.stringify(view)).not.toContain("hostile");
    }

    // The controller is still live: a real later event is applied normally.
    const cleared = apply(
      controller,
      messageEnd({ stopReason: "stop", text: "recovered" }),
    );
    expect(cleared.terminalError).toBeUndefined();
    const replaced = apply(controller, errorEnd("401 invalid_api_key"));
    expect(replaced.terminalError?.class).toBe("auth");
  });

  it("retains only the latest terminal error, replacing the prior one", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    const first = apply(controller, errorEnd("429 rate limit reached"));
    expect(first.terminalError?.class).toBe("rate-limit");
    const second = apply(controller, errorEnd("503 overloaded_error"));
    expect(second.terminalError?.class).toBe("overload");
    expect(second.terminalError?.httpStatus).toBe(503);
  });

  it("clears the retained error when a later live turn succeeds", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    expect(
      apply(controller, errorEnd("429 rate limit reached")).terminalError,
    ).toBeDefined();
    const success = apply(controller, messageEnd({ stopReason: "stop" }));
    expect(success.terminalError).toBeUndefined();
    expect(controller.requireFallback().terminalError).toBeUndefined();
    expect(Object.hasOwn(controller.requireFallback(), "terminalError")).toBe(
      false,
    );
    // A later error after the success sets it again.
    expect(apply(controller, errorEnd("ECONNRESET")).terminalError?.class).toBe(
      "connection",
    );
  });

  it("leaves the retained error untouched for unauthoritative live events", async () => {
    const { controller } = await open([liveChild("child-a")], "child-a");
    apply(controller, errorEnd("429 rate limit reached"));
    expect(
      apply(controller, { type: "text", text: "still talking" }).terminalError
        ?.class,
    ).toBe("rate-limit");
    expect(
      apply(controller, {
        type: "message_end",
        message: { role: "user", content: "hi", stopReason: "error" },
      }).terminalError?.class,
    ).toBe("rate-limit");
  });

  it("isolates the evidence per child", async () => {
    const { controller } = await open(
      [liveChild("child-a"), liveChild("child-b")],
      "child-a",
    );
    apply(controller, errorEnd("429 rate limit reached"));
    expect(controller.requireFallback().terminalError?.class).toBe(
      "rate-limit",
    );
    const other = await controller.open("child-b");
    expect(other.isOk()).toBe(true);
    expect(other._unsafeUnwrap().terminalError).toBeUndefined();
    expect(controller.requireFallback().terminalError).toBeUndefined();
    // child-b clearing its own state must not clear child-a's.
    const controllerB = controller;
    apply(controllerB, messageEnd({ stopReason: "stop" }));
    const back = await controller.open("child-a");
    expect(back._unsafeUnwrap().terminalError?.class).toBe("rate-limit");
    expect(controller.requireFallback().terminalError?.class).toBe(
      "rate-limit",
    );
  });

  it("keeps the error on a settled view and fallback rebuilt from history", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-h", [
          historicalError(
            "entry-1",
            `429 {"type":"error","error":{"type":"rate_limit_error","message":"exceeded"}} ${SENTINELS.requestId}`,
          ),
        ]),
      ],
      "child-h",
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    expect(view.terminalError?.httpStatus).toBe(429);
    expect(view.terminalError?.code).toBeUndefined();
    expect(view.terminalError?.message).toBe(CANON["rate-limit"]);
    const fallback = controller.requireFallback();
    expect(fallback.terminalError).toEqual(view.terminalError);
    const serialized = JSON.stringify(fallback);
    expect(serialized).not.toContain(SENTINELS.requestId);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("omits unavailable evidence from source-error fallback", async () => {
    const source: ChildOverlaySourcePort = {
      describe: () => errAsync({ type: "ChildNotFound", childId: "missing" }),
      loadNewest: () =>
        errAsync({ type: "SourceUnavailable", operation: "loadNewest" }),
      loadOlder: () =>
        errAsync({ type: "SourceUnavailable", operation: "loadOlder" }),
      loadNewer: () =>
        errAsync({ type: "SourceUnavailable", operation: "loadNewer" }),
    };
    const controller = createChildOverlayController(source);
    const opened = await controller.open("missing");
    expect(opened.isErr()).toBe(true);
    const fallback = opened._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(fallback.terminalError).toBeUndefined();
    expect(Object.hasOwn(fallback, "terminalError")).toBe(false);
  });

  it("takes the newest historical evidence inside the replacement window", async () => {
    const { view } = await open(
      [
        settledChild("child-h", [
          historicalError("entry-1", "429 rate limit reached"),
          historicalError("entry-2", "503 overloaded_error"),
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
          historicalError("entry-1", "429 rate limit reached"),
          historicalSuccess("entry-2"),
        ]),
      ],
      "child-h",
    );
    expect(view.terminalError).toBeUndefined();
  });

  it("lets a live error replace a historical one", async () => {
    const { controller, view } = await open(
      [liveChild("child-m", [historicalError("entry-1", "429 rate limit")])],
      "child-m",
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    expect(apply(controller, errorEnd("ECONNRESET")).terminalError?.class).toBe(
      "connection",
    );
  });

  it("lets a live success clear a historical error", async () => {
    const { controller, view } = await open(
      [liveChild("child-m", [historicalError("entry-1", "429 rate limit")])],
      "child-m",
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    expect(
      apply(controller, messageEnd({ stopReason: "stop" })).terminalError,
    ).toBeUndefined();
  });

  it("does not resurrect an older error when paging backwards past a success", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-p", [
          historicalError("entry-1", "429 rate limit reached"),
          historicalSuccess("entry-2"),
        ]),
      ],
      "child-p",
      { pageSize: 1, windowCap: 1 },
    );
    // Newest page carries the success, so evidence is `cleared`.
    expect(view.terminalError).toBeUndefined();
    // Prepending the older failed turn must not put the error back.
    const prepended = await older(controller);
    expect(prepended.terminalError).toBeUndefined();
  });

  it("does not resurrect an older error when paging backwards past a live success", async () => {
    const { controller } = await open(
      [
        liveChild("child-p", [
          historicalError("entry-1", "429 rate limit reached"),
          nativeUser("entry-2"),
        ]),
      ],
      "child-p",
      { pageSize: 1, windowCap: 1 },
    );
    // A live success clears before any backwards page is loaded.
    expect(
      apply(controller, messageEnd({ stopReason: "stop" })).terminalError,
    ).toBeUndefined();
    expect((await older(controller)).terminalError).toBeUndefined();
  });

  it("adopts an older error when nothing newer is known", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-p", [
          historicalError("entry-1", "429 rate limit reached"),
          nativeUser("entry-2"),
        ]),
      ],
      "child-p",
      { pageSize: 1, windowCap: 1 },
    );
    // The newest page holds a user turn: no terminal evidence at all.
    expect(view.terminalError).toBeUndefined();
    const prepended = await older(controller);
    expect(prepended.terminalError?.class).toBe("rate-limit");
  });

  it("does not let a prepend override a newer retained error", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-p", [
          historicalError("entry-1", "503 overloaded_error"),
          historicalError("entry-2", "429 rate limit reached"),
        ]),
      ],
      "child-p",
      { pageSize: 1, windowCap: 1 },
    );
    expect(view.terminalError?.class).toBe("rate-limit");
    const prepended = await older(controller);
    // The prepended page's only terminal turn is the older overload error.
    expect(prepended.terminalError?.class).toBe("rate-limit");
  });

  it("adopts newer evidence when appending forwards", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-q", [
          historicalError("entry-1", "429 rate limit reached"),
          historicalError("entry-2", "503 overloaded_error"),
        ]),
      ],
      "child-q",
      { pageSize: 1, windowCap: 1 },
    );
    expect(view.terminalError?.class).toBe("overload");
    // Page backwards, then forwards again: the newest page wins each time.
    expect((await older(controller)).terminalError?.class).toBe("overload");
    expect((await newer(controller)).terminalError?.class).toBe("overload");
  });

  it("clears when the appended newer page carries a success", async () => {
    const { controller, view } = await open(
      [
        liveChild("child-q", [
          historicalError("entry-1", "429 rate limit reached"),
          historicalSuccess("entry-2"),
        ]),
      ],
      "child-q",
      { pageSize: 1, windowCap: 1 },
    );
    expect(view.terminalError).toBeUndefined();
    // Force the retained state to an error, then append the successful page.
    expect(apply(controller, errorEnd("500 boom")).terminalError?.class).toBe(
      "provider-error",
    );
    await older(controller);
    expect((await newer(controller)).terminalError).toBeUndefined();
  });

  it("keeps an appended page that carries no terminal turn from changing state", async () => {
    const { controller, view } = await open(
      [
        settledChild("child-q", [
          historicalError("entry-1", "429 rate limit reached"),
          nativeUser("entry-2"),
        ]),
      ],
      "child-q",
      { pageSize: 1, windowCap: 1 },
    );
    expect(view.terminalError).toBeUndefined();
    await older(controller);
    expect((await newer(controller)).terminalError?.class).toBe("rate-limit");
  });

  it("never stores a raw errorMessage in the view or its serialization", async () => {
    const { controller, view } = await open(
      [
        liveChild("child-r", [
          nativeAssistant("entry-1", {
            stopReason: "error",
            errorMessage: `500 ${SENTINELS.authorization} ${SENTINELS.path}`,
            responseId: SENTINELS.responseId,
            diagnostics: { detail: SENTINELS.diagnostic },
          }),
        ]),
      ],
      "child-r",
    );
    const live = apply(
      controller,
      messageEnd({
        stopReason: "error",
        errorMessage: `500 ${SENTINELS.apiKey} ${SENTINELS.url}`,
        responseId: SENTINELS.responseId,
        diagnostics: {
          detail: SENTINELS.diagnostic,
          nested: { u: SENTINELS.url },
        },
      }),
    );
    for (const state of [view, live]) {
      const serialized = JSON.stringify(state);
      for (const fragment of [
        "errorMessage",
        "responseId",
        "diagnostics",
        "SENTINEL",
        "Bearer",
        "://",
        "rawStopReason",
      ]) {
        expect(serialized).not.toContain(fragment);
      }
    }
  });

  const assertReplayAndViewClean = (state: ChildOverlayView): void => {
    const full = JSON.stringify(state);
    const replayOnly = JSON.stringify(
      state.entries.map((entry) => entry.replay ?? []),
    );
    for (const serialized of [full, replayOnly]) {
      for (const sentinel of Object.values(SENTINELS)) {
        expect(serialized).not.toContain(sentinel);
      }
      for (const fragment of [
        "SENTINEL",
        "errorMessage",
        "rawStopReason",
        '"secret"',
        '"diagnostics"',
        '"responseId"',
        '"headers"',
        "Bearer",
        "://",
      ]) {
        expect(serialized).not.toContain(fragment);
      }
    }
  };

  it("drops live message_end top-level and nested catchall from replay and view", async () => {
    const { controller } = await open(
      [liveChild("child-live-catch")],
      "child-live-catch",
    );
    const live = apply(controller, {
      type: "message_end",
      secret: SENTINELS.secret,
      diagnostics: { detail: SENTINELS.diagnostic },
      path: SENTINELS.path,
      responseId: SENTINELS.responseId,
      headers: { authorization: SENTINELS.authorization },
      message: {
        id: "msg_live_catch",
        role: "assistant",
        stopReason: "error",
        text: "live terminal text",
        content: [{ type: "text", text: "live terminal text" }],
        usage: {
          input: 8,
          output: 2,
          totalTokens: 10,
          authorization: SENTINELS.authorization,
          cost: { total: 999, token: SENTINELS.token },
          nested: { path: SENTINELS.path, url: SENTINELS.url },
        },
        model: "claude-sonnet-5",
        responseModel: "claude-sonnet-5-20260101",
        contextUsage: { tokens: 20, contextWindow: 200, percent: 10 },
        context: { tokens: 20, contextWindow: 200 },
        timestamp: 9,
        errorMessage: `429 ${SENTINELS.apiKey} ${SENTINELS.url}`,
        rawStopReason: `raw ${SENTINELS.requestId}`,
        responseId: SENTINELS.responseId,
        diagnostics: { detail: SENTINELS.diagnostic },
        path: SENTINELS.path,
        secret: SENTINELS.secret,
        api: "anthropic-messages",
        provider: "anthropic",
      },
    });
    expect(live.terminalError).toEqual({
      class: "rate-limit",
      httpStatus: 429,
      message: CANON["rate-limit"],
    });
    const assistant = live.entries.find((entry) => entry.kind === "assistant");
    expect(assistant?.text).toContain("live terminal text");
    const endStep = (assistant?.replay ?? []).find(
      (step) => step.kind === "event" && step.event.type === "message_end",
    );
    expect(endStep).toBeDefined();
    if (endStep === undefined || endStep.kind !== "event") {
      throw new Error("unreachable");
    }
    expect(Object.keys(endStep.event).sort()).toEqual(["message", "type"]);
    const endMessage = (
      endStep.event as {
        message: Record<string, unknown>;
      }
    ).message;
    expect(endMessage.text).toBe("live terminal text");
    expect(endMessage.content).toEqual([
      { type: "text", text: "live terminal text" },
    ]);
    expect(endMessage.stopReason).toBe("error");
    expect(endMessage.usage).toEqual({
      input: 8,
      output: 2,
      totalTokens: 10,
    });
    expect(endMessage.model).toBe("claude-sonnet-5");
    expect(endMessage.contextUsage).toEqual({
      tokens: 20,
      contextWindow: 200,
    });
    expect(endMessage.context).toBeUndefined();
    expect(endMessage[CHILD_PROVIDER_ERROR_REPLAY_FIELD]).toEqual({
      class: "rate-limit",
      httpStatus: 429,
      message: CANON["rate-limit"],
    });
    assertReplayAndViewClean(live);

    const cleared = apply(
      controller,
      messageEnd({
        stopReason: "stop",
        text: "recovered after error",
        content: [{ type: "text", text: "recovered after error" }],
        usage: { input: 1, output: 1 },
        model: "claude-sonnet-5",
        secret: SENTINELS.secret,
        diagnostics: { detail: SENTINELS.diagnostic },
      }),
    );
    expect(cleared.terminalError).toBeUndefined();
    expect(Object.hasOwn(cleared, "terminalError")).toBe(false);
    assertReplayAndViewClean(cleared);
  });

  it("drops historical message_end nested catchall from replay and view", async () => {
    const { view } = await open(
      [
        settledChild("child-hist-catch", [
          nativeAssistant("entry-hist-1", {
            stopReason: "error",
            text: "historical terminal text",
            content: [{ type: "text", text: "historical terminal text" }],
            usage: {
              input: 5,
              output: 6,
              cacheRead: 7,
              authorization: SENTINELS.authorization,
              cost: { total: 999, secret: SENTINELS.secret },
              nested: { path: SENTINELS.path, url: SENTINELS.url },
              [Symbol("historical-usage-secret")]: SENTINELS.token,
            },
            model: "claude-sonnet-5",
            contextUsage: { tokens: 15, contextWindow: 150, percent: 10 },
            context: { tokens: 15, contextWindow: 150 },
            errorMessage: `503 ${SENTINELS.secret} ${SENTINELS.path}`,
            responseId: SENTINELS.responseId,
            diagnostics: { detail: SENTINELS.diagnostic },
            path: SENTINELS.path,
            secret: SENTINELS.secret,
            headers: { authorization: SENTINELS.authorization },
          }),
        ]),
      ],
      "child-hist-catch",
    );
    expect(view.terminalError).toEqual({
      class: "overload",
      httpStatus: 503,
      message: CANON.overload,
    });
    const assistant = view.entries.find((entry) => entry.kind === "assistant");
    expect(assistant?.text).toContain("historical terminal text");
    const endStep = (assistant?.replay ?? []).find(
      (step) => step.kind === "event" && step.event.type === "message_end",
    );
    expect(endStep).toBeDefined();
    if (endStep === undefined || endStep.kind !== "event") {
      throw new Error("unreachable");
    }
    expect(Object.keys(endStep.event).sort()).toEqual(["message", "type"]);
    const endMessage = (
      endStep.event as {
        message: Record<string, unknown>;
      }
    ).message;
    expect(endMessage.stopReason).toBe("error");
    expect(endMessage.usage).toEqual({
      input: 5,
      output: 6,
      cacheRead: 7,
    });
    expect(endMessage.model).toBe("claude-sonnet-5");
    expect(endMessage[CHILD_PROVIDER_ERROR_REPLAY_FIELD]).toEqual({
      class: "overload",
      httpStatus: 503,
      message: CANON.overload,
    });
    assertReplayAndViewClean(view);
  });
});

describe("historical replay projection helpers", () => {
  it("carries the authoritative stop reason and the canonical projection", () => {
    const facts = historicalProviderErrorFacts({
      role: "assistant",
      stopReason: "error",
      errorMessage: `429 rate limit reached ${SENTINELS.requestId}`,
    });
    expect(facts?.stopReason).toBe("error");
    expect(facts?.providerError?.class).toBe("rate-limit");
    expect(facts?.providerError?.message).toBe(CANON["rate-limit"]);
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

  it("carries usage, model, stop reason, and the projection but no raw text", () => {
    const fields = historicalAssistantMessageFields({
      role: "assistant",
      stopReason: "error",
      model: "claude-sonnet-5",
      usage: { input: 5, output: 6 },
      errorMessage: `429 rate limit ${SENTINELS.requestId}`,
      responseId: SENTINELS.responseId,
      diagnostics: { detail: SENTINELS.diagnostic },
    });
    expect(fields.stopReason).toBe("error");
    expect(fields.model).toBe("claude-sonnet-5");
    expect(fields.usage).toEqual({ input: 5, output: 6 });
    expect(fields[CHILD_PROVIDER_ERROR_REPLAY_FIELD]).toEqual({
      class: "rate-limit",
      httpStatus: 429,
      message: CANON["rate-limit"],
    });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("SENTINEL");
    expect(serialized).not.toContain("errorMessage");
    expect(serialized).not.toContain("responseId");
    expect(serialized).not.toContain("diagnostics");
  });

  it("is an empty record for a non-object message", () => {
    expect(historicalAssistantMessageFields(42)).toEqual({});
  });
});
