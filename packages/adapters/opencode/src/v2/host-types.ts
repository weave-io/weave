/** Public types from the exact OpenCode 2 host boundary. */

export type { Agent, Model, Skill } from "@opencode-ai/plugin";
export type { AgentEditor } from "@opencode-ai/plugin/promise/agent";
export type {
  CommandEditor,
  CommandInvocation,
} from "@opencode-ai/plugin/promise/command";
export type {
  Context as OpenCode2Context,
  Plugin as OpenCode2Plugin,
} from "@opencode-ai/plugin/promise/plugin";
export type {
  RpcHandlers,
  RpcRegistration,
} from "@opencode-ai/plugin/promise/rpc";
export type {
  SessionContext,
  SessionPrompt,
} from "@opencode-ai/plugin/promise/session";
