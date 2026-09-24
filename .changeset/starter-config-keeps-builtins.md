---
"@weaveio/weave-cli": patch
---

The starter `config.weave` that `weave init` writes no longer redefines the builtin `loom` and `shuttle` agents. The old starter set a one-line `prompt` and `execute ask`/`network ask` on both. Because project values merge over the builtins, every project initialised with it replaced Loom's full orchestration prompt (about 9,600 characters) with one sentence of 260 characters, and gave Shuttle `ask` permissions that can pause a delegated run on a permission prompt. The starter now shows `prompt_append` and a new-agent example as comments. If you ran `weave init` before, delete the `agent loom { ... }` and `agent shuttle { ... }` blocks from `.weave/config.weave` to get the builtins back.
