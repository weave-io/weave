/**
 * Structural guard for the child-overlay runtime split.
 *
 * The overlay runtime is intentionally layered:
 *
 *   child-overlay-types  →  child-overlay-replay  →  child-overlay-controller
 *                                                 →  child-overlay-component
 *                                                 →  child-overlay (facade)
 *
 * Imports must only flow left to right. Nothing may import the facade, and no
 * module may exceed its size budget, so the graph stays acyclic and each file
 * stays reviewable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Overlay modules in dependency order; earlier modules may not import later ones. */
const LAYERS = [
  "child-overlay-types.ts",
  "child-overlay-replay.ts",
  "child-overlay-controller.ts",
  "child-overlay-component.ts",
  "child-overlay.ts",
] as const;

/** Maximum lines allowed per overlay module. */
const MAX_MODULE_LINES = 1200;

/** Maximum lines allowed for the facade, which must stay a thin re-export. */
const MAX_FACADE_LINES = 500;

function readModule(file: string): string {
  return readFileSync(join(SRC_DIR, file), "utf8");
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
  test("imports only flow down the layer order", () => {
    for (const [index, file] of LAYERS.entries()) {
      const imports = localImports(readModule(file));
      const forbidden = LAYERS.slice(index).filter((later) =>
        imports.includes(later),
      );
      expect({ file, forbidden }).toEqual({ file, forbidden: [] });
    }
  });

  test("no overlay module imports the facade", () => {
    for (const file of LAYERS) {
      if (file === "child-overlay.ts") continue;
      expect({
        file,
        importsFacade: localImports(readModule(file)).includes(
          "child-overlay.ts",
        ),
      }).toEqual({ file, importsFacade: false });
    }
  });

  test("no overlay module imports itself", () => {
    for (const file of LAYERS) {
      expect({
        file,
        selfImport: localImports(readModule(file)).includes(file),
      }).toEqual({ file, selfImport: false });
    }
  });

  test("each module stays within its size budget", () => {
    for (const file of LAYERS) {
      const lines = readModule(file).split("\n").length;
      const budget =
        file === "child-overlay.ts" ? MAX_FACADE_LINES : MAX_MODULE_LINES;
      expect({ file, withinBudget: lines <= budget }).toEqual({
        file,
        withinBudget: true,
      });
    }
  });
});
