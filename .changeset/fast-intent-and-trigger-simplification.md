---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
"@weaveio/weave-adapter-pi": minor
---

Declare delegation triggers as plain strings, route categories by description, and declare fast-service intent with `fast true`.

Breaking for 0.1.x configs:

- `triggers` on agents and categories is a list of strings. The object form `{ domain, trigger, routing_hint }` is rejected (`triggers must contain quoted strings`).
- Category `patterns` is removed with no direct replacement and is rejected as an unrecognized key. In 0.1.x every category required `patterns`, so every existing category block needs editing.
- Every category needs a non-blank `description`. Categories route by `description` and `triggers`; Weave performs no file-path routing.
- Delegation targets in prompt templates no longer expose `domains` or trigger objects. Each target's `triggers` is a list of strings, rendered inside the target loop:

  ```md
  {{#delegation.targets}}
  - {{name}}
    {{#triggers}}
    - {{.}}
    {{/triggers}}
  {{/delegation.targets}}
  ```

To upgrade a 0.1.x config: remove `patterns`, add a `description` to each category, and rewrite each trigger as a string. Run `weave validate` from the project root and fix what it reports. Some errors (such as an object trigger) stop validation before later ones are checked, so run it again until it passes.

`weave init migrate` converts legacy `@opencode_weave/weave` JSONC on a best-effort basis. It drops object triggers and `patterns` with a warning and doesn't invent replacements, and it skips a category that has no `description`. Review the warnings, then edit the generated config.

Also:

- Agents and categories accept the optional literal `fast true` as provider-neutral fast-service intent. `fast false` is rejected; omission preserves inherited or harness defaults. Normalized agent descriptors retain the intent. The OpenCode adapters don't apply a provider-specific fast-service override or claim that fast service was requested or supplied.
- The optional `variant` field remains supported.

Bundled-source: @weaveio/weave-core
Bundled-source: @weaveio/weave-config
Bundled-source: @weaveio/weave-engine
