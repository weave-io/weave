import {
  ALL_CAPABILITY_IDS,
  PLAN_TASK_STATES,
  RECONCILIATION_AUTHORIZATION_SOURCES,
} from "@weaveio/weave-engine";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { PI_CONTROL_KINDS } from "../../packages/adapters/pi/src/child-envelope.js";
import {
  WEAVE_COMMAND_CLASSIFICATIONS,
  WEAVE_COMMAND_NAMES,
} from "../../packages/adapters/pi/src/commands.js";
import {
  PiAdapterFailureCodeSchema,
  PiAdapterFailureImpactSchema,
  PiAdapterFailureRecoverySchema,
} from "../../packages/adapters/pi/src/errors.js";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
} from "../../packages/adapters/pi/src/host-compatibility.js";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../../packages/adapters/pi/src/host-compatibility-matrix.js";
import type { SmokeChecklistResult } from "./smoke-checklist.js";

/**
 * Acceptance manifest builder and validator (Pi adapter contract, PI-PKG).
 *
 * Mirrors `scripts/release/pi-acceptance/acceptance-manifest.schema.json`
 * (the checked-in normative contract) as Zod schemas, provides the
 * source-controlled requirement rows tracing every mandatory `PI-*` ID to
 * real named automated tests, and validates that the named evidence
 * actually exists and that the closed sets it claims to cover are
 * exhaustive. It also binds a requirement result to the cited checklist
 * outcomes: a requirement cannot pass unless every cited live row passed.
 */

export const REQUIREMENT_IDS = [
  "PI-ACT",
  "PI-MAT",
  "PI-PRM",
  "PI-SKL",
  "PI-MDL",
  "PI-POL",
  "PI-DEL",
  "PI-CMD",
  "PI-LIF",
  "PI-CMP",
  "PI-REC",
  "PI-PLN",
  "PI-ART",
  "PI-PER",
  "PI-DIA",
  "PI-USG",
  "PI-CAP",
  "PI-ERR",
  "PI-PKG",
  "PI-MODE",
  "PI-INS",
  "PI-INT",
  "PI-PRI",
  "PI-BND",
  "PI-OVR",
  "PI-QUO",
  "PI-SET",
  "PI-RCV",
] as const;

export type RequirementId = (typeof REQUIREMENT_IDS)[number];

export const RequirementIdSchema = z.enum(REQUIREMENT_IDS);

const CONTRACT_REFERENCE_PATTERN = /^(?:docs\/(?!specs(?:\/|$))|packages\/|scripts\/)[A-Za-z0-9._/-]+(?:#[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const TEST_KEY_PATTERN = /^T[0-9]{3}$/;
const PROOF_ID_PATTERN = /^P[0-9]{3}$/;
const SMOKE_ID_PATTERN = /^S[0-9]{3}$/;
const TEST_FILE_PATTERN = /^(packages|scripts)\/.+\.(test|spec)\.ts$/;

export const TestEvidenceSchema = z
  .object({
    file: z.string().regex(TEST_FILE_PATTERN),
    name: z.string().min(1).max(200),
  })
  .strict();
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

export const RequirementSchema = z
  .object({
    id: RequirementIdSchema,
    contractReferences: z
      .array(z.string().regex(CONTRACT_REFERENCE_PATTERN))
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: "contract references must be unique",
      }),
    tests: z
      .record(z.string().regex(TEST_KEY_PATTERN), TestEvidenceSchema)
      .refine((value) => Object.keys(value).length >= 1, {
        message: "every requirement needs at least one named test",
      }),
    packedProof: z
      .object({
        required: z.literal(true),
        evidenceIds: z
          .array(z.string().regex(PROOF_ID_PATTERN))
          .min(1)
          .refine((items) => new Set(items).size === items.length, {
            message: "packed proof IDs must be unique",
          }),
      })
      .strict(),
    liveSmoke: z
      .object({
        required: z.literal(true),
        checklistIds: z
          .array(z.string().regex(SMOKE_ID_PATTERN))
          .min(1)
          .refine((items) => new Set(items).size === items.length, {
            message: "smoke checklist IDs must be unique",
          }),
      })
      .strict(),
    result: z.enum(["pending", "pass", "fail"]),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type AcceptanceManifestRequirement = z.infer<typeof RequirementSchema>;

export const HostSchema = z
  .object({
    package: z.literal(PI_HOST_COMPATIBILITY_MATRIX.package),
    supportedRange: z.string().regex(/^>=0\.81\.1(?: <\d+\.\d+\.\d+)?$/),
    floorVersion: z.literal(PI_HOST_COMPATIBILITY_MATRIX.floorVersion),
    exactTestedVersion: z.literal(
      PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion,
    ),
  })
  .strict();

export const ArtifactBindingSchema = z
  .object({
    packageVersion: z.string().min(1),
    payloadArtifactId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    subjectSha: z.string().regex(/^[a-f0-9]{40}$/),
    runAttempt: z.number().int().min(1),
    checklistVersion: z.string().min(1),
  })
  .strict();
export type AcceptanceManifestArtifactBinding = z.infer<
  typeof ArtifactBindingSchema
>;

export const AcceptanceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapter: z.literal("@weaveio/weave-adapter-pi"),
    host: HostSchema,
    artifactBinding: ArtifactBindingSchema,
    requirements: z.array(RequirementSchema).length(REQUIREMENT_IDS.length),
  })
  .strict();
