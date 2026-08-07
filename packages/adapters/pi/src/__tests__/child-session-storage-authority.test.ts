import { describe, expect, test } from "bun:test";
import {
  CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
} from "../child-session-storage-authority.js";
import { TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

describe("child session storage authority", () => {
  test("production authority refuses with the exact bounded path-only reason", () => {
    const result =
      createPiChildSessionStorageAuthority().requireDescriptorSafeSessionIo();

    result.match(
      (value) => expect(value).toBeUndefined(),
      (failure) => {
        expect(failure).toEqual({
          type: "SessionStorageUnavailable",
          reason: "path-only-session-api",
        });
        expect(describeChildSessionStorageUnavailable(failure)).toBe(
          CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
        );
        expect(JSON.stringify(failure)).not.toMatch(
          /\/|\\\\|\.\.|prompt|transcript|environment|configuration/i,
        );
        expect(
          JSON.stringify(describeChildSessionStorageUnavailable(failure)),
        ).toBe('"session-storage-unavailable:path-only-session-api"');
      },
    );
  });

  test("descriptor-safe authority is an explicit test-only opt-in", () => {
    const result =
      TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY.requireDescriptorSafeSessionIo();

    expect(result.isOk()).toBe(true);
  });
});
