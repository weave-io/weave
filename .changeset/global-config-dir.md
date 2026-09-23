---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
---

Let a host point Weave's global config at its own folder with
`WEAVE_GLOBAL_CONFIG_DIR`.

Until now, Weave always read its global layer from `~/.weave`, so anything
that ran Weave for someone else, such as a CI job, a container, or an app like
Weave Fleet that starts OpenCode for the user, picked up whatever personal
config lived in that home directory, or had nowhere of its own to put one.

Set `WEAVE_GLOBAL_CONFIG_DIR` to a folder the host owns and Weave uses it as
the global scope root:

- `<folder>/config.weave` replaces `~/.weave/config.weave` as the global
  layer.
- `prompt_file` and `prompt_append_file` in that config resolve from
  `<folder>/prompts/`.
- The project's `.weave/config.weave` still merges on top, exactly as it does
  over `~/.weave`.
- A folder without `config.weave` disables the global layer, leaving builtins
  plus project config.

Unset, empty, or whitespace-only values keep the default `~/.weave`.
