import type { Result } from "neverthrow";
import type {
  IdentityVerificationSuccess,
  VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

/** Render the bounded identity status line without writing or exiting. */
export function renderIdentityVerification(
  result: Result<IdentityVerificationSuccess, VerifyChildStreamingFailure>,
): string {
  if (result.isOk()) {
    return `identity: current; evidence=${result.value.evidence}; child-streaming=permitted`;
  }
  return `identity: blocked; state=${result.error.state ?? "unverifiable"}; evidence=${result.error.evidence}; child-streaming=refused; reason=${result.error.type}`;
}
