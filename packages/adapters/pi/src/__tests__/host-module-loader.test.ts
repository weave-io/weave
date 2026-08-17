import { describe, expect, it } from "bun:test";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  deriveHostPackageRoot,
  escapeExactPathRegExp,
  exactPathLoadFilter,
  PI_HOST_MODULE_REDIRECT_DISABLED_REASON,
  type PiHostModuleEnvironmentError,
  type PiHostModuleEnvironmentPort,
  type PiHostModuleOutcome,
  resolveHostModules,
  WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV,
} from "../host-module-loader.js";
import {
  hostEntrySpecifierFor,
  PI_HOST_MODULE_SPECIFIERS,
  type PiHostModuleSpecifier,
  renderHostReexportStub,
} from "../host-module-redirect.js";

const HOST_ROOT = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const HOST_CLI = `${HOST_ROOT}/dist/cli.js`;
const HOST_PACKAGE_JSON = `${HOST_ROOT}/package.json`;
const HOST_VERSION = "0.84.2";
const HOST_PACKAGE = {
  name: "@earendil-works/pi-coding-agent",
  version: HOST_VERSION,
};

const HOST_ENTRIES = {
  "@earendil-works/pi-coding-agent": `${HOST_ROOT}/dist/index.js`,
  "@earendil-works/pi-ai": `${HOST_ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  "@earendil-works/pi-tui": `${HOST_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
} as const;

const LOCAL_ROOT = "/Users/jose/projects/weave/node_modules/@earendil-works";
const LOCAL_ENTRIES = {
  "@earendil-works/pi-coding-agent": `${LOCAL_ROOT}/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${LOCAL_ROOT}/pi-ai/dist/index.js`,
  "@earendil-works/pi-tui": `${LOCAL_ROOT}/pi-tui/dist/index.js`,
} as const;

const ISOLATED_ENV = {} as const;

interface FakeEnvironmentScript {
  readonly mainModulePath?: Result<string, PiHostModuleEnvironmentError>;
  readonly jsonFiles?: Readonly<
    Record<string, Result<unknown, PiHostModuleEnvironmentError>>
  >;
  readonly resolveFrom?: Readonly<
    Record<string, Result<string, PiHostModuleEnvironmentError>>
  >;
  readonly resolveLocal?: Readonly<
    Record<PiHostModuleSpecifier, Result<string, PiHostModuleEnvironmentError>>
  >;
  readonly namespaces?: Readonly<Record<string, unknown>>;
  readonly throwOn?: "mainModulePath";
}

/** In-memory host-module environment. Never touches Bun.plugin or real I/O. */
class FakePiHostModuleEnvironment implements PiHostModuleEnvironmentPort {
  readonly calls: string[] = [];
  readonly registerCalls: {
    readonly exactPath: string;
    readonly contents: string;
  }[] = [];

  constructor(private readonly script: FakeEnvironmentScript = {}) {}

  mainModulePath(): ResultAsync<string, PiHostModuleEnvironmentError> {
    this.calls.push("mainModulePath");
    if (this.script.throwOn === "mainModulePath") {
      throw new Error("main-module-threw");
    }
    return toAsync(this.script.mainModulePath ?? ok(HOST_CLI));
  }

  readJsonFile(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    this.calls.push(`readJsonFile:${path}`);
    const scripted = this.script.jsonFiles?.[path];
    if (scripted !== undefined) return toAsync(scripted);
    if (path === HOST_PACKAGE_JSON) return okAsync(HOST_PACKAGE);
    return errAsync({ type: "JsonReadFailed", path });
  }

  resolveFrom(
    specifier: string,
    fromDir: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    this.calls.push(`resolveFrom:${specifier}:${fromDir}`);
    const key = `${specifier}::${fromDir}`;
    const scripted = this.script.resolveFrom?.[key];
    if (scripted !== undefined) return toAsync(scripted);
    for (const hostSpecifier of PI_HOST_MODULE_SPECIFIERS) {
      if (
        specifier === hostEntrySpecifierFor(hostSpecifier) &&
        fromDir === HOST_ROOT
      ) {
        return okAsync(HOST_ENTRIES[hostSpecifier]);
      }
    }
    return errAsync({ type: "ResolveFailed", specifier });
  }

  resolveLocal(
    specifier: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    this.calls.push(`resolveLocal:${specifier}`);
    if (isHostSpecifier(specifier)) {
      const scripted = this.script.resolveLocal?.[specifier];
      if (scripted !== undefined) return toAsync(scripted);
      return okAsync(LOCAL_ENTRIES[specifier]);
    }
    return errAsync({ type: "ResolveFailed", specifier });
  }

  registerLoadOverride(
    exactPath: string,
    contents: string,
  ): ResultAsync<void, PiHostModuleEnvironmentError> {
    this.calls.push(`registerLoadOverride:${exactPath}`);
    this.registerCalls.push({ exactPath, contents });
    return okAsync(undefined);
  }

  importAbsolute(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    this.calls.push(`importAbsolute:${path}`);
    return okAsync(this.script.namespaces?.[path] ?? {});
  }
}

function toAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error);
}

