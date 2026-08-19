import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  createExtensionBuildManifest,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  type ExtensionBuildIdentityManifest,
  type ExtensionLoadedIdentity,
  evaluateExtensionBuildIdentity,
  parseExtensionBuildIdentityProof,
  renderExtensionBuildIdentityHealthLine,
  renderExtensionBuildIdentityProofLine,
  renderExtensionBuildManifest,
} from "../../../packages/adapters/pi/src/extension-build-identity.js";
import {
  classifyChildStreamingEvidence,
  type IdentityVerificationSuccess,
  parseVerifyChildStreamingArgs,
  runAfterIdentity,
  verifyIdentityFacts,
} from "../verify-child-streaming.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SUBJECT = "1".repeat(40);
const BUILD_COMPLETED_AT = "1970-01-01T00:00:00.100Z";

function runtimeOutputs(digest: string): { name: string; sha256: string }[] {
  return EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
    name,
    sha256: digest,
  }));
}

function manifest(
  extension = A,
  implementation = extension,
  buildIdentity = extension,
  hostLoader = extension,
): ExtensionBuildIdentityManifest {
  const created = createExtensionBuildManifest({
    subject: SUBJECT,
    dirty: false,
    buildInputs: [B, A],
    outputs: [
      { name: "index", sha256: B },
      { name: "extension", sha256: extension },
      { name: "extension-build-identity", sha256: buildIdentity },
      { name: "extension-impl", sha256: implementation },
      { name: "host-module-loader", sha256: hostLoader },
    ],
    buildCompletedAt: BUILD_COMPLETED_AT,
  });
  expect(created.isOk()).toBe(true);
  return created._unsafeUnwrap();
}

function loaded(
  artifactSha256: string | undefined,
  loadTimeMs = 200,
  outputDigest = artifactSha256,
): ExtensionLoadedIdentity {
  return {
    artifactPath: "/artifact/extension.js",
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    ...(outputDigest === undefined
      ? {}
      : { loadedOutputs: runtimeOutputs(outputDigest) }),
    loadTimeMs,
    processStartMs: 1,
  };
}

function facts(
  overrides: Partial<Parameters<typeof verifyIdentityFacts>[0]> = {},
) {
  return {
    manifest: manifest(),
    currentBuildInputs: [A, B],
    currentOutputs: [
      { name: "extension", sha256: A },
      { name: "extension-build-identity", sha256: A },
      { name: "extension-impl", sha256: A },
      { name: "host-module-loader", sha256: A },
      { name: "index", sha256: B },
    ],
    currentSubject: SUBJECT,
    currentDirty: false,
    loadedProof: {
      schemaVersion: 1 as const,
      artifactSha256: A,
      loadedOutputs: runtimeOutputs(A),
      loadTimeMs: 200,
      processStartMs: 1,
    },
    nowMs: 300,
    ...overrides,
  };
}

describe("extension build identity manifest", () => {
  it("contains sorted digest values and no filesystem paths", () => {
    const rendered = renderExtensionBuildManifest(manifest());
    expect(rendered.isOk()).toBe(true);
    const text = rendered._unsafeUnwrap();
    expect(text).not.toContain("packages/");
    expect(text).not.toContain("/artifact/");
    const parsed = JSON.parse(text) as ExtensionBuildIdentityManifest;
    expect(parsed.buildInputs).toEqual([A, B]);
    expect(parsed.outputs.map((output) => output.name)).toEqual([
      "extension",
      "extension-build-identity",
      "extension-impl",
      "host-module-loader",
      "index",
    ]);
    expect(parsed.git).toEqual({ subject: SUBJECT, dirty: false });
  });

  it("rejects an unsorted or incomplete manifest instead of guessing", () => {
    const rendered = renderExtensionBuildManifest({
      ...manifest(),
      buildInputs: [B, A],
    });
    expect(rendered.isErr()).toBe(true);
  });
});

