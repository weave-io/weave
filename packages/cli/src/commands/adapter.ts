/**
 * `weave adapter <name> …` — bounded adapter-command CLI surface.
 *
 * Parses argv into an opaque engine envelope, dispatches through
 * `dispatchAdapterCommand`, and renders human or stable `--json` output.
 * Payload semantics stay adapter-owned.
 */

import {
  type AdapterCommandRegistry,
  dispatchAdapterCommand,
} from "@weaveio/weave-engine";
import {
  createPiAdapterCommandRegistry,
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
  type PiAdapterChildrenPort,
  type PiAdapterDoctorPort,
  type PiChildrenDeleteResult,
  type PiChildrenListResult,
  type PiChildrenShowResult,
  type PiDoctorResult,
} from "@weaveio/weave-adapter-pi";
import { err, ok, type Result } from "neverthrow";
import type { CliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import {
  ClackPromptAdapter,
  type PromptAdapter,
  StaticPromptAdapter,
} from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";

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
    }
  | {
      readonly adapter: "pi";
      readonly action: "children.delete";
      readonly childId: string;
      readonly parentSessionId: string;
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
  /** Injected registry for tests; production builds the Pi registry. */
  readonly registry?: AdapterCommandRegistry;
  /** Injected children port when building the default Pi registry. */
  readonly childrenPort?: PiAdapterChildrenPort;
  /** Injected doctor port (Task 15); defaults to the placeholder shell. */
  readonly doctorPort?: PiAdapterDoctorPort;
  readonly prompt?: PromptAdapter;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function renderAdapterHelp(theme: ThemeColors): string {
  return [
    `${theme.boldYellow("Usage:")} weave adapter <adapter> <command>`,
    "",
    `  ${theme.cyan("weave adapter pi children list")} ${theme.dim("[--json] [--diagnostic]")}`,
    `  ${theme.cyan("weave adapter pi children show <id>")} ${theme.dim("[--json] [--diagnostic] [--cursor <c>]")}`,
    `  ${theme.cyan("weave adapter pi children delete <id>")} ${theme.dim("[--yes] [--json]")}`,
    `  ${theme.cyan("weave adapter pi doctor")} ${theme.dim("[--json] [--diagnostic]")}`,
    "",
    `  List returns the newest ${PI_ADAPTER_COMMAND_BOUNDS.listPageSize} children for the workspace.`,
    `  Show returns the newest ${PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize} entries plus a cursor.`,
    "  Delete requires interactive confirmation or --yes and appends a tombstone.",
    "  Paths appear only when --diagnostic is set.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runAdapter(
  ctx: AdapterCommandContext,
): Promise<Result<number, CliError>> {
  if (ctx.target.adapter !== PI_ADAPTER_NAME) {
    ctx.terminal.stderr(
      formatCliMessage(`Unsupported adapter: ${ctx.target.adapter}`),
    );
    return ok(1);
  }

  const workspaceKey = ctx.workspaceKey ?? process.cwd();
  const registry = ctx.registry ?? buildDefaultRegistry(ctx);
  if (registry === undefined) {
    ctx.terminal.stderr(
      formatCliMessage(
        "Pi adapter command ports are unavailable. Production callers must pass a registry from createProductionPiAdapterCommandRegistry; tests may inject registry or childrenPort.",
      ),
    );
    return ok(1);
  }

  if (ctx.target.action === "children.delete" && !ctx.yes) {
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
      message: `Delete child ${ctx.target.childId} and append a tombstone?`,
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

  const request = buildRequest(ctx.target, workspaceKey, ctx);
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

  ctx.terminal.stdout(
    renderHuman(ctx.target.action, resultJson, ctx.theme),
  );
  return ok(0);
}

function buildDefaultRegistry(
  ctx: AdapterCommandContext,
): AdapterCommandRegistry | undefined {
  if (ctx.childrenPort === undefined) return undefined;
  return createPiAdapterCommandRegistry({
    children: ctx.childrenPort,
    ...(ctx.doctorPort === undefined ? {} : { doctor: ctx.doctorPort }),
  });
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
        adapter: PI_ADAPTER_NAME,
        command: PI_ADAPTER_COMMAND_NAMES.childrenList,
        payloadJson: JSON.stringify({
          workspaceKey,
          includeTombstoned: true,
        }),
      };
    case "children.show":
      return {
        adapter: PI_ADAPTER_NAME,
        command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
        payloadJson: JSON.stringify({
          workspaceKey,
          childId: target.childId,
          ...(target.parentSessionId === undefined
            ? {}
            : { parentSessionId: target.parentSessionId }),
          ...(target.cursor === undefined ? {} : { cursor: target.cursor }),
          ...(ctx.diagnostic ? { diagnostic: true } : {}),
        }),
      };
    case "children.delete":
      return {
        adapter: PI_ADAPTER_NAME,
        command: PI_ADAPTER_COMMAND_NAMES.childrenDelete,
        payloadJson: JSON.stringify({
          workspaceKey,
          childId: target.childId,
          parentSessionId: target.parentSessionId,
          confirmed: true,
        }),
      };
    case "doctor":
      return {
        adapter: PI_ADAPTER_NAME,
        command: PI_ADAPTER_COMMAND_NAMES.doctor,
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
    | PiChildrenListResult
    | PiChildrenShowResult
    | PiChildrenDeleteResult
    | PiDoctorResult;

  switch (action) {
    case "children.list": {
      const body = parsed as PiChildrenListResult;
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
      const body = parsed as PiChildrenShowResult;
      const header = [
        `${theme.bold(body.child.childId)}  ${body.child.status}`,
        theme.dim(body.child.title),
      ];
      const entryLines = body.entries.map(
        (entry) => `  [${entry.index}] ${entry.type} ${theme.dim(entry.id)}`,
      );
      if (body.nextCursor !== undefined) {
        entryLines.push(theme.dim(`next cursor: ${body.nextCursor}`));
      }
      if (body.sessionPath !== undefined) {
        entryLines.push(theme.dim(`session path: ${body.sessionPath}`));
      }
      return [...header, ...entryLines].join("\n");
    }
    case "children.delete": {
      const body = parsed as PiChildrenDeleteResult;
      return `Tombstoned child ${theme.cyan(body.childId)} at ${body.deletedAt}.`;
    }
    case "doctor": {
      const body = parsed as PiDoctorResult;
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
  if (group === "children" && verb === "delete") {
    if (id === undefined || id.length === 0) {
      return err({
        type: "InvalidArgs",
        message: "children delete requires a child id",
      });
    }
    // Parent scope is required for delete; callers may override via flags later.
    return ok({
      adapter: "pi",
      action: "children.delete",
      childId: id,
      parentSessionId: "current",
    });
  }
  return err({
    type: "InvalidArgs",
    message:
      "Unknown adapter command. Try: weave adapter pi children list|show|delete or weave adapter pi doctor",
  });
}
