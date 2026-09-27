import { copySafeGraph } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { OpenCode2Error } from "./errors.js";

export interface OpenCode2Options {
  readonly projectConfig: boolean;
  readonly defaultAgent: string;
  readonly refreshIntervalMs: number;
}

const OpenCode2OptionsSchema = z
  .object({
    projectConfig: z.boolean().optional(),
    defaultAgent: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    refreshIntervalMs: z.number().int().min(250).max(60_000).optional(),
  })
  .strict();

export function parseOpenCode2Options(
  value: unknown,
): Result<OpenCode2Options, OpenCode2Error> {
  const copied = copySafeGraph(value);
  if (copied.isErr())
    return err({
      code: "invalid_options",
      message: "OpenCode 2 plugin options must be bounded plain data",
    });
  const parsed = OpenCode2OptionsSchema.safeParse(copied.value);
  if (!parsed.success)
    return err({
      code: "invalid_options",
      message: "OpenCode 2 plugin options contain an unknown or invalid field",
    });
  return ok({
    projectConfig: parsed.data.projectConfig ?? true,
    // Loom unless the option names another agent. This never overrides the
    // user's own `default_agent`: OpenCode 2 applies its config agent
    // transform (core/src/config/plugin/agent.ts) after every package plugin's
    // (the plugin supervisor orders pre, packages, post), and
    // registerOpenCode2Agents only sets a default for an agent Weave inserted.
    defaultAgent: parsed.data.defaultAgent ?? "loom",
    refreshIntervalMs: parsed.data.refreshIntervalMs ?? 1_000,
  });
}
