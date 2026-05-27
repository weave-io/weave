/**
 * Type declaration for Markdown files imported as text.
 *
 * Bun supports `import content from "./file.md" with { type: "text" }` which
 * embeds the file content as a string at build time. This declaration tells
 * TypeScript to treat `.md` imports as `string` values.
 *
 * Used by `packages/config/src/builtins.ts` to embed builtin prompt files at
 * build time, making prompt resolution bundle-safe (no filesystem access
 * required at runtime).
 */
declare module "*.md" {
  const content: string;
  export default content;
}
