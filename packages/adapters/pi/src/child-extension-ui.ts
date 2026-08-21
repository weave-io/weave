import { err, errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  MAX_CHILD_EVENT_ITEMS,
  MAX_CHILD_EVENT_STRING,
  type PiChildSessionEvent,
  PiChildSessionEventSchema,
} from "./child-session-events.js";
import type { PiExtensionUiResponseInput } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";

const MAX_NOTIFICATIONS = MAX_CHILD_EVENT_ITEMS;
const MAX_WIDGETS = MAX_CHILD_EVENT_ITEMS;
const MAX_DIALOGS = MAX_CHILD_EVENT_ITEMS;
const MAX_WIDGET_NAME = 256;
const MAX_WIDGET_KEY = MAX_WIDGET_NAME;
const MAX_PI_EXTENSION_UI_REQUEST_ID = 256;
const MAX_PI_EXTENSION_UI_TIMEOUT_MS = 2_147_483_647;

const requestText = z
  .string()
  .max(MAX_CHILD_EVENT_STRING)
  .refine((value) => !value.includes("\0"));
const requestId = requestText.min(1).max(MAX_PI_EXTENSION_UI_REQUEST_ID);
const requestTimeout = z
  .number()
  .finite()
  .min(0)
  .max(MAX_PI_EXTENSION_UI_TIMEOUT_MS);

const nativeRequestEnvelopeSchema = z
  .object({
    type: z.unknown(),
    id: z.unknown(),
    method: z.unknown(),
    statusKey: z.unknown().optional(),
    statusText: z.unknown().optional(),
    title: z.unknown().optional(),
    options: z.unknown().optional(),
    message: z.unknown().optional(),
    notifyType: z.unknown().optional(),
    placeholder: z.unknown().optional(),
    prefill: z.unknown().optional(),
    text: z.unknown().optional(),
    widgetKey: z.unknown().optional(),
    widgetLines: z.unknown().optional(),
    widgetPlacement: z.unknown().optional(),
    timeout: z.unknown().optional(),
  })
  .strict();

const nativeSelectRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("select"),
    title: requestText,
    options: z.array(requestText).min(1).max(MAX_CHILD_EVENT_ITEMS),
    timeout: requestTimeout.optional(),
  })
  .strict();

const nativeConfirmRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("confirm"),
    title: requestText,
    message: requestText,
    timeout: requestTimeout.optional(),
  })
  .strict();

const nativeNotifyRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("notify"),
    message: requestText,
    notifyType: z.enum(["info", "warning", "error"]).optional(),
  })
  .strict();

const nativeSetTitleRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("setTitle"),
    title: requestText.min(1),
  })
  .strict();

const nativeSetStatusRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("setStatus"),
    statusKey: requestText.min(1),
    statusText: requestText.optional(),
  })
  .strict();

const nativeInputRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("input"),
    title: requestText,
    placeholder: requestText.optional(),
    timeout: requestTimeout.optional(),
  })
  .strict();

const nativeEditorRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("editor"),
    title: requestText,
    prefill: requestText.optional(),
    timeout: requestTimeout.optional(),
  })
  .strict();

const nativeSetWidgetRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("setWidget"),
    widgetKey: requestText.min(1).max(MAX_WIDGET_KEY),
    widgetLines: z
      .array(requestText)
      .max(MAX_CHILD_EVENT_ITEMS)
      .optional(),
    widgetPlacement: z
      .enum(["aboveEditor", "belowEditor"])
      .optional(),
  })
  .strict();

const nativeSetEditorTextRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: requestId,
    method: z.literal("set_editor_text"),
    text: requestText.min(1),
  })
  .strict();
export type PiExtensionUiRequestNormalizationErrorCode =
  | "malformed_request"
  | "unsupported_method";

export interface PiExtensionUiRequestNormalizationError {
  readonly code: PiExtensionUiRequestNormalizationErrorCode;
}

export type PiNormalizedExtensionUiDialog =
  | {
      readonly method: "select";
      readonly title: string;
      readonly options: readonly string[];
      readonly timeout?: number;
    }
  | {
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
      readonly timeout?: number;
    };

