import { describe, expect, test } from "bun:test";
import { BunPiChildProcessPort } from "../child-process-port.js";
import {
  CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
  provePiChildSessionRoot,
} from "../child-session-storage-authority.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
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

  test("grants only for a host exposing public create and open with a proven root", async () => {
    const proof = (
      await provePiChildSessionRoot({
        root: "/data/weave/sessions",
        fs: new MemoryPiNativeSessionFs(),
      })
    )._unsafeUnwrap();
    const result = createPiChildSessionStorageAuthority({
      SessionManager: { create: () => undefined, open: () => undefined },
      sessionRoot: proof,
    }).requireNativeSessionAuthority();

    expect(result.isOk()).toBe(true);
  });

  test("refuses storage when the API is present but the root is not proven", () => {
    const authority = createPiChildSessionStorageAuthority({
      SessionManager: { create: () => undefined, open: () => undefined },
    });

    expect(authority.requireNativeSessionAuthority().isErr()).toBe(true);
    expect(authority.readinessReason()).toBe("pi-session-root-unavailable");
  });

  test("recognizes the production process port's prototype spawn method", async () => {
    const proof = (
      await provePiChildSessionRoot({
        root: "/data/weave/sessions",
        fs: new MemoryPiNativeSessionFs(),
      })
    )._unsafeUnwrap();
    const authority = createPiChildSessionStorageAuthority({
      SessionManager: { create: () => undefined, open: () => undefined },
      sessionRoot: proof,
      processLaunch: new BunPiChildProcessPort(),
    });

    expect(authority.readinessReason()).toBeUndefined();
    expect(authority.requireLaunchAuthority().isOk()).toBe(true);
  });

  test("granted authority without a host is an explicit test-only opt-in", () => {
    const result =
      TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY.requireNativeSessionAuthority();

    expect(result.isOk()).toBe(true);
  });
});
