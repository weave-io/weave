import { describe, expect, it } from "bun:test";
import type {
  CodexFastEvidenceOutcome,
  CodexFastPayloadDecision,
  CodexFastReason,
  CodexFastSnapshot,
  CodexFastState,
} from "../codex-fast/attempt.js";
import {
  CODEX_FAST_EVIDENCE_OUTCOMES,
  CODEX_FAST_IGNORE_CAUSES,
  CODEX_FAST_MAX_ATTEMPTS,
  CODEX_FAST_PAYLOAD_DECISIONS,
  CODEX_FAST_REASONS,
  CODEX_FAST_STATES,
  createCodexFastAttempt,
} from "../codex-fast/attempt.js";
import type { CodexFastEligibility } from "../codex-fast/routing.js";
import { CODEX_INELIGIBLE_REASONS } from "../codex-fast/routing.js";

const SECRET_SHAPED_INPUT = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

const RULE_ID = "codex-sub-06";

const ELIGIBLE: CodexFastEligibility = Object.freeze({
  kind: "eligible",
  ruleId: RULE_ID,
} as const);

const NO_INTENT: CodexFastEligibility = Object.freeze({
  kind: "no-intent",
} as const);

const BOTH_PARTS = Object.freeze({
  originator: true,
  routingHint: true,
} as const);

/** The exact key set every public snapshot must carry, and nothing else. */
const SNAPSHOT_KEYS = [
  "attemptCount",
  "attemptsCapped",
  "collision",
  "evidenceKind",
  "evidenceOutcome",
  "reason",
  "ruleId",
  "state",
  "terminal",
] as const;

/** Values that are not the exact literal `true` a header part must carry. */
const NOT_EXACTLY_TRUE: readonly unknown[] = [
  false,
  undefined,
  null,
  0,
  1,
  "true",
  "yes",
  {},
  [],
  Number.NaN,
];

/** Attempt tokens that can never name the current open attempt. */
const FOREIGN_ATTEMPT_TOKENS: readonly unknown[] = [
  0,
  -1,
  2,
  99,
  "1",
  null,
  undefined,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1.5,
  {},
  [1],
];

/** Drive one attempt to an activated first fetch. */
function activatedAttempt(
  decision: CodexFastPayloadDecision = "priority-set",
): ReturnType<typeof createCodexFastAttempt> {
  const attempt = createCodexFastAttempt(ELIGIBLE);
  expect(attempt.resolvePayload(decision)).toEqual({ kind: "accepted" });
  const fetchTransition = attempt.beginFetchAttempt();
  expect(fetchTransition.kind).toBe("opened");
  expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({ kind: "accepted" });
  return attempt;
}

function currentAttemptToken(
  attempt: ReturnType<typeof createCodexFastAttempt>,
): number {
  const transition = attempt.beginFetchAttempt();
  if (transition.kind !== "opened") {
    throw new Error("expected an opened fetch attempt");
  }
  return transition.attempt;
}

/** Assert a snapshot carries only bounded enum tokens and small integers. */
function expectBoundedSnapshot(snapshot: CodexFastSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.keys(snapshot).sort()).toEqual([...SNAPSHOT_KEYS]);
  expect(CODEX_FAST_STATES).toContain(snapshot.state);
  expect(CODEX_FAST_REASONS).toContain(snapshot.reason);
  expect(["none", "openai-service-tier"]).toContain(snapshot.evidenceKind);
  expect(CODEX_FAST_EVIDENCE_OUTCOMES).toContain(snapshot.evidenceOutcome);
  expect(typeof snapshot.collision).toBe("boolean");
  expect(typeof snapshot.terminal).toBe("boolean");
  expect(typeof snapshot.attemptsCapped).toBe("boolean");
  expect(Number.isInteger(snapshot.attemptCount)).toBe(true);
  expect(snapshot.attemptCount).toBeGreaterThanOrEqual(0);
  expect(snapshot.attemptCount).toBeLessThanOrEqual(CODEX_FAST_MAX_ATTEMPTS);
  if (snapshot.ruleId !== "none") {
    expect(snapshot.ruleId).toBe(RULE_ID);
  }
}

