import { ClaudeCodeAdapter } from "@weaveio/weave-adapter-claude-code";
import { OpenCodeAdapter } from "@weaveio/weave-adapter-opencode";
import openCodePlugin from "@weaveio/weave-adapter-opencode/plugin";
import openCodeServer from "@weaveio/weave-adapter-opencode/server";
import { parseArgs } from "@weaveio/weave-cli";

export const publicConsumerTypecheck = [
  parseArgs,
  OpenCodeAdapter,
  openCodePlugin,
  openCodeServer,
  ClaudeCodeAdapter,
] as const;
