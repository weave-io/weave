import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  createPiChildExtensionUiBridge,
  normalizePiExtensionUiRequest,
  type PiChildExtensionUiResponseSender,
  type PiChildExtensionUiSnapshot,
} from "../child-extension-ui.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import type { PiExtensionUiResponseInput } from "../rpc-child.js";

const childId = "child-a";
const generationId = "generation-1";

type SenderError = "send failed";

function extensionEvent(
  requestType: "notification" | "widget" | "dialog",
  requestId: string,
  payload: Record<string, unknown> = {},
): PiChildSessionEvent {
  return {
    type: "extension_ui_request",
    requestType,
    requestId,
    ...payload,
  } as PiChildSessionEvent;
}

function response(
  requestId: string,
  value: string | boolean,
): PiExtensionUiResponseInput {
  return {
    type: "extension_ui_response",
    requestId,
    response: value,
  };
}

function dialog(requestId: string, kind: string): PiChildSessionEvent {
  return extensionEvent("dialog", requestId, {
    dialog: {
      type: kind,
      message: "Continue?",
      options: ["one", "two"],
      secret: "do-not-copy",
    },
  });
}

function senderFixture(
  calls: PiExtensionUiResponseInput[],
  result: ResultAsync<void, SenderError> = okAsync(undefined),
): PiChildExtensionUiResponseSender<SenderError> {
  return (_child, _generation, sent) => {
    calls.push(sent);
    return result;
  };
}

describe("normalizePiExtensionUiRequest", () => {
  it.each([
    [
      "select",
      {
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Pick one",
        options: ["one", "two"],
        timeout: 1_000,
      },
      {
        type: "extension_ui_request",
        requestType: "dialog",
        requestId: "select-1",
        dialog: {
          method: "select",
          title: "Pick one",
          options: ["one", "two"],
          timeout: 1_000,
        },
      },
    ],
    [
      "confirm",
      {
        type: "extension_ui_request",
        id: "confirm-1",
        method: "confirm",
        title: "Delete?",
        message: "This cannot be undone.",
      },
      {
        type: "extension_ui_request",
        requestType: "dialog",
        requestId: "confirm-1",
        dialog: {
          method: "confirm",
          title: "Delete?",
          message: "This cannot be undone.",
        },
      },
    ],
    [
      "input",
      {
        type: "extension_ui_request",
        id: "input-1",
        method: "input",
        title: "Name",
        placeholder: "Enter a name",
        timeout: 0,
      },
      {
        type: "extension_ui_request",
        requestType: "dialog",
        requestId: "input-1",
        dialog: {
          method: "input",
          title: "Name",
          placeholder: "Enter a name",
          timeout: 0,
        },
      },
    ],
    [
      "editor",
      {
        type: "extension_ui_request",
        id: "editor-1",
        method: "editor",
        title: "Edit prompt",
        prefill: "Draft text",
      },
      {
        type: "extension_ui_request",
        requestType: "dialog",
        requestId: "editor-1",
        dialog: {
          method: "editor",
          title: "Edit prompt",
          prefill: "Draft text",
        },
      },
    ],
  ] as const)("normalizes the native %s request", (_method, input, expected) => {
    const result = normalizePiExtensionUiRequest(input);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  it.each([
    ["non-object", null],
    ["wrong type", { type: "other", id: "id", method: "input", title: "t" }],
    [
      "missing title",
      { type: "extension_ui_request", id: "id", method: "input" },
    ],
    [
      "missing options",
      { type: "extension_ui_request", id: "id", method: "select", title: "t" },
    ],
    [
      "extra field",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "t",
        unexpected: "do not copy",
      },
    ],
    [
      "NUL in id",
      {
        type: "extension_ui_request",
        id: "id\0hidden",
        method: "input",
        title: "t",
      },
    ],
    [
      "NUL in title",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "t\0hidden",
      },
    ],
    [
      "negative timeout",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "t",
        timeout: -1,
      },
    ],
    [
      "infinite timeout",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "t",
        timeout: Number.POSITIVE_INFINITY,
      },
    ],
    [
      "oversized timeout",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "t",
        timeout: Number.MAX_SAFE_INTEGER,
      },
    ],
    [
      "oversized title",
      {
        type: "extension_ui_request",
        id: "id",
        method: "input",
        title: "x".repeat(16_385),
      },
    ],
    [
      "too many options",
      {
        type: "extension_ui_request",
        id: "id",
        method: "select",
        title: "t",
        options: Array.from({ length: 129 }, (_, index) => String(index)),
      },
    ],
  ] as const)("rejects %s", (_case, input) => {
    const result = normalizePiExtensionUiRequest(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "malformed_request" });
  });

  it.each([
    [
      "without notifyType",
      {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "Build complete",
      },
      {
        type: "extension_ui_request",
        requestType: "notification",
        requestId: "notify-1",
        message: "Build complete",
      },
    ],
    [
      "with notifyType",
      {
        type: "extension_ui_request",
        id: "notify-2",
        method: "notify",
        message: "Build failed",
        notifyType: "error",
      },
      {
        type: "extension_ui_request",
        requestType: "notification",
        requestId: "notify-2",
        message: "Build failed",
        notifyType: "error",
      },
    ],
  ] as const)("normalizes native notify requests %s", (_case, input, expected) => {
    const result = normalizePiExtensionUiRequest(input);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  it.each([
    [
      "extra key",
      {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "notice",
        unexpected: "do not copy",
      },
    ],
    [
      "bad notifyType",
      {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "notice",
        notifyType: "success",
      },
    ],
    [
      "NUL in id",
      {
        type: "extension_ui_request",
        id: "notify\0hidden",
        method: "notify",
        message: "notice",
      },
    ],
    [
      "NUL in message",
      {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "notice\0hidden",
      },
    ],
    [
      "oversized message",
      {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "x".repeat(16_385),
      },
    ],
  ] as const)("rejects native notify requests with %s", (_case, input) => {
    const result = normalizePiExtensionUiRequest(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "malformed_request" });
  });

  it("rejects malformed unsupported methods without exposing the input", () => {
    const result = normalizePiExtensionUiRequest({
      type: "extension_ui_request",
      id: "id",
      method: "future-method",
      title: "t",
      secret: "do not echo",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "malformed_request" });
  });

  it("reports a well-formed unsupported method without echoing it", () => {
    const result = normalizePiExtensionUiRequest({
      type: "extension_ui_request",
      id: "id",
      method: "future-method",
      title: "t",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "unsupported_method" });
  });
});

