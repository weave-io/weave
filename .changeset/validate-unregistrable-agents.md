---
"@weaveio/weave-cli": patch
---

`weave validate --project`, `--global` and `--path` now report an agent that harness adapters would leave out: a custom agent with no prompt, or a `prompt_file` that cannot be read, with the path it looked for. Before, only a bare `weave validate` checked this, so a scoped check printed "Weave config is valid" for a config whose agent would never register. The file is checked on top of the builtins, so a block that only changes a builtin's model or permissions still passes.
