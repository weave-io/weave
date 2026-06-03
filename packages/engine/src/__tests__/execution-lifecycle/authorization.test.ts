/**
 * Tests for execution-lifecycle/authorization.ts
 *
 * Verifies:
 * - validateAuthorizationSource: accepts "user", rejects "agent"/"hook"/"event"
 * - validateReconciliationSource: enforces closed reason→source mapping
 */

import { describe, expect, it } from "bun:test";
import {
  EXECUTION_AUTHORIZATION_SOURCES,
  RECONCILIATION_AUTHORIZATION_SOURCES,
  RECONCILIATION_REASONS,
  validateAuthorizationSource,
  validateReconciliationSource,
} from "@weave/engine";

describe("validateAuthorizationSource", () => {
  it("accepts 'user' for startExecution", () => {
    const result = validateAuthorizationSource("user", "startExecution");
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'user' for resumeExecution", () => {
    const result = validateAuthorizationSource("user", "resumeExecution");
    expect(result.isOk()).toBe(true);
  });

  it("rejects 'agent' for startExecution", () => {
    const result = validateAuthorizationSource("agent", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("agent");
    expect(result.error.rule).toBe("authorizationSource");
  });

  it("rejects 'hook' for startExecution", () => {
    const result = validateAuthorizationSource("hook", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("rejects 'event' for resumeExecution", () => {
    const result = validateAuthorizationSource("event", "resumeExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("all EXECUTION_AUTHORIZATION_SOURCES are covered", () => {
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("user");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("agent");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("hook");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("event");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toHaveLength(4);
  });
});

describe("validateReconciliationSource", () => {
  it("accepts 'runtime' for 'execution-mismatch'", () => {
    const result = validateReconciliationSource(
      "execution-mismatch",
      "runtime",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'user' for 'user-revision-request'", () => {
    const result = validateReconciliationSource(
      "user-revision-request",
      "user",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'review-gate' for 'review-rejection'", () => {
    const result = validateReconciliationSource(
      "review-rejection",
      "review-gate",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'security-gate' for 'security-rejection'", () => {
    const result = validateReconciliationSource(
      "security-rejection",
      "security-gate",
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects wrong source for 'execution-mismatch'", () => {
    const result = validateReconciliationSource("execution-mismatch", "user");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("runtime");
    expect(result.error.rule).toBe("reconciliationSource");
  });

  it("rejects wrong source for 'review-rejection'", () => {
    const result = validateReconciliationSource("review-rejection", "runtime");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("all RECONCILIATION_REASONS are covered", () => {
    expect(RECONCILIATION_REASONS).toContain("execution-mismatch");
    expect(RECONCILIATION_REASONS).toContain("user-revision-request");
    expect(RECONCILIATION_REASONS).toContain("review-rejection");
    expect(RECONCILIATION_REASONS).toContain("security-rejection");
    expect(RECONCILIATION_REASONS).toHaveLength(4);
  });

  it("all RECONCILIATION_AUTHORIZATION_SOURCES are covered", () => {
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("user");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("runtime");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("review-gate");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("security-gate");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toHaveLength(4);
  });
});