describe("PiChildExtensionUiBridge", () => {
  it("projects notifications and bounded widget methods without raw payloads", () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });

    expect(
      bridge
        .consume(
          extensionEvent("notification", "notice-1", {
            message: "hello",
            secret: "notification-canary",
          }),
        )
        .isOk(),
    ).toBe(true);
    for (const [method, payload] of [
      [
        "setWidget",
        { name: "build", content: "running", secret: "widget-canary" },
      ],
      ["setStatus", { status: "working", secret: "status-canary" }],
      ["setTitle", { title: "Child", secret: "title-canary" }],
      ["setEditorText", { text: "draft", secret: "editor-canary" }],
    ] as const) {
      expect(
        bridge
          .consume(
            extensionEvent("widget", `widget-${method}`, {
              widget: { method, ...payload },
            }),
          )
          .isOk(),
      ).toBe(true);
    }

    const view = bridge.snapshot();
    expect(view.notifications).toEqual(["hello"]);
    expect(view.widgets).toEqual({ build: { content: "running" } });
    expect(view.status).toBe("working");
    expect(view.title).toBe("Child");
    expect(view.editorText).toBe("draft");
    expect(JSON.stringify(view)).not.toContain("canary");
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.widgets)).toBe(true);
    expect(calls).toHaveLength(0);

    bridge.consume(
      extensionEvent("widget", "remove", {
        widget: { method: "removeWidget", name: "build" },
      }),
    );
    bridge.consume(
      extensionEvent("widget", "clear", { widget: { method: "clearWidgets" } }),
    );
    bridge.consume(
      extensionEvent("widget", "clear-status", {
        widget: { method: "clearStatus" },
      }),
    );
    bridge.consume(
      extensionEvent("widget", "clear-title", {
        widget: { method: "clearTitle" },
      }),
    );
    bridge.consume(
      extensionEvent("widget", "clear-editor", {
        widget: { method: "clearEditorText" },
      }),
    );
    expect(bridge.snapshot().widgets).toEqual({});
    expect(bridge.snapshot().status).toBeUndefined();
    expect(bridge.snapshot().title).toBeUndefined();
    expect(bridge.snapshot().editorText).toBeUndefined();
  });

  it("keeps multiple blocking dialogs pending and sends only correlated responses", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });

    expect(bridge.consume(dialog("confirm-1", "confirm")).isOk()).toBe(true);
    expect(bridge.consume(dialog("select-1", "select")).isOk()).toBe(true);
    expect(bridge.consume(dialog("input-1", "input")).isOk()).toBe(true);
    expect(bridge.snapshot().pendingDialogCount).toBe(3);

    expect((await bridge.respond(response("confirm-1", true))).isOk()).toBe(
      true,
    );
    expect(calls).toEqual([response("confirm-1", true)]);
    expect(bridge.snapshot().pendingDialogCount).toBe(2);
    expect((await bridge.respond(response("confirm-1", true))).isErr()).toBe(
      true,
    );
    expect(calls).toHaveLength(1);

    expect(
      (
        await bridge.respond(
          "other-child",
          generationId,
          response("select-1", "one"),
        )
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await bridge.respond(
          childId,
          "old-generation",
          response("select-1", "one"),
        )
      ).isErr(),
    ).toBe(true);
    expect(calls).toHaveLength(1);

    expect(
      (
        await bridge.respond({
          ...response("select-1", "one"),
          secret: "smuggled",
        } as PiExtensionUiResponseInput)
      ).isErr(),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(bridge.snapshot().pendingDialogCount).toBe(2);

    expect(
      (await bridge.cancel(childId, generationId, "select-1")).isOk(),
    ).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      type: "extension_ui_response",
      requestId: "select-1",
      cancelled: true,
    });
    expect(bridge.snapshot().pendingDialogCount).toBe(1);
  });

  it("preserves a pending dialog when the correlated sender fails, then retries", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    let attempts = 0;
    const sender: PiChildExtensionUiResponseSender<SenderError> = (
      _child,
      _generation,
      sent,
    ) => {
      calls.push(sent);
      attempts += 1;
      return attempts === 1 ? errAsync("send failed") : okAsync(undefined);
    };
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: sender,
    });
    bridge.consume(dialog("retry-1", "input"));

    expect((await bridge.respond(response("retry-1", "value"))).isErr()).toBe(
      true,
    );
    expect(bridge.snapshot().pendingDialogCount).toBe(1);
    expect((await bridge.respond(response("retry-1", "value"))).isOk()).toBe(
      true,
    );
    expect(bridge.snapshot().pendingDialogCount).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("accepts a blocking dialog with no optional host payload", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });
    expect(bridge.consume(extensionEvent("dialog", "generic-1")).isOk()).toBe(
      true,
    );
    expect(bridge.snapshot().dialogs[0]?.kind).toBe("input");
    expect((await bridge.respond(response("generic-1", "value"))).isOk()).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  it("applies a normalized notification without creating response authority", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });
    const normalized = normalizePiExtensionUiRequest({
      type: "extension_ui_request",
      id: "native-notify-1",
      method: "notify",
      message: "notice",
      notifyType: "warning",
    });

    expect(normalized.isOk()).toBe(true);
    expect(bridge.consume(normalized._unsafeUnwrap()).isOk()).toBe(true);
    expect(bridge.snapshot().notifications).toEqual(["notice"]);
    expect(bridge.snapshot().pendingDialogCount).toBe(0);
    expect(
      (await bridge.respond(response("native-notify-1", true))).isErr(),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not create response authority for fire-and-forget requests", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });
    bridge.consume(
      extensionEvent("notification", "not-dialog", { message: "notice" }),
    );
    bridge.consume(
      extensionEvent("widget", "not-dialog-2", {
        widget: { method: "setStatus", status: "status" },
      }),
    );

    expect((await bridge.respond(response("not-dialog", true))).isErr()).toBe(
      true,
    );
    expect((await bridge.respond(response("not-dialog-2", true))).isErr()).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
  });

  it("clears live authority on settlement while retaining immutable read-only history", async () => {
    const calls: PiExtensionUiResponseInput[] = [];
    const bridge = createPiChildExtensionUiBridge({
      childId,
      generationId,
      sendExtensionUiResponse: senderFixture(calls),
    });
    bridge.consume(dialog("history-1", "editor"));
    const before = bridge.snapshot();
    bridge.settle();

    const history = bridge.completedSnapshot() as PiChildExtensionUiSnapshot;
    expect(history.readOnly).toBe(true);
    expect(history.lifecycle).toBe("completed");
    expect(history.pendingDialogCount).toBe(1);
    expect(history.dialogs).toHaveLength(1);
    expect(Object.isFrozen(history)).toBe(true);
    expect((await bridge.respond(response("history-1", "late"))).isErr()).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
    expect(before.readOnly).toBe(false);
    expect(bridge.snapshot()).toBe(history);

    bridge.interrupt();
    bridge.dispose();
    expect(bridge.completedSnapshot()).toBe(history);
  });
});
