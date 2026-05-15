/**
 * Type-focused tests for the public skill-resolution types (Spec 09, Unit 1).
 *
 * These tests prove:
 * - `SkillInfo.name` is the only engine-owned matching key.
 * - Adapter-owned metadata is preserved in `ResolvedSkill` without engine inspection.
 * - `SkillResolutionError` carries `type`, `agentName`, and `skillName` only.
 * - `resolveSkillsForAgent` is importable and returns the correct `Result` shape.
 *
 * No harness-specific paths, file reads, or process-spawning are used.
 */

import { describe, expect, it } from "bun:test";
import type { Result } from "neverthrow";
import type {
  ResolvedSkill,
  SkillInfo,
  SkillResolutionError,
  SkillResolutionInput,
} from "../skill-resolution.js";
import { resolveSkillsForAgent } from "../skill-resolution.js";

// ---------------------------------------------------------------------------
// Type-level helpers — prove the shape at compile time
// ---------------------------------------------------------------------------

/**
 * Compile-time assertion: `SkillInfo` requires only `name`.
 * If this compiles, the engine does not mandate any harness-specific fields.
 */
const _minimalSkillInfo: SkillInfo = { name: "tdd" };
void _minimalSkillInfo;

/**
 * Compile-time assertion: `SkillInfo.metadata` accepts arbitrary adapter data.
 * The engine types it as `unknown` so adapters can store anything without
 * the engine needing to inspect or validate it.
 */
const _skillInfoWithMetadata: SkillInfo = {
  name: "code-review",
  metadata: {
    path: "/home/user/.weave/skills/code-review.md",
    scope: "global",
    content: "# Code Review\n...",
    harnessSpecific: { opencode: { toolName: "code-review" } },
  },
};
void _skillInfoWithMetadata;

/**
 * Compile-time assertion: `ResolvedSkill` exposes `name` and `skillInfo`.
 * The engine never adds harness-specific fields to this type.
 */
const _resolvedSkill: ResolvedSkill = {
  name: "tdd",
  skillInfo: { name: "tdd" },
};
void _resolvedSkill;

/**
 * Compile-time assertion: `SkillResolutionError` is a discriminated union
 * with `type: "MissingSkill"`, `agentName`, and `skillName`.
 */
const _missingSkillError: SkillResolutionError = {
  type: "MissingSkill",
  agentName: "loom",
  skillName: "unknown-skill",
};
void _missingSkillError;

/**
 * Compile-time assertion: `resolveSkillsForAgent` returns a `Result`.
 * The return type is assignable to `Result<ResolvedSkill[], SkillResolutionError[]>`.
 */
const _resultType: Result<ResolvedSkill[], SkillResolutionError[]> =
  resolveSkillsForAgent({
    agentName: "loom",
    availableSkills: [],
  });
void _resultType;

// ---------------------------------------------------------------------------
// Runtime tests — prove behaviour without harness discovery
// ---------------------------------------------------------------------------

describe("SkillInfo — adapter metadata pass-through", () => {
  it("(a) SkillInfo with only name is valid", () => {
    const skill: SkillInfo = { name: "tdd" };
    expect(skill.name).toBe("tdd");
    expect(skill.metadata).toBeUndefined();
  });

  it("(b) SkillInfo preserves arbitrary adapter metadata without engine inspection", () => {
    const adapterMetadata = {
      path: "/adapters/opencode/skills/tdd.md",
      scope: "project",
      mountPoint: "opencode://skills/tdd",
      apiKey: "should-not-be-read-by-engine",
    };

    const skill: SkillInfo = { name: "tdd", metadata: adapterMetadata };

    // Engine only uses `name` — metadata is opaque pass-through
    expect(skill.name).toBe("tdd");
    // The metadata reference is preserved exactly as provided
    expect(skill.metadata).toBe(adapterMetadata);
  });

  it("(c) SkillInfo metadata can be any shape — string, number, object, array", () => {
    const stringMeta: SkillInfo = { name: "a", metadata: "some-path" };
    const numberMeta: SkillInfo = { name: "b", metadata: 42 };
    const arrayMeta: SkillInfo = { name: "c", metadata: ["x", "y"] };
    const nullMeta: SkillInfo = { name: "d", metadata: null };

    expect(stringMeta.metadata).toBe("some-path");
    expect(numberMeta.metadata).toBe(42);
    expect(arrayMeta.metadata).toEqual(["x", "y"]);
    expect(nullMeta.metadata).toBeNull();
  });
});

