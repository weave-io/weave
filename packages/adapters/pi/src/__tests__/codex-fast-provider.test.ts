import { describe, expect, it } from "bun:test";
import type {
  CodexFastEvidenceOutcome,
  CodexFastSnapshot,
} from "../codex-fast/attempt.js";
import {
  CODEX_EVIDENCE_SCAN_BUDGET_BYTES,
  createCodexServiceTierSniffer,
} from "../codex-fast/evidence-sniffer.js";
import type {
  CodexFastAttemptSink,
  CodexFastIntent,
  CodexFastIntentPort,
  CodexWrappableProvider,
} from "../codex-fast/provider.js";
import {
  CODEX_FAST_BLOCKED_REQUEST_MESSAGE,
  hasCodexSubscriptionAccountClaim,
  wrapCodexProviderForFast,
} from "../codex-fast/provider.js";
import {
  CODEX_FAST_ORIGINATOR,
  CODEX_FIRST_PARTY_BASE_URL,
  CODEX_ORIGINATOR_HEADER,
  CODEX_PROVIDER_ID,
  CODEX_ROUTING_HINT_HEADER,
} from "../codex-fast/routing.js";

/** Never echoed anywhere: not in a snapshot, not in a header, not in a body. */
const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

const ELIGIBLE_MODEL_ID = "gpt-5.6-sol";
const ELIGIBLE_RULE_ID = "codex-sub-06";

const EXPECTED_HINT = `model=${ELIGIBLE_MODEL_ID};tier=priority`;

