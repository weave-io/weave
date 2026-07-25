import { describe, expect, it } from "bun:test";
import {
  ALL_CAPABILITY_IDS,
  logger,
  PLAN_TASK_STATES,
  RECONCILIATION_AUTHORIZATION_SOURCES,
} from "@weaveio/weave-engine";
import { err, ok } from "neverthrow";
import { PI_CONTROL_KINDS } from "../../../packages/adapters/pi/src/child-envelope.js";
import {
  WEAVE_COMMAND_CLASSIFICATIONS,
  WEAVE_COMMAND_NAMES,
} from "../../../packages/adapters/pi/src/commands.js";
import {
  PiAdapterFailureCodeSchema,
  PiAdapterFailureImpactSchema,
  PiAdapterFailureRecoverySchema,
} from "../../../packages/adapters/pi/src/errors.js";
import {
  ARTIFACT_APPROVAL_ACTOR_KINDS,
  BunEvidenceFileReader,
  buildAcceptanceManifest,
  type EvidenceFileReader,
  HOST_BOUNDARY_TOKENS,
  LIFECYCLE_OPERATIONS,
  PERMISSION_OUTCOME_KINDS,
  REQUIREMENT_IDS,
  validateAcceptanceManifestStructure,
  verifyAcceptanceManifestEvidence,
} from "../acceptance-manifest.js";
import {
  ACCEPTANCE_MANIFEST_REQUIREMENTS,
  PACKED_PROOF_REGISTRY,
} from "../acceptance-manifest-data.js";
import {
  BunSmokeChecklistReader,
  parseSmokeChecklist,
} from "../smoke-checklist.js";

function checklistResults(
  ids: Iterable<string>,
  result: "Pending" | "Pass" | "Fail" = "Pass",
): ReadonlyMap<string, "Pending" | "Pass" | "Fail"> {
  return new Map(Array.from(ids, (id) => [id, result]));
}

const VALID_ARTIFACT_BINDING = {
  packageVersion: "0.0.1",
  payloadArtifactId: "local-dev-pack",
  sha256: "a".repeat(64),
  subjectSha: "b".repeat(40),
  runAttempt: 1,
  checklistVersion: "1",
};

class FakeFileReader implements EvidenceFileReader {
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async read(path: string) {
    const content = this.files[path];
    if (content === undefined) return err({ type: "ReadFailed" as const });
    return ok(content);
  }
}

describe("buildAcceptanceManifest + validateAcceptanceManifestStructure", () => {
  it("builds a manifest that validates cleanly against the schema", () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    const result = validateAcceptanceManifestStructure(manifest);
    expect(result.isOk()).toBe(true);
  });

  it("accepts the immutable Task 12 manifest's historical capped host range", () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    const result = validateAcceptanceManifestStructure({
      ...manifest,
      host: {
        ...manifest.host,
        supportedRange: ">=0.81.1 <0.82.0",
      },
    });
    expect(result.isOk()).toBe(true);
  });

  it("covers exactly the 20 mandatory requirement IDs, no more, no fewer", () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    expect(manifest.requirements).toHaveLength(20);
    expect(new Set(manifest.requirements.map((row) => row.id))).toEqual(
      new Set(REQUIREMENT_IDS),
    );
  });

  it("rejects a manifest with a duplicated requirement ID", () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: [
        ...ACCEPTANCE_MANIFEST_REQUIREMENTS.slice(1),
        ACCEPTANCE_MANIFEST_REQUIREMENTS[1]!,
      ],
    });
    const result = validateAcceptanceManifestStructure(manifest);
    expect(result.isErr()).toBe(true);
  });

  it("rejects a manifest missing a mandatory requirement ID", () => {
    const manifest = {
      ...buildAcceptanceManifest({
        artifactBinding: VALID_ARTIFACT_BINDING,
        requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
      }),
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS.slice(1),
    };
    const result = validateAcceptanceManifestStructure(manifest);
    expect(result.isErr()).toBe(true);
  });

  it("rejects an artifactBinding with a malformed sha256", () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: { ...VALID_ARTIFACT_BINDING, sha256: "not-hex" },
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    const result = validateAcceptanceManifestStructure(manifest);
    expect(result.isErr()).toBe(true);
  });

  it("rejects duplicate normative, packed-proof, and smoke IDs within a row", () => {
    const base = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    const first = base.requirements[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const duplicated = {
      ...base,
      requirements: [
        {
          ...first,
          normativeSections: [
            first.normativeSections[0],
            first.normativeSections[0],
          ],
          packedProof: {
            required: true,
            evidenceIds: [
              first.packedProof.evidenceIds[0],
              first.packedProof.evidenceIds[0],
            ],
          },
          liveSmoke: {
            required: true,
            checklistIds: [
              first.liveSmoke.checklistIds[0],
              first.liveSmoke.checklistIds[0],
            ],
          },
        },
        ...base.requirements.slice(1),
      ],
    };
    expect(validateAcceptanceManifestStructure(duplicated).isErr()).toBe(true);
  });
});

