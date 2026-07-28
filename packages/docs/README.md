# @weaveio/weave-docs

Astro + Starlight site for Weave's public landing page and documentation.

## Commands

```bash
bun run docs:dev
bun run docs:typecheck
bun run docs:build
bun run docs:check-links
```

Run typecheck before build. Astro's generated data store must not be written by both commands at the same time.

## Public documentation structure

Public docs live under `src/content/docs/docs/` and use one page per user goal:

| Group | Pages |
| --- | --- |
| Start | Overview, Quickstart, Concepts |
| Configure | Configuration, Agents and categories, Prompts/models/policy, Workflows |
| Adapters | Support matrix, OpenCode, Claude Code, Pi |
| Operate | Runtime inspection, Evals, Releases |
| Reference | CLI, DSL, Packages |

Old entry points are handled by redirects in `astro.config.mjs`; redirects are not part of the sidebar or search index.

## Content sources

- landing page: `src/pages/index.astro`
- public docs pages: `src/content/docs/docs/`
- search data: `src/data/docs-search.ts`
- design-system QA route: `src/pages/design-system.astro`
