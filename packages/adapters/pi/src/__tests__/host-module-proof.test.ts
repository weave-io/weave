import { describe, expect, it } from "bun:test";
import { errAsync, type ResultAsync } from "neverthrow";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";
import {
  MAX_HOST_MODULE_PROOF_LINE_LENGTH,
  maybeWriteHostModuleProofLine,
  type PiHostModuleEnvironmentError,
  type PiHostModuleEnvironmentPort,
  type PiHostModuleOutcome,
  renderHostModuleProofLine,
  resolveHostModules,
  WEAVE_PI_HOST_MODULE_PROOF_ENV,
} from "../host-module-loader.js";
import { PI_HOST_MODULE_SPECIFIERS } from "../host-module-redirect.js";

const HOST_ROOT = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const HOST_VERSION = "0.84.2";
const HOST_ENTRY = `${HOST_ROOT}/dist/index.js`;
const LOCAL_ENTRY =
  "/Users/jose/projects/weave/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

function sampleOutcome(): PiHostModuleOutcome {
  return {
    redirected: ["@earendil-works/pi-coding-agent"],
    skipped: [
      { specifier: "@earendil-works/pi-ai", reason: "no-local-copy" },
      { specifier: "@earendil-works/pi-tui", reason: "already-host" },
      {
        specifier: "@earendil-works/pi-ai/providers/openai-codex",
        reason: "already-host",
      },
    ],
    hostVersion: HOST_VERSION,
    hostRoot: HOST_ROOT,
    localResolutions: {
      "@earendil-works/pi-coding-agent": LOCAL_ENTRY,
      "@earendil-works/pi-ai": undefined,
      "@earendil-works/pi-tui": undefined,
      "@earendil-works/pi-ai/providers/openai-codex": undefined,
    },
    proofRecord: {
      hostRoot: HOST_ROOT,
      hostVersion: HOST_VERSION,
      specifiers: [
        {
          specifier: "@earendil-works/pi-coding-agent",
          hostSpecifier: "@earendil-works/pi-coding-agent",
          localEntryPath: LOCAL_ENTRY,
          hostEntryPath: HOST_ENTRY,
          redirected: true,
          bareResolution: LOCAL_ENTRY,
          loadedFrom: HOST_ENTRY,
        },
        {
          specifier: "@earendil-works/pi-ai",
          hostSpecifier: "@earendil-works/pi-ai/compat",
          redirected: false,
          skipReason: "no-local-copy",
        },
        {
          specifier: "@earendil-works/pi-tui",
          hostSpecifier: "@earendil-works/pi-tui",
          redirected: false,
          skipReason: "already-host",
        },
        {
          specifier: "@earendil-works/pi-ai/providers/openai-codex",
          hostSpecifier: "@earendil-works/pi-ai/providers/openai-codex",
          redirected: false,
          skipReason: "already-host",
        },
      ],
    },
  };
}

class UnavailableHostEnvironment implements PiHostModuleEnvironmentPort {
  mainModulePath(): ResultAsync<string, PiHostModuleEnvironmentError> {
    return errAsync({ type: "MainModuleUnavailable" });
  }

  readJsonFile(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    return errAsync({ type: "JsonReadFailed", path });
  }

  resolveFrom(
    specifier: string,
    _fromDir: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    return errAsync({ type: "ResolveFailed", specifier });
  }

  resolveLocal(
    specifier: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    return errAsync({ type: "ResolveFailed", specifier });
  }

  registerLoadOverride(
    exactPath: string,
  ): ResultAsync<void, PiHostModuleEnvironmentError> {
    return errAsync({ type: "RegisterOverrideFailed", path: exactPath });
  }

  importAbsolute(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    return errAsync({ type: "ImportFailed", path });
  }
}

