import { describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import { errAsync, okAsync } from "neverthrow";
import { makePlanCatalogUnavailableFailure } from "../errors.js";
import type {
  PathContainmentError,
  SecureDirectoryListing,
  SecureFileRead,
  SecureRelativeFileProvider,
} from "../path-containment.js";
import {
  BunPiPlanCatalogPort,
  FakePiPlanCatalogPort,
} from "../plan-catalog.js";

class FixedSecureRelativeFileProvider implements SecureRelativeFileProvider {
  constructor(
    private readonly listing: ResultAsync<
      SecureDirectoryListing,
      PathContainmentError
    >,
  ) {}

  readFile(): ResultAsync<SecureFileRead, PathContainmentError> {
    throw new Error("not used in these tests");
  }

  listDirectory(): ResultAsync<SecureDirectoryListing, PathContainmentError> {
    return this.listing;
  }
}

describe("BunPiPlanCatalogPort", () => {
  it("filters to safe .md basenames and sorts them deterministically", async () => {
    const provider = new FixedSecureRelativeFileProvider(
      okAsync({
        resolvedPath: "/project/.weave/plans",
        fileNames: [
          "zeta.md",
          "alpha.md",
          "not-a-plan.txt",
          "..md",
          "bad name.md",
          "beta_two.md",
        ],
      }),
    );
    const port = new BunPiPlanCatalogPort(provider);
    const result = await port.listPlanNames("/project");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(["alpha", "beta_two", "zeta"]);
    }
  });

  it("reports an empty catalog (not a failure) when .weave/plans does not exist yet", async () => {
    const provider = new FixedSecureRelativeFileProvider(
      errAsync("path-component-missing"),
    );
    const port = new BunPiPlanCatalogPort(provider);
    const result = await port.listPlanNames("/project");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("reports a degraded, typed failure for a real containment failure (e.g. a symlinked plans directory)", async () => {
    const provider = new FixedSecureRelativeFileProvider(
      errAsync("symlink-component-rejected"),
    );
    const port = new BunPiPlanCatalogPort(provider);
    const result = await port.listPlanNames("/project");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("PlanCatalogUnavailable");
    }
  });
});

describe("FakePiPlanCatalogPort", () => {
  it("returns the scripted names in order", async () => {
    const port = new FakePiPlanCatalogPort(["b-plan", "a-plan"]);
    const result = await port.listPlanNames("/anything");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(["b-plan", "a-plan"]);
  });

  it("returns the scripted failure when provided", async () => {
    const failure = makePlanCatalogUnavailableFailure("scripted");
    const port = new FakePiPlanCatalogPort([], failure);
    const result = await port.listPlanNames("/anything");
    expect(result.isErr()).toBe(true);
  });
});
