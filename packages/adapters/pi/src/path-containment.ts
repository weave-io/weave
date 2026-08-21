/**
 * Public façade for the Pi adapter's shared no-follow path-containment
 * primitives.
 *
 * The implementation is split by responsibility: lexical/root policy,
 * libc descriptor operations, bounded absolute reads, and relative-file
 * providers. Keep callers on this façade so the containment error vocabulary
 * and security contract have one stable boundary.
 */

export { readAbsoluteFileBounded } from "./path-containment-bounded-read.js";
export type {
  BoundedAbsoluteFileReadError,
  NoFollowEntryIdentity,
  NoFollowInspectionError,
  PathContainmentError,
  PathContainmentPort,
  SecureDirectoryListing,
  SecureFileIdentity,
  SecureFileRead,
  SecureRelativeFileProvider,
} from "./path-containment-contracts.js";
export {
  BunPathContainmentPort,
  FakePathContainmentPort,
  isDirectoryContainmentSafeWith,
  isLexicallyContained,
  NullPathContainmentPort,
} from "./path-containment-lexical.js";
export {
  inspectNoFollowDirectory,
  inspectNoFollowFile,
} from "./path-containment-nofollow.js";

export {
  BunSecureRelativeFileProvider,
  FakeSecureRelativeFileProvider,
} from "./path-containment-relative-files.js";
