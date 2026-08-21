import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { createPiCatalogCell } from "../catalog-cell.js";
import type {
  PiConfigLoaderPort,
  PiMaterializerPort,
} from "../config-activator.js";
import {
  createPiConfigRefreshCoordinator,
  type PiConfigRefreshCoordinator,
} from "../config-refresh.js";
import {
  createPiConfigSourceManifest,
  hashConfigSourceContent,
  type PiConfigSourceEntry,
  type PiConfigSourceFsPort,
  type PiConfigSourceManifest,
} from "../config-source-digests.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import { fakeConfigActivator } from "./fakes/fake-pi-host.js";

const PROJECT_ROOT = "/config-refresh-performance";
const GLOBAL_CONFIG = "/config-refresh-performance-home/.weave/config.weave";
const PROJECT_CONFIG = `${PROJECT_ROOT}/.weave/config.weave`;
const FILE_SOURCE_COUNT = 12;
const PROMPT_SOURCE_COUNT = FILE_SOURCE_COUNT - 2;
const DEBOUNCED_BOUNDARY_COUNT = 64;
const WALL_CLOCK_CHECK_COUNT = 1_000;
const WALL_CLOCK_SMOKE_BOUND_MS = 5_000;

interface FakeSourceFile {
  readonly content: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface OperationCounts {
  readonly statCalls: string[];
  readonly readCalls: string[];
  hashCalls: number;
  loaderCalls: number;
  materializerCalls: number;
}

interface PerformanceHarness {
  readonly coordinator: PiConfigRefreshCoordinator;
  readonly manifest: PiConfigSourceManifest;
  readonly counts: OperationCounts;
}

function createSourceManifest(): {
  readonly manifest: PiConfigSourceManifest;
  readonly files: ReadonlyMap<string, FakeSourceFile>;
} {
  const promptFilePaths = Array.from(
    { length: PROMPT_SOURCE_COUNT },
    (_, index) => `${PROJECT_ROOT}/.weave/prompts/source-${index}.md`,
  );
  const emptyManifest = createPiConfigSourceManifest({
    identity: { projectRoot: PROJECT_ROOT, trust: "trusted" },
    globalConfigPath: GLOBAL_CONFIG,
    projectConfigPath: PROJECT_CONFIG,
    promptFilePaths,
  });
  const files = new Map<string, FakeSourceFile>();
  const entries = emptyManifest.files.map(
    (entry, index): PiConfigSourceEntry => {
      const content = `steady-state-source-${index}`;
      const file = {
        content,
        size: content.length,
        mtimeMs: 1_000 + index,
      };
      files.set(entry.path, file);
      return {
        ...entry,
        presence: "present",
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256: hashConfigSourceContent(content),
      };
    },
  );

  return {
    manifest: { ...emptyManifest, files: entries },
    files,
  };
}

async function createPerformanceHarness(
  minIntervalMs: number,
): Promise<PerformanceHarness> {
  const activation = (
    await fakeConfigActivator().activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    })
  )._unsafeUnwrap();
  const { manifest, files } = createSourceManifest();
  const counts: OperationCounts = {
    statCalls: [],
    readCalls: [],
    hashCalls: 0,
    loaderCalls: 0,
    materializerCalls: 0,
  };
  const fs: PiConfigSourceFsPort = {
    statFile: (path) => {
      counts.statCalls.push(path);
      const file = files.get(path);
      return okAsync(
        file === undefined
          ? undefined
          : { size: file.size, mtimeMs: file.mtimeMs },
      );
    },
    readFile: (path) => {
      counts.readCalls.push(path);
      return okAsync(files.get(path)?.content ?? "");
    },
  };
  const configLoader: PiConfigLoaderPort = {
    load: () => {
      counts.loaderCalls += 1;
      return okAsync(activation.config);
    },
  };
  const materializer: PiMaterializerPort = {
    materialize: () => {
      counts.materializerCalls += 1;
      return okAsync(activation.plan);
    },
  };
  const cell = createPiCatalogCell({
    generationId: "performance-generation",
    activation,
    manifest,
    contents: new Map(
      manifest.files.map((entry) => [
        entry.path,
        {
          content: files.get(entry.path)?.content ?? "",
          sha256: entry.sha256 ?? "",
        },
      ]),
    ),
  });
  const coordinator = createPiConfigRefreshCoordinator({
    catalog: cell,
    ownsGeneration: () => true,
    fs,
    onHashComputation: () => {
      counts.hashCalls += 1;
    },
    configLoader,
    materializer,
    primary: () => undefined,
    primaryDisabledSkills: () => [],
    skills: () => new PiSkillCatalog([]),
    clock: { now: () => 0 },
    minIntervalMs,
  });

  return { coordinator, manifest, counts };
}

function expectNoExpensiveOperations(counts: OperationCounts): void {
  expect(counts.readCalls).toEqual([]);
  expect(counts.hashCalls).toBe(0);
  expect(counts.loaderCalls).toBe(0);
  expect(counts.materializerCalls).toBe(0);
}

describe("config refresh steady-state performance", () => {
  it("bounds one unchanged boundary check to one stat per file source", async () => {
    const { coordinator, manifest, counts } = await createPerformanceHarness(0);
    const filePaths = manifest.files.map((source) => source.path);

    const result = await coordinator.ensureFresh();

    expect(result.isOk()).toBe(true);
    expect(manifest.files).toHaveLength(FILE_SOURCE_COUNT);
    // Exact equality proves every file source is statted once and the builtin
    // source, which has no file entry, is never passed to the fs port.
    expect(counts.statCalls).toEqual(filePaths);
    expectNoExpensiveOperations(counts);
  });

  it("coalesces many boundaries inside one injected debounce window", async () => {
    const { coordinator, manifest, counts } =
      await createPerformanceHarness(1_000);

    let completedChecks = 0;
    for (let index = 0; index < DEBOUNCED_BOUNDARY_COUNT; index += 1) {
      if ((await coordinator.ensureFresh()).isOk()) completedChecks += 1;
    }

    expect(completedChecks).toBe(DEBOUNCED_BOUNDARY_COUNT);
    expect(counts.statCalls).toEqual(
      manifest.files.map((source) => source.path),
    );
    expectNoExpensiveOperations(counts);
  });

  it(
    "keeps 1,000 twelve-source fast-path checks inside a loose smoke bound",
    async () => {
      const { coordinator, manifest, counts } =
        await createPerformanceHarness(0);
      let completedChecks = 0;
      const startedAtMs = performance.now();

      for (let index = 0; index < WALL_CLOCK_CHECK_COUNT; index += 1) {
        if ((await coordinator.ensureFresh()).isOk()) completedChecks += 1;
      }

      const elapsedMs = performance.now() - startedAtMs;
      expect(completedChecks).toBe(WALL_CLOCK_CHECK_COUNT);
      expect(counts.statCalls).toHaveLength(
        WALL_CLOCK_CHECK_COUNT * manifest.files.length,
      );
      expectNoExpensiveOperations(counts);
      expect(elapsedMs).toBeLessThan(WALL_CLOCK_SMOKE_BOUND_MS);
    },
    WALL_CLOCK_SMOKE_BOUND_MS * 2,
  );
});
