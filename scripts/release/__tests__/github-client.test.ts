import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import type { Clock } from "../clock.js";
import type { GitHubError } from "../errors.js";
import type { FileSystem } from "../filesystem.js";
import type {
  GitHubRelease,
  GitHubReleaseAsset,
  GitHubReleaseClient,
} from "../github-client.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";
import { ReleaseOrchestrator } from "../release-orchestrator.js";

const SHA = "a".repeat(40);
const VERSIONS = {
  "@weaveio/weave-cli": "1.2.3",
  "@weaveio/weave-adapter-opencode": "4.5.6",
};
const TAGS = ["weave-cli-v1.2.3", "weave-adapter-opencode-v4.5.6"] as const;
const bytes = new Uint8Array([1, 2, 3]);
const checksum = new TextEncoder().encode("checksum");
const digest = (value: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
function assetNames(tag: string): string[] {
  if (tag === TAGS[0])
    return [
      "@weaveio-weave-cli-1.2.3.tgz",
      "@weaveio-weave-cli-1.2.3.tgz.sha256",
    ];
  return [
    "@weaveio-weave-adapter-opencode-4.5.6.tgz",
    "@weaveio-weave-adapter-opencode-4.5.6.tgz.sha256",
  ];
}

class MockReleaseClient implements GitHubReleaseClient {
  readonly refs = new Map<string, string>();
  readonly releases = new Map<string, GitHubRelease>();
  readonly calls: string[] = [];
  immutableAfterPolls = 1;
  attestation = true;
  private nextId = 1;
  private polls = new Map<string, number>();

  getRef(ref: string) {
    const sha = this.refs.get(ref);
    return sha === undefined
      ? errAsync<never, GitHubError>({
          type: "GitHubError",
          operation: "getRef",
          status: 404,
          message: "missing",
        })
      : okAsync<string, GitHubError>(sha);
  }
  createRef(ref: string, sha: string) {
    this.calls.push(`createRef:${ref}`);
    this.refs.set(ref, sha);
    return okAsync<void, GitHubError>(undefined);
  }
  getRelease(tag: string) {
    const release = this.releases.get(tag);
    if (release === undefined)
      return errAsync<never, GitHubError>({
        type: "GitHubError",
        operation: "getRelease",
        status: 404,
        message: "missing",
      });
    if (!release.draft && !release.immutable) {
      const polls = (this.polls.get(tag) ?? 0) + 1;
      this.polls.set(tag, polls);
      if (polls >= this.immutableAfterPolls) release.immutable = true;
    }
    return okAsync<GitHubRelease, GitHubError>(release);
  }
  createDraftRelease(input: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
  }) {
    this.calls.push(`createDraft:${input.tag}`);
    const release: GitHubRelease = {
      id: this.nextId++,
      tag: input.tag,
      targetSha: input.targetSha,
      notes: input.notes,
      draft: true,
      immutable: false,
      assets: [],
    };
    this.releases.set(input.tag, release);
    return okAsync<GitHubRelease, GitHubError>(release);
  }
  uploadReleaseAsset(releaseId: number, name: string, value: Uint8Array) {
    this.calls.push(`upload:${releaseId}:${name}`);
    const release = this.release(releaseId);
    const asset: GitHubReleaseAsset = {
      id: this.nextId++,
      name,
      size: value.byteLength,
      digest: digest(value),
    };
    release.assets = [...release.assets, asset];
    return okAsync<GitHubReleaseAsset, GitHubError>(asset);
  }
  deleteReleaseAsset(releaseId: number, assetId: number) {
    this.calls.push(`delete:${releaseId}:${assetId}`);
    const release = this.release(releaseId);
    release.assets = release.assets.filter((asset) => asset.id !== assetId);
    return okAsync<void, GitHubError>(undefined);
  }
  publishRelease(releaseId: number) {
    this.calls.push(`publish:${releaseId}`);
    const release = this.release(releaseId);
    release.draft = false;
    return okAsync<GitHubRelease, GitHubError>(release);
  }
  hasReleaseAttestation(releaseId: number) {
    this.calls.push(`attestation:${releaseId}`);
    return okAsync<boolean, GitHubError>(this.attestation);
  }
  getTagVerification() {
    return okAsync<"unsigned", GitHubError>("unsigned");
  }
  private release(id: number): GitHubRelease {
    const release = [...this.releases.values()].find(
      (entry) => entry.id === id,
    );
    if (release === undefined) throw new Error("test fixture release missing");
    return release;
  }
}

