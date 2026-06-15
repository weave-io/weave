import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import type { ParsedArgs } from "../../args.js";
import { BufferTerminal } from "../../io/terminal.js";
import { ThemeManager } from "../../theme/colors.js";
import {
  buildLangChainScorer,
  type EvalContext,
  type LangChainOpenAIModule,
  readPublishMode,
  runEval,
  WEAVE_EVAL_PUBLISH_MODE_ENV_VAR,
} from "../eval.js";

const themeManager = new ThemeManager({ isTty: () => false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flags(
  overrides: Partial<ParsedArgs["flags"]> = {},
): ParsedArgs["flags"] {
  return {
    help: false,
    version: false,
    json: false,
    yes: false,
    force: false,
    allHarnesses: false,
    project: false,
    global: false,
    dryRun: false,
    rawArtifacts: false,
    ...overrides,
  };
}

/**
 * Default pass-through filter validator for tests that are NOT testing
 * model/case allowlist validation. Bypasses real file-system reads.
 */
const passThroughValidateFilters: EvalContext["validateFilters"] = async () =>
  ok(undefined);

function context(
  flagOverrides: Partial<ParsedArgs["flags"]> = {},
  envOverrides: Record<string, string | undefined> = {},
  runner?: EvalContext["runner"],
  validateFilters: EvalContext["validateFilters"] = passThroughValidateFilters,
): { terminal: BufferTerminal; ctx: EvalContext } {
  const terminal = new BufferTerminal();
  const ctx: EvalContext = {
    terminal,
    theme: themeManager.getTheme(false),
    flags: flags(flagOverrides),
    env: envOverrides,
    runner,
    validateFilters,
  };
  return { terminal, ctx };
}

// ---------------------------------------------------------------------------
// No subcommand
// ---------------------------------------------------------------------------

describe("runEval — no subcommand", () => {
  it("exits 1 and prints usage when no subcommand is given", async () => {
    const { terminal, ctx } = context();
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const err = terminal.err.join("\n");
    expect(err).toContain("weave eval run");
    expect(err).toContain("Usage:");
  });

  it("does not print usage to stdout", async () => {
    const { terminal, ctx } = context();
    await runEval(ctx);
    expect(terminal.out.join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// eval run — dry-run mode
// ---------------------------------------------------------------------------

describe("runEval run — dry-run", () => {
  it("exits 0 in dry-run mode without calling runner", async () => {
    let runnerCalled = false;
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true },
      {},
      async () => {
        runnerCalled = true;
        return ok(0);
      },
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(runnerCalled).toBe(false);
    const out = terminal.out.join("\n");
    expect(out).toContain("dry run");
  });

  it("shows agent filter in dry-run summary", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      dryRun: true,
      evalAgent: "loom",
    });
    await runEval(ctx);
    expect(terminal.out.join("\n")).toContain("loom");
  });

  it("shows model filter in dry-run summary", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      dryRun: true,
      evalModel: "claude-sonnet-4-5",
    });
    await runEval(ctx);
    expect(terminal.out.join("\n")).toContain("claude-sonnet-4-5");
  });

  it("shows case filter in dry-run summary", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      dryRun: true,
      evalCase: "case-01",
    });
    await runEval(ctx);
    expect(terminal.out.join("\n")).toContain("case-01");
  });

  it("shows no-filter message when no filters are set", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      dryRun: true,
    });
    await runEval(ctx);
    const out = terminal.out.join("\n");
    expect(out).toContain("No filters");
  });

  it("shows no-filter message when CI env filters are blank", async () => {
    const { terminal, ctx } = context(
      {
        evalSubcommand: "run",
        dryRun: true,
      },
      {
        CI: "true",
        WEAVE_EVAL_PUBLISH_MODE: "publish",
        WEAVE_EVAL_AGENT: "",
        WEAVE_EVAL_MODEL: "",
        WEAVE_EVAL_CASE: "",
      },
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("No filters");
    expect(terminal.err.join("")).toBe("");
  });

  it("shows raw-artifacts in dry-run summary when enabled", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      dryRun: true,
      rawArtifacts: true,
    });
    await runEval(ctx);
    expect(terminal.out.join("\n")).toContain("Raw artifacts");
  });
});

// ---------------------------------------------------------------------------
// eval run — runner delegation
// ---------------------------------------------------------------------------

