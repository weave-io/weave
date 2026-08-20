/**
 * The read-only production Task 14 authority reader.
 *
 * Every field of the `ReleaseAuthority` this module returns is derived from an
 * immutable, source-bound observation:
 *
 * - package identity and version come from the merged commit's manifests;
 * - publication, tarball bytes, and deprecation come from the registry;
 * - the expected digest comes from npm's published provenance statement, which
 *   names the exact source commit the bytes were built from;
 * - tags and releases come from Git refs and GitHub releases;
 * - changeset cleanup comes from the merged tree and from `main`'s tree, so a
 *   cleanup pull request merged *after* the release is observed;
 * - artifact cache and independent-proof evidence come from Actions runs at the
 *   released commit;
 * - integrity-incident authorization comes from the protected incident check
 *   run at the released commit.
 *
 * Nothing here reads a pull-request comment or trusts a workflow artifact as
 * authority, and nothing here writes. When an authority source cannot be read
 * or cannot be bound to the released commit, the read fails with a typed error.
 * It is never downgraded to `false` or `null`, because a fabricated negative is
 * indistinguishable from a proven one at the classifier.
 */
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_REPOSITORY,
} from "./constants.js";
import {
  boundedBytesFetch,
  boundedJsonFetch,
  DOCTOR_TRANSPORT_LIMITS,
} from "./doctor-transports.js";
import type { GitHubFetch, GitHubRestClient } from "./github-client.js";
import {
  INCIDENT_CHECK_RUN_NAME,
  type IncidentAuthorizationRecord,
  validateIncidentAuthorizationRecord,
} from "./incident-resolution.js";
import { SemVerSchema } from "./model.js";
import { releaseTagName } from "./notes-wrapper.js";
import type {
  MergedReleasePullRequestAuthority,
  PackageMemberAuthority,
  ReleaseAuthority,
  ReleaseStateError,
} from "./release-state.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const SOURCE_REPOSITORY_URLS: ReadonlySet<string> = new Set([
  `https://github.com/${RELEASE_REPOSITORY}`,
  `git+https://github.com/${RELEASE_REPOSITORY}`,
  `git+https://github.com/${RELEASE_REPOSITORY}.git`,
  RELEASE_REPOSITORY,
]);
const SLSA_PREDICATE_TYPES: ReadonlySet<string> = new Set([
  "https://slsa.dev/provenance/v1",
  "https://slsa.dev/provenance/v0.2",
]);
const AUTHORITY_BOUNDS = {
  changesetPaths: 256,
  checkRuns: 8,
  workflowRuns: 32,
  attestations: 8,
  subjects: 8,
  resolvedDependencies: 16,
  deprecationMessage: 512,
  tarballUrlLength: 2_048,
} as const;

/** Everything the reader needs that it cannot derive from the pull request. */
export interface DoctorAuthorityContext {
  readonly client: GitHubRestClient;
  readonly registryFetch?: GitHubFetch;
  readonly markerPresent: boolean;
  readonly markerSha: string | null;
  readonly associatedPullRequestSettled: boolean;
}

/** The merged stable release pull request the authority is bound to. */
export interface DoctorAuthorityRequest
  extends MergedReleasePullRequestAuthority {
  readonly labels: readonly string[];
}

export function authorityFailure(...issues: string[]): ReleaseStateError {
  return { type: "InvalidReleaseAuthority", issues };
}

/**
 * Reads the full Task 14 authority for one merged stable release.
 *
 * The result is only ever a validated observation; the caller still binds it to
 * the requested pull-request identity and classifies it.
 */
export function readProductionReleaseAuthority(
  context: DoctorAuthorityContext,
  request: DoctorAuthorityRequest,
): ResultAsync<ReleaseAuthority, ReleaseStateError> {
  return ResultAsync.fromPromise(
    collectAuthority(context, request),
    (cause): ReleaseStateError =>
      authorityFailure(
        cause instanceof Error
          ? cause.message
          : "production Task 14 authority read failed",
      ),
  ).andThen((result) => result);
}