describe("verifyAcceptanceManifestEvidence (mocked reader)", () => {
  const manifest = buildAcceptanceManifest({
    artifactBinding: VALID_ARTIFACT_BINDING,
    requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
  });

  it("reports no issues when every named test file contains the named test string", async () => {
    const files: Record<string, string> = {};
    for (const requirement of manifest.requirements)
      for (const test of Object.values(requirement.tests))
        files[test.file] =
          `${files[test.file] ?? ""}\nit("${test.name}", () => {});`;
    for (const entry of Object.values(PACKED_PROOF_REGISTRY))
      files[entry.file] =
        `${files[entry.file] ?? ""}\nit("${entry.name}", () => {});`;
    // Closed-set rows (PI-CAP/PI-CMD/PI-LIF) need every member literally
    // present somewhere in their referenced files, same as a real test file
    // would contain them via imports/loops/assertions elsewhere in the file.
    const capRow = manifest.requirements.find((row) => row.id === "PI-CAP")!;
    for (const test of Object.values(capRow.tests))
      files[test.file] = `${files[test.file]}\n${ALL_CAPABILITY_IDS.join(" ")}`;
    const cmdRow = manifest.requirements.find((row) => row.id === "PI-CMD")!;
    for (const test of Object.values(cmdRow.tests))
      files[test.file] =
        `${files[test.file]}\n${[...WEAVE_COMMAND_NAMES, ...WEAVE_COMMAND_CLASSIFICATIONS].join(" ")}`;
    const lifRow = manifest.requirements.find((row) => row.id === "PI-LIF")!;
    for (const test of Object.values(lifRow.tests))
      files[test.file] =
        `${files[test.file]}\n${LIFECYCLE_OPERATIONS.join(" ")}`;
    const delRow = manifest.requirements.find((row) => row.id === "PI-DEL")!;
    for (const test of Object.values(delRow.tests))
      files[test.file] = `${files[test.file]}\n${PI_CONTROL_KINDS.join(" ")}`;
    const polRow = manifest.requirements.find((row) => row.id === "PI-POL")!;
    for (const test of Object.values(polRow.tests))
      files[test.file] =
        `${files[test.file]}\n${PERMISSION_OUTCOME_KINDS.join(" ")}`;
    const plnRow = manifest.requirements.find((row) => row.id === "PI-PLN")!;
    for (const test of Object.values(plnRow.tests))
      files[test.file] = `${files[test.file]}\n${PLAN_TASK_STATES.join(" ")}`;
    const artRow = manifest.requirements.find((row) => row.id === "PI-ART")!;
    for (const test of Object.values(artRow.tests))
      files[test.file] =
        `${files[test.file]}\n${[...ARTIFACT_APPROVAL_ACTOR_KINDS, ...RECONCILIATION_AUTHORIZATION_SOURCES].join(" ")}`;
    const pkgRow = manifest.requirements.find((row) => row.id === "PI-PKG")!;
    for (const test of Object.values(pkgRow.tests))
      files[test.file] =
        `${files[test.file]}\n${HOST_BOUNDARY_TOKENS.join(" ")}`;
    const errRow = manifest.requirements.find((row) => row.id === "PI-ERR")!;
    for (const test of Object.values(errRow.tests))
      files[test.file] = `${files[test.file]}\n${[
        ...PiAdapterFailureCodeSchema.options,
        ...PiAdapterFailureImpactSchema.options,
        ...PiAdapterFailureRecoverySchema.options,
      ].join(" ")}`;

    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(files),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(
        manifest.requirements.flatMap((row) => row.liveSmoke.checklistIds),
      ),
    });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.orphanEvidence).toEqual([]);
  });

  it("flags a requirement whose named test file does not exist", async () => {
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader({}),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(["S001"]),
    });
    expect(report.ok).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("flags a requirement whose named test string is missing from an otherwise-present file", async () => {
    const files: Record<string, string> = {};
    for (const requirement of manifest.requirements)
      for (const test of Object.values(requirement.tests))
        files[test.file] = 'it("a completely unrelated test", () => {});';
    for (const entry of Object.values(PACKED_PROOF_REGISTRY))
      files[entry.file] = `it("${entry.name}", () => {});`;

    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(files),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(["S001"]),
    });
    expect(report.ok).toBe(false);
  });

  it("flags an unregistered packedProof evidence ID", async () => {
    const tampered = {
      ...manifest,
      requirements: manifest.requirements.map((row, index) =>
        index === 0
          ? {
              ...row,
              packedProof: { required: true as const, evidenceIds: ["P999"] },
            }
          : row,
      ),
    };
    const report = await verifyAcceptanceManifestEvidence(tampered, {
      reader: new FakeFileReader({}),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(["S001"]),
    });
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problems.some((problem) => problem.includes("P999")),
      ),
    ).toBe(true);
  });

  it("flags an unknown liveSmoke checklist ID", async () => {
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader({}),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults([]),
    });
    const errIssue = report.issues.find((issue) =>
      issue.problems.some((problem) => problem.includes("liveSmoke")),
    );
    expect(errIssue).toBeDefined();
  });

  it("rejects a passing requirement while any cited smoke row is pending", async () => {
    const passing = {
      ...manifest,
      requirements: manifest.requirements.map((row, index) =>
        index === 0 ? { ...row, result: "pass" as const } : row,
      ),
    };
    const report = await verifyAcceptanceManifestEvidence(passing, {
      reader: new FakeFileReader({}),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(
        manifest.requirements.flatMap((row) => row.liveSmoke.checklistIds),
        "Pending",
      ),
    });
    const activation = report.issues.find(
      (issue) => issue.requirementId === "PI-ACT",
    );
    expect(
      activation?.problems.some((problem) =>
        problem.includes("requirement is pass but checklist result is Pending"),
      ),
    ).toBe(true);
  });

  it("flags a missing closed-set member for PI-CAP when a capability ID is absent from the referenced tests", async () => {
    const files: Record<string, string> = {};
    for (const requirement of manifest.requirements)
      for (const test of Object.values(requirement.tests))
        files[test.file] =
          `${files[test.file] ?? ""}\nit("${test.name}", () => {});`;
    for (const entry of Object.values(PACKED_PROOF_REGISTRY))
      files[entry.file] =
        `${files[entry.file] ?? ""}\nit("${entry.name}", () => {});`;
    // Strip every mention of one required capability ID from the PI-CAP files only.
    const capRow = manifest.requirements.find((row) => row.id === "PI-CAP");
    expect(capRow).toBeDefined();
    for (const test of Object.values(capRow!.tests))
      files[test.file] = files[test.file]!.replaceAll(
        "config-materialization",
        "",
      );

    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(files),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(
        Array.from(
          { length: 30 },
          (_, index) => `S${String(index + 1).padStart(3, "0")}`,
        ),
      ),
    });
    const capIssue = report.issues.find(
      (issue) => issue.requirementId === "PI-CAP",
    );
    expect(capIssue).toBeDefined();
    expect(
      capIssue!.problems.some((problem) =>
        problem.includes("config-materialization"),
      ),
    ).toBe(true);
  });
});

