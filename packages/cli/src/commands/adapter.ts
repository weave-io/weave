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
  dispatchAdapterCommand,
} from "@weaveio/weave-engine";
import { err, ok, Result } from "neverthrow";
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

interface AdapterChildListItem {
  readonly childId: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly originParentSessionId: string;
  readonly tombstoned: boolean;
  readonly stale: boolean;
}

interface AdapterChildrenListResult {
  readonly children: readonly AdapterChildListItem[];
  readonly nextCursor?: string;
}

interface AdapterChildrenShowResult {
  readonly child: AdapterChildListItem;
  readonly entries: readonly {
    readonly index: number;
    readonly id: string;
    readonly type: string;
    readonly content?: string;
    readonly contentComplete?: boolean;
    readonly contentByteLength?: number;
    readonly contentCursor?: string;
  }[];
  readonly nextCursor?: string;
  readonly diagnostics?: {
    readonly nativeSessionId?: string;
    readonly originParentSessionId: string;
    readonly sessionHeader: string;
    readonly sessionHealth: string;
  };
  readonly complete?: boolean;
  readonly contentIncluded?: boolean;
}

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
interface AdapterChildrenResultResult {
  readonly childId: string;
  readonly exact: true;
  readonly status: "complete" | "incomplete";
  readonly reason?: string;
  readonly total?: number;
  readonly byteLength?: number;
  readonly digest?: string;
  readonly contentEncoding?: "base64";
  readonly content?: string;
  readonly contentByteOffset?: number;
  readonly contentByteLength?: number;
  readonly contentDigest?: string;
  readonly nextCursor?: string;
}

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
  if (page.content === undefined) return ok(undefined);
  if (page.contentEncoding !== "base64") {
    return err(
      `unsupported result content encoding: ${page.contentEncoding ?? "(absent)"}`,
    );
  }
  const decoded: Result<Uint8Array, string> = Result.fromThrowable(
    () => {
      const binary = atob(page.content as string);
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

interface AdapterChildrenDeleteResult {
  readonly childId: string;
  readonly tombstoned: true;
  readonly deletedAt: string;
}

interface AdapterDoctorResult {
  readonly status: string;
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly detail?: string;
  }[];
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
): readonly AdapterChildListItem[] | undefined {
  const parsed: Result<unknown, string> = Result.fromThrowable(
    () => JSON.parse(resultJson) as unknown,
    () => "invalid json",
  )();
  if (parsed.isErr()) return undefined;
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    !("matches" in parsed.value) ||
    !Array.isArray((parsed.value as { matches: unknown }).matches)
  ) {
    return undefined;
  }
  const matches: AdapterChildListItem[] = [];
  for (const row of (parsed.value as { matches: unknown[] }).matches) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { childId?: unknown }).childId !== "string" ||
      typeof (row as { originParentSessionId?: unknown })
        .originParentSessionId !== "string"
    ) {
      return undefined;
    }
    matches.push(row as AdapterChildListItem);
  }
  return matches;
}

function buildRequest(
  target: AdapterCliTarget,
  workspaceKey: string,
  ctx: AdapterCommandContext,
): {
  readonly adapter: string;
  readonly command: string;
  readonly payloadJson: string;
} {
  switch (target.action) {
    case "children.list":
      return {
        adapter: PI_ADAPTER,
        command: PI_COMMANDS.childrenList,
        payloadJson: JSON.stringify({
          workspaceKey,
          includeTombstoned: true,
        }),
      };
    case "children.show":
      return {
        adapter: PI_ADAPTER,
        command: PI_COMMANDS.childrenShow,
        payloadJson: JSON.stringify({
          workspaceKey,
          childId: target.childId,
          ...(target.parentSessionId === undefined
            ? {}
            : { parentSessionId: target.parentSessionId }),
          ...(target.cursor === undefined ? {} : { cursor: target.cursor }),
          ...(target.content === true ? { content: true } : {}),
          ...(target.contentCursor === undefined
            ? {}
            : { contentCursor: target.contentCursor }),
          ...(ctx.diagnostic ? { diagnostic: true } : {}),
        }),
      };
    case "children.result":
      return {
        adapter: PI_ADAPTER,
        command: PI_COMMANDS.childrenResult,
        payloadJson: JSON.stringify({
          workspaceKey,
          childId: target.childId,
          ...(target.parentSessionId === undefined
            ? {}
            : { parentSessionId: target.parentSessionId }),
          ...(target.cursor === undefined ? {} : { cursor: target.cursor }),
        }),
      };
    case "children.delete":
      return {
        adapter: PI_ADAPTER,
        command: PI_COMMANDS.childrenDelete,
        payloadJson: JSON.stringify({
          workspaceKey,
          childId: target.childId,
          parentSessionId: target.parentSessionId,
          confirmed: true,
        }),
      };
    case "doctor":
      return {
        adapter: PI_ADAPTER,
        command: PI_COMMANDS.doctor,
        payloadJson: JSON.stringify({
          ...(ctx.diagnostic ? { diagnostic: true } : {}),
        }),
      };
  }
}

function stableJson(resultJson: string): string {
  const parsed = JSON.parse(resultJson) as unknown;
  return `${JSON.stringify(parsed, null, 2)}\n`.trimEnd();
}

function renderHuman(
  action: AdapterCliTarget["action"],
  resultJson: string,
  theme: ThemeColors,
): string {
  const parsed = JSON.parse(resultJson) as
    | AdapterChildrenListResult
    | AdapterChildrenShowResult
    | AdapterChildrenResultResult
    | AdapterChildrenDeleteResult
    | AdapterDoctorResult;

  switch (action) {
    case "children.list": {
      const body = parsed as AdapterChildrenListResult;
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
      const body = parsed as AdapterChildrenShowResult;
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
      const body = parsed as AdapterChildrenResultResult;
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
      const body = parsed as AdapterChildrenDeleteResult;
      return `Tombstoned child ${theme.cyan(body.childId)} at ${body.deletedAt}.`;
    }
    case "doctor": {
      const body = parsed as AdapterDoctorResult;
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