/** A ChatGPT-shaped OAuth token whose payload carries the account claim. */
function subscriptionToken(accountId = "acct-fixture"): string {
  const payload = {
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  };
  const body = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${btoa('{"alg":"none"}')}.${body}.${btoa("sig")}`;
}

const SUBSCRIPTION_TOKEN = subscriptionToken();

type Recorded = {
  readonly model: unknown;
  readonly context: unknown;
  readonly options: unknown;
  readonly argCount: number;
};

type NativeHarness = {
  readonly provider: CodexWrappableProvider & Record<string, unknown>;
  readonly streamCalls: Recorded[];
  readonly streamSimpleCalls: Recorded[];
  readonly auth: object;
  readonly models: readonly { readonly id: string }[];
};

/**
 * A native provider stand-in with the same shape the real codex provider has.
 * Nothing here touches the network, the filesystem, or a process.
 */
function createNativeProvider(
  overrides: { readonly id?: string; readonly result?: unknown } = {},
): NativeHarness {
  const streamCalls: Recorded[] = [];
  const streamSimpleCalls: Recorded[] = [];
  const auth = Object.freeze({ oauth: Object.freeze({ kind: "chatgpt" }) });
  const models = Object.freeze([
    Object.freeze({ id: ELIGIBLE_MODEL_ID }),
    Object.freeze({ id: "gpt-5.4" }),
  ]);
  const result = overrides.result ?? Object.freeze({ kind: "native-stream" });
  const provider = {
    id: overrides.id ?? CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    baseUrl: CODEX_FIRST_PARTY_BASE_URL,
    auth,
    extraField: Object.freeze({ untouched: true }),
    getModels: () => models,
    refreshModels: async () => undefined,
    stream: (...args: never[]) => {
      streamCalls.push({
        model: args[0],
        context: args[1],
        options: args[2],
        argCount: args.length,
      });
      return result;
    },
    streamSimple: (...args: never[]) => {
      streamSimpleCalls.push({
        model: args[0],
        context: args[1],
        options: args[2],
        argCount: args.length,
      });
      return result;
    },
  };
  return { provider, streamCalls, streamSimpleCalls, auth, models };
}

function createSink(): {
  readonly sink: CodexFastAttemptSink;
  readonly snapshots: CodexFastSnapshot[];
} {
  const snapshots: CodexFastSnapshot[] = [];
  return {
    sink: {
      record: (snapshot) => {
        snapshots.push(snapshot);
      },
    },
    snapshots,
  };
}

function createIntentPort(
  intent: CodexFastIntent | undefined,
): CodexFastIntentPort & { readonly reads: () => number } {
  let reads = 0;
  return {
    readIntent: () => {
      reads += 1;
      return intent;
    },
    reads: () => reads,
  };
}

const FAST_INTENT: CodexFastIntent = Object.freeze({
  fast: true,
  modelId: ELIGIBLE_MODEL_ID,
});

function eligibleModel(): Record<string, unknown> {
  return { id: ELIGIBLE_MODEL_ID, baseUrl: CODEX_FIRST_PARTY_BASE_URL };
}

function baseOptions(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { apiKey: SUBSCRIPTION_TOKEN, temperature: 0.25, ...extra };
}

function last(snapshots: readonly CodexFastSnapshot[]): CodexFastSnapshot {
  const snapshot = snapshots[snapshots.length - 1];
  if (snapshot === undefined) {
    throw new Error("expected at least one snapshot");
  }
  return snapshot;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sseEvent(type: string, response: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
}

/** A readable body built from fixed chunks. No network, no timers. */
function bodyOf(
  chunks: readonly (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
  const queue = chunks.map((chunk) =>
    typeof chunk === "string" ? encode(chunk) : chunk,
  );
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue[index];
      index += 1;
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
}

async function drain(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    parts.push(chunk.value);
    total += chunk.value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * A scripted replacement for the host's `fetch`, handed to the wrapper through
 * `options.fetch`. Nothing here opens a socket; the responses are fixtures.
 */
function queuedFetch(responses: readonly (Response | Error)[]): {
  readonly fetch: (input: unknown, init?: unknown) => Promise<Response>;
  readonly inits: unknown[];
  readonly urls: unknown[];
} {
  const inits: unknown[] = [];
  const urls: unknown[] = [];
  let index = 0;
  return {
    fetch: async (url: unknown, init?: unknown): Promise<Response> => {
      urls.push(url);
      inits.push(init);
      const scripted = responses[index];
      index += 1;
      if (scripted === undefined) {
        throw new Error("no scripted response left");
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
    inits,
    urls,
  };
}

function sseResponse(
  chunks: readonly (string | Uint8Array)[],
  init: ResponseInit = {},
): Response {
  return new Response(bodyOf(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

/**
 * Run one eligible mapped call the way the real codex api does: take the
 * options the wrapper handed the native implementation, run its `onPayload`
 * chain, then drive its `fetch` once per scripted response.
 */
async function runMappedCall(input: {
  readonly payload?: unknown;
  readonly callerOnPayload?: (payload: unknown, model: unknown) => unknown;
  readonly init?: Record<string, unknown>;
  readonly responses?: readonly (Response | Error)[];
  readonly intent?: CodexFastIntent;
  readonly options?: Record<string, unknown>;
  readonly drainBodies?: boolean;
}): Promise<{
  readonly snapshots: readonly CodexFastSnapshot[];
  readonly sentInits: readonly unknown[];
  readonly payload: unknown;
  readonly bodies: readonly string[];
  readonly rejections: readonly unknown[];
  readonly options: Record<string, unknown>;
}> {
  const responses = input.responses ?? [];
  const native = createNativeProvider();
  const { sink, snapshots } = createSink();
  const scripted = queuedFetch(responses);
  const wrapped = wrapCodexProviderForFast(
    native.provider,
    createIntentPort(input.intent ?? FAST_INTENT),
    sink,
  )._unsafeUnwrap();

  wrapped.streamSimple(
    eligibleModel() as never,
    { messages: [] } as never,
    baseOptions({
      fetch: scripted.fetch,
      ...(input.callerOnPayload === undefined
        ? {}
        : { onPayload: input.callerOnPayload }),
      ...(input.options ?? {}),
    }) as never,
  );
  const recorded = native.streamSimpleCalls[0];
  if (recorded === undefined) {
    throw new Error("native was not called");
  }
  const options = recorded.options as Record<string, unknown>;

  const finalPayload = await (
    options.onPayload as (p: unknown, m: unknown) => Promise<unknown>
  )(input.payload ?? { model: ELIGIBLE_MODEL_ID, input: [] }, eligibleModel());

  const bodies: string[] = [];
  const rejections: unknown[] = [];
  const init = input.init ?? { method: "POST" };
  for (let index = 0; index < responses.length; index += 1) {
    const result = await (
      options.fetch as (u: unknown, i: unknown) => Promise<Response>
    )("https://chatgpt.com/backend-api/codex/responses", init).then(
      (response) => response,
      (error: unknown) => {
        rejections.push(error);
        return undefined;
      },
    );
    if (result !== undefined && input.drainBodies !== false) {
      bodies.push(await drain(result));
    }
  }

  return {
    snapshots,
    sentInits: scripted.inits,
    payload: finalPayload,
    bodies,
    rejections,
    options,
  };
}

describe("wrapCodexProviderForFast — provider shape", () => {
  it("preserves every native field except the two stream entry points", () => {
    const native = createNativeProvider();
    const { sink } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(undefined),
      sink,
    )._unsafeUnwrap();

    expect(wrapped.id).toBe(CODEX_PROVIDER_ID);
    expect(wrapped.name).toBe("OpenAI Codex");
    expect((wrapped as Record<string, unknown>).baseUrl).toBe(
      CODEX_FIRST_PARTY_BASE_URL,
    );
    expect((wrapped as Record<string, unknown>).auth).toBe(native.auth);
    expect((wrapped as Record<string, unknown>).extraField).toBe(
      native.provider.extraField,
    );
    expect((wrapped as Record<string, unknown>).getModels).toBe(
      native.provider.getModels,
    );
    expect((wrapped as Record<string, unknown>).refreshModels).toBe(
      native.provider.refreshModels,
    );
    expect(
      (wrapped as unknown as { getModels: () => unknown }).getModels(),
    ).toBe(native.models);
    expect(wrapped.stream).not.toBe(native.provider.stream);
    expect(wrapped.streamSimple).not.toBe(native.provider.streamSimple);
    expect(typeof wrapped.stream).toBe("function");
    expect(typeof wrapped.streamSimple).toBe("function");
  });

  it("leaves the native provider object itself untouched", () => {
    const native = createNativeProvider();
    const before = Object.keys(native.provider).sort();
    const nativeStream = native.provider.stream;
    const { sink } = createSink();
    wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    expect(Object.keys(native.provider).sort()).toEqual(before);
    expect(native.provider.stream).toBe(nativeStream);
  });

  it("returns the native stream result unchanged", () => {
    const marker = Object.freeze({ kind: "native-stream-instance" });
    const native = createNativeProvider({ result: marker });
    const { sink } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    const returned = wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions() as never,
    );
    expect(returned).toBe(marker);
  });

  it("fails closed when the native object cannot be wrapped", () => {
    const poisoned = new Proxy(
      {
        id: CODEX_PROVIDER_ID,
        stream: () => undefined,
        streamSimple: () => undefined,
      },
      {
        ownKeys: () => {
          throw new Error("hostile provider");
        },
      },
    ) as unknown as CodexWrappableProvider;
    const { sink } = createSink();
    const result = wrapCodexProviderForFast(
      poisoned,
      createIntentPort(FAST_INTENT),
      sink,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "provider-not-wrappable",
    });
  });
});

describe("wrapCodexProviderForFast — passthrough", () => {
  it("delegates with the exact options reference when no intent holds", () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const port = createIntentPort(undefined);
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      port,
      sink,
    )._unsafeUnwrap();
    const model = eligibleModel();
    const context = { messages: [] };
    const options = baseOptions();

    wrapped.stream(model as never, context as never, options as never);
    wrapped.streamSimple(model as never, context as never, options as never);

    expect(native.streamCalls).toHaveLength(1);
    expect(native.streamSimpleCalls).toHaveLength(1);
    for (const call of [native.streamCalls[0], native.streamSimpleCalls[0]]) {
      expect(call?.model).toBe(model);
      expect(call?.context).toBe(context);
      expect(call?.options).toBe(options);
    }
    expect(Object.keys(options).sort()).toEqual(["apiKey", "temperature"]);
    expect(snapshots).toEqual([]);
  });

  it("reads intent per call and never caches it", () => {
    const native = createNativeProvider();
    const { sink } = createSink();
    let intent: CodexFastIntent | undefined;
    const port: CodexFastIntentPort = { readIntent: () => intent };
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      port,
      sink,
    )._unsafeUnwrap();

    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions() as never,
    );
    intent = FAST_INTENT;
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions() as never,
    );
    intent = undefined;
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions() as never,
    );

    const [first, second, third] = native.streamSimpleCalls;
    expect(
      (first?.options as Record<string, unknown>).transport,
    ).toBeUndefined();
    expect((second?.options as Record<string, unknown>).transport).toBe("sse");
    expect(
      (third?.options as Record<string, unknown>).transport,
    ).toBeUndefined();
  });

  const ineligible: readonly {
    readonly name: string;
    readonly reason: string;
    readonly model: Record<string, unknown>;
    readonly intent: CodexFastIntent;
    readonly options: Record<string, unknown>;
    readonly providerId?: string;
  }[] = [
    {
      name: "a model outside the frozen allowlist",
      reason: "model-not-allowed",
      model: { id: "gpt-4o", baseUrl: CODEX_FIRST_PARTY_BASE_URL },
      intent: { fast: true, modelId: "gpt-4o" },
      options: baseOptions(),
    },
    {
      name: "a model id that cannot enter a header",
      reason: "model-id-unsafe",
      model: {
        id: "gpt-5.6-sol\r\nx-injected: 1",
        baseUrl: CODEX_FIRST_PARTY_BASE_URL,
      },
      intent: { fast: true, modelId: "gpt-5.6-sol\r\nx-injected: 1" },
      options: baseOptions(),
    },
    {
      name: "a request model the owner did not resolve",
      reason: "model-owner-mismatch",
      model: eligibleModel(),
      intent: { fast: true, modelId: "gpt-5.4" },
      options: baseOptions(),
    },
    {
      name: "a gateway base url",
      reason: "transport-not-first-party",
      model: { id: ELIGIBLE_MODEL_ID, baseUrl: "http://127.0.0.1:17399/v1" },
      intent: FAST_INTENT,
      options: baseOptions(),
    },
    {
      name: "a lookalike base url",
      reason: "transport-not-first-party",
      model: {
        id: ELIGIBLE_MODEL_ID,
        baseUrl: "https://chatgpt.com.evil.tld/backend-api",
      },
      intent: FAST_INTENT,
      options: baseOptions(),
    },
    {
      name: "a credential that is not a subscription token",
      reason: "auth-not-subscription",
      model: eligibleModel(),
      intent: FAST_INTENT,
      options: baseOptions({ apiKey: SECRET_SHAPED_INPUT }),
    },
    {
      name: "another provider",
      reason: "provider-not-codex",
      model: eligibleModel(),
      intent: FAST_INTENT,
      options: baseOptions(),
      providerId: "openai",
    },
  ];

  for (const testCase of ineligible) {
    it(`passes through unchanged for ${testCase.name}`, () => {
      const native = createNativeProvider(
        testCase.providerId === undefined ? {} : { id: testCase.providerId },
      );
      const { sink, snapshots } = createSink();
      const wrapped = wrapCodexProviderForFast(
        native.provider,
        createIntentPort(testCase.intent),
        sink,
      )._unsafeUnwrap();

      wrapped.streamSimple(
        testCase.model as never,
        {} as never,
        testCase.options as never,
      );

      expect(native.streamSimpleCalls[0]?.options).toBe(testCase.options);
      expect(snapshots).toHaveLength(1);
      expect(last(snapshots).state).toBe("unsupported");
      expect(last(snapshots).reason).toBe(testCase.reason as never);
      expect(last(snapshots).terminal).toBe(true);
      expect(JSON.stringify(snapshots)).not.toContain(SECRET_SHAPED_INPUT);
    });
  }

  it("passes through and degrades when the intent port throws", () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const port: CodexFastIntentPort = {
      readIntent: () => {
        throw new Error(`intent unavailable ${SECRET_SHAPED_INPUT}`);
      },
    };
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      port,
      sink,
    )._unsafeUnwrap();
    const options = baseOptions();

    expect(() =>
      wrapped.streamSimple(
        eligibleModel() as never,
        {} as never,
        options as never,
      ),
    ).not.toThrow();
    expect(native.streamSimpleCalls[0]?.options).toBe(options);
    expect(last(snapshots).state).toBe("unsupported");
    expect(last(snapshots).reason).toBe("wrapper-degraded");
    expect(JSON.stringify(snapshots)).not.toContain(SECRET_SHAPED_INPUT);
  });

  it("passes through when reading the request model throws", () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    const hostileModel = {
      get id(): string {
        throw new Error("hostile model id");
      },
    };
    const options = baseOptions();

    expect(() =>
      wrapped.streamSimple(
        hostileModel as never,
        {} as never,
        options as never,
      ),
    ).not.toThrow();
    expect(native.streamSimpleCalls[0]?.options).toBe(options);
    expect(last(snapshots).reason).toBe("wrapper-degraded");
  });
});

describe("wrapCodexProviderForFast — eligible option construction", () => {
  it("forces sse, chains onPayload, installs a fetch, and keeps the rest", () => {
    const native = createNativeProvider();
    const { sink } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    const callerOnPayload = (): undefined => undefined;
    const callerFetch = async (): Promise<Response> => new Response("");
    const signal = new AbortController().signal;
    const options = baseOptions({
      onPayload: callerOnPayload,
      fetch: callerFetch,
      signal,
      transport: "auto",
      maxRetries: 4,
      headers: { "x-caller": "1" },
    });

    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      options as never,
    );
    const received = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;

    expect(received).not.toBe(options);
    expect(received.transport).toBe("sse");
    expect(received.onPayload).not.toBe(callerOnPayload);
    expect(received.fetch).not.toBe(callerFetch);
    expect(received.apiKey).toBe(SUBSCRIPTION_TOKEN);
    expect(received.temperature).toBe(0.25);
    expect(received.signal).toBe(signal);
    expect(received.maxRetries).toBe(4);
    expect(received.headers).toBe(options.headers);
    // The caller's own object is never mutated.
    expect(options.transport).toBe("auto");
    expect(options.onPayload).toBe(callerOnPayload);
    expect(options.fetch).toBe(callerFetch);
  });
});

describe("wrapCodexProviderForFast — payload collision rule", () => {
  it("runs the caller hook first and sets the tier on its output", async () => {
    const order: string[] = [];
    const replacement = { model: ELIGIBLE_MODEL_ID, replaced: true };
    const run = await runMappedCall({
      payload: { model: ELIGIBLE_MODEL_ID, original: true },
      callerOnPayload: () => {
        order.push("caller");
        return replacement;
      },
    });
    expect(order).toEqual(["caller"]);
    expect(run.payload).toBe(replacement);
    expect(replacement as Record<string, unknown>).toEqual({
      model: ELIGIBLE_MODEL_ID,
      replaced: true,
      service_tier: "priority",
    });
  });

  it("keeps an exact priority tier the caller already set", async () => {
    const payload = { model: ELIGIBLE_MODEL_ID, service_tier: "priority" };
    const run = await runMappedCall({ payload });
    expect(run.payload).toBe(payload);
    expect(payload.service_tier).toBe("priority");
    expect(run.snapshots).toEqual([]);
  });

  const collisions: readonly {
    readonly name: string;
    readonly payload: () => unknown;
  }[] = [
    {
      name: "a conflicting tier",
      payload: () => ({ model: ELIGIBLE_MODEL_ID, service_tier: "flex" }),
    },
    {
      name: "a non-string tier",
      payload: () => ({ model: ELIGIBLE_MODEL_ID, service_tier: 1 }),
    },
    {
      name: "a null tier",
      payload: () => ({ model: ELIGIBLE_MODEL_ID, service_tier: null }),
    },
    {
      name: "an array payload",
      payload: () => [],
    },
    {
      name: "a class-instance payload",
      payload: () => {
        class Body {
          model = ELIGIBLE_MODEL_ID;
        }
        return new Body();
      },
    },
    {
      name: "a frozen payload",
      payload: () => Object.freeze({ model: ELIGIBLE_MODEL_ID }),
    },
    {
      name: "a payload whose model was rewritten",
      payload: () => ({ model: "gpt-5.4" }),
    },
    {
      name: "a payload with no model",
      payload: () => ({ input: [] }),
    },
  ];

  for (const testCase of collisions) {
    it(`fails closed on ${testCase.name}`, async () => {
      const payload = testCase.payload();
      const run = await runMappedCall({
        payload,
        responses: [sseResponse([sseEvent("response.completed", {})])],
      });
      expect(run.payload).toBe(payload);
      // The payload the caller owns is byte-for-byte what it was.
      expect(payload).toEqual(testCase.payload() as never);
      expect(last(run.snapshots).state).toBe("unsupported");
      expect(last(run.snapshots).reason).toBe("request-collision");
      expect(last(run.snapshots).collision).toBe(true);
      // No attempt was ever opened, so no header could be written.
      expect(last(run.snapshots).attemptCount).toBe(0);
      const sentInit = run.sentInits[0] as Record<string, unknown> | undefined;
      const headers = new Headers(
        (sentInit?.headers as HeadersInit | undefined) ?? {},
      );
      expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
      expect(headers.has(CODEX_ORIGINATOR_HEADER)).toBe(false);
    });
  }

  it("never invokes a service_tier accessor trap", async () => {
    let reads = 0;
    const payload = { model: ELIGIBLE_MODEL_ID };
    Object.defineProperty(payload, "service_tier", {
      get: () => {
        reads += 1;
        return "priority";
      },
      enumerable: true,
      configurable: true,
    });
    const run = await runMappedCall({ payload });
    expect(reads).toBe(0);
    expect(last(run.snapshots).reason).toBe("request-collision");
  });

  it("never invokes a model accessor trap", async () => {
    let reads = 0;
    const payload = {};
    Object.defineProperty(payload, "model", {
      get: () => {
        reads += 1;
        return ELIGIBLE_MODEL_ID;
      },
      enumerable: true,
      configurable: true,
    });
    const run = await runMappedCall({ payload });
    expect(reads).toBe(0);
    expect(last(run.snapshots).reason).toBe("request-collision");
  });

  it("propagates a caller hook failure and abandons the mapping", async () => {
    const failure = new Error(`caller exploded ${SECRET_SHAPED_INPUT}`);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({
        onPayload: () => {
          throw failure;
        },
      }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    const onPayload = options.onPayload as (p: unknown) => Promise<unknown>;

    await expect(onPayload({ model: ELIGIBLE_MODEL_ID })).rejects.toBe(failure);
    expect(last(snapshots).state).toBe("unsupported");
    expect(last(snapshots).reason).toBe("wrapper-degraded");
    expect(JSON.stringify(snapshots)).not.toContain(SECRET_SHAPED_INPUT);
  });
});

/**
 * `buildBaseOptions` from the pinned host's `api/simple-options.js`, reduced
 * to the fields that matter here. `streamSimple` runs this *before* the body
 * exists, so the object `stream` later reads `transport` and `fetch` from is
 * not the object the wrapper prepared.
 */
function deriveBaseOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    temperature: options.temperature,
    signal: options.signal,
    apiKey: options.apiKey,
    fetch: options.fetch,
    transport: options.transport,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    onResponse: options.onResponse,
    timeoutMs: options.timeoutMs,
  };
}

type HostCall = {
  /** What the wrapper handed the native provider, before the hook ran. */
  readonly prepared: Record<string, unknown>;
  /** The options view the host reads `transport` and `fetch` from. */
  readonly hostOptions: Record<string, unknown>;
  /** The body the host would serialize. */
  readonly payload: unknown;
  /** `options?.transport || "auto"`, exactly as the host resolves it. */
  readonly transport: unknown;
  /** `options?.fetch ?? globalThis.fetch`, exactly as the host resolves it. */
  readonly fetchImpl: unknown;
  readonly snapshots: readonly CodexFastSnapshot[];
};

/**
 * Drive one call in the pinned host's own option read order, taken from
 * `@earendil-works/pi-ai` 0.84.2 `api/openai-codex-responses.js`: build the
 * body, `await options?.onPayload?.(body, model)` (line 172), then read
 * `options?.transport || "auto"` (line 182) and `options?.fetch ??
 * globalThis.fetch` (line 265). The hook is called as a method, because the
 * host calls it as one.
 */
async function runPinnedHostCall(input: {
  /** `true` runs the `streamSimple` entry, which copies options eagerly. */
  readonly derive: boolean;
  readonly payload?: unknown;
  readonly callerOnPayload?: (payload: unknown, model: unknown) => unknown;
  readonly options?: Record<string, unknown>;
}): Promise<HostCall> {
  const native = createNativeProvider();
  const { sink, snapshots } = createSink();
  const wrapped = wrapCodexProviderForFast(
    native.provider,
    createIntentPort(FAST_INTENT),
    sink,
  )._unsafeUnwrap();
  const model = eligibleModel();
  const callerOptions = baseOptions({
    ...(input.callerOnPayload === undefined
      ? {}
      : { onPayload: input.callerOnPayload }),
    ...(input.options ?? {}),
  });

  if (input.derive) {
    wrapped.streamSimple(
      model as never,
      { messages: [] } as never,
      callerOptions as never,
    );
  } else {
    wrapped.stream(
      model as never,
      { messages: [] } as never,
      callerOptions as never,
    );
  }
  const recorded = input.derive
    ? native.streamSimpleCalls[0]
    : native.streamCalls[0];
  if (recorded === undefined) {
    throw new Error("native was not called");
  }
  const wrapperOptions = recorded.options as Record<string, unknown>;
  const prepared = {
    transport: wrapperOptions.transport,
    fetch: wrapperOptions.fetch,
    onPayload: wrapperOptions.onPayload,
  };
  const hostOptions = input.derive
    ? deriveBaseOptions(wrapperOptions)
    : wrapperOptions;

  let payload: unknown = input.payload ?? {
    model: ELIGIBLE_MODEL_ID,
    input: [],
  };
  const next = await (
    hostOptions as {
      onPayload?: (p: unknown, m: unknown) => Promise<unknown>;
    }
  ).onPayload?.(payload, model);
  if (next !== undefined) {
    payload = next;
  }

  return {
    prepared,
    hostOptions,
    payload,
    transport: (hostOptions.transport as string | undefined) || "auto",
    fetchImpl: hostOptions.fetch ?? globalThis.fetch,
    snapshots,
  };
}

/**
 * Regression cover for the gap this seam had: suppressing the tier and the
 * headers is not enough, because the mapped call also carried a forced
 * transport and a wrapper fetch. A body collision has to leave the whole
 * call native, not just the bytes.
 */
describe("wrapCodexProviderForFast — collision restores the native call", () => {
  const entries = [
    { name: "streamSimple, whose options the host copies", derive: true },
    { name: "stream, which reads the prepared options", derive: false },
  ] as const;

  for (const entry of entries) {
    it(`restores transport, fetch, and hook through ${entry.name}`, async () => {
      const callerFetch = async (): Promise<Response> => new Response("");
      let hookCalls = 0;
      const callerOnPayload = (payload: unknown): unknown => {
        hookCalls += 1;
        // The collision only exists after the caller's hook has run, so the
        // wrapper cannot have declined this call at its entry point.
        (payload as Record<string, unknown>).service_tier = "flex";
        return payload;
      };
      const run = await runPinnedHostCall({
        derive: entry.derive,
        callerOnPayload,
        options: { fetch: callerFetch, transport: "auto" },
      });

      // The call really was mapped before the hook ran.
      expect(run.prepared.transport).toBe("sse");
      expect(run.prepared.fetch).not.toBe(callerFetch);
      expect(run.prepared.onPayload).not.toBe(callerOnPayload);

      // And it is native afterwards: the host resolves the caller's own
      // transport and the caller's own fetch, not the wrapper's.
      expect(run.transport).toBe("auto");
      expect(run.hostOptions.transport).toBe("auto");
      expect(run.hostOptions.fetch).toBe(callerFetch);
      expect(run.fetchImpl).toBe(callerFetch);
      expect(run.hostOptions.onPayload).toBe(callerOnPayload);

      // The caller's hook ran once, and its output is what the host keeps.
      expect(hookCalls).toBe(1);
      expect(run.payload).toEqual({
        model: ELIGIBLE_MODEL_ID,
        input: [],
        service_tier: "flex",
      });
      expect(last(run.snapshots).state).toBe("unsupported");
      expect(last(run.snapshots).reason).toBe("request-collision");
      expect(last(run.snapshots).collision).toBe(true);
      expect(last(run.snapshots).attemptCount).toBe(0);
    });
  }

  it("leaves the host on its own default transport when the caller set none", async () => {
    const run = await runPinnedHostCall({
      derive: true,
      payload: { model: ELIGIBLE_MODEL_ID, service_tier: "flex" },
    });
    expect(run.prepared.transport).toBe("sse");
    // Absent, not `"sse"` and not an invented value: the host's own default
    // is what an untouched call would have used.
    expect(run.hostOptions.transport).toBeUndefined();
    expect(run.transport).toBe("auto");
    expect(run.hostOptions.fetch).toBeUndefined();
    expect(run.fetchImpl).toBe(globalThis.fetch);
    expect(last(run.snapshots).reason).toBe("request-collision");
  });

  it("preserves a transport the caller chose itself", async () => {
    const run = await runPinnedHostCall({
      derive: true,
      payload: { model: ELIGIBLE_MODEL_ID, service_tier: "flex" },
      options: { transport: "websocket-cached" },
    });
    expect(run.transport).toBe("websocket-cached");
    expect(run.hostOptions.transport).toBe("websocket-cached");
  });

  it("restores the prepared options even when the hook loses its receiver", async () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const callerFetch = async (): Promise<Response> => new Response("");
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: callerFetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    // Detached from any object, so `this` is undefined inside the chain.
    const hook = options.onPayload as (p: unknown) => Promise<unknown>;

    await hook({ model: ELIGIBLE_MODEL_ID, service_tier: "flex" });

    expect(options.transport).toBeUndefined();
    expect(options.fetch).toBe(callerFetch);
    expect(last(snapshots).reason).toBe("request-collision");
  });

  it("restores nothing when the mapping succeeds", async () => {
    const scripted = queuedFetch([
      sseResponse([
        sseEvent("response.completed", { service_tier: "default" }),
      ]),
    ]);
    const run = await runPinnedHostCall({
      derive: true,
      options: { fetch: scripted.fetch, transport: "auto" },
    });

    // An eligible call with no collision keeps every injection.
    expect(run.transport).toBe("sse");
    expect(run.hostOptions.fetch).toBe(run.prepared.fetch);
    expect(run.hostOptions.fetch).not.toBe(scripted.fetch);
    expect(run.payload).toEqual({
      model: ELIGIBLE_MODEL_ID,
      input: [],
      service_tier: "priority",
    });

    await (run.fetchImpl as (u: unknown, i: unknown) => Promise<Response>)(
      "https://chatgpt.com/backend-api/codex/responses",
      { method: "POST" },
    );
    const sent = new Headers(
      (scripted.inits[0] as { headers?: HeadersInit }).headers,
    );
    expect(sent.get(CODEX_ORIGINATOR_HEADER)).toBe(CODEX_FAST_ORIGINATOR);
    expect(sent.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
    expect(last(run.snapshots).state).toBe("requested");
  });
});

describe("wrapCodexProviderForFast — header authority", () => {
  it("writes exactly the two routing headers and touches nothing else", async () => {
    const run = await runMappedCall({
      init: {
        method: "POST",
        body: "zstd-bytes",
        headers: new Headers({
          authorization: "Bearer redacted",
          "chatgpt-account-id": "acct-fixture",
          "session-id": "session-fixture",
          originator: "pi",
          "content-encoding": "zstd",
        }),
      },
      responses: [
        sseResponse([
          sseEvent("response.created", { service_tier: "auto" }),
          sseEvent("response.completed", { service_tier: "priority" }),
        ]),
      ],
    });

    const init = run.sentInits[0] as Record<string, unknown>;
    const headers = init.headers as Headers;
    expect(headers.get(CODEX_ORIGINATOR_HEADER)).toBe(CODEX_FAST_ORIGINATOR);
    expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
    expect(headers.get("authorization")).toBe("Bearer redacted");
    expect(headers.get("chatgpt-account-id")).toBe("acct-fixture");
    expect(headers.get("session-id")).toBe("session-fixture");
    expect(headers.get("content-encoding")).toBe("zstd");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("zstd-bytes");
    expect(last(run.snapshots).state).toBe("applied");
  });

  it("replaces a differently cased originator without duplicating it", async () => {
    const run = await runMappedCall({
      init: {
        method: "POST",
        headers: { Originator: "pi", Authorization: "Bearer redacted" },
      },
      responses: [sseResponse([])],
    });
    const headers = (run.sentInits[0] as Record<string, unknown>)
      .headers as Headers;
    const names: string[] = [];
    headers.forEach((_value, name) => {
      if (name.toLowerCase() === CODEX_ORIGINATOR_HEADER) {
        names.push(name.toLowerCase());
      }
    });
    expect(names).toEqual([CODEX_ORIGINATOR_HEADER]);
    expect(headers.get(CODEX_ORIGINATOR_HEADER)).toBe(CODEX_FAST_ORIGINATOR);
    expect(headers.get("authorization")).toBe("Bearer redacted");
  });

  it("maps a call made through stream exactly as through streamSimple", async () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const scripted = queuedFetch([
      sseResponse([
        sseEvent("response.completed", { service_tier: "priority" }),
      ]),
    ]);
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();

    wrapped.stream(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamCalls[0]?.options as Record<string, unknown>;
    expect(options.transport).toBe("sse");
    const payload = { model: ELIGIBLE_MODEL_ID };
    await (options.onPayload as (p: unknown) => Promise<unknown>)(payload);
    expect(payload).toEqual({
      model: ELIGIBLE_MODEL_ID,
      service_tier: "priority",
    } as never);
    const response = await (
      options.fetch as (u: unknown, i: unknown) => Promise<Response>
    )("https://chatgpt.com/x", { method: "POST" });
    await drain(response);

    const headers = (scripted.inits[0] as Record<string, unknown>)
      .headers as Headers;
    expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
    expect(last(snapshots).state).toBe("applied");
  });

  it("falls back to the host fetch only when the caller supplies none", async () => {
    const globalFetch = globalThis.fetch;
    const seen: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seen.push(init);
      return sseResponse([]);
    }) as unknown as typeof fetch;
    try {
      const native = createNativeProvider();
      const { sink, snapshots } = createSink();
      const wrapped = wrapCodexProviderForFast(
        native.provider,
        createIntentPort(FAST_INTENT),
        sink,
      )._unsafeUnwrap();
      wrapped.streamSimple(
        eligibleModel() as never,
        {} as never,
        baseOptions() as never,
      );
      const options = native.streamSimpleCalls[0]?.options as Record<
        string,
        unknown
      >;
      await (options.onPayload as (p: unknown) => Promise<unknown>)({
        model: ELIGIBLE_MODEL_ID,
      });
      await (options.fetch as (u: unknown, i: unknown) => Promise<Response>)(
        "https://chatgpt.com/x",
        { method: "POST" },
      );
      expect(seen).toHaveLength(1);
      const headers = (seen[0] as Record<string, unknown>).headers as Headers;
      expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
      expect(last(snapshots).state).toBe("requested");
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it("uses the caller's fetch rather than the global one", async () => {
    const globalFetch = globalThis.fetch;
    let globalCalls = 0;
    globalThis.fetch = (async () => {
      globalCalls += 1;
      throw new Error("the global fetch must never run in this test");
    }) as unknown as typeof fetch;
    try {
      const run = await runMappedCall({ responses: [sseResponse([])] });
      expect(run.sentInits).toHaveLength(1);
      expect(globalCalls).toBe(0);
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it("reports requested as soon as both parts land", async () => {
    const run = await runMappedCall({ responses: [sseResponse([])] });
    const requested = run.snapshots.find(
      (snapshot) => snapshot.state === "requested",
    );
    expect(requested).toBeDefined();
    expect(requested?.ruleId).toBe(ELIGIBLE_RULE_ID);
    expect(requested?.evidenceKind).toBe("openai-service-tier");
    expect(requested?.attemptCount).toBe(1);
  });
});

/**
 * The casings rule 7 must treat identically. `Headers` names are case
 * insensitive, so every one of these is the same header.
 */
const HINT_CASINGS = [
  "x-codex-routing-hint",
  "X-Codex-Routing-Hint",
  "X-CODEX-ROUTING-HINT",
] as const;

const FOREIGN_HINT = "model=other;tier=priority";

describe("wrapCodexProviderForFast — preexisting hint preflight", () => {
  /**
   * Both sources the host merges into its request headers are caller-held
   * values the wrapper receives at the entry point, so a hint in either one
   * is knowable before the body is touched.
   */
  const sources = [
    { name: "the request model's headers", place: "model" },
    { name: "the options headers", place: "options" },
  ] as const;

  for (const source of sources) {
    for (const casing of HINT_CASINGS) {
      it(`delegates natively when ${source.name} carry ${casing}`, async () => {
        const hintHeaders = { [casing]: FOREIGN_HINT, originator: "pi" };
        const model =
          source.place === "model"
            ? { ...eligibleModel(), headers: hintHeaders }
            : eligibleModel();
        const callerOnPayload = (): undefined => undefined;
        const scripted = queuedFetch([sseResponse([])]);
        const options = baseOptions({
          fetch: scripted.fetch,
          onPayload: callerOnPayload,
          ...(source.place === "options" ? { headers: hintHeaders } : {}),
        });
        const optionKeys = Object.keys(options).sort();
        const native = createNativeProvider();
        const { sink, snapshots } = createSink();
        const wrapped = wrapCodexProviderForFast(
          native.provider,
          createIntentPort(FAST_INTENT),
          sink,
        )._unsafeUnwrap();

        wrapped.streamSimple(model as never, {} as never, options as never);

        // Native passthrough is by reference: no chained hook, no forced
        // transport, no wrapper fetch, nothing added or removed.
        const received = native.streamSimpleCalls[0]?.options as Record<
          string,
          unknown
        >;
        expect(received).toBe(options);
        expect(Object.keys(options).sort()).toEqual(optionKeys);
        expect(received.onPayload).toBe(callerOnPayload);
        expect(received.fetch).toBe(scripted.fetch);
        expect(received.transport).toBeUndefined();

        // The body the native path would build is untouched, because the
        // only hook that survives is the caller's own.
        const payload = { model: ELIGIBLE_MODEL_ID, input: [] };
        await (
          received.onPayload as (p: unknown, m: unknown) => Promise<unknown>
        )(payload, model);
        expect(payload).toEqual({ model: ELIGIBLE_MODEL_ID, input: [] });
        expect("service_tier" in payload).toBe(false);
        expect(scripted.inits).toEqual([]);
        expect(hintHeaders).toEqual({
          [casing]: FOREIGN_HINT,
          originator: "pi",
        });

        // One honest terminal state, and no attempt was ever opened.
        expect(snapshots).toHaveLength(1);
        expect(last(snapshots).state).toBe("unsupported");
        expect(last(snapshots).reason).toBe("request-collision");
        expect(last(snapshots).collision).toBe(true);
        expect(last(snapshots).attemptCount).toBe(0);
        expect(JSON.stringify(snapshots)).not.toContain(FOREIGN_HINT);
      });
    }
  }

  it("declines for a hint held in an options Headers instance", () => {
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    const options = baseOptions({
      headers: new Headers({ [CODEX_ROUTING_HINT_HEADER]: FOREIGN_HINT }),
    });

    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      options as never,
    );

    expect(native.streamSimpleCalls[0]?.options).toBe(options);
    expect(last(snapshots).reason).toBe("request-collision");
  });

  it("maps the call when the options headers delete an inherited hint", async () => {
    const scripted = queuedFetch([
      sseResponse([
        sseEvent("response.completed", { service_tier: "priority" }),
      ]),
    ]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();

    wrapped.streamSimple(
      {
        ...eligibleModel(),
        headers: { [CODEX_ROUTING_HINT_HEADER]: FOREIGN_HINT },
      } as never,
      {} as never,
      baseOptions({
        fetch: scripted.fetch,
        // The host deletes a header whose merged value is null, so no hint
        // reaches the wire and there is nothing to collide with.
        headers: { "X-Codex-Routing-Hint": null },
      }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    expect(options.transport).toBe("sse");
    await (options.onPayload as (p: unknown) => Promise<unknown>)({
      model: ELIGIBLE_MODEL_ID,
    });
    const response = await (
      options.fetch as (u: unknown, i: unknown) => Promise<Response>
    )("https://chatgpt.com/x", { method: "POST" });
    await drain(response);

    const headers = (scripted.inits[0] as Record<string, unknown>)
      .headers as Headers;
    expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
    expect(headers.get(CODEX_ORIGINATOR_HEADER)).toBe(CODEX_FAST_ORIGINATOR);
    expect(last(snapshots).state).toBe("applied");
  });

  it("still maps a call whose headers carry no hint", async () => {
    const run = await runMappedCall({
      options: { headers: { "x-caller": "1" } },
      responses: [sseResponse([])],
    });
    const headers = (run.sentInits[0] as Record<string, unknown>)
      .headers as Headers;
    expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
  });
});

describe("wrapCodexProviderForFast — late hint collision", () => {
  /**
   * Drive one eligible call up to the fetch seam, then hand that fetch an
   * init the preflight could not have seen. `tier` decides who owns the
   * priority body: the wrapper (absent) or the caller (already set).
   */
  async function runLateCollision(input: {
    readonly casing: string;
    readonly tier?: string;
    readonly calls?: number;
  }): Promise<{
    readonly snapshots: readonly CodexFastSnapshot[];
    readonly sentInits: readonly unknown[];
    readonly rejections: readonly unknown[];
    readonly payload: Record<string, unknown>;
    readonly init: Record<string, unknown>;
  }> {
    const scripted = queuedFetch([sseResponse([]), sseResponse([])]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    const payload: Record<string, unknown> = {
      model: ELIGIBLE_MODEL_ID,
      ...(input.tier === undefined ? {} : { service_tier: input.tier }),
    };
    await (options.onPayload as (p: unknown) => Promise<unknown>)(payload);

    const init = {
      method: "POST",
      body: "zstd-bytes",
      headers: { [input.casing]: FOREIGN_HINT, authorization: "Bearer x" },
    };
    const rejections: unknown[] = [];
    for (let call = 0; call < (input.calls ?? 1); call += 1) {
      await (options.fetch as (u: unknown, i: unknown) => Promise<Response>)(
        "https://chatgpt.com/backend-api/codex/responses",
        init,
      ).then(
        () => undefined,
        (error: unknown) => {
          rejections.push(error);
        },
      );
    }
    return {
      snapshots,
      sentInits: scripted.inits,
      rejections,
      payload,
      init,
    };
  }

  for (const casing of HINT_CASINGS) {
    it(`blocks the attempt when ${casing} appears only at fetch time`, async () => {
      const run = await runLateCollision({ casing });

      // The wrapper owns this body's tier, so it cannot be unsent: nothing
      // reached the network at all.
      expect(run.payload.service_tier).toBe("priority");
      expect(run.sentInits).toEqual([]);
      expect(run.rejections).toHaveLength(1);
      const error = run.rejections[0];
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(CODEX_FAST_BLOCKED_REQUEST_MESSAGE);
      expect((error as Error).name).toBe("CodexFastBlockedRequestError");
      // The bounded message leaks no header value, model, or credential.
      expect((error as Error).message).not.toContain(FOREIGN_HINT);
      expect((error as Error).message).not.toContain(ELIGIBLE_MODEL_ID);
      // The caller's own init is untouched.
      expect(run.init.headers).toEqual({
        [casing]: FOREIGN_HINT,
        authorization: "Bearer x",
      });
      expect(run.init.body).toBe("zstd-bytes");

      const terminal = last(run.snapshots);
      expect(terminal.state).toBe("unsupported");
      expect(terminal.reason).toBe("request-collision");
      expect(terminal.collision).toBe(true);
      expect(terminal.terminal).toBe(true);
      expect(JSON.stringify(run.snapshots)).not.toContain(FOREIGN_HINT);
    });
  }

  it("keeps blocking when the host retries the blocked attempt", async () => {
    const run = await runLateCollision({
      casing: CODEX_ROUTING_HINT_HEADER,
      calls: 3,
    });
    expect(run.rejections).toHaveLength(3);
    for (const error of run.rejections) {
      expect((error as Error).message).toBe(CODEX_FAST_BLOCKED_REQUEST_MESSAGE);
    }
    expect(run.sentInits).toEqual([]);
  });

  it("passes a caller-owned priority body through untouched instead", async () => {
    const run = await runLateCollision({
      casing: "X-Codex-Routing-Hint",
      tier: "priority",
    });

    // This body is the caller's, not the wrapper's, so withholding it would
    // be a mutation of native behavior rather than a fail-closed answer.
    expect(run.rejections).toEqual([]);
    expect(run.sentInits).toHaveLength(1);
    expect(run.sentInits[0]).toBe(run.init);
    expect(run.init.headers).toEqual({
      "X-Codex-Routing-Hint": FOREIGN_HINT,
      authorization: "Bearer x",
    });
    expect(last(run.snapshots).reason).toBe("request-collision");
  });

  it("never lets a wrapper-set priority body reach the wire unaccompanied", async () => {
    const outgoing: {
      readonly wrapperSetTier: boolean;
      readonly tier: unknown;
      readonly headers: Headers;
    }[] = [];
    const collect = (
      inits: readonly unknown[],
      payload: unknown,
      wrapperSetTier: boolean,
    ): void => {
      for (const init of inits) {
        outgoing.push({
          wrapperSetTier,
          tier: (payload as Record<string, unknown>).service_tier,
          headers: new Headers(
            ((init as Record<string, unknown>).headers as HeadersInit) ?? {},
          ),
        });
      }
    };

    const clean = await runMappedCall({ responses: [sseResponse([])] });
    collect(clean.sentInits, clean.payload, true);
    for (const casing of HINT_CASINGS) {
      const late = await runLateCollision({ casing });
      collect(late.sentInits, late.payload, true);
    }
    const preserved = await runLateCollision({
      casing: CODEX_ROUTING_HINT_HEADER,
      tier: "priority",
    });
    collect(preserved.sentInits, preserved.payload, false);

    // Exactly two requests reached the network across all five calls: the
    // fully mapped one, and the caller's own priority request the wrapper
    // never touched. The three late collisions sent nothing.
    expect(outgoing).toHaveLength(2);
    expect(outgoing.filter((request) => request.wrapperSetTier)).toHaveLength(
      1,
    );
    for (const request of outgoing) {
      if (!request.wrapperSetTier) {
        continue;
      }
      expect(request.tier).toBe("priority");
      expect(request.headers.get(CODEX_ORIGINATOR_HEADER)).toBe(
        CODEX_FAST_ORIGINATOR,
      );
      expect(request.headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(
        EXPECTED_HINT,
      );
    }
  });
});

describe("wrapCodexProviderForFast — response evidence", () => {
  const evidence: readonly {
    readonly name: string;
    readonly chunks: readonly string[];
    readonly outcome: CodexFastEvidenceOutcome;
    readonly state: string;
  }[] = [
    {
      name: "an exact priority tier on the completed event",
      chunks: [
        sseEvent("response.created", { service_tier: "auto" }),
        sseEvent("response.completed", { service_tier: "priority" }),
      ],
      outcome: "confirmed",
      state: "applied",
    },
    {
      name: "an exact priority tier on the created event",
      chunks: [sseEvent("response.created", { service_tier: "priority" })],
      outcome: "confirmed",
      state: "applied",
    },
    {
      name: "the documented default tier",
      chunks: [
        sseEvent("response.created", { service_tier: "auto" }),
        sseEvent("response.completed", { service_tier: "default" }),
      ],
      outcome: "standard",
      state: "not-confirmed",
    },
    {
      name: "an unknown tier at completion",
      chunks: [sseEvent("response.completed", { service_tier: "mystery" })],
      outcome: "ambiguous",
      state: "not-confirmed",
    },
    {
      name: "no tier field at all",
      chunks: [sseEvent("response.completed", { id: "resp_1" })],
      outcome: "absent",
      state: "not-confirmed",
    },
    {
      name: "malformed json framing",
      chunks: ["data: {not json at all\n\n", "data: [DONE]\n\n"],
      outcome: "ambiguous",
      state: "not-confirmed",
    },
  ];

  for (const testCase of evidence) {
    it(`maps ${testCase.name}`, async () => {
      const run = await runMappedCall({
        responses: [sseResponse(testCase.chunks)],
      });
      expect(run.snapshots.length).toBeGreaterThan(0);
      const finalSnapshot = last(run.snapshots);
      expect(finalSnapshot.state).toBe(testCase.state as never);
      expect(finalSnapshot.evidenceOutcome).toBe(testCase.outcome);
      expect(finalSnapshot.terminal).toBe(true);
    });
  }

  it("forwards the body byte-for-byte while sniffing", async () => {
    const chunks = [
      sseEvent("response.created", { service_tier: "auto" }),
      'event: response.output_text.delta\ndata: {"type":"x","delta":"hello"}\n\n',
      sseEvent("response.completed", { service_tier: "default" }),
      "data: [DONE]\n\n",
    ];
    const run = await runMappedCall({ responses: [sseResponse(chunks)] });
    expect(run.bodies[0]).toBe(chunks.join(""));
  });

  it("stays bounded and passes through a giant single event", async () => {
    const giant = `data: {"type":"response.completed","filler":"${"z".repeat(
      CODEX_EVIDENCE_SCAN_BUDGET_BYTES + 4096,
    )}"}\n\n`;
    const run = await runMappedCall({ responses: [sseResponse([giant])] });
    expect(run.bodies[0]).toBe(giant);
    expect(last(run.snapshots).state).toBe("not-confirmed");
    expect(last(run.snapshots).evidenceOutcome).toBe("ambiguous");
  });

  it("survives binary noise ahead of the events", async () => {
    const noise = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]);
    const run = await runMappedCall({
      responses: [
        sseResponse([
          noise,
          "\n\n",
          sseEvent("response.completed", { service_tier: "priority" }),
        ]),
      ],
    });
    expect(last(run.snapshots).state).toBe("applied");
    expect(last(run.snapshots).evidenceOutcome).toBe("confirmed");
  });

  it("reports inaccessible for a bodyless response", async () => {
    const run = await runMappedCall({
      responses: [new Response(null, { status: 200 })],
    });
    expect(last(run.snapshots).evidenceOutcome).toBe("inaccessible");
    expect(last(run.snapshots).state).toBe("requested");
  });

  it("reports inaccessible for an already locked body", async () => {
    const response = sseResponse([sseEvent("response.completed", {})]);
    response.body?.getReader();
    const run = await runMappedCall({
      responses: [response],
      drainBodies: false,
    });
    expect(last(run.snapshots).evidenceOutcome).toBe("inaccessible");
  });

  it("reports inaccessible for a non-ok response and keeps its body readable", async () => {
    const run = await runMappedCall({
      responses: [new Response("rate limited", { status: 429 })],
    });
    expect(run.bodies[0]).toBe("rate limited");
    expect(last(run.snapshots).evidenceOutcome).toBe("inaccessible");
    expect(last(run.snapshots).state).toBe("requested");
  });
});

