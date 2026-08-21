/**
 * The explicit legacy denylist for the Task 35 cutover.
 *
 * Test-only support data. It is the single source of truth for what the
 * cutover removed, so a guard test and the removal test can never drift.
 *
 * Two rules follow from it:
 *
 * - No denylisted path may exist, and none may appear in the entrypoint
 *   inventory.
 * - No source file may reference a denylisted identifier, except the files in
 *   {@link LEGACY_SCAN_ALLOWLIST}, each of which states why it still has to
 *   name the retired system.
 *
 * Deliberately outside the denylist: the new `scripts/release/release-refs.ts`
 * from Task 12 and generic `release-refs` naming. Only the enumerated legacy
 * paths and symbols go.
 */

/** Legacy modules, entrypoints, and workflows deleted at cutover. */
export const LEGACY_DENYLIST_PATHS = [
  ".github/workflows/publish.yml",
  "scripts/build-release-control.ts",
  "scripts/release/clean-room.ts",
  "scripts/release/control-main.ts",
  "scripts/release/dry-run-nightly.ts",
  "scripts/release/dry-run-stable.ts",
  "scripts/release/metadata-replay-main.ts",
  "scripts/release/metadata-replay.ts",
  "scripts/release/nightly-plan.ts",
  "scripts/release/promotion-commands.ts",
  "scripts/release/release-orchestrator.ts",
  "scripts/release/legacy-preflight.ts",
  "scripts/release/__tests__/legacy-preflight.test.ts",
  "scripts/release/release-refs-main.ts",
  "scripts/release/stable-finalize.ts",
  "scripts/release/stable-lineage.ts",
  "scripts/release/stable-plan-main.ts",
  "scripts/release/stable-train.ts",
] as const;

/**
 * Named legacy identifiers. `release-refs-main` is denylisted; the generic
 * `release-refs` stem is not.
 */
export const LEGACY_DENYLIST_IDENTIFIERS = [
  "stable-train",
  "metadata-replay",
  "dist-tag add",
  "promotion-commands",
  "release-refs-main",
  "legacy-preflight",
  "legacy-publisher-preflight",
  "LEGACY_PREFLIGHT_RUN_NAME",
  "LegacyPublisherPreflight",
  "STABLE_TRAIN_STATES",
  "STABLE_TRAIN_TRANSITIONS",
] as const;

/** New-pipeline entrypoints the cutover must positively retain. */
export const RETAINED_PIPELINE_PATHS = [
  "scripts/release/release-refs.ts",
  "scripts/release/publish-main.ts",
  "scripts/release/release-route-main.ts",
  "scripts/release/rollout-gate.ts",
  "scripts/release/rollout-stage.ts",
  "scripts/release/next-main.ts",
  "scripts/release/nightly-main.ts",
  "scripts/release/resume-main.ts",
  "scripts/release/incident-main.ts",
  "scripts/release/build-bind-main.ts",
  "scripts/release/await-attest-main.ts",
  "scripts/release/consumer-proof-main.ts",
  "scripts/release/harness-proof-main.ts",
  "scripts/release/registry-verify-main.ts",
  "scripts/release/refs-cleanup-main.ts",
  "scripts/release/publish-reachability.ts",
  "scripts/release/doctor.ts",
  ".github/workflows/release-publish.yml",
  ".github/workflows/release-attest.yml",
  ".github/workflows/release-stable-prepare.yml",
  ".github/workflows/release-stable-regenerate.yml",
] as const;

/**
 * Files that may still name a retired identifier, each with the reason. The
 * removal test proves this list is minimal: an entry that no longer contains a
 * denylisted identifier fails, so the allowlist cannot rot into a blanket
 * exemption.
 */
export const LEGACY_SCAN_ALLOWLIST: readonly {
  readonly path: string;
  readonly reason: string;
}[] = [
  {
    path: "docs/release-automation.md",
    reason:
      "Its History section names the retired system so readers can find the superseded design in Git history. Prose only; it documents no live path.",
  },
  {
    path: "scripts/release/doctor.ts",
    reason:
      "The documented Git revert rollback restores the old workflow and trust identity, and --pre-cutover verifies the restored scheduled publisher.",
  },
];

/** Historical records keep their original wording. */
export const LEGACY_SCAN_ALLOWED_PREFIXES = ["docs/adr/"] as const;

/** Files that define or drive the denylist itself. */
export const LEGACY_SCAN_SELF_PATHS = [
  "scripts/release/__tests__/legacy-denylist.ts",
  "scripts/release/__tests__/removed-paths.test.ts",
] as const;
