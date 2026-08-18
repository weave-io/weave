import { describe, expect, it } from "bun:test";
import {
  MAX_HOST_MODULE_PROOF_LINE_LENGTH,
  WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV,
} from "../../../packages/adapters/pi/src/host-module-loader.js";
import {
  ALLOW_SKIP_FLAG,
  buildProofEnv,
  checkoutCopyExistsFromListing,
  classifyMappedPaths,
  decideSkip,
  evaluateSingletonProof,
  extractProofLineFromOutput,
  formatSummary,
  hostModulePrefix,
  hostPackageJsonCandidates,
  isCheckoutEarendilPath,
  isCheckoutHostCopyPath,
  isPathInside,
  nativePackageRootFromPath,
  type ParsedHostModuleProof,
  parseHostPackageIdentity,
  parseLinuxMapsOutput,
  parseLsofDefaultOutput,
  parseLsofFnOutput,
  parseProofLine,
  parseVerifyArgs,
} from "../verify-host-singleton.js";

const HOST_ROOT = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const HOST_ENTRY = `${HOST_ROOT}/dist/index.js`;
const HOST_AI_ENTRY =
  "/opt/pi/node_modules/@earendil-works/pi-ai/dist/compat.js";
const HOST_TUI_ENTRY =
  "/opt/pi/node_modules/@earendil-works/pi-tui/dist/index.js";
const HOST_CODEX_SUBPATH_ENTRY =
  "/opt/pi/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js";
const CHECKOUT_ROOT = "/Users/jose/projects/weave";
const LOCAL_ENTRY = `${CHECKOUT_ROOT}/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1/node_modules/@earendil-works/pi-coding-agent/dist/index.js`;
const LOCAL_CODEX_SUBPATH_ENTRY = `${CHECKOUT_ROOT}/node_modules/.bun/@earendil-works+pi-ai@0.81.1/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`;

function redirectedProof(): ParsedHostModuleProof {
  return {
    hostRoot: HOST_ROOT,
    hostVersion: "0.84.2",
    specifiers: [
      {
        specifier: "@earendil-works/pi-coding-agent",
        bareResolution: LOCAL_ENTRY,
        loadedFrom: HOST_ENTRY,
        redirected: true,
      },
      {
        specifier: "@earendil-works/pi-ai",
        loadedFrom: HOST_AI_ENTRY,
        redirected: true,
      },
      {
        specifier: "@earendil-works/pi-tui",
        loadedFrom: HOST_TUI_ENTRY,
        redirected: true,
      },
      {
        specifier: "@earendil-works/pi-ai/providers/openai-codex",
        bareResolution: LOCAL_CODEX_SUBPATH_ENTRY,
        loadedFrom: HOST_CODEX_SUBPATH_ENTRY,
        redirected: true,
      },
    ],
  };
}

function disabledProof(): ParsedHostModuleProof {
  return {
    specifiers: [
      {
        specifier: "@earendil-works/pi-coding-agent",
        redirected: false,
      },
      {
        specifier: "@earendil-works/pi-ai",
        redirected: false,
      },
      {
        specifier: "@earendil-works/pi-tui",
        redirected: false,
      },
      {
        specifier: "@earendil-works/pi-ai/providers/openai-codex",
        bareResolution: LOCAL_CODEX_SUBPATH_ENTRY,
        redirected: false,
      },
    ],
  };
}