export type AcceptanceManifest = z.infer<typeof AcceptanceManifestSchema>;

export type AcceptanceManifestError =
  | { type: "SchemaInvalid"; issues: readonly string[] }
  | { type: "DuplicateRequirementId"; id: string }
  | { type: "MissingRequirementId"; id: string }
  | { type: "OrphanRequirementId"; id: string };

/**
 * Structural validation: schema shape, plus defense-in-depth duplicate and
 * orphan checks so a hand-edited manifest can never silently drop or
 * duplicate a mandatory `PI-*` row even if the schema regex checks pass.
 */
export function validateAcceptanceManifestStructure(
  candidate: unknown,
): Result<AcceptanceManifest, AcceptanceManifestError[]> {
  const parsed = AcceptanceManifestSchema.safeParse(candidate);
  if (!parsed.success)
    return err([
      {
        type: "SchemaInvalid",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      },
    ]);

  const errors: AcceptanceManifestError[] = [];
  const seen = new Set<string>();
  for (const requirement of parsed.data.requirements) {
    if (seen.has(requirement.id))
      errors.push({ type: "DuplicateRequirementId", id: requirement.id });
    seen.add(requirement.id);
  }
  for (const id of REQUIREMENT_IDS)
    if (!seen.has(id)) errors.push({ type: "MissingRequirementId", id });
  for (const id of seen)
    if (!(REQUIREMENT_IDS as readonly string[]).includes(id))
      errors.push({ type: "OrphanRequirementId", id });

  if (errors.length > 0) return err(errors);
  return ok(parsed.data);
}

/**
 * Closed sets that this validator can automatically verify are exhaustively
 * covered by a row's referenced test files, keyed by requirement ID. Each
 * member string is checked as a literal substring of the concatenated
 * content of every test file the row cites (via `tests` and, where
 * relevant, `packedProof`) — the same tests already required to exist by
 * `verifyAcceptanceManifestEvidence`.
 *
 * Only requirements with a single unambiguous, already-exported closed-set
 * source in the codebase are wired here (capabilities, direct commands,
 * lifecycle operations). Other rows still require named-test and
 * packed-proof evidence to exist; their closed-set exhaustiveness is
 * recorded in `notes` and reviewed by hand, not token-matched, because their
 * members are not a single flat exported literal list.
 */
export const LIFECYCLE_OPERATIONS = [
  "observeSession",
  "startExecution",
  "resumeExecution",
  "handleUserInterrupt",
  "dispatchStep",
  "completeStep",
  "beforeTool",
  "inspectExecution",
  "approveArtifact",
  "reconcileExecution",
] as const;

export interface ClosedSetSpec {
  readonly description: string;
  readonly members: readonly string[];
}

/** The 2 `ArtifactApprovalActor` kinds (Pi adapter contract). */
export const ARTIFACT_APPROVAL_ACTOR_KINDS = ["user", "agent"] as const;

/** The 2 source-controlled host-compatibility boundary tokens (Pi adapter contract). */
export const HOST_BOUNDARY_TOKENS = [
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
] as const;

export const CLOSED_SET_REQUIREMENTS: Partial<
  Record<RequirementId, ClosedSetSpec>