describe("codex fast attempt vocabulary", () => {
  it("exposes only the engine-compatible states", () => {
    expect([...CODEX_FAST_STATES]).toEqual([
      "requested",
      "applied",
      "not-confirmed",
      "unsupported",
    ]);
    expect(Object.isFrozen(CODEX_FAST_STATES)).toBe(true);
  });

  it("bounds reasons, decisions, outcomes, and ignore causes", () => {
    expect([...CODEX_FAST_REASONS]).toEqual([
      "none",
      "provider-not-codex",
      "model-id-unsafe",
      "model-not-allowed",
      "model-owner-mismatch",
      "transport-not-first-party",
      "auth-not-subscription",
      "request-collision",
      "harness-seam-unavailable",
      "response-proof-unavailable",
      "attempt-uncorrelated",
      "canceled",
      "timed-out",
      "wrapper-degraded",
    ]);
    for (const reason of CODEX_INELIGIBLE_REASONS) {
      expect(CODEX_FAST_REASONS).toContain(reason);
    }
    expect([...CODEX_FAST_PAYLOAD_DECISIONS]).toEqual([
      "priority-set",
      "priority-preserved",
      "collision",
    ]);
    expect([...CODEX_FAST_EVIDENCE_OUTCOMES]).toEqual([
      "confirmed",
      "standard",
      "absent",
      "ambiguous",
      "inaccessible",
    ]);
    expect([...CODEX_FAST_IGNORE_CAUSES]).toEqual([
      "terminal",
      "out-of-order",
      "duplicate",
      "cross-attempt",
      "not-eligible",
      "invalid",
    ]);
  });

  it("caps the public attempt counter at a small documented limit", () => {
    expect(CODEX_FAST_MAX_ATTEMPTS).toBe(8);
  });
});

describe("no-intent attempts", () => {
  it("produces no acceleration snapshot at all", () => {
    const attempt = createCodexFastAttempt(NO_INTENT);
    expect(attempt.snapshot()).toBeUndefined();
    expect(attempt.terminalize()).toBeUndefined();
    expect(attempt.history()).toEqual([]);
  });

  it("ignores every transition without becoming reportable", () => {
    const attempt = createCodexFastAttempt(NO_INTENT);
    expect(attempt.resolvePayload("priority-set")).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.beginFetchAttempt()).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.recordHeaderCollision()).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.recordEvidence(1, "confirmed")).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.cancel()).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.timeout()).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.degrade()).toEqual({
      kind: "ignored",
      cause: "not-eligible",
    });
    expect(attempt.snapshot()).toBeUndefined();
    expect(attempt.history()).toEqual([]);
  });
});

describe("ineligible attempts", () => {
  for (const reason of CODEX_INELIGIBLE_REASONS) {
    it(`terminates unsupported with the bounded reason ${reason}`, () => {
      const attempt = createCodexFastAttempt({ kind: "ineligible", reason });
      const snapshot = attempt.snapshot();
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) {
        throw new Error("unreachable");
      }
      expectBoundedSnapshot(snapshot);
      expect(snapshot.state).toBe("unsupported");
      expect(snapshot.reason).toBe(reason);
      expect(snapshot.ruleId).toBe("none");
      expect(snapshot.attemptCount).toBe(0);
      expect(snapshot.evidenceKind).toBe("none");
      expect(snapshot.evidenceOutcome).toBe("absent");
      expect(snapshot.terminal).toBe(true);
      expect(snapshot.collision).toBe(reason === "request-collision");
      expect(attempt.history()).toEqual(["unsupported"]);
      expect(attempt.terminalize()).toEqual(snapshot);
    });
  }

  it("ignores every later transition and never upgrades", () => {
    const attempt = createCodexFastAttempt({
      kind: "ineligible",
      reason: "model-not-allowed",
    });
    const before = attempt.snapshot();
    expect(attempt.resolvePayload("priority-set")).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.beginFetchAttempt()).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.recordEvidence(1, "confirmed")).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.snapshot()).toEqual(before);
    expect(attempt.history()).toEqual(["unsupported"]);
  });
});

describe("malformed eligibility input", () => {
  const MALFORMED: readonly unknown[] = [
    undefined,
    null,
    {},
    { kind: "weird" },
    { kind: "eligible" },
    { kind: "eligible", ruleId: SECRET_SHAPED_INPUT },
    { kind: "ineligible" },
    { kind: "ineligible", reason: SECRET_SHAPED_INPUT },
    "eligible",
    42,
  ];

  for (const [index, input] of MALFORMED.entries()) {
    it(`fails closed to unsupported for malformed input #${index}`, () => {
      const attempt = createCodexFastAttempt(input as CodexFastEligibility);
      const snapshot = attempt.terminalize();
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) {
        throw new Error("unreachable");
      }
      expectBoundedSnapshot(snapshot);
      expect(snapshot.state).toBe("unsupported");
      expect(snapshot.reason).toBe("wrapper-degraded");
      expect(snapshot.ruleId).toBe("none");
      expect(JSON.stringify(snapshot)).not.toContain(SECRET_SHAPED_INPUT);
    });
  }
});

