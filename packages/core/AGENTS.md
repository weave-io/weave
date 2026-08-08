# `packages/core` — Agent Guide

Core owns the `.weave` language: lexer → parser → AST → Zod validation → typed config. It has no harness knowledge and no I/O.

The canonical syntax contract is [`docs/reference/dsl.md`](../../docs/reference/dsl.md). If code and reference disagree, one of them is a bug — fix both together.

## Changing the language

A DSL change is never a one-file change. Adding, removing, or renaming a keyword, block, or field touches the lexer, parser, AST types, Zod schema, and validator — plus a test at each layer and the reference doc.

Schema changes and their tests land in the same commit, with coverage at all four layers (schema, parser, validator, full pipeline). See [`docs/contributing/testing.md`](../../docs/contributing/testing.md) for the required test-update matrix.

## Types

Other packages extend types from here rather than redefining them. Before adding a type, check whether an existing one can be extended, and check the package's `constants.ts` before adding a constant.
