# OpenCode 2 Core Contract Audit

> Historical, non-normative verification record for beta-19086. See [the V2 core guide](../adapters/opencode2-core.md) for the current product contract and the [merge proof](opencode2-package-merge-proof.md) for the separate-package verification.

Audit date: 2026-09-08

## Identity

- Weave baseline: `3b1210f17adb2580b3e820acd6fabd3b02b68532`
- `@opencode-ai/plugin`: `0.0.0-beta-19086`, integrity `sha512-/eW8LfB8wiBBR6q3My70t51ZPdmR3MNUguKjunLdoTz4P4rqWG9y0TKbWE2ZB0v5aszWa4vUjYfCYVMP+4bx/g==`
- `@opencode-ai/client`: `0.0.0-beta-19086`, integrity `sha512-TyTrVb8Hb6WjDRHDtVPVKIcKwHsn4HUz09jIFhGt5SYZSYrhoOfI0cgVJlwxbGlsj2dVsE/7kGkH64Zrtki1sA==`
- `@opencode-ai/cli`: `0.0.0-beta-19086`, integrity `sha512-PyEf2WVCHqBTbIuo1hXWshjNxX2cjZJSyNBnUdMmildRtXTkeITw3RwkUCfjBYBSdFTb3CFgO4eqF3RoprmVeg==`
- macOS ARM64 host binary: `@opencode-ai/cli-darwin-arm64@0.0.0-beta-19086`, integrity `sha512-Pdhlr9KFpdTYw9YKsD2ztM6dMG5oi/cR1YiiDxikaUaqdXJnOKSRpHjRulilIYsnqaoOe0SKdORvwKRYik/SvA==`

The audit installed these exact packages under an isolated HOME and XDG root. It did not change the user's global OpenCode installation.

## Baseline checks

The clean baseline passed `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run validate-config`, and `bun run docs:check-links`. The test run reported 5,489 passes, 11 skips, and no failures. Lint also reported 346 existing warnings and 62 existing informational diagnostics.

## Public contract results

| Contract | Result | Evidence |
| --- | --- | --- |
| Plugin setup and cleanup | Pass | `Plugin.define` accepts one setup function. Setup can return cleanup. The isolated host disposed registered transforms when the plugin scope ended. |
| Agent create and replay | Pass | `AgentEditor.get()` checks the current replay state. `update()` creates a default only when absent. Reload replays transforms into fresh state. |
| Foreign agent collision | Pass | A transform can check `editor.get(id)` before `update()`. The isolated proof retained a foreign agent and refreshed an owned agent. |
| Command collision ownership | Requirements decision | `CommandEditor` exposes only `add()`, and replay replaces the same map key. The release reserves `weave:start`; it does not claim coexistence with another command of that name. `/start-work` is not registered. |
| Native child identity | Pass | Native subagent execution creates the child with its agent before the first prompt. The public session lookup exposes that effective child agent. |
| Automatic skill permission check | Requirements decision | Prompt-attached skills bypass the native skill tool's permission assertion in this host. The release attaches configured available skills and documents this limit. |
| Model and role prompt | Pass | `Model.Ref` is `{ providerID, id, variant? }`. A nonempty agent `system` replaces the provider role prompt. |
| Public managed-child creation | Not available | Public `session.create` does not expose `parentID`. Weave uses native subagent execution and does not create a parallel child runtime. |
| Events and CLI slots | Pass | Events are live-only. The pinned TUI exposes sidebar, composer, and prompt-footer slots plus dialogs. It does not expose `session.panel`. |
| Local package-directory entrypoints | Pass | The pinned host resolves physical root `server`, `tui`, and `rpc` files for a local package directory. The adapter ships root wrappers in addition to package subpath exports. |

## Isolated host observation

The exact `opencode2` host reported:

```json
{
  "host": "0.0.0-beta-19086",
  "agentCreateOnUpdate": true,
  "agentReplayRefresh": true,
  "agentCollisionPreserved": true,
  "registrationDisposal": true,
  "commandReplayOverwritesForeign": true,
  "commandReplayPresenceAvailable": false,
  "agentReplays": 3,
  "commandReplays": 2
}
```

This observation proves the registration mechanics only. The packaged runtime and interactive CLI proofs use the procedures in [OpenCode 2 verification](../testing/opencode2-verification.md).

## Sources

- [OpenCode V2 plugin domains](https://opencode.ai/v2/docs/build/plugins/)
- [OpenCode V2 plugin loading](https://opencode.ai/v2/docs/plugins/)
- [OpenCode V2 agents](https://opencode.ai/v2/docs/agents/)
- [OpenCode V2 skills](https://opencode.ai/v2/docs/skills/)
- Published declarations from the exact npm package versions listed above