describe("both-part conditionality", () => {
  it("is not reportable before the payload resolved", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    expect(attempt.snapshot()).toBeUndefined();
    expect(attempt.history()).toEqual([]);
  });

  it("refuses header activation before the payload resolved", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "out-of-order",
    });
    expect(attempt.snapshot()).toBeUndefined();
    const terminal = attempt.terminalize();
    expect(terminal?.state).toBe("unsupported");
    expect(terminal?.reason).toBe("harness-seam-unavailable");
  });

  it("refuses header activation before a fetch attempt opened", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    expect(attempt.resolvePayload("priority-set")).toEqual({
      kind: "accepted",
    });
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "out-of-order",
    });
    expect(attempt.snapshot()).toBeUndefined();
  });

  it("stays unsupported when the wrapper fetch never ran", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-preserved");
    const terminal = attempt.terminalize();
    expect(terminal?.state).toBe("unsupported");
    expect(terminal?.reason).toBe("harness-seam-unavailable");
    expect(terminal?.attemptCount).toBe(0);
    expect(attempt.history()).toEqual(["unsupported"]);
  });

  it("stays unsupported when a fetch ran but wrote no headers", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    attempt.beginFetchAttempt();
    const terminal = attempt.terminalize();
    expect(terminal?.state).toBe("unsupported");
    expect(terminal?.reason).toBe("harness-seam-unavailable");
    expect(terminal?.attemptCount).toBe(1);
  });

  for (const [index, part] of NOT_EXACTLY_TRUE.entries()) {
    it(`fails closed on a partial originator write #${index}`, () => {
      const attempt = createCodexFastAttempt(ELIGIBLE);
      attempt.resolvePayload("priority-set");
      attempt.beginFetchAttempt();
      expect(
        attempt.activateHeaders({ originator: part, routingHint: true }),
      ).toEqual({ kind: "ignored", cause: "invalid" });
      const terminal = attempt.snapshot();
      expect(terminal?.state).toBe("unsupported");
      expect(terminal?.reason).toBe("wrapper-degraded");
      expect(attempt.history()).toEqual(["unsupported"]);
    });

    it(`fails closed on a partial routing-hint write #${index}`, () => {
      const attempt = createCodexFastAttempt(ELIGIBLE);
      attempt.resolvePayload("priority-set");
      attempt.beginFetchAttempt();
      expect(
        attempt.activateHeaders({ originator: true, routingHint: part }),
      ).toEqual({ kind: "ignored", cause: "invalid" });
      const terminal = attempt.snapshot();
      expect(terminal?.state).toBe("unsupported");
      expect(terminal?.reason).toBe("wrapper-degraded");
    });
  }

  it("reports requested only once both parts landed on the same attempt", () => {
    const attempt = activatedAttempt();
    const snapshot = attempt.snapshot();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error("unreachable");
    }
    expectBoundedSnapshot(snapshot);
    expect(snapshot.state).toBe("requested");
    expect(snapshot.reason).toBe("none");
    expect(snapshot.ruleId).toBe(RULE_ID);
    expect(snapshot.terminal).toBe(false);
    expect(snapshot.attemptCount).toBe(1);
    expect(snapshot.evidenceKind).toBe("openai-service-tier");
    expect(snapshot.evidenceOutcome).toBe("absent");
    expect(attempt.history()).toEqual(["requested"]);
  });
});

