import { z } from "zod";
import { V2Rpc as Rpc } from "./sdk-types.js";

const ScopeInput = z
  .object({
    sessionID: z.string().min(1).max(256),
    directory: z.string().min(1).max(4096),
    workspaceID: z.string().max(512).optional(),
    scopeToken: z.string().min(1).max(128),
  })
  .strict();

const ScopeOutput = z
  .object({
    sessionID: z.string().min(1).max(256),
    scopeToken: z.string().min(1).max(128),
  })
  .strict();

const Issue = z
  .object({
    code: z.enum([
      "materialization_failed",
      "model_unavailable",
      "variant_unavailable",
      "skill_unavailable",
      "model_updates_unavailable",
      "agent_collision",
      "config_invalid",
    ]),
    agentName: z.string().max(128).optional(),
    count: z.number().int().min(0).max(512).optional(),
  })
  .strict();

const Task = z
  .object({
    id: z.string().max(32),
    title: z.string().max(512),
    state: z.enum(["pending", "in_progress", "completed"]),
    depth: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

const Plan = z
  .object({
    name: z.string().max(128),
    revision: z.string().length(64),
    completed: z.number().int().min(0).max(512),
    total: z.number().int().min(0).max(512),
    current: Task.optional(),
    next: Task.optional(),
    tasks: z.array(Task).max(512),
  })
  .strict();

/**
 * The model recommendations layer (Spec 39): `off` without an opt-in,
 * `pending` before anything is applied, `applied` with the list's `issued`,
 * `unavailable` when `applied.json` is there but unusable (see the
 * `model_updates_unavailable` issue).
 */
const ModelUpdates = z
  .object({
    mode: z.enum(["off", "notify", "auto"]),
    channel: z.enum(["stable", "next"]),
    state: z.enum(["off", "pending", "applied", "unavailable"]),
    issued: z.string().min(1).max(64).optional(),
  })
  .strict();

const ModelChange = z
  .object({
    agent: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128).optional(),
    providerID: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  })
  .strict();

const RpcErrorData = z.object({ code: z.string().min(1).max(64) }).strict();

/** Portable Weave contract. Importing it performs no setup. */
export const WeaveRpc = Rpc.define({
  id: "weave",
  methods: {
    status: {
      input: ScopeInput,
      output: z
        .object({
          scope: ScopeOutput,
          catalogRevision: z.string().length(64).optional(),
          modelUpdates: ModelUpdates.optional(),
          refresh: z.enum([
            "initializing",
            "fresh",
            "deferred",
            "failed",
            "disposed",
          ]),
          agentCount: z.number().int().min(0).max(512),
          issues: z.array(Issue).max(64),
          readiness: z
            .object({
              nativeAgents: z.boolean(),
              requestIntent: z.boolean(),
              foregroundPlans: z.boolean(),
              planDisplay: z.boolean(),
              nativeDelegation: z.boolean(),
              durableWorkflows: z.literal(false),
            })
            .strict(),
        })
        .strict(),
      errors: {
        wrong_location: RpcErrorData,
        session_unavailable: RpcErrorData,
      },
    },
    plan: {
      input: ScopeInput,
      output: z
        .object({
          scope: ScopeOutput,
          state: z.enum(["no_plan", "ready", "completed"]),
          plan: Plan.optional(),
        })
        .strict(),
      errors: {
        wrong_location: RpcErrorData,
        session_unavailable: RpcErrorData,
        plan_unavailable: RpcErrorData,
      },
    },
    start: {
      input: ScopeInput.extend({
        planName: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      }),
      output: z.object({ scope: ScopeOutput }).strict(),
      errors: {
        wrong_location: RpcErrorData,
        session_unavailable: RpcErrorData,
        start_unavailable: RpcErrorData,
      },
    },
    plans: {
      input: ScopeInput,
      output: z
        .object({
          scope: ScopeOutput,
          names: z.array(z.string().min(1).max(128)).max(256),
        })
        .strict(),
      errors: {
        wrong_location: RpcErrorData,
        session_unavailable: RpcErrorData,
        plan_catalog_unreadable: RpcErrorData,
      },
    },
  },
  events: {
    "plan.changed": {
      schema: z
        .object({
          sessionID: z.string().min(1).max(256),
          scopeToken: z.string().min(1).max(128),
        })
        .strict(),
    },
    /**
     * A reload changed some agents' resolved models because a newer model
     * recommendations list was applied (Spec 39). Emitted once per reload;
     * the TUI shows it as a notice.
     */
    "models.changed": {
      schema: z
        .object({
          issued: z.string().min(1).max(64),
          agents: z.array(ModelChange).min(1).max(64),
        })
        .strict(),
    },
  },
});

export type WeaveRpcDefinition = typeof WeaveRpc;
