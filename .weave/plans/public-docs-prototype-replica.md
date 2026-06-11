# Public Docs Prototype Replica

## TL;DR
> **Summary**: Rebuild `packages/docs` so the landing page and Starlight docs routes visually and interactively match `/Users/jose/Downloads/Claude 4.8.zip`, treating the prototype bundle as the source of truth and current docs text as disposable.
> **Estimated Effort**: Large

## Context
### Original Request
Create a practical implementation plan for the Weave public docs package so `packages/docs` becomes an exact visual/interaction replica of the prototype bundle at `/Users/jose/Downloads/Claude 4.8.zip`. The prototype design is mandatory; text content is not important. Execution will be done later by Tapestry via `/start-work`.

### Key Findings
- `packages/docs` currently contains a new Astro + Starlight starter with `src/pages/index.astro`, simple MDX pages under `src/content/docs/docs/`, and no prototype assets/styles/scripts yet.
- The handoff at `/var/folders/00/kg4g6rwj56df8m493xpgm7s00000gn/T/handoff-XXXXXX.md.YvpH2S9J2Y` confirms `packages/docs` is the public site and repo-root `docs/` must remain internal-only.
- Prototype bundle files: `landing-static.html`, `docs-home.html`, `docs-article.html`, `design-system.html`, `tokens.css`, `docs.css`, `theme.js`, `docs.js`, `landing.js`, `logo.png`, plus React/prototype source files.
- Prototype routes should map to public routes: `landing-static.html` → `/`, `docs-home.html` → `/docs/`, `docs-article.html` → a canonical article route such as `/docs/workflows/`, and `design-system.html` → `/design-system/` as a QA/reference route.
- Starlight `0.40.0` supports `customCss`, `head`, `pagefind: false`, and component overrides. Relevant override keys include `Head`, `ThemeProvider`, `PageFrame`, `Header`, `Sidebar`, `MobileMenuToggle`, `TwoColumnContent`, `PageSidebar`, `TableOfContents`, `ContentPanel`, `PageTitle`, `MarkdownContent`, `Footer`, `Search`, `ThemeSelect`, `SocialIcons`, and `LanguageSelect`.
- To reach exact fidelity, prefer copying the prototype CSS/JS behavior and replacing Starlight chrome via overrides instead of merely theming default Starlight.

### Risks and Dependencies
- Prototype tokens reference `Geist` and `Geist Mono` but the zip does not include font files; exact typography likely requires self-hosting matching font assets or adding font packages.
- Starlight internal CSS is still imported by its route renderer; component overrides plus a bridge/reset stylesheet must neutralize visible default Starlight styling.
- GitHub Pages `BASE_PATH` can break copied asset URLs if links are hard-coded; all Astro pages/components must use `import.meta.env.BASE_URL` or bundled asset URLs.
- The prototype uses vanilla scripts for theme persistence, reveal animations, generated SVGs, copy buttons, command palette, keyboard navigation, and TOC scrollspy; all scripts must be wired on the final routes, not just copied.
- Pixel-perfect validation depends on consistent browser, viewport, fonts, motion state, and scroll positions. Treat any visible mismatch as unfinished.

## Objectives
### Core Objective
Make the built public docs site in `packages/docs` an exact visual and interaction replica of the prototype bundle for landing, docs home, docs article, shared tokens, JavaScript behaviors, and assets.

### Deliverables
- [ ] Prototype assets, tokens, docs CSS, landing CSS, and browser scripts are ported into `packages/docs` with base-path-safe loading.
- [ ] `/` matches prototype `landing-static.html`, including hero diagram, sections, theme toggle, reveal transitions, tabs, copy buttons, responsive behavior, and footer.
- [ ] `/docs/` matches prototype `docs-home.html`, including topbar, docs shell, sidebar, search trigger, docs-home content modules, right TOC, palette, and responsive behavior.
- [ ] A canonical article route such as `/docs/workflows/` matches prototype `docs-article.html`, including prose, code blocks, callouts, tables, diagrams, prev/next, feedback, TOC, palette, and scrollspy.
- [ ] Starlight is customized through supported overrides so no default Starlight chrome remains visible.
- [ ] Prototype `design-system.html` is available as `/design-system/` or an equivalent QA/reference route for visual token verification.
- [ ] Build, typecheck, route, interaction, and visual comparisons prove exact replica status.

