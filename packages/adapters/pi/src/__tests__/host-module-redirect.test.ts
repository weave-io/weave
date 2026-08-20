import { describe, expect, it } from "bun:test";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import {
  CODEX_PROVIDER_SUBPATH_SPECIFIER,
  hostEntrySpecifierFor,
  isSafeAbsoluteHostPath,
  MAX_HOST_MODULE_PATH_LENGTH,
  PI_AI_COMPAT_SPECIFIER,
  PI_HOST_MODULE_SPECIFIERS,
  PI_HOST_REDIRECT_REASONS,
  type PiHostModuleRedirectInput,
  type PiHostModuleSpecifier,
  planHostModuleRedirect,
  renderHostReexportStub,
  summarizeHostRedirect,
} from "../host-module-redirect.js";

const HOST_ROOT = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const HOST_VERSION = "0.84.2";

const HOST_ENTRIES = {
  "@earendil-works/pi-coding-agent": `${HOST_ROOT}/dist/index.js`,
  "@earendil-works/pi-ai": `${HOST_ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  "@earendil-works/pi-tui": `${HOST_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  [CODEX_PROVIDER_SUBPATH_SPECIFIER]: `${HOST_ROOT}/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`,
} as const;

const LOCAL_ROOT = "/Users/jose/projects/weave/node_modules/@earendil-works";
const LOCAL_ENTRIES = {
  "@earendil-works/pi-coding-agent": `${LOCAL_ROOT}/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${LOCAL_ROOT}/pi-ai/dist/index.js`,
  "@earendil-works/pi-tui": `${LOCAL_ROOT}/pi-tui/dist/index.js`,
  [CODEX_PROVIDER_SUBPATH_SPECIFIER]: `${LOCAL_ROOT}/pi-ai/dist/providers/openai-codex.js`,
} as const;

function defaultFacts(specifier: PiHostModuleSpecifier): {
  readonly localEntryPath: string;
  readonly hostEntryPath: string;
} {
  return {
    localEntryPath: LOCAL_ENTRIES[specifier],
    hostEntryPath: HOST_ENTRIES[specifier],
  };
}

function facts(
  overrides?: {
    readonly [K in PiHostModuleSpecifier]?: {
      readonly localEntryPath?: string;
      readonly hostEntryPath?: string;
    };
  },
): PiHostModuleRedirectInput["specifiers"] {
  return {
    "@earendil-works/pi-coding-agent":
      overrides?.["@earendil-works/pi-coding-agent"] ??
      defaultFacts("@earendil-works/pi-coding-agent"),
    "@earendil-works/pi-ai":
      overrides?.["@earendil-works/pi-ai"] ??
      defaultFacts("@earendil-works/pi-ai"),
    "@earendil-works/pi-tui":
      overrides?.["@earendil-works/pi-tui"] ??
      defaultFacts("@earendil-works/pi-tui"),
    [CODEX_PROVIDER_SUBPATH_SPECIFIER]:
      overrides?.[CODEX_PROVIDER_SUBPATH_SPECIFIER] ??
      defaultFacts(CODEX_PROVIDER_SUBPATH_SPECIFIER),
  };
}

function input(
  overrides: Partial<PiHostModuleRedirectInput> = {},
): PiHostModuleRedirectInput {
  return {
    hostPackageRoot: HOST_ROOT,
    hostPackage: { name: HOST_PACKAGE_NAME, version: HOST_VERSION },
    specifiers: facts(),
    ...overrides,
  };
}

describe("closed host specifier and reason sets", () => {
  it("names the four Pi host modules in loader order", () => {
    expect(PI_HOST_MODULE_SPECIFIERS).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-tui",
      "@earendil-works/pi-ai/providers/openai-codex",
    ]);
  });

  it("keeps the codex provider subpath as its own proof member", () => {
    // The bare pi-ai entry maps to the compat entry; the subpath resolves to
    // its own file and must be proven separately.
    expect(hostEntrySpecifierFor(CODEX_PROVIDER_SUBPATH_SPECIFIER)).toBe(
      CODEX_PROVIDER_SUBPATH_SPECIFIER,
    );
    expect(hostEntrySpecifierFor("@earendil-works/pi-ai")).not.toBe(
      CODEX_PROVIDER_SUBPATH_SPECIFIER,
    );
  });

  it("closes the redirect-reason union", () => {
    expect(PI_HOST_REDIRECT_REASONS).toEqual([
      "host-root-unproven",
      "host-package-mismatch",
      "no-local-copy",
      "already-host",
      "local-path-unsafe",
      "plugin-unavailable",
      "redirect-registered",
    ]);
  });

  it("keeps the expected host package identity aligned with host-compatibility", () => {
    expect(HOST_PACKAGE_NAME).toBe("@earendil-works/pi-coding-agent");
  });
});