async function collectAuthority(
  context: DoctorAuthorityContext,
  request: DoctorAuthorityRequest,
): Promise<Result<ReleaseAuthority, ReleaseStateError>> {
  const releasedSha = request.mergeCommitSha;
  if (!FULL_SHA.test(releasedSha))
    return err(authorityFailure("merge commit SHA is malformed"));
  const fetchImpl = context.registryFetch ?? fetch;

  const incidentRecord = await readIncidentAuthorization(
    context.client,
    releasedSha,
  );
  if (incidentRecord.isErr()) return err(incidentRecord.error);

  const proof = await readProofEvidence(context.client, releasedSha);
  if (proof.isErr()) return err(proof.error);

  const members: PackageMemberAuthority[] = [];
  for (const packageName of Object.keys(
    PUBLIC_PACKAGES,
  ) as PublicPackageName[]) {
    const member = await readMember({
      client: context.client,
      fetchImpl,
      packageName,
      releasedSha,
      incident: incidentRecord.value,
      proof: proof.value,
    });
    if (member.isErr()) return err(member.error);
    members.push(member.value);
  }

  const refs = await readReleaseRefs(context.client, members);
  if (refs.isErr()) return err(refs.error);

  const cleanup = await readChangesetCleanup(context.client, releasedSha);
  if (cleanup.isErr()) return err(cleanup.error);

  const incident = incidentEvidence(
    incidentRecord.value,
    members,
    refs.value.releases,
  );
  if (incident.isErr()) return err(incident.error);

  return ok({
    pullRequest: {
      number: request.number,
      url: request.url,
      merged: request.merged,
      closed: request.closed,
      mergeCommitSha: request.mergeCommitSha,
      headRef: request.headRef,
    },
    releasedSha,
    channel: "stable",
    members,
    tags: refs.value.tags,
    releases: refs.value.releases,
    cleanupMerged: cleanup.value.cleanupMerged,
    cleanupRequired: cleanup.value.cleanupRequired,
    markerPresent: context.markerPresent,
    markerSha: context.markerSha,
    associatedPullRequestSettled: context.associatedPullRequestSettled,
    incident: incident.value,
    // The doctor proves comments are never authority by never reading one.
    comments: [],
  });
}

// ---------------------------------------------------------------------------
// Package members
// ---------------------------------------------------------------------------

interface MemberReadInput {
  readonly client: GitHubRestClient;
  readonly fetchImpl: GitHubFetch;
  readonly packageName: PublicPackageName;
  readonly releasedSha: string;
  readonly incident: IncidentAuthorizationRecord | null;
  readonly proof: ProofEvidence;
}

async function readMember(
  input: MemberReadInput,
): Promise<Result<PackageMemberAuthority, ReleaseStateError>> {
  const manifestPath = `${PUBLIC_PACKAGES[input.packageName].directory}/package.json`;
  const manifest = await readJsonFileAtRef(
    input.client,
    manifestPath,
    input.releasedSha,
  );
  if (manifest.isErr()) return err(manifest.error);
  const version = readManifestVersion(manifest.value, manifestPath);
  if (version.isErr()) return err(version.error);

  const registry = await readRegistryPackage(
    input.packageName,
    version.value,
    input.fetchImpl,
  );
  if (registry.isErr()) return err(registry.error);
  const observation = registry.value;

  if (!observation.published)
    return ok({
      packageName: input.packageName,
      version: version.value,
      published: false,
      registryDigest: null,
      provenanceSubjectDigest: null,
      recordedDigest: null,
      deprecated: null,
      cacheDigest: null,
      cacheValid: input.proof.artifactCacheValid,
      // The doctor never rebuilds, so an unpublished member's bytes have no
      // rebuilt digest to compare. That is an absence, not a mismatch.
      rebuiltDigest: null,
      proofChainComplete: input.proof.independentProofComplete,
      registryVerified: false,
    });

  const affected = input.incident?.affected.find(
    (entry) =>
      entry.packageName === input.packageName &&
      entry.version === version.value,
  );
  if (affected !== undefined && affected.digest !== observation.digest)
    return err(
      authorityFailure(
        `${input.packageName}@${version.value}: the authorized incident record names registry digest ${affected.digest} but the registry serves ${observation.digest}`,
      ),
    );

  const provenance = await readProvenanceSubject({
    fetchImpl: input.fetchImpl,
    packageName: input.packageName,
    version: version.value,
    releasedSha: input.releasedSha,
    tarballSha512: observation.sha512,
  });
  if (provenance.isErr()) return err(provenance.error);

  const resolved = resolveProvenanceDigest(
    input.packageName,
    version.value,
    observation.digest,
    provenance.value,
    affected?.provenanceSubjectDigest ?? null,
  );
  if (resolved.isErr()) return err(resolved.error);

  return ok({
    packageName: input.packageName,
    version: version.value,
    published: true,
    registryDigest: observation.digest,
    provenanceSubjectDigest: resolved.value.provenanceSubjectDigest,
    recordedDigest: affected?.digest ?? null,
    deprecated: observation.deprecated,
    cacheDigest: null,
    cacheValid: input.proof.artifactCacheValid,
    rebuiltDigest: null,
    proofChainComplete: input.proof.independentProofComplete,
    registryVerified: resolved.value.registryVerified,
  });
}

