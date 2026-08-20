import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_PR_MARKER_REF } from "../constants.js";
import {
  CREATION_CLEANUP_TABLE,
  RELEASE_STATE_DB_ENV,
  readDurableCreationCleanup,
  releaseStateDatabasePath,
} from "../doctor-creation-cleanup.js";

const OWNER = "c".repeat(64);
const MARKER = "a".repeat(40);
const BASE = "b".repeat(40);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function makeDatabase(
  rows: readonly Record<string, unknown>[],
  options: { readonly schema?: string } = {},
): string {
  const directory = mkdtempSync(join(tmpdir(), "weave-release-state-"));
  directories.push(directory);
  const path = join(directory, "release-state.sqlite");
  const database = new Database(path, { create: true });
  database.run(
    options.schema ??
      `CREATE TABLE ${CREATION_CLEANUP_TABLE} (
         ref TEXT NOT NULL,
         owner_generation TEXT NOT NULL,
         expected_marker_sha TEXT NOT NULL,
         planned_base_sha TEXT NOT NULL,
         pull_request_number INTEGER,
         resolved_at TEXT
       )`,
  );
  for (const row of rows)
    database
      .query(
        `INSERT INTO ${CREATION_CLEANUP_TABLE}
         (ref, owner_generation, expected_marker_sha, planned_base_sha, pull_request_number, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ref as string,
        row.owner_generation as string,
        row.expected_marker_sha as string,
        row.planned_base_sha as string,
        (row.pull_request_number ?? null) as number | null,
        (row.resolved_at ?? null) as string | null,
      );
  database.close(false);
  return path;
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    ref: RELEASE_PR_MARKER_REF,
    owner_generation: OWNER,
    expected_marker_sha: MARKER,
    planned_base_sha: BASE,
    pull_request_number: null,
    resolved_at: null,
    ...overrides,
  };
}

describe("durable creation-cleanup store location", () => {
  it("prefers an explicit database and otherwise uses Weave's data directory", () => {
    const explicit = releaseStateDatabasePath({
      [RELEASE_STATE_DB_ENV]: "/tmp/explicit.sqlite",
    });
    expect(explicit).toEqual({ path: "/tmp/explicit.sqlite", explicit: true });

    const xdg = releaseStateDatabasePath({ XDG_DATA_HOME: "/data" });
    expect(xdg).toEqual({
      path: "/data/weave/release-state.sqlite",
      explicit: false,
    });

    const fallback = releaseStateDatabasePath({});
    expect(fallback.explicit).toBe(false);
    expect(fallback.path).toContain(
      join(".local", "share", "weave", "release-state.sqlite"),
    );
  });
});

describe("durable creation-cleanup reader", () => {
  it("returns the single pending record bound to its generation and pull request", async () => {
    const path = makeDatabase([pendingRow({ pull_request_number: 41 })]);
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: path,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value).toEqual({
        ownership: {
          ref: RELEASE_PR_MARKER_REF,
          ownerGeneration: OWNER,
          expectedMarkerSha: MARKER,
          plannedBaseSha: BASE,
        },
        pullRequestNumber: 41,
      });
  });

  it("ignores resolved records and records for another ref", async () => {
    const path = makeDatabase([
      pendingRow({ resolved_at: "2026-08-19T00:00:00.000Z" }),
      pendingRow({ ref: "release-pr/other" }),
    ]);
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: path,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBeNull();
  });

  it("fails closed on more than one pending record", async () => {
    const path = makeDatabase([pendingRow(), pendingRow()]);
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: path,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain(
        "pending creation-cleanup records",
      );
  });

  it("fails closed on a malformed identity", async () => {
    for (const overrides of [
      { owner_generation: "short" },
      { expected_marker_sha: "not-a-sha" },
      { planned_base_sha: "" },
    ]) {
      const path = makeDatabase([pendingRow(overrides)]);
      const result = await readDurableCreationCleanup({
        [RELEASE_STATE_DB_ENV]: path,
      });
      expect(result.isErr(), JSON.stringify(overrides)).toBe(true);
      if (result.isErr())
        expect(result.error.message).toContain(
          "invalid creation-cleanup identity",
        );
    }
  });

  it("fails closed on a malformed pull request number", async () => {
    const path = makeDatabase([pendingRow({ pull_request_number: -3 })]);
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: path,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain(
        "invalid creation-cleanup pull request number",
      );
  });

  it("fails closed when the table is missing", async () => {
    const path = makeDatabase([], {
      schema: "CREATE TABLE unrelated (id INTEGER)",
    });
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: path,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain(
        `no readable ${CREATION_CLEANUP_TABLE}`,
      );
  });

  it("fails closed when an explicitly configured database does not exist", async () => {
    const result = await readDurableCreationCleanup({
      [RELEASE_STATE_DB_ENV]: "/tmp/weave-release-state-missing.sqlite",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain("which does not exist");
  });

  it("treats an unconfigured, absent default store as empty", async () => {
    const directory = mkdtempSync(join(tmpdir(), "weave-release-home-"));
    directories.push(directory);
    const result = await readDurableCreationCleanup({
      XDG_DATA_HOME: directory,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBeNull();
  });

  it("never writes to the store it reads", async () => {
    const path = makeDatabase([pendingRow()]);
    await readDurableCreationCleanup({ [RELEASE_STATE_DB_ENV]: path });
    const database = new Database(path, { readonly: true });
    const rows = database
      .query(`SELECT COUNT(*) AS total FROM ${CREATION_CLEANUP_TABLE}`)
      .all() as { total: number }[];
    database.close(false);
    expect(rows[0]?.total).toBe(1);
  });
});