> = {
  "PI-CAP": {
    description: "20 capability IDs (Pi adapter contract)",
    members: ALL_CAPABILITY_IDS,
  },
  "PI-CMD": {
    description:
      "9 direct /weave:* commands plus the 3 command classifications gating invalid (health-only) states (Pi adapter contract)",
    members: [...WEAVE_COMMAND_NAMES, ...WEAVE_COMMAND_CLASSIFICATIONS],
  },
  "PI-LIF": {
    description: "10 lifecycle operations (Pi adapter contract)",
    members: LIFECYCLE_OPERATIONS,
  },
  "PI-DEL": {
    description: "9 private control envelope kinds (Pi adapter contract)",
    members: PI_CONTROL_KINDS,
  },
  "PI-PLN": {
    description: "3 plan task markers/states (Pi adapter contract)",
    members: PLAN_TASK_STATES,
  },
  "PI-ART": {
    description:
      "2 artifact-approval actor kinds plus 4 reconciliation authorization sources (Pi adapter contract)",
    members: [
      ...ARTIFACT_APPROVAL_ACTOR_KINDS,
      ...RECONCILIATION_AUTHORIZATION_SOURCES,
    ],
  },
  "PI-PKG": {
    description: "host package/minimum-version boundary tokens (Pi adapter contract)",
    members: HOST_BOUNDARY_TOKENS,
  },
  "PI-ERR": {
    description:
      "every PiAdapterFailureCode, impact, and recovery value (Pi adapter contract)",
    members: [
      ...PiAdapterFailureCodeSchema.options,
      ...PiAdapterFailureImpactSchema.options,
      ...PiAdapterFailureRecoverySchema.options,
    ],
  },
};

export interface EvidenceFileReader {
  read(path: string): Promise<Result<string, { type: "ReadFailed" }>>;
}

/** Reads evidence files from the real repository tree, relative to `root`. */
export class BunEvidenceFileReader implements EvidenceFileReader {
  constructor(private readonly root: string) {}

  async read(path: string): Promise<Result<string, { type: "ReadFailed" }>> {
    const fullPath = `${this.root}/${path}`;
    const file = Bun.file(fullPath);
    const exists = await ResultAsync.fromPromise(
      file.exists(),
      (): { type: "ReadFailed" } => ({ type: "ReadFailed" }),
    );
    if (exists.isErr()) return err(exists.error);
    if (!exists.value) return err({ type: "ReadFailed" });
    return ResultAsync.fromPromise(file.text(), (): { type: "ReadFailed" } => ({
      type: "ReadFailed",
    }));
  }
}

export interface RequirementEvidenceIssue {
  readonly requirementId: RequirementId;
  readonly problems: readonly string[];
}

export interface EvidenceVerificationReport {
  readonly ok: boolean;
  readonly issues: readonly RequirementEvidenceIssue[];
  /**
   * Canonical evidence (packed-proof registry entries, checklist items)
   * that exists but is never cited by any requirement row. An unreferenced
   * entry is exactly as dangerous as a missing one: it means the manifest
   * makes a claim ("this evidence backs a requirement") that nothing in the
   * checked-in data actually makes, so CI must reject it the same way it
   * rejects a reference to evidence that does not exist.
   */
  readonly orphanEvidence: readonly string[];
}

/**
 * Verifies, for every requirement row, that:
 *  - every named test's file exists and its file content contains the named
 *    test string (proof the test is real, not invented);
 *  - every `packedProof.evidenceIds` entry resolves against the supplied
 *    packed-proof registry, with the same file/name existence check;
 *  - every `liveSmoke.checklistIds` entry names a real checklist item and a
 *    passing requirement cites only checklist rows whose result is `Pass`;
 *  - any closed set registered for this requirement ID (see
 *    `CLOSED_SET_REQUIREMENTS`) has every member present somewhere in the
 *    concatenated content of the row's referenced test files.
 *
 * This never runs the named tests — it only proves the evidence trail is
 * real, matching Pi adapter contract's "CI ... verifies named tests and evidence
 * exist" requirement.
 */
