import { errAsync, type ResultAsync } from "neverthrow";
import type { SupportedHarnessId } from "../detect/index.js";
import type { InstallError, InstallResult } from "./index.js";

export function unsupportedHarnessInstall(
  harness: SupportedHarnessId,
): ResultAsync<InstallResult, InstallError> {
  return errAsync({
    type: "UnsupportedHarness",
    harness,
    message: `${harness} is detected but installer support is not available yet.`,
  });
}

export function undetectedHarnessInstall(
  harness: SupportedHarnessId,
): ResultAsync<InstallResult, InstallError> {
  return errAsync({
    type: "UndetectedHarness",
    harness,
    message: `${harness} was requested but no matching harness config or binary was detected.`,
  });
}
