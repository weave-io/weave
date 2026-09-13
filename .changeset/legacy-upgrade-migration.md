---
"@weaveio/weave-cli": patch
---

Make `weave init migrate` safe for legacy `@opencode_weave/weave` configs.

- Legacy configs with comments and trailing commas now migrate. Legacy Weave accepted both; 0.1.2 failed to parse them.
- A legacy config that cannot be parsed now exits non-zero and writes nothing. Migration never writes the starter template: when every field is skipped, the migrated file holds only header comments and the skipped-field warnings.
- `$schema` is ignored silently. `skill_directories`, `disabled_tools`, `tmux`, and `experimental` get specific skip reasons, and any other unhandled agent, custom agent, or category field is reported instead of dropped silently.
- Custom agent `description` (falling back to `display_name`, as legacy did) is migrated.
- Custom agent `prompt_file` is read relative to the legacy config directory and copied to `.weave/prompts/<agent>.md`. A custom agent left without any prompt is skipped with a warning instead of being emitted for adapters to drop.
- `weave validate` reports agents that harness adapters cannot register, such as an agent without a prompt or with a missing `prompt_file`.