describe("ResolvedSkill — adapter metadata preserved", () => {
  it("(a) ResolvedSkill carries the original SkillInfo reference", () => {
    const skillInfo: SkillInfo = {
      name: "tdd",
      metadata: { path: "/skills/tdd.md", scope: "global" },
    };

    const input: SkillResolutionInput = {
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [skillInfo],
    };

    const result = resolveSkillsForAgent(input);

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("tdd");
    // The original SkillInfo reference is preserved — engine did not copy or transform it
    expect(resolved[0]!.skillInfo).toBe(skillInfo);
  });

  it("(b) adapter metadata is accessible from ResolvedSkill without engine inspection", () => {
    const harnessData = {
      opencodePath: "/home/user/.config/opencode/skills/code-review.md",
      piMountPoint: "pi://skills/code-review",
      claudeCodeTool: "code-review",
    };

    const skillInfo: SkillInfo = { name: "code-review", metadata: harnessData };

    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["code-review"],
      availableSkills: [skillInfo],
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    // Adapter can recover its own metadata from the resolved skill
    expect(resolved[0]!.skillInfo.metadata).toBe(harnessData);
  });
});

describe("resolveSkillsForAgent — type-level result shape", () => {
  it("(a) returns ok([]) when agentSkills is undefined", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      availableSkills: [{ name: "tdd" }],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("(b) returns ok([]) when agentSkills is empty", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: [],
      availableSkills: [{ name: "tdd" }],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("(c) returns ok with resolved skill when name matches", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [{ name: "tdd" }],
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("tdd");
  });

  it("(d) returns err with MissingSkill when skill is not available", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["unknown-skill"],
      availableSkills: [],
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("MissingSkill");
    expect(errors[0]!.agentName).toBe("loom");
    expect(errors[0]!.skillName).toBe("unknown-skill");
  });

  it("(e) disabled skill is filtered without error — no MissingSkill emitted", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [],
      disabledSkills: ["tdd"],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("(f) SkillResolutionError contains only type, agentName, skillName — no paths or secrets", () => {
    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["missing-skill"],
      availableSkills: [],
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    const error = errors[0]!;

    // Only these three fields — no file paths, no content, no harness details
    expect(Object.keys(error).sort()).toEqual([
      "agentName",
      "skillName",
      "type",
    ]);
    expect(error.type).toBe("MissingSkill");
    expect(error.agentName).toBe("shuttle");
    expect(error.skillName).toBe("missing-skill");
  });
});

describe("resolveSkillsForAgent — name is the only matching key", () => {
  it("(a) matching is by exact name — metadata fields are never used for matching", () => {
    const skillWithRichMetadata: SkillInfo = {
      name: "tdd",
      metadata: {
        // These fields exist but the engine must not use them for matching
        alias: "test-driven-development",
        tags: ["testing", "quality"],
        path: "/skills/tdd.md",
      },
    };

    // Request by name only — engine matches on name, not metadata
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [skillWithRichMetadata],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0]!.name).toBe("tdd");
  });

  it("(b) two skills with different names are matched independently", () => {
    const available: SkillInfo[] = [
      { name: "tdd", metadata: { scope: "global" } },
      { name: "code-review", metadata: { scope: "project" } },
    ];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "code-review"],
      availableSkills: available,
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.name).toBe("tdd");
    expect(resolved[1]!.name).toBe("code-review");
  });

  it("(c) name match is case-sensitive — 'TDD' does not match 'tdd'", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["TDD"],
      availableSkills: [{ name: "tdd" }],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()[0]!.skillName).toBe("TDD");
  });
});

// ---------------------------------------------------------------------------
// Focused resolution tests — required by Spec 09 Task 2 acceptance criteria
// ---------------------------------------------------------------------------

describe("resolveSkillsForAgent — available skill resolution", () => {
  it("resolves a single available skill by exact name", () => {
    const available: SkillInfo[] = [{ name: "tdd" }, { name: "code-review" }];

    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["tdd"],
      availableSkills: available,
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("tdd");
    expect(resolved[0]!.skillInfo).toBe(available[0]);
  });

  it("resolves multiple available skills in a single call", () => {
    const available: SkillInfo[] = [
      { name: "tdd" },
      { name: "code-review" },
      { name: "security-audit" },
    ];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "security-audit"],
      availableSkills: available,
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved).toHaveLength(2);
    expect(resolved.map((r) => r.name)).toEqual(["tdd", "security-audit"]);
  });

  it("preserves the original SkillInfo reference in each ResolvedSkill", () => {
    const tddInfo: SkillInfo = { name: "tdd", metadata: { scope: "global" } };
    const reviewInfo: SkillInfo = {
      name: "code-review",
      metadata: { scope: "project" },
    };

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "code-review"],
      availableSkills: [tddInfo, reviewInfo],
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved[0]!.skillInfo).toBe(tddInfo);
    expect(resolved[1]!.skillInfo).toBe(reviewInfo);
  });
});

