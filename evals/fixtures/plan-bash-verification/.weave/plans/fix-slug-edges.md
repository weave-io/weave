# Fix slug edge dashes

## TL;DR
Slugs built from titles with leading or trailing punctuation or spaces keep a dash at either end. Trim them.

## Context
`slugify` in `src/slugify.ts` lowercases the input and replaces every run of non-alphanumeric characters with a dash, so `"  Hello, World!  "` becomes `"-hello-world-"`.

## Scope
- In scope: trimming leading and trailing dashes in `slugify`.
- Out of scope: Unicode transliteration.

## Tasks

- [ ] 1. Trim leading and trailing dashes in slugify
  - **What**: Make `slugify` return slugs that never start or end with a dash.
  - **Files**: `src/slugify.ts`
  - **Depends on**: None
  - **Acceptance**:
    - `slugify("  Hello, World!  ")` returns `"hello-world"`
    - Existing slugify behaviour is unchanged

## Verification

After all tasks are complete:

```bash
bun run check
```
