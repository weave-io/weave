/**
 * Non-fatal findings from `loadConfigDetailed` (Spec 39).
 *
 * A diagnostic never stops the config from loading. It tells a caller that
 * reports status — the CLI, `weave validate`, an adapter — what an optional
 * input contributed, or why it was left out, so the user can see it.
 */

import type { ModelUpdatesChannel } from "@weaveio/weave-core";
import {
  describeModelRecommendationsError,
  type ModelRecommendationsError,
  type RecommendationsHarness,
} from "./model-recommendations.js";

/** Why an opted-in recommendations layer was left out of the config. */
export type ModelRecommendationsSkipReason =
  /** No `applied.json` for the channel: nothing has been applied yet. */
  | { readonly type: "Missing" }
  /** `applied.json` exists but could not be read. */
  | { readonly type: "Unreadable" }
  /** The verified list could not be turned into a config layer (a Weave bug). */
  | { readonly type: "LayerInvalid"; readonly message: string }
  /** The envelope failed its size, shape, signature, schema or freshness checks. */
  | ModelRecommendationsError;

/** One non-fatal finding from loading the config. */
export type ConfigLoadDiagnostic =
  /** A verified recommendations list was merged as a layer. */
  | {
      readonly type: "ModelRecommendationsApplied";
      readonly channel: ModelUpdatesChannel;
      /** The harness ID the caller passed. */
      readonly harness: RecommendationsHarness;
      /** The section used: the harness's own, or `default`. */
      readonly section: RecommendationsHarness | "default";
      /** The `applied.json` that was read. */
      readonly path: string;
      readonly issued: string;
      readonly expires: string;
      readonly evidence: string;
      /** Builtin agents the layer set `models` for, sorted. */
      readonly agents: readonly string[];
      /** Agent names in the section that this version does not define as builtins, sorted. */
      readonly skippedAgents: readonly string[];
    }
  /** The user opted in, but the layer was left out; the config loaded without it. */
  | {
      readonly type: "ModelRecommendationsSkipped";
      readonly channel: ModelUpdatesChannel;
      readonly harness: RecommendationsHarness;
      readonly path: string;
      readonly reason: ModelRecommendationsSkipReason;
    };

/** A one-line, user-facing reason for a skipped recommendations layer. */
export function describeModelRecommendationsSkipReason(
  reason: ModelRecommendationsSkipReason,
): string {
  switch (reason.type) {
    case "Missing":
      return "no recommendations have been applied for this channel yet";
    case "Unreadable":
      return "the applied recommendations file could not be read";
    case "LayerInvalid":
      return `the applied recommendations could not be merged: ${reason.message}`;
    default:
      return describeModelRecommendationsError(reason);
  }
}