/**
 * Decides the expected-digest fields from provenance and incident authority.
 *
 * A published member is *verified* only when npm's own provenance statement
 * names both the released commit and the exact bytes the registry served. When
 * npm has published no provenance yet, that is an observed pending state. When
 * npm published provenance that does not describe these bytes, the doctor
 * refuses to invent the foreign artifact's digest: only the protected
 * incident-resolution operation records that pair, and without it the read
 * fails closed.
 */
function resolveProvenanceDigest(
  packageName: PublicPackageName,
  version: string,
  registryDigest: string,
  provenance: ProvenanceObservation,
  recordedProvenanceDigest: string | null,
): Result<
  { provenanceSubjectDigest: string | null; registryVerified: boolean },
  ReleaseStateError
> {
  if (recordedProvenanceDigest !== null)
    return ok({
      provenanceSubjectDigest: recordedProvenanceDigest,
      registryVerified: recordedProvenanceDigest === registryDigest,
    });
  if (provenance.kind === "absent")
    return ok({ provenanceSubjectDigest: null, registryVerified: false });
  if (provenance.kind === "bound")
    return ok({
      provenanceSubjectDigest: registryDigest,
      registryVerified: true,
    });
  return err(
    authorityFailure(
      `${packageName}@${version}: npm provenance does not describe the published bytes at the released commit (${provenance.reason}) and no authorized incident record supplies the attested digest`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type RegistryPackageObservation =
  | { readonly published: false }
  | {
      readonly published: true;
      readonly digest: string;
      readonly sha512: string;
      readonly deprecated: string | null;
    };

async function readRegistryPackage(
  packageName: PublicPackageName,
  version: string,
  fetchImpl: GitHubFetch,
): Promise<Result<RegistryPackageObservation, ReleaseStateError>> {
  const encodedPackage = encodeURIComponent(packageName);
  const metadataUrl = `${REGISTRY_ORIGIN}/${encodedPackage}/${encodeURIComponent(version)}`;
  const metadata = await boundedJsonFetch(
    metadataUrl,
    fetchImpl,
    DOCTOR_TRANSPORT_LIMITS.jsonResponseBytes,
  );
  if (metadata.status === 404) return ok({ published: false });
  if (!metadata.ok)
    return err(
      authorityFailure(
        `npm metadata read failed for ${packageName}@${version} (HTTP ${metadata.status})`,
      ),
    );
  const record = asRecord(metadata.value);
  if (record === undefined)
    return err(
      authorityFailure(
        `npm metadata is malformed for ${packageName}@${version}`,
      ),
    );
  const dist = asRecord(record.dist);
  const tarball = dist?.tarball;
  if (
    typeof tarball !== "string" ||
    tarball.length > AUTHORITY_BOUNDS.tarballUrlLength
  )
    return err(
      authorityFailure(
        `npm tarball URL is missing for ${packageName}@${version}`,
      ),
    );
  const unscoped = packageName.split("/").pop() ?? packageName;
  const expectedTarball = `${REGISTRY_ORIGIN}/${packageName}/-/${unscoped}-${encodeURIComponent(version)}.tgz`;
  const encodedTarball = `${REGISTRY_ORIGIN}/${encodedPackage}/-/${unscoped}-${encodeURIComponent(version)}.tgz`;
  if (tarball !== expectedTarball && tarball !== encodedTarball)
    return err(
      authorityFailure(
        `npm tarball URL is not canonical for ${packageName}@${version}`,
      ),
    );
  const response = await boundedBytesFetch(
    expectedTarball,
    fetchImpl,
    DOCTOR_TRANSPORT_LIMITS.tarballResponseBytes,
  );
  if (!response.ok)
    return err(
      authorityFailure(
        `npm tarball read failed for ${packageName}@${version} (HTTP ${response.status})`,
      ),
    );
  const sha512 = new Bun.CryptoHasher("sha512")
    .update(response.bytes)
    .digest("hex");
  const integrity = dist?.integrity;
  if (integrity !== undefined) {
    const declared = decodeSha512Integrity(integrity);
    if (declared === undefined)
      return err(
        authorityFailure(
          `npm dist.integrity is malformed for ${packageName}@${version}`,
        ),
      );
    if (declared !== sha512)
      return err(
        authorityFailure(
          `npm served bytes for ${packageName}@${version} that do not match its own dist.integrity`,
        ),
      );
  }
  const deprecated = readDeprecation(record.deprecated);
  if (deprecated === undefined)
    return err(
      authorityFailure(
        `npm deprecation field is malformed for ${packageName}@${version}`,
      ),
    );
  return ok({
    published: true,
    digest: `sha256:${new Bun.CryptoHasher("sha256").update(response.bytes).digest("hex")}`,
    sha512,
    deprecated,
  });
}

function readDeprecation(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (
    typeof value === "string" &&
    value.length <= AUTHORITY_BOUNDS.deprecationMessage
  )
    return value;
  return undefined;
}

function decodeSha512Integrity(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("sha512-"))
    return undefined;
  const base64 = value.slice("sha512-".length);
  if (base64.length === 0 || base64.length > 256) return undefined;
  const decoded = Result.fromThrowable(
    () => bytesFromBase64(base64),
    () => undefined,
  )();
  if (decoded.isErr()) return undefined;
  if (decoded.value.byteLength !== 64) return undefined;
  return [...decoded.value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------------------------------------------------------------------------
// npm provenance
// ---------------------------------------------------------------------------

type ProvenanceObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "bound" }
  | { readonly kind: "unbound"; readonly reason: string };

interface ProvenanceReadInput {
  readonly fetchImpl: GitHubFetch;
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly releasedSha: string;
  readonly tarballSha512: string;
}

/**
 * Reads npm's published provenance statement for one version.
 *
 * The doctor treats the registry's published attestation document as the
 * source-bound expected digest. It is accepted only when the in-toto subject
 * names exactly the bytes the registry served *and* the build's source commit
 * is the released commit; anything else is `unbound` or a typed failure.
 */
async function readProvenanceSubject(
  input: ProvenanceReadInput,
): Promise<Result<ProvenanceObservation, ReleaseStateError>> {
  const url = `${REGISTRY_ORIGIN}/-/npm/v1/attestations/${encodeURIComponent(`${input.packageName}@${input.version}`)}`;
  const document = await boundedJsonFetch(
    url,
    input.fetchImpl,
    DOCTOR_TRANSPORT_LIMITS.attestationResponseBytes,
  );
  if (document.status === 404) return ok({ kind: "absent" });
  if (!document.ok)
    return err(
      authorityFailure(
        `npm provenance read failed for ${input.packageName}@${input.version} (HTTP ${document.status})`,
      ),
    );
  const record = asRecord(document.value);
  const attestations = record?.attestations;
  if (
    !Array.isArray(attestations) ||
    attestations.length === 0 ||
    attestations.length > AUTHORITY_BOUNDS.attestations
  )
    return err(
      authorityFailure(
        `npm provenance document is malformed for ${input.packageName}@${input.version}`,
      ),
    );
  const statements: Record<string, unknown>[] = [];
  for (const entry of attestations) {
    const attestation = asRecord(entry);
    if (attestation === undefined)
      return err(
        authorityFailure(
          `npm provenance entry is malformed for ${input.packageName}@${input.version}`,
        ),
      );
    if (
      typeof attestation.predicateType !== "string" ||
      !SLSA_PREDICATE_TYPES.has(attestation.predicateType)
    )
      continue;
    const statement = decodeDsseStatement(attestation.bundle);
    if (statement === undefined)
      return err(
        authorityFailure(
          `npm provenance bundle is undecodable for ${input.packageName}@${input.version}`,
        ),
      );
    statements.push(statement);
  }
  if (statements.length === 0) return ok({ kind: "absent" });
  if (statements.length > 1)
    return err(
      authorityFailure(
        `npm published more than one provenance statement for ${input.packageName}@${input.version}`,
      ),
    );
  const statement = statements[0] as Record<string, unknown>;
  const subject = subjectSha512(statement.subject);
  if (subject === undefined)
    return err(
      authorityFailure(
        `npm provenance subject is malformed for ${input.packageName}@${input.version}`,
      ),
    );
  if (subject !== input.tarballSha512)
    return ok({
      kind: "unbound",
      reason: "the attested subject is not the published tarball",
    });
  const source = provenanceSourceCommit(statement.predicate);
  if (source === undefined)
    return err(
      authorityFailure(
        `npm provenance build definition is malformed for ${input.packageName}@${input.version}`,
      ),
    );
  if (!source.repositoryMatches)
    return ok({
      kind: "unbound",
      reason: "the attested build names another source repository",
    });
  if (source.commit !== input.releasedSha)
    return ok({
      kind: "unbound",
      reason: `the attested build names source commit ${source.commit}, not the released commit`,
    });
  return ok({ kind: "bound" });
}

function decodeDsseStatement(
  bundle: unknown,
): Record<string, unknown> | undefined {
  const envelope = asRecord(asRecord(bundle)?.dsseEnvelope);
  const payload = envelope?.payload;
  const payloadType = envelope?.payloadType;
  if (
    typeof payload !== "string" ||
    payload.length === 0 ||
    payload.length > DOCTOR_TRANSPORT_LIMITS.attestationResponseBytes ||
    payloadType !== "application/vnd.in-toto+json"
  )
    return undefined;
  const decoded = Result.fromThrowable(
    () =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytesFromBase64(payload),
      ),
    () => undefined,
  )();
  if (decoded.isErr()) return undefined;
  const parsed = Result.fromThrowable(
    () => JSON.parse(decoded.value) as unknown,
    () => undefined,
  )();
  if (parsed.isErr()) return undefined;
  return asRecord(parsed.value);
}

function subjectSha512(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value.length > AUTHORITY_BOUNDS.subjects
  )
    return undefined;
  const digest = asRecord(asRecord(value[0])?.digest);
  const sha512 = digest?.sha512;
  if (typeof sha512 !== "string" || !SHA512_HEX.test(sha512)) return undefined;
  return sha512;
}

function provenanceSourceCommit(
  predicate: unknown,
): { repositoryMatches: boolean; commit: string } | undefined {
  const record = asRecord(predicate);
  if (record === undefined) return undefined;
  const v1 = slsaV1Source(record);
  if (v1 !== undefined) return v1;
  return slsaV02Source(record);
}

function slsaV1Source(
  predicate: Record<string, unknown>,
): { repositoryMatches: boolean; commit: string } | undefined {
  const definition = asRecord(predicate.buildDefinition);
  if (definition === undefined) return undefined;
  const dependencies = definition.resolvedDependencies;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length === 0 ||
    dependencies.length > AUTHORITY_BOUNDS.resolvedDependencies
  )
    return undefined;
  for (const entry of dependencies) {
    const dependency = asRecord(entry);
    const uri = dependency?.uri;
    const commit = asRecord(dependency?.digest)?.gitCommit;
    if (typeof uri !== "string" || typeof commit !== "string") continue;
    if (!FULL_SHA.test(commit)) continue;
    return { repositoryMatches: sourceUriMatches(uri), commit };
  }
  return undefined;
}