describe("wrapCodexProviderForFast — retries and cancellation", () => {
  it("correlates evidence to the final attempt only", async () => {
    const scripted = queuedFetch([
      new Response("retry me", { status: 429 }),
      sseResponse([
        sseEvent("response.completed", { service_tier: "priority" }),
      ]),
    ]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    await (options.onPayload as (p: unknown) => Promise<unknown>)({
      model: ELIGIBLE_MODEL_ID,
    });
    const wrapperFetch = options.fetch as (
      u: unknown,
      i: unknown,
    ) => Promise<Response>;

    const first = await wrapperFetch("https://chatgpt.com/x", {
      method: "POST",
    });
    expect(await first.text()).toBe("retry me");
    const second = await wrapperFetch("https://chatgpt.com/x", {
      method: "POST",
    });
    await drain(second);

    for (const init of scripted.inits) {
      const headers = (init as Record<string, unknown>).headers as Headers;
      expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(EXPECTED_HINT);
      expect(headers.get(CODEX_ORIGINATOR_HEADER)).toBe(CODEX_FAST_ORIGINATOR);
    }
    const terminal = last(snapshots);
    expect(terminal.state).toBe("applied");
    expect(terminal.evidenceOutcome).toBe("confirmed");
    expect(terminal.attemptCount).toBe(2);
    expect(terminal.terminal).toBe(true);
  });

  it("records cancellation and rethrows the abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("aborted", "AbortError");
    const scripted = queuedFetch([abort as unknown as Error]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    await (options.onPayload as (p: unknown) => Promise<unknown>)({
      model: ELIGIBLE_MODEL_ID,
    });
    await expect(
      (options.fetch as (u: unknown, i: unknown) => Promise<Response>)(
        "https://chatgpt.com/x",
        { signal: controller.signal },
      ),
    ).rejects.toBe(abort);
    expect(last(snapshots).state).toBe("not-confirmed");
    expect(last(snapshots).reason).toBe("canceled");
  });

  it("rethrows a transport failure without claiming a state change", async () => {
    const failure = new Error(`socket died ${SECRET_SHAPED_INPUT}`);
    const scripted = queuedFetch([failure]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    await (options.onPayload as (p: unknown) => Promise<unknown>)({
      model: ELIGIBLE_MODEL_ID,
    });
    await expect(
      (options.fetch as (u: unknown, i: unknown) => Promise<Response>)(
        "https://chatgpt.com/x",
        {},
      ),
    ).rejects.toBe(failure);
    expect(last(snapshots).state).toBe("requested");
    expect(last(snapshots).terminal).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain(SECRET_SHAPED_INPUT);
  });

  it("absorbs a throwing sink without disturbing the call", async () => {
    const scripted = queuedFetch([
      sseResponse([
        sseEvent("response.completed", { service_tier: "default" }),
      ]),
    ]);
    const native = createNativeProvider();
    const hostileSink: CodexFastAttemptSink = {
      record: () => {
        throw new Error("hostile sink");
      },
    };
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      hostileSink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    const payload = { model: ELIGIBLE_MODEL_ID };
    await (options.onPayload as (p: unknown) => Promise<unknown>)(payload);
    const response = await (
      options.fetch as (u: unknown, i: unknown) => Promise<Response>
    )("https://chatgpt.com/x", {});
    expect(await drain(response)).toContain("response.completed");
  });

  it("passes the request through when onPayload never ran", async () => {
    const scripted = queuedFetch([sseResponse([])]);
    const native = createNativeProvider();
    const { sink, snapshots } = createSink();
    const wrapped = wrapCodexProviderForFast(
      native.provider,
      createIntentPort(FAST_INTENT),
      sink,
    )._unsafeUnwrap();
    wrapped.streamSimple(
      eligibleModel() as never,
      {} as never,
      baseOptions({ fetch: scripted.fetch }) as never,
    );
    const options = native.streamSimpleCalls[0]?.options as Record<
      string,
      unknown
    >;
    const init = { method: "POST", headers: { originator: "pi" } };
    await (options.fetch as (u: unknown, i: unknown) => Promise<Response>)(
      "https://chatgpt.com/x",
      init,
    );
    expect(scripted.inits[0]).toBe(init);
    expect(init.headers).toEqual({ originator: "pi" });
    expect(snapshots).toEqual([]);
  });
});

describe("hasCodexSubscriptionAccountClaim", () => {
  it("accepts a ChatGPT subscription token", () => {
    expect(hasCodexSubscriptionAccountClaim(SUBSCRIPTION_TOKEN)).toBe(true);
  });

  const rejected: readonly [string, unknown][] = [
    ["a non-string", 42],
    ["an empty string", ""],
    ["an api key", SECRET_SHAPED_INPUT],
    ["a two-part token", "a.b"],
    ["an unparseable payload", "aaa.!!!!.ccc"],
    ["a token without the claim namespace", `${btoa("{}")}.${btoa("{}")}.x`],
    [
      "a token whose account id is empty",
      `x.${btoa(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "" },
        }),
      )}.y`,
    ],
    ["an over-long string", "a.".repeat(20_000)],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(hasCodexSubscriptionAccountClaim(value)).toBe(false);
    });
  }
});