### Definition of Done
- [ ] `bun run docs:build` succeeds.
- [ ] `bun run --filter '@weave/docs' typecheck` succeeds.
- [ ] `BASE_PATH=/weave/ SITE_URL=https://example.invalid bun run docs:build` succeeds and generated asset links work under the base path.
- [ ] Screenshots of built `/`, `/docs/`, `/docs/workflows/`, and `/design-system/` match the corresponding prototype pages at desktop, tablet, and mobile widths with no visible design differences.
- [ ] Theme toggle, landing animations/tabs/copy buttons, docs command palette, keyboard shortcuts, copy buttons, and TOC scrollspy work on the built site.
- [ ] No browser console errors and no network 404s appear for CSS, JS, fonts, or image assets.

### Guardrails (Must NOT)
- Do not publish or copy repo-root `docs/` as the public docs site.
- Do not prioritize prose quality over visual fidelity; prototype layout and interactions are the acceptance criteria.
- Do not leave default Starlight UI visible if it diverges from the prototype.
- Do not hard-code root-relative URLs that fail when GitHub Pages serves the site under a repository base path.
- Do not introduce Node-only runtime code into the docs package; keep project tooling Bun-compatible.

## TODOs

- [x] 1. Establish the prototype-to-site map
  **What**: Create an implementation reference that maps each prototype file to final Astro/Starlight routes, assets, and components. Record that `landing-static.html`, `docs-home.html`, `docs-article.html`, `tokens.css`, `docs.css`, `theme.js`, `docs.js`, `landing.js`, and `logo.png` are the fidelity baseline.
  **Files**: `packages/docs/README.md`, `packages/docs/src/prototype/README.md`
  **Acceptance**: Future implementers can open one docs-package reference and know exactly which prototype file backs each public route and which fidelity checks must pass.

- [x] 2. Port shared prototype assets and tokens
  **What**: Copy `logo.png`, `tokens.css`, `docs.css`, `theme.js`, `docs.js`, and `landing.js` from the zip into the docs package. Extract the inline landing styles from `landing-static.html` into a dedicated landing stylesheet. Preserve selectors, variables, timings, OKLCH colors, class names, and script behavior unless a change is required for Astro base-path support.
  **Files**: `packages/docs/package.json`, `packages/docs/src/assets/prototype/logo.png`, `packages/docs/src/styles/prototype/tokens.css`, `packages/docs/src/styles/prototype/docs.css`, `packages/docs/src/styles/prototype/landing.css`, `packages/docs/src/styles/prototype/starlight-bridge.css`, `packages/docs/src/scripts/prototype/theme.js`, `packages/docs/src/scripts/prototype/docs.js`, `packages/docs/src/scripts/prototype/landing.js`
  **Acceptance**: The copied CSS/JS is traceable to the prototype, Astro can bundle it, font loading is resolved, and no asset URLs are hard-coded in a way that breaks `BASE_PATH`.

- [x] 3. Rebuild the custom landing page from the prototype
  **What**: Replace the current starter `index.astro` with an Astro version of `landing-static.html`. Keep the prototype DOM/classes for topbar, hero, editor/diagram mount, why/capabilities/how/DSL/architecture/docs/final/footer sections. Adjust only links, asset imports, and base-path handling. Wire `theme.js` and `landing.js` so generated SVGs, tabs, copy, and reveal transitions work.
  **Files**: `packages/docs/src/pages/index.astro`, `packages/docs/src/components/prototype/Topbar.astro`, `packages/docs/src/components/prototype/ThemeToggle.astro`, `packages/docs/src/styles/prototype/landing.css`, `packages/docs/src/scripts/prototype/landing.js`
  **Acceptance**: Built `/` is visually indistinguishable from `landing-static.html` at initial load, after scroll reveals, after theme toggle, and across responsive breakpoints.

