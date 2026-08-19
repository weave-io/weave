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
  closeProofInput,
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
  type ProofSubprocess,
  parseHostPackageIdentity,
  parseLinuxMapsOutput,
  parseLsofDefaultOutput,
  parseLsofFnOutput,
  parseProofLine,
  parseVerifyArgs,
  readUntilProof,
  type SpawnedProof,
  terminateSpawned,
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

function outputStream(
  chunks: readonly string[],
  delayMs = 0,
): ReadableStream<Uint8Array> {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = encoded[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      if (delayMs > 0) await Bun.sleep(delayMs);
      controller.enqueue(chunk);
    },
  });
}

function neverClosingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => undefined);
    },
  });
}

function proofProcess(input: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited?: Promise<number>;
  readonly exitCode?: number | null;
}): SpawnedProof {
  const subprocess: ProofSubprocess = {
    stdin: undefined,
    stdout: input.stdout,
    stderr: input.stderr,
    exited: input.exited ?? Promise.resolve(0),
    exitCode: input.exitCode ?? 0,
    killed: false,
    pid: 4242,
    kill: () => undefined,
  };
  return { subprocess, pid: 4242, output: "" };
}

describe("readUntilProof", () => {
  const proofLine = JSON.stringify({
    weaveHostModuleProof: redirectedProof(),
  });

  it("returns a valid proof from either child output stream", async () => {
    const result = await readUntilProof(
      proofProcess({
        stdout: outputStream(["ordinary output\n"]),
        stderr: outputStream([
          proofLine.slice(0, 20),
          proofLine.slice(20),
          "\n",
        ]),
      }),
      100,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual(redirectedProof());
  });

  it("reports missing proof after both streams close and the child exits", async () => {
    const result = await readUntilProof(
      proofProcess({
        stdout: outputStream(["ordinary output\n"]),
        stderr: outputStream(["no proof here\n"]),
        exited: Promise.resolve(7),
        exitCode: 7,
      }),
      100,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("ProofMissing");
    expect(result.error.message).toContain("exited 7");
  });

  it("preserves malformed and oversized proof diagnostics", async () => {
    const malformed = await readUntilProof(
      proofProcess({
        stdout: outputStream([]),
        stderr: outputStream(['{"weaveHostModuleProof":']),
        exited: Promise.resolve(1),
        exitCode: 1,
      }),
      100,
    );
    expect(malformed.isErr()).toBe(true);
    if (malformed.isOk()) return;
    expect(malformed.error.type).toBe("ProofInvalid");

    const oversized = JSON.stringify({
      weaveHostModuleProof: { specifiers: [], pad: "x".repeat(40_000) },
    });
    const tooLarge = await readUntilProof(
      proofProcess({
        stdout: outputStream([]),
        stderr: outputStream([oversized]),
        exited: Promise.resolve(1),
        exitCode: 1,
      }),
      100,
    );
    expect(tooLarge.isErr()).toBe(true);
    if (tooLarge.isOk()) return;
    expect(tooLarge.error.type).toBe("ProofInvalid");
  });

  it("fails closed on an exit rejection", async () => {
    const result = await readUntilProof(
      proofProcess({
        stdout: outputStream([]),
        stderr: outputStream([]),
        exited: Promise.reject(new Error("exit status unavailable")),
        exitCode: null,
      }),
      100,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("SpawnFailed");
  });

  it("returns ProofTimeout and cancels open output streams", async () => {
    const result = await readUntilProof(
      proofProcess({
        stdout: neverClosingStream(),
        stderr: neverClosingStream(),
        exited: new Promise(() => undefined),
        exitCode: null,
      }),
      10,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("ProofTimeout");
  });

  it("waits for stream close after child exit before declaring proof missing", async () => {
    const result = await readUntilProof(
      proofProcess({
        stdout: outputStream([], 20),
        stderr: outputStream([proofLine], 20),
        exited: Promise.resolve(0),
        exitCode: 0,
      }),
      100,
    );
    expect(result.isOk()).toBe(true);
  });
});

describe("proof child cleanup", () => {
  it("closes stdin before terminating the owned child", async () => {
    const events: string[] = [];
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stdin = {
      end: () => {
        events.push("stdin.end");
      },
    } as unknown as Bun.FileSink;
    const subprocess: ProofSubprocess = {
      stdin,
      stdout: outputStream([]),
      stderr: outputStream([]),
      exited,
      exitCode: null,
      killed: false,
      pid: 4242,
      kill: (signal) => {
        events.push(String(signal));
        resolveExit?.(0);
      },
    };
    const spawned: SpawnedProof = { subprocess, pid: 4242, output: "" };

    const result = await terminateSpawned(spawned);

    expect(result.isOk()).toBe(true);
    expect(events).toEqual(["stdin.end", "SIGTERM"]);
  });

  it("does not touch absent stdin", () => {
    const subprocess: ProofSubprocess = {
      stdin: undefined,
      stdout: outputStream([]),
      stderr: outputStream([]),
      exited: Promise.resolve(0),
      exitCode: 0,
      killed: false,
      pid: 4242,
      kill: () => undefined,
    };
    expect(() => closeProofInput(subprocess)).not.toThrow();
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
        BUN_INSTALL: "/Users/jose/.bun",
        HOME: "/Users/jose",
        OPENAI_API_KEY: "must-not-cross-process-boundary",
        WEAVE_CHILD_SECRET: "secret",
        WEAVE_CHILD_ID: "child",
        [WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV]: "1",
        PI_CODING_AGENT_DIR: "/tmp/agent",
      },
      {
        WEAVE_PI_HOST_MODULE_PROOF: "1",
        PI_OFFLINE: "1",
      },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.BUN_INSTALL).toBe("/Users/jose/.bun");
    expect(env.HOME).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
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