describe("verifyAcceptanceManifestEvidence orphan evidence detection (mocked reader)", () => {
  const manifest = buildAcceptanceManifest({
    artifactBinding: VALID_ARTIFACT_BINDING,
    requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
  });

  const allFilesPresent = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const requirement of manifest.requirements)
      for (const test of Object.values(requirement.tests))
        files[test.file] =
          `${files[test.file] ?? ""}\nit("${test.name}", () => {});`;
    for (const entry of Object.values(PACKED_PROOF_REGISTRY))
      files[entry.file] =
        `${files[entry.file] ?? ""}\nit("${entry.name}", () => {});`;
    return files;
  };

  it("flags a packedProof registry entry that no requirement references", async () => {
    const registryWithOrphan = {
      ...PACKED_PROOF_REGISTRY,
      P999: {
        file: "scripts/release/__tests__/does-not-matter.test.ts",
        name: "unused",
      },
    };
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(allFilesPresent()),
      packedProofRegistry: registryWithOrphan,
      checklistResults: checklistResults(
        Array.from(
          { length: 30 },
          (_, index) => `S${String(index + 1).padStart(3, "0")}`,
        ),
      ),
    });
    expect(report.ok).toBe(false);
    expect(
      report.orphanEvidence.some((problem) => problem.includes("P999")),
    ).toBe(true);
  });

  it("flags a checklist item ID that no requirement references", async () => {
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(allFilesPresent()),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults([
        ...Array.from(
          { length: 30 },
          (_, index) => `S${String(index + 1).padStart(3, "0")}`,
        ),
        "S999",
      ]),
    });
    expect(report.ok).toBe(false);
    expect(
      report.orphanEvidence.some((problem) => problem.includes("S999")),
    ).toBe(true);
  });

  it("reports no orphan evidence for the committed registry and every checklist item it references", async () => {
    const referencedChecklistIds = new Set(
      manifest.requirements.flatMap((row) => row.liveSmoke.checklistIds),
    );
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new FakeFileReader(allFilesPresent()),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: checklistResults(referencedChecklistIds),
    });
    expect(report.orphanEvidence).toEqual([]);
  });
});

