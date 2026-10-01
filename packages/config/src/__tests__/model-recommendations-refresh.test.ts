/**
 * `ModelRecommendations`: refresh, apply and status (Spec 39, item 4).
 *
 * Every dependency is a fake: an in-memory cache that implements both the file
 * and the shell interfaces, a scripted `fetch`, and a clock the test moves.
 * Every envelope is signed with a throwaway key made for this run. Nothing here
 * touches the network or the disk; `model-recommendations-cache-io.test.ts`
 * pins the real `mv` and `mkdir` behaviour.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { ModelUpdatesSettings } from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { MAX_MODEL_RECOMMENDATIONS_BYTES } from "../model-recommendations.js";
import { modelRecommendationsCachePaths } from "../model-recommendations-cache.js";
import type {
  CacheIoError,
  ModelRecommendationsFiles,
  ModelRecommendationsShell,
} from "../model-recommendations-cache-io.js";
import {
  DEFAULT_MODEL_RECOMMENDATIONS_BASE_URL,
  MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS,
  MODEL_RECOMMENDATIONS_FETCH_TIMEOUT_MS,
  MODEL_RECOMMENDATIONS_LOCK_STALE_MS,
  MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS,
  MODEL_RECOMMENDATIONS_URL_ENV,
  ModelRecommendations,
  type ModelRecommendationsDeps,
  type ModelRecommendationsFetch,
} from "../model-recommendations-refresh.js";
import {
  encodeBase64,
  signModelRecommendations,
} from "../model-recommendations-verifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBAL_DIR = "/home/tester/.weave";
const PATHS = modelRecommendationsCachePaths("stable", GLOBAL_DIR);
const NEXT_PATHS = modelRecommendationsCachePaths("next", GLOBAL_DIR);
const BASE_URL = "https://models.test/models";
const STABLE_URL = `${BASE_URL}/stable.v1.json`;
const START = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const AUTO: ModelUpdatesSettings = { mode: "auto" };
const NOTIFY: ModelUpdatesSettings = { mode: "notify" };

interface TestKeys {
  publicKey: string;
  privateKey: string;
}

let keys: TestKeys;
let otherKeys: TestKeys;

async function generateKeys(): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    publicKey: encodeBase64(new Uint8Array(raw)),
    privateKey: encodeBase64(new Uint8Array(pkcs8)),
  };
}

beforeAll(async () => {
  keys = await generateKeys();
  otherKeys = await generateKeys();
});

/** A list issued on `day` of October 2026 (09:00 UTC). */
function list(day: number, overrides: Record<string, unknown> = {}): string {
  const issued = new Date(Date.UTC(2026, 9, day, 9));
  const expires = new Date(issued.getTime() + 89 * 24 * HOUR);
  return JSON.stringify({
    schema: 1,
    channel: "stable",
    issued: issued.toISOString().replace(".000Z", "Z"),
    expires: expires.toISOString().replace(".000Z", "Z"),
    evidence: `https://tryweave.io/evals/runs/run-${day}`,
    default: { agents: { loom: { models: [`rec-${day}`] } } },
    ...overrides,
  });
}

async function signed(
  payload: string,
  privateKey = keys.privateKey,
): Promise<string> {
  return (await signModelRecommendations(payload, privateKey))._unsafeUnwrap();
}

function issuedOf(envelope: string | undefined): string | undefined {
  if (envelope === undefined) return undefined;
  return JSON.parse(JSON.parse(envelope).payload).issued;
}

/** The clock every fake shares. */
class Clock {
  constructor(public ms: number = START) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** An in-memory cache: files, directories and every write, in order. */
class MemoryCache
  implements ModelRecommendationsFiles, ModelRecommendationsShell
{
  readonly files = new Map<string, { text: string; mtime: number }>();
  readonly dirs = new Map<string, number>();
  /** Every mutation, as `op path`. */
  readonly writes: string[] = [];
  /** Paths whose write fails. */
  readonly failWrites = new Set<string>();
  /** Called before each move; lets a test act between write and rename. */
  beforeMove?: (from: string, to: string) => void;

  constructor(private readonly clock: Clock) {}

  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }

  put(path: string, text: string): void {
    this.files.set(path, { text, mtime: this.clock.ms });
  }

  exists(path: string): ResultAsync<boolean, CacheIoError> {
    return okAsync(this.files.has(path));
  }

  read(path: string): ResultAsync<string, CacheIoError> {
    const file = this.files.get(path);
    if (file === undefined) return errAsync(this.error("read", path));
    return okAsync(file.text);
  }

  write(path: string, text: string): ResultAsync<void, CacheIoError> {
    if (this.failWrites.has(path) || this.failWrites.has("*"))
      return errAsync(this.error("write", path));
    this.writes.push(`write ${path}`);
    this.put(path, text);
    return okAsync(undefined);
  }

  modifiedAt(path: string): ResultAsync<number | undefined, CacheIoError> {
    return okAsync(this.dirs.get(path) ?? this.files.get(path)?.mtime);
  }

