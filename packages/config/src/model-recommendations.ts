/**
 * SPIKE (Spec 39) — opt-in model recommendations.
 *
 * Throwaway code to answer the spike's questions; not production quality.
 * Reads a signed list of builtin-agent `models` from a cache under the global
 * config dir and turns it into a config layer; `ModelRecommendations.refresh`
 * fetches and promotes a new file.
 */

import { join } from "node:path";
import {
  type WeaveConfig,
  WeaveConfigSchema,
} from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";
import { type FileReader, globalConfigDir } from "./discovery.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "model-recommendations" });

export type ModelUpdatesMode = "off" | "notify" | "auto";
export type ModelUpdatesChannel = "stable" | "next";
export interface ModelUpdatesSettings {
  mode: ModelUpdatesMode;
  channel: ModelUpdatesChannel;
}

export const DEFAULT_RECOMMENDATIONS_URL = "https://tryweave.io/models";
export const RECOMMENDATIONS_URL_ENV = "WEAVE_MODEL_RECOMMENDATIONS_URL";
/** SPIKE: production embeds the keys; the spike takes one from the env. */
export const RECOMMENDATIONS_PUBKEY_ENV = "WEAVE_MODEL_RECOMMENDATIONS_PUBKEY";
const MAX_BYTES = 64 * 1024;
// SPIKE: env override so a live test can refetch quickly.
const THROTTLE_MS = Number(Bun.env.WEAVE_MODEL_RECOMMENDATIONS_THROTTLE_MS ?? 24 * 60 * 60 * 1000);

export const RecommendationsFileSchema = z
  .object({
    schema: z.literal(1),
    channel: z.enum(["stable", "next"]),
    issued: z.iso.datetime(),
    min_config_version: z.string().optional(),
    evidence: z.url().max(256).optional(),
    agents: z
      .record(
        z.string(),
        z.object({ models: z.array(z.string().min(1)).min(1).max(8) }).strict(),
      )
      .refine((agents) => {
        const count = Object.keys(agents).length;
        return count >= 1 && count <= 32;
      }, "agents must have 1–32 entries"),
  })
  .strict();
export type RecommendationsFile = z.infer<typeof RecommendationsFileSchema>;

export type RecommendationsError =
  | { type: "Missing" }
  | { type: "TooLarge" }
  | { type: "NoPublicKey" }
  | { type: "SignatureInvalid" }
  | { type: "SchemaInvalid"; message: string }
  | { type: "ChannelMismatch" }
  | { type: "NotNewer" }
  | { type: "Network"; message: string };

export function cacheDir(channel: ModelUpdatesChannel): string {
  return join(globalConfigDir(), "cache", "model-recommendations", channel);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0));
}

function publicKeys(): string[] {
  const fromEnv = Bun.env[RECOMMENDATIONS_PUBKEY_ENV];
  return fromEnv ? [fromEnv] : [];
}

/** Verify `sigB64` over the exact UTF-8 bytes of `text`, then validate. */
export function verifyRecommendations(
  text: string,
  sigB64: string,
  channel: ModelUpdatesChannel,
): ResultAsync<RecommendationsFile, RecommendationsError> {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  if (bytes.length > MAX_BYTES) return errAsync({ type: "TooLarge" });
  const keys = publicKeys();
  if (keys.length === 0) return errAsync({ type: "NoPublicKey" });
  return ResultAsync.fromPromise(
    (async () => {
      const signature = base64ToBytes(sigB64);
      for (const key of keys) {
        const pub = await crypto.subtle.importKey(
          "raw",
          base64ToBytes(key),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        if (await crypto.subtle.verify("Ed25519", pub, signature, bytes))
          return true;
      }
      return false;
    })(),
    (): RecommendationsError => ({ type: "SignatureInvalid" }),
  ).andThen((verified) => {
    if (!verified) return errAsync({ type: "SignatureInvalid" as const });
    const parsed = RecommendationsFileSchema.safeParse(
      (() => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      })(),
    );
    if (!parsed.success)
      return errAsync({
        type: "SchemaInvalid" as const,
        message: parsed.error.message.slice(0, 200),
      });
    if (parsed.data.channel !== channel)
      return errAsync({ type: "ChannelMismatch" as const });
    return okAsync(parsed.data);
  });
}

/**
 * Read the merged `model_updates` setting from parsed layers, project last.
 * Absent everywhere means off.
 */
export function modelUpdatesSettings(
  layers: readonly WeaveConfig[],
): ModelUpdatesSettings {
  let settings: ModelUpdatesSettings = { mode: "off", channel: "stable" };
  for (const layer of layers) {
    const value = layer.settings.model_updates;
    if (value !== undefined) settings = { ...settings, ...value };
  }
  return settings;
}

/**
 * Read `applied.json` through `reader` (so OpenCode 2's source cache records
 * and probes it) and turn it into a models-only layer for builtin agents.
 */
