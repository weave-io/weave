import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { makeRuntimeStoreOpenFailedFailure } from "../errors.js";
import {
  FailingRuntimeStoreFactory,
  InMemoryRuntimeStoreFactory,
  SqliteRuntimeStoreFactory,
} from "../runtime-store-port.js";

describe("InMemoryRuntimeStoreFactory", () => {
  it("returns the injected store without touching disk", async () => {
    const store = createInMemoryRuntimeStore();
    const factory = new InMemoryRuntimeStoreFactory(store);
    const result = await factory.open("/never/read");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(store);
  });
});

describe("FailingRuntimeStoreFactory", () => {
  it("maps a scripted open failure onto RuntimeStoreOpenFailed", async () => {
    const factory = new FailingRuntimeStoreFactory(
      makeRuntimeStoreOpenFailedFailure("disk-unavailable"),
    );
    const result = await factory.open("/tmp/weave.db");
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("RuntimeStoreOpenFailed");
  });
});

describe("SqliteRuntimeStoreFactory — real filesystem conformance", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "weave-runtime-store-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("opens and migrates a fresh Runtime Store in a scratch directory", async () => {
    const factory = new SqliteRuntimeStoreFactory();
    const result = await factory.open(root);
    expect(result.isOk()).toBe(true);
  });
});