function orchestrator(sleeps: number[] = []): ReleaseOrchestrator {
  const files: FileSystem = {
    exists: () => okAsync(false),
    readBytes: (path) => okAsync(path.endsWith(".sha256") ? checksum : bytes),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
    delete: () => okAsync(undefined),
  };
  const npm: NpmRegistryClient = {
    publish: () => okAsync(undefined),
    viewVersion: () => okAsync(""),
    listVersions: () => okAsync([]),
    viewDistTags: () => okAsync({}),
    distTagLs: () => okAsync({}),
    verifyPublished: () => okAsync(undefined),
  };
  const clock: Clock = {
    now: () => new Date(),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return okAsync(undefined);
    },
  };
  return new ReleaseOrchestrator(files, npm, clock);
}

function request(github: MockReleaseClient, attempts?: number) {
  const artifacts = Object.entries(VERSIONS).map(([packageName, version]) => {
    const filename = `${packageName.replace("/", "-")}-${version}.tgz`;
    return {
      filename,
      checksumFilename: `${filename}.sha256`,
      sizeBytes: bytes.byteLength,
      sha256: digest(bytes),
    };
  });
  return {
    authorization: {
      schemaVersion: 1,
      operation: "stable-publish",
      state: "awaiting-promotion",
      subjectSha: SHA,
      packages: Object.keys(VERSIONS),
      versions: VERSIONS,
      artifactDigests: Object.fromEntries(
        Object.keys(VERSIONS).map((name) => [name, digest(bytes)]),
      ),
    },
    manifest: {
      schemaVersion: 1,
      releaseSubjectSha: SHA,
      channel: "stable",
      packages: Object.keys(VERSIONS),
      versions: VERSIONS,
      artifacts,
    },
    artifactDirectory: "/artifacts",
    github,
    notes: "release notes",
    immutablePollAttempts: attempts,
  };
}