export type PiNormalizedExtensionUiNotifyType = "info" | "warning" | "error";

type PiNormalizedExtensionUiSetWidgetRequest =
  | {
      readonly method: "setWidget";
      readonly widgetKey: string;
      readonly widgetLines?: readonly string[];
      readonly widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      readonly method: "setTitle";
      readonly title: string;
    }
  | {
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText?: string;
    }
  | {
      readonly method: "set_editor_text";
      readonly text: string;
    };

export type PiNormalizedExtensionUiRequest =
  | {
      readonly type: "extension_ui_request";
      readonly requestType: "notification";
      readonly requestId: string;
      readonly message: string;
      readonly notifyType?: PiNormalizedExtensionUiNotifyType;
      readonly widget?: never;
    }
  | {
      readonly type: "extension_ui_request";
      readonly requestType: "dialog";
      readonly requestId: string;
      readonly dialog: PiNormalizedExtensionUiDialog;
      readonly widget?: never;
    }
  | {
      readonly type: "extension_ui_request";
      readonly requestType: "widget";
      readonly requestId: string;
      readonly widget: PiNormalizedExtensionUiSetWidgetRequest;
    };

function normalizationError(
  code: PiExtensionUiRequestNormalizationErrorCode,
): PiExtensionUiRequestNormalizationError {
  return { code };
}

function parseNativeRequest<T>(
  schema: z.ZodType<T>,
  value: unknown,
): Result<T, PiExtensionUiRequestNormalizationError> {
  const parsed = Result.fromThrowable(
    () => schema.safeParse(value),
    () => normalizationError("malformed_request"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  return parsed.value.success
    ? ok(parsed.value.data)
    : err(normalizationError("malformed_request"));
}

export function normalizePiExtensionUiRequest(
  value: unknown,
): Result<
  PiNormalizedExtensionUiRequest,
  PiExtensionUiRequestNormalizationError
> {
  const envelope = parseNativeRequest(nativeRequestEnvelopeSchema, value);
  if (envelope.isErr()) return err(envelope.error);

  const method = envelope.value.method;
  if (typeof method !== "string") {
    return err(normalizationError("malformed_request"));
  }
  if (
    method !== "select" &&
    method !== "confirm" &&
    method !== "notify" &&
    method !== "setTitle" &&
    method !== "setStatus" &&
    method !== "input" &&
    method !== "editor" &&
    method !== "setWidget" &&
    method !== "set_editor_text"
  ) {
    return err(normalizationError("unsupported_method"));
  }

  if (method === "setTitle") {
    const parsed = parseNativeRequest(nativeSetTitleRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "widget",
      requestId: parsed.value.id,
      widget: {
        method: "setTitle",
        title: parsed.value.title,
      },
    });
  }

  if (method === "setStatus") {
    const parsed = parseNativeRequest(nativeSetStatusRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "widget",
      requestId: parsed.value.id,
      widget: {
        method: "setStatus",
        statusKey: parsed.value.statusKey,
        statusText: parsed.value.statusText,
      },
    });
  }

  if (method === "setWidget") {
    const parsed = parseNativeRequest(nativeSetWidgetRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "widget",
      requestId: parsed.value.id,
      widget: {
        method: "setWidget",
        widgetKey: parsed.value.widgetKey,
        ...(parsed.value.widgetLines === undefined
          ? {}
          : { widgetLines: parsed.value.widgetLines }),
        ...(parsed.value.widgetPlacement === undefined
          ? {}
          : { widgetPlacement: parsed.value.widgetPlacement }),
      },
    });
  }

  if (method === "set_editor_text") {
    const parsed = parseNativeRequest(nativeSetEditorTextRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "widget",
      requestId: parsed.value.id,
      widget: {
        method: "set_editor_text",
        text: parsed.value.text,
      },
    });
  }

  if (method === "select") {
    const parsed = parseNativeRequest(nativeSelectRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: parsed.value.id,
      dialog: {
        method: "select",
        title: parsed.value.title,
        options: parsed.value.options,
        ...(parsed.value.timeout === undefined
          ? {}
          : { timeout: parsed.value.timeout }),
      },
    });
  }

  if (method === "confirm") {
    const parsed = parseNativeRequest(nativeConfirmRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: parsed.value.id,
      dialog: {
        method: "confirm",
        title: parsed.value.title,
        message: parsed.value.message,
        ...(parsed.value.timeout === undefined
          ? {}
          : { timeout: parsed.value.timeout }),
      },
    });
  }

  if (method === "notify") {
    const parsed = parseNativeRequest(nativeNotifyRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "notification",
      requestId: parsed.value.id,
      message: parsed.value.message,
      ...(parsed.value.notifyType === undefined
        ? {}
        : { notifyType: parsed.value.notifyType }),
    });
  }

  if (method === "input") {
    const parsed = parseNativeRequest(nativeInputRequestSchema, value);
    if (parsed.isErr()) return err(parsed.error);
    return ok({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: parsed.value.id,
      dialog: {
        method: "input",
        title: parsed.value.title,
        ...(parsed.value.placeholder === undefined
          ? {}
          : { placeholder: parsed.value.placeholder }),
        ...(parsed.value.timeout === undefined
          ? {}
          : { timeout: parsed.value.timeout }),
      },
    });
  }

  const parsed = parseNativeRequest(nativeEditorRequestSchema, value);
  if (parsed.isErr()) return err(parsed.error);
  return ok({
    type: "extension_ui_request",
    requestType: "dialog",
    requestId: parsed.value.id,
    dialog: {
      method: "editor",
      title: parsed.value.title,
      ...(parsed.value.prefill === undefined
        ? {}
        : { prefill: parsed.value.prefill }),
      ...(parsed.value.timeout === undefined
        ? {}
        : { timeout: parsed.value.timeout }),
    },
  });
}

