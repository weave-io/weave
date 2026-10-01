---
"@weaveio/weave-cli": minor
---

See, fetch, apply and pin model recommendations from the command line
(Spec 39).

- `weave models status` shows the `model_updates` mode and channel, the
  applied list's dates and evidence link, a list waiting to be applied, the
  last check and its error, and every builtin agent's `models` list with
  where each entry came from: your project or global config, the
  recommendations, or the builtins. `--harness opencode2|claude-code|pi`
  picks the harness (OpenCode 2 by default), `--json` prints a document.
- `weave models update` checks tryweave.io now and prints each agent's list
  before and after; `weave models apply` applies a waiting list in `notify`
  mode.
- `weave models pin` writes the applied lists into `~/.weave/config.weave` as
  explicit `models` lines, keeping the rest of the file as it was, after
  showing the diff and asking (`--yes` for scripts).
- `weave validate` reports the mode, the applied list's date, and a pending
  or skipped list with the reason. Its output does not change for configs
  without `settings { model_updates { … } }`.
