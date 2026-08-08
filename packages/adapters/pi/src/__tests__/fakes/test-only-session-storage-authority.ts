import { ok } from "neverthrow";
import type { PiChildSessionStorageAuthority } from "../../child-session-storage-authority.js";

/** Test-only opt-in for the descriptor-safe host seam. */
export const TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY: PiChildSessionStorageAuthority =
  {
    requireDescriptorSafeSessionIo: () => ok(undefined),
  };