describe("committed acceptance manifest data (real repository files)", () => {
  it("resolves every named test and packed-proof evidence entry against the real files on disk", async () => {
    const manifest = buildAcceptanceManifest({
      artifactBinding: VALID_ARTIFACT_BINDING,
      requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
    });
    const checklistRead = await new BunSmokeChecklistReader().read();
    expect(checklistRead.isOk()).toBe(true);
    if (!checklistRead.isOk()) return;
    const parsedChecklist = parseSmokeChecklist(checklistRead.value);
    expect(parsedChecklist.isOk()).toBe(true);
    if (!parsedChecklist.isOk()) return;

    const root = new URL("../../..", import.meta.url).pathname;
    const report = await verifyAcceptanceManifestEvidence(manifest, {
      reader: new BunEvidenceFileReader(root),
      packedProofRegistry: PACKED_PROOF_REGISTRY,
      checklistResults: new Map(
        parsedChecklist.value.items.map((item) => [item.id, item.result]),
      ),
    });

    if (!report.ok)
      logger.error(
        { issues: report.issues, orphanEvidence: report.orphanEvidence },
        "acceptance manifest evidence verification failed",
      );
    expect(report.ok).toBe(true);
  }, 20_000);

  it("has no checklist item that every requirement row collectively fails to reference", async () => {
    const checklistRead = await new BunSmokeChecklistReader().read();
    expect(checklistRead.isOk()).toBe(true);
    if (!checklistRead.isOk()) return;
    const parsedChecklist = parseSmokeChecklist(checklistRead.value);
    expect(parsedChecklist.isOk()).toBe(true);
    if (!parsedChecklist.isOk()) return;

    const referenced = new Set(
      ACCEPTANCE_MANIFEST_REQUIREMENTS.flatMap(
        (row) => row.liveSmoke.checklistIds,
      ),
    );
    const orphaned = parsedChecklist.value.items
      .map((item) => item.id)
      .filter((id) => !referenced.has(id));
    expect(orphaned).toEqual([]);
  });
});