function slsaV02Source(
  predicate: Record<string, unknown>,
): { repositoryMatches: boolean; commit: string } | undefined {
  const configSource = asRecord(asRecord(predicate.invocation)?.configSource);
  const uri = configSource?.uri;
  const digest = asRecord(configSource?.digest);
  const commit = digest?.sha1;
  if (
    typeof uri !== "string" ||
    typeof commit !== "string" ||
    !FULL_SHA.test(commit)
  )
    return undefined;
  return { repositoryMatches: sourceUriMatches(uri), commit };
}

function sourceUriMatches(uri: string): boolean {
  if (uri.length > AUTHORITY_BOUNDS.tarballUrlLength) return false;
  const base = uri.split("@")[0] ?? uri;
  return (
    SOURCE_REPOSITORY_URLS.has(base) ||
    SOURCE_REPOSITORY_URLS.has(base.replace(/\.git$/, ""))
  );
}

// ---------------------------------------------------------------------------
// Tags and releases
// ---------------------------------------------------------------------------

interface ReleaseRefObservation {
  readonly tags: Record<string, { commitSha: string }>;
  readonly releases: Record<string, { targetSha: string; notes: string }>;
}

async function readReleaseRefs(
  client: GitHubRestClient,
  members: readonly PackageMemberAuthority[],
): Promise<Result<ReleaseRefObservation, ReleaseStateError>> {
  const tags: Record<string, { commitSha: string }> = {};
  const releases: Record<string, { targetSha: string; notes: string }> = {};
  for (const member of members) {
    const tag = releaseTagName(member.packageName, member.version);
    const tagResult = await client.getRef(`refs/tags/${tag}`);
    if (tagResult.isOk()) {
      if (!FULL_SHA.test(tagResult.value))
        return err(authorityFailure(`tag ${tag} returned a malformed SHA`));
      tags[tag] = { commitSha: tagResult.value };
    } else if (tagResult.error.status !== 404) {
      return err(
        authorityFailure(`tag ${tag} read failed: ${tagResult.error.message}`),
      );
    }
    const releaseResult = await client.getRelease(tag);
    if (releaseResult.isOk()) {
      if (!FULL_SHA.test(releaseResult.value.targetSha))
        return err(
          authorityFailure(`release ${tag} returned a malformed target SHA`),
        );
      releases[tag] = {
        targetSha: releaseResult.value.targetSha,
        notes: releaseResult.value.notes,
      };
    } else if (releaseResult.error.status !== 404) {
      return err(
        authorityFailure(
          `release ${tag} read failed: ${releaseResult.error.message}`,
        ),
      );
    }
  }
  return ok({ tags, releases });
}

