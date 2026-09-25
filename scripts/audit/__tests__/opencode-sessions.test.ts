import { describe, expect, it } from "bun:test";
import { errAsync, ok, okAsync, type ResultAsync } from "neverthrow";
import {
  type AuditDependencies,
  type CategoryCounter,
  CategoryProjects,
  parseAuditArgs,
  SessionAuditCommand,
  StderrLogSink,
} from "../opencode-sessions.js";
import {
  type AuditError,
  OpenCodeV1SessionStore,
  OpenCodeV2SessionStore,
} from "../session-store.js";
import { DAY, V1Store, V2Store } from "./store-fixtures.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const HOME = "/home/dev";

describe("parseAuditArgs", () => {
  it("defaults to the OpenCode V1 store, the last 7 days and Markdown", () => {
    expect(parseAuditArgs([], NOW, HOME)._unsafeUnwrap()).toEqual({
      harness: "opencode",
      db: "/home/dev/.local/share/opencode/opencode.db",
      since: NOW - 7 * 24 * 60 * 60 * 1000,
      until: NOW,
      project: undefined,
      format: "md",
    });
  });

  it("defaults the OpenCode V2 store to the Weave-managed host's data directory", () => {
    expect(
      parseAuditArgs(["--harness", "opencode2"], NOW, HOME)._unsafeUnwrap().db,
    ).toBe("/home/dev/.weave/harnesses/opencode2/data/opencode.db");
  });

  it("reads a date-only --until as the end of that day", () => {
    const options = parseAuditArgs(
      ["--since", "2026-09-04", "--until", "2026-09-18"],
      NOW,
      HOME,
    )._unsafeUnwrap();
    expect(new Date(options.since).toISOString()).toBe(
      "2026-09-04T00:00:00.000Z",
    );
    expect(new Date(options.until).toISOString()).toBe(
      "2026-09-19T00:00:00.000Z",
    );
  });

  it("uses a full timestamp as given", () => {
    const options = parseAuditArgs(
      ["--until", "2026-09-18T12:00:00Z", "--db", "/x.db", "--format", "json"],
      NOW,
      HOME,
    )._unsafeUnwrap();
    expect(options.until).toBe(Date.parse("2026-09-18T12:00:00Z"));
    expect(options.db).toBe("/x.db");
    expect(options.format).toBe("json");
  });

  it.each([
    [["--harness", "claude"]],
    [["--format", "csv"]],
    [["--since", "last week"]],
    [["--since", "2026-09-10", "--until", "2026-09-01"]],
    [["--verbose", "yes"]],
    [["--db"]],
  ])("rejects %p with the usage", (argv) => {
    const error = parseAuditArgs(argv, NOW, HOME)._unsafeUnwrapErr();
    expect(error.type).toBe("UsageError");
    expect(error.type === "UsageError" && error.message).toContain("usage:");
  });
});

describe("CategoryProjects", () => {
  it("keeps projects whose config declares at least one category", async () => {
    const counts: Record<string, number> = { "/a": 2, "/b": 0 };
    const counter: CategoryCounter = (dir) => {
      const count = counts[dir];
      if (count !== undefined) return okAsync(count);
      return errAsync([
        {
          type: "FileReadError",
          path: `${dir}/.weave/config.weave`,
          cause: "EACCES",
        },
      ]);
    };
    const projects = await new CategoryProjects(counter).resolve([
      "/a",
      "/b",
      "/c",
      "/a",
    ]);
    expect([...projects._unsafeUnwrap()]).toEqual(["/a"]);
  });
});

describe("StderrLogSink", () => {
  it("drops lines below the minimum level and forwards the rest", () => {
    const lines: string[] = [];
    const sink = new StderrLogSink(40, {
      write: (chunk) => lines.push(chunk) > 0,
    });
    sink.write('{"level":30,"msg":"loaded"}\n');
    sink.write('{"level":50,"msg":"failed"}\n');
    expect(lines).toEqual(['{"level":50,"msg":"failed"}\n']);
  });
});

