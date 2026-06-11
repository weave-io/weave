# Prototype Fidelity Reference

This directory documents the **prototype bundle** that backs the public Weave
docs site. The prototype is the **single source of truth** for visual design and
interaction behavior. Prose content is disposable; layout, classes, tokens,
colors, timings, and JavaScript behavior are the acceptance criteria.

> Implementation plan: [`.weave/plans/public-docs-prototype-replica.md`](../../../../.weave/plans/public-docs-prototype-replica.md)
> Package overview: [`../../README.md`](../../README.md)

## Fidelity baseline (ground truth)

The prototype ships as a zip (`Claude 4.8.zip`). These files are the **fidelity
baseline** — the replica is correct only when it matches them:

| Prototype file        | Role                                                              |
| --------------------- | ---------------------------------------------------------------- |
| `landing-static.html` | Landing page DOM/markup (static, no React)                       |
| `docs-home.html`      | Docs home page DOM/markup                                        |
| `docs-article.html`   | Canonical docs article DOM/markup                                |
| `design-system.html`  | Token / typography / component QA reference page                 |
| `tokens.css`          | Shared design tokens (OKLCH colors, fonts, spacing, type scale)  |
| `docs.css`            | Docs shell + prose + palette + TOC styling                       |
| `theme.js`            | Shared light/dark theme toggle (persists `localStorage`)         |
| `docs.js`             | Docs behaviors: copy buttons, command palette, TOC scrollspy     |
| `landing.js`          | Landing behaviors: generated SVGs, tabs, reveal, copy buttons    |
| `logo.png`            | Brand logo (8 KB raster)                                         |

The following zip files are **React/source artifacts** and are NOT the fidelity
baseline. The static HTML files above are the canonical markup; the `.jsx`
sources are reference-only and must not be ported verbatim:

- `index.html`, `landing.html` — wrapper/redirect shells (ignore)
- `weave-hero.jsx`, `weave-landing-app.jsx`, `weave-sections.jsx`,
  `tweaks-panel.jsx` — React prototype source (reference only)

## Prototype file → public route map

| Public route       | Prototype file        | Astro entry (target)                                 | Notes                                                            |
| ------------------ | --------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `/`                | `landing-static.html` | `src/pages/index.astro`                              | Custom Astro page (not Starlight); inline landing CSS extracted |
| `/docs/`           | `docs-home.html`      | `src/content/docs/docs/index.mdx` + Starlight shell  | Docs home content inside overridden Starlight chrome            |
| `/docs/workflows/` | `docs-article.html`   | `src/content/docs/docs/workflows.mdx`                | Canonical article; all other articles reuse this chrome         |
| `/design-system/`  | `design-system.html`  | `src/pages/design-system.astro`                      | Standalone QA/reference route (not Starlight)                   |

## Prototype asset → docs-package destination

When Task 2 ports assets, copy preserving selectors/variables/timings:

| Prototype source | Docs-package destination                          |
| ---------------- | ------------------------------------------------- |
| `logo.png`       | `src/assets/prototype/logo.png`                   |
| `tokens.css`     | `src/styles/prototype/tokens.css`                 |
| `docs.css`       | `src/styles/prototype/docs.css`                   |
| `theme.js`       | `src/scripts/prototype/theme.js`                  |
| `docs.js`        | `src/scripts/prototype/docs.js`                   |
| `landing.js`     | `src/scripts/prototype/landing.js`                |
| (inline landing) | `src/styles/prototype/landing.css` (extracted)    |
| (new)            | `src/styles/prototype/starlight-bridge.css`       |

## Starlight chrome → prototype DOM (hard overrides)

Docs routes are served by Starlight, but **no default Starlight chrome may
remain visible**. Rebuild the prototype shell through component overrides in
`src/components/starlight/` rather than theming the default shell. The docs
shell DOM is: `header.w-topbar` + `div.docs-shell` (left `.sidebar`, central
content slot, right `.toc`), plus the command-palette overlay markup.