describe("createCodexServiceTierSniffer", () => {
  async function sniff(
    chunks: readonly (string | Uint8Array)[],
    budgetBytes?: number,
  ): Promise<{
    readonly outcomes: readonly CodexFastEvidenceOutcome[];
    readonly text: string;
  }> {
    const outcomes: CodexFastEvidenceOutcome[] = [];
    const sniffer = createCodexServiceTierSniffer({
      onOutcome: (outcome) => outcomes.push(outcome),
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    })._unsafeUnwrap();
    const piped = bodyOf(chunks).pipeThrough(sniffer);
    const text = await drain(new Response(piped));
    return { outcomes, text };
  }

  it("emits exactly one outcome and forwards every byte", async () => {
    const chunks = [
      sseEvent("response.created", { service_tier: "auto" }),
      sseEvent("response.completed", { service_tier: "priority" }),
      "data: [DONE]\n\n",
    ];
    const result = await sniff(chunks);
    expect(result.outcomes).toEqual(["confirmed"]);
    expect(result.text).toBe(chunks.join(""));
  });

  it("handles crlf framing and split chunks", async () => {
    const event = sseEvent("response.completed", {
      service_tier: "default",
    }).replaceAll("\n", "\r\n");
    const half = Math.floor(event.length / 2);
    const result = await sniff([event.slice(0, half), event.slice(half)]);
    expect(result.outcomes).toEqual(["standard"]);
    expect(result.text).toBe(event);
  });

  it("ignores unrelated events", async () => {
    const result = await sniff([
      sseEvent("response.in_progress", { service_tier: "auto" }),
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    ]);
    expect(result.outcomes).toEqual(["absent"]);
  });

  it("stops scanning once the budget is spent", async () => {
    const filler = `data: ${"y".repeat(200)}\n\n`;
    const late = sseEvent("response.completed", { service_tier: "priority" });
    const result = await sniff([filler, late], 64);
    expect(result.outcomes).toEqual(["ambiguous"]);
    expect(result.text).toBe(filler + late);
  });

  it("never emits twice", async () => {
    const result = await sniff([
      sseEvent("response.completed", { service_tier: "priority" }),
      sseEvent("response.completed", { service_tier: "default" }),
    ]);
    expect(result.outcomes).toEqual(["confirmed"]);
  });

  it("absorbs a throwing consumer callback", async () => {
    const sniffer = createCodexServiceTierSniffer({
      onOutcome: () => {
        throw new Error("hostile consumer");
      },
    })._unsafeUnwrap();
    const event = sseEvent("response.completed", { service_tier: "priority" });
    const piped = bodyOf([event]).pipeThrough(sniffer);
    expect(await drain(new Response(piped))).toBe(event);
  });

  it("reports absent for an empty stream", async () => {
    const result = await sniff([]);
    expect(result.outcomes).toEqual(["absent"]);
    expect(result.text).toBe("");
  });
});