// ---------------------------------------------------------------------------
// Changeset cleanup, including a cleanup merged after the release
// ---------------------------------------------------------------------------

export interface ChangesetCleanupObservation {
  readonly cleanupRequired: boolean;
  readonly cleanupMerged: boolean;
  readonly consumed: readonly string[];
}

/**
 * Observes changeset cleanup at the release *and afterwards*.
 *
 * Cleanup is a separate pull request that merges after the release commit, so
 * reading the merged tree alone can only ever say "cleanup was required". The
 * later merge is observed by proving the released commit is an ancestor of
 * `main` and then reading `main`'s own tree: when none of the consumed
 * changesets survive there, the cleanup pull request merged.
 */
async function readChangesetCleanup(
  client: GitHubRestClient,
  releasedSha: string,
): Promise<Result<ChangesetCleanupObservation, ReleaseStateError>> {
  const releasedTree = await client.listCommitTreePaths(releasedSha);
  if (releasedTree.isErr())
    return err(
      authorityFailure(
        `release tree read failed: ${releasedTree.error.message}`,
      ),
    );
  const consumed = releasedTree.value.filter(isConsumedChangeset);
  if (consumed.length > AUTHORITY_BOUNDS.changesetPaths)
    return err(
      authorityFailure(
        "the released tree holds more changesets than the bound",
      ),
    );
  if (consumed.length === 0)
    return ok({ cleanupRequired: false, cleanupMerged: true, consumed: [] });

  const merged = await client.isMergedToMain(releasedSha);
  if (merged.isErr())
    return err(
      authorityFailure(`main ancestry read failed: ${merged.error.message}`),
    );
  if (!merged.value)
    return err(
      authorityFailure(
        "the released commit is not an ancestor of main, so cleanup cannot be observed",
      ),
    );
  const mainHead = await client.getRef("refs/heads/main");
  if (mainHead.isErr())
    return err(
      authorityFailure(`main ref read failed: ${mainHead.error.message}`),
    );
  if (!FULL_SHA.test(mainHead.value))
    return err(authorityFailure("main returned a malformed head SHA"));
  const mainTree = await client.listCommitTreePaths(mainHead.value);
  if (mainTree.isErr())
    return err(
      authorityFailure(`main tree read failed: ${mainTree.error.message}`),
    );
  const survivors = new Set(mainTree.value.filter(isConsumedChangeset));
  const cleanupMerged = consumed.every((path) => !survivors.has(path));
  return ok({ cleanupRequired: true, cleanupMerged, consumed });
}