describe("parseVerifyArgs", () => {
  it("accepts an empty argv", () => {
    const result = parseVerifyArgs([]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({ allowSkip: false });
  });

  it("accepts --allow-skip", () => {
    const result = parseVerifyArgs([ALLOW_SKIP_FLAG]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({ allowSkip: true });
  });

  it("rejects an unknown flag", () => {
    const result = parseVerifyArgs(["--help"]);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("InvalidArgs");
  });
});

describe("decideSkip", () => {
  it("runs when the host is present", () => {
    expect(
      decideSkip(
        {
          status: "found",
          cliPath: "/usr/bin/pi",
          hostRoot: HOST_ROOT,
          hostVersion: "0.84.2",
        },
        false,
      ),
    ).toEqual({ action: "run" });
  });

  it("skips a missing host only when --allow-skip is set", () => {
    const missing = {
      status: "missing" as const,
      reason: "Pi host CLI not found (set PI_HOST_CLI or install pi on PATH)",
    };
    expect(decideSkip(missing, true)).toEqual({
      action: "skip",
      reason: missing.reason,
    });
    expect(decideSkip(missing, false)).toEqual({
      action: "fail",
      reason: missing.reason,
    });
  });

  it("never skips an invalid host package identity", () => {
    const invalid = {
      status: "invalid" as const,
      reason:
        "Pi host CLI /tmp/pi is not package @earendil-works/pi-coding-agent",
    };
    expect(decideSkip(invalid, true)).toEqual({
      action: "fail",
      reason: invalid.reason,
    });
    expect(decideSkip(invalid, false)).toEqual({
      action: "fail",
      reason: invalid.reason,
    });
  });
});

describe("parseHostPackageIdentity", () => {
  it("accepts the host package name and version", () => {
    const result = parseHostPackageIdentity({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.2",
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.2",
    });
  });

  it("rejects a missing or empty identity", () => {
    expect(parseHostPackageIdentity(null).isErr()).toBe(true);
    expect(parseHostPackageIdentity({ name: "", version: "1" }).isErr()).toBe(
      true,
    );
    expect(
      parseHostPackageIdentity({
        name: "@earendil-works/pi-coding-agent",
      }).isErr(),
    ).toBe(true);
  });
});

describe("parseProofLine", () => {
  it("parses a valid single-line proof envelope", () => {
    const line = JSON.stringify({
      weaveHostModuleProof: redirectedProof(),
    });
    const result = parseProofLine(line);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual(redirectedProof());
  });

  it("rejects invalid JSON, empty lines, and multiline text", () => {
    expect(parseProofLine("").isErr()).toBe(true);
    expect(parseProofLine("{").isErr()).toBe(true);
    expect(parseProofLine('{"weaveHostModuleProof":{}}\n').isErr()).toBe(true);
    expect(parseProofLine(JSON.stringify({ ok: true })).isErr()).toBe(true);
  });

  it("rejects a line over the bounded size", () => {
    const oversized = `{"weaveHostModuleProof":{"specifiers":[],"pad":"${"x".repeat(MAX_HOST_MODULE_PROOF_LINE_LENGTH)}"}}`;
    expect(oversized.length).toBeGreaterThan(MAX_HOST_MODULE_PROOF_LINE_LENGTH);
    expect(parseProofLine(oversized).isErr()).toBe(true);
  });

  it("extracts the proof line from mixed process output", () => {
    const line = JSON.stringify({
      weaveHostModuleProof: redirectedProof(),
    });
    const output = [
      '{"level":30,"msg":"starting"}',
      "not json",
      line,
      "trailing noise",
    ].join("\n");
    const result = extractProofLineFromOutput(output);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual(redirectedProof());
  });

  it("reports a missing proof line", () => {
    const result = extractProofLineFromOutput("no proof here\n");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("ProofMissing");
  });
});

describe("lsof and maps classification", () => {
  it("parses lsof -Fn name records", () => {
    const output = [
      "p12345",
      "fcwd",
      "n/tmp/proof",
      "fmem",
      `n${HOST_ENTRY}`,
      "fmem",
      `n${LOCAL_ENTRY} (deleted)`,
    ].join("\n");
    expect(parseLsofFnOutput(output)).toEqual([
      "/tmp/proof",
      HOST_ENTRY,
      LOCAL_ENTRY,
    ]);
  });

  it("parses default columnar lsof output", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      `pi      12345 jose  txt    REG   1,18     4096    1 ${HOST_ENTRY}`,
      "pi      12345 jose  cwd    DIR   1,18      128    2 /tmp/proof",
    ].join("\n");
    expect(parseLsofDefaultOutput(output)).toEqual([HOST_ENTRY, "/tmp/proof"]);
  });

  it("parses Linux maps pathnames", () => {
    const output = [
      `7f00-7f01 r-xp 00000000 08:01 1 ${HOST_ENTRY}`,
      "7f01-7f02 rw-p 00000000 00:00 0 [heap]",
      `7f02-7f03 r-xp 00000000 08:01 2 ${LOCAL_ENTRY} (deleted)`,
    ].join("\n");
    expect(parseLinuxMapsOutput(output)).toEqual([HOST_ENTRY, LOCAL_ENTRY]);
  });

  it("flags checkout @earendil-works mappings and counts native roots", () => {
    const hostNode = `${HOST_ROOT}/node_modules/clipboard/clipboard.node`;
    const checkoutNode = `${CHECKOUT_ROOT}/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1/node_modules/@earendil-works/pi-coding-agent/node_modules/clipboard/clipboard.node`;
    const classified = classifyMappedPaths({
      paths: [
        HOST_ENTRY,
        LOCAL_ENTRY,
        hostNode,
        checkoutNode,
        `${CHECKOUT_ROOT}/packages/adapters/pi/dist/extension.js`,
      ],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(classified.checkoutEarendilPaths).toEqual([
      LOCAL_ENTRY,
      checkoutNode,
    ]);
    expect(classified.nativePackageRoots).toEqual([
      HOST_ROOT,
      `${CHECKOUT_ROOT}/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1/node_modules/@earendil-works/pi-coding-agent`,
    ]);
  });

  it("does not treat host mappings as checkout copies", () => {
    expect(isCheckoutEarendilPath(HOST_ENTRY, CHECKOUT_ROOT)).toBe(false);
    expect(isPathInside(HOST_ENTRY, HOST_ROOT)).toBe(true);
    expect(
      nativePackageRootFromPath(`${HOST_ROOT}/dist/index.js`),
    ).toBeUndefined();
  });
});

describe("checkout copy listing", () => {
  it("detects hoisted and bun-isolated host copies", () => {
    expect(
      checkoutCopyExistsFromListing([
        "node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1+abc",
      ]),
    ).toBe(true);
    expect(isCheckoutHostCopyPath("node_modules/@earendil-works/pi-tui")).toBe(
      true,
    );
    expect(checkoutCopyExistsFromListing(["packages/adapters/pi"])).toBe(false);
  });
});

describe("evaluateSingletonProof", () => {
  it("accepts sibling host package loadedFrom paths", () => {
    expect(hostModulePrefix(HOST_ROOT)).toBe(
      "/opt/pi/node_modules/@earendil-works",
    );
    const result = evaluateSingletonProof({
      proof: redirectedProof(),
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [
        HOST_ENTRY,
        HOST_AI_ENTRY,
        `${HOST_ROOT}/node_modules/clipboard/clipboard.node`,
      ],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).toBe("single-copy");
    expect(result.reasons).toEqual([]);
  });

  it("rejects a disable-redirect proof as a duplicate", () => {
    const result = evaluateSingletonProof({
      proof: disabledProof(),
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [LOCAL_ENTRY],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).not.toBe("single-copy");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a checkout mapping even when the proof line looks clean", () => {
    const result = evaluateSingletonProof({
      proof: redirectedProof(),
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [HOST_ENTRY, LOCAL_ENTRY],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).not.toBe("single-copy");
    expect(result.reasons.some((reason) => reason.includes("checkout"))).toBe(
      true,
    );
  });

  it("requires a differing bareResolution when a checkout copy exists", () => {
    const clean = redirectedProof();
    const result = evaluateSingletonProof({
      proof: {
        hostRoot: HOST_ROOT,
        hostVersion: "0.84.2",
        specifiers: clean.specifiers.map((entry) => ({
          ...entry,
          bareResolution: entry.loadedFrom,
          redirected: false,
        })),
      },
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [HOST_ENTRY],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).toBe("redirect-not-observed");
  });

  it("detects a codex subpath that resolves to a second copy", () => {
    // Exactly the live blocker: the three package entries are redirected to
    // the host while the provider subpath still loads the checkout's pi-ai.
    const proof = redirectedProof();
    const result = evaluateSingletonProof({
      proof: {
        ...proof,
        specifiers: proof.specifiers.map((entry) =>
          entry.specifier === "@earendil-works/pi-ai/providers/openai-codex"
            ? {
                specifier: entry.specifier,
                bareResolution: LOCAL_CODEX_SUBPATH_ENTRY,
                redirected: false,
              }
            : entry,
        ),
      },
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [HOST_ENTRY, HOST_AI_ENTRY],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).toBe("subpath-not-host");
    expect(
      result.reasons.some((reason) =>
        reason.includes("providers/openai-codex"),
      ),
    ).toBe(true);
  });

  it("rejects a proof line that omits the codex subpath entirely", () => {
    const proof = redirectedProof();
    const result = evaluateSingletonProof({
      proof: {
        ...proof,
        specifiers: proof.specifiers.filter(
          (entry) =>
            entry.specifier !== "@earendil-works/pi-ai/providers/openai-codex",
        ),
      },
      expectedHostVersion: "0.84.2",
      expectedHostRoot: HOST_ROOT,
      checkoutCopyExists: true,
      mappedPaths: [HOST_ENTRY, HOST_AI_ENTRY],
      checkoutRoot: CHECKOUT_ROOT,
    });
    expect(result.verdict).toBe("proof-incomplete");
  });
});

describe("buildProofEnv", () => {
  it("sets proof env, forces offline, and strips child variables", () => {
    const env = buildProofEnv(
      {
        PATH: "/bin",
        WEAVE_CHILD_SECRET: "secret",
        WEAVE_CHILD_ID: "child",
        [WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV]: "1",
        PI_CODING_AGENT_DIR: "/tmp/agent",
        HOME: "/Users/jose",
      },
      {
        WEAVE_PI_HOST_MODULE_PROOF: "1",
        PI_OFFLINE: "1",
      },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/Users/jose");
    expect(env.WEAVE_PI_HOST_MODULE_PROOF).toBe("1");
    expect(env.PI_OFFLINE).toBe("1");
    expect(env.WEAVE_CHILD_SECRET).toBeUndefined();
    expect(env.WEAVE_CHILD_ID).toBeUndefined();
    expect(env[WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV]).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });
});

describe("formatSummary", () => {
  it("prints a compact PASS line", () => {
    expect(
      formatSummary({
        kind: "PASS",
        hostVersion: "0.84.2",
        artifactSha256: "abc",
        positive: "single-copy",
        negative: "duplicate-detected",
      }),
    ).toBe(
      "PASS hostVersion=0.84.2 artifactSha256=abc positive=single-copy negative=duplicate-detected",
    );
  });
});

describe("hostPackageJsonCandidates", () => {
  it("includes the dist/cli parent and the bun global install", () => {
    const candidates = hostPackageJsonCandidates(
      "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      { BUN_INSTALL: "/Users/jose/.bun", HOME: "/Users/jose" },
    );
    expect(candidates).toContain(
      "/opt/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
    );
    expect(candidates).toContain(
      "/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/package.json",
    );
  });
});