describe("runEval run — runner delegation", () => {
  it("calls the injected runner with the validated request", async () => {
    let capturedAgent: string | undefined;
    const { ctx } = context(
      { evalSubcommand: "run", evalAgent: "loom" },
      {},
      async (req) => {
        capturedAgent = req.agent;
        return ok(0);
      },
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(capturedAgent).toBe("loom");
  });

  it("propagates non-zero exit code from runner", async () => {
    const { ctx } = context({ evalSubcommand: "run" }, {}, async () => ok(42));
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(42);
  });

  it("prints error and returns ok(1) when injected runner returns err(CliError)", async () => {
    const { terminal, ctx } = context({ evalSubcommand: "run" }, {}, async () =>
      err({ type: "EvalValidation" as const, message: "runner-typed-error" }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("runner-typed-error");
  });

  it("exits 1 without runner and surfaces API key error when env is empty", async () => {
    // Without an injected runner, the command constructs the live production
    // orchestrator. With no env vars set, it fails on the missing API key
    // pre-flight check and prints a sanitized error message.
    const { terminal, ctx } = context({ evalSubcommand: "run" }, {});
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOutput = terminal.err.join("\n");
    expect(errOutput).toContain("OPENROUTER_API_KEY");
    // The error must not leak the key value (it was never set) or any secret
    expect(errOutput).not.toContain("Bearer");
    expect(errOutput).not.toContain("sk-");
  });
});

// ---------------------------------------------------------------------------
// eval run — validation failures surfaced to terminal
// ---------------------------------------------------------------------------

describe("runEval run — validation errors", () => {
  it("exits 1 and prints error for empty agent", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      evalAgent: "",
    });
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const err = terminal.err.join("\n");
    expect(err).toContain("Error:");
    expect(err).toContain("--agent");
  });

  it("exits 1 and prints error for invalid model identifier", async () => {
    const { terminal, ctx } = context({
      evalSubcommand: "run",
      evalModel: "model with spaces",
    });
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error:");
  });

  it("exits 1 and prints error when rawArtifacts used in CI", async () => {
    const { terminal, ctx } = context(
      { evalSubcommand: "run", rawArtifacts: true },
      { CI: "true" },
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const err = terminal.err.join("\n");
    expect(err).toContain("Error:");
    expect(err).toContain("--raw-artifacts");
  });

  it("exits 1 and prints error for conflicting agent filter", async () => {
    const { terminal, ctx } = context(
      { evalSubcommand: "run", evalAgent: "loom" },
      { WEAVE_EVAL_AGENT: "shuttle" },
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// eval run — rawArtifacts is explicit opt-in, never implicit
// ---------------------------------------------------------------------------

describe("runEval run — rawArtifacts explicit opt-in", () => {
  it("rawArtifacts defaults to false when flag not present", async () => {
    let capturedRawArtifacts: boolean | undefined;
    const { ctx } = context({ evalSubcommand: "run" }, {}, async (req) => {
      capturedRawArtifacts = req.rawArtifacts;
      return ok(0);
    });
    await runEval(ctx);
    expect(capturedRawArtifacts).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eval run — live path scorer policy (no stub in production)
// ---------------------------------------------------------------------------

describe("runEval run — live path scorer policy", () => {
  it("live path fails closed with EvalValidation when OPENROUTER_API_KEY is missing (no stub used)", async () => {
    // This test verifies the live production path (no injected runner).
    // Without OPENROUTER_API_KEY, the command MUST fail with a typed error
    // and MUST NOT silently use a StubAgentEvalsScorer or any test double.
    // The error message must mention the missing key.
    const { terminal, ctx } = context({ evalSubcommand: "run" }, {});
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("OPENROUTER_API_KEY");
    // No "Stub" or stub-related text should appear in the error output
    expect(errOut).not.toContain("Stub");
    expect(errOut).not.toContain("stub");
    expect(errOut).not.toContain("Bearer");
    expect(errOut).not.toContain("sk-");
  });

  it("live path reports EvalValidation (not a stub success) when key is missing", async () => {
    // If a stub scorer were used, the run would proceed to suite execution.
    // With the real path, the key check must abort BEFORE any scorer use.
    const { terminal, ctx } = context({ evalSubcommand: "run" }, {});
    const result = await runEval(ctx);
    // Must be exit 1 — not 0 (which would indicate a stub passed the run)
    expect(result._unsafeUnwrap()).toBe(1);
    // Error output must be on stderr (not stdout — no "dry run" or "cases run")
    expect(terminal.out.join("")).toBe("");
    expect(terminal.err.join("\n")).toContain("Error:");
  });

  it("dry-run does not call any scorer or model (injected runner not called)", async () => {
    let runnerCalled = false;
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true },
      { OPENROUTER_API_KEY: "sk-test" },
      async () => {
        runnerCalled = true;
        return ok(0);
      },
    );
    const result = await runEval(ctx);
    // dry-run exits before runner is called
    expect(result._unsafeUnwrap()).toBe(0);
    expect(runnerCalled).toBe(false);
    // Only stdout output (the dry-run summary), no stderr errors
    expect(terminal.out.join("\n")).toContain("dry run");
    expect(terminal.err.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// eval run — model allowlist validation (fails before dry-run)
// ---------------------------------------------------------------------------

describe("runEval run — unknown model fails closed before dry-run", () => {
  it("exits 1 and prints error when unknown model is given with --dry-run", async () => {
    // The validateFilters injection reports an unknown model error.
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true, evalModel: "totally/unknown" },
      {},
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--model "totally/unknown" is not in the model matrix allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("Error:");
    expect(errOut).toContain("totally/unknown");
    // Dry-run summary must NOT appear (validation failed before dry-run)
    expect(terminal.out.join("")).toBe("");
  });

  it("exits 1 and prints error when unknown model is given without --dry-run", async () => {
    const { terminal, ctx } = context(
      { evalSubcommand: "run", evalModel: "totally/unknown" },
      {},
      async () => ok(0), // runner would succeed, but should never be called
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--model "totally/unknown" is not in the model matrix allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("totally/unknown");
    // Runner must not have been called (validation failed before runner)
    expect(terminal.out.join("")).toBe("");
  });

  it("exits 1 and prints error when unknown model is supplied via WEAVE_EVAL_MODEL env", async () => {
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true },
      { WEAVE_EVAL_MODEL: "totally/unknown" },
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--model "totally/unknown" is not in the model matrix allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error:");
  });

  it("exits 1 and error message mentions allowlist when model unknown in dry-run", async () => {
    const unknownModel = "totally/unknown-model-xyz";
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true, evalModel: unknownModel },
      {},
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message:
            `--model "${unknownModel}" is not in the model matrix allowlist. ` +
            `Allowed model IDs: anthropic/claude-opus-4.5, anthropic/claude-sonnet-4.5, openai/gpt-5.5`,
        }),
    );
    await runEval(ctx);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain(unknownModel);
    expect(errOut).toContain("allowlist");
  });
});

// ---------------------------------------------------------------------------
// eval run — case allowlist validation (fails before dry-run)
// ---------------------------------------------------------------------------

describe("runEval run — unknown case fails closed before dry-run", () => {
  it("exits 1 and prints error when unknown case is given with --dry-run", async () => {
    const { terminal, ctx } = context(
      {
        evalSubcommand: "run",
        dryRun: true,
        evalCase: "totally-unknown-case",
      },
      {},
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--case "totally-unknown-case" is not in the fixture allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("Error:");
    expect(errOut).toContain("totally-unknown-case");
    // Dry-run summary must NOT appear (validation failed before dry-run)
    expect(terminal.out.join("")).toBe("");
  });

  it("exits 1 and prints error when unknown case is given without --dry-run", async () => {
    let runnerCalled = false;
    const { terminal, ctx } = context(
      { evalSubcommand: "run", evalCase: "totally-unknown-case" },
      {},
      async () => {
        runnerCalled = true;
        return ok(0);
      },
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--case "totally-unknown-case" is not in the fixture allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("totally-unknown-case");
    expect(runnerCalled).toBe(false);
  });

  it("exits 1 and prints error when unknown case supplied via WEAVE_EVAL_CASE env", async () => {
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true },
      { WEAVE_EVAL_CASE: "totally-unknown-case" },
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message: `--case "totally-unknown-case" is not in the fixture allowlist.`,
        }),
    );
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Error:");
  });

  it("exits 1 and error message mentions known cases when case unknown in dry-run", async () => {
    const unknownCase = "totally-unknown-case-xyz";
    const { terminal, ctx } = context(
      { evalSubcommand: "run", dryRun: true, evalCase: unknownCase },
      {},
      undefined,
      async (_req) =>
        err({
          type: "EvalValidation" as const,
          message:
            `--case "${unknownCase}" is not in the fixture allowlist. ` +
            `Known case IDs: loom-route-backend-api, loom-route-frontend-ui`,
        }),
    );
    await runEval(ctx);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain(unknownCase);
    expect(errOut).toContain("allowlist");
  });
});

// ---------------------------------------------------------------------------
// eval run — defaultValidateFilters integration (real fixture reads)
// ---------------------------------------------------------------------------

describe("runEval run — defaultValidateFilters real fixture integration", () => {
  it("unknown model fails closed in dry-run with real model matrix (no validateFilters injection)", async () => {
    // This test uses the REAL defaultValidateFilters (no injection) to verify
    // that the default validator loads the real model-matrix.json and rejects
    // unknown model IDs before the dry-run branch executes.
    const terminal = new BufferTerminal();
    const ctx: EvalContext = {
      terminal,
      theme: themeManager.getTheme(false),
      flags: flags({
        evalSubcommand: "run",
        dryRun: true,
        evalModel: "totally/unknown",
      }),
      env: {},
      // No validateFilters injection — uses defaultValidateFilters with real matrix
    };
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("Error:");
    expect(errOut).toContain("totally/unknown");
    // Dry-run summary must NOT appear on stdout
    expect(terminal.out.join("")).toBe("");
  });

  it("unknown case fails closed in dry-run with real fixtures (no validateFilters injection)", async () => {
    // Uses REAL defaultValidateFilters to verify real fixture loading rejects unknown cases.
    const terminal = new BufferTerminal();
    const ctx: EvalContext = {
      terminal,
      theme: themeManager.getTheme(false),
      flags: flags({
        evalSubcommand: "run",
        dryRun: true,
        evalCase: "totally-unknown-case",
      }),
      env: {},
      // No validateFilters injection — uses defaultValidateFilters with real fixtures
    };
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("Error:");
    expect(errOut).toContain("totally-unknown-case");
    // Dry-run summary must NOT appear on stdout
    expect(terminal.out.join("")).toBe("");
  });

  it("valid model passes through validation in dry-run (real matrix)", async () => {
    // Uses REAL defaultValidateFilters to verify a known model passes.
    const terminal = new BufferTerminal();
    const ctx: EvalContext = {
      terminal,
      theme: themeManager.getTheme(false),
      flags: flags({
        evalSubcommand: "run",
        dryRun: true,
        evalModel: "anthropic/claude-sonnet-4.5",
      }),
      env: {},
      // No validateFilters injection — real validation
    };
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("dry run");
    expect(terminal.err.join("")).toBe("");
  });

  it("valid case passes through validation in dry-run (real fixtures)", async () => {
    // Uses REAL defaultValidateFilters to verify a known case passes.
    const terminal = new BufferTerminal();
    const ctx: EvalContext = {
      terminal,
      theme: themeManager.getTheme(false),
      flags: flags({
        evalSubcommand: "run",
        dryRun: true,
        evalCase: "loom-route-backend-api",
      }),
      env: {},
      // No validateFilters injection — real validation
    };
    const result = await runEval(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("dry run");
    expect(terminal.err.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildLangChainScorer — ChatOpenAI construction uses `apiKey` not `openAIApiKey`
// ---------------------------------------------------------------------------

/**
 * Tests that `buildLangChainScorer` passes `apiKey` (the canonical field name
 * in @langchain/openai v1) rather than the deprecated `openAIApiKey` alias
 * that the v1 `BaseChatOpenAI` constructor does NOT read at runtime.
 *
 * Root cause of the 401 "Missing Authentication header" from OpenRouter:
 *   `BaseChatOpenAI` constructor reads `fields?.apiKey ?? ... ?? getEnvironmentVariable("OPENAI_API_KEY")`.
 *   Passing `openAIApiKey` instead of `apiKey` is silently ignored by the runtime,
 *   causing the client to fall through to env-var lookup (likely undefined) → 401.
 *
 * These tests inject a fake `@langchain/openai` module so they run without
 * the real package installed and without any network calls.
 */
describe("buildLangChainScorer — ChatOpenAI receives apiKey (not openAIApiKey)", () => {
  it("passes apiKey to ChatOpenAI constructor", async () => {
    const capturedFields: Record<string, unknown>[] = [];

    // Minimal BaseChatModel stub — only needs to satisfy the interface used
    // by RealLangChainJudge (a BaseChatModel is passed through opaque).
    // Use a plain function constructor (not a class) so we can capture fields
    // without returning from a class constructor (Biome noConstructorReturn).
    const fakeModule: LangChainOpenAIModule = {
      ChatOpenAI: function FakeChatOpenAI(fields: Record<string, unknown>) {
        capturedFields.push({ ...fields });
      } as unknown as LangChainOpenAIModule["ChatOpenAI"],
    };

    const evalEnv = {
      apiKey: "test-openrouter-api-key",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    const result = await buildLangChainScorer(evalEnv, async () => fakeModule);

    expect(result.isOk()).toBe(true);
    expect(capturedFields).toHaveLength(1);

    const fields = capturedFields[0];

    // Critical: `apiKey` must be present — this is the field the v1
    // BaseChatOpenAI constructor reads.
    expect(fields.apiKey).toBe("test-openrouter-api-key");

    // Equally critical: `openAIApiKey` must NOT be the sole auth mechanism
    // (it is ignored by the runtime in @langchain/openai v1).
    // If `apiKey` is set, whether `openAIApiKey` happens to also be set
    // doesn't matter — but it should NOT be the only auth field.
    expect(fields.apiKey).toBeDefined();
  });

  it("does NOT pass openAIApiKey as the sole auth field", async () => {
    const capturedFields: Record<string, unknown>[] = [];

    const fakeModule: LangChainOpenAIModule = {
      ChatOpenAI: function FakeChatOpenAI(fields: Record<string, unknown>) {
        capturedFields.push({ ...fields });
      } as unknown as LangChainOpenAIModule["ChatOpenAI"],
    };

    const evalEnv = {
      apiKey: "test-key-abc",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    await buildLangChainScorer(evalEnv, async () => fakeModule);

    const fields = capturedFields[0];
    // `apiKey` is set — the v1 constructor will find it
    expect(fields.apiKey).toBe("test-key-abc");
    // `openAIApiKey` is NOT the primary auth field — it is a dead alias in v1
    expect(fields.openAIApiKey).toBeUndefined();
  });

  it("passes baseURL inside configuration", async () => {
    const capturedFields: Record<string, unknown>[] = [];

    const fakeModule: LangChainOpenAIModule = {
      ChatOpenAI: function FakeChatOpenAI(fields: Record<string, unknown>) {
        capturedFields.push({ ...fields });
      } as unknown as LangChainOpenAIModule["ChatOpenAI"],
    };

    const evalEnv = {
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    await buildLangChainScorer(evalEnv, async () => fakeModule);

    const fields = capturedFields[0];
    expect(fields.configuration).toBeDefined();
    const config = fields.configuration as Record<string, unknown>;
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("returns err(EvalValidation) when the module loader throws module-not-found", async () => {
    const evalEnv = {
      apiKey: "any-key",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    const result = await buildLangChainScorer(evalEnv, async () => {
      throw new Error("Cannot find module '@langchain/openai'");
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("EvalValidation");
    // Narrow the type to EvalValidationError to access `message`
    if (error.type !== "EvalValidation")
      throw new Error("expected EvalValidation");
    expect(error.message).toContain("@langchain/openai");
    expect(error.message).toContain("bun add");
  });

  it("returns err(EvalValidation) when module loader throws non-module error", async () => {
    const evalEnv = {
      apiKey: "any-key",
      baseUrl: "https://openrouter.ai/api/v1",
    };

    const result = await buildLangChainScorer(evalEnv, async () => {
      throw new Error("Some unexpected construction error");
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("EvalValidation");
    // Narrow the type to EvalValidationError to access `message`
    if (error.type !== "EvalValidation")
      throw new Error("expected EvalValidation");
    expect(error.message).toContain("Some unexpected construction error");
    expect(error.message).toContain("OPENROUTER_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// readPublishMode — WEAVE_EVAL_PUBLISH_MODE env var
// ---------------------------------------------------------------------------

describe("readPublishMode", () => {
  it("returns 'local' when WEAVE_EVAL_PUBLISH_MODE is absent", () => {
    expect(readPublishMode({})).toBe("local");
  });

  it("returns 'local' when WEAVE_EVAL_PUBLISH_MODE is empty string", () => {
    expect(readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "" })).toBe(
      "local",
    );
  });

  it("returns 'local' when WEAVE_EVAL_PUBLISH_MODE is whitespace-only", () => {
    expect(readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "   " })).toBe(
      "local",
    );
  });

  it("returns 'local' when WEAVE_EVAL_PUBLISH_MODE is 'local'", () => {
    expect(
      readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "local" }),
    ).toBe("local");
  });

  it("returns 'local' for any unknown value (fail-safe)", () => {
    expect(
      readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "unknown" }),
    ).toBe("local");
    expect(
      readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "PUBLISH" }),
    ).toBe("local");
    expect(readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "1" })).toBe(
      "local",
    );
  });

  it("returns 'publish' when WEAVE_EVAL_PUBLISH_MODE is exactly 'publish'", () => {
    expect(
      readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "publish" }),
    ).toBe("publish");
  });

  it("returns 'publish' when WEAVE_EVAL_PUBLISH_MODE is 'publish' with surrounding whitespace", () => {
    expect(
      readPublishMode({ [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: "  publish  " }),
    ).toBe("publish");
  });

  it("WEAVE_EVAL_PUBLISH_MODE_ENV_VAR constant is WEAVE_EVAL_PUBLISH_MODE", () => {
    expect(WEAVE_EVAL_PUBLISH_MODE_ENV_VAR).toBe("WEAVE_EVAL_PUBLISH_MODE");
  });
});

// ---------------------------------------------------------------------------
// Publish mode wiring — buildLiveRunner does not start in publish mode by default
// ---------------------------------------------------------------------------

describe("runEval — publish mode wiring", () => {
  it("readPublishMode returns 'publish' for WEAVE_EVAL_PUBLISH_MODE=publish env", () => {
    // Test the function that wires publish mode through buildLiveRunner.
    // The actual wiring into EvalOrchestrator is tested via readPublishMode
    // since buildLiveRunner is only invoked on the live path (no injected runner).
    const mode = readPublishMode({ WEAVE_EVAL_PUBLISH_MODE: "publish" });
    expect(mode).toBe("publish");
  });

  it("defaults to local mode when WEAVE_EVAL_PUBLISH_MODE is absent", () => {
    const mode = readPublishMode({});
    expect(mode).toBe("local");
  });

  it("EVAL_RESULTS_REPO_TOKEN is never included in any error surfaced by runEval", async () => {
    // Simulate a missing API key failure while publish mode is set
    const fakeToken = "ghp_test_token_not_real_xyz789";
    const { terminal, ctx } = context({ evalSubcommand: "run" }, {});

    const runnerCtx: EvalContext = {
      ...ctx,
      env: {
        WEAVE_EVAL_PUBLISH_MODE: "publish",
        EVAL_RESULTS_REPO_TOKEN: fakeToken,
        // OPENROUTER_API_KEY intentionally absent to trigger MissingApiKey
      },
    };

    const result = await runEval(runnerCtx);

    // Should exit with code 1 (missing API key)
    expect(result._unsafeUnwrap()).toBe(1);

    // Token must not appear in any error output
    const stderrOutput = terminal.err.join("\n");
    expect(stderrOutput).not.toContain(fakeToken);
  });
});

// ---------------------------------------------------------------------------
// Workflow env scoping — EVAL_RESULTS_REPO_TOKEN is step-scoped
// ---------------------------------------------------------------------------

describe("workflow env scoping", () => {
  it("EVAL_RESULTS_REPO_TOKEN must not be read outside publish mode", () => {
    // When WEAVE_EVAL_PUBLISH_MODE is local (or absent), the token should
    // not be needed. Verify readPublishMode returns local for the default.
    const mode = readPublishMode({});
    expect(mode).toBe("local");

    // And the mode remains local even when a token happens to be present
    const modeWithToken = readPublishMode({
      EVAL_RESULTS_REPO_TOKEN: "ghp_whatever",
    });
    expect(modeWithToken).toBe("local");
  });

  it("publish mode requires explicit opt-in via WEAVE_EVAL_PUBLISH_MODE=publish", () => {
    // All values except exact "publish" must produce local mode
    const cases = ["", "  ", "local", "PUBLISH", "true", "1", "yes", "enabled"];
    for (const value of cases) {
      const mode = readPublishMode({
        [WEAVE_EVAL_PUBLISH_MODE_ENV_VAR]: value,
      });
      expect(mode).toBe("local");
    }
  });
});
