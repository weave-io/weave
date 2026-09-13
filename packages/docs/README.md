# @weaveio/weave-docs

Astro + Starlight site with contributor reference docs for Weave.

> **This site is not published.** The public documentation at
> [tryweave.io/docs](https://tryweave.io/docs/) is the source of truth for
> users and is maintained by hand in
> [pgermishuys/weave-website](https://github.com/pgermishuys/weave-website).
> When a change affects user-visible behavior (CLI output, DSL syntax, install
> steps, adapter behavior), update the website too. Use this site for deeper
> reference and design material, and build it locally with the commands below.

## Commands

```bash
bun run docs:dev
bun run docs:build
```

## Documentation structure

Pages live under `src/content/docs/docs/` and follow Diataxis:

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
- docs pages: `src/content/docs/docs/`
- design-system QA route: `src/pages/design-system.astro`

There is no deployment workflow. `bun run docs:build` honors `SITE_URL` and
`BASE_PATH` so the site can still be built for a subpath host.