describe("payload collisions", () => {
  it("terminates unsupported with request-collision and no header activation", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    expect(attempt.resolvePayload("collision")).toEqual({ kind: "accepted" });
    const snapshot = attempt.snapshot();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error("unreachable");
    }
    expectBoundedSnapshot(snapshot);
    expect(snapshot.state).toBe("unsupported");
    expect(snapshot.reason).toBe("request-collision");
    expect(snapshot.collision).toBe(true);
    expect(snapshot.terminal).toBe(true);
    expect(attempt.beginFetchAttempt()).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.history()).toEqual(["unsupported"]);
  });

  it("rejects a duplicate payload decision", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    expect(attempt.resolvePayload("priority-set")).toEqual({
      kind: "accepted",
    });
    expect(attempt.resolvePayload("priority-preserved")).toEqual({
      kind: "ignored",
      cause: "duplicate",
    });
    expect(attempt.resolvePayload("collision")).toEqual({
      kind: "ignored",
      cause: "duplicate",
    });
    expect(attempt.snapshot()).toBeUndefined();
  });

  const INVALID_DECISIONS: readonly unknown[] = [
    undefined,
    null,
    "",
    "priority",
    "PRIORITY-SET",
    SECRET_SHAPED_INPUT,
    42,
    {},
    ["priority-set"],
  ];

  for (const [index, decision] of INVALID_DECISIONS.entries()) {
    it(`fails closed on invalid payload decision #${index}`, () => {
      const attempt = createCodexFastAttempt(ELIGIBLE);
      expect(
        attempt.resolvePayload(decision as CodexFastPayloadDecision),
      ).toEqual({ kind: "ignored", cause: "invalid" });
      const snapshot = attempt.snapshot();
      expect(snapshot?.state).toBe("unsupported");
      expect(snapshot?.reason).toBe("wrapper-degraded");
      expect(JSON.stringify(snapshot)).not.toContain(SECRET_SHAPED_INPUT);
    });
  }
});

describe("header collisions", () => {
  it("terminates unsupported with request-collision after a fetch opened", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    attempt.beginFetchAttempt();
    expect(attempt.recordHeaderCollision()).toEqual({ kind: "accepted" });
    const snapshot = attempt.snapshot();
    expect(snapshot?.state).toBe("unsupported");
    expect(snapshot?.reason).toBe("request-collision");
    expect(snapshot?.collision).toBe(true);
    expect(snapshot?.attemptCount).toBe(1);
    expect(attempt.recordEvidence(1, "confirmed")).toEqual({
      kind: "ignored",
      cause: "terminal",
    });
    expect(attempt.terminalize()?.state).toBe("unsupported");
  });
});

describe("evidence terminalization", () => {
  const TERMINALS: readonly {
    readonly outcome: CodexFastEvidenceOutcome;
    readonly state: CodexFastState;
    readonly reason: CodexFastReason;
  }[] = [
    { outcome: "confirmed", state: "applied", reason: "none" },
    { outcome: "standard", state: "not-confirmed", reason: "none" },
    {
      outcome: "absent",
      state: "not-confirmed",
      reason: "response-proof-unavailable",
    },
    {
      outcome: "ambiguous",
      state: "not-confirmed",
      reason: "response-proof-unavailable",
    },
    {
      outcome: "inaccessible",
      state: "not-confirmed",
      reason: "response-proof-unavailable",
    },
  ];

  for (const decision of CODEX_FAST_PAYLOAD_DECISIONS) {
    if (decision === "collision") {
      continue;
    }
    for (const terminal of TERMINALS) {
      it(`maps ${decision} + ${terminal.outcome} to ${terminal.state}`, () => {
        const attempt = createCodexFastAttempt(ELIGIBLE);
        attempt.resolvePayload(decision);
        const token = currentAttemptToken(attempt);
        attempt.activateHeaders(BOTH_PARTS);
        expect(attempt.recordEvidence(token, terminal.outcome)).toEqual({
          kind: "accepted",
        });
        expect(attempt.snapshot()?.state).toBe("requested");
        const snapshot = attempt.terminalize();
        expect(snapshot).toBeDefined();
        if (snapshot === undefined) {
          throw new Error("unreachable");
        }
        expectBoundedSnapshot(snapshot);
        expect(snapshot.state).toBe(terminal.state);
        expect(snapshot.reason).toBe(terminal.reason);
        expect(snapshot.evidenceKind).toBe("openai-service-tier");
        expect(snapshot.evidenceOutcome).toBe(terminal.outcome);
        expect(snapshot.ruleId).toBe(RULE_ID);
        expect(snapshot.collision).toBe(false);
        expect(snapshot.terminal).toBe(true);
        expect(attempt.history()).toEqual(["requested", terminal.state]);
      });
    }
  }

  it("yields exactly requested then not-confirmed without any evidence", () => {
    const attempt = activatedAttempt();
    expect(attempt.snapshot()?.state).toBe("requested");
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("not-confirmed");
    expect(snapshot?.reason).toBe("response-proof-unavailable");
    expect(snapshot?.evidenceKind).toBe("openai-service-tier");
    expect(snapshot?.evidenceOutcome).toBe("absent");
    expect(attempt.history()).toEqual(["requested", "not-confirmed"]);
  });

  it("never upgrades the observed host standard result to applied", () => {
    const attempt = activatedAttempt();
    attempt.recordEvidence(1, "standard");
    expect(attempt.recordEvidence(1, "confirmed")).toEqual({
      kind: "ignored",
      cause: "duplicate",
    });
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("not-confirmed");
    expect(snapshot?.evidenceOutcome).toBe("standard");
  });

  it("is idempotent across repeated terminalization", () => {
    const attempt = activatedAttempt();
    attempt.recordEvidence(1, "confirmed");
    const first = attempt.terminalize();
    const second = attempt.terminalize();
    expect(second).toEqual(first);
    expect(attempt.snapshot()).toEqual(first);
    expect(attempt.history()).toEqual(["requested", "applied"]);
  });

  const INVALID_OUTCOMES: readonly unknown[] = [
    undefined,
    null,
    "",
    "priority",
    "CONFIRMED",
    SECRET_SHAPED_INPUT,
    7,
    {},
    ["confirmed"],
  ];

  for (const [index, outcome] of INVALID_OUTCOMES.entries()) {
    it(`ignores invalid evidence outcome #${index}`, () => {
      const attempt = activatedAttempt();
      expect(
        attempt.recordEvidence(1, outcome as CodexFastEvidenceOutcome),
      ).toEqual({ kind: "ignored", cause: "invalid" });
      const snapshot = attempt.terminalize();
      expect(snapshot?.state).toBe("not-confirmed");
      expect(snapshot?.evidenceOutcome).toBe("absent");
      expect(JSON.stringify(snapshot)).not.toContain(SECRET_SHAPED_INPUT);
    });
  }
});

