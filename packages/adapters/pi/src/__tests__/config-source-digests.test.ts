import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, okAsync } from "neverthrow";
import {
  classifyConfigSourceChange,
  createPiConfigSourceFsPort,
  createPiConfigSourceManifest,
  discoverPromptSourcePaths,
  getPiBuiltinSourceDigest,
  hashConfigSourceContent,
  PI_CONFIG_SOURCE_DIGEST_PATTERN,
  type PiConfigSourceEntry,
  type PiConfigSourceFileHandle,
  type PiConfigSourceFsError,
  type PiConfigSourceFsPort,
  type PiConfigSourceManifest,
  probeConfigSources,
  refreshChangedSources,
  refreshConfigSourceManifest,
  resolvePiConfigSourcePaths,
} from "../config-source-digests.js";

// ---------------------------------------------------------------------------
// Fake filesystem port — never touches the real filesystem
// ---------------------------------------------------------------------------

interface FakeFile {
  readonly content: string;
  readonly size?: number;
  readonly mtimeMs: number;
}

interface FakeFs extends PiConfigSourceFsPort {
  readonly statCalls: string[];
  readonly readCalls: string[];
}

function fakeFs(
  files: Record<string, FakeFile>,
  failures: {
    readonly stat?: Record<string, string>;
    readonly read?: Record<string, string>;
  } = {},
): FakeFs {
  const statCalls: string[] = [];
  const readCalls: string[] = [];

  return {
    statCalls,
    readCalls,
    statFile: (path) => {
      statCalls.push(path);
      const failure = failures.stat?.[path];
      if (failure !== undefined) {
        return errAsync<undefined, PiConfigSourceFsError>({
          type: "StatFailed",
          path,
          message: failure,
        });
      }
      const file = files[path];
      if (file === undefined) return okAsync(undefined);
      return okAsync({
        size: file.size ?? file.content.length,
        mtimeMs: file.mtimeMs,
      });
    },
    readFile: (path) => {
      readCalls.push(path);
      const failure = failures.read?.[path];
      if (failure !== undefined) {
        return errAsync<string, PiConfigSourceFsError>({
          type: "ReadFailed",
          path,
          message: failure,
        });
      }
      const file = files[path];
      if (file === undefined) {
        return errAsync<string, PiConfigSourceFsError>({
          type: "ReadFailed",
          path,
          message: "missing",
        });
      }
      return okAsync(file.content);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY = { projectRoot: "/my/project", trust: "trusted" } as const;
const GLOBAL_CONFIG = "/home/tester/.weave/config.weave";
const PROJECT_CONFIG = "/my/project/.weave/config.weave";
const PROMPT_A = "/my/project/.weave/prompts/a.md";
const PROMPT_B = "/my/project/.weave/prompts/b.md";

const GLOBAL_TEXT = 'agent alpha {\n  prompt "global"\n}\n';
const PROJECT_TEXT = 'agent beta {\n  prompt "project"\n}\n';
const PROMPT_A_TEXT = "# prompt a\n";
const PROMPT_B_TEXT = "# prompt b\n";

function entry(
  kind: PiConfigSourceEntry["kind"],
  path: string,
  content: string,
  mtimeMs: number,
): PiConfigSourceEntry {
  return {
    kind,
    path,
    presence: "present",
    size: content.length,
    mtimeMs,
    sha256: hashConfigSourceContent(content),
  };
}

function seededManifest(): PiConfigSourceManifest {
  return {
    identity: IDENTITY,
    builtin: { kind: "builtin", sha256: getPiBuiltinSourceDigest() },
    files: [
      entry("global-config", GLOBAL_CONFIG, GLOBAL_TEXT, 1_000),
      entry("project-config", PROJECT_CONFIG, PROJECT_TEXT, 2_000),
      entry("prompt-file", PROMPT_A, PROMPT_A_TEXT, 3_000),
      entry("prompt-file", PROMPT_B, PROMPT_B_TEXT, 4_000),
    ],
  };
}

function currentFiles(): Record<string, FakeFile> {
  return {
    [GLOBAL_CONFIG]: { content: GLOBAL_TEXT, mtimeMs: 1_000 },
    [PROJECT_CONFIG]: { content: PROJECT_TEXT, mtimeMs: 2_000 },
    [PROMPT_A]: { content: PROMPT_A_TEXT, mtimeMs: 3_000 },
    [PROMPT_B]: { content: PROMPT_B_TEXT, mtimeMs: 4_000 },
  };
}

function findEntry(
  manifest: PiConfigSourceManifest,
  path: string,
): PiConfigSourceEntry {
  const found = manifest.files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`no manifest entry for ${path}`);
  return found;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

describe("config source digests", () => {
  it("hashes content as lowercase 64-hex SHA-256 matching a known vector", () => {
    const digest = hashConfigSourceContent("abc");
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(digest).toMatch(PI_CONFIG_SOURCE_DIGEST_PATTERN);
    expect(hashConfigSourceContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("gives the builtin layer a process-stable 64-hex digest", () => {
    const first = getPiBuiltinSourceDigest();
    const second = getPiBuiltinSourceDigest();
    expect(first).toMatch(PI_CONFIG_SOURCE_DIGEST_PATTERN);
    expect(second).toBe(first);
  });

  it("never probes the builtin source", async () => {
    const fs = fakeFs(currentFiles());
    const result = await refreshConfigSourceManifest(seededManifest(), fs);
    expect(result.isOk()).toBe(true);
    expect(fs.statCalls).not.toContain("builtin");
    expect(fs.statCalls.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Manifest construction and path resolution
// ---------------------------------------------------------------------------

describe("createPiConfigSourceManifest", () => {
  it("orders sources deterministically and starts unknown files absent", () => {
    const manifest = createPiConfigSourceManifest({
      identity: IDENTITY,
      globalConfigPath: GLOBAL_CONFIG,
      projectConfigPath: PROJECT_CONFIG,
      promptFilePaths: [PROMPT_B, PROMPT_A],
    });

    expect(manifest.files.map((file) => file.path)).toEqual([
      GLOBAL_CONFIG,
      PROJECT_CONFIG,
      PROMPT_A,
      PROMPT_B,
    ]);
    expect(manifest.files.map((file) => file.kind)).toEqual([
      "global-config",
      "project-config",
      "prompt-file",
      "prompt-file",
    ]);
    for (const file of manifest.files) {
      expect(file.presence).toBe("absent");
      expect(file.size).toBeUndefined();
      expect(file.mtimeMs).toBeUndefined();
      expect(file.sha256).toBeUndefined();
    }
    expect(manifest.builtin.sha256).toBe(getPiBuiltinSourceDigest());
  });

  it("carries known entries over and drops dropped references", () => {
    const rebuilt = createPiConfigSourceManifest({
      identity: IDENTITY,
      globalConfigPath: GLOBAL_CONFIG,
      projectConfigPath: PROJECT_CONFIG,
      promptFilePaths: [PROMPT_A],
      previous: seededManifest(),
    });

    expect(rebuilt.files.map((file) => file.path)).toEqual([
      GLOBAL_CONFIG,
      PROJECT_CONFIG,
      PROMPT_A,
    ]);
    expect(findEntry(rebuilt, PROMPT_A).sha256).toBe(
      hashConfigSourceContent(PROMPT_A_TEXT),
    );
  });

  it("omits the project config when trust is withheld", () => {
    const paths = resolvePiConfigSourcePaths({
      identity: { projectRoot: "/my/project", trust: "withheld" },
      homeDir: "/home/tester",
    });
    expect(paths.globalConfigPath).toBe(GLOBAL_CONFIG);
    expect(paths.projectConfigPath).toBeUndefined();

    const trusted = resolvePiConfigSourcePaths({
      identity: IDENTITY,
      homeDir: "/home/tester",
    });
    expect(trusted.projectConfigPath).toBe(PROJECT_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// Prompt reference discovery
// ---------------------------------------------------------------------------

describe("discoverPromptSourcePaths", () => {
  it("finds every prompt-file reference and ignores inline prompts", () => {
    const config = {
      agents: {
        alpha: {
          prompt_file: "/root/prompts/alpha.md",
          prompt_append_file: "/root/prompts/alpha-append.md",
        },
        beta: { prompt: "inline only" },
        gamma: { prompt: 'multi\n\nline """ style' },
      },
      categories: {
        review: { prompt_append_file: "/root/prompts/review.md" },
        plain: { prompt_append: "inline append" },
      },
      workflows: {
        build: {
          prompt_append_file: "/root/prompts/build.md",
          steps: [
            { prompt: "inline step", prompt_append: "inline append" },
            { prompt_append_file: "/root/prompts/step.md" },
            { prompt_append_file: "/root/prompts/alpha.md" },
          ],
        },
      },
    } as unknown as WeaveConfig;

    expect(discoverPromptSourcePaths(config)).toEqual([
      "/root/prompts/alpha-append.md",
      "/root/prompts/alpha.md",
      "/root/prompts/build.md",
      "/root/prompts/review.md",
      "/root/prompts/step.md",
    ]);
  });

  it("returns nothing for a config with only inline prompts", () => {
    const config = {
      agents: { alpha: { prompt: "inline" } },
      categories: {},
      workflows: {},
    } as unknown as WeaveConfig;
    expect(discoverPromptSourcePaths(config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Probe + refresh classification
// ---------------------------------------------------------------------------

describe("refreshConfigSourceManifest", () => {
  it("reports unchanged and reads nothing when metadata matches", async () => {
    const fs = fakeFs(currentFiles());
    const result = await refreshConfigSourceManifest(seededManifest(), fs);

    expect(result.isOk()).toBe(true);
    const refresh = result._unsafeUnwrap();
    expect(refresh.change).toEqual({ kind: "unchanged" });
    expect(fs.readCalls).toEqual([]);
    expect(fs.statCalls.sort()).toEqual(
      [GLOBAL_CONFIG, PROJECT_CONFIG, PROMPT_A, PROMPT_B].sort(),
    );
    expect(refresh.reads).toEqual([]);
    expect(refresh.manifest.files).toEqual(seededManifest().files);
  });

  it("classifies every known file, including absent ones", async () => {
    const manifest = createPiConfigSourceManifest({
      identity: IDENTITY,
      globalConfigPath: GLOBAL_CONFIG,
      projectConfigPath: PROJECT_CONFIG,
      promptFilePaths: [PROMPT_A],
      previous: seededManifest(),
    });
    const withoutGlobal = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === GLOBAL_CONFIG
          ? {
              ...file,
              presence: "absent" as const,
              size: undefined,
              mtimeMs: undefined,
              sha256: undefined,
            }
          : file,
      ),
    };
    const files = currentFiles();
    delete files[GLOBAL_CONFIG];
    files[PROMPT_A] = { content: PROMPT_A_TEXT, mtimeMs: 9_999 };

    const probes = (
      await probeConfigSources(withoutGlobal, fakeFs(files))
    )._unsafeUnwrap();

    expect(probes.map((probe) => [probe.entry.path, probe.status])).toEqual([
      [GLOBAL_CONFIG, "absent-unchanged"],
      [PROJECT_CONFIG, "unchanged"],
      [PROMPT_A, "maybe-changed"],
    ]);
  });

  it("updates metadata without reporting a change when the hash matches", async () => {
    const files = currentFiles();
    files[PROMPT_A] = { content: PROMPT_A_TEXT, mtimeMs: 7_777 };
    const fs = fakeFs(files);

    const refresh = (
      await refreshConfigSourceManifest(seededManifest(), fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([PROMPT_A]);
    expect(refresh.change).toEqual({ kind: "unchanged" });
    expect(refresh.reads).toHaveLength(1);
    expect(refresh.reads[0]?.contentChanged).toBe(false);
    expect(refresh.reads[0]?.content).toBe(PROMPT_A_TEXT);

    const updated = findEntry(refresh.manifest, PROMPT_A);
    expect(updated.mtimeMs).toBe(7_777);
    expect(updated.sha256).toBe(hashConfigSourceContent(PROMPT_A_TEXT));

    // The refreshed manifest makes the next probe cheap again.
    const second = fakeFs(files);
    const again = (
      await refreshConfigSourceManifest(refresh.manifest, second)
    )._unsafeUnwrap();
    expect(second.readCalls).toEqual([]);
    expect(again.change).toEqual({ kind: "unchanged" });
  });

  it("classifies a changed prompt file as prompt-only and returns its bytes", async () => {
    const files = currentFiles();
    files[PROMPT_B] = { content: "# prompt b, edited\n", mtimeMs: 5_000 };
    const fs = fakeFs(files);

    const refresh = (
      await refreshConfigSourceManifest(seededManifest(), fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([PROMPT_B]);
    expect(refresh.change).toEqual({
      kind: "prompt-only",
      changedPaths: [PROMPT_B],
    });
    expect(refresh.reads[0]?.content).toBe("# prompt b, edited\n");
    expect(refresh.reads[0]?.sha256).toBe(
      hashConfigSourceContent("# prompt b, edited\n"),
    );
    expect(findEntry(refresh.manifest, PROMPT_B).sha256).toBe(
      hashConfigSourceContent("# prompt b, edited\n"),
    );
    expect(findEntry(refresh.manifest, PROMPT_A).sha256).toBe(
      hashConfigSourceContent(PROMPT_A_TEXT),
    );
  });

  it("classifies a changed config file as config-changed", async () => {
    const files = currentFiles();
    const edited = 'agent beta {\n  prompt "edited"\n}\n';
    files[PROJECT_CONFIG] = { content: edited, mtimeMs: 2_500 };
    files[PROMPT_A] = { content: "# prompt a, edited\n", mtimeMs: 3_500 };
    const fs = fakeFs(files);

    const refresh = (
      await refreshConfigSourceManifest(seededManifest(), fs)
    )._unsafeUnwrap();

    expect(refresh.change).toEqual({
      kind: "config-changed",
      changedPaths: [PROJECT_CONFIG, PROMPT_A].sort(),
    });
    expect(fs.readCalls.sort()).toEqual([PROJECT_CONFIG, PROMPT_A].sort());
    const read = refresh.reads.find((entry) => entry.path === PROJECT_CONFIG);
    expect(read?.content).toBe(edited);
    expect(read?.contentChanged).toBe(true);
  });

  it("treats an appearing config file as a config change", async () => {
    const manifest = seededManifest();
    const withoutGlobal: PiConfigSourceManifest = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === GLOBAL_CONFIG
          ? {
              kind: file.kind,
              path: file.path,
              presence: "absent" as const,
              size: undefined,
              mtimeMs: undefined,
              sha256: undefined,
            }
          : file,
      ),
    };
    const fs = fakeFs(currentFiles());

    const refresh = (
      await refreshConfigSourceManifest(withoutGlobal, fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([GLOBAL_CONFIG]);
    expect(refresh.change).toEqual({
      kind: "config-changed",
      changedPaths: [GLOBAL_CONFIG],
    });
    const updated = findEntry(refresh.manifest, GLOBAL_CONFIG);
    expect(updated.presence).toBe("present");
    expect(updated.sha256).toBe(hashConfigSourceContent(GLOBAL_TEXT));
  });

  it("treats a disappearing config file as a config change", async () => {
    const files = currentFiles();
    delete files[PROJECT_CONFIG];
    const fs = fakeFs(files);

    const refresh = (
      await refreshConfigSourceManifest(seededManifest(), fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([]);
    expect(refresh.change).toEqual({
      kind: "config-changed",
      changedPaths: [PROJECT_CONFIG],
    });
    const updated = findEntry(refresh.manifest, PROJECT_CONFIG);
    expect(updated).toEqual({
      kind: "project-config",
      path: PROJECT_CONFIG,
      presence: "absent",
      size: undefined,
      mtimeMs: undefined,
      sha256: undefined,
    });
  });

  it("fails when a known prompt file was deleted", async () => {
    const files = currentFiles();
    delete files[PROMPT_A];
    const fs = fakeFs(files);

    const result = await refreshConfigSourceManifest(seededManifest(), fs);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "PromptSourceDisappeared",
      kind: "prompt-file",
      path: PROMPT_A,
    });
    expect(fs.readCalls).toEqual([]);
  });

  it("fails with a typed error when a stat fails", async () => {
    const fs = fakeFs(currentFiles(), {
      stat: { [PROJECT_CONFIG]: "EACCES: permission denied" },
    });

    const result = await refreshConfigSourceManifest(seededManifest(), fs);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SourceStatFailed",
      kind: "project-config",
      path: PROJECT_CONFIG,
      message: "EACCES: permission denied",
    });
    expect(fs.readCalls).toEqual([]);
  });

  it("fails with a typed error when a changed source cannot be read", async () => {
    const files = currentFiles();
    files[PROMPT_B] = { content: PROMPT_B_TEXT, mtimeMs: 8_888 };
    const fs = fakeFs(files, { read: { [PROMPT_B]: "EIO: read error" } });

    const result = await refreshConfigSourceManifest(seededManifest(), fs);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SourceReadFailed",
      kind: "prompt-file",
      path: PROMPT_B,
      message: "EIO: read error",
    });
  });

  it("re-hashes a source whose metadata is unreliable", async () => {
    const manifest = seededManifest();
    const unreliable: PiConfigSourceManifest = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === PROMPT_A ? { ...file, mtimeMs: Number.NaN } : file,
      ),
    };
    const files = currentFiles();
    files[PROMPT_A] = { content: PROMPT_A_TEXT, mtimeMs: Number.NaN };
    const fs = fakeFs(files);

    const refresh = (
      await refreshConfigSourceManifest(unreliable, fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([PROMPT_A]);
    expect(refresh.change).toEqual({ kind: "unchanged" });
  });
});

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

describe("classifyConfigSourceChange", () => {
  it("prefers config-changed over prompt-only and sorts changed paths", () => {
    const promptEntry = entry("prompt-file", PROMPT_A, PROMPT_A_TEXT, 1);
    const configEntry = entry("global-config", GLOBAL_CONFIG, GLOBAL_TEXT, 1);

    expect(
      classifyConfigSourceChange([
        {
          entry: promptEntry,
          read: {
            kind: "prompt-file",
            path: PROMPT_A,
            content: PROMPT_A_TEXT,
            sha256: promptEntry.sha256 ?? "",
            contentChanged: true,
          },
          disappeared: false,
        },
        {
          entry: configEntry,
          read: {
            kind: "global-config",
            path: GLOBAL_CONFIG,
            content: GLOBAL_TEXT,
            sha256: configEntry.sha256 ?? "",
            contentChanged: true,
          },
          disappeared: false,
        },
      ]),
    ).toEqual({
      kind: "config-changed",
      changedPaths: [GLOBAL_CONFIG, PROMPT_A].sort(),
    });
  });

  it("reports unchanged when reads produced identical digests", () => {
    const promptEntry = entry("prompt-file", PROMPT_A, PROMPT_A_TEXT, 1);
    expect(
      classifyConfigSourceChange([
        {
          entry: promptEntry,
          read: {
            kind: "prompt-file",
            path: PROMPT_A,
            content: PROMPT_A_TEXT,
            sha256: promptEntry.sha256 ?? "",
            contentChanged: false,
          },
          disappeared: false,
        },
      ]),
    ).toEqual({ kind: "unchanged" });
  });
});

// ---------------------------------------------------------------------------
// Production port error mapping (fake opener; no real filesystem)
// ---------------------------------------------------------------------------

describe("createPiConfigSourceFsPort", () => {
  const handle = (
    overrides: Partial<{
      stat: () => Promise<{
        size: number;
        mtimeMs: number;
        isFile(): boolean;
      }>;
      text: () => Promise<string>;
    }>,
  ): PiConfigSourceFileHandle => ({
    stat:
      overrides.stat ??
      (async () => ({ size: 1, mtimeMs: 1, isFile: () => true })),
    text: overrides.text ?? (async () => "content"),
  });

  it("maps a missing file to absent rather than a failure", async () => {
    const port = createPiConfigSourceFsPort(() =>
      handle({
        stat: () => {
          const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return Promise.reject(error);
        },
      }),
    );

    const result = await port.statFile("/missing");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("maps other stat failures, non-files, and read failures to typed errors", async () => {
    const denied = createPiConfigSourceFsPort(() =>
      handle({
        stat: () => {
          const error = Object.assign(new Error("EACCES"), { code: "EACCES" });
          return Promise.reject(error);
        },
      }),
    );
    const deniedResult = await denied.statFile("/denied");
    expect(deniedResult._unsafeUnwrapErr()).toEqual({
      type: "StatFailed",
      path: "/denied",
      message: "EACCES",
    });

    const directory = createPiConfigSourceFsPort(() =>
      handle({
        stat: async () => ({ size: 64, mtimeMs: 5, isFile: () => false }),
      }),
    );
    const directoryResult = await directory.statFile("/dir");
    expect(directoryResult._unsafeUnwrapErr()).toEqual({
      type: "StatFailed",
      path: "/dir",
      message: "not a regular file",
    });

    const unreadable = createPiConfigSourceFsPort(() =>
      handle({ text: () => Promise.reject(new Error("EIO")) }),
    );
    const unreadableResult = await unreadable.readFile("/broken");
    expect(unreadableResult._unsafeUnwrapErr()).toEqual({
      type: "ReadFailed",
      path: "/broken",
      message: "EIO",
    });
  });

  it("degrades unreliable metadata to NaN so the source is re-hashed", async () => {
    const port = createPiConfigSourceFsPort(() =>
      handle({
        stat: async () => ({
          size: -1,
          mtimeMs: Number.POSITIVE_INFINITY,
          isFile: () => true,
        }),
      }),
    );

    const stat = (await port.statFile("/odd"))._unsafeUnwrap();
    expect(Number.isNaN(stat?.size)).toBe(true);
    expect(Number.isNaN(stat?.mtimeMs)).toBe(true);
  });

  it("reads text through the opener", async () => {
    const port = createPiConfigSourceFsPort(() =>
      handle({ text: async () => "hello" }),
    );
    expect((await port.readFile("/file"))._unsafeUnwrap()).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// refreshChangedSources composed directly with probes
// ---------------------------------------------------------------------------

describe("refreshChangedSources", () => {
  it("reads only maybe-changed and appeared sources", async () => {
    const files = currentFiles();
    files[PROMPT_A] = { content: "# edited\n", mtimeMs: 3_500 };
    const fs = fakeFs(files);
    const manifest = seededManifest();

    const probes = (await probeConfigSources(manifest, fs))._unsafeUnwrap();
    expect(probes.map((probe) => probe.status)).toEqual([
      "unchanged",
      "unchanged",
      "maybe-changed",
      "unchanged",
    ]);

    const refresh = (
      await refreshChangedSources(manifest, probes, fs)
    )._unsafeUnwrap();

    expect(fs.readCalls).toEqual([PROMPT_A]);
    expect(refresh.change).toEqual({
      kind: "prompt-only",
      changedPaths: [PROMPT_A],
    });
    expect(refresh.manifest.identity).toEqual(IDENTITY);
    expect(refresh.manifest.builtin.sha256).toBe(getPiBuiltinSourceDigest());
  });
});
