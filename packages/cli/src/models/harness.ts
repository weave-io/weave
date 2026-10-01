/**
 * Which harness `weave models` and `weave validate` report recommendations for
 * (`--harness`, Spec 39 "Harness behaviour").
 *
 * A published list has one section per harness, so the merged lists depend on
 * the harness. Without `--harness` the commands use OpenCode 2: it is the
 * harness Spec 39 ships first and the only one that applies a list without a
 * restart. Detection, as `weave init` does it, would spawn harness binaries
 * just to print a status, and several harnesses can be installed at once.
 * OpenCode V1 and Copilot CLI get no recommendations layer; the commands say
 * so instead of rejecting the name.
 */

import {
  isRecommendationsHarness,
  RECOMMENDATIONS_HARNESSES,
  type RecommendationsHarness,
} from "@weaveio/weave-config";
import { err, ok, type Result } from "neverthrow";
import type { CliError } from "../errors.js";

/** The harness used when `--harness` is not given. */
export const DEFAULT_RECOMMENDATIONS_HARNESS: RecommendationsHarness =
  "opencode2";

/** Harnesses Weave configures that take no recommendations layer, and why. */
const UNSUPPORTED = {
  opencode: {
    label: "OpenCode V1",
    reason:
      "it writes the first provider-qualified entry without checking that the provider is connected",
  },
  copilot: {
    label: "Copilot CLI",
    reason: "it writes no agent model",
  },
} as const;

type UnsupportedHarness = keyof typeof UNSUPPORTED;

/** The harness a command reports for. */
export type HarnessChoice =
  | { readonly type: "supported"; readonly harness: RecommendationsHarness }
  | {
      readonly type: "unsupported";
      readonly harness: UnsupportedHarness;
      readonly label: string;
      readonly reason: string;
    };

function isUnsupported(value: string): value is UnsupportedHarness {
  return Object.hasOwn(UNSUPPORTED, value);
}

/** Read `--harness`; unset means `DEFAULT_RECOMMENDATIONS_HARNESS`. */
export function chooseHarness(
  flag: string | undefined,
): Result<HarnessChoice, CliError> {
  const value = flag ?? DEFAULT_RECOMMENDATIONS_HARNESS;
  if (isRecommendationsHarness(value))
    return ok({ type: "supported", harness: value });
  if (isUnsupported(value))
    return ok({ type: "unsupported", harness: value, ...UNSUPPORTED[value] });
  const known = [...RECOMMENDATIONS_HARNESSES, ...Object.keys(UNSUPPORTED)];
  return err({
    type: "InvalidArgs",
    message: `--harness must be one of ${known.join(", ")}, got "${value}"`,
  });
}

/** The sentence a command prints for a harness without recommendations. */
export function unsupportedMessage(
  choice: Extract<HarnessChoice, { type: "unsupported" }>,
): string {
  return `Model recommendations are not supported on ${choice.label}: ${choice.reason}.`;
}
