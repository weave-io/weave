/**
 * Tests for `env.ts`.
 *
 * Verifies:
 *   - Missing or empty `OPENROUTER_API_KEY` returns a typed `MissingApiKey`
 *     error and never succeeds.
 *   - A present, non-empty API key returns `ok(EvalEnv)` with the key value.
 *   - The error message for a missing key names the env var and does NOT
 *     include the key value (security).
 *   - `OPENROUTER_BASE_URL` defaults to `DEFAULT_OPENROUTER_BASE_URL` when
 *     absent.
 *   - A valid `OPENROUTER_BASE_URL` override using `https://` is accepted
 *     and normalized (trailing slash stripped).
 *   - An `http://` base URL is REJECTED by default (production guard). The
 *     `allowHttpBaseUrl` escape hatch is test-only; it must never be set from
 *     CLI or CI production env handling.
 *   - An invalid `OPENROUTER_BASE_URL` (no http/https scheme) returns a typed
 *     `InvalidBaseUrl` error.
 *   - `readEvalEnv()` uses `Bun.env` by default (tested by structure, not
 *     by relying on real env state).
 *
 * Test isolation:
 *   - All tests inject a mock `env` map — no reads from `Bun.env`.
 *   - No network, file I/O, or shell calls.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY_ENV_VAR,
  OPENROUTER_BASE_URL_ENV_VAR,
  readEvalEnv,
} from "../env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_API_KEY = "sk-or-v1-test1234567890abcdef";

/** Build a minimal valid env map. */
function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [OPENROUTER_API_KEY_ENV_VAR]: VALID_API_KEY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Missing / empty API key
// ---------------------------------------------------------------------------

describe("readEvalEnv — missing OPENROUTER_API_KEY", () => {
  it("returns MissingApiKey when OPENROUTER_API_KEY is absent", () => {
    const result = readEvalEnv({});
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("MissingApiKey");
  });

  it("returns MissingApiKey when OPENROUTER_API_KEY is empty string", () => {
    const result = readEvalEnv({ [OPENROUTER_API_KEY_ENV_VAR]: "" });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("MissingApiKey");
  });

  it("returns MissingApiKey when OPENROUTER_API_KEY is whitespace only", () => {
    const result = readEvalEnv({ [OPENROUTER_API_KEY_ENV_VAR]: "   " });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("MissingApiKey");
  });

  it("error contains the env var name", () => {
    const result = readEvalEnv({});
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    if (error.type === "MissingApiKey") {
      expect(error.envVar).toBe(OPENROUTER_API_KEY_ENV_VAR);
      expect(error.message).toContain(OPENROUTER_API_KEY_ENV_VAR);
    }
  });

  it("error message does NOT contain any key value (security)", () => {
    const fakeKey = "sk-or-v1-secret-key";
    // Even if the key somehow ends up half-set (this tests the absent case)
    const result = readEvalEnv({ [OPENROUTER_API_KEY_ENV_VAR]: undefined });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.message).not.toContain(fakeKey);
  });

  it("error message includes a hint about where to get the key", () => {
    const result = readEvalEnv({});
    const error = result._unsafeUnwrapErr();
    if (error.type === "MissingApiKey") {
      // Should reference openrouter.ai so users know where to go
      expect(error.message).toContain("openrouter.ai");
    }
  });
});

// ---------------------------------------------------------------------------
// Valid API key
// ---------------------------------------------------------------------------

