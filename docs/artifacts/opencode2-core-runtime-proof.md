# OpenCode 2 Core Runtime Proof

> Non-normative verification record. See [the verification
> guide](../testing/opencode2-verification.md) for the maintained procedure.

Proof date: 2026-09-08

This record describes the pre-merge package layout and beta-19086 host only.
The V2 implementation now ships separately in `@weaveio/weave-adapter-opencode2`;
use the [current verification procedure](../testing/opencode2-verification.md).
The hashes below are historical and do not identify the relocated package.

## Identity

- Weave baseline: `3b1210f17adb2580b3e820acd6fabd3b02b68532`
- Host: `opencode2 v0.0.0-beta-19086`
- Adapter: `@weaveio/weave-adapter-opencode@0.1.2`
- Packed tarball SHA-256:
  `65e53c8bedf0ae9cff9bebcb2af6ecfadbc20880186ee317427755380b600af6`
- Installed `dist/plugin.js` SHA-256:
  `252b3a075d1385e7a3041059d93049f702dfe17ff1f2a157872d061b18b8419d`

The proof installed these bytes under an isolated HOME and XDG root. It used an
ephemeral service port and a local deterministic provider. It did not read,
change, restart, or upgrade the user's shared OpenCode installation.

## Result

`bun scripts/opencode2/verify-runtime.ts` exited zero. All 20 required verdicts
passed.

| Verdict | Result | Bounded observation |
| --- | --- | --- |
| Artifact identity | Pass | Packed and installed SHA-256 digests were recorded. |
| Host identity | Pass | Health reported the exact pinned host. |
| Plugin activation | Pass | The packed package was active in native plugin inventory. |
| Native inventory | Pass | Required agents, model, skill, and reserved command were present. |
| Prompt request | Pass | The request contained the composed role prompt and user marker. |
| Model variant | Pass | The request used the declared model, variant body, and temperature. |
| Skill attachment | Pass | The available configured skill was attached once. |
| Tool policy | Pass | Native delegation remained available while denied edit and shell actions did not. |
| Command and plan RPC | Pass | The reserved command selected one explicit plan and RPC reported task 1. |
| Foreign collision | Pass | A same-ID foreign agent retained its system prompt. |
| Foreground subagent | Pass | The native child used the registered model and returned a result. |
| Background subagent | Pass | The native child used the registered model and returned a result. |
| Valid refresh | Pass | A later request used the second valid source revision. |
| Invalid refresh | Pass | Malformed source retained the last valid catalog. |
| Negative resources | Pass | Missing model, skill, prompt, and plan paths created no placeholder work. |
| Wrong Location | Pass | Read-only RPC rejected mismatched Location input. |
| Denied delegation | Pass | A delegate-denied request did not expose the native subagent action. |
| Concurrent admission | Pass | Parallel requests completed against one valid catalog generation. |
| Interruption | Pass | Public session interruption stopped the in-flight fixture request. |
| Cleanup | Pass | No Weave Runtime Store database was created. |

The fixture kept request bodies in memory and wrote no transcript evidence.
The service and provider stopped, and the temporary proof root was removed.
