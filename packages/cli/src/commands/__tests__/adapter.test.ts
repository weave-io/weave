/**
 * Tests for `weave adapter pi …` command surface (Spec 33 §15.3 / Task 14).
 */

import { describe, expect, it } from "bun:test";
import {
  createPiAdapterCommandRegistry,
  PI_ADAPTER_COMMAND_BOUNDS,
  type PiAdapterChildListItem,
  type PiAdapterChildrenPort,
} from "@weaveio/weave-adapter-pi/cli";
import { errAsync, okAsync } from "neverthrow";
import { parseArgs } from "../../args.js";
import { BufferTerminal } from "../../io/terminal.js";
import { StaticPromptAdapter } from "../../prompt/index.js";
import { ThemeManager } from "../../theme/colors.js";
import {
  parseAdapterTarget,
  resolveDeleteParentScope,
  runAdapter,
  type AdapterCommandContext,
} from "../adapter.js";

const themeManager = new ThemeManager({ isTty: () => false });
const theme = themeManager.getTheme(false);

const child = (
  overrides: Partial<PiAdapterChildListItem> = {},
): PiAdapterChildListItem => ({
  childId: overrides.childId ?? "child-1",
  threadId: overrides.threadId ?? "thread-1",
  title: overrides.title ?? "Title one",
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 2_000,
  originParentSessionId: overrides.originParentSessionId ?? "parent-1",
  tombstoned: overrides.tombstoned ?? false,
  stale: overrides.stale ?? false,
});

function makeChildrenPort(options: {
  readonly rows?: PiAdapterChildListItem[];
  readonly entryCount?: number;
  readonly sessionPath?: string;
}): PiAdapterChildrenPort {
  const rows = [...(options.rows ?? [child()])];
  const entryCount = options.entryCount ?? 3;
  const entries = Array.from({ length: entryCount }, (_, index) => ({
    index,
    id: `entry-${index}`,
    type: "message",
  }));
  return {
    list() {
      const page = rows.slice(0, PI_ADAPTER_COMMAND_BOUNDS.listPageSize);
      return okAsync({
        children: page,
        ...(rows.length > PI_ADAPTER_COMMAND_BOUNDS.listPageSize
          ? { nextCursor: "list-cursor" }
          : {}),
      });
    },
    show(input) {
      const found = rows.find((row) => {
        if (row.childId !== input.childId) return false;
        if (input.parentSessionId === undefined) return true;
        return row.originParentSessionId === input.parentSessionId;
      });
      if (found === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      const page = entries.slice(
        Math.max(0, entries.length - PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize),
      );
      return okAsync({
        child: found,
        entries: page,
        ...(entries.length > PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize
          ? { nextCursor: "show-cursor" }
          : {}),
        ...(input.diagnostic === true
          ? {
              sessionPath:
                options.sessionPath ??
                "/Users/jose/.local/share/weave/adapters/pi/sessions/x.jsonl",
              sessionRef: `${found.childId}/session.jsonl`,
            }
          : {}),
      });
    },
    delete(input) {
      if (!input.confirmed) {
        return errAsync({
          type: "ConfirmationRequired" as const,
          message: "delete requires confirmation or --yes",
        });
      }
      const found = rows.find(
        (row) =>
          row.childId === input.childId &&
          row.originParentSessionId === input.parentSessionId,
      );
      if (found === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      found.tombstoned = true;
      found.status = "tombstoned";
      return okAsync({
        childId: input.childId,
        tombstoned: true as const,
        deletedAt: "2026-08-05T12:00:00.000Z",
      });
    },
  };
}

function makeCtx(
  overrides: Partial<AdapterCommandContext> &
    Pick<AdapterCommandContext, "target">,
): { terminal: BufferTerminal; ctx: AdapterCommandContext } {
  const terminal = new BufferTerminal();
  const ctx: AdapterCommandContext = {
    terminal,
    theme,
    json: false,
    yes: false,
    diagnostic: false,
    workspaceKey: "workspace-test",
    prompt: new StaticPromptAdapter({ confirm: [true] }),
    registry: createPiAdapterCommandRegistry({
      children: makeChildrenPort({}),
    }),
    ...overrides,
  };
  return { terminal, ctx };
}

describe("parseAdapterTarget", () => {
  it("parses children list/show/delete and doctor", () => {
    expect(parseAdapterTarget(["pi", "children", "list"])._unsafeUnwrap()).toEqual(
      {
        adapter: "pi",
        action: "children.list",
      },
    );
    expect(
      parseAdapterTarget(["pi", "children", "show", "c1"])._unsafeUnwrap(),
    ).toMatchObject({ action: "children.show", childId: "c1" });
    expect(
      parseAdapterTarget(["pi", "children", "delete", "c1"])._unsafeUnwrap(),
    ).toEqual({
      adapter: "pi",
      action: "children.delete",
      childId: "c1",
    });
    expect(parseAdapterTarget(["pi", "doctor"])._unsafeUnwrap()).toEqual({
      adapter: "pi",
      action: "doctor",
    });
  });

  it("does not invent a synthetic parentSessionId for delete", () => {
    const target = parseAdapterTarget([
      "pi",
      "children",
      "delete",
      "child-1",
    ])._unsafeUnwrap();
    expect(target).toEqual({
      adapter: "pi",
      action: "children.delete",
      childId: "child-1",
    });
    expect(
      "parentSessionId" in target ? target.parentSessionId : undefined,
    ).toBeUndefined();
  });

  it("parses adapter flags from argv", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "adapter",
      "pi",
      "children",
      "show",
      "c1",
      "--json",
      "--diagnostic",
      "--cursor",
      "abc",
      "--parent-session",
      "parent-1",
    ]);
    expect(parsed._unsafeUnwrap()).toMatchObject({
      command: "adapter",
      rest: ["pi", "children", "show", "c1"],
      flags: {
        json: true,
        diagnostic: true,
        cursor: "abc",
        parentSession: "parent-1",
      },
    });
  });
});