- [x] 4. Configure Starlight for hard visual overrides
  **What**: Update Starlight config to load prototype CSS, disable Pagefind/default search UI, disable default credits/last-updated/pagination where replaced, set favicon/logo metadata, and register custom override components. Use overrides to rebuild the docs shell rather than styling the default Starlight shell.
  **Files**: `packages/docs/astro.config.mjs`, `packages/docs/src/components/starlight/Head.astro`, `packages/docs/src/components/starlight/ThemeProvider.astro`, `packages/docs/src/components/starlight/PageFrame.astro`, `packages/docs/src/components/starlight/Header.astro`, `packages/docs/src/components/starlight/Sidebar.astro`, `packages/docs/src/components/starlight/MobileMenuToggle.astro`, `packages/docs/src/components/starlight/TwoColumnContent.astro`, `packages/docs/src/components/starlight/PageSidebar.astro`, `packages/docs/src/components/starlight/TableOfContents.astro`, `packages/docs/src/components/starlight/ContentPanel.astro`, `packages/docs/src/components/starlight/PageTitle.astro`, `packages/docs/src/components/starlight/MarkdownContent.astro`, `packages/docs/src/components/starlight/Footer.astro`, `packages/docs/src/components/starlight/Search.astro`, `packages/docs/src/components/starlight/ThemeSelect.astro`, `packages/docs/src/components/starlight/SocialIcons.astro`, `packages/docs/src/components/starlight/LanguageSelect.astro`
  **Acceptance**: Docs routes render prototype `.w-topbar`, `.docs-shell`, `.sidebar`, `.docs-main`, `.prose`, and `.toc` structure; default Starlight header/search/sidebar/footer styling is not visible.

- [x] 5. Recreate the docs shell layout inside Starlight overrides
  **What**: Implement the docs layout as `header.w-topbar` plus `div.docs-shell` with left sidebar, central Starlight content slot, and right TOC. Put the command palette markup in the shell so `docs.js` can open it from `#searchTrigger`. Keep prototype sidebar nav groups, badges, current-page states, TOC metadata, and responsive collapse behavior.
  **Files**: `packages/docs/src/components/starlight/PageFrame.astro`, `packages/docs/src/components/starlight/Header.astro`, `packages/docs/src/components/starlight/Sidebar.astro`, `packages/docs/src/components/starlight/TwoColumnContent.astro`, `packages/docs/src/components/starlight/PageSidebar.astro`, `packages/docs/src/components/starlight/TableOfContents.astro`, `packages/docs/src/styles/prototype/docs.css`, `packages/docs/src/styles/prototype/starlight-bridge.css`
  **Acceptance**: `/docs/` and article routes have the same grid, fixed topbar, sticky sidebar/TOC, palette overlay, active nav styling, and mobile behavior as the prototype docs pages.

- [x] 6. Port the docs home page content structure
  **What**: Replace the starter docs index with the prototype `docs-home.html` main content structure. Keep prototype classes such as `home-hero`, `secn`, `callout`, `path-grid`, `codeblock`, `docs-tree`, `conv`, and `next`. Use MDX/raw HTML or small Astro components only when they preserve the same emitted DOM and classes.
  **Files**: `packages/docs/src/content/docs/docs/index.mdx`, `packages/docs/src/components/docs/DocsHomeHero.astro`, `packages/docs/src/components/docs/CodeBlock.astro`, `packages/docs/src/components/docs/Callout.astro`
  **Acceptance**: Built `/docs/` matches `docs-home.html`; content may be rewritten only if visual dimensions, classes, and interaction targets remain equivalent.

- [x] 7. Port the canonical docs article structure
  **What**: Add or repurpose a canonical article route for the prototype `docs-article.html` content, preferably `/docs/workflows/`. Keep article classes such as `prose`, `crumbs`, `meta-row`, `lede`, numbered headings, `codeblock`, `term`, `callout`, `spec-table`, `diagram`, `deflist`, `prevnext`, and `feedback`. Update sidebar links so the active article mirrors the prototype.
  **Files**: `packages/docs/src/content/docs/docs/workflows.mdx`, `packages/docs/src/content/docs/docs/getting-started.mdx`, `packages/docs/src/content/docs/docs/guides/installation.mdx`, `packages/docs/src/content/docs/docs/guides/core-concepts.mdx`, `packages/docs/src/content/docs/docs/guides/configuration.mdx`, `packages/docs/src/content/docs/docs/reference/cli.mdx`, `packages/docs/src/content/docs/docs/reference/adapters.mdx`, `packages/docs/astro.config.mjs`
  **Acceptance**: Built `/docs/workflows/` matches `docs-article.html`, and every existing article route uses the same prototype article chrome without broken nav or layout regressions.