  move(from: string, to: string): ResultAsync<void, CacheIoError> {
    this.beforeMove?.(from, to);
    const file = this.files.get(from);
    if (file === undefined) return errAsync(this.error("move", from));
    this.writes.push(`move ${to}`);
    this.files.delete(from);
    this.files.set(to, file);
    return okAsync(undefined);
  }

  makeDir(path: string): ResultAsync<boolean, CacheIoError> {
    if (this.dirs.has(path)) return okAsync(false);
    this.writes.push(`mkdir ${path}`);
    this.dirs.set(path, this.clock.ms);
    return okAsync(true);
  }

  makeDirs(path: string): ResultAsync<void, CacheIoError> {
    if (!this.dirs.has(path)) this.dirs.set(path, this.clock.ms);
    return okAsync(undefined);
  }

  remove(path: string): ResultAsync<void, CacheIoError> {
    this.writes.push(`remove ${path}`);
    this.dirs.delete(path);
    this.files.delete(path);
    return okAsync(undefined);
  }

  /** Files other than the four known ones: leftover temporary files. */
  strays(): string[] {
    const known = new Set([
      PATHS.latest,
      PATHS.applied,
      PATHS.state,
      NEXT_PATHS.latest,
      NEXT_PATHS.applied,
      NEXT_PATHS.state,
    ]);
    return [...this.files.keys()].filter((path) => !known.has(path));
  }

  state(): Record<string, unknown> | undefined {
    const text = this.text(PATHS.state);
    return text === undefined ? undefined : JSON.parse(text);
  }

  private error(
    operation: CacheIoError["operation"],
    path: string,
  ): CacheIoError {
    return { type: "CacheIoError", operation, path, message: "disk failure" };
  }
}

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly init: RequestInit;
}

type Responder = (call: FetchCall) => Promise<Response> | Response;

/** A scripted `fetch` that records every call. */
class FakeFetch {
  readonly calls: FetchCall[] = [];
  constructor(public responder: Responder) {}
  fetch: ModelRecommendationsFetch = (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call = { url, headers, init };
    this.calls.push(call);
    return Promise.resolve(this.responder(call));
  };
}

function serve(body: string, etag?: string): Responder {
  return () =>
    new Response(body, {
      status: 200,
      headers: etag === undefined ? {} : { etag },
    });
}

interface Harness {
  readonly clock: Clock;
  readonly cache: MemoryCache;
  readonly fetcher: FakeFetch;
  readonly models: ModelRecommendations;
}

