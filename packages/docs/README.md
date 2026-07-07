# @weaveio/weave-docs

Astro + Starlight site for Weave's public landing page and public documentation.

## Commands

```bash
bun run docs:dev
bun run docs:build
```

## Public documentation structure

Public docs live under `src/content/docs/docs/` and follow Diataxis:

| Group | Route prefix | Purpose |
| --- | --- | --- |
| Tutorials | `/docs/tutorials/` | Teach first successful paths. |
| How-to | `/docs/how-to/` | Solve specific setup, config, runtime, and maintenance tasks. |
| Reference | `/docs/reference/` | Describe current CLI, DSL, config, engine, runtime, adapter, package, and deployment behavior. |
| Explanation | `/docs/explanation/` | Explain architecture and design rationale. |

Compatibility routes remain at `/docs/getting-started/`, `/docs/workflows/`,
and `/docs/guides/*/`; they point readers to the current comprehensive docs.

## Content sources

- landing page: `src/pages/index.astro`
- public docs pages: `src/content/docs/docs/`
- design-system QA route: `src/pages/design-system.astro`

GitHub Pages deployment is defined in `../../.github/workflows/deploy-docs.yml`
and publishes `packages/docs/dist`. The workflow runs `bun run docs:build` with
`SITE_URL` and `BASE_PATH` set for GitHub Pages subpath deployment.