describe("resolveSkillsForAgent — declaration order preserved", () => {
  it("returns resolved skills in the order they appear in agentSkills", () => {
    // availableSkills is in reverse order — result must follow agentSkills order
    const available: SkillInfo[] = [
      { name: "security-audit" },
      { name: "code-review" },
      { name: "tdd" },
    ];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "code-review", "security-audit"],
      availableSkills: available,
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved.map((r) => r.name)).toEqual([
      "tdd",
      "code-review",
      "security-audit",
    ]);
  });

  it("declaration order is preserved even when availableSkills has duplicates", () => {
    // Duplicate entries in availableSkills — order from agentSkills is what matters
    const available: SkillInfo[] = [
      { name: "tdd", metadata: { version: 1 } },
      { name: "code-review" },
      { name: "tdd", metadata: { version: 2 } }, // duplicate — should not affect agentSkills order
    ];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["code-review", "tdd"],
      availableSkills: available,
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    // Order follows agentSkills: code-review first, then tdd
    expect(resolved[0]!.name).toBe("code-review");
    expect(resolved[1]!.name).toBe("tdd");
    // tdd is resolved — declaration order is what the spec guarantees
    expect(resolved[1]!.skillInfo.name).toBe("tdd");
  });

  it("disabled skills are removed without shifting the order of remaining skills", () => {
    const available: SkillInfo[] = [
      { name: "tdd" },
      { name: "code-review" },
      { name: "security-audit" },
    ];

    // code-review is disabled — tdd and security-audit should remain in order
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "code-review", "security-audit"],
      availableSkills: available,
      disabledSkills: ["code-review"],
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved.map((r) => r.name)).toEqual(["tdd", "security-audit"]);
  });
});

describe("resolveSkillsForAgent — disabled-skill filtering", () => {
  it("filters a disabled skill silently — no MissingSkill error emitted", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [], // tdd not available, but it's disabled
      disabledSkills: ["tdd"],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("filters multiple disabled skills, resolves remaining available skills", () => {
    const available: SkillInfo[] = [
      { name: "tdd" },
      { name: "security-audit" },
    ];

    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["tdd", "code-review", "security-audit"],
      availableSkills: available,
      disabledSkills: ["code-review"],
    });

    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved.map((r) => r.name)).toEqual(["tdd", "security-audit"]);
  });

  it("disabled skill that is also available is still filtered — disabled takes precedence", () => {
    const available: SkillInfo[] = [{ name: "tdd" }];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: available,
      disabledSkills: ["tdd"], // disabled even though available
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("disabledSkills undefined behaves the same as empty array", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd"],
      availableSkills: [{ name: "tdd" }],
      // disabledSkills omitted
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });
});

describe("resolveSkillsForAgent — no-skills input", () => {
  it("returns ok([]) when agentSkills is undefined", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      availableSkills: [{ name: "tdd" }],
      // agentSkills omitted
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("returns ok([]) when agentSkills is an empty array", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: [],
      availableSkills: [{ name: "tdd" }],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("returns ok([]) when agentSkills is undefined and availableSkills is also empty", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      availableSkills: [],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });
});

describe("resolveSkillsForAgent — missing non-disabled skill errors", () => {
  it("returns err with MissingSkill for a skill not in availableSkills", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["unknown-skill"],
      availableSkills: [],
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("MissingSkill");
    expect(errors[0]!.agentName).toBe("loom");
    expect(errors[0]!.skillName).toBe("unknown-skill");
  });

  it("collects multiple MissingSkill errors in a single err result", () => {
    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["missing-a", "missing-b", "missing-c"],
      availableSkills: [],
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.skillName)).toEqual([
      "missing-a",
      "missing-b",
      "missing-c",
    ]);
    for (const error of errors) {
      expect(error.type).toBe("MissingSkill");
      expect(error.agentName).toBe("shuttle");
    }
  });

  it("returns err only for missing non-disabled skills — disabled missing skills are not errors", () => {
    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["missing-disabled", "missing-active"],
      availableSkills: [],
      disabledSkills: ["missing-disabled"],
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    // Only missing-active should produce an error; missing-disabled is silently filtered
    expect(errors).toHaveLength(1);
    expect(errors[0]!.skillName).toBe("missing-active");
  });

  it("MissingSkill error contains exactly type, agentName, skillName — no extra fields", () => {
    const result = resolveSkillsForAgent({
      agentName: "tapestry",
      agentSkills: ["ghost-skill"],
      availableSkills: [],
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr()[0]!;
    expect(Object.keys(error).sort()).toEqual([
      "agentName",
      "skillName",
      "type",
    ]);
    expect(error.type).toBe("MissingSkill");
    expect(error.agentName).toBe("tapestry");
    expect(error.skillName).toBe("ghost-skill");
  });

  it("mixed scenario: some available, some missing — returns err for missing only", () => {
    const available: SkillInfo[] = [{ name: "tdd" }, { name: "code-review" }];

    const result = resolveSkillsForAgent({
      agentName: "loom",
      agentSkills: ["tdd", "ghost-skill", "code-review", "another-ghost"],
      availableSkills: available,
    });

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.skillName)).toEqual([
      "ghost-skill",
      "another-ghost",
    ]);
  });
});