function isHostSpecifier(value: string): value is PiHostModuleSpecifier {
  return (PI_HOST_MODULE_SPECIFIERS as readonly string[]).includes(value);
}

async function resolveOutcome(
  env: PiHostModuleEnvironmentPort,
  options?: { readonly env?: Readonly<Record<string, string | undefined>> },
): Promise<PiHostModuleOutcome> {
  const result = await resolveHostModules(env, {
    env: options?.env ?? ISOLATED_ENV,
  });
  expect(result.isOk()).toBe(true);
  return result.match(
    (outcome) => outcome,
    () => {
      throw new Error("resolveHostModules rejected");
    },
  );
}

describe("exactPathLoadFilter", () => {
  it("escapes regex metacharacters so the filter matches only the exact path", () => {
    const exactPath = "/tmp/pi-ai.dist/index+(copy).js";
    expect(escapeExactPathRegExp(exactPath)).toBe(
      "/tmp/pi-ai\\.dist/index\\+\\(copy\\)\\.js",
    );
    const filter = exactPathLoadFilter(exactPath);
    expect(filter.test(exactPath)).toBe(true);
    expect(filter.test("/tmp/pi-aidist/index+(copy).js")).toBe(false);
    expect(filter.test("/tmp/pi-aiXdist/index+(copy).js")).toBe(false);
    expect(filter.test("/tmp/pi-ai.dist/indexX(copy).js")).toBe(false);
  });
});

describe("deriveHostPackageRoot", () => {
  it("takes the parent of the directory that contains the host CLI entry", () => {
    const result = deriveHostPackageRoot(HOST_CLI);
    expect(result).toEqual(ok(HOST_ROOT));
  });

  it("treats a $bunfs CLI path as unproven", () => {
    const result = deriveHostPackageRoot("/$bunfs/root/dist/cli.js");
    expect(result).toEqual(err({ reason: "host-root-unproven" }));
  });
});

