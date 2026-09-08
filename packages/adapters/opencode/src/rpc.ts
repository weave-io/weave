import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

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
      "skill_unavailable",
      "agent_collision",
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

const RpcErrorData = z.object({ code: z.string().min(1).max(64) }).strict();

/** Portable, read-only Weave contract. Importing it performs no setup. */
export const WeaveRpc = Rpc.define({
  id: "weave",
  methods: {
    status: {
      input: ScopeInput,
      output: z
        .object({
          scope: ScopeOutput,
          catalogRevision: z.string().length(64).optional(),
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
  },
});

export type WeaveRpcDefinition = typeof WeaveRpc;
