import { describe, expect, it } from "bun:test";
import {
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
      code: "rate_limit_error",
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

  it("reads an allowlisted code from an anchored error envelope", () => {
    const anthropic = projectOk(
      errorEnd('{"type":"error","error":{"type":"authentication_error"}}'),
    );
    expect(anthropic.code).toBe("authentication_error");
    expect(anthropic.class).toBe("auth");
    expect(anthropic.message).toBe(CANON.auth);

    const bare = projectOk(errorEnd('{"error":{"type":"abort_err"}}'));
    expect(bare.code).toBe("abort_err");
    expect(bare.class).toBe("cancelled");

    // A code that follows a message member inside the anchored envelope is
    // still anchored evidence.
    const later = projectOk(
      errorEnd(
        '400 {"error":{"message":"bad request","type":"invalid_request_error"}}',
      ),
    );
    expect(later.code).toBe("invalid_request_error");
    expect(later.class).toBe("provider-error");
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

  it("does not mine an unanchored or non-envelope structure for a code", () => {
    // No `"error": {` at offset zero, so nothing inside is evidence.
    for (const raw of [
      '{"data":{"error":{"type":"rate_limit_error"}}}',
      '{"raw":{"nested":{"type":"rate_limit_error"}}}',
      'prefix {"error":{"type":"rate_limit_error"}}',
    ]) {
      const projected = projectOk(errorEnd(raw));
      expect(projected.code).toBeUndefined();
      expect(projected.class).toBe("unknown");
    }
  });

  it("ignores an allowlisted code beyond the bounded envelope window", () => {
    const padding = `"note":"${"p".repeat(
      CHILD_PROVIDER_ERROR_BOUNDS.maxEnvelopeWindow + 40,
    )}",`;
    const projected = projectOk(
      errorEnd(`{"error":{${padding}"type":"rate_limit_error"}}`),
    );
    expect(projected.code).toBeUndefined();
    expect(projected.class).toBe("unknown");
  });

  it("pins precedence when status and code disagree", () => {
    // Status says server error, code says rate limit: rate-limit outranks.
    const projected = projectOk(
      errorEnd('500 {"error":{"type":"rate_limit_error"}}'),
    );
    expect(projected.class).toBe("rate-limit");
    expect(projected.httpStatus).toBe(500);
    // Status says rate limit, code says connection: rate-limit outranks.
    expect(
      projectOk(errorEnd('429 {"error":{"type":"econnreset"}}')).class,
    ).toBe("rate-limit");
    // Auth outranks timeout, timeout outranks overload.
    expect(
      projectOk(errorEnd('504 {"error":{"type":"authentication_error"}}'))
        .class,
    ).toBe("auth");
    expect(
      projectOk(errorEnd('503 {"error":{"type":"gateway_timeout"}}')).class,
    ).toBe("timeout");
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

  it("still classifies an anchored known envelope beside content keys", () => {
    // The anchored evidence is at offset zero, so trailing content is ignored
    // rather than allowed to suppress a real fact.
    const projected = projectOk(
      errorEnd(
        `429 {"type":"error","error":{"type":"rate_limit_error"}} messages ${SENTINELS.prompt}`,
      ),
    );
    expect(projected.class).toBe("rate-limit");
    expect(projected.httpStatus).toBe(429);
    expect(projected.code).toBe("rate_limit_error");
  });
});

describe("child provider error direct envelope members", () => {
  /**
   * The envelope scan reads exactly two positions: the direct top-level
   * `error` member, and the direct `type` / `code` members of the object it
   * holds. Every fixture below places an allowlisted code somewhere else and
   * asserts that the class stays `unknown`, which is what makes model output
   * unable to pick Weave's error class.
   */
  const noForge = (raw: string): void => {
    const projected = projectOk(errorEnd(raw));
    expect(projected.code).toBeUndefined();
    expect(projected.class).toBe("unknown");
    expect(projected.message).toBe(CANON.unknown);
  };

  it("ignores a code nested inside the error object", () => {
    noForge('{"error":{"completion":{"type":"rate_limit_error"}}}');
    noForge('{"error":{"details":{"code":"invalid_api_key"}}}');
    noForge(
      '{"error":{"message":"failed","details":[{"code":"invalid_api_key"}]}}',
    );
    noForge('{"type":"error","error":{"cause":{"type":"econnreset"}}}');
    // Deeply nested is no different: nesting is skipped, never read.
    noForge('{"error":{"a":{"b":{"c":{"d":{"type":"rate_limit_error"}}}}}}');
  });

  it("ignores a code in a sibling of the error envelope", () => {
    noForge('{"error":{},"completion":{"code":"invalid_api_key"}}');
    noForge('{"error":{"message":"failed"},"code":"rate_limit_error"}');
    noForge(
      `{"error":{},"completion":"${SENTINELS.completion} rate_limit_error"}`,
    );
    noForge('{"error":{},"diagnostics":{"type":"overloaded_error"}}');
    // A sibling that precedes the envelope is equally out of reach.
    noForge('{"prompt":{"type":"rate_limit_error"},"error":{}}');
  });

  it("ignores an error member that is not an object", () => {
    noForge('{"error":["rate_limit_error"]}');
    noForge('{"error":"rate_limit_error"}');
    noForge('{"error":429}');
    noForge('{"error":null}');
  });

  it("ignores a code-bearing member that is not a direct string", () => {
    noForge('{"error":{"type":{"value":"rate_limit_error"}}}');
    noForge('{"error":{"code":["invalid_api_key"]}}');
  });

  it("never reads an inherited or prototype-injected member", () => {
    noForge('{"error":{"__proto__":{"type":"rate_limit_error"}}}');
    noForge('{"__proto__":{"error":{"type":"rate_limit_error"}}}');
    noForge('{"error":{"constructor":{"type":"invalid_api_key"}}}');

    // The scan creates no object, so a real prototype carrying the member
    // cannot contribute either.
    const inherited = Object.create({
      errorMessage: '{"error":{"type":"rate_limit_error"}}',
    }) as Record<string, unknown>;
    inherited.role = "assistant";
    inherited.stopReason = "error";
    const projected = projectAssistantProviderError(inherited);
    expect(projected.isOk()).toBe(true);
    // `errorMessage` lives on the prototype, so the projection reads the raw
    // value through the normal property read and still yields only bounded,
    // canonical facts — no provider prose and no forged nesting.
    expect(projected._unsafeUnwrap().message).toBe(
      CANON[projected._unsafeUnwrap().class],
    );
  });

  it("discards duplicate and ambiguous direct members", () => {
    noForge('{"error":{"type":"rate_limit_error","type":"econnreset"}}');
    noForge('{"error":{"code":"invalid_api_key","code":"invalid_api_key"}}');
    // A first sighting that carries no usable token still counts, so a later
    // duplicate cannot become the single authoritative spelling.
    noForge('{"error":{"type":{},"type":"rate_limit_error"}}');
    noForge('{"error":{"code":"not_allowlisted_x","code":"invalid_api_key"}}');
    // Duplicating `type` does not promote a nested code either.
    noForge(
      '{"error":{"type":"rate_limit_error","type":"rate_limit_error","details":{"code":"invalid_api_key"}}}',
    );
  });

  it("never accepts an escaped or oversized literal as a token", () => {
    noForge(String.raw`{"error":{"type":"rate_limit\u005Ferror"}}`);
    noForge(String.raw`{"error":{"typ\u0065":"rate_limit_error"}}`);
    noForge(
      `{"error":{"type":"${"z".repeat(
        CHILD_PROVIDER_ERROR_BOUNDS.maxEnvelopeToken + 8,
      )}"}}`,
    );
  });

  it("yields no evidence for malformed, truncated, or oversized JSON", () => {
    noForge('{"error":{"type":"rate_limit_error"');
    noForge('{"error":{"type" "rate_limit_error"}}');
    noForge('{"error"{"type":"rate_limit_error"}}');
    // Beyond the scan bound the envelope is truncated mid-structure, so the
    // code that follows the padding is never reached.
    const padding = "q".repeat(CHILD_PROVIDER_ERROR_BOUNDS.maxScanLength);
    noForge(`{"note":"${padding}","error":{"type":"rate_limit_error"}}`);
    // Too many direct members to be a genuine envelope.
    const many = Array.from(
      { length: CHILD_PROVIDER_ERROR_BOUNDS.maxEnvelopeMembers + 4 },
      (_unused, index) => `"k${index}":${index}`,
    ).join(",");
    noForge(`{${many},"error":{"type":"rate_limit_error"}}`);
  });

  it("stays typed and quiet for a hostile envelope proxy", () => {
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
    // The nested forge is out of reach even though the value was read.
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

  it("still classifies a direct error type or code", () => {
    expect(
      projectOk(errorEnd('{"error":{"type":"rate_limit_error"}}')).class,
    ).toBe("rate-limit");
    expect(
      projectOk(
        errorEnd('{"type":"error","error":{"type":"overloaded_error"}}'),
      ).class,
    ).toBe("overload");
    // A direct `code` beside prose members is read.
    const openai = projectOk(
      errorEnd(
        '401 {"error":{"message":"bad key","param":null,"code":"invalid_api_key"}}',
      ),
    );
    expect(openai.code).toBe("invalid_api_key");
    expect(openai.class).toBe("auth");
    // `type` outranks `code` when both direct members are allowlisted.
    const both = projectOk(
      errorEnd(
        '{"error":{"type":"rate_limit_error","code":"invalid_api_key"}}',
      ),
    );
    expect(both.code).toBe("rate_limit_error");
    expect(both.class).toBe("rate-limit");
    // An unallowlisted `type` falls through to a direct allowlisted `code`.
    const fallthrough = projectOk(
      errorEnd('{"error":{"type":"acct_9911_sentinel","code":"econnreset"}}'),
    );
    expect(fallthrough.code).toBe("econnreset");
    expect(fallthrough.class).toBe("connection");
    // The envelope may appear after another direct top-level member.
    expect(
      projectOk(errorEnd('{"id":"x","error":{"type":"etimedout"}}')).class,
    ).toBe("timeout");
    // Whitespace inside the envelope does not defeat the scan.
    expect(
      projectOk(errorEnd('{ "error" : { "type" : "permission_error" } }'))
        .class,
    ).toBe("auth");
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
      "code",
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
    // ...and the copy path degrades to the minimum instead of throwing.
    const redacted = redactProviderErrorFromEvent({
      type: "message_end",
      message: proxy,
    } as never) as unknown as { message: Record<string, unknown> };
    expect(redacted.message.role).toBe("assistant");
    expect(redacted.message.errorMessage).toBeUndefined();
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
    const allowlist: readonly string[] = SAFE_ASSISTANT_MESSAGE_FIELDS;
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

  it("returns non-terminal and message-less events unchanged", () => {
    const text = { type: "text", text: "hello" } as const;
    expect(redactProviderErrorFromEvent(text as never)).toBe(text as never);
    const empty = { type: "message_end" } as const;
    expect(redactProviderErrorFromEvent(empty as never)).toBe(empty as never);
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
    const other = await controller.open("child-b");
    expect(other.isOk()).toBe(true);
    expect(other._unsafeUnwrap().terminalError).toBeUndefined();
    // child-b clearing its own state must not clear child-a's.
    const controllerB = controller;
    apply(controllerB, messageEnd({ stopReason: "stop" }));
    const back = await controller.open("child-a");
    expect(back._unsafeUnwrap().terminalError?.class).toBe("rate-limit");
  });

  it("keeps the error on a settled view rebuilt from history", async () => {
    const { view } = await open(
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
    expect(view.terminalError?.code).toBe("rate_limit_error");
    expect(view.terminalError?.message).toBe(CANON["rate-limit"]);
    expect(JSON.stringify(view)).not.toContain(SENTINELS.requestId);
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
