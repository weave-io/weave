/**
 * Structural guard for the child-overlay runtime split.
 *
 * The overlay runtime is intentionally layered:
 *
 *   child-overlay-types  →  child-overlay-scroll   →  child-overlay-window
 *                        →  child-overlay-native-parts
 *                        →  child-overlay-replay   →  child-overlay-controller
 *                        →  child-overlay-stream   →  child-overlay-pi-native
 *                        →  child-overlay-facts    →  child-overlay-component
 *                                                  →  child-overlay (facade)
 *
 * Imports must only flow left to right. Nothing may import the facade, and no
 * module may exceed its size budget, so the graph stays acyclic and each file
 * stays reviewable.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..");

/** Overlay modules in dependency order; earlier modules may not import later ones. */
const LAYERS = [
  "child-overlay-types.ts",
  "child-overlay-telemetry.ts",
  "child-overlay-scroll.ts",
  "child-overlay-native-parts.ts",
  "child-overlay-replay.ts",
  "child-overlay-window.ts",
  "child-overlay-controller.ts",
  "child-overlay-stream.ts",
  "child-overlay-pi-native.ts",
  "child-overlay-facts.ts",
  "child-overlay-component.ts",
  "child-overlay.ts",
] as const;

/** Maximum lines allowed per overlay module. */
const MAX_MODULE_LINES = 1200;

/** Maximum lines allowed for the facade, which must stay a thin re-export. */
const MAX_FACADE_LINES = 500;

async function readModule(file: string): Promise<string> {
  return await Bun.file(join(SRC_DIR, file)).text();
}

function localImports(source: string): readonly string[] {
  const specifiers: string[] = [];
  const pattern = /from\s+"(\.\/[^"]+)"/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
    }
    match = pattern.exec(source);
  }
  return specifiers;
}

describe("child overlay module boundaries", () => {
  test("imports only flow down the layer order", async () => {
    for (const [index, file] of LAYERS.entries()) {
      const imports = localImports(await readModule(file));
      const forbidden = LAYERS.slice(index).filter((later) =>
        imports.includes(later),
      );
      expect({ file, forbidden }).toEqual({ file, forbidden: [] });
    }
  });

  test("no overlay module imports the facade", async () => {
    for (const file of LAYERS) {
      if (file === "child-overlay.ts") continue;
      expect({
        file,
        importsFacade: localImports(await readModule(file)).includes(
          "child-overlay.ts",
        ),
      }).toEqual({ file, importsFacade: false });
    }
  });

  test("no overlay module imports itself", async () => {
    for (const file of LAYERS) {
      expect({
        file,
        selfImport: localImports(await readModule(file)).includes(file),
      }).toEqual({ file, selfImport: false });
    }
  });

  test("each module stays within its size budget", async () => {
    for (const file of LAYERS) {
      const lines = (await readModule(file)).split("\n").length;
      const budget =
        file === "child-overlay.ts" ? MAX_FACADE_LINES : MAX_MODULE_LINES;
      expect({ file, withinBudget: lines <= budget }).toEqual({
        file,
        withinBudget: true,
      });
    }
  });
});
