# @weave/docs

Astro + Starlight site for Weave's public landing page and public documentation.

## Commands

```bash
bun run docs:dev
bun run docs:build
```

## Fidelity reference (read this first)

This package is being rebuilt as an **exact visual/interaction replica** of a
prototype bundle. The prototype — not the current text — is the source of truth.

**Single reference:** [`src/prototype/README.md`](src/prototype/README.md)
documents the fidelity baseline, the prototype-file → route map, the asset
destinations, the Starlight override strategy, per-route structural anchors, the
interaction contract, and the fidelity checks that must pass.

Implementation plan:
[`../../.weave/plans/public-docs-prototype-replica.md`](../../.weave/plans/public-docs-prototype-replica.md).

### Route map at a glance

| Public route       | Prototype file        | Astro entry (target)                  |
| ------------------ | --------------------- | ------------------------------------- |
| `/`                | `landing-static.html` | `src/pages/index.astro`               |
| `/docs/`           | `docs-home.html`      | `src/content/docs/docs/index.mdx`     |
| `/docs/workflows/` | `docs-article.html`   | `src/content/docs/docs/workflows.mdx` |
| `/design-system/`  | `design-system.html`  | `src/pages/design-system.astro`       |

The fidelity baseline assets are `landing-static.html`, `docs-home.html`,
`docs-article.html`, `tokens.css`, `docs.css`, `theme.js`, `docs.js`,
`landing.js`, and `logo.png`. See the prototype README for where each lands in
this package and which fidelity checks must pass.

## Content sources

- landing page: `src/pages/index.astro`
- public docs pages: `src/content/docs/docs/`
- design-system QA route: `src/pages/design-system.astro`

GitHub Pages deployment is defined in `../../.github/workflows/deploy-docs.yml`
and publishes `packages/docs/dist`.