export async function verifyAcceptanceManifestEvidence(
  manifest: AcceptanceManifest,
  deps: {
    reader: EvidenceFileReader;
    packedProofRegistry: Readonly<Record<string, TestEvidence>>;
    checklistResults: ReadonlyMap<string, SmokeChecklistResult>;
  },
): Promise<EvidenceVerificationReport> {
  const issues: RequirementEvidenceIssue[] = [];
  const fileContentCache = new Map<string, string | undefined>();

  const loadFile = async (path: string): Promise<string | undefined> => {
    if (fileContentCache.has(path)) return fileContentCache.get(path);
    const result = await deps.reader.read(path);
    const content = result.isOk() ? result.value : undefined;
    fileContentCache.set(path, content);
    return content;
  };

  for (const requirement of manifest.requirements) {
    const problems: string[] = [];
    const coveredFiles: string[] = [];

    for (const [key, test] of Object.entries(requirement.tests)) {
      const content = await loadFile(test.file);
      if (content === undefined) {
        problems.push(`${key}: file not found: ${test.file}`);
        continue;
      }
      if (!content.includes(test.name)) {
        problems.push(
          `${key}: test name not found in ${test.file}: ${test.name}`,
        );
        continue;
      }
      coveredFiles.push(test.file);
    }

    for (const evidenceId of requirement.packedProof.evidenceIds) {
      const entry = deps.packedProofRegistry[evidenceId];
      if (entry === undefined) {
        problems.push(`packedProof ${evidenceId}: unregistered evidence ID`);
        continue;
      }
      const content = await loadFile(entry.file);
      if (content === undefined) {
        problems.push(
          `packedProof ${evidenceId}: file not found: ${entry.file}`,
        );
        continue;
      }
      if (!content.includes(entry.name)) {
        problems.push(
          `packedProof ${evidenceId}: test name not found in ${entry.file}: ${entry.name}`,
        );
        continue;
      }
      coveredFiles.push(entry.file);
    }

    let citedFailedSmoke = false;
    for (const checklistId of requirement.liveSmoke.checklistIds) {
      const checklistResult = deps.checklistResults.get(checklistId);
      if (checklistResult === undefined) {
        problems.push(`liveSmoke ${checklistId}: unknown checklist item`);
        continue;
      }
      if (checklistResult === "Fail") citedFailedSmoke = true;
      if (requirement.result === "pass" && checklistResult !== "Pass") {
        problems.push(
          `liveSmoke ${checklistId}: requirement is pass but checklist result is ${checklistResult}`,
        );
      }
    }
    if (requirement.result === "fail" && !citedFailedSmoke) {
      problems.push(
        "requirement is fail but none of its cited checklist rows failed",
      );
    }

    const closedSet = CLOSED_SET_REQUIREMENTS[requirement.id];
    if (closedSet !== undefined) {
      const combined = (
        await Promise.all(coveredFiles.map((path) => loadFile(path)))
      )
        .filter((content): content is string => content !== undefined)
        .join("\n");
      for (const member of closedSet.members)
        if (!combined.includes(member))
          problems.push(
            `closed set (${closedSet.description}) missing member: ${member}`,
          );
    }

    if (problems.length > 0)
      issues.push({ requirementId: requirement.id, problems });
  }

  const orphanEvidence: string[] = [];
  const referencedProofIds = new Set<string>();
  const referencedChecklistIds = new Set<string>();
  for (const requirement of manifest.requirements) {
    for (const id of requirement.packedProof.evidenceIds)
      referencedProofIds.add(id);
    for (const id of requirement.liveSmoke.checklistIds)
      referencedChecklistIds.add(id);
  }
  for (const id of Object.keys(deps.packedProofRegistry))
    if (!referencedProofIds.has(id))
      orphanEvidence.push(
        `packedProof ${id}: registered but never referenced by any requirement`,
      );
  for (const id of deps.checklistResults.keys())
    if (!referencedChecklistIds.has(id))
      orphanEvidence.push(
        `liveSmoke ${id}: checklist item exists but is never referenced by any requirement`,
      );

  return {
    ok: issues.length === 0 && orphanEvidence.length === 0,
    issues,
    orphanEvidence,
  };
}

/**
 * Builds a complete, schema-valid manifest from the source-controlled
 * requirement rows plus release-time `artifactBinding` input. The host block
 * is always derived from `PI_HOST_COMPATIBILITY_MATRIX` so it can never
 * drift from the single source-controlled compatibility record.
 */
export function buildAcceptanceManifest(input: {
  artifactBinding: AcceptanceManifestArtifactBinding;
  requirements: readonly AcceptanceManifestRequirement[];
}): AcceptanceManifest {
  return {
    schemaVersion: 1,
    adapter: "@weaveio/weave-adapter-pi",
    host: {
      package: PI_HOST_COMPATIBILITY_MATRIX.package,
      supportedRange: PI_HOST_COMPATIBILITY_MATRIX.supportedRange,
      floorVersion: PI_HOST_COMPATIBILITY_MATRIX.floorVersion,
      exactTestedVersion: PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion,
    },
    artifactBinding: input.artifactBinding,
    requirements: [...input.requirements],
  };
}