- [x] 8. Wire docs JavaScript behaviors to real routes
  **What**: Adapt `docs.js` route data and selectors for Astro routes while keeping prototype behavior. Ensure copy buttons target real code blocks, the command palette opens on click and `⌘/Ctrl+K`, filtering and arrow-key navigation work, Escape closes the palette, and TOC scrollspy applies `.active` as users scroll.
  **Files**: `packages/docs/src/scripts/prototype/docs.js`, `packages/docs/src/components/starlight/PageFrame.astro`, `packages/docs/src/components/starlight/Sidebar.astro`, `packages/docs/src/components/starlight/TableOfContents.astro`, `packages/docs/src/data/docsSearch.ts`
  **Acceptance**: Manual browser testing confirms every prototype docs interaction works on `/docs/` and `/docs/workflows/` without console errors.

- [x] 9. Port the design-system reference page for QA
  **What**: Create a standalone Astro route from `design-system.html` to verify tokens, typography, spacing, components, icons, motion, and motif styling in the built site. Reuse the shared topbar, theme toggle, logo, and token CSS.
  **Files**: `packages/docs/src/pages/design-system.astro`, `packages/docs/src/components/prototype/Topbar.astro`, `packages/docs/src/styles/prototype/tokens.css`, `packages/docs/src/scripts/prototype/theme.js`
  **Acceptance**: Built `/design-system/` matches `design-system.html` and provides a stable visual reference for future styling changes.

- [x] 10. Harden routing, metadata, and base-path support
  **What**: Rewrite prototype links from `.html` files to final routes, ensure every `href`/`src` works under `import.meta.env.BASE_URL`, preserve favicon/title/description metadata, and confirm GitHub Pages deployment still uploads the built docs output.
  **Files**: `packages/docs/astro.config.mjs`, `packages/docs/src/pages/index.astro`, `packages/docs/src/pages/design-system.astro`, `packages/docs/src/components/prototype/Topbar.astro`, `packages/docs/src/components/starlight/Head.astro`, `.github/workflows/deploy-docs.yml`
  **Acceptance**: Local `/` base and `/weave/` base both load CSS, JS, images, fonts, landing links, docs links, and design-system links without 404s.

- [x] 11. Run build and type validation
  **What**: Execute the docs build/typecheck gates and fix any Astro/Starlight errors caused by overrides, MDX raw HTML, asset imports, or base-path handling.
  **Acceptance**: `bun run docs:build`, `bun run --filter '@weave/docs' typecheck`, and `BASE_PATH=/weave/ SITE_URL=https://example.invalid bun run docs:build` all pass.

- [x] 12. Validate exact visual and interaction fidelity
  **What**: Serve the prototype bundle and built docs side by side. Compare `/`, `/docs/`, `/docs/workflows/`, and `/design-system/` against `landing-static.html`, `docs-home.html`, `docs-article.html`, and `design-system.html` at desktop, tablet, and mobile widths. Exercise theme toggle, reveal animations, landing tabs, copy buttons, command palette, keyboard navigation, TOC scrollspy, and responsive states.
  **Acceptance**: Screenshots and manual interaction checks show no visible design differences. If anything looks unlike the prototype, the task remains incomplete.

## Verification
- [ ] `bun run docs:build` passes.
- [ ] `bun run --filter '@weave/docs' typecheck` passes.
- [ ] `BASE_PATH=/weave/ SITE_URL=https://example.invalid bun run docs:build` passes.
- [ ] Browser network panel shows zero 404s for CSS, JS, logo, font, and route assets.
- [ ] Built `/` matches prototype `landing-static.html` at 1440px, 1024px, and mobile widths.
- [ ] Built `/docs/` matches prototype `docs-home.html` at 1440px, 1024px, and mobile widths.
- [ ] Built `/docs/workflows/` matches prototype `docs-article.html` at 1440px, 1024px, and mobile widths.
- [ ] Built `/design-system/` matches prototype `design-system.html` at 1440px, 1024px, and mobile widths.
- [ ] Theme toggle persists `localStorage["weave-theme"]` and updates `html[data-theme]` on all public routes.
- [ ] Landing generated SVGs, reveal transitions, tab interactions, and copy buttons behave like the prototype.
- [ ] Docs command palette opens by click and `⌘/Ctrl+K`, filters results, supports arrow navigation, opens selected routes, and closes on Escape/backdrop.
- [ ] Docs copy buttons and TOC scrollspy behave like the prototype.
- [ ] No default Starlight visual chrome remains visible in the final screenshots.
