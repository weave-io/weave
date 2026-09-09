import { describe, expect, it } from "bun:test";
import { validateSessionScope } from "../v2/session-scope.js";

describe("validateSessionScope", () => {
  it("normalizes the directory and requires the exact workspace", () => {
    const session = {
      location: { directory: "/project/./app", workspaceID: "one" },
      agent: "helper",
    };
    expect(
      validateSessionScope(
        "session",
        session,
        "/project/app",
        "one",
      )._unsafeUnwrap(),
    ).toMatchObject({ agent: "helper" });
    expect(
      validateSessionScope("session", session, "/project/app", "two").isErr(),
    ).toBe(true);
    expect(
      validateSessionScope("session", session, "/other", "one").isErr(),
    ).toBe(true);
  });
});
