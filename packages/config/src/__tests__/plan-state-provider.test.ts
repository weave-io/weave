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
  await Bun.spawn(["rm", "-rf", TEST_ROOT]).exited;
});

async function writePlan(slug: string, content: string): Promise<string> {
  const path = join(TEST_PLAN_DIR, `${slug}.md`);
  await Bun.write(path, content);
  return path;
}

async function removePlan(slug: string): Promise<void> {
  const path = join(TEST_PLAN_DIR, `${slug}.md`);
  await Bun.file(path)
    .unlink()
    .catch(() => undefined);
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

  it("returns err(PlanMissing) when plan file does not exist", async () => {
    const provider = new BunFilesystemPlanStateProvider(TEST_ROOT);
    const result = await provider.isPlanComplete(
      `nonexistent-plan-${Date.now()}`,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("PlanMissing");
  });
});

// ---------------------------------------------------------------------------
// Revisioned snapshots and transitions (Spec 33 §16)
// ---------------------------------------------------------------------------

describe("BunFilesystemPlanStateProvider: revisioned plan state", () => {
  const provider = () => new BunFilesystemPlanStateProvider(TEST_ROOT);
  const slugs = new Set<string>();
  const slug = (label: string): string => {
    const value = `${label}-${Date.now()}-${slugs.size}`;
    slugs.add(value);
    return value;
  };

  afterEach(async () => {
    for (const name of slugs) await removePlan(name);
    slugs.clear();
  });

  it("reads a canonical two-level snapshot with visible IDs and derived state", async () => {
    const name = slug("canonical");
    await writePlan(
      name,
      "- [ ] 1. First parent\n  - [ ] a. First leaf\n  - [-] b. Active leaf\n- [x] 2. Completed parent\n",
    );

    const result = await provider().readSnapshot(name);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toMatchObject({
      planName: name,
      format: "canonical",
      totalParentCount: 2,
      complete: false,
    });
    expect(result.value.contentRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.parents).toEqual([
      {
        id: "1",
        title: "First parent",
        state: "in_progress",
        children: [
          {
            id: "1.a",
            title: "First leaf",
            state: "pending",
            children: [],
          },
          {
            id: "1.b",
            title: "Active leaf",
            state: "in_progress",
            children: [],
          },
        ],
      },
      {
        id: "2",
        title: "Completed parent",
        state: "completed",
        children: [],
      },
    ]);
  });

  it("applies an authorized leaf transition with revision CAS and atomic replacement", async () => {
    const name = slug("transition");
    await writePlan(
      name,
      "- [ ] 1. Parent\n  - [ ] a. Leaf\n  - [x] b. Done\n",
    );
    const before = (await provider().readSnapshot(name))._unsafeUnwrap();

    const transitioned = await provider().applyTransition({
      planName: name,
      taskId: "1.a",
      expectedRevision: before.contentRevision,
      toState: "in_progress",
      coordinatorAgent: "tapestry",
    });

    expect(transitioned.isOk()).toBe(true);
    if (transitioned.isErr()) return;
    expect(transitioned.value.contentRevision).not.toBe(before.contentRevision);
    expect(transitioned.value.parents[0]?.state).toBe("in_progress");
    expect(transitioned.value.parents[0]?.children[0]?.state).toBe(
      "in_progress",
    );
    expect(await Bun.file(join(TEST_PLAN_DIR, `${name}.md`)).text()).toContain(
      "  - [-] a. Leaf",
    );
  });

  it("rejects stale revisions, unauthorized coordinators, and terminal transitions", async () => {
    const name = slug("closed-transitions");
    await writePlan(name, "- [ ] 1. Pending\n- [x] 2. Terminal\n");
    const snapshot = (await provider().readSnapshot(name))._unsafeUnwrap();

    const unauthorized = await provider().applyTransition({
      planName: name,
      taskId: "1",
      expectedRevision: snapshot.contentRevision,
      toState: "in_progress",
      coordinatorAgent: "shuttle",
    });
    expect(unauthorized._unsafeUnwrapErr().type).toBe(
      "UnauthorizedCoordinator",
    );

    const terminal = await provider().applyTransition({
      planName: name,
      taskId: "2",
      expectedRevision: snapshot.contentRevision,
      toState: "in_progress",
      coordinatorAgent: "tapestry",
    });
    expect(terminal._unsafeUnwrapErr().type).toBe("InvalidTransition");

    const first = await provider().applyTransition({
      planName: name,
      taskId: "1",
      expectedRevision: snapshot.contentRevision,
      toState: "in_progress",
      coordinatorAgent: "tapestry",
    });
    expect(first.isOk()).toBe(true);

    const stale = await provider().applyTransition({
      planName: name,
      taskId: "1",
      expectedRevision: snapshot.contentRevision,
      toState: "in_progress",
      coordinatorAgent: "tapestry",
    });
    expect(stale._unsafeUnwrapErr().type).toBe("PlanRevisionStale");
  });

  it("reads unambiguous legacy plans and rejects ambiguous deep trees", async () => {
    const legacyName = slug("legacy");
    await writePlan(legacyName, "- [ ] First parent\n  - [x] First child\n");
    const legacy = await provider().readSnapshot(legacyName);
    expect(legacy.isOk()).toBe(true);
    if (legacy.isOk()) {
      expect(legacy.value.format).toBe("legacy");
      expect(legacy.value.parents[0]?.id).toBe("1");
      expect(legacy.value.parents[0]?.children[0]?.id).toBe("1.a");
    }

    const malformedName = slug("malformed");
    await writePlan(
      malformedName,
      "- [ ] Parent\n  - [ ] Child\n    - [ ] Too deep\n",
    );
    const malformed = await provider().readSnapshot(malformedName);
    expect(malformed._unsafeUnwrapErr().type).toBe("PlanTreeMalformed");
  });

  it("fails closed when the plans directory is a symlink", async () => {
    const root = join(TEST_ROOT, `symlink-root-${Date.now()}`);
    const outside = join(TEST_ROOT, `symlink-target-${Date.now()}`);
    const weave = join(root, ".weave");
    expect(await Bun.spawn(["mkdir", "-p", weave, outside]).exited).toBe(0);
    expect(
      await Bun.spawn(["ln", "-s", outside, join(weave, "plans")]).exited,
    ).toBe(0);
    await Bun.write(join(outside, "feature.md"), "- [ ] 1. Target\n");

    const result = await new BunFilesystemPlanStateProvider(root).readSnapshot(
      "feature",
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ProviderUnavailable");

    await Bun.spawn(["rm", "-rf", root, outside]).exited;
  });

  it("fails closed when the plan file is a symlink", async () => {
    const name = slug("symlink");
    const target = join(TEST_PLAN_DIR, `${name}-target.md`);
    const link = join(TEST_PLAN_DIR, `${name}.md`);
    await Bun.write(target, "- [ ] 1. Target\n");
    const linked = Bun.spawn(["ln", "-s", target, link]);
    expect(await linked.exited).toBe(0);

    const result = await provider().readSnapshot(name);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ProviderUnavailable");

    await Bun.file(link)
      .unlink()
      .catch(() => undefined);
    await Bun.file(target)
      .unlink()
      .catch(() => undefined);
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
