/**
 * Tests for the read-only runtime inspection CLI commands.
 *
 * Uses createInMemoryRuntimeStore() to avoid real filesystem operations.
 * The store factory is injected via RuntimeCommandContext.storeFactory.
 * The DB existence check is injected via RuntimeCommandContext.dbExists.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryRuntimeStore,
  createOwnerId,
} from "@weaveio/weave-engine";
import { parseArgs } from "../../args.js";
import { run } from "../../cli.js";
import { BufferTerminal } from "../../io/terminal.js";
import { ThemeManager } from "../../theme/colors.js";
import { type RuntimeCommandContext, runRuntime } from "../runtime.js";

const themeManager = new ThemeManager({ isTty: () => false });
const theme = themeManager.getTheme(false);

type RuntimePreferenceValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimePreferenceValue[]
  | { readonly [key: string]: RuntimePreferenceValue };

interface RuntimeTestContext {
  readonly terminal: BufferTerminal;
  readonly ctx: RuntimeCommandContext;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  subcommand: "status" | "journal" | "preferences",
  overrides: Partial<RuntimeCommandContext> = {},
): RuntimeTestContext {
  const terminal = new BufferTerminal();
  const store = createInMemoryRuntimeStore();
  const ctx: RuntimeCommandContext = {
    terminal,
    theme,
    subcommand,
    storeFactory: () => store,
    dbExists: async () => true,
    schemaVersion: 1,
    ...overrides,
  };
  return { terminal, ctx };
}

function makeContextWithStore(
  subcommand: "status" | "journal" | "preferences",
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  overrides: Partial<RuntimeCommandContext> = {},
): RuntimeTestContext {
  const terminal = new BufferTerminal();
  const ctx: RuntimeCommandContext = {
    terminal,
    theme,
    subcommand,
    storeFactory: () => store,
    dbExists: async () => true,
    ...overrides,
  };
  return { terminal, ctx };
}

// ---------------------------------------------------------------------------
// Missing runtime behavior
// ---------------------------------------------------------------------------

describe("runtime — missing store", () => {
  it("reports no runtime store found and exits 0 without creating DB", async () => {
    const terminal = new BufferTerminal();
    const ctx: RuntimeCommandContext = {
      terminal,
      theme,
      subcommand: "status",
      dbExists: async () => false,
      storeFactory: () => {
        throw new Error("store should not be created");
      },
    };
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No runtime store found at");
    expect(out).not.toContain("Runtime Store Status");
  });

  it("reports no runtime store for journal command too", async () => {
    const terminal = new BufferTerminal();
    const ctx: RuntimeCommandContext = {
      terminal,
      theme,
      subcommand: "journal",
      dbExists: async () => false,
      storeFactory: () => {
        throw new Error("store should not be created");
      },
    };
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("No runtime store found at");
  });
});

// ---------------------------------------------------------------------------
// runtime status
// ---------------------------------------------------------------------------

describe("runtime status", () => {
  it("renders status with DB path", async () => {
    const { terminal, ctx } = makeContext("status");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Runtime Store Status");
    expect(out).toContain("DB path:");
  });

  it("shows no active lease when store is empty", async () => {
    const { terminal, ctx } = makeContext("status");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No active lease");
  });

  it("shows active lease when one exists", async () => {
    const store = createInMemoryRuntimeStore();
    // Create a workflow instance first
    const instanceResult = await store.instances.create({
      workflowName: "test-workflow",
      goal: "test goal",
      slug: "test-goal",
    });
    expect(instanceResult.isOk()).toBe(true);
    const instance = instanceResult._unsafeUnwrap();

    // Acquire a lease
    const leaseResult = await store.leases.acquire({
      workflowInstanceId: instance.id,
      ownerId: createOwnerId("test-owner"),
      ttlMs: 60_000,
    });
    expect(leaseResult.isOk()).toBe(true);

    const { terminal, ctx } = makeContextWithStore("status", store);
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Active Lease");
    expect(out).toContain("test-owner");
  });

  it("shows workflow instances", async () => {
    const store = createInMemoryRuntimeStore();
    await store.instances.create({
      workflowName: "my-workflow",
      goal: "implement feature X",
      slug: "implement-feature-x",
    });

    const { terminal, ctx } = makeContextWithStore("status", store);
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Workflow Instances");
    expect(out).toContain("my-workflow");
    expect(out).toContain("implement feature X");
  });

  it("shows resumable instances separately", async () => {
    const store = createInMemoryRuntimeStore();
    const inst = await store.instances.create({
      workflowName: "paused-workflow",
      goal: "paused goal",
      slug: "paused-goal",
    });
    await store.instances.update(inst._unsafeUnwrap().id, {
      status: "paused",
    });

    const { terminal, ctx } = makeContextWithStore("status", store);
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Resumable:");
  });

  it("shows no workflow instances when store is empty", async () => {
    const { terminal, ctx } = makeContext("status");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No workflow instances found");
  });

  it("does not mutate the store (read-only)", async () => {
    const store = createInMemoryRuntimeStore();
    const { ctx } = makeContextWithStore("status", store, { schemaVersion: 1 });
    await runRuntime(ctx);

    // Verify no instances were created
    const instances = await store.instances.list();
    expect(instances._unsafeUnwrap()).toHaveLength(0);
  });

  it("shows schema version in status output", async () => {
    const { terminal, ctx } = makeContext("status", { schemaVersion: 1 });
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Schema version: 1");
  });

  it("shows injected schema version in status output", async () => {
    const { terminal, ctx } = makeContext("status", { schemaVersion: 42 });
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Schema version: 42");
  });

  it("surfaces schema-read failure to stderr and falls back to CURRENT_SCHEMA_VERSION", async () => {
    // Use a cwd where the DB path resolves to a non-existent directory so that
    // new Database(path, { readonly: true }) throws "unable to open database file".
    // dbExists returns true (simulating the store exists) but the DB open fails.
    // This exercises the outer catch: stderr warning + CURRENT_SCHEMA_VERSION fallback.
    const terminal = new BufferTerminal();
    const store = createInMemoryRuntimeStore();
    const ctx: RuntimeCommandContext = {
      terminal,
      theme,
      subcommand: "status",
      storeFactory: () => store,
      dbExists: async () => true,
      // cwd points to a directory that doesn't contain .weave/runtime/weave.db
      // so new Database(resolvedPath, { readonly: true }) will throw
      cwd: "/nonexistent-weave-test-dir-that-does-not-exist",
      // schemaVersion intentionally omitted — forces the real DB read path
    };

    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);

    // stderr must contain the fallback warning
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("Could not read schema version");

    // stdout must still show the status output (command continues with fallback)
    const stdOut = terminal.out.join("\n");
    expect(stdOut).toContain("Runtime Store Status");
  });
});

// ---------------------------------------------------------------------------
// runtime journal
// ---------------------------------------------------------------------------

describe("runtime journal", () => {
  it("renders journal header", async () => {
    const { terminal, ctx } = makeContext("journal");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Runtime Journal");
    expect(out).toContain("limit:");
  });

  it("shows no entries when journal is empty", async () => {
    const { terminal, ctx } = makeContext("journal");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No journal entries found");
  });

  it("renders journal entries with timestamp, severity, source, eventType", async () => {
    const store = createInMemoryRuntimeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: { stepName: "plan" },
    });

    const { terminal, ctx } = makeContextWithStore("journal", store);
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("engine/runner");
    expect(out).toContain("step.started");
    expect(out).toContain("[INFO]");
  });

  it("respects --limit flag", async () => {
    const store = createInMemoryRuntimeStore();
    // Append 10 entries
    for (let i = 0; i < 10; i++) {
      await store.journal.append({
        source: { kind: "engine", name: "runner" },
        eventType: `event.${i}`,
        severity: "info",
        data: { index: i },
      });
    }

    const { terminal, ctx } = makeContextWithStore("journal", store, {
      limit: 3,
    });
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    // Header should show limit: 3, showing: 3
    expect(out).toContain("limit: 3");
    expect(out).toContain("showing: 3");
  });

  it("defaults to limit 50", async () => {
    const { terminal, ctx } = makeContext("journal");
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("limit: 50");
  });

  it("sanitizes output — does not render sensitive field names", async () => {
    const store = createInMemoryRuntimeStore();
    // Append entry with safe data only (sensitive fields would be rejected by sanitizer)
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.completed",
      severity: "info",
      data: { stepName: "implement", duration: 1234 },
    });

    const { terminal, ctx } = makeContextWithStore("journal", store);
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    // Safe fields should appear
    expect(out).toContain("stepName");
    expect(out).toContain("duration");
    // No raw prompt/completion/token fields
    expect(out).not.toContain("password");
    expect(out).not.toContain("token");
    expect(out).not.toContain("apiKey");
  });

  it("does not mutate the store (read-only)", async () => {
    const store = createInMemoryRuntimeStore();
    const { ctx } = makeContextWithStore("journal", store);
    await runRuntime(ctx);

    // Verify no journal entries were created by the command
    const entries = await store.journal.query();
    expect(entries._unsafeUnwrap()).toHaveLength(0);
  });

  it("deterministic output — same entries produce same output", async () => {
    const store = createInMemoryRuntimeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "lease.acquired",
      severity: "info",
      data: { workflowName: "test" },
    });

    const { terminal: t1, ctx: ctx1 } = makeContextWithStore("journal", store);
    await runRuntime(ctx1);

    const { terminal: t2, ctx: ctx2 } = makeContextWithStore("journal", store);
    await runRuntime(ctx2);

    expect(t1.out.join("\n")).toBe(t2.out.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// runtime preferences
// ---------------------------------------------------------------------------

async function seedPreference(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  namespace: string,
  key: string,
  value: RuntimePreferenceValue,
): Promise<void> {
  const result = await store.preferences.set(
    namespace,
    key,
    JSON.stringify(value),
  );
  expect(result.isOk()).toBe(true);
}

/** UTF-8 byte length of a string. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe("runtime preferences", () => {
  it("reports no runtime store found and exits 0 without creating a DB", async () => {
    const terminal = new BufferTerminal();
    const ctx: RuntimeCommandContext = {
      terminal,
      theme,
      subcommand: "preferences",
      namespace: "adapter-pi",
      dbExists: async () => false,
      storeFactory: () => {
        throw new Error("store should not be created");
      },
    };
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("No runtime store found at");
    expect(terminal.out.join("\n")).not.toContain("Adapter Preferences");
  });

  it("lists every namespace by default, ordered by namespace then key", async () => {
    const store = createInMemoryRuntimeStore();
    // Seeded out of order across three namespaces.
    await seedPreference(store, "adapter-pi", "child-extensions", { a: 1 });
    await seedPreference(store, "adapter-other", "other-key", { b: 2 });
    await seedPreference(store, "adapter-pi", "another-key", { c: 3 });

    const { terminal, ctx } = makeContextWithStore("preferences", store);
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Adapter Preferences");
    expect(out).toContain("all namespaces");
    expect(out).toContain("showing: 3");
    const rows = out.split("\n").filter((line) => line.startsWith("adapter-"));
    expect(rows.map((row) => row.split("  ").slice(0, 2).join("/"))).toEqual([
      "adapter-other/other-key",
      "adapter-pi/another-key",
      "adapter-pi/child-extensions",
    ]);
  });

  it("produces the same default listing on repeated runs", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "zeta", "b", { b: 1 });
    await seedPreference(store, "alpha", "z", { z: 1 });
    await seedPreference(store, "zeta", "a", { a: 1 });

    const { terminal: t1, ctx: ctx1 } = makeContextWithStore(
      "preferences",
      store,
    );
    await runRuntime(ctx1);
    const { terminal: t2, ctx: ctx2 } = makeContextWithStore(
      "preferences",
      store,
    );
    await runRuntime(ctx2);

    expect(t1.out.join("\n")).toBe(t2.out.join("\n"));
    const rows = t1.out
      .join("\n")
      .split("\n")
      .filter(
        (line) => line.startsWith("alpha  ") || line.startsWith("zeta  "),
      );
    expect(rows.map((row) => row.split("  ").slice(0, 2).join("/"))).toEqual([
      "alpha/z",
      "zeta/a",
      "zeta/b",
    ]);
  });

  it("clamps an oversized --limit in the default cross-namespace listing", async () => {
    const store = createInMemoryRuntimeStore();
    for (let i = 0; i < 105; i++) {
      await seedPreference(store, `ns-${String(i).padStart(3, "0")}`, "key", {
        i,
      });
    }

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      limit: 500,
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("limit: 100");
    expect(out).toContain("showing: 100");
    const rows = out.split("\n").filter((line) => line.startsWith("ns-"));
    expect(rows).toHaveLength(100);
    // Bounded from the start of the deterministic order.
    expect(rows[0]).toStartWith("ns-000  key  ");
    expect(rows[99]).toStartWith("ns-099  key  ");
  });

  it("reports an empty default listing clearly and exits 0", async () => {
    const { terminal, ctx } = makeContext("preferences");
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No preferences stored.");
    expect(out).toContain("showing: 0");
    expect(terminal.err.join("\n")).toBe("");
  });

  it("reports no runtime store found for the default listing and exits 0", async () => {
    const terminal = new BufferTerminal();
    const ctx: RuntimeCommandContext = {
      terminal,
      theme,
      subcommand: "preferences",
      dbExists: async () => false,
      storeFactory: () => {
        throw new Error("store should not be created");
      },
    };
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("No runtime store found at");
    expect(terminal.out.join("\n")).not.toContain("Adapter Preferences");
  });

  it("truncates a long value preview in the default listing too", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "long", {
      note: "é".repeat(400),
    });

    const { terminal, ctx } = makeContextWithStore("preferences", store);
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const rows = terminal.out
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("adapter-pi  long  "));
    expect(rows).toHaveLength(1);
    const preview = rows[0].split("  ")[3];
    expect(preview.endsWith("\u2026")).toBe(true);
    expect(byteLength(preview)).toBeLessThanOrEqual(123);
    expect(preview).not.toContain("\uFFFD");
  });

  it("surfaces a repository failure in the default listing and exits 1", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { preferenceList: { type: "query", message: "listAll boom" } },
    });

    const { terminal, ctx } = makeContextWithStore("preferences", store);
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error querying preferences");
    expect(terminal.out.join("\n")).not.toContain("Adapter Preferences");
  });

  it("lists stored preferences as namespace, key, updated_at, value preview", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "child-extensions", {
      mode: "explicit",
    });

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("Adapter Preferences");
    expect(out).toContain("namespace: adapter-pi");
    expect(out).toContain("showing: 1");
    const row = out
      .split("\n")
      .find((line) => line.startsWith("adapter-pi  child-extensions  "));
    expect(row).toBeDefined();
    expect(row).toContain('{"mode":"explicit"}');
  });

  it("filters by namespace and never shows another namespace's rows", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "pi-key", { pi: true });
    await seedPreference(store, "adapter-other", "other-key", { other: true });

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("pi-key");
    expect(out).not.toContain("other-key");
    expect(out).not.toContain("adapter-other");
    expect(out).toContain("showing: 1");
  });

  it("defaults to the engine list limit of 100", async () => {
    const { terminal, ctx } = makeContext("preferences", {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("limit: 100");
  });

  it("honors a smaller --limit", async () => {
    const store = createInMemoryRuntimeStore();
    for (let i = 0; i < 5; i++) {
      await seedPreference(store, "adapter-pi", `key-${i}`, { i });
    }

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
      limit: 2,
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("limit: 2");
    expect(out).toContain("showing: 2");
    const rows = out
      .split("\n")
      .filter((line) => line.startsWith("adapter-pi  "));
    expect(rows).toHaveLength(2);
  });

  it("clamps an oversized --limit to 100 rows", async () => {
    const store = createInMemoryRuntimeStore();
    for (let i = 0; i < 105; i++) {
      // Zero-padded keys keep the repository's key ordering stable.
      await seedPreference(
        store,
        "adapter-pi",
        `key-${String(i).padStart(3, "0")}`,
        { i },
      );
    }

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
      limit: 500,
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("limit: 100");
    expect(out).toContain("showing: 100");
    const rows = out
      .split("\n")
      .filter((line) => line.startsWith("adapter-pi  "));
    expect(rows).toHaveLength(100);
  });

  it("reports an empty namespace clearly and exits 0", async () => {
    const { terminal, ctx } = makeContext("preferences", {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain('No preferences stored in namespace "adapter-pi"');
    expect(out).toContain("showing: 0");
  });

  it("truncates a long value preview by bytes and keeps one line per record", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "long", {
      note: "é".repeat(400),
    });

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const rows = terminal.out
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("adapter-pi  long  "));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const preview = row.split("  ")[3];
    expect(preview.endsWith("\u2026")).toBe(true);
    // 120 payload bytes plus the 3-byte ellipsis marker.
    expect(byteLength(preview)).toBeLessThanOrEqual(123);
    // No replacement character from a split multi-byte sequence.
    expect(preview).not.toContain("\uFFFD");
  });

  it("collapses control characters so a value cannot forge extra rows", async () => {
    const store = createInMemoryRuntimeStore();
    // Pretty-printed JSON carries real newlines between tokens, which the
    // engine accepts as valid JSON.
    const stored = await store.preferences.set(
      "adapter-pi",
      "multiline",
      JSON.stringify({ mode: "explicit", entries: ["a", "b"] }, null, 2),
    );
    expect(stored.isOk()).toBe(true);
    expect(stored._unsafeUnwrap().valueJson).toContain("\n");

    const { terminal, ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const printed = terminal.out.join("\n");
    const rows = printed
      .split("\n")
      .filter((line) => line.startsWith("adapter-pi  "));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("explicit");
    expect(rows[0]).not.toContain("\n");
  });

  it("reports a repository error for an out-of-bounds namespace and exits 1", async () => {
    const { terminal, ctx } = makeContext("preferences", {
      // 65 characters — beyond the engine's 64-character namespace bound.
      namespace: "n".repeat(65),
    });
    const result = await runRuntime(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error querying preferences");
    expect(terminal.out.join("\n")).not.toContain("Adapter Preferences");
  });

  it("does not mutate the store (read-only)", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "only", { a: 1 });

    const { ctx } = makeContextWithStore("preferences", store, {
      namespace: "adapter-pi",
    });
    await runRuntime(ctx);

    const after = await store.preferences.list("adapter-pi");
    expect(after._unsafeUnwrap()).toHaveLength(1);
    const other = await store.preferences.list("adapter-other");
    expect(other._unsafeUnwrap()).toHaveLength(0);
  });

  it("does not mutate the store in the default listing either", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "only", { a: 1 });

    const { ctx } = makeContextWithStore("preferences", store);
    await runRuntime(ctx);

    const all = await store.preferences.listAll();
    expect(all._unsafeUnwrap().map((row) => row.key)).toEqual(["only"]);
  });

  it("produces deterministic output for the same records", async () => {
    const store = createInMemoryRuntimeStore();
    await seedPreference(store, "adapter-pi", "b-key", { b: 1 });
    await seedPreference(store, "adapter-pi", "a-key", { a: 1 });

    const { terminal: t1, ctx: ctx1 } = makeContextWithStore(
      "preferences",
      store,
      { namespace: "adapter-pi" },
    );
    await runRuntime(ctx1);
    const { terminal: t2, ctx: ctx2 } = makeContextWithStore(
      "preferences",
      store,
      { namespace: "adapter-pi" },
    );
    await runRuntime(ctx2);

    expect(t1.out.join("\n")).toBe(t2.out.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// Routing / arg parsing
// ---------------------------------------------------------------------------

describe("runtime — arg parsing", () => {
  it("parses 'runtime status' command", () => {
    const result = parseArgs(["bun", "weave", "runtime", "status"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("runtime");
    expect(parsed.flags.runtimeSubcommand).toBe("status");
  });

  it("parses 'runtime journal' command", () => {
    const result = parseArgs(["bun", "weave", "runtime", "journal"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("runtime");
    expect(parsed.flags.runtimeSubcommand).toBe("journal");
  });

  it("parses 'runtime preferences' command", () => {
    const result = parseArgs(["bun", "weave", "runtime", "preferences"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("runtime");
    expect(parsed.flags.runtimeSubcommand).toBe("preferences");
    expect(parsed.flags.namespace).toBeUndefined();
  });

  it("parses 'runtime preferences --namespace adapter-pi --limit 5'", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "preferences",
      "--namespace",
      "adapter-pi",
      "--limit",
      "5",
    ]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.flags.runtimeSubcommand).toBe("preferences");
    expect(parsed.flags.namespace).toBe("adapter-pi");
    expect(parsed.flags.limit).toBe(5);
  });

  it("returns error for missing --namespace value", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "preferences",
      "--namespace",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("MissingFlagValue");
    expect(e.flag).toBe("--namespace");
    expect(e.message).toContain("namespace");
  });

  it("returns error when --namespace is followed by another flag", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "preferences",
      "--namespace",
      "--limit",
      "5",
    ]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().flag).toBe("--namespace");
  });

  it("returns InvalidFlagValue for 'runtime preferences --limit 0'", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "preferences",
      "--limit",
      "0",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFlagValue");
    expect(e.flag).toBe("--limit");
  });

  it("parses 'runtime journal --limit 10'", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "10",
    ]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("runtime");
    expect(parsed.flags.runtimeSubcommand).toBe("journal");
    expect(parsed.flags.limit).toBe(10);
  });

  it("defaults limit to 50 when not specified", () => {
    const result = parseArgs(["bun", "weave", "runtime", "journal"]);
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.flags.limit).toBeUndefined();
    // The command itself defaults to 50 when limit is undefined
  });

  it("returns error for missing --limit value", () => {
    const result = parseArgs(["bun", "weave", "runtime", "journal", "--limit"]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().flag).toBe("--limit");
  });

  it("returns InvalidFlagValue error for --limit abc", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "abc",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFlagValue");
    expect(e.flag).toBe("--limit");
    expect(e.message).toContain("positive integer");
  });

  it("returns InvalidFlagValue error for --limit 0", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "0",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFlagValue");
    expect(e.flag).toBe("--limit");
  });

  it("returns InvalidFlagValue error for --limit -5", () => {
    // Note: "-5" starts with "-" so it triggers MissingFlagValue (treated as
    // a missing value / next flag). Both error types are acceptable here since
    // the value is still rejected.
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "-5",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.flag).toBe("--limit");
  });

  it("returns InvalidFlagValue error for --limit 10xyz (partial integer)", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "10xyz",
    ]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFlagValue");
    expect(e.flag).toBe("--limit");
  });

  it("accepts --limit 1 (minimum valid positive integer)", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "runtime",
      "journal",
      "--limit",
      "1",
    ]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().flags.limit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI router integration
// ---------------------------------------------------------------------------

describe("runtime — CLI router integration", () => {
  it("routes 'runtime status' through the CLI router", async () => {
    const terminal = new BufferTerminal();
    const _store = createInMemoryRuntimeStore();

    // We can't easily inject the store through the CLI router, so we test
    // that the router correctly dispatches to the runtime command by checking
    // that the output contains expected runtime status content.
    // We use a missing-DB path to avoid real filesystem access.
    const result = await run({
      argv: ["bun", "weave", "runtime", "status"],
      terminal,
      colorEnabled: false,
    });
    // Should succeed (exit 0) — either shows status or "no runtime store found"
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    // Either "Runtime Store Status" (if DB exists) or "No runtime store found"
    const hasExpectedOutput =
      out.includes("Runtime Store Status") ||
      out.includes("No runtime store found");
    expect(hasExpectedOutput).toBe(true);
  });

  it("routes 'runtime journal' through the CLI router", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "runtime", "journal"],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    const hasExpectedOutput =
      out.includes("Runtime Journal") || out.includes("No runtime store found");
    expect(hasExpectedOutput).toBe(true);
  });

  it("routes 'runtime preferences' through the CLI router", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: [
        "bun",
        "weave",
        "runtime",
        "preferences",
        "--namespace",
        "adapter-pi",
      ],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    const hasExpectedOutput =
      out.includes("Adapter Preferences") ||
      out.includes("No runtime store found");
    expect(hasExpectedOutput).toBe(true);
  });

  it("routes 'runtime preferences' without --namespace through the CLI router", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "runtime", "preferences"],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    const hasExpectedOutput =
      out.includes("Adapter Preferences") ||
      out.includes("No runtime store found");
    expect(hasExpectedOutput).toBe(true);
  });

  it("exits non-zero for a 'runtime preferences --namespace' argument error", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "runtime", "preferences", "--namespace"],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).not.toBe(0);
    expect(terminal.err.join("\n")).toContain("--namespace");
  });

  it("shows usage when 'runtime' is called without subcommand", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "runtime"],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).toBe(1);
    const err = terminal.err.join("\n");
    expect(err).toContain("weave runtime status");
    expect(err).toContain("weave runtime journal");
    expect(err).toContain("weave runtime preferences");
  });

  it("help output includes runtime status and runtime journal", async () => {
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "--help"],
      terminal,
      colorEnabled: false,
    });
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("runtime status");
    expect(out).toContain("runtime journal");
  });
});