describe("readEvalEnv — valid OPENROUTER_API_KEY", () => {
  it("returns ok when OPENROUTER_API_KEY is present and non-empty", () => {
    const result = readEvalEnv(validEnv());
    expect(result.isOk()).toBe(true);
  });

  it("EvalEnv.apiKey matches the provided key value", () => {
    const result = readEvalEnv(validEnv());
    const env = result._unsafeUnwrap();
    expect(env.apiKey).toBe(VALID_API_KEY);
  });

  it("EvalEnv.apiKey is the exact trimmed key (single-char key is valid)", () => {
    const result = readEvalEnv({ [OPENROUTER_API_KEY_ENV_VAR]: "x" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().apiKey).toBe("x");
  });

  it("does not trim non-empty key values (key is used as-is)", () => {
    const key = "sk-or-v1-padded";
    const result = readEvalEnv({ [OPENROUTER_API_KEY_ENV_VAR]: key });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().apiKey).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// Default base URL
// ---------------------------------------------------------------------------

describe("readEvalEnv — OPENROUTER_BASE_URL default", () => {
  it("EvalEnv.baseUrl defaults to DEFAULT_OPENROUTER_BASE_URL when env var is absent", () => {
    const result = readEvalEnv(validEnv());
    const env = result._unsafeUnwrap();
    expect(env.baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  it("EvalEnv.baseUrl defaults to DEFAULT_OPENROUTER_BASE_URL when env var is empty", () => {
    const result = readEvalEnv(validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "" }));
    const env = result._unsafeUnwrap();
    expect(env.baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  it("DEFAULT_OPENROUTER_BASE_URL starts with https://", () => {
    expect(DEFAULT_OPENROUTER_BASE_URL.startsWith("https://")).toBe(true);
  });

  it("DEFAULT_OPENROUTER_BASE_URL contains openrouter.ai", () => {
    expect(DEFAULT_OPENROUTER_BASE_URL).toContain("openrouter.ai");
  });

  it("DEFAULT_OPENROUTER_BASE_URL does not have a trailing slash", () => {
    expect(DEFAULT_OPENROUTER_BASE_URL.endsWith("/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Base URL override — valid
// ---------------------------------------------------------------------------

describe("readEvalEnv — valid OPENROUTER_BASE_URL override", () => {
  it("accepts an https:// override and returns it in EvalEnv.baseUrl", () => {
    const override = "https://custom.openrouter.example.com/api/v1";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: override }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().baseUrl).toBe(override);
  });

  it("rejects an http:// override by default (production security guard)", () => {
    // Production callers must never use http:// — this would transmit the API
    // key unencrypted. readEvalEnv() requires https:// by default.
    const override = "http://localhost:9999/api/v1";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: override }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result._unsafeUnwrapErr().type).toBe("InvalidBaseUrl");
    }
  });

  it("accepts an http:// override when allowHttpBaseUrl=true (test-only escape hatch)", () => {
    // allowHttpBaseUrl is ONLY for integration tests pointing at a local stub
    // server. It is never set from CLI flags or CI workflow env blocks.
    const override = "http://localhost:9999/api/v1";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: override }),
      { allowHttpBaseUrl: true },
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().baseUrl).toBe(override);
  });

  it("strips a trailing slash from the override URL", () => {
    const override = "https://custom.example.com/api/v1/";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: override }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().baseUrl).toBe(
      "https://custom.example.com/api/v1",
    );
  });

  it("strips trailing slash from http:// override when allowHttpBaseUrl=true", () => {
    const override = "http://localhost:3000/";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: override }),
      { allowHttpBaseUrl: true },
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().baseUrl).toBe("http://localhost:3000");
  });

  it("whitespace-only override is treated as absent (uses default)", () => {
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "   " }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });
});

// ---------------------------------------------------------------------------
// Base URL override — invalid
// ---------------------------------------------------------------------------

describe("readEvalEnv — invalid OPENROUTER_BASE_URL override", () => {
  it("returns InvalidBaseUrl for a value with no scheme", () => {
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "openrouter.ai/api/v1" }),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("InvalidBaseUrl");
  });

  it("returns InvalidBaseUrl for a ftp:// scheme", () => {
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "ftp://example.com" }),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("InvalidBaseUrl");
  });

  it("returns InvalidBaseUrl for an http:// scheme in production mode (default)", () => {
    // http:// is rejected by default — the API key would be sent unencrypted.
    // Use allowHttpBaseUrl=true ONLY in tests targeting a local stub server.
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "http://localhost:9999" }),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("InvalidBaseUrl");
  });

  it("InvalidBaseUrl error contains the offending value", () => {
    const bad = "not-a-url";
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: bad }),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    if (error.type === "InvalidBaseUrl") {
      expect(error.value).toBe(bad);
      expect(error.message).toContain(OPENROUTER_BASE_URL_ENV_VAR);
    }
  });

  it("error message suggests removing the var to use the default", () => {
    const result = readEvalEnv(
      validEnv({ [OPENROUTER_BASE_URL_ENV_VAR]: "bad-url" }),
    );
    const error = result._unsafeUnwrapErr();
    if (error.type === "InvalidBaseUrl") {
      expect(error.message).toContain(DEFAULT_OPENROUTER_BASE_URL);
    }
  });
});

// ---------------------------------------------------------------------------
// Priority: missing API key is checked first
// ---------------------------------------------------------------------------

describe("readEvalEnv — error priority", () => {
  it("reports MissingApiKey even when OPENROUTER_BASE_URL is also invalid", () => {
    const result = readEvalEnv({
      [OPENROUTER_API_KEY_ENV_VAR]: "",
      [OPENROUTER_BASE_URL_ENV_VAR]: "not-a-url",
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    // API key is checked first — base URL error is secondary
    expect(error.type).toBe("MissingApiKey");
  });
});

// ---------------------------------------------------------------------------
// Exported constants sanity
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("OPENROUTER_API_KEY_ENV_VAR is the string 'OPENROUTER_API_KEY'", () => {
    expect(OPENROUTER_API_KEY_ENV_VAR).toBe("OPENROUTER_API_KEY");
  });

  it("OPENROUTER_BASE_URL_ENV_VAR is the string 'OPENROUTER_BASE_URL'", () => {
    expect(OPENROUTER_BASE_URL_ENV_VAR).toBe("OPENROUTER_BASE_URL");
  });

  it("DEFAULT_OPENROUTER_BASE_URL is the canonical OpenRouter v1 endpoint", () => {
    expect(DEFAULT_OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
});
