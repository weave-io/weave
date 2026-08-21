import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import weaveGrammar from './src/shiki/weave.tmLanguage.js';

const site = process.env.SITE_URL ?? 'http://localhost:4321';
const base = process.env.BASE_PATH ?? '/';
const basePrefix = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
const withBase = (path) => `${basePrefix}${path}`;

export default defineConfig({
  site,
  base,
  // The prototype is the visual source of truth. Astro enables SmartyPants by
  // default, which rewrites `--` → `—` and straight quotes → curly quotes in
  // prose. The ported MDX already uses literal `—` characters wherever an
  // em-dash is intended, while `--adapter` / `--emit` CLI flags and the
  // straight quotes inside `.term` / code-style spans must stay verbatim to
  // match `docs-home.html` and `docs-article.html`. Disabling SmartyPants keeps
  // that content byte-faithful without removing any intended typography.
  markdown: {
    smartypants: false,
    shikiConfig: {
      langs: [weaveGrammar],
      langAlias: {
        weave: 'weave-config',
      },
    },
  },
  redirects: {
    '/docs/getting-started': withBase('/docs/quickstart'),
    '/docs/tutorials/quickstart': withBase('/docs/quickstart'),
    '/docs/explanation/what-is-weave': withBase('/docs/concepts'),
    '/docs/guides/installation': withBase('/docs/quickstart'),
    '/docs/guides/configuration': withBase('/docs/configuration'),
    '/docs/guides/core-concepts': withBase('/docs/concepts'),
  },
  integrations: [
    starlight({
      title: 'Weave',
      description:
        'Harness-agnostic prompt and agent configuration, documented with Astro Starlight.',

      // --- Hard visual override strategy ------------------------------------
      // The prototype is the source of truth for the docs chrome. Rather than
      // theme the default Starlight shell, every chrome component is replaced
      // with prototype-faithful markup (see `src/components/starlight/`). The
      // PageFrame override rebuilds the prototype docs shell
      // (`header.w-topbar` + `div.docs-shell`); the remaining overrides empty
      // or repoint Starlight's default chrome so none of it remains visible.
      //
      // `pagefind: false` disables Starlight's built-in search index and the
      // default search UI; our `Search` override renders the prototype command
      // palette trigger instead (palette behavior ships in a later task).
      pagefind: false,

      // The prototype footer has no "Built with Starlight" credit, no
      // last-updated line, and no Starlight pagination — all replaced by the
      // prototype `.prevnext` / `.feedback` markup in the Footer override.
      credits: false,
      lastUpdated: false,
      pagination: false,

      // Brand metadata. The prototype favicon/logo is the bundled raster logo.
      logo: {
        src: './src/assets/prototype/logo.png',
        alt: 'Weave',
        replacesTitle: true,
      },
      favicon: './src/assets/prototype/logo.png',

      // Prototype design system loaded globally so the overridden chrome and
      // prose inherit the prototype tokens, docs shell, and Starlight bridge.
      // Load order matters: tokens first (defines custom properties), then the
      // bridge (maps Starlight vars → prototype vars), then the docs shell.
      // None of these reference asset URLs, so they are BASE_PATH-safe.
      customCss: [
        './src/styles/prototype/tokens.css',
        './src/styles/prototype/starlight-bridge.css',
        './src/styles/prototype/docs.css',
      ],

      // --- Component overrides (Starlight 0.40 keys) ------------------------
      components: {
        Head: './src/components/starlight/head.astro',
        ThemeProvider: './src/components/starlight/theme-provider.astro',
        PageFrame: './src/components/starlight/page-frame.astro',
        Header: './src/components/starlight/header.astro',
        Sidebar: './src/components/starlight/sidebar.astro',
        MobileMenuToggle: './src/components/starlight/mobile-menu-toggle.astro',
        TwoColumnContent: './src/components/starlight/two-column-content.astro',
        PageSidebar: './src/components/starlight/page-sidebar.astro',
        TableOfContents: './src/components/starlight/table-of-contents.astro',
        ContentPanel: './src/components/starlight/content-panel.astro',
        // Hero override — the docs index (`docs/index.mdx`) sets `hero`
        // frontmatter so Starlight's Page.astro suppresses the auto PageTitle
        // (`.prose h1#_top`) and renders this component instead. It emits the
        // prototype `.home-hero` block (docs-home.html) as the first child of
        // `.docs-main`. Inert on every route that does not set `hero`.
        Hero: './src/components/docs/docs-home-hero.astro',
        PageTitle: './src/components/starlight/page-title.astro',
        MarkdownContent: './src/components/starlight/markdown-content.astro',
        Footer: './src/components/starlight/footer.astro',
        Search: './src/components/starlight/search.astro',
        ThemeSelect: './src/components/starlight/theme-select.astro',
        SocialIcons: './src/components/starlight/social-icons.astro',
        LanguageSelect: './src/components/starlight/language-select.astro',
      },

      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/weave-io/weave',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/weave-io/weave/edit/main/packages/docs/',
      },
      sidebar: [
        {
          label: 'Start',
          items: ['docs', 'docs/quickstart', 'docs/concepts'],
        },
        {
          label: 'Configure',
          items: [
            'docs/configuration',
            'docs/agents-and-categories',
            'docs/prompts-models-policy',
            'docs/workflows',
          ],
        },
        {
          label: 'Adapters',
          items: [
            'docs/reference/adapters',
            'docs/reference/adapters/opencode',
            'docs/reference/adapters/claude-code',
            'docs/reference/adapters/pi',
          ],
        },
        {
          label: 'Operate',
          items: [
            'docs/runtime-inspection',
            'docs/evals',
            'docs/reference/releases',
          ],
        },
        {
          label: 'Reference',
          items: [
            'docs/reference/cli',
            'docs/reference/dsl',
            'docs/reference/packages',
          ],
        },
      ],
    }),
  ],
});
