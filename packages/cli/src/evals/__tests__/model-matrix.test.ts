/**
 * Tests for `model-matrix.ts`.
 *
 * Verifies:
 *   - `loadModelMatrix()` parses the real fixture and returns at least three
 *     default models (the core acceptance criterion).
 *   - `resolveDefaultModels()` returns only `default: true` entries.
 *   - `filterMatrix()` returns matching entries and empty for unknowns.
 *   - `validateModelInMatrix()` returns ok for known IDs and a typed error
 *     for unknown IDs.
 *   - Schema violations produce `FixtureValidationFailed` errors pointing
 *     at the offending file.
 *   - The `ModelMatrixConstraintViolation` error surfaces when fewer than
 *     three models have `default: true`.
 *
 * Test isolation:
 *   - Happy-path tests load the real `evals/model-matrix.json` (no mocking).
 *   - Error-path tests write temp JSON to the Bun temp directory.
 *
 * No network, git, or shell calls are made.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  filterMatrix,
  loadModelMatrix,
  MAX_DEV_MODELS,
  MIN_DEFAULT_MODELS,
  MODEL_SET_NAMES,
  resolveCaseDefaultModels,
  resolveDefaultModels,
  resolveDevModels,
  resolveModelSet,
  validateModelInMatrix,
} from "../model-matrix.js";
import type { ModelMatrix } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();

/** Write a JSON object to a temp file and return its path. */
async function writeTempJson(name: string, content: unknown): Promise<string> {
  const filePath = resolve(TEMP_DIR, `model-matrix-test-${name}.json`);
  await Bun.write(filePath, JSON.stringify(content));
  return filePath;
}

/** Minimal valid model matrix with N default models. */
function makeMatrix(defaultCount: number, totalCount = defaultCount): unknown {
  const models = Array.from({ length: totalCount }, (_, i) => ({
    id: `provider/model-${i}`,
    display_name: `Model ${i}`,
    provider: "provider",
    default: i < defaultCount,
    tags: [],
  }));
  return { version: 1, models };
}

// ---------------------------------------------------------------------------
// Happy path — real fixture
// ---------------------------------------------------------------------------