Relevant override keys (Starlight `0.40.0`): `Head`, `ThemeProvider`,
`PageFrame`, `Header`, `Sidebar`, `MobileMenuToggle`, `TwoColumnContent`,
`PageSidebar`, `TableOfContents`, `ContentPanel`, `PageTitle`,
`MarkdownContent`, `Footer`, `Search`, `ThemeSelect`, `SocialIcons`,
`LanguageSelect`.

### How the overrides map onto Starlight's `Page.astro` (implemented)

Starlight composes a docs page as
`PageFrame[ header=Header, sidebar=Sidebar, default=TwoColumnContent[ right-sidebar=PageSidebar, default=main[ ContentPanel… MarkdownContent ] ] ]`.
The override set rebuilds the prototype shell instead of theming it:

| Override                | Role in the prototype shell                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `PageFrame`             | Emits `header.w-topbar` + `div.docs-shell` (3-col grid), the `.sidebar` aside with `#searchTrigger`, and the `#palette` overlay (including the `#paletteData` JSON island built from `src/data/docsSearch.ts` with base-resolved hrefs); loads `theme.js` + `docs.js`. The `header` slot (default `Header`) is dropped. |
| `Header`                | Renders nothing — the prototype topbar lives in `PageFrame`.                                |
| `Sidebar`               | Maps Starlight `sidebar` route data → prototype `.nav-group` lists (`aria-current="page"`). |
| `TwoColumnContent`      | Emits `main.docs-main` (body) + `aside.toc` (TOC) as direct grid cells.                     |
| `PageSidebar`           | Passes through to the `TableOfContents` override (no mobile TOC, no wrapper).               |
| `TableOfContents`       | Flattens the TOC tree → prototype `.toc-label` + `<ul>` (drops the `#_top` overview entry). |
| `ContentPanel`          | Bare passthrough — `.docs-main` owns width/padding.                                         |
| `PageTitle`             | Wraps the `<h1 id="_top">` in `.prose`.                                                     |
| `MarkdownContent`       | Wraps the body in `.prose` (no Starlight `markdown.css`).                                   |
| `Footer`                | Prototype `.prevnext` when pagination links exist; otherwise empty. No credit/last-updated. |
| `MobileMenuToggle`, `Search`, `ThemeSelect`, `SocialIcons`, `LanguageSelect` | Render nothing — their function is owned by the prototype topbar / command palette, or unused. |
| `Head`                  | Starlight head tags + base-path-safe bundled favicon.                                       |
| `ThemeProvider`         | Inlined no-FOUC bootstrap reading `localStorage["weave-theme"]`, dark-by-default.           |

### Starlight constraints / workarounds (Task 4)

- The prototype design system is loaded via Starlight `customCss` (`tokens.css`
  → `starlight-bridge.css` → `docs.css`, in that order) so the overridden chrome
  inherits the prototype tokens.
- **Search is disabled at two layers**: `pagefind: false` removes the search
  index, and the `Search` override renders nothing. Note that overriding
  `Search` makes Starlight's default `Header` want to render search even with
  Pagefind off — harmless here because the `Header` override renders nothing.
- **Theme contract is unified on `weave-theme`**: the `ThemeProvider` override
  replaces Starlight's `starlight-theme` + system-preference bootstrap with the
  prototype's `localStorage["weave-theme"]` contract so `theme.js` drives both
  layers from one key. The prototype is dark-by-default (no OS-preference
  fallback).
- **Type-safety of overrides**: `virtual:starlight/components/*` modules are not
  type-resolvable under `astro check`. `PageSidebar` imports the local
  `TableOfContents.astro` override directly (functionally identical, it reads the
  same `starlightRoute.toc`). `Sidebar` / `TableOfContents` use local structural
  interfaces mirroring `SidebarEntry` / `TocItem` instead of importing from the
  hashed `node_modules/.bun/...` path.
- `credits: false`, `lastUpdated: false`, `pagination: false` remove the default
  footer chrome; the in-article `.prevnext` / `.feedback` content is owned by
  later tasks.