describe("resolveDeleteParentScope", () => {
  it("resolves a unique origin parent from list metadata", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: makeChildrenPort({
        rows: [child({ childId: "child-1", originParentSessionId: "parent-a" })],
      }),
    });
    const resolved = await resolveDeleteParentScope(registry, "ws", {
      adapter: "pi",
      action: "children.delete",
      childId: "child-1",
    });
    expect(resolved._unsafeUnwrap().parentSessionId).toBe("parent-a");
  });

  it("requires --parent-session when the same child id exists under two parents", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: makeChildrenPort({
        rows: [
          child({
            childId: "shared-child",
            threadId: "thread-a",
            originParentSessionId: "parent-a",
          }),
          child({
            childId: "shared-child",
            threadId: "thread-b",
            originParentSessionId: "parent-b",
          }),
        ],
      }),
    });
    const ambiguous = await resolveDeleteParentScope(registry, "ws", {
      adapter: "pi",
      action: "children.delete",
      childId: "shared-child",
    });
    expect(ambiguous.isErr()).toBe(true);
    if (ambiguous.isOk()) return;
    expect(ambiguous.error).toContain("multiple parents");
    expect(ambiguous.error).toContain("--parent-session");

    const scoped = await resolveDeleteParentScope(registry, "ws", {
      adapter: "pi",
      action: "children.delete",
      childId: "shared-child",
      parentSessionId: "parent-b",
    });
    expect(scoped._unsafeUnwrap().parentSessionId).toBe("parent-b");
  });

  it("rejects a forged parent session scope", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: makeChildrenPort({
        rows: [
          child({ childId: "child-1", originParentSessionId: "parent-real" }),
        ],
      }),
    });
    const forged = await resolveDeleteParentScope(registry, "ws", {
      adapter: "pi",
      action: "children.delete",
      childId: "child-1",
      parentSessionId: "forged-parent",
    });
    expect(forged.isErr()).toBe(true);
    if (forged.isOk()) return;
    expect(forged.error).toContain("parent session scope rejected");
    expect(forged.error).toContain("forged-parent");
  });
});

