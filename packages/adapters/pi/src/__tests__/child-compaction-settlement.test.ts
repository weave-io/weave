import { describe, expect, it } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import {
  DEFAULT_COMPACTION_EVIDENCE_GRACE_MS,
  DEFAULT_COMPACTION_RESUME_TIMEOUT_MS,
} from "../child-compaction-settlement.js";
import {
  bytesToHex,
  generateNonceHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import { signEnvelope } from "../child-envelope.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import { createPiExtension, type PiExtensionDeps } from "../extension.js";
import type { JsonValue } from "../strict-json.js";
import type {
  PiCommandRegistration,
  PiEnvPort,
  PiEventHandler,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiToolRegistration,
} from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

/**
 * Synthetic replay of the real Pi 0.84 event order produced when
 * `@ogulcancelik/pi-codex-compaction` forces a threshold compaction inside a
 * private Weave RPC child.
 *
 * Observed live ordering (`ExtensionRunner.emit` awaits every handler
 * sequentially, extension by extension, in load order):
 *
 * ```
 * turn_start
 * message_update... / message_end
 * turn_end            → compaction ext: usage >= threshold → ctx.abort()
 * message_end         → stopReason "aborted" (or "error" for a local abort)
 * agent_settled #1    → compaction ext: ctx.compact({ onComplete })
 *                       Weave: (before this fix) terminal "failed"
 * session_before_compact / session_compact       (later ticks)
 * onComplete → sendUserMessage("Compaction completed. Continue.")
 * turn_start #2       ← the only structural resumption evidence
 * message_end (stop)
 * agent_settled #2    ← the genuine settlement
 * ```
 *
 * Weave cannot know whether its own `agent_settled` handler runs before or
 * after the compaction extension's, and it must never block the handler chain
 * (blocking would stop a later-ordered `ctx.compact()` from ever running). So
 * every abort/error settlement is recorded synchronously and published on a
 * bounded deferral instead.
 *
 * Every event here is synthetic. No persisted real session is used.
 */

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

class FakeEnvPort implements PiEnvPort {
  constructor(private readonly values: Map<string, string>) {}
  read(name: string): string | undefined {
    return this.values.get(name);
  }
  deleteValue(name: string): void {
    this.values.delete(name);
  }
}

class FakeOutputPort {
  readonly lines: Record<string, unknown>[] = [];
  writeLine(
    bytes: Uint8Array,
  ): ResultAsync<void, { type: "ChildOutputWriteFailed"; reason: string }> {
    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (line.length > 0) {
        this.lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    return okAsync(undefined);
  }
}

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

/** Deterministic timer port: nothing fires until a test fires it. */
class FakeTimerPort implements TimerPort {
  readonly scheduled: ScheduledTimer[] = [];
  schedule(callback: () => void, delayMs: number): TimerHandle {
    const entry: ScheduledTimer = {
      callback,
      delayMs,
      cancelled: false,
      fired: false,
    };
    this.scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }
  pending(): readonly ScheduledTimer[] {
    return this.scheduled.filter((entry) => !entry.cancelled && !entry.fired);
  }
  /** Fires every live timer once, in scheduling order. */
  fireAll(): void {
    for (const entry of [...this.scheduled]) {
      if (entry.cancelled || entry.fired) continue;
      entry.fired = true;
      entry.callback();
    }
  }
}

class MinimalFakeHost implements PiExtensionApi {
  readonly commands = new Map<string, PiCommandRegistration>();
  readonly events = new Map<string, PiEventHandler[]>();
  readonly sentUserMessages: string[] = [];
  registerCommand(name: string, registration: PiCommandRegistration): void {
    this.commands.set(name, registration);
  }
  getCommands() {
    return [];
  }
  on(event: string, handler: PiEventHandler): void {
    const existing = this.events.get(event) ?? [];
    existing.push(handler);
    this.events.set(event, existing);
  }
  sendUserMessage(content: string): void {
    this.sentUserMessages.push(content);
  }
  appendEntry(_type: string, _data: unknown): void {}
  getActiveTools(): readonly string[] {
    return [];
  }
  setActiveTools(_names: readonly string[]): void {}
  sendMessage(
    _message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    _options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
  ): void {}
  readonly registerToolCalls: PiToolRegistration[] = [];
  registerTool(tool: PiToolRegistration): void {
    this.registerToolCalls.push(tool);
  }
  setModel(_model: PiModelInfo): boolean {
    return true;
  }
  setThinkingLevel(_level: string): void {}
  async fire(
    event: string,
    payload: unknown,
    ctx: PiSessionContext,
  ): Promise<void> {
    for (const handler of this.events.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drains enough macrotasks for a signed envelope to have reached the port if
 * one was ever queued. Used only by assertions that nothing was published:
 * a single `flush()` can outrun the runtime's serialized send tail and report
 * an absence that is really a race.
 */
async function quiesce(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await flush();
}

/**
 * Waits for a settled envelope to actually reach the port. One `flush()` is
 * not enough: every outgoing envelope is HMAC-signed and queued on the child
 * runtime's serialized send tail, so it can land several macrotasks later.
 */
async function waitForSettlement(
  output: FakeOutputPort,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (settledLines(output).length === 0) {
    if (Date.now() >= deadline) {
      throw new Error("test setup: timed out waiting for a settled envelope");
    }
    await flush();
  }
}

function fakeCtx(): PiSessionContext {
  return {
    mode: "rpc",
    cwd: "/project",
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: false,
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
    },
  };
}

async function buildChildExtension(overrides: Partial<PiExtensionDeps> = {}) {
  const secretBytes = randomPort.randomBytes(32);
  const env = new FakeEnvPort(
    new Map([
      [WEAVE_CHILD_SECRET_ENV, bytesToHex(secretBytes)],
      [WEAVE_CHILD_ID_ENV, "child-1"],
      [WEAVE_CONTROLLER_GENERATION_ENV, "gen-1"],
    ]),
  );
  const output = new FakeOutputPort();
  const host = new MinimalFakeHost();
  const timers = new FakeTimerPort();
  const factory = createPiExtension({
    envPort: env,
    randomPort,
    hmacPort,
    processPort: new FakeChildProcessPort(),
    childOutputPort: output,
    childTimerPort: timers,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    ...overrides,
  });
  factory(host);
  await host.fire("session_start", {}, fakeCtx());
  return { host, output, timers, secretBytes };
}

function settledLines(output: FakeOutputPort): Record<string, unknown>[] {
  return output.lines.filter((line) => line.kind === "settled");
}

function cancelledLines(output: FakeOutputPort): Record<string, unknown>[] {
  return output.lines.filter((line) => line.kind === "cancelled");
}

/** Delivers one authenticated parent `cancel` control envelope. */
async function sendCancel(
  host: MinimalFakeHost,
  secretBytes: Uint8Array,
  sequence = 1,
): Promise<void> {
  const envelope = await signEnvelope(
    {
      childId: "child-1",
      generationId: "gen-1",
      direction: "parent-to-child",
      sequence,
      nonce: generateNonceHex(randomPort),
      correlationId: "child-1",
      kind: "cancel",
      body: { reason: "parent-cancelled" },
    },
    secretBytes,
    hmacPort,
  );
  const control = host.commands.get("weave:__control__");
  await control?.handler(JSON.stringify(envelope._unsafeUnwrap()), fakeCtx());
}

function settledBody(
  output: FakeOutputPort,
): Record<string, unknown> | undefined {
  const line = settledLines(output).at(-1);
  return line?.body as Record<string, unknown> | undefined;
}

async function assistantMessageEnd(
  host: MinimalFakeHost,
  message: {
    id: string;
    stopReason: string;
    text?: string;
    error?: JsonValue;
  },
): Promise<void> {
  await host.fire(
    "message_end",
    {
      type: "message_end",
      message: {
        role: "assistant",
        id: message.id,
        stopReason: message.stopReason,
        content:
          message.text === undefined
            ? []
            : [{ type: "text", text: message.text }],
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    },
    fakeCtx(),
  );
}

async function compactionLifecycle(host: MinimalFakeHost): Promise<void> {
  await host.fire(
    "session_before_compact",
    {
      type: "session_before_compact",
      reason: "manual",
      willRetry: false,
      preparation: { firstKeptEntryId: "e-1", tokensBefore: 100 },
      branchEntries: [],
    },
    fakeCtx(),
  );
  await host.fire(
    "session_compact",
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      fromExtension: true,
      compactionEntry: { type: "compaction", summary: "checkpoint" },
    },
    fakeCtx(),
  );
}

describe("private child settlement across a forced context compaction", () => {
  it("does not publish a terminal failed settlement for the compaction abort, and publishes exactly one completed settlement after the resumed run", async () => {
    const { host, output, timers } = await buildChildExtension();

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "pre-compaction",
      stopReason: "aborted",
    });
    await host.fire("turn_end", { type: "turn_end", turnIndex: 0 }, fakeCtx());
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    // The exact root symptom: before the fix this is a terminal `failed`
    // settlement, so the parent renders the child as failed while the child
    // is still perfectly healthy and about to compact.
    expect(settledLines(output)).toHaveLength(0);

    await compactionLifecycle(host);
    await flush();

    // Resumption: the compaction extension's `sendUserMessage` starts a turn.
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "post-compaction",
      stopReason: "stop",
      text: "resumed verdict",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    const body = settledBody(output);
    expect(body?.outcome).toBe("completed");
    expect(body?.assistantOutput).toBe("resumed verdict");
    // Nothing is left armed once the child has genuinely settled.
    expect(timers.pending()).toHaveLength(0);
  });

  it("reproduces the same cycle when the local abort surfaces as stopReason error with no provider payload", async () => {
    const { host, output } = await buildChildExtension();

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "pre-compaction",
      stopReason: "error",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    // `assistant error · details unavailable` was the reported symptom.
    expect(settledLines(output)).toHaveLength(0);

    await compactionLifecycle(host);
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "post-compaction",
      stopReason: "stop",
      text: "verdict after compaction",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("completed");
    expect(settledBody(output)?.assistantOutput).toBe(
      "verdict after compaction",
    );
  });

  it("fails closed with the original sanitized reason when compaction never starts", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, {
      id: "aborted",
      stopReason: "aborted",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);
    expect(timers.pending()).toHaveLength(1);

    // No compaction lifecycle ever arrives: the bounded grace expires and the
    // original terminal verdict is published unchanged.
    timers.fireAll();
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    const body = settledBody(output);
    expect(body?.outcome).toBe("failed");
    expect(body?.reason).toBe("assistant stop reason: aborted");
  });

  it("fails closed when compaction starts but the child never resumes", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    await compactionLifecycle(host);
    await flush();
    // The grace timer was replaced by the bounded resume timer - never left
    // unbounded.
    expect(timers.pending()).toHaveLength(1);
    expect(settledLines(output)).toHaveLength(0);

    timers.fireAll();
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");
    expect(settledBody(output)?.reason).toBe("assistant stop reason: aborted");
    expect(timers.pending()).toHaveLength(0);
  });

  it("keeps a genuine provider error terminal with its sanitized reason", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, {
      id: "provider-failure",
      stopReason: "error",
      error: {
        type: "api_error",
        status: 429,
        provider: "openai",
        message: "rate limited",
      },
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);

    timers.fireAll();
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    const body = settledBody(output);
    expect(body?.outcome).toBe("failed");
    expect(typeof body?.reason).toBe("string");
    expect(body?.reason as string).toStartWith("assistant error");
    // Sanitization is untouched: no raw provider prose leaks into the reason.
    expect(body?.reason as string).not.toContain("rate limited");
  });

  it("never publishes a second settlement when agent_settled repeats during and after a compaction cycle", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);
    // A repeated abort settlement must not arm a second timer.
    expect(timers.pending()).toHaveLength(1);

    await compactionLifecycle(host);
    // The compaction extension re-enters `agent_settled` in its `compacted`
    // phase before it sends the continuation prompt.
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "resumed",
      stopReason: "stop",
      text: "final",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("completed");

    // Even a stray expiry after the child settled publishes nothing more.
    timers.fireAll();
    await flush();
    expect(settledLines(output)).toHaveLength(1);
  });

  it("leaves an ordinary successful settlement on its existing immediate path", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, {
      id: "ok",
      stopReason: "stop",
      text: "plain answer",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("completed");
    expect(settledBody(output)?.assistantOutput).toBe("plain answer");
    expect(timers.pending()).toHaveLength(0);
  });

  it("arms nothing past session shutdown, leaving the parent's exit classification to own the outcome", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);
    expect(timers.pending()).toHaveLength(1);

    await host.fire(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      fakeCtx(),
    );
    await flush();

    // The adapter's own shutdown handler runs first and has already torn the
    // child runtime down, so nothing can be sent from here. What must not
    // happen is a timer surviving the session and firing into a dead runtime.
    expect(timers.pending()).toHaveLength(0);
    timers.fireAll();
    await flush();
    expect(settledLines(output)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Settlement authority: a captured failure is discarded ONLY on structural
  // compaction evidence. An unrelated later turn is not evidence.
  // -------------------------------------------------------------------------

  it("does not convert an observed abort into a later unrelated turn's success", async () => {
    const { host, output } = await buildChildExtension();

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(settledLines(output)).toHaveLength(0);

    // A new turn with NO compaction lifecycle event anywhere. Nothing here is
    // evidence of a compaction, so the recorded failure still owns the run.
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "unrelated",
      stopReason: "stop",
      text: "unrelated success",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    const body = settledBody(output);
    expect(body?.outcome).toBe("failed");
    expect(body?.reason).toBe("assistant stop reason: aborted");
    expect(body?.assistantOutput).toBeUndefined();
  });

  it("publishes the deferred failure as soon as an unrelated turn starts, with no settlement of its own", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(timers.pending()).toHaveLength(1);

    // A turn that starts with no compaction evidence proves the compaction
    // that would have justified the abort never began, so the captured verdict
    // is published at once and nothing is left armed.
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await waitForSettlement(output);
    expect(timers.pending()).toHaveLength(0);

    timers.fireAll();
    await quiesce();

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");
    expect(settledBody(output)?.reason).toBe("assistant stop reason: aborted");
  });

  it("never lets compaction evidence that arrives after an unrelated turn adopt the earlier failure", async () => {
    const { host, output, timers } = await buildChildExtension();

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    // An unrelated turn starts with NO compaction evidence: the captured
    // failure becomes terminal here.
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await waitForSettlement(output);
    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");

    // Late lifecycle evidence belongs to that later turn. It must not reach
    // back, adopt the closed verdict, and resume it into a success.
    await compactionLifecycle(host);
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "resumed",
      stopReason: "stop",
      text: "late success",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    timers.fireAll();
    await quiesce();

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");
    expect(settledBody(output)?.reason).toBe("assistant stop reason: aborted");
    expect(settledBody(output)?.assistantOutput).toBeUndefined();
    expect(timers.pending()).toHaveLength(0);
  });

  it("discards the captured failure only when compaction evidence precedes the resumed turn", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await compactionLifecycle(host);
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await flush();

    // Evidence-backed resumption: nothing captured, nothing armed.
    expect(timers.pending()).toHaveLength(0);

    await assistantMessageEnd(host, {
      id: "resumed",
      stopReason: "stop",
      text: "resumed verdict",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("completed");
  });

  it("records compaction evidence that arrives before Weave observes the abort (compaction extension loaded first)", async () => {
    const { host, output, timers } = await buildChildExtension();

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    // Handler order B: the compaction extension is loaded BEFORE Weave, so its
    // `agent_settled` handler already drove `ctx.compact()` to completion by
    // the time Weave's own handler runs.
    await compactionLifecycle(host);
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    expect(settledLines(output)).toHaveLength(0);
    // The evidence was recorded, so the child waits on the bounded RESUME
    // budget, not on the short evidence grace that would fail a healthy child
    // mid-compaction.
    const pending = timers.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.delayMs).toBe(DEFAULT_COMPACTION_RESUME_TIMEOUT_MS);

    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "resumed",
      stopReason: "stop",
      text: "verdict after compaction",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("completed");
    expect(timers.pending()).toHaveLength(0);
  });

  it("bounds a compaction-evidence window that no abort ever follows", async () => {
    const { host, output, timers } = await buildChildExtension();

    await compactionLifecycle(host);
    await flush();
    const pending = timers.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.delayMs).toBe(DEFAULT_COMPACTION_EVIDENCE_GRACE_MS);

    // The window closes on its own and publishes nothing.
    timers.fireAll();
    await flush();
    expect(settledLines(output)).toHaveLength(0);
    expect(timers.pending()).toHaveLength(0);

    // A genuine failure observed after the window is ordinary again: it is
    // deferred on the short grace and published unchanged.
    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    timers.fireAll();
    await waitForSettlement(output);

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");
  });

  it("ignores compaction evidence that arrives after the failure was already published", async () => {
    const { host, output, timers } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    timers.fireAll();
    await waitForSettlement(output);
    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");

    // Late evidence, a late resumed turn, and a late settlement all arrive
    // after the terminal verdict. None of them may reopen a closed gate.
    await compactionLifecycle(host);
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "late",
      stopReason: "stop",
      text: "late success",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    timers.fireAll();
    await quiesce();

    expect(settledLines(output)).toHaveLength(1);
    expect(settledBody(output)?.outcome).toBe("failed");
    expect(timers.pending()).toHaveLength(0);
  });

  it("does not defer a genuine cancellation settlement after a cancel control envelope", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    await sendCancel(host, secretBytes);
    await flush();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();

    // Cancellation already owns the terminal outcome; no `settled` envelope
    // is ever produced, deferred or otherwise.
    expect(settledLines(output)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Cancellation is terminal: it closes the gate BEFORE `cancelled` is
  // published, so no armed timer can publish a second authenticated verdict.
  // -------------------------------------------------------------------------

  it("closes the gate when cancellation arrives while a failure is deferred", async () => {
    const { host, output, timers, secretBytes } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(timers.pending()).toHaveLength(1);

    await sendCancel(host, secretBytes);
    await flush();

    // The gate is disarmed as part of cancelling, not eventually.
    expect(timers.pending()).toHaveLength(0);
    expect(cancelledLines(output)).toHaveLength(1);
    expect(settledLines(output)).toHaveLength(0);

    // Even if the host still runs the expired callback, nothing is published.
    timers.fireAll();
    await quiesce();
    expect(settledLines(output)).toHaveLength(0);
    expect(cancelledLines(output)).toHaveLength(1);
  });

  it("closes the gate when cancellation arrives while the child is compacting", async () => {
    const { host, output, timers, secretBytes } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await compactionLifecycle(host);
    await flush();
    expect(timers.pending()).toHaveLength(1);

    await sendCancel(host, secretBytes);
    await flush();

    expect(timers.pending()).toHaveLength(0);
    expect(cancelledLines(output)).toHaveLength(1);
    expect(settledLines(output)).toHaveLength(0);

    timers.fireAll();
    await quiesce();
    expect(settledLines(output)).toHaveLength(0);
  });

  it("never publishes an authenticated failed settlement after cancellation, in either gate state", async () => {
    for (const compactFirst of [false, true]) {
      const { host, output, timers, secretBytes } = await buildChildExtension();

      await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
      await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
      if (compactFirst) await compactionLifecycle(host);
      await sendCancel(host, secretBytes);
      await flush();

      // Whatever the host does with an already-scheduled callback, the
      // parent has recorded `cancelled` and must never receive a second,
      // authenticated terminal verdict for the same child.
      timers.fireAll();
      await quiesce();

      expect(settledLines(output)).toHaveLength(0);
      expect(cancelledLines(output)).toHaveLength(1);
    }
  });

  it("publishes nothing more when late events follow a cancellation of a deferred failure", async () => {
    const { host, output, timers, secretBytes } = await buildChildExtension();

    await assistantMessageEnd(host, { id: "aborted", stopReason: "aborted" });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await sendCancel(host, secretBytes);
    await flush();

    // A duplicate cancel, a late compaction, a late resumed turn and a late
    // settlement all arrive after the terminal cancellation.
    await sendCancel(host, secretBytes, 2);
    await compactionLifecycle(host);
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await assistantMessageEnd(host, {
      id: "late",
      stopReason: "stop",
      text: "late success",
    });
    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    timers.fireAll();
    await quiesce();

    expect(settledLines(output)).toHaveLength(0);
    expect(timers.pending()).toHaveLength(0);
  });
});
