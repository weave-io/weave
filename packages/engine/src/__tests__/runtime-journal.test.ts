/**
 * Runtime Journal writer tests.
 *
 * Tests envelope validation, payload size limit, sanitization/rejection,
 * no raw content persistence, fingerprint stability within one store,
 * and fingerprint difference across salts.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { RuntimeStoreError } from "../runtime/errors.js";
import { journalWriteError, notFoundError } from "../runtime/errors.js";
import {
  createProjectSalt,
  fingerprintContent,
} from "../runtime/fingerprint.js";
import {
  RuntimeJournalWriter,
  type WriteJournalEntryInput,
} from "../runtime/journal-writer.js";
import {
  sanitizeJournalData,
  sanitizeSnapshotMetadata,
} from "../runtime/sanitizer.js";
import type { RuntimeJournalRepository } from "../runtime/store.js";
import type {
  JournalQueryFilter,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
} from "../runtime/types.js";
import {
  createExecutionLeaseId,
  createRuntimeJournalEntryId,
  createWorkflowInstanceId,
} from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Stub repository
// ---------------------------------------------------------------------------

class StubJournalRepository implements RuntimeJournalRepository {
  readonly appended: Array<Omit<RuntimeJournalEntry, "id" | "timestamp">> = [];
  private failNext = false;

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    if (this.failNext) {
      this.failNext = false;
      return errAsync(journalWriteError("Simulated repository failure"));
    }
    this.appended.push(entry);
    const full: RuntimeJournalEntry = {
      ...entry,
      id: createRuntimeJournalEntryId(`entry-${Date.now()}-${Math.random()}`),
      timestamp: new Date().toISOString(),
    };
    return okAsync(full);
  }

  findById(
    _id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    return okAsync(null);
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return errAsync(notFoundError("RuntimeJournalEntry", id));
  }

  query(
    _filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    return okAsync([]);
  }

  injectFailure(): void {
    this.failNext = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidInput(
  overrides: Partial<WriteJournalEntryInput> = {},
): WriteJournalEntryInput {
  return {
    source: { kind: "engine", name: "runner" },
    eventType: "step.started",
    severity: "info",
    data: { stepName: "implement" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

describe("RuntimeJournalWriter — envelope validation", () => {
  it("accepts a valid entry with all required fields", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(makeValidInput());
    expect(result.isOk()).toBe(true);
    expect(repo.appended).toHaveLength(1);
  });

  it("accepts source.kind = 'adapter'", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ source: { kind: "adapter", name: "adapter-opencode" } }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects invalid source.kind", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({
        source: { kind: "unknown" as "engine", name: "runner" },
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
      expect((result.error as { message: string }).message).toContain(
        "source.kind",
      );
    }
    expect(repo.appended).toHaveLength(0);
  });

  it("rejects empty source.name", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ source: { kind: "engine", name: "  " } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
      expect((result.error as { message: string }).message).toContain(
        "source.name",
      );
    }
  });

  it("rejects empty eventType", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(makeValidInput({ eventType: "" }));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
      expect((result.error as { message: string }).message).toContain(
        "eventType",
      );
    }
  });

  it("rejects invalid severity", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ severity: "critical" as "error" }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
      expect((result.error as { message: string }).message).toContain(
        "severity",
      );
    }
  });

  it("accepts all valid severity values", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    for (const severity of ["debug", "info", "warn", "error"] as const) {
      const result = await writer.write(makeValidInput({ severity }));
      expect(result.isOk()).toBe(true);
    }
    expect(repo.appended).toHaveLength(4);
  });

  it("rejects null data", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ data: null as unknown as Record<string, unknown> }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
    }
  });

  it("rejects array data", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ data: [] as unknown as Record<string, unknown> }),
    );
    expect(result.isErr()).toBe(true);
  });

  it("accepts optional executionId, workflowInstanceId, stepId", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({
        executionId: createExecutionLeaseId("lease-001"),
        workflowInstanceId: createWorkflowInstanceId("wfi-001"),
        stepId: "implement",
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(repo.appended[0].executionId).toBe(
      createExecutionLeaseId("lease-001"),
    );
    expect(repo.appended[0].workflowInstanceId).toBe(
      createWorkflowInstanceId("wfi-001"),
    );
    expect(repo.appended[0].stepId).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// Payload size limit
// ---------------------------------------------------------------------------

describe("RuntimeJournalWriter — payload size limit", () => {
  it("accepts a payload just under 64 KiB", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    // Build a string that serializes to just under 64 KiB
    const value = "x".repeat(64 * 1024 - 20);
    const result = await writer.write(makeValidInput({ data: { v: value } }));
    expect(result.isOk()).toBe(true);
  });

  it("rejects a payload exceeding 64 KiB", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    // Build a string that serializes to well over 64 KiB
    const value = "x".repeat(64 * 1024 + 100);
    const result = await writer.write(makeValidInput({ data: { v: value } }));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
      expect((result.error as { message: string }).message).toContain("64 KiB");
    }
    expect(repo.appended).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sanitization / rejection
// ---------------------------------------------------------------------------

describe("RuntimeJournalWriter — sanitization", () => {
  const secretFields = [
    "token",
    "apiKey",
    "api_key",
    "password",
    "secret",
    "authorization",
    "cookie",
    "bearer",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "clientSecret",
    "client_secret",
    "privateKey",
    "private_key",
    "auth",
    "credentials",
    "credential",
  ];

  const rawContentFields = [
    "prompt",
    "completion",
    "transcript",
    "rawPrompt",
    "raw_prompt",
    "rawCompletion",
    "raw_completion",
    "rawTranscript",
    "raw_transcript",
    "systemPrompt",
    "system_prompt",
    "userPrompt",
    "user_prompt",
    "assistantMessage",
    "assistant_message",
  ];

  for (const field of secretFields) {
    it(`rejects entry with secret field: ${field}`, async () => {
      const repo = new StubJournalRepository();
      const writer = new RuntimeJournalWriter(repo);
      const result = await writer.write(
        makeValidInput({ data: { [field]: "secret-value" } }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("journal_write");
        expect((result.error as { message: string }).message).toContain(
          "denied field",
        );
      }
      expect(repo.appended).toHaveLength(0);
    });
  }

  for (const field of rawContentFields) {
    it(`rejects entry with raw content field: ${field}`, async () => {
      const repo = new StubJournalRepository();
      const writer = new RuntimeJournalWriter(repo);
      const result = await writer.write(
        makeValidInput({ data: { [field]: "raw content here" } }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("journal_write");
      }
      expect(repo.appended).toHaveLength(0);
    });
  }

  it("rejects nested secret fields", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({
        data: { context: { nested: { token: "abc123" } } },
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
    }
  });

  it("accepts clean data with no denied fields", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({
        data: {
          stepName: "implement",
          duration: 1234,
          success: true,
          agentName: "shuttle",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(repo.appended).toHaveLength(1);
  });

  it("accepts fingerprint fields (sha256 hex strings) in data", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const salt = createProjectSalt();
    const fp = await fingerprintContent(salt, "some prompt content");
    expect(fp.isOk()).toBe(true);
    const result = await writer.write(
      makeValidInput({
        data: {
          promptFingerprint: fp.isOk() ? fp.value : "",
          completionFingerprint: fp.isOk() ? fp.value : "",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No raw content persistence
// ---------------------------------------------------------------------------

describe("RuntimeJournalWriter — no raw content persistence", () => {
  it("does not persist raw prompt content", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ data: { prompt: "You are a helpful assistant." } }),
    );
    expect(result.isErr()).toBe(true);
    expect(repo.appended).toHaveLength(0);
  });

  it("does not persist raw completion content", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const result = await writer.write(
      makeValidInput({ data: { completion: "Here is the answer..." } }),
    );
    expect(result.isErr()).toBe(true);
    expect(repo.appended).toHaveLength(0);
  });

  it("stores fingerprint instead of raw content", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo);
    const salt = createProjectSalt();
    const fp = await fingerprintContent(salt, "You are a helpful assistant.");
    expect(fp.isOk()).toBe(true);

    const result = await writer.write(
      makeValidInput({
        data: { promptFingerprint: fp.isOk() ? fp.value : "" },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(repo.appended[0].data).toHaveProperty("promptFingerprint");
    // The stored value is a hex fingerprint, not the raw content
    const stored = repo.appended[0].data.promptFingerprint as string;
    expect(stored).not.toContain("helpful assistant");
    expect(stored).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex = 64 chars
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability and cross-salt difference
// ---------------------------------------------------------------------------

describe("fingerprintContent — stability and cross-salt difference", () => {
  it("produces the same fingerprint for the same salt and content", async () => {
    const salt = createProjectSalt();
    const content = "You are a helpful assistant.";
    const fp1 = await fingerprintContent(salt, content);
    const fp2 = await fingerprintContent(salt, content);
    expect(fp1.isOk()).toBe(true);
    expect(fp2.isOk()).toBe(true);
    if (fp1.isOk() && fp2.isOk()) {
      expect(fp1.value).toBe(fp2.value);
    }
  });

  it("produces different fingerprints for different salts (same content)", async () => {
    const salt1 = createProjectSalt();
    const salt2 = createProjectSalt();
    const content = "You are a helpful assistant.";
    const fp1 = await fingerprintContent(salt1, content);
    const fp2 = await fingerprintContent(salt2, content);
    expect(fp1.isOk()).toBe(true);
    expect(fp2.isOk()).toBe(true);
    if (fp1.isOk() && fp2.isOk()) {
      // Different salts → different fingerprints (with overwhelming probability)
      expect(fp1.value).not.toBe(fp2.value);
    }
  });

  it("produces different fingerprints for different content (same salt)", async () => {
    const salt = createProjectSalt();
    const fp1 = await fingerprintContent(salt, "content A");
    const fp2 = await fingerprintContent(salt, "content B");
    expect(fp1.isOk()).toBe(true);
    expect(fp2.isOk()).toBe(true);
    if (fp1.isOk() && fp2.isOk()) {
      expect(fp1.value).not.toBe(fp2.value);
    }
  });

  it("produces a 64-character hex string (SHA-256)", async () => {
    const salt = createProjectSalt();
    const fp = await fingerprintContent(salt, "test content");
    expect(fp.isOk()).toBe(true);
    if (fp.isOk()) {
      expect(fp.value).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// createProjectSalt — entropy
// ---------------------------------------------------------------------------

describe("createProjectSalt — CSPRNG entropy", () => {
  it("returns a 32-character hex string (16 bytes = 128 bits)", () => {
    const salt = createProjectSalt();
    // 16 bytes → 32 hex chars
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces unique salts on each call", () => {
    const salts = new Set(
      Array.from({ length: 100 }, () => createProjectSalt()),
    );
    // All 100 salts should be unique
    expect(salts.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// sanitizeJournalData — direct unit tests
// ---------------------------------------------------------------------------

describe("sanitizeJournalData", () => {
  it("returns ok for clean data", () => {
    const result = sanitizeJournalData({ stepName: "plan", duration: 100 });
    expect(result.isOk()).toBe(true);
  });

  it("returns err for data with 'token' field", () => {
    const result = sanitizeJournalData({ token: "abc" });
    expect(result.isErr()).toBe(true);
  });

  it("returns err for data with 'password' field", () => {
    const result = sanitizeJournalData({ password: "hunter2" });
    expect(result.isErr()).toBe(true);
  });

  it("returns err for data with 'prompt' field", () => {
    const result = sanitizeJournalData({ prompt: "You are..." });
    expect(result.isErr()).toBe(true);
  });

  it("is case-insensitive for field names", () => {
    const result = sanitizeJournalData({ TOKEN: "abc" });
    expect(result.isErr()).toBe(true);
  });

  it("detects denied keys in nested objects", () => {
    const result = sanitizeJournalData({
      context: { auth: { token: "abc" } },
    });
    expect(result.isErr()).toBe(true);
  });

  it("detects denied keys in arrays of objects", () => {
    const result = sanitizeJournalData({
      items: [{ name: "ok" }, { password: "bad" }],
    });
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeSnapshotMetadata — direct unit tests
// ---------------------------------------------------------------------------

describe("sanitizeSnapshotMetadata", () => {
  it("returns ok for clean metadata", () => {
    const result = sanitizeSnapshotMetadata({
      harnessVersion: "1.0.0",
      stepCount: 3,
      isActive: true,
    });
    expect(result.isOk()).toBe(true);
  });

  it("returns err for metadata with 'token' field", () => {
    const result = sanitizeSnapshotMetadata({ token: "abc" });
    expect(result.isErr()).toBe(true);
  });

  it("returns err for metadata with 'cookie' field", () => {
    const result = sanitizeSnapshotMetadata({ cookie: "session=xyz" });
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Best-effort vs strict mode
// ---------------------------------------------------------------------------

describe("RuntimeJournalWriter — strict vs best-effort mode", () => {
  it("best-effort mode: returns error but does not throw on validation failure", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo, { strictMode: false });
    const result = await writer.write(makeValidInput({ eventType: "" }));
    expect(result.isErr()).toBe(true);
    // No exception thrown
  });

  it("strict mode: returns error on validation failure", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo, { strictMode: true });
    const result = await writer.write(makeValidInput({ eventType: "" }));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
    }
  });

  it("best-effort mode: swallows repository errors (returns ok)", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo, { strictMode: false });
    repo.injectFailure();
    const result = await writer.write(makeValidInput());
    // In best-effort mode, repository failures are swallowed so the
    // surrounding transaction can still commit.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeUndefined();
    }
  });

  it("strict mode: propagates repository errors", async () => {
    const repo = new StubJournalRepository();
    const writer = new RuntimeJournalWriter(repo, { strictMode: true });
    repo.injectFailure();
    const result = await writer.write(makeValidInput());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("journal_write");
    }
  });
});
