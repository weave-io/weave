# Learnings: Public Docs Prototype Replica

## Task 4: Configure Starlight for hard visual overrides
- **Discrepancy**: The plan's validation and base-path examples assumed the public docs might be served under `/weave/` on GitHub Pages.
- **Resolution**: User clarified that `/weave` should not be part of the public path. Continue implementing links and assets through `import.meta.env.BASE_URL`, but treat the intended public route shape as root-relative `/`, `/docs/`, and `/design-system/` with no `/weave` prefix in the final experience.
- **Suggestion**: Update future plan assumptions and validation examples to describe root-path deployment explicitly instead of using `/weave/` as the example base path.

## Task 12: Validate exact visual and interaction fidelity
- **Discrepancy**: The plan treated final fidelity validation as a verification-only step, but side-by-side browser comparison exposed several remaining implementation mismatches that required code changes (SmartyPants typography mutation, article title order, palette markup/CSS shape, missing TOC metadata rows, and docs-home/article spacing drift).
- **Resolution**: Applied targeted fixes during the validation pass across `astro.config.mjs`, Starlight overrides, docs content/schema, and prototype CSS, then re-ran build/type checks and browser-level comparisons until the remaining differences were sub-perceptual only.
- **Suggestion**: Split future plans into separate tasks for “browser compare and defect capture” and “apply fidelity fixes from comparison” so the final validation task does not implicitly contain implementation work.
