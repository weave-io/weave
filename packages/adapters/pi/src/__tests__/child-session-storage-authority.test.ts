import { describe, expect, test } from "bun:test";
import {
  CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
} from "../child-session-storage-authority.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

describe("child session storage authority", () => {
  test("refuses with the exact bounded reason when no Pi session API exists", () => {
    const result =
      createPiChildSessionStorageAuthority().requireNativeSessionAuthority();

    result.match(
      (value) => expect(value).toBeUndefined(),
      (failure) => {
        expect(failure).toEqual({
          type: "SessionStorageUnavailable",
          reason: "pi-session-api-unavailable",
        });
        expect(describeChildSessionStorageUnavailable(failure)).toBe(
          CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
        );
        expect(JSON.stringify(failure)).not.toMatch(
          /\/|\\\\|\.\.|prompt|transcript|environment|configuration/i,
        );
        expect(
          JSON.stringify(describeChildSessionStorageUnavailable(failure)),
        ).toBe('"session-storage-unavailable:pi-session-api-unavailable"');
      },
    );
  });

  test("refuses a host whose SessionManager is not the public constructor pair", () => {
    for (const candidate of [
      undefined,
      null,
      "SessionManager",
      {},
      { create: () => undefined },
      { open: () => undefined },
    ]) {
      const result = createPiChildSessionStorageAuthority({
        SessionManager: candidate,
      }).requireNativeSessionAuthority();
      expect(result.isErr()).toBe(true);
    }
  });

  test("grants only for a host exposing public create and open", () => {
    const result = createPiChildSessionStorageAuthority({
      SessionManager: { create: () => undefined, open: () => undefined },
    }).requireNativeSessionAuthority();

    expect(result.isOk()).toBe(true);
  });

  test("granted authority without a host is an explicit test-only opt-in", () => {
    const result =
      TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY.requireNativeSessionAuthority();

    expect(result.isOk()).toBe(true);
  });
});
