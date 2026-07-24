/**
 * Adapter-owned artifact file I/O and digest computation (Spec 33 §17;
 * docs/adapter-boundary.md "Artifact Integrity Metadata"). The engine only
 * owns `ArtifactIntegrityMetadata`'s type/format/fail-closed comparison; it
 * never reads artifact contents. This module reads bytes from a verified,
 * contained, no-follow-checked path under the canonical project root and
 * hashes those exact bytes - never a lexical-check-then-reopen. All
 * filesystem side effects are Bun-native (`Bun.file`) or routed through the
 * injected `PathContainmentPort` (`path-containment.ts`) - no `node:fs`.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import {
  makeArtifactDigestFailedFailure,
  makeArtifactReadFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  BunSecureRelativeFileProvider,
  isLexicallyContained,
  type SecureRelativeFileProvider,
} from "./path-containment.js";

export interface PiArtifactReadInput {
  readonly projectRoot: string;
  readonly relativePath: string;
}

export interface PiArtifactDigest {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly byteLength: number;
}

/**
 * Adapter-owned artifact port (docs/adapter-boundary.md: "artifact digest
 * computation ... = Adapter"). Production and fakes both implement this;
 * `PiWorkflowController` never reads files itself.
 */
export interface PiArtifactProvider {
  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure>;
}

/** Hashes bytes already read from the exact no-follow-verified path - pure, no reopen. */
function hashBytes(
  bytes: Uint8Array,
  relativePath: string,
): Result<PiArtifactDigest, PiAdapterFailure> {
  // Fixed, bounded reason only - never the raw thrown `Error.message`/stack,
  // which could otherwise carry absolute filesystem paths or other
  // internal detail into a failure's `correlation` field.
  const digestResult = Result.fromThrowable(
    () => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    (): string => "digest-computation-failed",
  )();
  if (digestResult.isErr()) {
    return err(
      makeArtifactDigestFailedFailure(relativePath, digestResult.error),
    );
  }
  return ok({
    algorithm: "sha256" as const,
    digest: digestResult.value,
    byteLength: bytes.byteLength,
  });
}

export class BunPiArtifactProvider implements PiArtifactProvider {
  private readonly provider: SecureRelativeFileProvider;

  constructor(
    provider: SecureRelativeFileProvider = new BunSecureRelativeFileProvider(),
  ) {
    this.provider = provider;
  }

  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure> {
    if (!isLexicallyContained(input.relativePath)) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path escapes the project root",
        ),
      );
    }
    // Reads bytes and computes identity from one no-follow-verified
    // descriptor chain (`SecureRelativeFileProvider.readFile`) - never a
    // lexical check followed by a separate path-based reopen (Spec 33
    // §17/§18).
    return this.provider
      .readFile(input.projectRoot, input.relativePath)
      .mapErr((reason) =>
        makeArtifactReadFailedFailure(input.relativePath, reason),
      )
      .andThen(({ bytes }) => hashBytes(bytes, input.relativePath));
  }
}

/** In-memory fake for isolated tests - no real filesystem access. */
export class FakePiArtifactProvider implements PiArtifactProvider {
  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  readAndDigest(
    input: PiArtifactReadInput,
  ): ResultAsync<PiArtifactDigest, PiAdapterFailure> {
    if (!isLexicallyContained(input.relativePath)) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path escapes the project root",
        ),
      );
    }
    const bytes = this.files.get(input.relativePath);
    if (bytes === undefined) {
      return errAsync(
        makeArtifactReadFailedFailure(
          input.relativePath,
          "path-component-missing",
        ),
      );
    }
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return okAsync({
      algorithm: "sha256" as const,
      digest,
      byteLength: bytes.byteLength,
    });
  }
}
