import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  type AcceptanceManifest,
  type AcceptanceManifestError,
  BunEvidenceFileReader,
  buildAcceptanceManifest,
  validateAcceptanceManifestStructure,
  verifyAcceptanceManifestEvidence,
} from "./acceptance-manifest.js";
import {
  ACCEPTANCE_MANIFEST_REQUIREMENTS,
  PACKED_PROOF_REGISTRY,
} from "./acceptance-manifest-data.js";
import { PackagePolicyValidator } from "./package-policy.js";
import {
  BunPackageCommandRunner,
  type PackagerError,
  PublicPackagePackager,
} from "./packager.js";
import {
  BunSmokeChecklistReader,
  parseSmokeChecklist,
  type SmokeChecklistParseError,
  type SmokeChecklistReadError,
} from "./smoke-checklist.js";

/**
 * Regenerates both committed acceptance manifests from the source-controlled
 * requirement rows in `acceptance-manifest-data.ts`:
 * - `scripts/release/pi-acceptance/acceptance-manifest.json`
 * - `docs/specs/33-spec-pi-adapter/acceptance-manifest.json`
 *
 * The `artifactBinding` this script produces is computed from a *real* local
 * pack of the current working tree (a genuine sha256 of an actually-built
 * tarball, the actual git HEAD as `subjectSha`) - never fabricated values.
 * It is explicitly **not** a claim that this binding has been through the
 * real release pipeline: `payloadArtifactId` is a clearly-labeled local
 * identifier and `runAttempt` is fixed at `1` for a local/dev regeneration.
 * A real stable release replaces this block with the exact GitHub Actions
 * artifact identity before the live TUI smoke checklist is run against it
 * (Pi adapter contract's `pi-stable-smoke` gate).
 *
 * Every requirement's `result` stays whatever `acceptance-manifest-data.ts`
 * declares (`"pending"` until the checklist has actually been executed and
 * the data file updated by hand) - this script never upgrades a result.
 */
export interface GeneratedAcceptanceManifestResult {
  readonly manifest: AcceptanceManifest;
  readonly evidenceOk: boolean;
}

export type GenerateAcceptanceManifestError =
  | { readonly type: "PackageJsonReadFailed"; readonly cause: string }
  | { readonly type: "PackFailed"; readonly cause: PackagerError }
  | { readonly type: "TarballReadFailed"; readonly cause: string }
  | { readonly type: "GitHeadResolutionFailed" }
  | {
      readonly type: "SmokeChecklistReadFailed";
      readonly cause: SmokeChecklistReadError;
    }
  | {
      readonly type: "SmokeChecklistParseFailed";
      readonly cause: SmokeChecklistParseError;
    }
  | {
      readonly type: "StructuralValidationFailed";
      readonly cause: readonly AcceptanceManifestError[];
    };

async function generateAcceptanceManifestUnsafe(
  root: string,
): Promise<
  Result<GeneratedAcceptanceManifestResult, GenerateAcceptanceManifestError>