## Structural anchors per route

These are the prototype DOM classes/IDs the replica must reproduce. Treat them
as the contract between markup and the ported CSS/JS.

### Landing (`/` ← `landing-static.html`)

Sections/classes: `topbar`/`brand`, `hero`/`hero-meta`/`lede`/`ctas`,
`editor`/`editor-head`/`editor-body` (diagram mount), `problem`/`solution`,
`cap-grid`/`card`, `how`/`how-tabs`/`how-tab`/`how-canvas`, `dsl`/`dsl-notes`,
`arch`, `docs-cta`/`docs-tree`, `final`, `foot`/`foot-grid`/`foot-brand`/`foot-meta`.
Interaction hooks: `.reveal` (scroll reveals), `.how-tab.active` (tabs),
`[data-copy]`/`.copy-btn` (copy), `[data-theme-set]` (theme toggle).

### Docs home (`/docs/` ← `docs-home.html`)

IDs: `searchTrigger`, `palette`, `paletteInput`, `paletteResults`, `tocList`,
plus content section IDs `what`, `start`, `anatomy`, `paths`, `conventions`,
`recent`, `next`, `introCode`.
Content classes: `home-hero`, `secn`, `callout`, `path-grid`, `codeblock`,
`docs-tree`, `conv`, `next`.

### Docs article (`/docs/workflows/` ← `docs-article.html`)

Classes: `prose`, `crumbs`, `meta`/`meta-row`, `lede`, numbered headings,
`codeblock`, `term`, `callout`, `spec`/`spec-table`, `diagram`, `deflist`,
`prevnext`, `feedback`, `toc`/`toc-label`/`toc-meta`.

**Canonical article route (implemented):** `src/content/docs/docs/workflows.mdx`
is the canonical port of `docs-article.html`. All other article routes
(`getting-started`, `guides/*`, `reference/*`) reuse the same chrome. The
article-only chrome that lived in the prototype's *inline* `<style>`/`<script>`
is factored into three shared docs components so every article shares one source:

| Component | Role |
| --------- | ---- |
| `src/components/docs/ArticleChrome.astro` | Page-scoped `is:global` CSS: numbered `·NN` heading markers (CSS counter on `.prose h2`, so the marker never enters the TOC text), `.meta-row`, `.feedback` styling, and hiding Starlight's `.sl-anchor-link` icon. |
| `src/components/docs/Feedback.astro` | The `.feedback` block + its toggle script (clicking `[data-fb]` adds `.done`). |
| `src/components/docs/WorkflowGraph.astro` | The `.diagram` block + the compiled-graph SVG `<script>` (kept in an `.astro` component because MDX parses raw `<script>` bodies as JSX expressions). |

Headings are authored as **markdown** (`##`/`###`) so Astro collects them into
the right-hand TOC and the `docs.js` scrollspy/smooth-scroll resolve against the
auto-generated slugs (the `TableOfContents` override flattens h2/h3 and tags
deeper entries `li.h3`, matching the prototype). The prototype's hand-curated
ids differ slightly from Astro's auto-slugs (e.g. `#deps` → `#inputs--dependencies`),
but TOC anchors and the scrollspy use the same slugs, so navigation stays
internally consistent. The sidebar (`astro.config.mjs`) mirrors the prototype
`.nav-group` structure (Get started / Core DSL / Reference) with `Workflows` as
the canonical, active Core DSL article. All in-article links route through
`import.meta.env.BASE_URL`.

## Interaction contract (must work on built routes)

Ported scripts must keep these behaviors verbatim:

- **Theme toggle** (`theme.js`): persists `localStorage["weave-theme"]`
  (`"light"`/`"dark"`), sets `html[data-theme]`, syncs
  `.theme-toggle button[aria-pressed]` via `[data-theme-set]`. Re-applies saved
  theme on load.
