---
"@weaveio/weave-cli": minor
---

Make `weave init` produce a setup that runs on every supported harness.

- OpenCode 1: `--harness opencode` now adds the pinned
  `@weaveio/weave-adapter-opencode` entry to the `plugin` array of the
  project's (or global) `opencode.json(c)`, replacing a legacy
  `@opencode_weave/weave` entry. It used to append a comment and write an
  unused `weave-agents.json`, so OpenCode never loaded Weave.
- Claude Code: `--harness claude-code` composes the Claude Code plugin
  (`weave compose --adapter claude-code --init`) instead of failing with
  "installer support is not available yet".
- Detection finds harness binaries again (`Bun.which` replaces a `command -v`
  that Bun Shell does not implement), and tells OpenCode 1 from OpenCode 2 by
  binary and version instead of by their shared config file.
- An explicit `--harness` installs even when detection missed the harness.
  Pi is skipped with "Weave for pi is not published yet" unless named
  explicitly.
- OpenCode 2's installer no longer refuses a config that also has OpenCode 1's
  `plugin` key; both hosts load such a file.
- The starter `config.weave` drops the stale `claude-sonnet-4-5`/`gpt-4o`
  category models (category shuttles now run on Shuttle's models) and the
  `temperature 0.2` some models reject, and the quick-fix workflow's review
  step uses Weft.
- Engine logs go to stderr at `warn` unless `LOG_LEVEL` is set, so
  `weave prompt inspect --json` output parses. `weave --help` lists
  `compose`, `--harness` and `--all-harnesses`.