describe("extension runtime identity states", () => {
  it("reports current only when loaded, disk, and manifest digests agree", () => {
    const health = evaluateExtensionBuildIdentity({
      loaded: loaded(A),
      diskArtifactSha256: A,
      diskOutputs: runtimeOutputs(A),
      manifest: manifest(),
    });
    expect(health.state).toBe("current");
    const line = renderExtensionBuildIdentityHealthLine(health);
    expect(line).toContain("extension identity: current");
    expect(line).toContain(`loaded=${A}`);
    expect(line).not.toContain("/artifact/");
  });

  it("is RED when build A was loaded and disk now contains build B", () => {
    const health = evaluateExtensionBuildIdentity({
      loaded: loaded(A),
      diskArtifactSha256: B,
      diskOutputs: runtimeOutputs(B),
      manifest: manifest(B),
    });
    expect(health.state).toBe("stale-on-disk");
  });

  it("is RED for a valid sidecar whose extension output digest is wrong", () => {
    const health = evaluateExtensionBuildIdentity({
      loaded: loaded(A),
      diskArtifactSha256: A,
      diskOutputs: runtimeOutputs(A),
      manifest: manifest(B),
    });
    expect(health.state).toBe("manifest-mismatch");
  });

  it("is RED when the implementation changes while the thin entry stays unchanged", () => {
    const health = evaluateExtensionBuildIdentity({
      loaded: loaded(A),
      diskArtifactSha256: A,
      diskOutputs: [
        { name: "extension", sha256: A },
        { name: "extension-build-identity", sha256: A },
        { name: "extension-impl", sha256: B },
        { name: "host-module-loader", sha256: A },
      ],
      manifest: manifest(A, B, A, A),
    });
    expect(health.state).toBe("stale-on-disk");
  });

  it("is RED and unverifiable when the sidecar or output cannot be read", () => {
    expect(
      evaluateExtensionBuildIdentity({
        loaded: loaded(A),
        manifestReason: "manifest-malformed",
      }).state,
    ).toBe("unverifiable");
    expect(
      evaluateExtensionBuildIdentity({
        loaded: loaded(A),
        manifest: manifest(),
      }).state,
    ).toBe("unverifiable");
    expect(
      evaluateExtensionBuildIdentity({
        loaded: loaded(undefined),
        diskArtifactSha256: A,
        manifest: manifest(),
      }).state,
    ).toBe("unverifiable");
  });

  it("records reload adoption without treating reload as fresh-parent proof", () => {
    expect(
      evaluateExtensionBuildIdentity({
        loaded: loaded(A),
        diskArtifactSha256: B,
        diskOutputs: runtimeOutputs(B),
        manifest: manifest(B),
      }).state,
    ).toBe("stale-on-disk");
    expect(
      evaluateExtensionBuildIdentity({
        loaded: loaded(B),
        diskArtifactSha256: B,
        diskOutputs: runtimeOutputs(B),
        manifest: manifest(B),
      }).state,
    ).toBe("current");
    expect(
      verifyIdentityFacts(
        facts({
          manifest: manifest(B),
          currentOutputs: [
            { name: "extension", sha256: B },
            { name: "index", sha256: B },
          ],
          loadedProof: undefined,
        }),
      ).isErr(),
    ).toBe(true);
  });
});

