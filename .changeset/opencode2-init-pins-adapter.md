---
"@weaveio/weave-cli": patch
---

`weave init --harness opencode2` now writes `@weaveio/weave-adapter-opencode2@<version>`, pinned to the adapter version released with the CLI. Before, it wrote the bare package name, so OpenCode 2 installed the npm `latest` dist-tag. That tag is `0.1.0`, which registers no Weave agents on OpenCode 2.0.x. An existing entry is left alone. If your config names the package with no version, or `@0.1.0`, change it to the exact version, for example `@weaveio/weave-adapter-opencode2@0.2.0-next.2`.