describe("evidence correlation", () => {
  it("rejects evidence before any header activation", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    const token = currentAttemptToken(attempt);
    expect(attempt.recordEvidence(token, "confirmed")).toEqual({
      kind: "ignored",
      cause: "out-of-order",
    });
    expect(attempt.terminalize()?.state).toBe("unsupported");
  });

  for (const [index, token] of FOREIGN_ATTEMPT_TOKENS.entries()) {
    it(`rejects foreign attempt token #${index}`, () => {
      const attempt = activatedAttempt();
      expect(attempt.recordEvidence(token, "confirmed")).toEqual({
        kind: "ignored",
        cause: "cross-attempt",
      });
      const snapshot = attempt.terminalize();
      expect(snapshot?.state).toBe("not-confirmed");
      expect(snapshot?.evidenceOutcome).toBe("absent");
    });
  }

  it("discards a prior attempt's confirmed evidence when a retry opens", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    const first = currentAttemptToken(attempt);
    attempt.activateHeaders(BOTH_PARTS);
    attempt.recordEvidence(first, "confirmed");
    const second = currentAttemptToken(attempt);
    expect(second).not.toBe(first);
    attempt.activateHeaders(BOTH_PARTS);
    expect(attempt.recordEvidence(first, "confirmed")).toEqual({
      kind: "ignored",
      cause: "cross-attempt",
    });
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("not-confirmed");
    expect(snapshot?.reason).toBe("attempt-uncorrelated");
    expect(snapshot?.evidenceOutcome).toBe("absent");
    expect(snapshot?.attemptCount).toBe(2);
  });

  it("lets a retry earn applied with its own confirmed evidence", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    currentAttemptToken(attempt);
    attempt.activateHeaders(BOTH_PARTS);
    const second = currentAttemptToken(attempt);
    attempt.activateHeaders(BOTH_PARTS);
    expect(attempt.recordEvidence(second, "confirmed")).toEqual({
      kind: "accepted",
    });
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("applied");
    expect(snapshot?.attemptCount).toBe(2);
  });

  it("caps at not-confirmed when the final retry wrote no headers", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    const first = currentAttemptToken(attempt);
    attempt.activateHeaders(BOTH_PARTS);
    attempt.recordEvidence(first, "confirmed");
    currentAttemptToken(attempt);
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("not-confirmed");
    expect(snapshot?.reason).toBe("attempt-uncorrelated");
  });

  it("rejects a duplicate header activation on the same attempt", () => {
    const attempt = activatedAttempt();
    expect(attempt.activateHeaders(BOTH_PARTS)).toEqual({
      kind: "ignored",
      cause: "duplicate",
    });
    expect(attempt.snapshot()?.attemptCount).toBe(1);
  });

  it("saturates the public attempt count at the documented cap", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    let token = 0;
    for (let index = 0; index < CODEX_FAST_MAX_ATTEMPTS + 12; index += 1) {
      token = currentAttemptToken(attempt);
      attempt.activateHeaders(BOTH_PARTS);
    }
    expect(attempt.snapshot()?.attemptCount).toBe(CODEX_FAST_MAX_ATTEMPTS);
    expect(attempt.snapshot()?.attemptsCapped).toBe(true);
    expect(attempt.recordEvidence(token, "confirmed")).toEqual({
      kind: "accepted",
    });
    const snapshot = attempt.terminalize();
    expect(snapshot?.state).toBe("applied");
    expect(snapshot?.attemptCount).toBe(CODEX_FAST_MAX_ATTEMPTS);
  });
});