function harness(
  responder: Responder = () => new Response(null, { status: 500 }),
  overrides: Partial<ModelRecommendationsDeps> = {},
  shared?: { clock: Clock; cache: MemoryCache },
): Harness {
  const clock = shared?.clock ?? new Clock();
  const cache = shared?.cache ?? new MemoryCache(clock);
  const fetcher = new FakeFetch(responder);
  const models = new ModelRecommendations({
    fetch: fetcher.fetch,
    now: clock.now,
    files: cache,
    shell: cache,
    globalDir: GLOBAL_DIR,
    baseUrl: BASE_URL,
    publicKeys: [keys.publicKey],
    ...overrides,
  });
  return { clock, cache, fetcher, models };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Off
// ---------------------------------------------------------------------------

describe("refresh with model updates off", () => {
  for (const settings of [undefined, { mode: "off" } as ModelUpdatesSettings]) {
    it(`does nothing at all (${settings === undefined ? "no block" : "mode off"})`, async () => {
      const { cache, fetcher, models } = harness();
      const outcome = await models.refresh({ settings, force: true });
      expect(outcome._unsafeUnwrap()).toEqual({ type: "Off" });
      expect(fetcher.calls).toHaveLength(0);
      expect(cache.writes).toHaveLength(0);
      expect(cache.dirs.size).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe("the refresh request", () => {
  it("GETs <base>/<channel>.v1.json with no identifying headers or query", async () => {
    const { fetcher, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: AUTO });
    expect(fetcher.calls).toHaveLength(1);
    const [call] = fetcher.calls;
    expect(call?.url).toBe(STABLE_URL);
    expect(call?.init.method).toBe("GET");
    expect(call?.headers).toEqual({});
  });

  it("asks for the settings' channel", async () => {
    const { fetcher, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: { mode: "auto", channel: "next" } });
    expect(fetcher.calls[0]?.url).toBe(`${BASE_URL}/next.v1.json`);
  });

  it("defaults to tryweave.io, and WEAVE_MODEL_RECOMMENDATIONS_URL overrides it", async () => {
    expect(DEFAULT_MODEL_RECOMMENDATIONS_BASE_URL).toBe(
      "https://tryweave.io/models",
    );
    const original = process.env[MODEL_RECOMMENDATIONS_URL_ENV];
    const urls: string[] = [];
    const run = async () => {
      const { fetcher, models } = harness(
        () => new Response(null, { status: 500 }),
        { baseUrl: undefined },
      );
      await models.refresh({ settings: AUTO });
      urls.push(fetcher.calls[0]?.url ?? "");
    };
    try {
      delete process.env[MODEL_RECOMMENDATIONS_URL_ENV];
      await run();
      process.env[MODEL_RECOMMENDATIONS_URL_ENV] = "http://127.0.0.1:8080/m/";
      await run();
    } finally {
      if (original === undefined)
        delete process.env[MODEL_RECOMMENDATIONS_URL_ENV];
      else process.env[MODEL_RECOMMENDATIONS_URL_ENV] = original;
    }
    expect(urls).toEqual([
      "https://tryweave.io/models/stable.v1.json",
      "http://127.0.0.1:8080/m/stable.v1.json",
    ]);
  });

  it("sends the stored ETag as If-None-Match", async () => {
    const { fetcher, models } = harness(serve(await signed(list(2)), '"v2"'));
    await models.refresh({ settings: AUTO });
    await models.refresh({ settings: AUTO, force: true });
    expect(fetcher.calls[1]?.headers).toEqual({ "if-none-match": '"v2"' });
  });

  it("uses a 5-second timeout and a 64 KiB cap by default", () => {
    expect(MODEL_RECOMMENDATIONS_FETCH_TIMEOUT_MS).toBe(5000);
    expect(MAX_MODEL_RECOMMENDATIONS_BYTES).toBe(64 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

describe("the refresh throttle", () => {
  it("waits 24 hours after a successful check", async () => {
    const { clock, fetcher, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: AUTO });
    clock.advance(MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS - 1);
    const throttled = await models.refresh({ settings: AUTO });
    expect(throttled._unsafeUnwrap()).toEqual({
      type: "Throttled",
      channel: "stable",
      lastCheck: new Date(START).toISOString(),
      nextCheckAt: new Date(
        START + MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS,
      ).toISOString(),
    });
    expect(fetcher.calls).toHaveLength(1);
    clock.advance(1);
    await models.refresh({ settings: AUTO });
    expect(fetcher.calls).toHaveLength(2);
    expect(MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS).toBe(24 * HOUR);
  });

  it("waits 1 hour after a failed check", async () => {
    const { clock, fetcher, models } = harness();
    expect((await models.refresh({ settings: AUTO })).isErr()).toBe(true);
    clock.advance(MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS - 1);
    expect(
      (await models.refresh({ settings: AUTO }))._unsafeUnwrap().type,
    ).toBe("Throttled");
    clock.advance(1);
    await models.refresh({ settings: AUTO });
    expect(fetcher.calls).toHaveLength(2);
    expect(MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS).toBe(HOUR);
  });

  it("checks again at once when forced", async () => {
    const { clock, fetcher, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: AUTO });
    clock.advance(60_000);
    await models.refresh({ settings: AUTO, force: true });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("throttles each channel on its own", async () => {
    const { fetcher, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: AUTO });
    await models.refresh({ settings: { mode: "auto", channel: "next" } });
    expect(fetcher.calls.map((call) => call.url)).toEqual([
      STABLE_URL,
      `${BASE_URL}/next.v1.json`,
    ]);
  });

  it("writes nothing and takes no lock while throttled", async () => {
    const { cache, models } = harness(serve(await signed(list(2))));
    await models.refresh({ settings: AUTO });
    const before = cache.writes.length;
    await models.refresh({ settings: AUTO });
    expect(cache.writes.slice(before)).toEqual([]);
  });

  it("does not trust a last check in the future", async () => {
    const { cache, fetcher, models } = harness(serve(await signed(list(2))));
    cache.put(
      PATHS.state,
      JSON.stringify({
        version: 1,
        lastCheck: new Date(START + 10 * HOUR).toISOString(),
      }),
    );
    await models.refresh({ settings: AUTO });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("treats a corrupt state.json as no state", async () => {
    const { cache, fetcher, models } = harness(serve(await signed(list(2))));
    cache.put(PATHS.state, "{ torn");
    expect((await models.refresh({ settings: AUTO })).isOk()).toBe(true);
    expect(fetcher.calls).toHaveLength(1);
    expect(cache.state()).toMatchObject({ version: 1 });
  });
});

// ---------------------------------------------------------------------------
// A successful download
// ---------------------------------------------------------------------------

describe("a verified download", () => {
  it("in auto mode, is written to latest and promoted to applied", async () => {
    const envelope = await signed(list(2));
    const { cache, models } = harness(serve(envelope, '"v2"'));
    const outcome = await models.refresh({ settings: AUTO });
    expect(outcome._unsafeUnwrap()).toEqual({
      type: "Downloaded",
      channel: "stable",
      issued: "2026-10-02T09:00:00Z",
      promoted: { issued: "2026-10-02T09:00:00Z" },
    });
    expect(cache.text(PATHS.latest)).toBe(envelope);
    expect(cache.text(PATHS.applied)).toBe(envelope);
    expect(cache.state()).toEqual({
      version: 1,
      lastCheck: new Date(START).toISOString(),
      etag: '"v2"',
    });
    expect(cache.strays()).toEqual([]);
  });

  it("in notify mode, is written to latest only", async () => {
    const envelope = await signed(list(2));
    const { cache, models } = harness(serve(envelope));
    const outcome = await models.refresh({ settings: NOTIFY });
    expect(outcome._unsafeUnwrap()).toEqual({
      type: "Downloaded",
      channel: "stable",
      issued: "2026-10-02T09:00:00Z",
    });
    expect(cache.text(PATHS.latest)).toBe(envelope);
    expect(cache.text(PATHS.applied)).toBeUndefined();
  });

  it("in auto mode, replaces an older applied list", async () => {
    const { cache, models } = harness(serve(await signed(list(3))));
    cache.put(PATHS.applied, await signed(list(2)));
    cache.put(PATHS.latest, await signed(list(2)));
    const outcome = await models.refresh({ settings: AUTO });
    expect(outcome._unsafeUnwrap()).toMatchObject({
      type: "Downloaded",
      promoted: {
        issued: "2026-10-03T09:00:00Z",
        previousIssued: "2026-10-02T09:00:00Z",
      },
    });
    expect(issuedOf(cache.text(PATHS.applied))).toBe("2026-10-03T09:00:00Z");
  });

  it("in notify mode, replaces a waiting latest with a newer one and leaves applied", async () => {
    const applied = await signed(list(1));
    const { cache, models } = harness(serve(await signed(list(3))));
    cache.put(PATHS.applied, applied);
    cache.put(PATHS.latest, await signed(list(2)));
    await models.refresh({ settings: NOTIFY });
    expect(issuedOf(cache.text(PATHS.latest))).toBe("2026-10-03T09:00:00Z");
    expect(cache.text(PATHS.applied)).toBe(applied);
  });

  it("writes every file to a unique temporary name in the same directory, then moves it", async () => {
    const { cache, models } = harness(serve(await signed(list(2))));
    const temps: string[] = [];
    cache.beforeMove = (from, to) => {
      temps.push(from);
      expect(from.slice(0, from.lastIndexOf("/"))).toBe(PATHS.dir);
      expect(from).not.toBe(to);
      // The destination is untouched until the move.
      if (to === PATHS.latest) expect(cache.text(PATHS.latest)).toBeUndefined();
    };
    await models.refresh({ settings: AUTO });
    expect(new Set(temps).size).toBe(3);
    expect(cache.writes.filter((entry) => entry.startsWith("move "))).toEqual([
      `move ${PATHS.latest}`,
      `move ${PATHS.applied}`,
      `move ${PATHS.state}`,
    ]);
    expect(
      cache.writes.some((entry) => entry === `write ${PATHS.latest}`),
    ).toBe(false);
  });

  it("a served list identical to the applied one is unchanged and stores the new ETag", async () => {
    const envelope = await signed(list(2));
    const { cache, models } = harness(serve(envelope, '"again"'));
    cache.put(PATHS.applied, envelope);
    cache.put(PATHS.latest, envelope);
    const outcome = await models.refresh({ settings: AUTO });
    expect(outcome._unsafeUnwrap()).toEqual({
      type: "Unchanged",
      channel: "stable",
      issued: "2026-10-02T09:00:00Z",
    });
    expect(cache.writes.filter((entry) => entry.startsWith("move "))).toEqual([
      `move ${PATHS.state}`,
    ]);
    expect(cache.state()?.etag).toBe('"again"');
  });
});

// ---------------------------------------------------------------------------
// 304
// ---------------------------------------------------------------------------

describe("a 304 Not Modified", () => {
  it("records the check time only", async () => {
    const envelope = await signed(list(2));
    const { cache, clock, fetcher, models } = harness(serve(envelope, '"v2"'));
    await models.refresh({ settings: AUTO });
    fetcher.responder = () => new Response(null, { status: 304 });
    clock.advance(MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS);
    const before = cache.writes.length;
    const outcome = await models.refresh({ settings: AUTO });
    expect(outcome._unsafeUnwrap()).toEqual({
      type: "NotModified",
      channel: "stable",
    });
    expect(
      cache.writes.slice(before).filter((entry) => entry.startsWith("move ")),
    ).toEqual([`move ${PATHS.state}`]);
    expect(cache.state()).toEqual({
      version: 1,
      lastCheck: new Date(clock.ms).toISOString(),
      etag: '"v2"',
    });
    expect(cache.text(PATHS.applied)).toBe(envelope);
  });

  it("clears a previous error, so the 24-hour window applies again", async () => {
    const { cache, models } = harness(
      () => new Response(null, { status: 304 }),
    );
    cache.put(
      PATHS.state,
      JSON.stringify({
        version: 1,
        lastCheck: new Date(START - 2 * HOUR).toISOString(),
        etag: '"v2"',
        lastError: {
          code: "Timeout",
          message: "timed out",
          at: new Date(START - 2 * HOUR).toISOString(),
        },
      }),
    );
    await models.refresh({ settings: AUTO });
    expect(cache.state()?.lastError).toBeUndefined();
  });

  it("in auto mode, promotes a newer list that was waiting from notify mode", async () => {
    const waiting = await signed(list(3));
    const { cache, models } = harness(
      () => new Response(null, { status: 304 }),
    );
    cache.put(PATHS.applied, await signed(list(2)));
    cache.put(PATHS.latest, waiting);
    const outcome = await models.refresh({ settings: AUTO });
    expect(outcome._unsafeUnwrap()).toEqual({
      type: "NotModified",
      channel: "stable",
      promoted: {
        issued: "2026-10-03T09:00:00Z",
        previousIssued: "2026-10-02T09:00:00Z",
      },
    });
    expect(cache.text(PATHS.applied)).toBe(waiting);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("a failed check", () => {
  async function failing(
    responder: Responder,
    overrides: Partial<ModelRecommendationsDeps> = {},
  ) {
    const applied = await signed(list(2));
    const latest = await signed(list(3));
    const h = harness(responder, overrides);
    h.cache.put(PATHS.applied, applied);
    h.cache.put(PATHS.latest, latest);
    const result = await h.models.refresh({ settings: AUTO });
    // Both files untouched, and the error recorded under the lock.
    expect(h.cache.text(PATHS.applied)).toBe(applied);
    expect(h.cache.text(PATHS.latest)).toBe(latest);
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
    expect(h.cache.strays()).toEqual([]);
    const error = result._unsafeUnwrapErr();
    if (error.type !== "CheckFailed") throw new Error(`got ${error.type}`);
    const state = h.cache.state();
    expect(state?.lastCheck).toBe(new Date(START).toISOString());
    expect(state?.lastError).toMatchObject({
      code: error.failure.type,
      at: new Date(START).toISOString(),
    });
    expect(typeof (state?.lastError as { message?: unknown })?.message).toBe(
      "string",
    );
    return { error: error.failure, h };
  }

  it("network error", async () => {
    const { error } = await failing(() =>
      Promise.reject(new TypeError("offline")),
    );
    expect(error).toEqual({ type: "Network", message: "offline" });
  });

  it("HTTP error status", async () => {
    const { error } = await failing(
      () => new Response("nope", { status: 503 }),
    );
    expect(error).toEqual({ type: "HttpStatus", status: 503 });
  });

  it("timeout waiting for the response", async () => {
    const { error } = await failing(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      { timeoutMs: 20 },
    );
    expect(error).toEqual({ type: "Timeout", timeoutMs: 20 });
  });

  it("timeout while the body is still arriving", async () => {
    const { error } = await failing(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"payload":'));
            },
          }),
          { status: 200 },
        ),
      { timeoutMs: 20 },
    );
    expect(error).toEqual({ type: "Timeout", timeoutMs: 20 });
  });

  it("a timeout that ignores the abort signal still ends the attempt", async () => {
    const { error } = await failing(() => new Promise<Response>(() => {}), {
      timeoutMs: 20,
    });
    expect(error).toEqual({ type: "Timeout", timeoutMs: 20 });
  });

  it("oversize body: stops reading once past 64 KiB", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(32);
    const { error } = await failing(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    expect(error).toMatchObject({
      type: "TooLarge",
      limit: MAX_MODEL_RECOMMENDATIONS_BYTES,
    });
    // Five 16 KiB chunks cross 64 KiB; reading stopped there, not at the end.
    expect(pulled).toBeLessThanOrEqual(7);
  });

  it("oversize Content-Length: rejected before reading", async () => {
    let pulled = 0;
    const { error } = await failing(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-length": String(MAX_MODEL_RECOMMENDATIONS_BYTES + 1),
            },
          },
        ),
    );
    expect(error).toMatchObject({ type: "TooLarge" });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("bad signature", async () => {
    const { error } = await failing(
      serve(await signed(list(4), otherKeys.privateKey)),
    );
    expect(error.type).toBe("SignatureInvalid");
  });

  it("not an envelope", async () => {
    const { error } = await failing(serve("<html>"));
    expect(error.type).toBe("EnvelopeInvalid");
  });

  it("schema-invalid list", async () => {
    const { error } = await failing(
      serve(await signed(list(4, { schema: 2 }))),
    );
    expect(error.type).toBe("SchemaInvalid");
  });

  it("expired list", async () => {
    const { error } = await failing(
      serve(
        await signed(
          list(4, {
            issued: "2026-09-30T00:00:00Z",
            expires: "2026-10-01T00:00:00Z",
          }),
        ),
      ),
    );
    expect(error.type).toBe("Expired");
  });

  it("list issued more than 24 hours ahead of the clock", async () => {
    const { error } = await failing(serve(await signed(list(4))));
    expect(error.type).toBe("IssuedInFuture");
  });

  it("list older than this release's builtin models", async () => {
    const { error } = await failing(
      serve(
        await signed(
          list(4, {
            issued: "2026-09-01T00:00:00Z",
            expires: "2026-11-01T00:00:00Z",
          }),
        ),
      ),
    );
    expect(error.type).toBe("OlderThanBuiltins");
  });

  it("list that needs a newer client", async () => {
    const { error } = await failing(
      serve(
        await signed(
          list(4, {
            issued: "2026-10-02T10:00:00Z",
            expires: "2026-12-30T09:00:00Z",
            min_config_version: "9.0.0",
          }),
        ),
      ),
    );
    expect(error).toMatchObject({ type: "ClientTooOld", required: "9.0.0" });
  });

  it("list for another channel", async () => {
    const { error } = await failing(
      serve(
        await signed(
          list(4, {
            issued: "2026-10-02T10:00:00Z",
            expires: "2026-12-30T09:00:00Z",
            channel: "next",
          }),
        ),
      ),
    );
    expect(error).toMatchObject({ type: "ChannelMismatch", actual: "next" });
  });

  it("rollback: a list older than the newest one held", async () => {
    const { error } = await failing(serve(await signed(list(1))));
    expect(error).toEqual({
      type: "NotNewer",
      issued: "2026-10-01T09:00:00Z",
      appliedIssued: "2026-10-03T09:00:00Z",
    });
  });

  it("replay: the same issued date with different bytes", async () => {
    const { error } = await failing(
      serve(
        await signed(
          list(3, { default: { agents: { loom: { models: ["evil"] } } } }),
        ),
      ),
    );
    expect(error).toMatchObject({
      type: "NotNewer",
      issued: "2026-10-03T09:00:00Z",
    });
  });

  it("does not store the ETag of a rejected body", async () => {
    const { h } = await failing(
      serve(await signed(list(4, {}), otherKeys.privateKey), '"bad"'),
    );
    expect(h.cache.state()?.etag).toBeUndefined();
  });

  it("keeps the ETag it had before the failure", async () => {
    const h = harness(serve(await signed(list(2)), '"v2"'));
    await h.models.refresh({ settings: AUTO });
    h.fetcher.responder = () => new Response(null, { status: 500 });
    await h.models.refresh({ settings: AUTO, force: true });
    expect(h.cache.state()?.etag).toBe('"v2"');
  });

  it("a cache write that fails leaves the files and records the error", async () => {
    const applied = await signed(list(2));
    const h = harness(serve(await signed(list(3))));
    h.cache.put(PATHS.applied, applied);
    // Fail the move of latest by removing its temporary file first.
    h.cache.beforeMove = (from, to) => {
      if (to === PATHS.latest) h.cache.files.delete(from);
    };
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CacheFailed",
      channel: "stable",
    });
    expect(h.cache.text(PATHS.applied)).toBe(applied);
    expect(h.cache.text(PATHS.latest)).toBeUndefined();
    expect(h.cache.state()?.lastError).toMatchObject({ code: "CacheIoError" });
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
  });

  it("never throws, even when an injected dependency does", async () => {
    const h = harness(() => {
      throw new Error("boom");
    });
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "CheckFailed" });
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
  });
});

describe("refresh never throws", () => {
  it("turns a file access that throws before the lock into Unexpected", async () => {
    const h = harness(serve(await signed(list(2))));
    h.cache.exists = () => {
      throw new Error("permission denied");
    };
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "Unexpected",
      channel: "stable",
      message: "permission denied",
    });
  });

  it("keeps a successful download when only state.json cannot be written", async () => {
    const envelope = await signed(list(2));
    const h = harness(serve(envelope));
    h.cache.beforeMove = (from, to) => {
      if (to === PATHS.state) h.cache.files.delete(from);
    };
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrap().type).toBe("Downloaded");
    expect(h.cache.text(PATHS.latest)).toBe(envelope);
    expect(h.cache.text(PATHS.applied)).toBe(envelope);
    expect(h.cache.text(PATHS.state)).toBeUndefined();
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
  });

  it("in auto mode, stages both files first: a failed applied write leaves latest unchanged too", async () => {
    const applied = await signed(list(1));
    const latest = await signed(list(1));
    const h = harness(serve(await signed(list(2))));
    h.cache.put(PATHS.applied, applied);
    h.cache.put(PATHS.latest, latest);
    const write = h.cache.write.bind(h.cache);
    h.cache.write = (path, text) =>
      path.startsWith(`${PATHS.dir}/.applied.json.`)
        ? errAsync({
            type: "CacheIoError",
            operation: "write",
            path,
            message: "disk full",
          })
        : write(path, text);
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CacheFailed",
      error: { operation: "write", message: "disk full" },
    });
    expect(h.cache.text(PATHS.latest)).toBe(latest);
    expect(h.cache.text(PATHS.applied)).toBe(applied);
    expect(h.cache.strays()).toEqual([]);
    expect(h.cache.state()?.lastError).toMatchObject({ code: "CacheIoError" });
  });

  it("reports a temporary file that cannot be written, and leaves no stray", async () => {
    const applied = await signed(list(1));
    const h = harness(serve(await signed(list(2))));
    h.cache.put(PATHS.applied, applied);
    h.cache.failWrites.add("*");
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CacheFailed",
      error: { operation: "write" },
    });
    expect(h.cache.text(PATHS.applied)).toBe(applied);
    expect(h.cache.strays()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe("the cache lock", () => {
  it("is taken before state.json is read and released after", async () => {
    const h = harness(serve(await signed(list(2))));
    let lockedDuringFetch = false;
    h.fetcher.responder = async () => {
      lockedDuringFetch = h.cache.dirs.has(PATHS.lock);
      return new Response(await signed(list(2)), { status: 200 });
    };
    await h.models.refresh({ settings: AUTO });
    expect(lockedDuringFetch).toBe(true);
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
    expect(h.cache.writes[0]).toBe(`mkdir ${PATHS.lock}`);
    expect(h.cache.writes.at(-1)).toBe(`remove ${PATHS.lock}`);
  });

  it("held by another process: Busy, and nothing written, state.json included", async () => {
    const h = harness(serve(await signed(list(2))));
    const state = JSON.stringify({ version: 1 });
    h.cache.put(PATHS.state, state);
    h.cache.dirs.set(PATHS.lock, START - 1000);
    const result = await h.models.refresh({ settings: AUTO, force: true });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "Busy",
      channel: "stable",
    });
    expect(h.fetcher.calls).toHaveLength(0);
    expect(h.cache.writes).toEqual([]);
    expect(h.cache.text(PATHS.state)).toBe(state);
    expect(h.cache.dirs.has(PATHS.lock)).toBe(true);
  });

  it("a lock exactly 60 seconds old is still held", async () => {
    const h = harness(serve(await signed(list(2))));
    h.cache.dirs.set(PATHS.lock, START - MODEL_RECOMMENDATIONS_LOCK_STALE_MS);
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr().type).toBe("Busy");
    expect(MODEL_RECOMMENDATIONS_LOCK_STALE_MS).toBe(60_000);
  });

  it("a lock older than 60 seconds is abandoned: removed, and taken", async () => {
    const h = harness(serve(await signed(list(2))));
    h.cache.dirs.set(
      PATHS.lock,
      START - MODEL_RECOMMENDATIONS_LOCK_STALE_MS - 1,
    );
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrap().type).toBe("Downloaded");
    expect(h.cache.writes.slice(0, 2)).toEqual([
      `remove ${PATHS.lock}`,
      `mkdir ${PATHS.lock}`,
    ]);
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
  });

  it("a stale lock retaken by someone else in between: Busy", async () => {
    const h = harness(serve(await signed(list(2))));
    h.cache.dirs.set(
      PATHS.lock,
      START - 2 * MODEL_RECOMMENDATIONS_LOCK_STALE_MS,
    );
    const remove = h.cache.remove.bind(h.cache);
    h.cache.remove = (path) =>
      remove(path).map(() => {
        // Another process takes the lock between our remove and our mkdir.
        if (path === PATHS.lock) h.cache.dirs.set(PATHS.lock, START);
        return undefined;
      });
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr().type).toBe("Busy");
    expect(h.fetcher.calls).toHaveLength(0);
  });

  it("two refreshes at once: the second is Busy and writes nothing", async () => {
    const clock = new Clock();
    const cache = new MemoryCache(clock);
    const release = deferred<void>();
    const envelope = await signed(list(2));
    const first = harness(
      async () => {
        await release.promise;
        return new Response(envelope, { status: 200 });
      },
      {},
      { clock, cache },
    );
    const second = harness(serve(envelope), {}, { clock, cache });

    const running = first.models.refresh({ settings: AUTO });
    // Let the first take the lock and start its request.
    while (first.fetcher.calls.length === 0) await Bun.sleep(1);
    const writesBefore = [...cache.writes];
    const busy = await second.models.refresh({ settings: AUTO });
    expect(busy._unsafeUnwrapErr().type).toBe("Busy");
    expect(cache.writes).toEqual(writesBefore);
    expect(second.fetcher.calls).toHaveLength(0);

    release.resolve();
    expect((await running)._unsafeUnwrap().type).toBe("Downloaded");
    expect(cache.text(PATHS.applied)).toBe(envelope);
  });

  it("re-reads applied.json after the download, so a slower writer cannot regress it", async () => {
    // Another writer promotes a newer list while this one's request is in
    // flight (for example after taking over an abandoned lock).
    const newer = await signed(list(3));
    const h = harness();
    h.cache.put(PATHS.applied, await signed(list(1)));
    h.fetcher.responder = async () => {
      h.cache.put(PATHS.applied, newer);
      return new Response(await signed(list(2)), { status: 200 });
    };
    const result = await h.models.refresh({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CheckFailed",
      failure: { type: "NotNewer", appliedIssued: "2026-10-03T09:00:00Z" },
    });
    expect(h.cache.text(PATHS.applied)).toBe(newer);
    expect(h.cache.text(PATHS.latest)).toBeUndefined();
  });

  it("is released when the check fails", async () => {
    const h = harness(() => Promise.reject(new TypeError("offline")));
    await h.models.refresh({ settings: AUTO });
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe("apply", () => {
  it("promotes a verified latest that is newer than applied", async () => {
    const latest = await signed(list(3));
    const h = harness();
    h.cache.put(PATHS.applied, await signed(list(2)));
    h.cache.put(PATHS.latest, latest);
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrap()).toEqual({
      type: "Applied",
      channel: "stable",
      issued: "2026-10-03T09:00:00Z",
      previousIssued: "2026-10-02T09:00:00Z",
    });
    expect(h.cache.text(PATHS.applied)).toBe(latest);
    expect(h.cache.dirs.has(PATHS.lock)).toBe(false);
    expect(h.cache.writes[0]).toBe(`mkdir ${PATHS.lock}`);
    expect(h.fetcher.calls).toHaveLength(0);
  });

  it("promotes into an empty applied slot", async () => {
    const h = harness();
    h.cache.put(PATHS.latest, await signed(list(2)));
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrap()).toEqual({
      type: "Applied",
      channel: "stable",
      issued: "2026-10-02T09:00:00Z",
    });
  });

  it("has nothing to apply without a latest", async () => {
    const h = harness();
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrap()).toEqual({
      type: "NothingToApply",
      channel: "stable",
      reason: "NoLatest",
    });
  });

  it("has nothing to apply when latest is not newer", async () => {
    const envelope = await signed(list(2));
    const h = harness();
    h.cache.put(PATHS.applied, envelope);
    h.cache.put(PATHS.latest, envelope);
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrap()).toEqual({
      type: "NothingToApply",
      channel: "stable",
      reason: "NotNewer",
      appliedIssued: "2026-10-02T09:00:00Z",
    });
    expect(h.cache.writes.filter((entry) => entry.startsWith("move "))).toEqual(
      [],
    );
  });

  it("refuses a latest that no longer verifies", async () => {
    const h = harness();
    h.cache.put(PATHS.latest, await signed(list(2)));
    h.clock.advance(100 * 24 * HOUR);
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "LatestRejected",
      error: { type: "Expired" },
    });
    expect(h.cache.text(PATHS.applied)).toBeUndefined();
  });

  it("is Busy while another process holds the lock", async () => {
    const h = harness();
    h.cache.put(PATHS.latest, await signed(list(2)));
    h.cache.dirs.set(PATHS.lock, START);
    const result = await h.models.apply({ settings: NOTIFY });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "Busy",
      channel: "stable",
    });
    expect(h.cache.writes).toEqual([]);
  });

  it("refuses when model updates are off", async () => {
    const h = harness();
    const result = await h.models.apply({ settings: { mode: "off" } });
    expect(result._unsafeUnwrapErr()).toEqual({ type: "Off" });
    expect(h.cache.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("status", () => {
  it("summarizes an empty cache", async () => {
    const h = harness();
    const status = (
      await h.models.status({ settings: NOTIFY })
    )._unsafeUnwrap();
    expect(status).toEqual({
      mode: "notify",
      channel: "stable",
      applied: { state: "none" },
    });
    expect(h.cache.writes).toEqual([]);
  });

  it("reports the applied list, a waiting newer one, the last check and the last error", async () => {
    const h = harness();
    h.cache.put(PATHS.applied, await signed(list(1)));
    h.cache.put(PATHS.latest, await signed(list(2)));
    const at = new Date(START - HOUR).toISOString();
    h.cache.put(
      PATHS.state,
      JSON.stringify({
        version: 1,
        lastCheck: at,
        lastError: { code: "Timeout", message: "timed out", at },
      }),
    );
    const status = (
      await h.models.status({ settings: { mode: "notify", channel: "stable" } })
    )._unsafeUnwrap();
    expect(status).toEqual({
      mode: "notify",
      channel: "stable",
      applied: {
        state: "usable",
        list: {
          issued: "2026-10-01T09:00:00Z",
          expires: "2026-12-29T09:00:00Z",
          evidence: "https://tryweave.io/evals/runs/run-1",
        },
      },
      waiting: {
        issued: "2026-10-02T09:00:00Z",
        expires: "2026-12-30T09:00:00Z",
        evidence: "https://tryweave.io/evals/runs/run-2",
      },
      lastCheck: at,
      nextCheckAt: new Date(
        START - HOUR + MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS,
      ).toISOString(),
      lastError: { code: "Timeout", message: "timed out", at },
    });
    expect(h.cache.writes).toEqual([]);
  });

  it("says why an applied file cannot be used", async () => {
    const h = harness();
    h.cache.put(PATHS.applied, "{ torn");
    const status = (await h.models.status({ settings: AUTO }))._unsafeUnwrap();
    expect(status.applied).toMatchObject({
      state: "unusable",
      reason: { type: "EnvelopeInvalid" },
    });
  });

  it("turns a file access that throws into Unexpected", async () => {
    const h = harness();
    h.cache.exists = () => {
      throw new Error("permission denied");
    };
    const result = await h.models.status({ settings: AUTO });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "Unexpected",
      channel: "stable",
      message: "permission denied",
    });
  });

  it("reports mode off with no settings", async () => {
    const h = harness();
    const status = (
      await h.models.status({ settings: undefined })
    )._unsafeUnwrap();
    expect(status.mode).toBe("off");
    expect(status.channel).toBe("stable");
  });
});
