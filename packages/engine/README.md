# @weave/engine

The Weave engine manages normalized agent lifecycle concerns and the adapter boundary. It consumes validated `WeaveConfig` and passes agent intent to harness adapters; adapters own harness-specific plugin/config generation, UI state, model selection, tools, commands, and runtime wiring.

## Overview

- **`HarnessAdapter`** — interface that every harness adapter must implement to translate Weave intent into harness behavior
- **`WeaveRunner`** — main entry point; accepts a `WeaveConfig` and a `HarnessAdapter` and passes normalized agent config through the adapter boundary

## Usage

```ts
import { WeaveRunner } from "@weave/engine";
import { OpenCodeAdapter } from "@weave/adapter-opencode";
import config from "./weave.config.js";

const adapter = new OpenCodeAdapter();
const runner = new WeaveRunner(config, adapter);

await runner.run();
```

## Adapter Contract

Harness adapters must implement `HarnessAdapter`. The adapter is where harness UI state, concrete model fields, tool names, commands, and runtime behavior are resolved:

```ts
import type { HarnessAdapter } from "@weave/engine";

export class MyAdapter implements HarnessAdapter {
  async init(): Promise<void> {
    /* ... */
  }
  async spawnSubagent(name: string, config: AgentConfig): Promise<void> {
    /* ... */
  }
  async registerHook(hook: HookConfig): Promise<void> {
    /* ... */
  }
  async loadSkill(skill: SkillConfig): Promise<void> {
    /* ... */
  }
}
```