describe("renderHostModuleProofLine", () => {
  it("emits one bounded valid JSON line with the required proof shape", () => {
    const line = renderHostModuleProofLine(sampleOutcome());
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThanOrEqual(MAX_HOST_MODULE_PROOF_LINE_LENGTH);
    const parsed = JSON.parse(line) as {
      readonly weaveHostModuleProof: {
        readonly hostRoot: string;
        readonly hostVersion: string;
        readonly specifiers: readonly {
          readonly specifier: string;
          readonly bareResolution?: string;
          readonly loadedFrom?: string;
          readonly redirected: boolean;
        }[];
      };
    };
    expect(parsed).toEqual({
      weaveHostModuleProof: {
        hostRoot: HOST_ROOT,
        hostVersion: HOST_VERSION,
        specifiers: [
          {
            specifier: "@earendil-works/pi-coding-agent",
            bareResolution: LOCAL_ENTRY,
            loadedFrom: HOST_ENTRY,
            redirected: true,
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
            redirected: false,
          },
        ],
      },
    });
    expect(parsed.weaveHostModuleProof.hostRoot.startsWith("/")).toBe(true);
    expect(
      parsed.weaveHostModuleProof.specifiers[0]?.bareResolution?.startsWith(
        "/",
      ),
    ).toBe(true);
    expect(
      parsed.weaveHostModuleProof.specifiers[0]?.loadedFrom?.startsWith("/"),
    ).toBe(true);
    expect(parsed.weaveHostModuleProof.specifiers).toHaveLength(
      PI_HOST_MODULE_SPECIFIERS.length,
    );
  });
});

describe("maybeWriteHostModuleProofLine", () => {
  it("writes exactly one line only when the env var is the value 1", () => {
    const written: string[] = [];
    const outcome = sampleOutcome();
    const write = (line: string): void => {
      written.push(line);
    };

    expect(
      maybeWriteHostModuleProofLine(outcome, { env: {}, proofWrite: write }),
    ).toBe(false);
    expect(
      maybeWriteHostModuleProofLine(outcome, {
        env: { [WEAVE_PI_HOST_MODULE_PROOF_ENV]: "true" },
        proofWrite: write,
      }),
    ).toBe(false);
    expect(
      maybeWriteHostModuleProofLine(outcome, {
        env: { [WEAVE_PI_HOST_MODULE_PROOF_ENV]: "0" },
        proofWrite: write,
      }),
    ).toBe(false);
    expect(
      maybeWriteHostModuleProofLine(outcome, {
        env: { [WEAVE_PI_HOST_MODULE_PROOF_ENV]: "1" },
        proofWrite: write,
      }),
    ).toBe(true);

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toEqual(
      JSON.parse(renderHostModuleProofLine(outcome)),
    );
  });
});

describe("resolveHostModules proof gating", () => {
  it("does not write a proof line when the env var is unset", async () => {
    const written: string[] = [];
    const result = await resolveHostModules(new UnavailableHostEnvironment(), {
      env: {},
      proofWrite: (line) => {
        written.push(line);
      },
    });
    expect(result.isOk()).toBe(true);
    expect(written).toEqual([]);
  });

  it("writes one valid JSON proof line when the env var is 1", async () => {
    const written: string[] = [];
    const result = await resolveHostModules(new UnavailableHostEnvironment(), {
      env: { [WEAVE_PI_HOST_MODULE_PROOF_ENV]: "1" },
      proofWrite: (line) => {
        written.push(line);
      },
    });
    expect(result.isOk()).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.includes("\n")).toBe(false);
    const parsed = JSON.parse(written[0] ?? "") as {
      readonly weaveHostModuleProof: {
        readonly specifiers: readonly unknown[];
      };
    };
    expect(parsed.weaveHostModuleProof.specifiers).toHaveLength(
      PI_HOST_MODULE_SPECIFIERS.length,
    );
  });
});

describe("capability declarations", () => {
  it("does not declare a host-runtime capability", () => {
    const ids = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.map(
      (capability) => capability.id,
    );
    expect(ids).not.toContain("host-runtime-duplicate");
    expect(ids.some((id) => id.includes("host-runtime"))).toBe(false);
  });
});
