# @weaveio/weave-adapter-opencode

## 0.2.0

First stable release of the new Weave for OpenCode 1, superseding the legacy
`@opencode_weave/weave` plugin. Add
`"plugin": ["@weaveio/weave-adapter-opencode@0.2.0"]` to `opencode.json`;
OpenCode installs it on start, and the builtin agents load with no `.weave`
config. `weave init --harness opencode` writes that entry for you, and
`weave init migrate` converts a legacy `weave-opencode.jsonc`.

Includes everything released on `next` as `0.2.0-next.0` and `0.2.0-next.1`,
plus the builtin model, delegation and prompt changes on `main` since.
Verified on OpenCode 1.18.33.

## 0.1.0

### Minor Changes

- Align all packages to v0.1.0 for initial public release.

### Patch Changes

- 9ae688c: Rename npm scope from `@weave` to `@weaveio` and add publish pipeline
