/**
 * Unit tests for `skill-discovery.ts`.
 *
 * Verifies the corrected architecture: skill discovery is harness-owned.
 * The adapter receives a harness-provided `SkillInfo[]` list and validates
 * declared skill names against it. No filesystem scanning is performed.
 *
 * Verifies:
 * - `buildSkillInfoList()` constructs `SkillInfo[]` from a list of names.
 * - `validateDeclaredSkills()` returns ok when all declared skills are present.
 * - `validateDeclaredSkills()` returns err with missing skill names when any
 *   declared skill is absent from the available list.
 * - `validateDeclaredSkills()` silently skips disabled skills.
 * - `validateDeclaredSkills()` returns ok for an empty declared list.
 * - Missing declared skills surface as hard errors (not silent skips).
 *
 * ## Architecture note
 *
 * The previous implementation of `skill-discovery.ts` scanned the filesystem
 * for `.md` files in `.weave/skills/` and `.agents/skills/` directories. This
 * violated the adapter/harness boundary: skill discovery is harness-owned, not
 * adapter-owned. The corrected implementation accepts harness-provided skill
 * data and validates it — no filesystem scanning.
 *
 * The `OpenCodeAdapter` accepts harness-provided skills via
 * `OpenCodeAdapterOptions.availableSkills` and forwards them to the engine via
 * `loadAvailableSkills()`. Tests for that injection path live in
 * `adapter.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  buildSkillInfoList,
  validateDeclaredSkills,
} from "../skill-discovery.js";

// ---------------------------------------------------------------------------
// Tests: buildSkillInfoList
// ---------------------------------------------------------------------------

describe("buildSkillInfoList", () => {
  it("returns an empty array for an empty input", () => {
    const result = buildSkillInfoList([]);
    expect(result).toEqual([]);
  });

  it("returns SkillInfo[] with the correct names", () => {
    const result = buildSkillInfoList(["tdd", "code-review", "security"]);
    expect(result).toHaveLength(3);
    expect(result[0]?.name).toBe("tdd");
    expect(result[1]?.name).toBe("code-review");
    expect(result[2]?.name).toBe("security");
  });

  it("each entry has no metadata (pure name list)", () => {
    const result = buildSkillInfoList(["tdd"]);
    expect(result[0]?.metadata).toBeUndefined();
  });

  it("preserves order", () => {
    const names = ["z-skill", "a-skill", "m-skill"];
    const result = buildSkillInfoList(names);
    expect(result.map((s) => s.name)).toEqual(names);
  });

  it("accepts harness-provided skill names and wraps them as SkillInfo", () => {
    // Simulates a harness SDK returning skill names as strings
    const harnessSkillNames = ["tdd", "code-review", "security-audit"];
    const result = buildSkillInfoList(harnessSkillNames);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual(harnessSkillNames);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateDeclaredSkills — success cases
// ---------------------------------------------------------------------------

describe("validateDeclaredSkills — success cases", () => {
  it("returns ok when declared skills list is empty", () => {
    const available = buildSkillInfoList(["tdd", "code-review"]);
    const result = validateDeclaredSkills([], available);
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when all declared skills are available", () => {
    const available = buildSkillInfoList(["tdd", "code-review", "security"]);
    const result = validateDeclaredSkills(["tdd", "code-review"], available);
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when declared skills exactly match available skills", () => {
    const available = buildSkillInfoList(["tdd", "code-review"]);
    const result = validateDeclaredSkills(["tdd", "code-review"], available);
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when available list is a superset of declared skills", () => {
    const available = buildSkillInfoList([
      "tdd",
      "code-review",
      "security",
      "perf",
    ]);
    const result = validateDeclaredSkills(["tdd", "security"], available);
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when harness provides all declared skills", () => {
    // Simulates: harness SDK returns ["tdd", "code-review"] → adapter builds
    // SkillInfo[] → validateDeclaredSkills confirms all declared skills present
    const harnessProvided = buildSkillInfoList(["tdd", "code-review"]);
    const result = validateDeclaredSkills(["tdd"], harnessProvided);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateDeclaredSkills — missing skill hard errors
// ---------------------------------------------------------------------------

describe("validateDeclaredSkills — missing skill hard errors", () => {
  it("returns err when a declared skill is not in the available list", () => {
    const available = buildSkillInfoList(["tdd"]);
    const result = validateDeclaredSkills(["tdd", "missing-skill"], available);
    expect(result.isErr()).toBe(true);
  });

  it("err contains the missing skill name", () => {
    const available = buildSkillInfoList(["tdd"]);
    const result = validateDeclaredSkills(["missing-skill"], available);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("missing-skill");
    }
  });

  it("err contains all missing skill names when multiple are missing", () => {
    const available = buildSkillInfoList(["tdd"]);
    const result = validateDeclaredSkills(
      ["missing-a", "tdd", "missing-b"],
      available,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("missing-a");
      expect(result.error).toContain("missing-b");
      // "tdd" is present — should not be in the error list
      expect(result.error).not.toContain("tdd");
    }
  });

  it("returns err when available list is empty and skills are declared", () => {
    const result = validateDeclaredSkills(["tdd"], []);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("tdd");
    }
  });

  it("missing skill error is an array of strings (not a single string)", () => {
    const available = buildSkillInfoList([]);
    const result = validateDeclaredSkills(["skill-a", "skill-b"], available);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(Array.isArray(result.error)).toBe(true);
      expect(result.error).toHaveLength(2);
    }
  });

  it("hard error when harness provides no skills but agent declares some", () => {
    // Simulates: harness SDK returns empty list → adapter has no skills →
    // declared skills cannot be resolved → hard error (not silent skip)
    const harnessProvided = buildSkillInfoList([]);
    const result = validateDeclaredSkills(["tdd"], harnessProvided);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("tdd");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: validateDeclaredSkills — disabled skills are silently skipped
// ---------------------------------------------------------------------------

describe("validateDeclaredSkills — disabled skills", () => {
  it("silently skips disabled skills even when they are not available", () => {
    const available = buildSkillInfoList(["tdd"]);
    // "disabled-skill" is declared but disabled — should not cause an error
    const result = validateDeclaredSkills(
      ["tdd", "disabled-skill"],
      available,
      ["disabled-skill"],
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns ok when all declared skills are disabled", () => {
    const available = buildSkillInfoList([]);
    const result = validateDeclaredSkills(["skill-a", "skill-b"], available, [
      "skill-a",
      "skill-b",
    ]);
    expect(result.isOk()).toBe(true);
  });

  it("still errors on non-disabled missing skills when some are disabled", () => {
    const available = buildSkillInfoList(["tdd"]);
    const result = validateDeclaredSkills(
      ["tdd", "disabled-skill", "missing-skill"],
      available,
      ["disabled-skill"],
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("missing-skill");
      expect(result.error).not.toContain("disabled-skill");
    }
  });

  it("uses empty array as default for disabledSkills", () => {
    const available = buildSkillInfoList(["tdd"]);
    // No disabledSkills argument — should behave as if empty
    const result = validateDeclaredSkills(["missing-skill"], available);
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: hard-error semantics (integration with validateDeclaredSkills)
// ---------------------------------------------------------------------------

describe("skill validation — hard-error semantics", () => {
  it("missing declared skill surfaces as a hard error (not silent skip)", () => {
    // Simulate: agent declares "tdd" but harness only provides "code-review"
    const harnessProvided = buildSkillInfoList(["code-review"]);
    const result = validateDeclaredSkills(["tdd"], harnessProvided);

    // Hard error — not ok, not silently skipped
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("tdd");
    }
  });

  it("all declared skills present → no error", () => {
    const harnessProvided = buildSkillInfoList(["tdd", "code-review"]);
    const result = validateDeclaredSkills(["tdd"], harnessProvided);
    expect(result.isOk()).toBe(true);
  });

  it("empty declared skills → no error even with empty harness list", () => {
    const result = validateDeclaredSkills([], []);
    expect(result.isOk()).toBe(true);
  });

  it("harness-provided SkillInfo with metadata passes through name matching", () => {
    // Simulates harness providing rich SkillInfo with metadata
    const harnessProvided = [
      { name: "tdd", metadata: { source: "harness", path: "/skills/tdd.md" } },
      { name: "code-review", metadata: { source: "harness" } },
    ];
    const result = validateDeclaredSkills(
      ["tdd", "code-review"],
      harnessProvided,
    );
    expect(result.isOk()).toBe(true);
  });
});
