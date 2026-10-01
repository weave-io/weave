/**
 * Turns the applied model recommendations into a config layer (Spec 39,
 * "Loading").
 *
 * The layer holds only `agents.<name>.models` for builtin agents. It is read
 * through the loader's injected `FileReader`, so OpenCode 2's catalog source
 * cache records `applied.json` like any other source and notices a promotion.
 * Loading never touches the network, and nothing here ever fails the load: a
 * file that cannot be used is skipped and the reason is returned.
 */

import { type WeaveConfig, WeaveConfigSchema } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
  ConfigLoadDiagnostic,
  ModelRecommendationsSkipReason,
} from "./diagnostics.js";
import type { FileReader } from "./discovery.js";
import { logger } from "./logger.js";
import {
  type ModelRecommendationsFile,
  type RecommendationsHarness,
  selectRecommendationsSection,
} from "./model-recommendations.js";
import {
  modelRecommendationsCachePaths,
  type ResolvedModelUpdates,
} from "./model-recommendations-cache.js";
import type { ModelRecommendationsVerifier } from "./model-recommendations-verifier.js";

const log = logger.child({ module: "model-recommendations-layer" });

/** What the layer reader needs. All of it is injected. */
export interface ModelRecommendationsLayerDeps {
  readonly reader: FileReader;
  readonly verifier: ModelRecommendationsVerifier;
  /** Compared with a list's `min_config_version`. */
  readonly clientVersion: string;
  /** The global config directory the cache lives under. */
  readonly globalDir: string;
}

/** One request for a layer. */
export interface ModelRecommendationsLayerRequest {
  readonly settings: ResolvedModelUpdates;
  readonly harness: RecommendationsHarness;
  /** Names of the agents the builtin config defines. */
  readonly builtinAgents: ReadonlySet<string>;
}

/** The layer, when there is one, and the diagnostic that explains it. */
export interface ModelRecommendationsLayerResult {
  readonly layer?: WeaveConfig;
  readonly diagnostic: ConfigLoadDiagnostic;
}

/** Reads `applied.json` for a channel and builds the recommendations layer. */
export class ModelRecommendationsLayerReader {
  constructor(private readonly deps: ModelRecommendationsLayerDeps) {}

  /** Never fails: an unusable file yields a `ModelRecommendationsSkipped` diagnostic. */
  read(
    request: ModelRecommendationsLayerRequest,
  ): ResultAsync<ModelRecommendationsLayerResult, never> {
    const { channel } = request.settings;
    const path = modelRecommendationsCachePaths(
      channel,
      this.deps.globalDir,
    ).applied;
    const skipped = (
      reason: ModelRecommendationsSkipReason,
    ): ModelRecommendationsLayerResult => {
      // Nothing applied yet is the normal state before the first fetch.
      const level = reason.type === "Missing" ? "info" : "warn";
      log[level](
        { channel, harness: request.harness, reason: reason.type },
        "Model recommendations layer skipped",
      );
      return {
        diagnostic: {
          type: "ModelRecommendationsSkipped",
          channel,
          harness: request.harness,
          path,
          reason,
        },
      };
    };

    return this.readEnvelope(path)
      .andThen((text) =>
        this.deps.verifier
          .verifyEnvelope(text, {
            channel,
            clientVersion: this.deps.clientVersion,
          })
          .mapErr((error): ModelRecommendationsSkipReason => error),
      )
      .andThen((file) => this.toLayer(file, request, path))
      .orElse((reason) => okAsync(skipped(reason)));
  }

  private readEnvelope(
    path: string,
  ): ResultAsync<string, ModelRecommendationsSkipReason> {
    // fromThrowable, not fromPromise: a reader that throws synchronously must
    // still give `Unreadable`, not escape this never-failing method.
    const exists = ResultAsync.fromThrowable(
      (target: string) => this.deps.reader.exists(target),
      (): ModelRecommendationsSkipReason => ({ type: "Unreadable" }),
    );
    return exists(path).andThen((exists) => {
      if (!exists)
        return errAsync<string, ModelRecommendationsSkipReason>({
          type: "Missing",
        });
      return this.deps.reader
        .read(path)
        .mapErr((): ModelRecommendationsSkipReason => ({ type: "Unreadable" }));
    });
  }

  private toLayer(
    file: ModelRecommendationsFile,
    request: ModelRecommendationsLayerRequest,
    path: string,
  ): ResultAsync<
    ModelRecommendationsLayerResult,
    ModelRecommendationsSkipReason
  > {
    const section = selectRecommendationsSection(file, request.harness);
    const entries = Object.entries(section?.agents ?? {});
    const agents: Record<string, { models: string[] }> = {};
    const skippedAgents: string[] = [];
    for (const [name, entry] of entries) {
      if (!request.builtinAgents.has(name)) {
        skippedAgents.push(name);
        continue;
      }
      agents[name] = { models: [...entry.models] };
    }
    const layer = WeaveConfigSchema.safeParse({ agents });
    if (!layer.success)
      return errAsync({ type: "LayerInvalid", message: layer.error.message });
    const applied = Object.keys(agents).sort();
    log.info(
      {
        channel: request.settings.channel,
        harness: request.harness,
        issued: file.issued,
        agents: applied,
      },
      "Model recommendations layer applied",
    );
    return okAsync({
      layer: layer.data,
      diagnostic: {
        type: "ModelRecommendationsApplied",
        channel: request.settings.channel,
        harness: request.harness,
        section: section?.source ?? "default",
        path,
        issued: file.issued,
        expires: file.expires,
        evidence: file.evidence,
        agents: applied,
        skippedAgents: skippedAgents.sort(),
      },
    });
  }
}
