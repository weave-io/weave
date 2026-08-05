import { describe, expect, it } from "bun:test";
import { dispatchAdapterCommand } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  createPiAdapterCommandHandlers,
  createPiAdapterCommandRegistry,
  createPlaceholderDoctorPort,
  looksLikeFilesystemPath,
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  stripPathsUnlessDiagnostic,
  type PiAdapterChildrenPort,
  type PiAdapterChildListItem,
} from "../adapter-cli-commands.js";

const child = (
  overrides: Partial<PiAdapterChildListItem> = {},
): PiAdapterChildListItem => ({
  childId: overrides.childId ?? "child-1",
  threadId: overrides.threadId ?? "thread-1",
  title: overrides.title ?? "Title",
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 2_000,
  originParentSessionId: overrides.originParentSessionId ?? "parent-1",
  tombstoned: overrides.tombstoned ?? false,
  stale: overrides.stale ?? false,
});

function fakeChildren(options: {
  readonly list?: PiAdapterChildListItem[];
  readonly entries?: readonly { id: string; type: string }[];
  readonly sessionPath?: string;
}): PiAdapterChildrenPort {
  const rows = [...(options.list ?? [child()])];
  const entries = options.entries ?? [
    { id: "e1", type: "message" },
    { id: "e2", type: "message" },
  ];
  return {
    list(input) {
      const limited = rows
        .filter((row) => input.includeTombstoned === true || !row.tombstoned)
        .slice(0, PI_ADAPTER_COMMAND_BOUNDS.listPageSize);
      return okAsync({
        children: limited,
        ...(rows.length > PI_ADAPTER_COMMAND_BOUNDS.listPageSize
          ? { nextCursor: "cursor-next" }
          : {}),
      });
    },
    show(input) {
      const found = rows.find((row) => row.childId === input.childId);
      if (found === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      const page = entries.slice(-PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize);
      return okAsync({
        child: found,
        entries: page.map((entry, index) => ({
          index,
          id: entry.id,
          type: entry.type,
        })),
        ...(entries.length > PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize
          ? { nextCursor: "entry-cursor" }
          : {}),
        ...(input.diagnostic === true
          ? {
              sessionPath:
                options.sessionPath ?? "/tmp/weave/adapters/pi/sessions/x.jsonl",
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
      const found = rows.find((row) => row.childId === input.childId);
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
        deletedAt: "2026-08-05T00:00:00.000Z",
      });
    },
  };
}

describe("Pi adapter-cli-commands", () => {
  it("lists at most 50 children through engine dispatch", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      child({
        childId: `child-${index}`,
        threadId: `thread-${index}`,
        updatedAt: 3_000 - index,
      }),
    );
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ list: many }),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({ workspaceKey: "ws" }),
    });
    expect(result.isOk()).toBe(true);
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      children: unknown[];
      nextCursor?: string;
    };
    expect(body.children).toHaveLength(50);
    expect(body.nextCursor).toBe("cursor-next");
  });

  it("shows at most 100 entries and a cursor when more remain", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: `e-${index}`,
      type: "message",
    }));
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ entries }),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
      }),
    });
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      entries: unknown[];
      nextCursor?: string;
      sessionPath?: string;
    };
    expect(body.entries).toHaveLength(100);
    expect(body.nextCursor).toBe("entry-cursor");
    expect(body.sessionPath).toBeUndefined();
  });

  it("omits filesystem paths by default and includes them with diagnostic", async () => {
    const path = "/Users/jose/.local/share/weave/adapters/pi/sessions/a.jsonl";
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ sessionPath: path }),
    });

    const defaultShow = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
      }),
    });
    const defaultBody = defaultShow._unsafeUnwrap().resultJson;
    expect(defaultBody).not.toContain(path);
    expect(defaultBody).not.toContain("/Users/");

    const diagnosticShow = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        diagnostic: true,
      }),
    });
    expect(diagnosticShow._unsafeUnwrap().resultJson).toContain(path);
  });

  it("requires confirmation for delete and tombstones on confirm", async () => {
    const port = fakeChildren({});
    const handlers = createPiAdapterCommandHandlers({ children: port });
    const refused = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenDelete]!(
      JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: "parent-1",
        confirmed: false,
      }),
    );
    expect(refused.isErr()).toBe(true);

    const deleted = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenDelete]!(
      JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: "parent-1",
        confirmed: true,
      }),
    );
    expect(JSON.parse(deleted._unsafeUnwrap())).toEqual({
      kind: "children.delete",
      childId: "child-1",
      tombstoned: true,
      deletedAt: "2026-08-05T00:00:00.000Z",
    });

    const listed = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenList]!(
      JSON.stringify({ workspaceKey: "ws", includeTombstoned: true }),
    );
    const body = JSON.parse(listed._unsafeUnwrap()) as {
      children: PiAdapterChildListItem[];
    };
    expect(body.children[0]?.tombstoned).toBe(true);
    expect(body.children[0]?.status).toBe("tombstoned");
  });

  it("exposes an injectable doctor shell for Task 15", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({}),
      doctor: createPlaceholderDoctorPort(),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.doctor,
      payloadJson: JSON.stringify({}),
    });
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      kind: string;
      status: string;
    };
    expect(body.kind).toBe("doctor");
    expect(body.status).toBe("not_implemented");
  });

  it("stripPathsUnlessDiagnostic removes absolute paths", () => {
    expect(looksLikeFilesystemPath("/tmp/x")).toBe(true);
    expect(looksLikeFilesystemPath("child-1/session.jsonl")).toBe(false);
    const cleaned = stripPathsUnlessDiagnostic(
      { sessionPath: "/tmp/x", ok: true } as {
        sessionPath?: string;
        ok: boolean;
      },
      false,
    );
    expect(cleaned).toEqual({ ok: true });
    expect("sessionPath" in cleaned).toBe(false);
  });
});