describe("independent child-streaming verifier gate", () => {
  it("accepts only a complete current identity proof", () => {
    const result = verifyIdentityFacts(facts());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().evidence).toBe("identity-proven");
  });

  it("rejects stale, corrupt, mismatched, and unverifiable facts", () => {
    expect(
      verifyIdentityFacts(
        facts({
          currentOutputs: [
            { name: "extension", sha256: B },
            { name: "extension-build-identity", sha256: B },
            { name: "extension-impl", sha256: B },
            { name: "host-module-loader", sha256: B },
            { name: "index", sha256: B },
          ],
        }),
      )._unsafeUnwrapErr().type,
    ).toBe("output-mismatch");
    expect(
      verifyIdentityFacts(
        facts({
          loadedProof: {
            schemaVersion: 1,
            artifactSha256: B,
            loadedOutputs: runtimeOutputs(B),
            loadTimeMs: 200,
            processStartMs: 1,
          },
        }),
      )._unsafeUnwrapErr().type,
    ).toBe("stale-on-disk");
    const manifestMismatch = verifyIdentityFacts(
      facts({ manifest: manifest(B) }),
    )._unsafeUnwrapErr();
    expect(manifestMismatch.type).toBe("output-mismatch");
    expect(manifestMismatch.state).toBe("manifest-mismatch");
    expect(
      verifyIdentityFacts(facts({ loadedProof: undefined }))._unsafeUnwrapErr()
        .type,
    ).toBe("unverifiable");
  });

  it("rejects a stale implementation when the thin loader entry is unchanged", () => {
    const result = verifyIdentityFacts(
      facts({
        // Build B changed only the runtime implementation graph. The thin
        // extension entry remains build A's exact bytes.
        manifest: manifest(A, B, A, A),
        currentOutputs: [
          { name: "extension", sha256: A },
          { name: "extension-build-identity", sha256: A },
          { name: "extension-impl", sha256: B },
          { name: "host-module-loader", sha256: A },
          { name: "index", sha256: B },
        ],
      }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("stale-on-disk");
    expect(result._unsafeUnwrapErr().state).toBe("stale-on-disk");
  });

  it("blocks all later checks when identity fails", async () => {
    let called = false;
    const result = await runAfterIdentity(
      verifyIdentityFacts(facts({ loadedProof: undefined })),
      () => {
        called = true;
        return okAsync("should-not-run");
      },
    );
    expect(result.isErr()).toBe(true);
    expect(called).toBe(false);

    const passed = await runAfterIdentity(
      verifyIdentityFacts(facts()),
      (_proof: IdentityVerificationSuccess) => {
        called = true;
        return errAsync("later-ui-check-failed" as const);
      },
    );
    expect(passed.isErr()).toBe(true);
    expect(called).toBe(true);
  });

  it("requires the explicit current-build flag and Pi executable", () => {
    expect(parseVerifyChildStreamingArgs(["identity"]).isErr()).toBe(true);
    const parsed = parseVerifyChildStreamingArgs([
      "identity",
      "--pi",
      "/usr/local/bin/pi",
      "--require-current-build",
    ]);
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual({
      command: "identity",
      pi: "/usr/local/bin/pi",
      requireCurrentBuild: true,
    });
  });

  it("parses and emits a bounded path-free loader proof", () => {
    const identity = loaded(C);
    const line = renderExtensionBuildIdentityProofLine(identity);
    expect(line).not.toContain("/artifact/");
    const parsed = parseExtensionBuildIdentityProof(JSON.parse(line));
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap().artifactSha256).toBe(C);
    expect(
      parsed
        ._unsafeUnwrap()
        .loadedOutputs?.find((output) => output.name === "extension-impl")
        ?.sha256,
    ).toBe(C);
  });

  it("rejects path-shaped loaded output facts", () => {
    const parsed = parseExtensionBuildIdentityProof({
      weaveExtensionBuildIdentity: {
        schemaVersion: 1,
        artifactSha256: C,
        loadedOutputs: [{ name: "/tmp/extension-impl.js", sha256: C }],
        loadTimeMs: 200,
        processStartMs: 1,
      },
    });
    expect(parsed.isErr()).toBe(true);
  });

  it("distinguishes stale screenshots, the post-build RED repro, and identity-proven proof", () => {
    expect(
      classifyChildStreamingEvidence({
        identity: verifyIdentityFacts(
          facts({
            loadedProof: {
              schemaVersion: 1,
              artifactSha256: B,
              loadedOutputs: runtimeOutputs(B),
              loadTimeMs: 200,
              processStartMs: 1,
            },
          }),
        ),
      }),
    ).toBe("stale-screenshot");
    expect(
      classifyChildStreamingEvidence({
        identity: verifyIdentityFacts(facts({ loadedProof: undefined })),
      }),
    ).toBe("blocked");
    expect(
      classifyChildStreamingEvidence({
        identity: verifyIdentityFacts(facts()),
        uiLanes: "red",
      }),
    ).toBe("post-build-red-reproduction");
    expect(
      classifyChildStreamingEvidence({
        identity: verifyIdentityFacts(facts()),
        uiLanes: "green",
      }),
    ).toBe("identity-proven");
  });
});