describe("cancellation, timeout, and degradation", () => {
  const ENDINGS = [
    { name: "cancel", reason: "canceled" },
    { name: "timeout", reason: "timed-out" },
    { name: "degrade", reason: "wrapper-degraded" },
  ] as const;

  for (const ending of ENDINGS) {
    it(`terminates unsupported when ${ending.name} precedes any fetch`, () => {
      const attempt = createCodexFastAttempt(ELIGIBLE);
      attempt.resolvePayload("priority-set");
      expect(attempt[ending.name]()).toEqual({ kind: "accepted" });
      const snapshot = attempt.snapshot();
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) {
        throw new Error("unreachable");
      }
      expectBoundedSnapshot(snapshot);
      expect(snapshot.state).toBe("unsupported");
      expect(snapshot.reason).toBe(ending.reason);
      expect(snapshot.attemptCount).toBe(0);
      expect(snapshot.evidenceKind).toBe("none");
      expect(attempt.history()).toEqual(["unsupported"]);
    });

    it(`caps at not-confirmed when ${ending.name} follows activation`, () => {
      const attempt = activatedAttempt();
      expect(attempt[ending.name]()).toEqual({ kind: "accepted" });
      const snapshot = attempt.snapshot();
      expect(snapshot?.state).toBe("not-confirmed");
      expect(snapshot?.reason).toBe(ending.reason);
      expect(attempt.history()).toEqual(["requested", "not-confirmed"]);
    });

    it(`never lets ${ending.name} report applied after confirmed evidence`, () => {
      const attempt = activatedAttempt();
      attempt.recordEvidence(1, "confirmed");
      expect(attempt[ending.name]()).toEqual({ kind: "accepted" });
      const snapshot = attempt.terminalize();
      expect(snapshot?.state).toBe("not-confirmed");
      expect(snapshot?.reason).toBe(ending.reason);
      expect(snapshot?.evidenceOutcome).toBe("confirmed");
    });

    it(`ignores ${ending.name} after the attempt terminalized`, () => {
      const attempt = activatedAttempt();
      attempt.recordEvidence(1, "confirmed");
      const before = attempt.terminalize();
      expect(attempt[ending.name]()).toEqual({
        kind: "ignored",
        cause: "terminal",
      });
      expect(attempt.snapshot()).toEqual(before);
      expect(attempt.snapshot()?.state).toBe("applied");
    });
  }

  it("keeps the first ending when cancel and timeout race", () => {
    const attempt = activatedAttempt();
    expect(attempt.cancel()).toEqual({ kind: "accepted" });
    expect(attempt.timeout()).toEqual({ kind: "ignored", cause: "terminal" });
    expect(attempt.snapshot()?.reason).toBe("canceled");
  });
});

describe("post-terminal immutability", () => {
  it("ignores every transition and preserves the terminal snapshot", () => {
    const attempt = activatedAttempt();
    attempt.recordEvidence(1, "standard");
    const terminal = attempt.terminalize();
    expect(terminal?.state).toBe("not-confirmed");

    const transitions = [
      () => attempt.resolvePayload("priority-set"),
      () => attempt.beginFetchAttempt(),
      () => attempt.activateHeaders(BOTH_PARTS),
      () => attempt.recordHeaderCollision(),
      () => attempt.recordEvidence(1, "confirmed"),
      () => attempt.recordEvidence(2, "confirmed"),
      () => attempt.cancel(),
      () => attempt.timeout(),
      () => attempt.degrade(),
    ] as const;

    for (const transition of transitions) {
      expect(transition()).toEqual({ kind: "ignored", cause: "terminal" });
      expect(attempt.snapshot()).toEqual(terminal);
    }
    expect(attempt.history()).toEqual(["requested", "not-confirmed"]);
  });
});

