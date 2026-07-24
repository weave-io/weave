import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { BunPiPlanCatalogPort } from "../plan-catalog.js";

/**
 * Real Bun filesystem conformance tests (Spec 33 §24 layer E) for the
 * production `.weave/plans` directory listing - scratch temp directory
 * only. `Bun.$`/`Bun.write` are fixture scaffolding only (see
 * `artifact-provider-fs.test.ts`'s header for the same rationale); the code
 * under test proves containment itself via held-descriptor `openat`.
 */
describe("BunPiPlanCatalogPort — real filesystem conformance", () => {
  let root: string;

  beforeEach(async () => {
    const result = await $`mktemp -d`.quiet();
    root = result.text().trim();
    await $`mkdir -p ${join(root, ".weave", "plans")}`.quiet();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  it("lists ordinary .md plan files, sorted, ignoring non-.md files", async () => {
    const plansDir = join(root, ".weave", "plans");
    await Bun.write(join(plansDir, "zeta.md"), "# Zeta\n");
    await Bun.write(join(plansDir, "alpha.md"), "# Alpha\n");
    await Bun.write(join(plansDir, "notes.txt"), "not a plan");
    const port = new BunPiPlanCatalogPort();
    const result = await port.listPlanNames(root);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(["alpha", "zeta"]);
  });

  it("excludes an unsafe file name (fails the safe-name allowlist) even though it is an ordinary regular file", async () => {
    const plansDir = join(root, ".weave", "plans");
    await Bun.write(join(plansDir, "good-plan.md"), "# Good\n");
    await Bun.write(join(plansDir, "bad name!.md"), "# Bad\n");
    const port = new BunPiPlanCatalogPort();
    const result = await port.listPlanNames(root);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(["good-plan"]);
  });

  it("reports an empty catalog when .weave/plans does not exist yet", async () => {
    await $`rm -rf ${join(root, ".weave")}`.quiet();
    const port = new BunPiPlanCatalogPort();
    const result = await port.listPlanNames(root);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("rejects a symlinked plans directory rather than listing through it", async () => {
    const outsideResult = await $`mktemp -d`.quiet();
    const outside = outsideResult.text().trim();
    await Bun.write(join(outside, "secret.md"), "# Secret\n");
    await $`rm -rf ${join(root, ".weave", "plans")}`.quiet();
    await $`ln -s ${outside} ${join(root, ".weave", "plans")}`.quiet();
    const port = new BunPiPlanCatalogPort();
    const result = await port.listPlanNames(root);
    expect(result.isErr()).toBe(true);
    await $`rm -rf ${outside}`.quiet();
  });

  it("rejects a symlinked ancestor (.weave itself) rather than listing through it", async () => {
    const outsideResult = await $`mktemp -d`.quiet();
    const outside = outsideResult.text().trim();
    await $`mkdir -p ${join(outside, "plans")}`.quiet();
    await Bun.write(join(outside, "plans", "secret.md"), "# Secret\n");
    await $`rm -rf ${join(root, ".weave")}`.quiet();
    await $`ln -s ${outside} ${join(root, ".weave")}`.quiet();
    const port = new BunPiPlanCatalogPort();
    const result = await port.listPlanNames(root);
    expect(result.isErr()).toBe(true);
    await $`rm -rf ${outside}`.quiet();
  });
});
