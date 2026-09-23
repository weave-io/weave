# Tidy display helpers

## TL;DR
Two small, unrelated display bugs: slugs keep a dash at either end, and prices drop their cents digits.

## Context
- `slugify` in `src/slugify.ts` replaces every run of non-alphanumeric characters with a dash, so `"  Hello, World!  "` becomes `"-hello-world-"`.
- `formatPrice` in `src/price.ts` divides by 100 and prints the number as is, so `1250` becomes `"$12.5"` and `1200` becomes `"$12"`.

## Scope
- In scope: the two fixes below.
- Out of scope: currency other than dollars, Unicode transliteration.

## Tasks

- [ ] 1. Trim leading and trailing dashes in slugify
  - **What**: Make `slugify` return slugs that never start or end with a dash.
  - **Files**: `src/slugify.ts`
  - **Depends on**: None
  - **Acceptance**:
    - `slugify("  Hello, World!  ")` returns `"hello-world"`
    - `slugify("Hello World")` still returns `"hello-world"`

- [ ] 2. Always show two decimal places in formatPrice
  - **What**: Make `formatPrice` always print cents with two digits.
  - **Files**: `src/price.ts`
  - **Depends on**: None
  - **Acceptance**:
    - `formatPrice(1250)` returns `"$12.50"`
    - `formatPrice(1200)` returns `"$12.00"`

## Verification

After all tasks are complete:

```bash
bun test
```