describe("sanitization", () => {
  it("never echoes secret-shaped or raw values in any snapshot", () => {
    const attempt = createCodexFastAttempt(ELIGIBLE);
    attempt.resolvePayload("priority-set");
    const token = currentAttemptToken(attempt);
    attempt.activateHeaders({
      originator: true,
      routingHint: true,
    });
    attempt.recordEvidence(token, "confirmed");
    attempt.recordEvidence(
      token,
      SECRET_SHAPED_INPUT as CodexFastEvidenceOutcome,
    );
    const snapshot = attempt.terminalize();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error("unreachable");
    }
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SECRET_SHAPED_INPUT);
    expect(serialized).not.toContain("chatgpt.com");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("gpt-");
    expect(serialized).not.toContain("originator");
    expectBoundedSnapshot(snapshot);
  });

  it("returns a frozen history that a caller cannot grow", () => {
    const attempt = activatedAttempt();
    attempt.terminalize();
    const history = attempt.history();
    expect(Object.isFrozen(history)).toBe(true);
    expect(history).toEqual(["requested", "not-confirmed"]);
  });
});

/** Deterministic 32-bit LCG so the property run is reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("property: random transition sequences stay bounded and honest", () => {
  it("never reaches applied without same-attempt confirmed final evidence", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = createRandom(seed);
      const attempt = createCodexFastAttempt(ELIGIBLE);
      let latestToken = 0;
      let confirmedOnLatest = false;
      let evidenceOnLatest = false;

      const steps = 3 + Math.floor(random() * 12);
      for (let step = 0; step < steps; step += 1) {
        const pick = Math.floor(random() * 8);
        if (pick === 0) {
          const decision =
            CODEX_FAST_PAYLOAD_DECISIONS[
              Math.floor(random() * CODEX_FAST_PAYLOAD_DECISIONS.length)
            ];
          if (decision !== undefined) {
            attempt.resolvePayload(decision);
          }
        } else if (pick === 1 || pick === 2) {
          const opened = attempt.beginFetchAttempt();
          if (opened.kind === "opened") {
            latestToken = opened.attempt;
            confirmedOnLatest = false;
            evidenceOnLatest = false;
          }
        } else if (pick === 3 || pick === 4) {
          attempt.activateHeaders(BOTH_PARTS);
        } else if (pick === 5 || pick === 6) {
          const outcome =
            CODEX_FAST_EVIDENCE_OUTCOMES[
              Math.floor(random() * CODEX_FAST_EVIDENCE_OUTCOMES.length)
            ];
          const token = random() < 0.8 ? latestToken : latestToken - 1;
          if (outcome !== undefined) {
            const result = attempt.recordEvidence(token, outcome);
            if (result.kind === "accepted") {
              evidenceOnLatest = true;
              confirmedOnLatest = outcome === "confirmed";
            }
          }
        } else {
          const ending = random();
          if (ending < 0.35) {
            attempt.cancel();
          } else if (ending < 0.7) {
            attempt.timeout();
          }
        }

        const live = attempt.snapshot();
        if (live !== undefined) {
          expectBoundedSnapshot(live);
          expect(live.state).not.toBe("applied");
        }
      }

      const canceled = attempt.snapshot()?.terminal === true;
      const terminal = attempt.terminalize();
      expect(terminal).toBeDefined();
      if (terminal === undefined) {
        throw new Error("unreachable");
      }
      expectBoundedSnapshot(terminal);
      expect(terminal.terminal).toBe(true);
      if (terminal.state === "applied") {
        expect(confirmedOnLatest).toBe(true);
        expect(evidenceOnLatest).toBe(true);
        expect(canceled).toBe(false);
        expect(terminal.evidenceOutcome).toBe("confirmed");
        expect(terminal.collision).toBe(false);
      }
      const history = attempt.history();
      expect(history.length).toBeLessThanOrEqual(2);
      for (const state of history) {
        expect(CODEX_FAST_STATES).toContain(state);
      }
      expect(attempt.terminalize()).toEqual(terminal);
    }
  });
});