class Harness {
  readonly output: string[] = [];
  readonly opened: { harness: string; path: string }[] = [];

  constructor(
    private readonly stores: { v1?: V1Store; v2?: V2Store },
    private readonly categories = 1,
  ) {}

  deps(): AuditDependencies {
    return {
      openStore: (harness, path) => {
        this.opened.push({ harness, path });
        if (harness === "opencode2") {
          return ok(
            new OpenCodeV2SessionStore((this.stores.v2 ?? new V2Store()).db),
          );
        }
        return ok(
          new OpenCodeV1SessionStore((this.stores.v1 ?? new V1Store()).db),
        );
      },
      countCategories: () => okAsync(this.categories),
      write: (text): ResultAsync<void, AuditError> => {
        this.output.push(text);
        return okAsync(undefined);
      },
      now: () => NOW,
      home: HOME,
    };
  }
}

const WINDOW_ARGS = ["--since", "2026-09-09", "--until", "2026-09-10"];

function v1Fixture(): V1Store {
  return new V1Store()
    .session({ id: "s1", directory: "/home/dev/secret-project", time: DAY })
    .user("s1", "private user text")
    .assistant("s1", "loom", [
      {
        target: "shuttle-api",
        status: "error",
        error: "Model not found: private/.",
      },
      { target: "explore" },
    ])
    .assistant("s1", "loom", [{ target: "shuttle" }]);
}

describe("SessionAuditCommand", () => {
  it("prints the Markdown scorecard for the selected store", async () => {
    const harness = new Harness({ v1: v1Fixture() });
    const result = await new SessionAuditCommand(harness.deps()).run(
      WINDOW_ARGS,
    );
    expect(result.isOk()).toBe(true);
    const text = harness.output.join("");
    expect(text).toContain("## WS1 delegation scorecard — OpenCode V1");
    expect(text).toContain("| Delegations | 3 |");
    expect(text).toContain("| Configuration delegation failures | 1 of 3 |");
    expect(text).toContain("| Category-shuttle success | 0 / 1 (0.0%) |");
    expect(text).toContain(
      "| Built-in agent delegations | 1 (explore 1, general 0) |",
    );
    expect(harness.opened).toEqual([
      {
        harness: "opencode",
        path: "/home/dev/.local/share/opencode/opencode.db",
      },
    ]);
  });

  it("prints aggregates only: no directories, message text or error strings", async () => {
    const harness = new Harness({ v1: v1Fixture() });
    await new SessionAuditCommand(harness.deps()).run([
      ...WINDOW_ARGS,
      "--format",
      "json",
    ]);
    const text = harness.output.join("");
    expect(text).not.toContain("private");
    expect(text).not.toContain("secret-project");
    expect(JSON.parse(text).configurationFailures).toEqual({
      count: 1,
      total: 3,
    });
  });

  it("reads the OpenCode V2 store with --harness opencode2", async () => {
    const v2 = new V2Store()
      .session({ id: "s1", time: DAY })
      .assistant("s1", "loom", [{ target: "general" }]);
    const harness = new Harness({ v2 });
    await new SessionAuditCommand(harness.deps()).run([
      ...WINDOW_ARGS,
      "--harness",
      "opencode2",
      "--format",
      "json",
    ]);
    const card = JSON.parse(harness.output.join(""));
    expect(card.harness).toBe("opencode2");
    expect(card.builtinAgentDelegations.total).toBe(1);
  });

  it("returns the store's error and prints nothing when the schema does not match", async () => {
    const harness = new Harness({ v2: new V2Store() });
    const deps = harness.deps();
    const result = await new SessionAuditCommand({
      ...deps,
      openStore: () => ok(new OpenCodeV1SessionStore(new V2Store().db)),
    }).run(WINDOW_ARGS);
    expect(result._unsafeUnwrapErr().type).toBe("UnsupportedSchema");
    expect(harness.output).toEqual([]);
  });
});
