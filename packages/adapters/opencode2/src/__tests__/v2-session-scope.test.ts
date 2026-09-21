/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: the workspace half of the scope check. The scenarios vary
 * the session's directory, but the plugin takes both its own workspace id and
 * the session's from the same host, so a workspace mismatch is not reachable
 * from outside.
 */

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