function isConsumedChangeset(path: string): boolean {
  return (
    path.startsWith(".changeset/") &&
    path.endsWith(".md") &&
    path !== ".changeset/README.md"
  );
}

// ---------------------------------------------------------------------------
// Artifact cache and independent proof
// ---------------------------------------------------------------------------

interface ProofEvidence {
  readonly artifactCacheValid: boolean;
  readonly independentProofComplete: boolean;
}

/**
 * Reads the two proof signals an unpublished member still needs.
 *
 * `artifactCacheValid` asks whether the build's uploaded artifacts are still
 * retrievable — an expired or absent artifact is a true negative, not a guess.
 * `independentProofComplete` asks whether the separate attestation workflow
 * succeeded at the released commit. Both are read from GitHub Actions metadata
 * at the released commit; a malformed or failed read is a typed failure.
 */
async function readProofEvidence(
  client: GitHubRestClient,
  releasedSha: string,
): Promise<Result<ProofEvidence, ReleaseStateError>> {
  const publishRuns = await client.listWorkflowRunsForHeadSha(
    RELEASE_PUBLISH_WORKFLOW_PATH,
    releasedSha,
  );
  if (publishRuns.isErr())
    return err(
      authorityFailure(
        `publish workflow read failed: ${publishRuns.error.message}`,
      ),
    );
  if (publishRuns.value.length > AUTHORITY_BOUNDS.workflowRuns)
    return err(
      authorityFailure(
        "more publish runs at the released commit than the bound",
      ),
    );
  let artifactCacheValid = false;
  for (const run of publishRuns.value) {
    const artifacts = await client.listRunArtifacts(run.id);
    if (artifacts.isErr())
      return err(
        authorityFailure(
          `publish run ${run.id} artifact read failed: ${artifacts.error.message}`,
        ),
      );
    if (
      artifacts.value.length > 0 &&
      artifacts.value.every(
        (artifact) => !artifact.expired && artifact.digest !== undefined,
      )
    ) {
      artifactCacheValid = true;
      break;
    }
  }

  const attestRuns = await client.listWorkflowRunsForHeadSha(
    RELEASE_ATTEST_WORKFLOW_PATH,
    releasedSha,
  );
  if (attestRuns.isErr())
    return err(
      authorityFailure(
        `attestation workflow read failed: ${attestRuns.error.message}`,
      ),
    );
  if (attestRuns.value.length > AUTHORITY_BOUNDS.workflowRuns)
    return err(
      authorityFailure(
        "more attestation runs at the released commit than the bound",
      ),
    );
  const independentProofComplete = attestRuns.value.some(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  return ok({ artifactCacheValid, independentProofComplete });
}

// ---------------------------------------------------------------------------
// Integrity incident authorization
// ---------------------------------------------------------------------------

/**
 * Reads the authorized incident record from its check run at the released commit.
 *
 * The check run is created only by the protected incident-resolution operation
 * and lives on the commit it describes, so it is durable, GitHub-owned
 * authority. A check run that exists but cannot be parsed, or that names a
 * different released commit, fails the read instead of being ignored.
 */
async function readIncidentAuthorization(
  client: GitHubRestClient,
  releasedSha: string,
): Promise<Result<IncidentAuthorizationRecord | null, ReleaseStateError>> {
  const runs = await client.listNamedCheckRuns(
    releasedSha,
    INCIDENT_CHECK_RUN_NAME,
  );
  if (runs.isErr())
    return err(
      authorityFailure(`incident check run read failed: ${runs.error.message}`),
    );
  if (runs.value.length === 0) return ok(null);
  if (runs.value.length > AUTHORITY_BOUNDS.checkRuns)
    return err(
      authorityFailure(
        "more incident check runs than the bound at this commit",
      ),
    );
  const completed = runs.value.filter((run) => run.status === "completed");
  if (completed.length === 0)
    return err(
      authorityFailure(
        "an incident check run exists at the released commit but has not completed",
      ),
    );
  if (completed.length > 1)
    return err(
      authorityFailure(
        "more than one completed incident check run exists at the released commit",
      ),
    );
  const run = completed[0] as (typeof completed)[number];
  if (run.conclusion !== "success" && run.conclusion !== "neutral")
    return err(
      authorityFailure(
        `the incident check run at the released commit concluded ${run.conclusion ?? "null"}`,
      ),
    );
  const parsed = Result.fromThrowable(
    () => JSON.parse(run.output.text) as unknown,
    () => undefined,
  )();
  if (parsed.isErr())
    return err(
      authorityFailure(
        "the incident check run does not carry a parseable authorization record",
      ),
    );
  const record = validateIncidentAuthorizationRecord(parsed.value);
  if (record.isErr())
    return err(
      authorityFailure(
        "the incident check run carries an invalid authorization record",
      ),
    );
  if (record.value.releasedSha !== releasedSha)
    return err(
      authorityFailure(
        "the incident authorization record names another released commit",
      ),
    );
  return ok(record.value);
}

function incidentEvidence(
  record: IncidentAuthorizationRecord | null,
  members: readonly PackageMemberAuthority[],
  releases: Readonly<Record<string, { targetSha: string; notes: string }>>,
): Result<ReleaseAuthority["incident"], ReleaseStateError> {
  if (record === null) return ok(null);
  const affected: {
    packageName: PublicPackageName;
    version: string;
    digest: string;
  }[] = [];
  for (const entry of record.affected) {
    const member = members.find(
      (candidate) =>
        candidate.packageName === entry.packageName &&
        candidate.version === entry.version,
    );
    if (member === undefined)
      return err(
        authorityFailure(
          `the incident record names ${entry.packageName}@${entry.version}, which this release does not contain`,
        ),
      );
    affected.push({
      packageName: entry.packageName,
      version: entry.version,
      digest: entry.digest,
    });
  }
  const releasesCarryNotice = record.affected.every((entry) => {
    const notes = releases[releaseTagName(entry.packageName, entry.version)];
    return notes?.notes.includes(record.requiredMessage) === true;
  });
  const deprecationsMatch = record.affected.every((entry) => {
    const member = members.find(
      (candidate) =>
        candidate.packageName === entry.packageName &&
        candidate.version === entry.version,
    );
    return member?.deprecated === record.requiredMessage;
  });
  return ok({
    requiredMessage: record.requiredMessage,
    affected,
    // The record was read from a check run that GitHub attached to the released
    // commit; the reader refuses any run whose head SHA differs.
    checkRunAtReleasedSha: true,
    releasesCarryNotice,
    deprecationsMatch,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readJsonFileAtRef(
  client: GitHubRestClient,
  path: string,
  ref: string,
): Promise<Result<unknown, ReleaseStateError>> {
  const result = await client.readFileAtRef(path, ref);
  if (result.isErr())
    return err(
      authorityFailure(
        `GitHub file ${path} read failed: ${result.error.message}`,
      ),
    );
  const parsed = Result.fromThrowable(
    () => JSON.parse(result.value) as unknown,
    () => undefined,
  )();
  if (parsed.isErr())
    return err(authorityFailure(`GitHub file ${path} is not valid JSON`));
  return ok(parsed.value);
}

function readManifestVersion(
  value: unknown,
  path: string,
): Result<string, ReleaseStateError> {
  const record = asRecord(value);
  const version = record?.version;
  if (typeof version !== "string" || !SemVerSchema.safeParse(version).success)
    return err(
      authorityFailure(`GitHub file ${path} has no valid package version`),
    );
  return ok(version);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