describe("runAdapter", () => {
  it("bounds list to 50 and emits a stable JSON snapshot", async () => {
    const rows = Array.from({ length: 55 }, (_, index) =>
      child({
        childId: `child-${String(index).padStart(2, "0")}`,
        threadId: `thread-${index}`,
        title: `Title ${index}`,
        updatedAt: 10_000 - index,
      }),
    );
    const { terminal, ctx } = makeCtx({
      target: { adapter: "pi", action: "children.list" },
      json: true,
      registry: createPiAdapterCommandRegistry({
        children: makeChildrenPort({ rows }),
      }),
    });
    const code = await runAdapter(ctx);
    expect(code._unsafeUnwrap()).toBe(0);
    const body = JSON.parse(terminal.out.join("\n"));
    expect(body.children).toHaveLength(50);
    expect(body.nextCursor).toBe("list-cursor");
    expect(body).toMatchSnapshot("adapter-pi-children-list-json");
  });

  it("bounds show to 100 entries plus cursor and keeps default path-free", async () => {
    const path =
      "/Users/jose/.local/share/weave/adapters/pi/sessions/child-1/session.jsonl";
    const { terminal, ctx } = makeCtx({
      target: {
        adapter: "pi",
        action: "children.show",
        childId: "child-1",
      },
      json: true,
      registry: createPiAdapterCommandRegistry({
        children: makeChildrenPort({ entryCount: 130, sessionPath: path }),
      }),
    });
    const code = await runAdapter(ctx);
    expect(code._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).not.toContain(path);
    expect(out).not.toContain("/Users/");
    const body = JSON.parse(out);
    expect(body.entries).toHaveLength(100);
    expect(body.nextCursor).toBe("show-cursor");
    expect(body).toMatchSnapshot("adapter-pi-children-show-json");
  });

  it("includes diagnostic path only when --diagnostic is set", async () => {
    const path =
      "/Users/jose/.local/share/weave/adapters/pi/sessions/child-1/session.jsonl";
    const { terminal, ctx } = makeCtx({
      target: {
        adapter: "pi",
        action: "children.show",
        childId: "child-1",
      },
      json: true,
      diagnostic: true,
      registry: createPiAdapterCommandRegistry({
        children: makeChildrenPort({ sessionPath: path }),
      }),
    });
    await runAdapter(ctx);
    expect(terminal.out.join("\n")).toContain(path);
  });

  it("requires confirmation for delete unless --yes, then tombstones", async () => {
    const port = makeChildrenPort({});
    const registry = createPiAdapterCommandRegistry({ children: port });
    const declined = makeCtx({
      target: {
        adapter: "pi",
        action: "children.delete",
        childId: "child-1",
      },
      yes: false,
      registry,
      prompt: new StaticPromptAdapter({ confirm: [false] }),
    });
    const declinedCode = await runAdapter(declined.ctx);
    expect(declinedCode._unsafeUnwrap()).toBe(0);
    expect(declined.terminal.out.join("\n")).toContain("Delete cancelled");

    const accepted = makeCtx({
      target: {
        adapter: "pi",
        action: "children.delete",
        childId: "child-1",
      },
      yes: true,
      json: true,
      registry,
    });
    const code = await runAdapter(accepted.ctx);
    expect(code._unsafeUnwrap()).toBe(0);
    expect(JSON.parse(accepted.terminal.out.join("\n"))).toEqual({
      kind: "children.delete",
      childId: "child-1",
      tombstoned: true,
      deletedAt: "2026-08-05T12:00:00.000Z",
    });

    const listed = makeCtx({
      target: { adapter: "pi", action: "children.list" },
      json: true,
      registry,
    });
    await runAdapter(listed.ctx);
    const listBody = JSON.parse(listed.terminal.out.join("\n")) as {
      children: PiAdapterChildListItem[];
    };
    expect(listBody.children[0]?.tombstoned).toBe(true);
    expect(listBody.children[0]?.status).toBe("tombstoned");
  });

  it("deletes only the scoped parent when the same child id exists twice", async () => {
    const port = makeChildrenPort({
      rows: [
        child({
          childId: "shared-child",
          threadId: "thread-a",
          originParentSessionId: "parent-a",
        }),
        child({
          childId: "shared-child",
          threadId: "thread-b",
          originParentSessionId: "parent-b",
        }),
      ],
    });
    const registry = createPiAdapterCommandRegistry({ children: port });
    const { terminal, ctx } = makeCtx({
      target: {
        adapter: "pi",
        action: "children.delete",
        childId: "shared-child",
        parentSessionId: "parent-a",
      },
      yes: true,
      json: true,
      registry,
    });
    const code = await runAdapter(ctx);
    expect(code._unsafeUnwrap()).toBe(0);
    expect(JSON.parse(terminal.out.join("\n"))).toMatchObject({
      childId: "shared-child",
      tombstoned: true,
    });

    const listed = await port.list({
      workspaceKey: "ws",
      includeTombstoned: true,
    });
    const rows = listed._unsafeUnwrap().children;
    expect(
      rows.find((row) => row.originParentSessionId === "parent-a")?.tombstoned,
    ).toBe(true);
    expect(
      rows.find((row) => row.originParentSessionId === "parent-b")?.tombstoned,
    ).toBe(false);
  });

  it("rejects forged parent scope before delete dispatch", async () => {
    const { terminal, ctx } = makeCtx({
      target: {
        adapter: "pi",
        action: "children.delete",
        childId: "child-1",
        parentSessionId: "forged-parent",
      },
      yes: true,
      registry: createPiAdapterCommandRegistry({
        children: makeChildrenPort({}),
      }),
    });
    const code = await runAdapter(ctx);
    expect(code._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("parent session scope rejected");
  });

  it("runs doctor through the injectable shell", async () => {
    const { terminal, ctx } = makeCtx({
      target: { adapter: "pi", action: "doctor" },
      json: true,
    });
    const code = await runAdapter(ctx);
    expect(code._unsafeUnwrap()).toBe(0);
    expect(JSON.parse(terminal.out.join("\n"))).toMatchObject({
      kind: "doctor",
      status: "not_implemented",
    });
  });
});
