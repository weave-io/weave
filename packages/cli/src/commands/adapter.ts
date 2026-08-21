/**
 * `weave adapter <name> …` — bounded adapter-command CLI surface.
 *
 * Parses argv into an opaque engine envelope, dispatches through
 * `dispatchAdapterCommand`, and renders human or stable `--json` output.
 * Payload semantics stay adapter-owned. Production Pi registry composition is
 * injected by the router via the thin `@weaveio/weave-adapter-pi/cli` boundary;
 * this module stays free of harness package imports.
 */

import {
  type AdapterCommandRegistry,
  type AdapterCommandRequest,
  dispatchAdapterCommand,
} from "@weaveio/weave-engine";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { CliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import {
  ClackPromptAdapter,
  type PromptAdapter,
  StaticPromptAdapter,
} from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";

/** Spec 33 §15.3 list page size — mirrored locally so the CLI stays Pi-import free. */
const ADAPTER_LIST_PAGE_SIZE = 50;
/** Spec 33 §15.3 show entry page size. */
const ADAPTER_SHOW_ENTRY_PAGE_SIZE = 100;

const PI_ADAPTER = "pi" as const;
const PI_COMMANDS = {
  childrenList: "children.list",
  childrenShow: "children.show",
  childrenResolve: "children.resolve",
  childrenResult: "children.result",
  childrenDelete: "children.delete",
  doctor: "doctor",
} as const;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type AdapterCliTarget =
  | {
      readonly adapter: "pi";
      readonly action: "children.list";
    }
  | {
      readonly adapter: "pi";
      readonly action: "children.show";
      readonly childId: string;
      readonly cursor?: string;
      readonly parentSessionId?: string;
      readonly content?: boolean;
      readonly contentCursor?: string;
    }
  | {
      readonly adapter: "pi";
      readonly action: "children.result";
      readonly childId: string;
      readonly cursor?: string;
      readonly parentSessionId?: string;
    }
  | {
      readonly adapter: "pi";
      readonly action: "children.delete";
      readonly childId: string;
      /** Immutable origin parent; resolved from list/show metadata when omitted. */
      readonly parentSessionId?: string;
    }
  | {
      readonly adapter: "pi";
      readonly action: "doctor";
    };

export interface AdapterCommandContext {
  readonly terminal: TerminalIO;
  readonly theme: ThemeColors;
  readonly target: AdapterCliTarget;
  readonly json: boolean;
  readonly yes: boolean;
  readonly diagnostic: boolean;
  /** Workspace key; defaults to process cwd. */
  readonly workspaceKey?: string;
  /** Injected registry; production builds pass the Pi CLI registration result. */
  readonly registry?: AdapterCommandRegistry;
  readonly prompt?: PromptAdapter;
}

const adapterChildListItemSchema = z.object({
  childId: z.string(),
  threadId: z.string(),
  title: z.string(),
  status: z.string(),
  originParentSessionId: z.string(),
  tombstoned: z.boolean(),
  stale: z.boolean(),
});

const adapterChildrenListResultSchema = z.object({
  children: z.array(adapterChildListItemSchema),
  nextCursor: z.string().optional(),
});
const adapterChildrenShowResultSchema = z.object({
  child: adapterChildListItemSchema,
  entries: z.array(
    z.object({
      index: z.number(),
      id: z.string(),
      type: z.string(),
      content: z.string().optional(),
      contentComplete: z.boolean().optional(),
      contentByteLength: z.number().optional(),
      contentCursor: z.string().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
  diagnostics: z
    .object({
      nativeSessionId: z.string().optional(),
      originParentSessionId: z.string(),
      sessionHeader: z.string(),
      sessionHealth: z.string(),
    })
    .optional(),
  complete: z.boolean().optional(),
  contentIncluded: z.boolean().optional(),
});
/**
 * Byte-exact authoritative result page. Unlike `children show --content`,
 * nothing here is sanitized or rewritten, and `exact` says so on the wire.
 *
 * `content` is base64, never the child's raw text. Raw text would be
 * JSON-escaped into the opaque result envelope, and escaping has no bounded
 * expansion factor: one page of C0 control bytes costs six characters per
 * byte and overruns the envelope. Base64 costs a fixed `4 * ceil(n / 3)` for
 * any bytes at all, and it is byte-preserving, so nothing has to be sanitized
 * to make it fit.
 */
const adapterChildrenResultResultSchema = z.object({
  childId: z.string(),
  exact: z.literal(true),
  status: z.enum(["complete", "incomplete"]),
  reason: z.string().optional(),
  total: z.number().optional(),
  byteLength: z.number().optional(),
  digest: z.string().optional(),
  contentEncoding: z.literal("base64").optional(),
  content: z.string().optional(),
  contentByteOffset: z.number().optional(),
  contentByteLength: z.number().optional(),
  contentDigest: z.string().optional(),
  nextCursor: z.string().optional(),
});
/**
 * Decodes one base64 result page back to its exact bytes.
 *
 * Refuses any page whose encoding it does not recognise rather than guessing:
 * an unknown encoding is never rendered as if it were the child's own text.
 */
export function decodeAdapterResultPage(page: {
  readonly contentEncoding?: string;
  readonly content?: string;
  readonly contentByteLength?: number;
}): Result<Uint8Array | undefined, string> {
  const content = page.content;
  if (content === undefined) return ok(void 0);
  if (page.contentEncoding !== "base64") {
    return err(
      `unsupported result content encoding: ${page.contentEncoding ?? "(absent)"}`,
    );
  }
  const decoded: Result<Uint8Array, string> = Result.fromThrowable(
    () => {
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
    () => "result page content is not valid base64",
  )();
  if (decoded.isErr()) return decoded;
  if (
    page.contentByteLength !== undefined &&
    decoded.value.byteLength !== page.contentByteLength
  ) {
    return err(
      `result page byte length mismatch: declared ${page.contentByteLength}, decoded ${decoded.value.byteLength}`,
    );
  }
  return ok(decoded.value);
}

const adapterChildrenDeleteResultSchema = z.object({
  childId: z.string(),
  tombstoned: z.literal(true),
  deletedAt: z.string(),
});
const adapterDoctorResultSchema = z.object({
  status: z.string(),
  checks: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      detail: z.string().optional(),
    }),
  ),
});
const adapterResolveMatchesSchema = z.object({
  matches: z.array(
    z.object({
      childId: z.string(),
      originParentSessionId: z.string(),
    }),
  ),
});
type AdapterResolveMatch = z.infer<
  typeof adapterResolveMatchesSchema
>["matches"][number];

function parseAdapterJson<T extends z.ZodType>(
  resultJson: string,
  schema: T,
): Result<z.output<T>, string> {
  const parsed = Result.fromThrowable(
    () => JSON.parse(resultJson),
    () => "invalid json",
  )();
  if (parsed.isErr()) return err(parsed.error);

  const validated = schema.safeParse(parsed.value);
  if (!validated.success) return err("invalid adapter result payload");
  return ok(validated.data);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function renderAdapterHelp(theme: ThemeColors): string {
  return [
    `${theme.boldYellow("Usage:")} weave adapter <adapter> <command>`,
    "",
    `  ${theme.cyan("weave adapter pi children list")} ${theme.dim("[--json] [--diagnostic]")}`,
    `  ${theme.cyan("weave adapter pi children show <id>")} ${theme.dim("[--json] [--content] [--content-cursor <c>] [--diagnostic] [--cursor <c>] [--parent-session <id>]")}`,
    `  ${theme.cyan("weave adapter pi children result <id>")} ${theme.dim("[--json] [--cursor <c>] [--parent-session <id>]")}`,
    `  ${theme.cyan("weave adapter pi children delete <id>")} ${theme.dim("[--yes] [--json] [--parent-session <id>]")}`,
    `  ${theme.cyan("weave adapter pi doctor")} ${theme.dim("[--json] [--diagnostic]")}`,
    "",
    `  List returns the newest ${ADAPTER_LIST_PAGE_SIZE} children for the workspace.`,
    `  Show returns the newest ${ADAPTER_SHOW_ENTRY_PAGE_SIZE} entries plus a cursor.`,
    "  Delete resolves the child's immutable origin parent via children.resolve;",
    "  pass --parent-session when the same child id exists under two parents.",
    "  Delete requires interactive confirmation or --yes and appends a tombstone.",
    "  Show --content returns a sanitized display projection, never exact bytes.",
    "  Result returns the byte-exact authoritative child result in bounded pages.",
    "  Result --json carries each page as base64 under contentEncoding: base64.",
    "  Show --diagnostic adds path-free session identity, lineage, and health.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runAdapter(
  ctx: AdapterCommandContext,
): Promise<Result<number, CliError>> {
  if (ctx.target.adapter !== PI_ADAPTER) {
    ctx.terminal.stderr(
      formatCliMessage(`Unsupported adapter: ${ctx.target.adapter}`),
    );
    return ok(1);
  }

  const workspaceKey = ctx.workspaceKey ?? process.cwd();
  const registry = ctx.registry;
  if (registry === undefined) {
    ctx.terminal.stderr(
      formatCliMessage(
        "Adapter command registry is unavailable. Production callers must pass a registry from the Pi CLI registration boundary; tests may inject registry.",
      ),
    );
    return ok(1);
  }

  let target = ctx.target;
  if (target.action === "children.delete") {
    const scoped = await resolveDeleteParentScope(
      registry,
      workspaceKey,
      target,
    );
    if (scoped.isErr()) {
      ctx.terminal.stderr(formatCliMessage(scoped.error));
      return ok(1);
    }
    target = scoped.value;
  }

  if (target.action === "children.delete" && !ctx.yes) {
    const prompt =
      ctx.prompt ??
      (process.stdin.isTTY
        ? new ClackPromptAdapter()
        : new StaticPromptAdapter({ interactive: false }));
    if (!prompt.isInteractive()) {
      ctx.terminal.stderr(
        formatCliMessage(
          "Interactive mode is unavailable. Re-run with --yes to delete without a prompt.",
        ),
      );
      return ok(1);
    }
    const confirmed = await prompt.confirm({
      message: `Delete child ${target.childId} and append a tombstone?`,
      initialValue: false,
    });
    if (confirmed.isErr()) {
      ctx.terminal.stderr(formatCliMessage(confirmed.error.message));
      return ok(1);
    }
    if (!confirmed.value) {
      ctx.terminal.stdout("Delete cancelled.");
      return ok(0);
    }
  }

  const request = buildRequest(target, workspaceKey, ctx);
  const dispatched = await dispatchAdapterCommand(registry, request);
  if (dispatched.isErr()) {
    ctx.terminal.stderr(formatDispatchError(dispatched.error));
    return ok(1);
  }

  const resultJson = dispatched.value.resultJson;
  if (ctx.json) {
    ctx.terminal.stdout(stableJson(resultJson));
    return ok(0);
  }

  ctx.terminal.stdout(renderHuman(target.action, resultJson, ctx.theme));
  return ok(0);
}

/**
 * Resolve the immutable origin parent for delete.
 *
 * Never invents a synthetic parent such as `current`. Uses the adapter-owned
 * `children.resolve` index lookup (not the newest-50 list page), accepts an
 * explicit `--parent-session` only when it matches a resolved row, and refuses
 * ambiguous same-child-id / two-parent cases.
 */
export async function resolveDeleteParentScope(
  registry: AdapterCommandRegistry,
  workspaceKey: string,
  target: Extract<AdapterCliTarget, { action: "children.delete" }>,
): Promise<
  Result<
    Extract<AdapterCliTarget, { action: "children.delete" }> & {
      readonly parentSessionId: string;
    },
    string
  >
> {
  const resolved = await dispatchAdapterCommand(registry, {
    adapter: PI_ADAPTER,
    command: PI_COMMANDS.childrenResolve,
    payloadJson: JSON.stringify({
      workspaceKey,
      childId: target.childId,
      includeTombstoned: true,
    }),
  });
  if (resolved.isErr()) {
    return err(formatDispatchError(resolved.error));
  }

  const matches = parseResolveMatches(resolved.value.resultJson);
  if (matches === undefined) {
    return err("children resolve returned an invalid payload");
  }
  if (matches.length === 0) {
    return err(`child not found: ${target.childId}`);
  }

  const requestedParent = target.parentSessionId;
  if (requestedParent !== undefined) {
    const scoped = matches.find(
      (row) => row.originParentSessionId === requestedParent,
    );
    if (scoped === undefined) {
      return err(
        `parent session scope rejected: "${requestedParent}" is not the origin parent for child ${target.childId}`,
      );
    }
    return ok({
      ...target,
      parentSessionId: scoped.originParentSessionId,
    });
  }

  if (matches.length > 1) {
    const parents = matches.map((row) => row.originParentSessionId).join(", ");
    return err(
      `child id ${target.childId} exists under multiple parents (${parents}); pass --parent-session <id>`,
    );
  }

  const only = matches[0];
  if (only === undefined) {
    return err(`child not found: ${target.childId}`);
  }
  return ok({
    ...target,
    parentSessionId: only.originParentSessionId,
  });
}

function parseResolveMatches(
  resultJson: string,
): readonly AdapterResolveMatch[] | undefined {
  const parsed = parseAdapterJson(resultJson, adapterResolveMatchesSchema);
  return parsed.isOk() ? parsed.value.matches : undefined;
}

interface AdapterChildrenListPayload {
  workspaceKey: string;
  includeTombstoned: true;
}

interface AdapterChildrenShowPayload {
  workspaceKey: string;
  childId: string;
  parentSessionId?: string;
  cursor?: string;
  content?: true;
  contentCursor?: string;
  diagnostic?: true;
}

interface AdapterChildrenResultPayload {
  workspaceKey: string;
  childId: string;
  parentSessionId?: string;
  cursor?: string;
}

interface AdapterChildrenDeletePayload {
  workspaceKey: string;
  childId: string;
  parentSessionId?: string;
  confirmed: true;
}

interface AdapterDoctorPayload {
  diagnostic?: true;
}

type AdapterPayload =
  | AdapterChildrenListPayload
  | AdapterChildrenShowPayload
  | AdapterChildrenResultPayload
  | AdapterChildrenDeletePayload
  | AdapterDoctorPayload;

function createAdapterRequest(
  command: string,
  payload: AdapterPayload,
): AdapterCommandRequest {
  return {
    adapter: PI_ADAPTER,
    command,
    payloadJson: JSON.stringify(payload),
  };
}

function buildRequest(
  target: AdapterCliTarget,
  workspaceKey: string,
  ctx: AdapterCommandContext,
): AdapterCommandRequest {
  switch (target.action) {
    case "children.list": {
      const payload: AdapterChildrenListPayload = {
        workspaceKey,
        includeTombstoned: true,
      };
      return createAdapterRequest(PI_COMMANDS.childrenList, payload);
    }
    case "children.show": {
      const payload: AdapterChildrenShowPayload = {
        workspaceKey,
        childId: target.childId,
      };
      if (target.parentSessionId !== undefined) {
        payload.parentSessionId = target.parentSessionId;
      }
      if (target.cursor !== undefined) {
        payload.cursor = target.cursor;
      }
      if (target.content === true) {
        payload.content = true;
      }
      if (target.contentCursor !== undefined) {
        payload.contentCursor = target.contentCursor;
      }
      if (ctx.diagnostic) {
        payload.diagnostic = true;
      }
      return createAdapterRequest(PI_COMMANDS.childrenShow, payload);
    }
    case "children.result": {
      const payload: AdapterChildrenResultPayload = {
        workspaceKey,
        childId: target.childId,
      };
      if (target.parentSessionId !== undefined) {
        payload.parentSessionId = target.parentSessionId;
      }
      if (target.cursor !== undefined) {
        payload.cursor = target.cursor;
      }
      return createAdapterRequest(PI_COMMANDS.childrenResult, payload);
    }
    case "children.delete": {
      const payload: AdapterChildrenDeletePayload = {
        workspaceKey,
        childId: target.childId,
        confirmed: true,
      };
      if (target.parentSessionId !== undefined) {
        payload.parentSessionId = target.parentSessionId;
      }
      return createAdapterRequest(PI_COMMANDS.childrenDelete, payload);
    }
    case "doctor": {
      const payload: AdapterDoctorPayload = {};
      if (ctx.diagnostic) {
        payload.diagnostic = true;
      }
      return createAdapterRequest(PI_COMMANDS.doctor, payload);
    }
  }
}

function stableJson(resultJson: string): string {
  const parsed = Result.fromThrowable(
    () => JSON.parse(resultJson),
    () => void 0,
  )();
  return parsed.match(
    (value) => `${JSON.stringify(value, null, 2)}\n`.trimEnd(),
    () => resultJson,
  );
}

function renderHuman(
  action: AdapterCliTarget["action"],
  resultJson: string,
  theme: ThemeColors,
): string {
  switch (action) {
    case "children.list": {
      const parsed = parseAdapterJson(
        resultJson,
        adapterChildrenListResultSchema,
      );
      if (parsed.isErr()) {
        return `Invalid adapter result payload: ${parsed.error}`;
      }
      const body = parsed.value;
      if (body.children.length === 0) {
        return "No children found for this workspace.";
      }
      const lines = body.children.map(
        (row) =>
          `${theme.cyan(row.childId)}  ${row.status}${row.tombstoned ? " (tombstone)" : ""}  ${theme.dim(row.title)}`,
      );
      if (body.nextCursor !== undefined) {
        lines.push(theme.dim(`next cursor: ${body.nextCursor}`));
      }
      return lines.join("\n");
    }
    case "children.show": {
      const parsed = parseAdapterJson(
        resultJson,
        adapterChildrenShowResultSchema,
      );
      if (parsed.isErr()) {
        return `Invalid adapter result payload: ${parsed.error}`;
      }
      const body = parsed.value;
      const header = [
        `${theme.bold(body.child.childId)}  ${body.child.status}`,
        theme.dim(body.child.title),
      ];
      const entryLines = body.entries.flatMap((entry) => {
        const line = `  [${entry.index}] ${entry.type} ${theme.dim(entry.id)}`;
        if (entry.content === undefined) return [line];
        const suffix = entry.contentComplete === false ? " [truncated]" : "";
        return [line, `${entry.content}${suffix}`];
      });
      if (body.nextCursor !== undefined) {
        entryLines.push(theme.dim(`next cursor: ${body.nextCursor}`));
      }
      if (body.diagnostics !== undefined) {
        const diagnostics = body.diagnostics;
        entryLines.push(
          theme.dim(
            `session health: ${diagnostics.sessionHealth}  header: ${diagnostics.sessionHeader}`,
          ),
        );
        entryLines.push(
          theme.dim(
            `origin parent session: ${diagnostics.originParentSessionId}`,
          ),
        );
        if (diagnostics.nativeSessionId !== undefined) {
          entryLines.push(
            theme.dim(`native session id: ${diagnostics.nativeSessionId}`),
          );
        }
      }
      return [...header, ...entryLines].join("\n");
    }
    case "children.result": {
      const parsed = parseAdapterJson(
        resultJson,
        adapterChildrenResultResultSchema,
      );
      if (parsed.isErr()) {
        return `Invalid adapter result payload: ${parsed.error}`;
      }
      const body = parsed.value;
      if (body.status !== "complete") {
        return `No verified result for child ${theme.cyan(body.childId)} (${body.reason ?? "unknown"}).`;
      }
      const decoded = decodeAdapterResultPage(body);
      if (decoded.isErr()) {
        return `Could not read the exact result page for child ${theme.cyan(body.childId)}: ${decoded.error}`;
      }
      const lines = [
        theme.dim(
          `exact result: ${body.byteLength ?? 0} bytes  sha256 ${body.digest ?? ""}`,
        ),
        decoded.value === undefined
          ? ""
          : new TextDecoder().decode(decoded.value),
      ];
      if (body.nextCursor !== undefined) {
        lines.push(theme.dim(`next cursor: ${body.nextCursor}`));
      }
      return lines.join("\n");
    }
    case "children.delete": {
      const parsed = parseAdapterJson(
        resultJson,
        adapterChildrenDeleteResultSchema,
      );
      if (parsed.isErr()) {
        return `Invalid adapter result payload: ${parsed.error}`;
      }
      const body = parsed.value;
      return `Tombstoned child ${theme.cyan(body.childId)} at ${body.deletedAt}.`;
    }
    case "doctor": {
      const parsed = parseAdapterJson(resultJson, adapterDoctorResultSchema);
      if (parsed.isErr()) {
        return `Invalid adapter result payload: ${parsed.error}`;
      }
      const body = parsed.value;
      const lines = [
        `Doctor status: ${theme.bold(body.status)}`,
        ...body.checks.map(
          (check) =>
            `  ${check.id}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`,
        ),
      ];
      return lines.join("\n");
    }
  }
}

function formatDispatchError(error: {
  readonly type: string;
  readonly message?: string;
  readonly adapter?: string;
  readonly command?: string;
  readonly issues?: readonly string[];
}): string {
  if (error.type === "InvalidEnvelope") {
    return formatCliMessage(
      `Invalid adapter command envelope: ${(error.issues ?? []).join("; ")}`,
    );
  }
  if (error.type === "HandlerFailed") {
    return formatCliMessage(error.message ?? "adapter command failed");
  }
  return formatCliMessage(`${error.type}`);
}

function formatCliMessage(message: string): string {
  return message;
}

/** Parse `weave adapter …` rest tokens into a typed target. */
export function parseAdapterTarget(
  rest: readonly string[],
): Result<AdapterCliTarget, CliError> {
  const [adapter, group, verb, id] = rest;
  if (adapter === undefined) {
    return err({
      type: "InvalidArgs",
      message: "Missing adapter name. Try: weave adapter pi children list",
    });
  }
  if (adapter !== "pi") {
    return err({
      type: "InvalidArgs",
      message: `Unsupported adapter "${adapter}". Only "pi" is available.`,
    });
  }
  if (group === "doctor") {
    return ok({ adapter: "pi", action: "doctor" });
  }
  if (group === "children" && verb === "list") {
    return ok({ adapter: "pi", action: "children.list" });
  }
  if (group === "children" && verb === "show") {
    if (id === undefined || id.length === 0) {
      return err({
        type: "InvalidArgs",
        message: "children show requires a child id",
      });
    }
    return ok({ adapter: "pi", action: "children.show", childId: id });
  }
  if (group === "children" && verb === "result") {
    if (id === undefined || id.length === 0) {
      return err({
        type: "InvalidArgs",
        message: "children result requires a child id",
      });
    }
    return ok({ adapter: "pi", action: "children.result", childId: id });
  }
  if (group === "children" && verb === "delete") {
    if (id === undefined || id.length === 0) {
      return err({
        type: "InvalidArgs",
        message: "children delete requires a child id",
      });
    }
    return ok({
      adapter: "pi",
      action: "children.delete",
      childId: id,
    });
  }
  return err({
    type: "InvalidArgs",
    message:
      "Unknown adapter command. Try: weave adapter pi children list|show|result|delete or weave adapter pi doctor",
  });
}