export type PiChildExtensionUiDialogKind =
  | "confirm"
  | "select"
  | "input"
  | "editor";

export interface PiChildExtensionUiWidgetSnapshot {
  readonly content: string;
}

export interface PiChildExtensionUiDialogSnapshot {
  readonly requestId: string;
  readonly kind: PiChildExtensionUiDialogKind;
  readonly pending: true;
  readonly message?: string;
  readonly title?: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

/**
 * The only data exposed by a child UI bridge. It contains projections of
 * extension requests, never the request payload itself.
 */
export interface PiChildExtensionUiSnapshot {
  readonly childId: string;
  readonly generationId: string;
  readonly readOnly: boolean;
  readonly lifecycle: "active" | "completed" | "interrupted" | "disposed";
  readonly notifications: readonly string[];
  readonly widgets: Readonly<Record<string, PiChildExtensionUiWidgetSnapshot>>;
  readonly status?: string;
  readonly title?: string;
  readonly editorText?: string;
  readonly dialogs: readonly PiChildExtensionUiDialogSnapshot[];
  readonly pendingDialogCount: number;
}

export type PiChildExtensionUiBridgeErrorCode =
  | "bridge_closed"
  | "event_malformed"
  | "widget_malformed"
  | "dialog_malformed"
  | "response_malformed"
  | "scope_mismatch"
  | "unknown_request"
  | "duplicate_request"
  | "response_in_flight"
  | "sender_threw";

export interface PiChildExtensionUiBridgeError {
  readonly code: PiChildExtensionUiBridgeErrorCode;
}

export type PiChildExtensionUiResponseSender<E = unknown> = (
  childId: string,
  generationId: string,
  response: PiExtensionUiResponseInput,
) => ResultAsync<void, E>;

export interface PiChildExtensionUiBridgeOptions<E = unknown> {
  readonly childId: string;
  readonly generationId: string;
  readonly sendExtensionUiResponse: PiChildExtensionUiResponseSender<E>;
}

type DialogState = PiChildExtensionUiDialogSnapshot;
type WidgetState = PiChildExtensionUiWidgetSnapshot;
type BridgeResult<T> = Result<T, PiChildExtensionUiBridgeError>;
type ResponseResult<E> = ResultAsync<void, PiChildExtensionUiBridgeError | E>;

type WidgetAction = Readonly<Record<string, unknown>>;

type ExtensionUiRequest = {
  readonly type: "extension_ui_request";
  readonly requestType: "notification" | "widget" | "dialog";
  readonly requestId: string;
  readonly message?: string;
  readonly widget?: unknown;
  readonly dialog?: unknown;
};

function bridgeError(
  code: PiChildExtensionUiBridgeErrorCode,
): PiChildExtensionUiBridgeError {
  return { code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  max = MAX_CHILD_EVENT_STRING,
): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function isBoundedJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null) return true;
  if (typeof value === "string") return value.length <= MAX_CHILD_EVENT_STRING;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_CHILD_EVENT_ITEMS &&
      value.every((item) => isBoundedJson(item, depth + 1))
    );
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= 64 &&
    keys.every(
      (key) => key.length <= 256 && isBoundedJson(value[key], depth + 1),
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function textFromAction(
  action: WidgetAction,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = action[key];
    const text = boundedText(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function widgetContent(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = boundedText(value);
  if (text !== undefined) return text;
  if (Array.isArray(value) && value.length <= MAX_CHILD_EVENT_ITEMS) {
    const parts = value.map((item) => boundedText(item));
    if (parts.every((part) => part !== undefined)) {
      const joined = parts.join("\n");
      return joined.length <= MAX_CHILD_EVENT_STRING ? joined : undefined;
    }
  }
  if (isRecord(value)) {
    const textValue = boundedText(value.text);
    if (
      textValue !== undefined &&
      Object.keys(value).every((key) => key === "text")
    ) {
      return textValue;
    }
  }
  return undefined;
}

function sanitizeDialog(event: ExtensionUiRequest): BridgeResult<DialogState> {
  // The normalized event schema deliberately keeps dialog details optional;
  // the request itself is still blocking and therefore gets a bounded generic
  // dialog projection when the host omits those details.
  const dialog = event.dialog;
  if (dialog === undefined) {
    return ok({
      requestId: event.requestId,
      kind: "input",
      pending: true,
      ...(event.message === undefined ? {} : { message: event.message }),
    });
  }
  if (!isRecord(dialog)) return err(bridgeError("dialog_malformed"));
  const kindValue = dialog.kind ?? dialog.type ?? dialog.dialogType;
  if (
    kindValue !== "confirm" &&
    kindValue !== "select" &&
    kindValue !== "input" &&
    kindValue !== "editor"
  ) {
    return err(bridgeError("dialog_malformed"));
  }

  const optionsValue = dialog.options ?? dialog.items;
  let options: readonly string[] | undefined;
  if (optionsValue !== undefined) {
    if (
      !Array.isArray(optionsValue) ||
      optionsValue.length > MAX_CHILD_EVENT_ITEMS
    ) {
      return err(bridgeError("dialog_malformed"));
    }
    const parsed = optionsValue.map((item) => boundedText(item, 256));
    if (parsed.some((item) => item === undefined)) {
      return err(bridgeError("dialog_malformed"));
    }
    options = parsed as string[];
  }

  const readOptional = (...keys: readonly string[]): string | undefined =>
    textFromAction(dialog, ...keys);
  const message = readOptional("message", "prompt") ?? event.message;
  const title = readOptional("title");
  const placeholder = readOptional("placeholder");
  const defaultValue = readOptional("defaultValue", "default", "value");

  return ok({
    requestId: event.requestId,
    kind: kindValue,
    pending: true,
    ...(message === undefined ? {} : { message }),
    ...(title === undefined ? {} : { title }),
    ...(options === undefined ? {} : { options }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  });
}

/** Owns one authenticated child's local extension UI state and authority. */
export class PiChildExtensionUiBridge<E = unknown> {
  private readonly notifications: string[] = [];
  private readonly widgets = new Map<string, WidgetState>();
  private readonly dialogs = new Map<string, DialogState>();
  private readonly completedRequestIds = new Set<string>();
  private readonly inFlightRequestIds = new Set<string>();
  private status: string | undefined;
  private title: string | undefined;
  private editorText: string | undefined;
  private lifecycle: PiChildExtensionUiSnapshot["lifecycle"] = "active";
  private history: PiChildExtensionUiSnapshot | undefined;

  constructor(private readonly options: PiChildExtensionUiBridgeOptions<E>) {}

  /** Consume one already-normalized child session event. */
  consume(event: PiChildSessionEvent): BridgeResult<void> {
    if (this.lifecycle !== "active") return err(bridgeError("bridge_closed"));
    const parsed = PiChildSessionEventSchema.safeParse(event);
    if (!parsed.success) return err(bridgeError("event_malformed"));
    if (parsed.data.type !== "extension_ui_request") return ok(undefined);
    const request = parsed.data as unknown as ExtensionUiRequest;

    if (request.requestType === "notification") {
      if (request.message !== undefined) {
        this.notifications.push(request.message);
        while (this.notifications.length > MAX_NOTIFICATIONS) {
          this.notifications.shift();
        }
      }
      return ok(undefined);
    }

    if (request.requestType === "widget") {
      return this.applyWidget(request.widget);
    }

    if (
      this.dialogs.has(request.requestId) ||
      this.completedRequestIds.has(request.requestId)
    ) {
      return err(bridgeError("duplicate_request"));
    }
    if (this.dialogs.size >= MAX_DIALOGS) {
      return err(bridgeError("dialog_malformed"));
    }
    const dialog = sanitizeDialog(request);
    if (dialog.isErr()) return err(dialog.error);
    this.dialogs.set(request.requestId, dialog.value);
    return ok(undefined);
  }

  /** Alias used by event observers. */
  handleEvent(event: PiChildSessionEvent): BridgeResult<void> {
    return this.consume(event);
  }

  /** Return a fresh, deeply immutable child-local view. */
  snapshot(): PiChildExtensionUiSnapshot {
    return this.history ?? this.makeSnapshot(false);
  }

  /** Return the immutable terminal snapshot, if this bridge has closed. */
  completedSnapshot(): PiChildExtensionUiSnapshot | undefined {
    return this.history;
  }

  /** Alias for callers rendering a completed history record. */
  historySnapshot(): PiChildExtensionUiSnapshot | undefined {
    return this.completedSnapshot();
  }

  respond(response: PiExtensionUiResponseInput): ResponseResult<E>;
  respond(
    childId: string,
    generationId: string,
    response: PiExtensionUiResponseInput,
  ): ResponseResult<E>;
  respond(
    first: string | PiExtensionUiResponseInput,
    second?: string,
    third?: PiExtensionUiResponseInput,
  ): ResponseResult<E> {
    const scoped = typeof first === "string";
    const childId = scoped ? first : this.options.childId;
    const generationId = scoped ? second : this.options.generationId;
    const response = scoped ? third : first;
    if (
      typeof childId !== "string" ||
      typeof generationId !== "string" ||
      response === undefined
    ) {
      return errAsync(bridgeError("response_malformed"));
    }
    if (
      childId !== this.options.childId ||
      generationId !== this.options.generationId
    ) {
      return errAsync(bridgeError("scope_mismatch"));
    }
    if (this.lifecycle !== "active")
      return errAsync(bridgeError("bridge_closed"));

    const valid = this.validateResponse(response);
    if (valid.isErr()) return errAsync(valid.error);
    const pending = this.dialogs.get(response.requestId);
    if (pending === undefined) {
      return errAsync(
        bridgeError(
          this.completedRequestIds.has(response.requestId)
            ? "duplicate_request"
            : "unknown_request",
        ),
      );
    }
    if (this.inFlightRequestIds.has(response.requestId)) {
      return errAsync(bridgeError("response_in_flight"));
    }
    if (!this.responseMatchesDialog(pending, response)) {
      return errAsync(bridgeError("response_malformed"));
    }

    this.inFlightRequestIds.add(response.requestId);
    const invoked = Result.fromThrowable(
      () =>
        this.options.sendExtensionUiResponse(
          this.options.childId,
          this.options.generationId,
          response,
        ),
      () => bridgeError("sender_threw"),
    )();
    if (invoked.isErr()) {
      this.inFlightRequestIds.delete(response.requestId);
      return errAsync(invoked.error);
    }

    return invoked.value
      .map(() => {
        this.inFlightRequestIds.delete(response.requestId);
        if (this.dialogs.get(response.requestId) === pending) {
          this.dialogs.delete(response.requestId);
          this.completedRequestIds.add(response.requestId);
        }
        return undefined;
      })
      .mapErr((error) => {
        this.inFlightRequestIds.delete(response.requestId);
        return error;
      });
  }

  sendResponse(
    childId: string,
    generationId: string,
    response: PiExtensionUiResponseInput,
  ): ResponseResult<E> {
    return this.respond(childId, generationId, response);
  }

  cancel(
    childId: string,
    generationId: string,
    requestId: string,
  ): ResponseResult<E> {
    return this.respond(childId, generationId, {
      type: "extension_ui_response",
      requestId,
      cancelled: true,
    });
  }

  /** Clear response authority while retaining a read-only renderable history. */
  settle(): void {
    this.close("completed");
  }

  complete(): void {
    this.settle();
  }

  interrupt(): void {
    this.close("interrupted");
  }

  dispose(): void {
    this.close("disposed");
  }

  private applyWidget(widget: unknown): BridgeResult<void> {
    if (!isRecord(widget)) return ok(undefined);
    const action = widget as WidgetAction;
    const method = boundedText(action.method, 64);
    if (method === undefined) return ok(undefined);

    if (method === "clearWidgets") {
      this.widgets.clear();
      return ok(undefined);
    }
    if (method === "removeWidget") {
      const name = boundedText(action.name, MAX_WIDGET_NAME);
      if (name !== undefined) this.widgets.delete(name);
      return ok(undefined);
    }
    if (method === "clearStatus") {
      this.status = undefined;
      return ok(undefined);
    }
    if (method === "clearTitle") {
      this.title = undefined;
      return ok(undefined);
    }
    if (method === "clearEditorText") {
      this.editorText = undefined;
      return ok(undefined);
    }

    if (method === "setWidget") {
      if (hasOwn(action, "widgetKey")) {
        const name = boundedText(action.widgetKey, MAX_WIDGET_NAME);
        if (name === undefined) return err(bridgeError("widget_malformed"));
        if (!hasOwn(action, "widgetLines")) {
          this.widgets.delete(name);
          return ok(undefined);
        }
        const content = widgetContent(action.widgetLines);
        if (content === null) {
          this.widgets.delete(name);
          return ok(undefined);
        }
        if (content === undefined) {
          return err(bridgeError("widget_malformed"));
        }
        if (this.widgets.size >= MAX_WIDGETS && !this.widgets.has(name)) {
          return err(bridgeError("widget_malformed"));
        }
        this.widgets.set(name, { content });
        return ok(undefined);
      }

      const name = boundedText(
        action.name ?? action.widgetName ?? action.key,
        MAX_WIDGET_NAME,
      );
      const rawContent = hasOwn(action, "content")
        ? action.content
        : action.value;
      const content = widgetContent(rawContent);
      if (content === null) {
        if (name === undefined) return err(bridgeError("widget_malformed"));
        this.widgets.delete(name);
        return ok(undefined);
      }
      if (name === undefined || content === undefined) {
        return err(bridgeError("widget_malformed"));
      }
      if (this.widgets.size >= MAX_WIDGETS && !this.widgets.has(name)) {
        return err(bridgeError("widget_malformed"));
      }
      this.widgets.set(name, { content });
      return ok(undefined);
    }
    if (method === "setStatus") {
      if (hasOwn(action, "statusText")) {
        const statusText = action.statusText;
        if (statusText === undefined || statusText === null) {
          this.status = undefined;
          return ok(undefined);
        }
        const value = boundedText(statusText);
        if (value === undefined) return err(bridgeError("widget_malformed"));
        this.status = value;
        return ok(undefined);
      }
      let raw = action.value;
      if (hasOwn(action, "message")) raw = action.message;
      if (hasOwn(action, "status")) raw = action.status;
      if (raw === null) {
        this.status = undefined;
        return ok(undefined);
      }
      const value = boundedText(raw);
      if (value === undefined) return err(bridgeError("widget_malformed"));
      this.status = value;
      return ok(undefined);
    }
    if (method === "setTitle") {
      const raw = hasOwn(action, "title") ? action.title : action.value;
      if (raw === null) {
        this.title = undefined;
        return ok(undefined);
      }
      const value = boundedText(raw);
      if (value === undefined) return err(bridgeError("widget_malformed"));
      this.title = value;
      return ok(undefined);
    }
    if (method === "setEditorText" || method === "set_editor_text") {
      const raw = hasOwn(action, "text") ? action.text : action.value;
      if (raw === null) {
        this.editorText = undefined;
        return ok(undefined);
      }
      const value = boundedText(raw);
      if (value === undefined) return err(bridgeError("widget_malformed"));
      this.editorText = value;
      return ok(undefined);
    }
    return ok(undefined);
  }

  private validateResponse(
    response: PiExtensionUiResponseInput,
  ): BridgeResult<void> {
    if (!isRecord(response)) return err(bridgeError("response_malformed"));
    const allowed = new Set([
      "type",
      "requestId",
      "response",
      "cancelled",
      "error",
    ]);
    if (!exactKeys(response, allowed))
      return err(bridgeError("response_malformed"));
    if (response.type !== "extension_ui_response") {
      return err(bridgeError("response_malformed"));
    }
    if (boundedText(response.requestId) === undefined) {
      return err(bridgeError("response_malformed"));
    }
    if (response.error !== undefined || hasOwn(response, "error")) {
      return err(bridgeError("response_malformed"));
    }
    if (
      response.cancelled !== undefined &&
      typeof response.cancelled !== "boolean"
    ) {
      return err(bridgeError("response_malformed"));
    }
    const hasResponse = hasOwn(response, "response");
    if (hasResponse && !isBoundedJson(response.response)) {
      return err(bridgeError("response_malformed"));
    }
    if (response.cancelled === true && hasResponse) {
      return err(bridgeError("response_malformed"));
    }
    if (response.cancelled !== true && !hasResponse) {
      return err(bridgeError("response_malformed"));
    }
    return ok(undefined);
  }

  private responseMatchesDialog(
    dialog: DialogState,
    response: PiExtensionUiResponseInput,
  ): boolean {
    if (response.cancelled === true) return true;
    if (response.response === undefined) return false;
    if (dialog.kind === "confirm") {
      if (typeof response.response === "boolean") return true;
      return (
        isRecord(response.response) &&
        Object.keys(response.response).length === 1 &&
        typeof response.response.confirmed === "boolean"
      );
    }
    return true;
  }

  private makeSnapshot(readOnly: boolean): PiChildExtensionUiSnapshot {
    const widgets: Record<string, PiChildExtensionUiWidgetSnapshot> = {};
    for (const [name, widget] of this.widgets) {
      widgets[name] = { ...widget };
    }
    const snapshot: PiChildExtensionUiSnapshot = {
      childId: this.options.childId,
      generationId: this.options.generationId,
      readOnly,
      lifecycle: this.lifecycle,
      notifications: [...this.notifications],
      widgets,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.title === undefined ? {} : { title: this.title }),
      ...(this.editorText === undefined ? {} : { editorText: this.editorText }),
      dialogs: [...this.dialogs.values()].map((dialog) => ({ ...dialog })),
      pendingDialogCount: this.dialogs.size,
    };
    return deepFreeze(snapshot);
  }

  private close(
    lifecycle: Exclude<PiChildExtensionUiSnapshot["lifecycle"], "active">,
  ): void {
    if (this.lifecycle !== "active") return;
    this.lifecycle = lifecycle;
    this.history = this.makeSnapshot(true);
    this.dialogs.clear();
    this.inFlightRequestIds.clear();
    this.completedRequestIds.clear();
  }
}

export function createPiChildExtensionUiBridge<E = unknown>(
  options: PiChildExtensionUiBridgeOptions<E>,
): PiChildExtensionUiBridge<E> {
  return new PiChildExtensionUiBridge(options);
}
