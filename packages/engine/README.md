# @weave/engine

The Weave orchestration engine. Drives agent lifecycle management, hook registration, skill loading, and sub-agent spawning through a harness-agnostic adapter interface.

## Overview

- **`HarnessAdapter`** — interface that every harness adapter must implement
- **`WeaveRunner`** — main entry point; accepts a `WeaveConfig` and a `HarnessAdapter` and orchestrates execution

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

Harness adapters must implement `HarnessAdapter`:

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