describe("planHostModuleRedirect", () => {
  it("plans a redirect when a local copy differs from the host entry", () => {
    const result = planHostModuleRedirect(input());
    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.hostVersion).toBe(HOST_VERSION);
    expect(plan.redirects).toHaveLength(4);
    expect(plan.skipped).toEqual([]);
    expect(plan.redirects[0]).toEqual({
      specifier: "@earendil-works/pi-coding-agent",
      hostSpecifier: "@earendil-works/pi-coding-agent",
      localEntryPath: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      hostEntryPath: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
    });
  });

  it("skips a specifier whose local path is already the host entry", () => {
    const result = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-tui": {
            localEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
          },
        }),
      }),
    );
    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.redirects.map((entry) => entry.specifier)).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      CODEX_PROVIDER_SUBPATH_SPECIFIER,
    ]);
    expect(plan.skipped).toEqual([
      { specifier: "@earendil-works/pi-tui", reason: "already-host" },
    ]);
  });

  it("skips a specifier when no local copy exists", () => {
    const result = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-ai": {
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-ai"],
          },
        }),
      }),
    );
    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(
      plan.skipped.find((entry) => entry.specifier === "@earendil-works/pi-ai"),
    ).toEqual({
      specifier: "@earendil-works/pi-ai",
      reason: "no-local-copy",
    });
    expect(plan.redirects).toHaveLength(3);
  });

  it("skips a local copy when the host entry is missing", () => {
    const result = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-coding-agent": {
            localEntryPath: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
          },
        }),
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().skipped).toContainEqual({
      specifier: "@earendil-works/pi-coding-agent",
      reason: "host-root-unproven",
    });
  });

  it("rejects a mismatched host package name", () => {
    const result = planHostModuleRedirect(
      input({
        hostPackage: {
          name: "@mariozechner/pi-coding-agent",
          version: HOST_VERSION,
        },
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      reason: "host-package-mismatch",
      expected: HOST_PACKAGE_NAME,
      actual: "@mariozechner/pi-coding-agent",
    });
  });

  it("rejects an empty host package root as unproven", () => {
    const result = planHostModuleRedirect(input({ hostPackageRoot: "" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      reason: "host-root-unproven",
    });
  });

  it("rejects an unsafe host package root", () => {
    const result = planHostModuleRedirect(
      input({ hostPackageRoot: "/opt/pi/../other" }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      reason: "local-path-unsafe",
      field: "hostPackageRoot",
    });
  });

  it("rejects unsafe local and host entry paths", () => {
    const relative = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-tui": {
            localEntryPath: "node_modules/pi-tui/index.js",
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
          },
        }),
      }),
    );
    expect(relative._unsafeUnwrapErr()).toEqual({
      reason: "local-path-unsafe",
      field: "localEntryPath",
      specifier: "@earendil-works/pi-tui",
    });

    const traversal = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-tui": {
            localEntryPath: LOCAL_ENTRIES["@earendil-works/pi-tui"],
            hostEntryPath: "/opt/pi/./dist/index.js",
          },
        }),
      }),
    );
    expect(traversal._unsafeUnwrapErr()).toEqual({
      reason: "local-path-unsafe",
      field: "hostEntryPath",
      specifier: "@earendil-works/pi-tui",
    });

    const nul = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-ai": {
            localEntryPath: `/tmp/pi-ai\0dist/index.js`,
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-ai"],
          },
        }),
      }),
    );
    expect(nul._unsafeUnwrapErr().reason).toBe("local-path-unsafe");

    const backslash = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-ai": {
            localEntryPath: "/tmp/pi-ai\\dist\\index.js",
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-ai"],
          },
        }),
      }),
    );
    expect(backslash._unsafeUnwrapErr().reason).toBe("local-path-unsafe");

    const overlong = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-ai": {
            localEntryPath: `/${"a".repeat(MAX_HOST_MODULE_PATH_LENGTH)}`,
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-ai"],
          },
        }),
      }),
    );
    expect(overlong._unsafeUnwrapErr().reason).toBe("local-path-unsafe");
  });

  it("maps the bare pi-ai specifier to the host compat entry", () => {
    expect(hostEntrySpecifierFor("@earendil-works/pi-ai")).toBe(
      PI_AI_COMPAT_SPECIFIER,
    );
    expect(hostEntrySpecifierFor("@earendil-works/pi-coding-agent")).toBe(
      "@earendil-works/pi-coding-agent",
    );
    expect(hostEntrySpecifierFor("@earendil-works/pi-tui")).toBe(
      "@earendil-works/pi-tui",
    );

    const result = planHostModuleRedirect(input());
    const piAi = result
      ._unsafeUnwrap()
      .redirects.find((entry) => entry.specifier === "@earendil-works/pi-ai");
    expect(piAi?.hostSpecifier).toBe("@earendil-works/pi-ai/compat");
    expect(piAi?.hostEntryPath).toBe(HOST_ENTRIES["@earendil-works/pi-ai"]);
    expect(piAi?.hostEntryPath.endsWith("/compat.js")).toBe(true);
  });
});