- **Landing** (`landing.js`): generates inline SVGs (`SVGNS` namespace), hero
  editor diagram, `.how-tab` tab switching, `.reveal` scroll reveals via
  `IntersectionObserver`, `[data-copy]` copy buttons.
- **Docs** (`docs.js`):
  - copy buttons via `[data-copy]` → `querySelector(target)`;
  - command palette opens on `#searchTrigger` click and `⌘/Ctrl+K`, filters via
    `#paletteInput`, renders `.res` rows, supports `ArrowUp`/`ArrowDown`
    (`.sel`), `Enter` to navigate, `Escape`/backdrop click to close;
  - palette result data is **real-route, not hardcoded**: it is read from the
    `<script id="paletteData" type="application/json">` island that `PageFrame`
    emits from [`src/data/docsSearch.ts`](../../src/data/docsSearch.ts). Each
    entry's `href` is base-path-resolved in `PageFrame` (joined to
    `import.meta.env.BASE_URL`) so `Enter` navigates to the live Astro route
    (`/docs/`, `/docs/workflows/#overview`, …). If the island is missing,
    `docs.js` falls back to a minimal built-in list so the palette is never
    empty;
  - TOC scrollspy toggles `.toc ul a.active` on scroll; anchor clicks smooth-
    scroll with a 72px top offset.

## Tokens, fonts, color model

- `tokens.css` defines CSS custom properties: `--font-sans` (`"Geist"`),
  `--font-mono` (`"Geist Mono"`), `--bg*`, `--border*`, `--accent-warm*`,
  `--cyan`, `--danger`, type scale `--fs-*`, easings `--ease-out`/`--ease-inout`.
- **Colors use OKLCH** (~56 `oklch()` declarations) — preserve exact values.
- **Fonts**: prototype imports Geist + Geist Mono from Google Fonts
  (`@import url('https://fonts.googleapis.com/css2?family=Geist...')`). Task 2
  must resolve font loading in a base-path-safe way (self-host or font package);
  do not silently drop the Geist faces.

## Fidelity checks (must pass)

Replica is complete only when **all** pass — any visible mismatch means the
work is unfinished:

1. `bun run docs:build` succeeds.
2. `bun run --filter '@weave/docs' typecheck` succeeds.
3. A root-base build (`bun run docs:build`) resolves every `href`/`src` from
   `/` with no 404s, and a generic sub-path build
   (`BASE_PATH=/sub-path/ SITE_URL=https://example.invalid bun run docs:build`)
   prefixes every internal link/asset with the base. The public route shape is
   always root-relative `/`, `/docs/`, `/design-system/` — no project-name
   prefix is baked into the experience.
4. Built `/`, `/docs/`, `/docs/workflows/`, `/design-system/` match the
   corresponding prototype HTML at **1440px, 1024px, and mobile** widths.
5. Theme toggle persists `localStorage["weave-theme"]` and updates
   `html[data-theme]` on every public route.
6. Landing generated SVGs, reveal transitions, `.how-tab` tabs, and copy
   buttons behave like the prototype.
7. Docs command palette: opens by click and `⌘/Ctrl+K`, filters, arrow-navigates
   `.sel`, opens selected route on `Enter`, closes on `Escape`/backdrop.
8. Docs copy buttons and TOC scrollspy (`.active`) behave like the prototype.
9. No default Starlight chrome remains visible (header/search/sidebar/footer).
10. Browser console shows zero errors and zero 404s for CSS, JS, fonts, logo,
    or route assets.

## Base-path safety (GitHub Pages)

The site deploys to GitHub Pages from `packages/docs/dist`
(`.github/workflows/deploy-docs.yml`). Prototype HTML uses root-relative
`.html` links and asset paths; the replica must instead:

- route every `href`/`src` through `import.meta.env.BASE_URL` or bundled asset
  URLs (`import logo from "..."`);
- rewrite `.html` links (`landing-static.html`, `docs-home.html`,
  `docs-article.html`, `design-system.html`) to the final routes above;
- never hard-code root-relative URLs that break when served under a sub-path.