> {
  const packageJsonResult = await ResultAsync.fromPromise(
    Bun.file(`${root}/packages/adapters/pi/package.json`).json() as Promise<{
      version: string;
    }>,
    (cause): GenerateAcceptanceManifestError => ({
      type: "PackageJsonReadFailed",
      cause: String(cause),
    }),
  );
  if (packageJsonResult.isErr()) return err(packageJsonResult.error);
  const packageJson = packageJsonResult.value;

  const packager = new PublicPackagePackager(
    new BunPackageCommandRunner(),
    new PackagePolicyValidator(),
  );
  // `pack()`'s `root` argument is a scratch working directory for staging
  // and destination files, never the real project tree - mirrors the
  // convention already used by pi-adapter-packed.test.ts and
  // pi-adapter-fake-host-consumer.test.ts so this generator never writes a
  // `staging/` directory into the real repository.
  const scratchRoot = `${root}/.release/acceptance-manifest-pack-${crypto.randomUUID()}`;
  const packed = await packager.pack(
    "@weaveio/weave-adapter-pi",
    scratchRoot,
    `${scratchRoot}/out`,
  );
  if (packed.isErr()) return err({ type: "PackFailed", cause: packed.error });

  const tarballBytesResult = await ResultAsync.fromPromise(
    Bun.file(packed.value).arrayBuffer(),
    (cause): GenerateAcceptanceManifestError => ({
      type: "TarballReadFailed",
      cause: String(cause),
    }),
  );
  await ResultAsync.fromPromise(
    Bun.$`rm -rf ${scratchRoot}`.quiet(),
    () => undefined,
  );
  if (tarballBytesResult.isErr()) return err(tarballBytesResult.error);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(tarballBytesResult.value))
    .digest("hex");

  const gitHead = Bun.spawnSync({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: root,
    stdout: "pipe",
  });
  const subjectSha = new TextDecoder().decode(gitHead.stdout).trim();
  if (!gitHead.success || !/^[0-9a-f]{40}$/.test(subjectSha))
    return err({ type: "GitHeadResolutionFailed" });

  const checklistMarkdownResult = await new BunSmokeChecklistReader().read();
  if (checklistMarkdownResult.isErr())
    return err({
      type: "SmokeChecklistReadFailed",
      cause: checklistMarkdownResult.error,
    });

  const parsedChecklist = parseSmokeChecklist(checklistMarkdownResult.value);
  if (parsedChecklist.isErr())
    return err({
      type: "SmokeChecklistParseFailed",
      cause: parsedChecklist.error,
    });

  const manifest = buildAcceptanceManifest({
    artifactBinding: {
      packageVersion: packageJson.version,
      payloadArtifactId: "local-dev-pack",
      sha256,
      subjectSha,
      runAttempt: 1,
      checklistVersion: parsedChecklist.value.version,
    },
    requirements: ACCEPTANCE_MANIFEST_REQUIREMENTS,
  });

  const structural = validateAcceptanceManifestStructure(manifest);
  if (structural.isErr())
    return err({
      type: "StructuralValidationFailed",
      cause: structural.error,
    });

  const evidence = await verifyAcceptanceManifestEvidence(manifest, {
    reader: new BunEvidenceFileReader(root),
    packedProofRegistry: PACKED_PROOF_REGISTRY,
    checklistResults: new Map(
      parsedChecklist.value.items.map((item) => [item.id, item.result]),
    ),
  });

  return ok({ manifest, evidenceOk: evidence.ok });
}

/**
 * Fallible entry point: never throws. Every step above returns an explicit
 * `Result`/`ResultAsync` and the whole pipeline is wrapped as one
 * `ResultAsync` so callers (tests, the CLI entrypoint below) get a typed
 * error instead of a rejected promise.
 */
export function generateAcceptanceManifest(
  root: string,
): ResultAsync<
  GeneratedAcceptanceManifestResult,
  GenerateAcceptanceManifestError
> {
  return ResultAsync.fromSafePromise(
    generateAcceptanceManifestUnsafe(root),
  ).andThen((result) => result);
}

if (import.meta.main) {
  const log = logger.child({ module: "generate-acceptance-manifest" });
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  await generateAcceptanceManifest(root).match(
    async ({ manifest, evidenceOk }) => {
      if (!evidenceOk) {
        log.error(
          "acceptance manifest evidence verification failed; not writing file",
        );
        process.exitCode = 1;
        return;
      }
      const body = `${JSON.stringify(manifest, null, 2)}\n`;
      const paths = [
        `${root}/scripts/release/pi-acceptance/acceptance-manifest.json`,
        `${root}/docs/specs/33-spec-pi-adapter/acceptance-manifest.json`,
      ] as const;
      for (const path of paths) {
        await Bun.write(path, body);
        log.info({ path }, "wrote acceptance manifest");
      }
    },
    (error) => {
      log.error({ error }, "failed to generate acceptance manifest");
      process.exitCode = 1;
    },
  );
}