describe("renderHostReexportStub", () => {
  it("renders a named-only re-export", () => {
    expect(
      renderHostReexportStub({
        hostEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
        hasDefaultExport: false,
      }),
    ).toBe(
      `export * from ${JSON.stringify(HOST_ENTRIES["@earendil-works/pi-tui"])};`,
    );
  });

  it("adds a default re-export only when one was observed", () => {
    expect(
      renderHostReexportStub({
        hostEntryPath: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
        hasDefaultExport: true,
      }),
    ).toBe(
      [
        `export * from ${JSON.stringify(HOST_ENTRIES["@earendil-works/pi-coding-agent"])};`,
        `export { default } from ${JSON.stringify(HOST_ENTRIES["@earendil-works/pi-coding-agent"])};`,
      ].join("\n"),
    );
  });

  it("JSON-escapes a path that contains quotes", () => {
    const hostEntryPath = `/tmp/pi-"weird"/index.js`;
    const stub = renderHostReexportStub({
      hostEntryPath,
      hasDefaultExport: false,
    });
    expect(stub).toBe(`export * from ${JSON.stringify(hostEntryPath)};`);
    expect(stub).toContain('\\"');
    expect(stub).not.toContain(`from "${hostEntryPath}"`);
  });
});

describe("summarizeHostRedirect and proof record", () => {
  it("keeps the health summary bounded and path-free", () => {
    const plan = planHostModuleRedirect(
      input({
        specifiers: facts({
          "@earendil-works/pi-tui": {
            hostEntryPath: HOST_ENTRIES["@earendil-works/pi-tui"],
          },
        }),
      }),
    )._unsafeUnwrap();
    const summary = summarizeHostRedirect(plan);
    expect(summary).toBe(
      "host modules: redirected 3, skipped 1 (no-local-copy)",
    );
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).not.toContain(HOST_ROOT);
    expect(summary).not.toContain(LOCAL_ROOT);
    expect(summary).not.toContain("/opt/");
    expect(summary).not.toContain("/Users/");
    expect(summary.startsWith("/")).toBe(false);
  });

  it("keeps absolute paths on the separate proof record", () => {
    const plan = planHostModuleRedirect(input())._unsafeUnwrap();
    expect(plan.proof.hostRoot).toBe(HOST_ROOT);
    expect(plan.proof.hostVersion).toBe(HOST_VERSION);
    expect(plan.proof.specifiers).toHaveLength(4);
    expect(plan.proof.specifiers[0]).toEqual({
      specifier: "@earendil-works/pi-coding-agent",
      hostSpecifier: "@earendil-works/pi-coding-agent",
      localEntryPath: LOCAL_ENTRIES["@earendil-works/pi-coding-agent"],
      hostEntryPath: HOST_ENTRIES["@earendil-works/pi-coding-agent"],
      redirected: true,
    });
    expect(JSON.stringify(plan.proof)).toContain(HOST_ROOT);
    expect(summarizeHostRedirect(plan)).not.toContain(HOST_ROOT);
  });
});

describe("isSafeAbsoluteHostPath", () => {
  it("accepts a bounded canonical absolute path", () => {
    expect(isSafeAbsoluteHostPath("/opt/pi/dist/index.js")).toBe(true);
    expect(isSafeAbsoluteHostPath("/")).toBe(true);
  });

  it("rejects relative, traversing, empty, and overlong paths", () => {
    expect(isSafeAbsoluteHostPath("opt/pi")).toBe(false);
    expect(isSafeAbsoluteHostPath("/opt/./pi")).toBe(false);
    expect(isSafeAbsoluteHostPath("/opt/../pi")).toBe(false);
    expect(isSafeAbsoluteHostPath("")).toBe(false);
    expect(
      isSafeAbsoluteHostPath(`/${"n".repeat(MAX_HOST_MODULE_PATH_LENGTH)}`),
    ).toBe(false);
  });
});
