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

/**
 * What the harness already has on disk before the adapter runs.
 *
 * Use it to describe a user regenerating over a bundle from a previous run:
 * `existing` maps a directory to the filenames it already contains.
 */
export interface ExistingBundle {
  existing?: Record<string, string[]>;
}

export interface MemoryIO {
  /** Files the adapter wrote, by absolute path. */
  written: Record<string, string>;
  /** Files the adapter deleted, in the order it deleted them. */
  removed: string[];
  hooks: {
    exists: (path: string) => Promise<boolean>;
    readDir: (path: string) => Promise<string[]>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    removeFile: (path: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
  };
}

/** In-memory I/O hooks plus what the adapter wrote and deleted through them. */
export function memoryIO(options: ExistingBundle = {}): MemoryIO {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  const existing = options.existing ?? {};

  return {
    written,
    removed,
    hooks: {
      exists: async () => true,
      readDir: async (path) => {
        // Match a whole trailing path segment: `endsWith` would let a key of
        // `agents` also answer for `agents-extra`, so a cleanup scenario could
        // pass for the wrong directory.
        const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
        const last = segments[segments.length - 1];
        for (const [dir, names] of Object.entries(existing)) {
          if (last === dir) return names;
        }
        return [];
      },
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      removeFile: async (path) => {
        removed.push(path);
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
  build: (hooks: MemoryIO["hooks"]) => A,
): Promise<Record<string, string>> {
  return (await runAdapter(config, build)).written;
}

/**
 * As `generateBundle`, but also reports what the adapter deleted and lets the
 * caller describe files already on disk from a previous run.
 */
export async function runAdapter<A extends FlushingAdapter>(
  config: string,
  build: (hooks: MemoryIO["hooks"]) => A,
  options: ExistingBundle = {},
): Promise<{ written: Record<string, string>; removed: string[] }> {
  const { written, removed, hooks } = memoryIO(options);
  const adapter = build(hooks);

  await adapter.init();

  const plan = await whenMaterialized(config);
  for (const entry of plan.agents) {
    const spawned = await adapter.spawnSubagent(entry.descriptor);
    expect(spawned.isOk()).toBe(true);
  }

  // Nothing reaches disk until flush; a caller asserting that reads `written`
  // before this line via `runAdapter`'s own steps is not possible, so the
  // queue-then-flush promise has its own scenario driving the adapter directly.
  const flushed = await adapter.flush();
  expect(flushed.isOk()).toBe(true);

  return { written, removed };
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