describe("app-only release references", () => {
  test("creates tags once and rejects a pre-existing different SHA", async () => {
    const github = new MockReleaseClient();
    github.refs.set(`refs/tags/${TAGS[0]}`, "b".repeat(40));
    const result = await orchestrator().stableReleaseRefs(request(github));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ReleaseRefMismatch");
    expect(github.calls).toEqual([]);
  });

  test("accepts exact existing tags without force, update, or delete paths", async () => {
    const github = new MockReleaseClient();
    for (const tag of TAGS) github.refs.set(`refs/tags/${tag}`, SHA);
    const result = await orchestrator().stableReleaseRefs(request(github));
    expect(result.isOk()).toBe(true);
    expect(
      github.calls.some((call) => /(?:force|updateRef|deleteRef)/.test(call)),
    ).toBe(false);
  });

  test("creates, uploads two assets per draft, publishes, polls, and verifies", async () => {
    const github = new MockReleaseClient();
    const sleeps: number[] = [];
    github.immutableAfterPolls = 2;
    const result = await orchestrator(sleeps).stableReleaseRefs(
      request(github),
    );
    expect(result.isOk()).toBe(true);
    expect(
      github.calls.filter((call) => call.startsWith("createDraft:")).length,
    ).toBe(2);
    expect(
      github.calls.filter((call) => call.startsWith("upload:")).length,
    ).toBe(4);
    expect(
      github.calls.filter((call) => call.startsWith("publish:")).length,
    ).toBe(2);
    expect(sleeps).toEqual([1000, 1000]);
    for (const release of github.releases.values()) {
      expect(release.immutable).toBe(true);
      expect(release.draft).toBe(false);
      expect(release.targetSha).toBe(SHA);
      expect(release.notes).toBe("release notes");
      expect(release.assets).toHaveLength(2);
      expect(release.assets.map((asset) => asset.size)).toEqual([
        bytes.byteLength,
        checksum.byteLength,
      ]);
      expect(release.assets.map((asset) => asset.digest)).toEqual([
        digest(bytes),
        digest(checksum),
      ]);
      expect(release.assets.map((asset) => asset.name)).toEqual(
        assetNames(release.tag),
      );
    }
  });

  test("resumes matching drafts, replacing only mismatched draft assets", async () => {
    const github = new MockReleaseClient();
    const draft = {
      id: 90,
      tag: TAGS[0],
      targetSha: SHA,
      notes: "release notes",
      draft: true,
      immutable: false,
      assets: [
        {
          id: 91,
          name: "@weaveio-weave-cli-1.2.3.tgz",
          size: 1,
          digest: "sha256:wrong",
        },
      ],
    } satisfies GitHubRelease;
    github.releases.set(TAGS[0], draft);
    const result = await orchestrator().stableReleaseRefs(request(github));
    expect(result.isOk()).toBe(true);
    expect(github.calls).toContain("delete:90:91");
    expect(
      github.calls.filter((call) => call.startsWith("upload:90:")).length,
    ).toBe(2);
    expect(github.calls).toContain("publish:90");
  });

  test("rejects published non-immutable releases without a mutation path", async () => {
    const github = new MockReleaseClient();
    github.releases.set(TAGS[0], {
      id: 1,
      tag: TAGS[0],
      targetSha: SHA,
      notes: "release notes",
      draft: false,
      immutable: false,
      assets: [],
    });
    const result = await orchestrator().stableReleaseRefs(request(github));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ReleaseMismatch");
    expect(github.calls).toEqual([
      `createRef:refs/tags/${TAGS[0]}`,
      `createRef:refs/tags/${TAGS[1]}`,
    ]);
  });

  test("times out through injected bounded polling and blocks absent attestations", async () => {
    const github = new MockReleaseClient();
    github.immutableAfterPolls = 99;
    const sleeps: number[] = [];
    const timeout = await orchestrator(sleeps).stableReleaseRefs(
      request(github, 2),
    );
    expect(timeout.isErr()).toBe(true);
    if (timeout.isErr())
      expect(timeout.error.type).toBe("ReleaseImmutableTimeout");
    expect(sleeps).toEqual([1000]);

    const unattested = new MockReleaseClient();
    unattested.attestation = false;
    const result = await orchestrator().stableReleaseRefs(request(unattested));
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ReleaseAttestationNotVerifiable");
  });

  test("treats only exact immutable releases as idempotent", async () => {
    const exact = new MockReleaseClient();
    for (const [index, tag] of TAGS.entries()) {
      exact.refs.set(`refs/tags/${tag}`, SHA);
      const packageName =
        index === 0 ? "@weaveio-weave-cli" : "@weaveio-weave-adapter-opencode";
      const version =
        index === 0
          ? VERSIONS["@weaveio/weave-cli"]
          : VERSIONS["@weaveio/weave-adapter-opencode"];
      const filename = `${packageName}-${version}.tgz`;
      exact.releases.set(tag, {
        id: index + 1,
        tag,
        targetSha: SHA,
        notes: "release notes",
        draft: false,
        immutable: true,
        assets: [
          {
            id: 10 + index,
            name: filename,
            size: bytes.byteLength,
            digest: digest(bytes),
          },
          {
            id: 20 + index,
            name: `${filename}.sha256`,
            size: checksum.byteLength,
            digest: digest(checksum),
          },
        ],
      });
    }
    const noOp = await orchestrator().stableReleaseRefs(request(exact));
    expect(noOp.isOk()).toBe(true);
    if (noOp.isOk()) expect(noOp.value.state).toBe("already-immutable");
    expect(exact.calls.every((call) => call.startsWith("attestation:"))).toBe(
      true,
    );

    const cases = [
      "tag",
      "target",
      "notes",
      "missing",
      "extra",
      "digest",
    ] as const;
    for (const mismatch of cases) {
      const github = new MockReleaseClient();
      const assets = [
        {
          id: 1,
          name: "@weaveio-weave-cli-1.2.3.tgz",
          size: bytes.byteLength,
          digest: digest(bytes),
        },
        {
          id: 2,
          name: "@weaveio-weave-cli-1.2.3.tgz.sha256",
          size: checksum.byteLength,
          digest: digest(checksum),
        },
      ];
      if (mismatch === "tag")
        github.releases.set(TAGS[0], {
          id: 1,
          tag: "other",
          targetSha: SHA,
          notes: "release notes",
          draft: false,
          immutable: true,
          assets,
        });
      else if (mismatch === "target")
        github.releases.set(TAGS[0], {
          id: 1,
          tag: TAGS[0],
          targetSha: "b".repeat(40),
          notes: "release notes",
          draft: false,
          immutable: true,
          assets,
        });
      else if (mismatch === "notes")
        github.releases.set(TAGS[0], {
          id: 1,
          tag: TAGS[0],
          targetSha: SHA,
          notes: "other",
          draft: false,
          immutable: true,
          assets,
        });
      else if (mismatch === "missing")
        github.releases.set(TAGS[0], {
          id: 1,
          tag: TAGS[0],
          targetSha: SHA,
          notes: "release notes",
          draft: false,
          immutable: true,
          assets: assets.slice(0, 1),
        });
      else if (mismatch === "extra")
        github.releases.set(TAGS[0], {
          id: 1,
          tag: TAGS[0],
          targetSha: SHA,
          notes: "release notes",
          draft: false,
          immutable: true,
          assets: [
            ...assets,
            { id: 3, name: "extra", size: 1, digest: digest(bytes) },
          ],
        });
      else
        github.releases.set(TAGS[0], {
          id: 1,
          tag: TAGS[0],
          targetSha: SHA,
          notes: "release notes",
          draft: false,
          immutable: true,
          assets: [{ ...assets[0], digest: "sha256:wrong" }, assets[1]],
        });
      const result = await orchestrator().stableReleaseRefs(request(github));
      expect(result.isErr(), mismatch).toBe(true);
      if (result.isErr())
        expect(result.error.type, mismatch).toBe("ReleaseMismatch");
    }
  });
});