describe("resolveHostModules", () => {
  it("registers a redirect for all three specifiers when a local copy differs", async () => {
    const env = new FakePiHostModuleEnvironment({
      namespaces: {
        [HOST_ENTRIES["@earendil-works/pi-coding-agent"]]: {
          default: { VERSION: HOST_VERSION },
        },
      },
    });
    const outcome = await resolveOutcome(env);

    expect(outcome.redirected).toEqual([...PI_HOST_MODULE_SPECIFIERS]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.hostRoot).toBe(HOST_ROOT);
    expect(outcome.hostVersion).toBe(HOST_VERSION);
    expect(outcome.localResolutions).toEqual(LOCAL_ENTRIES);
    expect(outcome.proofRecord.hostRoot).toBe(HOST_ROOT);
    expect(outcome.proofRecord.hostVersion).toBe(HOST_VERSION);
    expect(outcome.proofRecord.specifiers).toHaveLength(3);
    expect(outcome.proofRecord.specifiers[0]).toEqual({
      specifier: "@earendil-works/pi-coding-agent",
      hostSpecifier: "@earendil-works/pi-coding-agent",
      localEntryPath: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      hostEntryPath: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
      redirected: true,
      bareResolution: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      loadedFrom: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
    });

    expect(env.registerCalls).toHaveLength(3);
    expect(env.registerCalls[0]).toEqual({
      exactPath: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      contents: renderHostReexportStub({
        hostEntryPath: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
        hasDefaultExport: true,
      }),
    });
    expect(env.registerCalls[1]).toEqual({
      exactPath: LOCAL_ENTRIES["@earendil-works/pi-ai"],
      contents: renderHostReexportStub({
        hostEntryPath: HOST_ENTRIES["@earendil-works/pi-ai"],
        hasDefaultExport: false,
      }),
    });
    expect(env.registerCalls[2]).toEqual({
      exactPath: LOCAL_ENTRIES["@earendil-works/pi-tui"],
      contents: renderHostReexportStub({
        hostEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
        hasDefaultExport: false,
      }),
    });

    const firstHostImport = env.calls.indexOf(
      `importAbsolute:${HOST_ENTRIES["@earendil-works/pi-coding-agent"]}`,
    );
    const firstRegister = env.calls.indexOf(
      `registerLoadOverride:${LOCAL_ENTRIES["@earendil-works/pi-coding-agent"]}`,
    );
    const firstLocalImport = env.calls.indexOf(
      `importAbsolute:${LOCAL_ENTRIES["@earendil-works/pi-coding-agent"]}`,
    );
    expect(firstHostImport).toBeGreaterThan(-1);
    expect(firstRegister).toBeGreaterThan(firstHostImport);
    expect(firstLocalImport).toBeGreaterThan(firstRegister);
    expect(env.calls).toContain(`readJsonFile:${HOST_PACKAGE_JSON}`);
  });

  it("skips every specifier as host-root-unproven for a $bunfs main path", async () => {
    const env = new FakePiHostModuleEnvironment({
      mainModulePath: ok("/$bunfs/root/dist/cli.js"),
    });
    const outcome = await resolveOutcome(env);

    expect(outcome.redirected).toEqual([]);
    expect(outcome.skipped).toEqual(
      PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
        specifier,
        reason: "host-root-unproven",
      })),
    );
    expect(outcome.hostRoot).toBeUndefined();
    expect(outcome.hostVersion).toBeUndefined();
    expect(env.registerCalls).toEqual([]);
    expect(env.calls.some((call) => call.startsWith("readJsonFile:"))).toBe(
      false,
    );
    expect(env.calls.some((call) => call.startsWith("resolveLocal:"))).toBe(
      false,
    );
    expect(
      outcome.proofRecord.specifiers.every((entry) => !entry.redirected),
    ).toBe(true);
  });

  it("skips every specifier when the host package.json cannot be read", async () => {
    const env = new FakePiHostModuleEnvironment({
      jsonFiles: {
        [HOST_PACKAGE_JSON]: err({
          type: "JsonReadFailed",
          path: HOST_PACKAGE_JSON,
        }),
      },
    });
    const outcome = await resolveOutcome(env);

    expect(outcome.redirected).toEqual([]);
    expect(outcome.hostRoot).toBe(HOST_ROOT);
    expect(outcome.hostVersion).toBeUndefined();
    expect(outcome.skipped).toEqual(
      PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
        specifier,
        reason: "host-package-mismatch",
      })),
    );
    expect(env.registerCalls).toEqual([]);
    expect(env.calls.some((call) => call.startsWith("resolveLocal:"))).toBe(
      false,
    );
  });

  it("skips every specifier when the host package.json is malformed", async () => {
    const env = new FakePiHostModuleEnvironment({
      jsonFiles: {
        [HOST_PACKAGE_JSON]: ok({ name: 1, version: HOST_VERSION }),
      },
    });
    const outcome = await resolveOutcome(env);

    expect(outcome.redirected).toEqual([]);
    expect(outcome.skipped).toEqual(
      PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
        specifier,
        reason: "host-package-mismatch",
      })),
    );
    expect(env.registerCalls).toEqual([]);
  });

  it("skips a specifier whose local resolution fails as no-local-copy", async () => {
    const env = new FakePiHostModuleEnvironment({
      resolveLocal: {
        "@earendil-works/pi-coding-agent": ok(
          LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
        ),
        "@earendil-works/pi-ai": err({
          type: "ResolveFailed",
          specifier: "@earendil-works/pi-ai",
        }),
        "@earendil-works/pi-tui": ok(LOCAL_ENTRIES["@earendil-works/pi-tui"]),
      },
    });
    const outcome = await resolveOutcome(env);

    expect(outcome.redirected).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]);
    expect(outcome.skipped).toEqual([
      { specifier: "@earendil-works/pi-ai", reason: "no-local-copy" },
    ]);
    expect(outcome.localResolutions["@earendil-works/pi-ai"]).toBeUndefined();
    expect(env.registerCalls.map((entry) => entry.exactPath)).toEqual([
      LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      LOCAL_ENTRIES["@earendil-works/pi-tui"],
    ]);
  });

  it("skips every specifier for the disable env var without touching I/O", async () => {
    const env = new FakePiHostModuleEnvironment();
    const outcome = await resolveOutcome(env, {
      env: { [WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV]: "1" },
    });

    expect(outcome.redirected).toEqual([]);
    expect(outcome.skipped).toEqual(
      PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
        specifier,
        reason: PI_HOST_MODULE_REDIRECT_DISABLED_REASON,
      })),
    );
    expect(outcome.hostRoot).toBeUndefined();
    expect(
      outcome.proofRecord.specifiers.map((entry) => entry.skipReason),
    ).toEqual([
      PI_HOST_MODULE_REDIRECT_DISABLED_REASON,
      PI_HOST_MODULE_REDIRECT_DISABLED_REASON,
      PI_HOST_MODULE_REDIRECT_DISABLED_REASON,
    ]);
    expect(env.calls).toEqual([]);
    expect(env.registerCalls).toEqual([]);
  });

  it("registers each specifier at most once across a double invocation", async () => {
    const env = new FakePiHostModuleEnvironment();
    const first = await resolveOutcome(env);
    const second = await resolveOutcome(env);

    expect(first.redirected).toEqual([...PI_HOST_MODULE_SPECIFIERS]);
    expect(second.redirected).toEqual([...PI_HOST_MODULE_SPECIFIERS]);
    expect(first.skipped).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(env.registerCalls).toHaveLength(3);
    expect(env.registerCalls.map((entry) => entry.exactPath)).toEqual([
      LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      LOCAL_ENTRIES["@earendil-works/pi-ai"],
      LOCAL_ENTRIES["@earendil-works/pi-tui"],
    ]);
  });

  it("never rejects when the environment port throws", async () => {
    const env = new FakePiHostModuleEnvironment({
      throwOn: "mainModulePath",
    });
    const result = await resolveHostModules(env, { env: ISOLATED_ENV });
    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.redirected).toEqual([]);
    expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
      "host-root-unproven",
      "host-root-unproven",
      "host-root-unproven",
    ]);
  });
});