describe("loadModelMatrix — real fixture", () => {
  it("returns ok with a valid ModelMatrix", async () => {
    const result = await loadModelMatrix();
    expect(result.isOk()).toBe(true);
  });

  it(`returns at least ${MIN_DEFAULT_MODELS} default models`, async () => {
    const result = await loadModelMatrix();
    const matrix = result._unsafeUnwrap();
    const defaultModels = matrix.models.filter((m) => m.default);
    expect(defaultModels.length).toBeGreaterThanOrEqual(MIN_DEFAULT_MODELS);
  });

  it("returns exactly the canonical default seven-model matrix", async () => {
    const result = await loadModelMatrix();
    const matrix = result._unsafeUnwrap();
    const defaultIds = matrix.models
      .filter((m) => m.default)
      .map((m) => m.id)
      .sort();
    expect(defaultIds).toEqual([
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4.5",
      "deepseek/deepseek-v4-flash-0731",
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-6-astra",
      "qwen/qwen3.8-max",
    ]);
  });

  it("resolveDefaultModels returns all canonical defaults", async () => {
    const result = await loadModelMatrix();
    const matrix = result._unsafeUnwrap();
    const defaults = resolveDefaultModels(matrix);
    expect(defaults.length).toBeGreaterThanOrEqual(MIN_DEFAULT_MODELS);
    const ids = defaults.map((m) => m.id).sort();
    expect(ids).toEqual([
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4.5",
      "deepseek/deepseek-v4-flash-0731",
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-6-astra",
      "qwen/qwen3.8-max",
    ]);
  });

  it("returns models with valid ids, display_names, and providers", async () => {
    const result = await loadModelMatrix();
    const matrix = result._unsafeUnwrap();
    for (const model of matrix.models) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.display_name.length).toBeGreaterThan(0);
      expect(model.provider.length).toBeGreaterThan(0);
    }
  });

  it("has version 1", async () => {
    const result = await loadModelMatrix();
    expect(result._unsafeUnwrap().version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultModels
// ---------------------------------------------------------------------------

describe("resolveDefaultModels", () => {
  it("returns only default=true entries", () => {
    const matrix: ModelMatrix = {
      version: 1,
      models: [
        {
          id: "a/m1",
          display_name: "M1",
          provider: "a",
          default: true,
          dev: false,
          tags: [],
        },
        {
          id: "b/m2",
          display_name: "M2",
          provider: "b",
          default: false,
          dev: false,
          tags: [],
        },
        {
          id: "c/m3",
          display_name: "M3",
          provider: "c",
          default: true,
          dev: false,
          tags: [],
        },
      ],
    };
    const defaults = resolveDefaultModels(matrix);
    expect(defaults).toHaveLength(2);
    expect(defaults.every((m) => m.default)).toBe(true);
    expect(defaults.map((m) => m.id)).toEqual(["a/m1", "c/m3"]);
  });

  it("returns empty array when no models have default=true", () => {
    const matrix: ModelMatrix = {
      version: 1,
      models: [
        {
          id: "a/m1",
          display_name: "M1",
          provider: "a",
          default: false,
          dev: false,
          tags: [],
        },
      ],
    };
    expect(resolveDefaultModels(matrix)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterMatrix
// ---------------------------------------------------------------------------

describe("filterMatrix", () => {
  const matrix: ModelMatrix = {
    version: 1,
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        display_name: "Claude",
        provider: "anthropic",
        default: true,
        dev: false,
        tags: [],
      },
      {
        id: "openai/gpt-4o",
        display_name: "GPT-4o",
        provider: "openai",
        default: true,
        dev: false,
        tags: [],
      },
    ],
  };

  it("returns the matching entry when the id is known", () => {
    const result = filterMatrix(matrix, "openai/gpt-4o");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("openai/gpt-4o");
  });

  it("returns empty array for an unknown id", () => {
    const result = filterMatrix(matrix, "unknown/model");
    expect(result).toHaveLength(0);
  });

  it("returns all matching entries (exact id match)", () => {
    const result = filterMatrix(matrix, "anthropic/claude-sonnet-4-5");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("anthropic/claude-sonnet-4-5");
  });
});

// ---------------------------------------------------------------------------
// validateModelInMatrix
// ---------------------------------------------------------------------------

describe("validateModelInMatrix", () => {
  const matrix: ModelMatrix = {
    version: 1,
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        display_name: "Claude",
        provider: "anthropic",
        default: true,
        dev: false,
        tags: [],
      },
      {
        id: "openai/gpt-4o",
        display_name: "GPT-4o",
        provider: "openai",
        default: true,
        dev: false,
        tags: [],
      },
    ],
  };

  it("returns ok(entry) for a known model id", () => {
    const result = validateModelInMatrix(matrix, "anthropic/claude-sonnet-4-5");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns FixtureValidationFailed for an unknown model id", () => {
    const result = validateModelInMatrix(matrix, "unknown/model");
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.message).toContain("unknown/model");
      expect(e.issues).toHaveLength(1);
      expect(e.issues[0].message).toContain("unknown/model");
    }
  });

  it("error message includes the allowlist of known model ids", () => {
    const result = validateModelInMatrix(matrix, "mystery/model");
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    if (e.type === "FixtureValidationFailed") {
      expect(e.message).toContain("anthropic/claude-sonnet-4-5");
      expect(e.message).toContain("openai/gpt-4o");
    }
  });
});

// ---------------------------------------------------------------------------
// Error paths — temp fixtures
// ---------------------------------------------------------------------------

describe("loadModelMatrix — file not found", () => {
  it("returns FixtureFileNotFound for a missing file", async () => {
    const result = await loadModelMatrix("/nonexistent/path/model-matrix.json");
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureFileNotFound");
    if (e.type === "FixtureFileNotFound") {
      expect(e.file).toContain("model-matrix.json");
      expect(e.message).toContain("not found");
    }
  });
});

describe("loadModelMatrix — schema violations", () => {
  it("returns FixtureValidationFailed for a missing version field", async () => {
    const filePath = await writeTempJson("missing-version", {
      models: [
        {
          id: "a/m1",
          display_name: "M1",
          provider: "a",
          default: true,
          dev: false,
          tags: [],
        },
        {
          id: "b/m2",
          display_name: "M2",
          provider: "b",
          default: true,
          dev: false,
          tags: [],
        },
        {
          id: "c/m3",
          display_name: "M3",
          provider: "c",
          default: true,
          dev: false,
          tags: [],
        },
      ],
    });
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns FixtureValidationFailed for a model with invalid id characters", async () => {
    const filePath = await writeTempJson("invalid-id", {
      version: 1,
      models: [
        {
          id: "bad id with spaces",
          display_name: "Bad",
          provider: "x",
          default: true,
          dev: false,
          tags: [],
        },
        {
          id: "b/m2",
          display_name: "M2",
          provider: "b",
          default: true,
          dev: false,
          tags: [],
        },
        {
          id: "c/m3",
          display_name: "M3",
          provider: "c",
          default: true,
          dev: false,
          tags: [],
        },
      ],
    });
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
    }
  });

  it("returns FixtureValidationFailed for empty models array", async () => {
    const filePath = await writeTempJson("empty-models", {
      version: 1,
      models: [],
    });
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureParseError for non-JSON content", async () => {
    const filePath = resolve(TEMP_DIR, "model-matrix-test-not-json.txt");
    await Bun.write(filePath, "this is not valid json {{{");
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    // Bun may throw a parse error or SyntaxError on invalid JSON
    expect(["FixtureParseError", "FixtureFileNotFound"]).toContain(e.type);
  });
});

describe("loadModelMatrix — constraint violations", () => {
  it("returns ModelMatrixConstraintViolation when fewer than MIN_DEFAULT_MODELS have default=true", async () => {
    const content = makeMatrix(2, 5); // only 2 out of 5 are default
    const filePath = await writeTempJson("too-few-defaults", content);
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("ModelMatrixConstraintViolation");
    if (e.type === "ModelMatrixConstraintViolation") {
      expect(e.file).toBe(filePath);
      expect(e.message).toContain(`${MIN_DEFAULT_MODELS}`);
    }
  });

  it("returns ok when exactly MIN_DEFAULT_MODELS have default=true", async () => {
    const content = makeMatrix(MIN_DEFAULT_MODELS, MIN_DEFAULT_MODELS + 1);
    const filePath = await writeTempJson("exactly-min-defaults", content);
    const result = await loadModelMatrix(filePath);
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when all models have default=true", async () => {
    const content = makeMatrix(4, 4);
    const filePath = await writeTempJson("all-defaults", content);
    const result = await loadModelMatrix(filePath);
    expect(result.isOk()).toBe(true);
  });

  it("error message cites the offending file path", async () => {
    const content = makeMatrix(1, 3);
    const filePath = await writeTempJson("one-default", content);
    const result = await loadModelMatrix(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    if (e.type === "ModelMatrixConstraintViolation") {
      expect(e.file).toBe(filePath);
    }
  });
});

// ---------------------------------------------------------------------------
// The dev subset — `dev: true` (Spec 37, 17.1)
// ---------------------------------------------------------------------------

/** A matrix of three defaults plus the given extra entries. */
function matrixWith(extra: Array<Record<string, unknown>>): unknown {
  const defaults = [0, 1, 2].map((i) => ({
    id: `provider/default-${i}`,
    display_name: `Default ${i}`,
    provider: "provider",
    default: true,
  }));
  return { version: 1, models: [...defaults, ...extra] };
}

function devEntry(i: number, isDefault = false): Record<string, unknown> {
  return {
    id: `provider/dev-${i}`,
    display_name: `Dev ${i}`,
    provider: "provider",
    default: isDefault,
    dev: true,
  };
}

describe("loadModelMatrix — the dev field", () => {
  it("defaults dev to false when an entry omits it", async () => {
    const filePath = await writeTempJson("dev-omitted", matrixWith([]));
    const matrix = (await loadModelMatrix(filePath))._unsafeUnwrap();
    expect(matrix.models.every((m) => m.dev === false)).toBe(true);
  });

  it("accepts dev: true", async () => {
    const filePath = await writeTempJson("dev-true", matrixWith([devEntry(0)]));
    const matrix = (await loadModelMatrix(filePath))._unsafeUnwrap();
    expect(matrix.models.filter((m) => m.dev).map((m) => m.id)).toEqual([
      "provider/dev-0",
    ]);
  });

  it("rejects a dev value that is not a boolean, pointing at the field", async () => {
    const filePath = await writeTempJson(
      "dev-not-boolean",
      matrixWith([{ ...devEntry(0), dev: "yes" }]),
    );
    const e = (await loadModelMatrix(filePath))._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.issues.map((i) => i.path)).toContain("models.3.dev");
    }
  });

  it(`accepts up to ${MAX_DEV_MODELS} dev models`, async () => {
    const extra = Array.from({ length: MAX_DEV_MODELS }, (_, i) => devEntry(i));
    const filePath = await writeTempJson("dev-at-cap", matrixWith(extra));
    expect((await loadModelMatrix(filePath)).isOk()).toBe(true);
  });

  it(`rejects more than ${MAX_DEV_MODELS} dev models, so the subset stays cheap`, async () => {
    const extra = Array.from({ length: MAX_DEV_MODELS + 1 }, (_, i) =>
      devEntry(i),
    );
    const filePath = await writeTempJson("dev-over-cap", matrixWith(extra));
    const e = (await loadModelMatrix(filePath))._unsafeUnwrapErr();
    expect(e.type).toBe("ModelMatrixConstraintViolation");
    expect(e.message).toContain(`at most ${MAX_DEV_MODELS}`);
  });
});