export function readRecommendationsLayer(
  reader: FileReader,
  settings: ModelUpdatesSettings,
  builtinAgents: ReadonlySet<string>,
): ResultAsync<WeaveConfig, RecommendationsError> {
  const dir = cacheDir(settings.channel);
  const filePath = join(dir, "applied.json");
  const sigPath = join(dir, "applied.json.sig");
  return ResultAsync.fromSafePromise(reader.exists(filePath))
    .andThen((exists) =>
      exists ? okAsync(true) : errAsync({ type: "Missing" as const }),
    )
    .andThen(() =>
      reader
        .read(filePath)
        .mapErr((): RecommendationsError => ({ type: "Missing" }))
        .andThen((text) =>
          reader
            .read(sigPath)
            .mapErr((): RecommendationsError => ({ type: "Missing" }))
            .map((sig) => ({ text, sig })),
        ),
    )
    .andThen(({ text, sig }) =>
      verifyRecommendations(text, sig, settings.channel),
    )
    .map((file) => {
      const agents: Record<string, { models: string[] }> = {};
      for (const [name, entry] of Object.entries(file.agents)) {
        if (!builtinAgents.has(name)) {
          log.info({ agent: name }, "Skipping recommendation for unknown agent");
          continue;
        }
        agents[name] = { models: entry.models };
      }
      return WeaveConfigSchema.parse({ agents });
    });
}

interface CacheState {
  lastCheck?: number;
  etag?: string;
  lastError?: string;
}

/** Fetches, verifies and promotes recommendations. Never throws. */
export class ModelRecommendations {
  private inFlight?: Promise<void>;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fire-and-forget entry point for adapters. */
  refreshInBackground(settings: ModelUpdatesSettings, force = false): void {
    if (settings.mode === "off") return;
    if (this.inFlight !== undefined) return;
    this.inFlight = this.refresh(settings, force)
      .match(
        (outcome) => log.info({ outcome }, "Model recommendations refreshed"),
        (error) => log.warn({ error }, "Model recommendations not updated"),
      )
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  refresh(
    settings: ModelUpdatesSettings,
    force = false,
  ): ResultAsync<"throttled" | "unchanged" | "downloaded" | "applied", RecommendationsError> {
    const dir = cacheDir(settings.channel);
    return ResultAsync.fromSafePromise(this.readState(dir)).andThen((state) => {
      if (!force && state.lastCheck !== undefined && this.now() - state.lastCheck < THROTTLE_MS)
        return okAsync("throttled" as const);
      const base = Bun.env[RECOMMENDATIONS_URL_ENV] ?? DEFAULT_RECOMMENDATIONS_URL;
      const url = `${base}/${settings.channel}.v1.json`;
      const headers: Record<string, string> = {};
      if (state.etag) headers["if-none-match"] = state.etag;
      return ResultAsync.fromPromise(
        (async () => {
          const response = await this.fetchImpl(url, {
            headers,
            signal: AbortSignal.timeout(5_000),
          });
          if (response.status === 304) return { status: 304 as const };
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          const sigResponse = await this.fetchImpl(`${url}.sig`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!sigResponse.ok) throw new Error(`sig HTTP ${sigResponse.status}`);
          return {
            status: 200 as const,
            text,
            sig: await sigResponse.text(),
            etag: response.headers.get("etag") ?? undefined,
          };
        })(),
        (cause): RecommendationsError => ({ type: "Network", message: String(cause) }),
      )
        .andThen((download) => {
          if (download.status === 304) {
            return ResultAsync.fromSafePromise(
              this.writeState(dir, { ...state, lastCheck: this.now() }),
            ).map(() => "unchanged" as const);
          }
          return verifyRecommendations(download.text, download.sig, settings.channel)
            .andThen((file) => this.store(dir, settings, download, file, state));
        })
        .orElse((error) =>
          ResultAsync.fromSafePromise(
            this.writeState(dir, { ...state, lastCheck: this.now(), lastError: error.type }),
          ).andThen(() => errAsync(error)),
        );
    });
  }

  private store(
    dir: string,
    settings: ModelUpdatesSettings,
    download: { text: string; sig: string; etag?: string },
    file: RecommendationsFile,
    state: CacheState,
  ): ResultAsync<"downloaded" | "applied", RecommendationsError> {
    return ResultAsync.fromSafePromise(
      (async () => {
        await Bun.write(join(dir, "latest.json"), download.text);
        await Bun.write(join(dir, "latest.json.sig"), download.sig);
        const applied = await this.appliedIssued(dir);
        const newer = applied === undefined || Date.parse(file.issued) > Date.parse(applied);
        const promote = settings.mode === "auto" && newer;
        if (promote) {
          // Signature first: the loader re-verifies, so a reader that sees the
          // new sig with the old json rejects it rather than merging it.
          await Bun.write(join(dir, "applied.json.sig"), download.sig);
          await Bun.write(join(dir, "applied.json"), download.text);
        }
        await this.writeState(dir, { lastCheck: this.now(), etag: download.etag ?? state.etag });
        return promote ? ("applied" as const) : ("downloaded" as const);
      })(),
    );
  }

  private async appliedIssued(dir: string): Promise<string | undefined> {
    const file = Bun.file(join(dir, "applied.json"));
    if (!(await file.exists())) return undefined;
    const parsed = RecommendationsFileSchema.safeParse(await file.json().catch(() => undefined));
    return parsed.success ? parsed.data.issued : undefined;
  }

  private async readState(dir: string): Promise<CacheState> {
    const file = Bun.file(join(dir, "state.json"));
    if (!(await file.exists())) return {};
    return (await file.json().catch(() => ({}))) as CacheState;
  }

  private async writeState(dir: string, state: CacheState): Promise<void> {
    await Bun.write(join(dir, "state.json"), `${JSON.stringify(state)}\n`);
  }
}
