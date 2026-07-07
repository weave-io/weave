/**
 * Tests for BunFilesystemPlanStateProvider.
 *
 * Verifies:
 * - Safe-name validation rejects unsafe plan names
 * - planExists returns ok(true) when file exists, ok(false) when absent
 * - isPlanComplete returns ok(true) when no incomplete checkboxes, ok(false) otherwise
 * - ProviderUnavailable is returned for I/O errors
 * - BunFilesystemPlanStateProvider is importable from @weaveio/weave-config
 * - PlanStateProvider and PlanStateError are importable from @weaveio/weave-engine
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFilesystemPlanStateProvider } from "@weaveio/weave-config";
import type { PlanStateError, PlanStateProvider } from "@weaveio/weave-engine";

// ---------------------------------------------------------------------------
// Isolated temp directory — no real project files touched
// ---------------------------------------------------------------------------

let TEST_ROOT: string;
let TEST_PLAN_DIR: string;

beforeAll(async () => {
  // Create an isolated temp directory so tests never touch the real project.
  TEST_ROOT = join(tmpdir(), `weave-plan-state-test-${Date.now()}`);
  TEST_PLAN_DIR = join(TEST_ROOT, ".weave", "plans");
  await Bun.write(join(TEST_PLAN_DIR, ".keep"), "");
});

afterAll(async () => {
  // Clean up the entire temp tree after all tests finish.
  await rmdir(TEST_ROOT, { recursive: true }).catch(() => undefined);
});

async function writePlan(slug: string, content: string): Promise<string> {
  const path = join(TEST_PLAN_DIR, `${slug}.md`);
  await Bun.write(path, content);
  return path;
}

async function removePlan(slug: string): Promise<void> {
  const path = join(TEST_PLAN_DIR, `${slug}.md`);
  await unlink(path).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Import / type tests
// ---------------------------------------------------------------------------

describe("BunFilesystemPlanStateProvider: imports", () => {
  it("is importable from @weaveio/weave-config", () => {
    expect(BunFilesystemPlanStateProvider).toBeDefined();
  });

  it("implements PlanStateProvider interface", () => {
    const provider: PlanStateProvider = new BunFilesystemPlanStateProvider();
    expect(typeof provider.planExists).toBe("function");
    expect(typeof provider.isPlanComplete).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Safe-name validation
// ---------------------------------------------------------------------------

describe("BunFilesystemPlanStateProvider: safe-name validation", () => {
  const provider = new BunFilesystemPlanStateProvider();

  const unsafeNames = [
    "../etc/passwd",
    "../../secret",
    "plan/traversal",
    "plan\0null",
    "plan name with spaces",
    "plan.with.dots",
    "plan@special",
    "",
  ];

  for (const name of unsafeNames) {
    it(`planExists rejects unsafe name: ${JSON.stringify(name)}`, async () => {
      const result = await provider.planExists(name);
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.type).toBe("InvalidPlanName");
      if (result.error.type === "InvalidPlanName") {
        expect(result.error.planName).toBe(name);
      }
    });

    it(`isPlanComplete rejects unsafe name: ${JSON.stringify(name)}`, async () => {
      const result = await provider.isPlanComplete(name);
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.type).toBe("InvalidPlanName");
      if (result.error.type === "InvalidPlanName") {
        expect(result.error.planName).toBe(name);
      }
    });
  }

  const safeNames = [
    "my-plan",
    "my_plan",
    "MyPlan123",
    "plan-2024-01-01",
    "a",
    "PLAN",
  ];

  for (const name of safeNames) {
    it(`planExists accepts safe name: ${JSON.stringify(name)}`, async () => {
      // Safe names pass validation; result may be ok(false) (file absent) but not InvalidPlanName
      const result = await provider.planExists(name);
      if (result.isErr()) {
        expect(result.error.type).not.toBe("InvalidPlanName");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// planExists
// ---------------------------------------------------------------------------

describe("BunFilesystemPlanStateProvider: planExists", () => {
  // Provider is constructed lazily inside each test so TEST_ROOT is available.
  const slug = `test-plan-exists-${Date.now()}`;

  afterEach(async () => {
    await removePlan(slug);
  });

  it("returns ok(false) when plan file does not exist", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    const result = await provider.planExists(`nonexistent-plan-${Date.now()}`);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(false);
  });

  it("returns ok(true) when plan file exists", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    await writePlan(slug, "# Plan\n\n- [x] Task 1\n");
    const result = await provider.planExists(slug);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPlanComplete
// ---------------------------------------------------------------------------

describe("BunFilesystemPlanStateProvider: isPlanComplete", () => {
  // Provider is constructed lazily inside each test so TEST_ROOT is available.
  const slug = `test-plan-complete-${Date.now()}`;

  afterEach(async () => {
    await removePlan(slug);
  });

  it("returns ok(true) when all checkboxes are checked", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    await writePlan(
      slug,
      "# Plan\n\n- [x] Task 1\n- [x] Task 2\n- [x] Task 3\n",
    );
    const result = await provider.isPlanComplete(slug);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(true);
  });

  it("returns ok(true) when there are no checkboxes at all", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    await writePlan(slug, "# Plan\n\nJust some text, no checkboxes.\n");
    const result = await provider.isPlanComplete(slug);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(true);
  });

  it("returns ok(false) when there is one incomplete checkbox", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    await writePlan(
      slug,
      "# Plan\n\n- [x] Task 1\n- [ ] Task 2 (incomplete)\n- [x] Task 3\n",
    );
    const result = await provider.isPlanComplete(slug);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(false);
  });

  it("returns ok(false) when all checkboxes are incomplete", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    await writePlan(
      slug,
      "# Plan\n\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n",
    );
    const result = await provider.isPlanComplete(slug);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(false);
  });

  it("returns err(ProviderUnavailable) when plan file does not exist", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    const result = await provider.isPlanComplete(
      `nonexistent-plan-${Date.now()}`,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("ProviderUnavailable");
  });
});

// ---------------------------------------------------------------------------
// PlanStateError type guard (compile-time shape check)
// ---------------------------------------------------------------------------

describe("PlanStateError: discriminated union shape", () => {
  it("InvalidPlanName has planName field", () => {
    const e: PlanStateError = { type: "InvalidPlanName", planName: "bad/name" };
    expect(e.type).toBe("InvalidPlanName");
    if (e.type === "InvalidPlanName") {
      expect(e.planName).toBe("bad/name");
    }
  });

  it("ProviderUnavailable has cause field", () => {
    const e: PlanStateError = {
      type: "ProviderUnavailable",
      cause: new Error("disk full"),
    };
    expect(e.type).toBe("ProviderUnavailable");
    if (e.type === "ProviderUnavailable") {
      expect(e.cause).toBeInstanceOf(Error);
    }
  });
});