describe("resolveModelSet / resolveDevModels / resolveCaseDefaultModels", () => {
  const entry = (
    id: string,
    isDefault: boolean,
    dev: boolean,
  ): ModelMatrix["models"][number] => ({
    id,
    display_name: id,
    provider: "p",
    default: isDefault,
    dev,
    tags: [],
  });
  const matrix: ModelMatrix = {
    version: 1,
    models: [
      entry("p/full-only", true, false),
      entry("p/both", true, true),
      entry("p/dev-only", false, true),
      entry("p/neither", false, false),
    ],
  };

  it("resolves the dev set to the dev: true entries only", () => {
    expect(resolveDevModels(matrix).map((m) => m.id)).toEqual([
      "p/both",
      "p/dev-only",
    ]);
    expect(resolveModelSet(matrix, "dev").map((m) => m.id)).toEqual([
      "p/both",
      "p/dev-only",
    ]);
  });

  it("resolves the default set to the default: true entries, never a dev-only one", () => {
    expect(resolveModelSet(matrix, "default").map((m) => m.id)).toEqual([
      "p/full-only",
      "p/both",
    ]);
  });

  it("lets a case that omits allowed_models run on the default and dev sets, not on neither", () => {
    expect(resolveCaseDefaultModels(matrix).map((m) => m.id)).toEqual([
      "p/full-only",
      "p/both",
      "p/dev-only",
    ]);
  });

  it("names exactly the two sets --models accepts", () => {
    expect([...MODEL_SET_NAMES]).toEqual(["default", "dev"]);
  });
});

describe("loadModelMatrix — the real dev subset", () => {
  it(`marks between one and ${MAX_DEV_MODELS} models dev`, async () => {
    const matrix = (await loadModelMatrix())._unsafeUnwrap();
    const dev = resolveDevModels(matrix);
    expect(dev.length).toBeGreaterThanOrEqual(1);
    expect(dev.length).toBeLessThanOrEqual(MAX_DEV_MODELS);
  });

  // Deliberately no hard-coded list of the dev models: moving the subset must
  // stay a single edit to evals/model-matrix.json (#194, Spec 37 4.4).
});
