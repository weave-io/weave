/**
 * Shared harness for the adapter bucket.
 *
 * Drives a flush-based adapter the way `weave compose` does — parse a
 * `.weave` config, resolve every agent, hand them over, flush — and hands back
 * the files a user would find on disk. The adapter's own injectable I/O keeps
 * everything in memory, so no bundle is created.
 *
 * Adapters that materialise by writing files (Claude Code, Copilot) share this
 * shape. The OpenCode adapters register agents with a running harness instead,
 * so they need a different harness of their own.
 */

import { expect } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { ResultAsync } from "neverthrow";
import { whenMaterialized } from "./scenario.js";

/** The subset of adapter surface this harness drives. */
export interface FlushingAdapter {
  init(): Promise<void>;
  spawnSubagent(descriptor: AgentDescriptor): ResultAsync<void, Error>;
  flush(): ResultAsync<void, Error>;
}

/** In-memory I/O hooks plus the map they write into. */
export function memoryIO(): {
  written: Record<string, string>;
  hooks: {
    exists: (path: string) => Promise<boolean>;
    readDir: (path: string) => Promise<string[]>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    removeFile: (path: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
  };
} {
  const written: Record<string, string> = {};
  return {
    written,
    hooks: {
      exists: async () => true,
      readDir: async () => [],
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      removeFile: async (path) => {
        delete written[path];
      },
      mkdir: async () => {},
    },
  };
}

/**
 * Runs config through an adapter and returns everything it wrote.
 *
 * `build` receives the in-memory I/O hooks and returns the adapter under test,
 * so each bucket file supplies its own constructor without repeating the
 * pipeline.
 */
export async function generateBundle<A extends FlushingAdapter>(
  config: string,
  build: (hooks: ReturnType<typeof memoryIO>["hooks"]) => A,
): Promise<Record<string, string>> {
  const { written, hooks } = memoryIO();
  const adapter = build(hooks);

  await adapter.init();

  const plan = await whenMaterialized(config);
  for (const entry of plan.agents) {
    const spawned = await adapter.spawnSubagent(entry.descriptor);
    expect(spawned.isOk()).toBe(true);
  }
  const flushed = await adapter.flush();
  expect(flushed.isOk()).toBe(true);

  return written;
}

/** Reads one generated file, failing with the full listing when it is absent. */
export function bundleFile(
  files: Record<string, string>,
  path: string,
): string {
  const content = files[path];
  if (content === undefined) {
    expect(Object.keys(files).sort()).toContain(path);
    throw new Error("unreachable");
  }
  return content;
}

/** The YAML frontmatter block at the top of a generated agent file. */
export function frontmatter(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}
