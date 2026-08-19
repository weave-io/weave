import { describe, expect, it } from "bun:test";
import { validateRefsCleanupInput } from "../refs-cleanup-main.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const valid = {
  releasedSha: SHA,
  publicationVerified: true,
  members: [
    { packageName: "@weaveio/weave-cli", version: "1.0.0", digest: DIGEST },
  ],
  cleanup: { channel: "stable", ledgerDigest: DIGEST },
};

describe("refs and cleanup chain boundary", () => {
  it("requires verified publication and a released-SHA-bound member set", () => {
    expect(validateRefsCleanupInput(valid).isOk()).toBe(true);
    expect(
      validateRefsCleanupInput({
        ...valid,
        publicationVerified: false,
      }).isErr(),
    ).toBe(true);
    expect(
      validateRefsCleanupInput({
        ...valid,
        members: [valid.members[0], valid.members[0]],
      }).isErr(),
    ).toBe(true);
  });
});
