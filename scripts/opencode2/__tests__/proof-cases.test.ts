import { describe, expect, it } from "bun:test";
import {
  OpenCode2ProofCases,
  REQUIRED_OPENCODE2_PROOF_CASES,
} from "../proof-cases.js";

describe("OpenCode2ProofCases", () => {
  it("requires every bounded proof case exactly once", () => {
    const cases = new OpenCode2ProofCases();
    expect(
      cases
        .complete({
          adapterVersion: "0.1.2",
          tarballSha256: "a",
          pluginSha256: "b",
        })
        ._unsafeUnwrapErr(),
    ).toEqual({
      type: "MissingCase",
      caseID: "artifact_identity",
    });
    for (const id of REQUIRED_OPENCODE2_PROOF_CASES) {
      expect(cases.pass(id, `passed ${id}`).isOk()).toBe(true);
    }
    expect(cases.pass("cleanup", "again")._unsafeUnwrapErr().type).toBe(
      "DuplicateCase",
    );
    expect(
      cases
        .complete({
          adapterVersion: "0.1.2",
          tarballSha256: "a",
          pluginSha256: "b",
        })
        .isOk(),
    ).toBe(true);
  });

  it("rejects failed cases and unsafe durable evidence", () => {
    const cases = new OpenCode2ProofCases();
    expect(
      cases.pass("artifact_identity", "line\nbreak")._unsafeUnwrapErr().type,
    ).toBe("InvalidEvidence");
    expect(cases.fail("artifact_identity", "digest mismatch").isOk()).toBe(
      true,
    );
    for (const id of REQUIRED_OPENCODE2_PROOF_CASES.slice(1))
      cases.pass(id, `passed ${id}`);
    expect(
      cases
        .complete({
          adapterVersion: "0.1.2",
          tarballSha256: "a",
          pluginSha256: "b",
        })
        ._unsafeUnwrapErr(),
    ).toEqual({
      type: "FailedCase",
      caseID: "artifact_identity",
    });
  });
});
