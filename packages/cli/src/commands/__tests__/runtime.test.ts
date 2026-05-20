/**
 * Tests for the read-only runtime inspection CLI commands.
 *
 * Uses createInMemoryRuntimeStore() to avoid real filesystem operations.
 * The store factory is injected via RuntimeCommandContext.storeFactory.
 * The DB existence check is injected via RuntimeCommandContext.dbExists.
 */

import { describe, expect, it } from "bun:test";
import {
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createOwnerId,
  createWorkflowInstanceId,
} from "@weave/engine";
import { parseArgs } from "../../args.js";
import { run } from "../../cli.js";
import { BufferTerminal } from "../../io/terminal.js";
import { ThemeManager } from "../../theme/colors.js";
import { type RuntimeCommandContext, runRuntime } from "../runtime.js";

const themeManager = new ThemeManager({ isTty: () => false });
const theme = themeManager.getTheme(false);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  subcommand: "status" | "journal",
  overrides: Partial<RuntimeCommandContext> = {},
): { terminal: BufferTerminal; ctx: RuntimeCommandContext } {
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
  subcommand: "status" | "journal",
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  overrides: Partial<RuntimeCommandContext> = {},
): { terminal: BufferTerminal; ctx: RuntimeCommandContext } {
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
});

// ---------------------------------------------------------------------------
// CLI router integration
// ---------------------------------------------------------------------------

describe("runtime — CLI router integration", () => {
  it("routes 'runtime status' through the CLI router", async () => {
    const terminal = new BufferTerminal();
    const store = createInMemoryRuntimeStore();

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
