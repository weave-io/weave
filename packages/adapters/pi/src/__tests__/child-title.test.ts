import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import {
  createPiAdapterCommandHandlers,
  PI_ADAPTER_COMMAND_NAMES,
  type PiAdapterChildListItem,
  type PiAdapterChildrenPort,
} from "../adapter-cli-commands.js";
import {
  type PiDoctorCheckPorts,
  passedDoctorCheck,
  runChildDoctor,
} from "../child-doctor.js";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
  openPiChildMetadataCache,
} from "../child-metadata-cache.js";
import {
  buildChildPickerMetadataEntries,
  type PiChildPickerCandidate,
  resolveChildPickerTitle,
} from "../child-picker.js";
import {
  describeChildReconstructionError,
  mergeReconstructedHistoryRows,
  reconstructParentLocalChildren,
  renderReconstructedStatusLines,
} from "../child-session-reconstruction.js";
import type {
  PiChildRefRecord,
  PiChildRefScan,
} from "../child-session-refs.js";
import {
  durableChildTitleSuffix,
  PI_CHILD_TITLE_BOUNDS,
  PI_CHILD_TITLE_PROVENANCE,
  resolveDurableChildTitle,
} from "../child-title.js";

const ESC = String.fromCharCode(0x1b);

function controlText(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const SECRET_TASK = [
  "SECRET_TASK_TOKEN_WARP_T6",
  `line two with ANSI ${ESC}[31mred${ESC}[0m text`,
  "path=/Users/jose/projects/weave/.env.production",
  "password=correct-horse-battery-staple",
  "Authorization: Bearer credential-like-secret",
].join("\n");
const SECRET_MARKERS = [
  "SECRET_TASK_TOKEN_WARP_T6",
  "line two with ANSI",
  "/Users/jose/projects/weave/.env.production",
  "password=correct-horse-battery-staple",
  "Authorization: Bearer credential-like-secret",
] as const;

function expectSecretAbsent(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of SECRET_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

function makeRef(title: string): PiChildRefRecord {
  return {
    childId: "child-privacy-42",
    threadId: "thread-privacy-42",
    nativeSessionId: "native-privacy-42",
    sessionRef: "child-privacy-42/session.jsonl",
    originParentSessionId: "parent-session-privacy",
    originEntryId: "entry-privacy-42",
    title,
    titleProvenance: PI_CHILD_TITLE_PROVENANCE,
    status: "completed",
    createdAt: 1_000,
    updatedAt: 2_000,
    settledAt: 2_000,
    runs: [
      {
        run: 1,
        action: "start",
        startedAt: 1_000,
        model: "model-x",
      },
    ],
  };
}

describe("durable child titles", () => {
  it("uses trusted identity and an opaque suffix, not task-shaped text", () => {
    const title = resolveDurableChildTitle({
      agentName: "shuttle",
      workflowStep: "execute",
      threadId: "thread-child-00000042",
    });

    expect(title).toBe("shuttle-00000042");
    expect(title).not.toContain("execute");
    expect(title).not.toContain("SECRET_TASK_TOKEN_WARP_T6");
    expect(title.length).toBeLessThanOrEqual(
      PI_CHILD_TITLE_BOUNDS.maxTitleLength,
    );
  });

  it("removes ANSI and control characters while preserving safe word boundaries", () => {
    const title = resolveDurableChildTitle({
      agentName: `${ESC}[31mloom${ESC}[0m\nchild\t${controlText(0, 7)}`,
      threadId: "child/alpha-42",
    });

    expect(title).toBe("loom child-dalpha42");
    expect(title).not.toContain(ESC);
    expect(hasControlCharacter(title)).toBe(false);
  });

  it("keeps Unicode identity text and the full title within explicit bounds", () => {
    const title = resolveDurableChildTitle({
      agentName: `漢字-${"é".repeat(400)}`,
      workflowStep: "workflow-step",
      threadId: `opaque-${"x".repeat(400)}`,
    });

    expect(title.length).toBeLessThanOrEqual(
      PI_CHILD_TITLE_BOUNDS.maxTitleLength,
    );
    expect(title).toContain("漢字");
    expect(title).toContain("…");
    expect(hasControlCharacter(title)).toBe(false);
  });

  it("falls back safely when trusted identity is absent or sanitizes empty", () => {
    expect(resolveDurableChildTitle({ threadId: "thread-abc" })).toBe(
      "child-hreadabc",
    );
    expect(
      resolveDurableChildTitle({
        agentName: `${ESC}[2J${controlText(0, 7)}`,
        workflowStep: "step",
        threadId: "thread-abc",
      }),
    ).toBe("step-hreadabc");
    expect(resolveDurableChildTitle({})).toBe("child");
  });

  it("filters opaque suffixes and keeps distinct opaque tails distinct", () => {
    expect(durableChildTitleSuffix("child/alpha-42")).toBe("dalpha42");
    expect(durableChildTitleSuffix("---___!!!")).toBe("");
    expect(durableChildTitleSuffix("run-00000041")).not.toBe(
      durableChildTitleSuffix("run-00000042"),
    );
    expect(durableChildTitleSuffix("opaque-1234567890")?.length).toBe(
      PI_CHILD_TITLE_BOUNDS.maxSuffixLength,
    );
  });

  it("has no legacy durable title candidate in production sources", async () => {
    const legacyCandidateField = ["task", "FirstLine"].join("");
    const productionFiles = [
      "child-title.ts",
      "child-picker.ts",
      "delegation-controller.ts",
    ];
    const sources = await Promise.all(
      productionFiles.map(async (file) =>
        Bun.file(new URL(`../${file}`, import.meta.url)).text(),
      ),
    );

    for (const source of sources) {
      expect(source).not.toContain(legacyCandidateField);
    }
  });

  it("keeps the generated title safe in SQLite, reconstruction, picker, history, doctor, and CLI models", async () => {
    expect(SECRET_TASK).toContain("SECRET_TASK_TOKEN_WARP_T6");
    const workspaceKey = "workspace-privacy";
    const parentSessionId = "parent-session-privacy";
    const title = resolveDurableChildTitle({
      agentName: "shuttle",
      workflowStep: "execute-secret-task",
      threadId: "thread-privacy-42",
    });
    const ref = makeRef(title);

    const source = {
      workspaceKey,
      parentSessionId,
      readRefs: () => okAsync<readonly PiChildRefRecord[], never>([ref]),
    };
    const cacheOpen = await openPiChildMetadataCache({
      root: "/tmp/weave-task21-title-privacy",
      fs: new FakePiChildMetadataCacheFs(),
      authority: {
        checkSource: () => okAsync("available" as const),
      },
      source,
      openDatabase: () => openBunChildMetadataDatabase(":memory:"),
      now: () => 3_000,
    });
    if (cacheOpen.isErr()) throw new Error(JSON.stringify(cacheOpen.error));
    if (cacheOpen.value.mode !== "active") {
      throw new Error(JSON.stringify(cacheOpen.value.error));
    }
    const cache = cacheOpen.value.cache;
    const cacheWrite = cache.upsertRef(ref, workspaceKey);
    expect(cacheWrite.isOk()).toBe(true);
    const cacheRows = await cache.list({
      workspaceKey,
      parentSessionId,
      limit: 10,
    });
    if (cacheRows.isErr()) throw new Error(JSON.stringify(cacheRows.error));
    expect(cacheRows.value.records).toHaveLength(1);
    expect(cacheRows.value.records[0]?.title).toBe(title);
    expectSecretAbsent(cacheRows.value.records);
    expectSecretAbsent(JSON.stringify(cacheRows.value.records[0]));

    const scan: PiChildRefScan = {
      refs: [ref],
      issues: [],
      counts: {
        scannedEntries: 1,
        candidateEntries: 1,
        malformedEntries: 0,
        originMismatchedChildren: 0,
        conflictingChildren: 0,
        duplicateEntries: 0,
        unusableSourceChildren: 0,
        usableRefs: 1,
      },
    };
    const reconstructed = await reconstructParentLocalChildren({
      refs: {
        liveParentSessionId: () => parentSessionId,
        readRefs: () => okAsync(scan),
      },
      workspaceKey,
      parentSessionId,
      cache,
    });
    if (reconstructed.isErr()) {
      throw new Error(JSON.stringify(reconstructed.error));
    }
    const summary = reconstructed.value;
    expect(summary.children[0]?.title).toBe(title);
    expectSecretAbsent(summary);
    expectSecretAbsent(renderReconstructedStatusLines([], summary));
    expectSecretAbsent(mergeReconstructedHistoryRows([], summary));
    expectSecretAbsent(
      describeChildReconstructionError({
        type: "ReconstructionParentUnavailable",
        reason: "empty-parent-session-id",
      }),
    );

    const pickerCandidate: PiChildPickerCandidate = {
      childId: ref.childId,
      threadId: ref.threadId,
      parentId: ref.originParentSessionId,
      status: "completed",
      explicitTitle: ref.title,
      workflowStep: "execute-secret-task",
      agent: "shuttle",
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      active: false,
      treeOrder: 0,
      sourceState: "available",
    };
    expect(resolveChildPickerTitle(pickerCandidate)).toBe(title);
    const pickerEntries = buildChildPickerMetadataEntries({
      candidates: [pickerCandidate],
      formatTimestamp: () => "now",
    });
    if (pickerEntries.isErr())
      throw new Error(JSON.stringify(pickerEntries.error));
    expectSecretAbsent(pickerEntries.value);

    const healthy = () => okAsync(passedDoctorCheck("healthy"));
    const doctorPorts: PiDoctorCheckPorts = {
      capabilities: healthy,
      permissions: healthy,
      sessions: healthy,
      refs: healthy,
      cache: healthy,
      stale: healthy,
      orphans: healthy,
    };
    const doctor = await runChildDoctor({
      ports: doctorPorts,
      diagnostic: true,
    });
    if (doctor.isErr()) throw new Error(JSON.stringify(doctor.error));
    expectSecretAbsent(doctor.value);

    const cliChild: PiAdapterChildListItem = {
      childId: ref.childId,
      threadId: ref.threadId,
      title,
      status: ref.status,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      originParentSessionId: ref.originParentSessionId,
      tombstoned: false,
      stale: false,
    };
    const children: PiAdapterChildrenPort = {
      list: () => okAsync({ children: [cliChild] }),
      show: () =>
        okAsync({
          child: cliChild,
          entries: [
            { index: 0, id: "entry-privacy-42", type: "weave.child.thread" },
          ],
          sessionRef: ref.sessionRef,
        }),
      resolve: () => okAsync({ matches: [cliChild] }),
      delete: () =>
        okAsync({
          childId: ref.childId,
          tombstoned: true as const,
          deletedAt: new Date(3_000).toISOString(),
        }),
    };
    const handlers = createPiAdapterCommandHandlers({ children });
    const listResult = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenList](
      JSON.stringify({ workspaceKey }),
    );
    if (listResult.isErr()) throw new Error(JSON.stringify(listResult.error));
    expectSecretAbsent(listResult.value);
    expectSecretAbsent(JSON.parse(listResult.value));

    const showResult = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenShow](
      JSON.stringify({ workspaceKey, childId: ref.childId }),
    );
    if (showResult.isErr()) throw new Error(JSON.stringify(showResult.error));
    expectSecretAbsent(showResult.value);
    expectSecretAbsent(JSON.parse(showResult.value));
  });
});
