# Task 15 evidence — real Pi host proof (host singleton and `/weave:pi-config`)

Plan: `.weave/plans/pi-host-singleton-and-pi-config.md`, Task 15. Refs #21.

- **Date**: 2026-08-17 (America/New_York), 19:50–20:07.
- **Repository**: `/Users/jose/projects/weave`, branch `feat/pi-native-child-stream-rendering`,
  HEAD `02db8404d5c4638f3f9d54229aadc02685c0c7ce`.
- **Working tree**: carried the unrelated, uncommitted config-activation work owned by another
  session. Those seven paths were verified byte-identical before and after this task and were never
  staged. See "Working-tree preservation".
- **Pi host**: `0.84.2` at `/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`.
- **Launch path**: `~/.pi/agent/bin/pi` (Bun launcher; sets
  `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` and only there).
- **Adapter load path**: local-development symlink
  `~/.pi/agent/extensions/weave-adapter-pi -> /Users/jose/projects/weave/packages/adapters/pi`.
  No npm provenance artifact was installed; `~/.pi/agent/settings.json` `packages` was not modified.

## Artifact

Built with `bun scripts/build-public-packages.ts` immediately before the proof.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `packages/adapters/pi/dist/extension.js` | 486 | `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` |
| `packages/adapters/pi/dist/extension-impl.js` | 1903627 | `0308179f56bb1541a93c5c9da8d91c3cb47ad508c0f99cfa4ae996cb9d65c259` |

`grep -c "@earendil-works/" packages/adapters/pi/dist/extension.js` → `0`.
`shasum -a 256 ~/.pi/agent/extensions/weave-adapter-pi/dist/extension.js` →
`39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae`, so the bytes the host loaded are
the bytes recorded above. The digest equals Task 14's digest, so the build is reproducible from the
same source bytes.

## Proof tiers, kept separate

### 1. Import / load proof (module identity)

`bun run verify:pi-host-singleton` against the installed host, exit `0`:

```
PASS hostVersion=0.84.2
artifactSha256=39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae
positive=single-copy negative=duplicate-detected
```

This proves module loading in an RPC process only. It is not readiness and not behavior.

### 2. Readiness proof (fresh interactive TUI)

`/weave:health` in the fixed TUI (PID `33187`):

```
Weave adapter mode: ready
...
host runtime: single-copy; redirected 3
child inspection: native-overlay
```

`/weave:status` in the same TUI:

```
generation: df7f96f7-2c34-434d-ba8e-3dc87087549b
trust: trusted
mode: tui
health-only: false
children: 0
```

Readiness is not behavior.

### 3. Behavior proof

`/weave:pi-config` save, child argv, and one settled delegation. See "`/weave:pi-config`" and
"Delegation and child argv".

## Baseline: synthetic negative control (not historical)

The repository already contains the fix, so no genuine pre-fix process or artifact exists. The
baseline is the **designed negative-control mode**: the same bytes started with
`WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1`. It is a synthetic negative control and must never be
described as a historical pre-fix measurement.

Command run in a dedicated terminal pane:

```
WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1 pi
```

### Process facts

| Run | Wrapper PID | Host PID | RSS (KB) | macOS threads | Command used |
| --- | --- | --- | --- | --- | --- |
| Baseline @ 00:46 | 58934 | 58935 | 497648 | 96 | `ps -o pid,ppid,rss,vsz,etime,command -p <pid>` / `ps -M -p <pid>` |
| Baseline @ 02:59 | 58934 | 58935 | 297520 | 96 | same |
| Fixed A @ 00:29 | 33182 | 33187 | 779792 | 78 | same |
| Fixed A @ 02:06 | 33182 | 33187 | 681184 | 78 | same |
| Fixed C @ 00:28 | 89363 | 89364 | 782544 | 78 | same |
| Fixed C @ 01:23 (delegating) | 89363 | 89364 | 724112 | 78 | same |
| Fixed C @ 03:34 (final) | 89363 | 89364 | 703632 | 77 | same |

Thread count is the discriminating measurement: **96 threads with the redirect disabled versus 78
with it enabled**, an 18-thread reduction consistent with a second Pi runtime and its own pool.

**RSS is not a valid discriminator here and is reported without interpretation.** The fixed runs
show *higher* RSS than the baseline. The baseline reading fell from 497 MB to 297 MB inside the same
process without any configuration change, so allocator and GC timing dominate the signal at this
scale. Do not read the RSS column as evidence for or against the fix.

### Mapped `@earendil-works`-attributable files (`lsof -p <pid>`)

`lsof` shows no `@earendil-works` JavaScript path in any run: Pi reads JS and closes the descriptor.
The observable OS fingerprint of an evaluated Pi runtime copy is the native module that
`@earendil-works/pi-coding-agent` dlopens through its direct dependency `@mariozechner/clipboard@0.3.9`
(declared at `package.json:68` in the checkout copy and `package.json:76` in the host copy).

Baseline (PID 58935), distinct mapped `.node` files:

```
/Users/jose/.bun/install/global/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/extensions/bash-audit/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/npm/node_modules/@yuuang/ffi-rs-darwin-arm64/ffi-rs.darwin-arm64.node
/Users/jose/projects/weave/node_modules/.bun/@mariozechner+clipboard-darwin-universal@0.3.9/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
```

Fixed (PIDs 33187 and 89364), distinct mapped `.node` files:

```
/Users/jose/.bun/install/global/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/extensions/bash-audit/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/npm/node_modules/@yuuang/ffi-rs-darwin-arm64/ffi-rs.darwin-arm64.node
```

`grep -o '/Users/jose/projects/weave/node_modules[^ ]*'` over the fixed `lsof` output returns
nothing, in every fixed run.

### Copy attribution

| Copy | Owner | Baseline | Fixed | In scope for this plan |
| --- | --- | --- | --- | --- |
| `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent` (0.84.2) | Pi host | mapped | mapped | yes — the one copy Weave must use |
| `/Users/jose/projects/weave/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1/...` | Weave checkout, loaded through the adapter | **mapped** | **not mapped** | yes — the defect |
| `/Users/jose/.pi/agent/extensions/bash-audit/node_modules/@earendil-works/pi-coding-agent` (0.84.2) | `bash-audit` extension | mapped | mapped | no — other-extension copy, explicitly out of scope |
| `/Users/jose/.pi/agent/extensions/afk/node_modules/@earendil-works/pi-coding-agent` (0.82.0) | `afk` extension | not observable | not observable | no — other-extension copy |
| `/Users/jose/projects/pi-cursor/node_modules/@earendil-works` | `pi-cursor` checkout | absent | absent | no — Task 16 |

**Conclusion.** After the redirect, exactly one `@earendil-works/pi-coding-agent` copy is
attributable to the host/Weave: the host copy. `/weave:health` reports `redirected 3`, meaning all
three Pi specifiers resolved to the proven host root, and the checkout copy's native fingerprint
disappears from the process.

Honest limits of the OS evidence:

- `lsof` can only reveal a runtime copy that dlopens a native module. A JavaScript-only duplicate
  leaves no mapping, so `afk`'s nested `0.82.0` copy is neither proven present nor proven absent.
- The `bash-audit` copy is present identically in baseline and fixed. The plan places
  other-extension copies out of scope, and this measurement does not claim to remove them.

### `pi-cursor` status

The acceptance assumed `pi-cursor` would be configured during both measurements. It was **already
absent from `~/.pi/agent/settings.json` `packages`** before this task started, so it loaded in
neither run and contributed no copy to either measurement.

- I did not remove it, and I made no change to `~/.pi/agent/settings.json`.
- `@rahularya01/pi-cursor` remains installed under `~/.pi/agent/npm/node_modules`, and the checkout
  `/Users/jose/projects/pi-cursor` is untouched.
- `grep -c pi-cursor` over the fixed `lsof` output → `0`.
- Task 16 still owns any `pi-cursor` operation. Its settings-entry removal step is already satisfied
  by the pre-existing state; its remaining verification steps are unaffected.

### Why the baseline health line still says `single-copy`

In negative-control mode the loader returns early
(`runResolveHostModules` → `skipAllOutcome({ reason: "redirect-disabled" })`) with no `hostVersion`,
so `renderHostRuntimeHealthLine` has no proven version to compare against and falls back to the
imported `VERSION`. The baseline therefore printed:

```
Weave adapter mode: ready
host runtime: single-copy; redirected 0
```

That line is **not** a duplicate detector while the redirect is disabled. It is honest only in the
fixed configuration, where `redirected 3` and the proven host version agree. The duplicate itself is
proven by the OS mapping and the thread count, and by `verify:pi-host-singleton`'s own negative
control (`negative=duplicate-detected`), which reaches the detector through a different path.

## `/weave:pi-config`

Opened in the fixed TUI (PID `33187`). Header, pinned mandatory row, and footer as rendered:

```
Weave child extensions — inheriting all 27 optional
Children load only the selected extensions plus Weave.
Unselected provider extensions supply no models or credentials to children.
Changes apply to children spawned after this session's next start, never to r...

  ◆ Weave adapter — always enabled  mandatory
› (•) Inherit all extensions (default)
  [ ] @ogulcancelik/pi-codex-compaction  user · inherited
  ...
up/down move · space toggle · a all · n none · enter save · escape cancel
```

The third notice line is truncated by the overlay width. Its full text is
`Changes apply to children spawned after this session's next start, never to running children.`
(`packages/adapters/pi/src/pi-config-ui.ts:565`).

The Weave row is pinned first, tagged `mandatory`, and carries no checkbox affordance.

### Save 1 — explicit, Weave only

`n` (select none) → header became `Weave child extensions — 0 of 27 optional selected` and
`( ) Inherit all extensions (default)`. `enter` produced the notice:

```
Weave children will load 0 selected extensions plus Weave. This applies to children spawned after
this session's next start, never to running children.
```

Stored record (`weave runtime preferences`):

```
adapter-pi  child-extensions  2026-08-17T23:57:49.434Z  {"schemaVersion":1,"mode":"explicit","entries":[]}
```

### Save 2 — explicit, all 27 optional

`a` (select all) → `Weave child extensions — 27 of 27 optional selected`. `enter` produced:

```
Weave children will load 27 selected extensions plus Weave. This applies to children spawned after
this session's next start, never to running children.
```

Stored record at `2026-08-18T00:02:24.722Z`: `mode explicit`, `entries 27`. The mandatory Weave entry
is **not** stored; it is derived at resolve time, matching the design.

## Delegation and child argv

The task text asked for `shuttle-mini`. That agent does not exist in the active configuration: the
`mini` category is commented out in `~/.weave/config.weave`, and the primary agent reported
`Available target: shuttle`. I did not modify the user's Weave configuration to create it. The
delegation therefore used **`shuttle`**, the available deterministic target. Recorded as a deviation.

### Run B — explicit selection with zero optional extensions (host PID 86041)

Live child argv, captured by polling `ps -o args= -p <pid>` for new children of the host process:

```
bun /Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --mode rpc \
  --no-extensions \
  -e /Users/jose/.pi/agent/extensions/weave-adapter-pi/dist/extension.js \
  --session-dir /Users/jose/dotfiles/.local/share/weave/adapters/pi/sessions/3ae1d44f-... \
  --session .../2026-08-18T00-00-37-870Z_01a0122b-....jsonl
```

`--no-extensions` first, then exactly the mandatory Weave absolute path, then session flags. No
optional `-e` entry, matching the saved selection.

That delegation **failed**:

```
{"ok":true,"settlement":{"outcome":"failed","reason":"assistant error · provider error · HTTP 400 · Provider request failed."}}
```

This is the documented provider-extension caveat behaving exactly as the TUI copy warns. The
`shuttle` agent uses `anthropic/claude-opus-5`, whose credentials come from the
`opencode-anthropic-auth` extension. A Weave-only child does not load it, so the child had no usable
credential. Weave settled the child cleanly and reported the typed failure; no process leaked.

### Run C — explicit selection with all 27 optional extensions (host PID 89364)

Live child argv (`ps -o args= -p 4617`, exit `0`; wrapped for readability, single line in reality):

```
bun /Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
  --mode rpc
  --no-extensions
  -e /Users/jose/.pi/agent/extensions/weave-adapter-pi/dist/extension.js
  -e /Users/jose/.pi/agent/npm/node_modules/@ogulcancelik/pi-codex-compaction
  -e /Users/jose/.pi/agent/npm/node_modules/@upstash/context7-pi
  -e /Users/jose/.pi/agent/extensions/context-inspector.ts
  -e /Users/jose/.pi/agent/extensions/context-token-status.ts
  -e /Users/jose/.pi/agent/extensions/fast-mode.ts
  -e /Users/jose/.pi/agent/extensions/force-queued-on-enter.ts
  -e /Users/jose/.pi/agent/extensions/herdr-agent-state.ts
  -e /Users/jose/.pi/agent/extensions/herdr-git-metadata.ts
  -e /Users/jose/.pi/agent/extensions/afk/index.ts
  -e /Users/jose/.pi/agent/extensions/bash-audit/index.ts
  -e /Users/jose/.pi/agent/extensions/goal/index.ts
  -e /Users/jose/.pi/agent/extensions/honcho-memory/index.ts
  -e /Users/jose/.pi/agent/extensions/insights/index.ts
  -e /Users/jose/.pi/agent/extensions/message-timestamps/index.ts
  -e /Users/jose/.pi/agent/extensions/obsidian-note/index.ts
  -e /Users/jose/.pi/agent/extensions/opencode-anthropic-auth/index.ts
  -e /Users/jose/.pi/agent/extensions/tavily/index.ts
  -e /Users/jose/.pi/agent/extensions/learn.ts
  -e /Users/jose/.pi/agent/npm/node_modules/pi-clarify
  -e /Users/jose/.pi/agent/npm/node_modules/pi-fff
  -e /Users/jose/.pi/agent/npm/node_modules/pi-intercom
  -e /Users/jose/.pi/agent/npm/node_modules/pi-markdown-preview
  -e /Users/jose/.pi/agent/npm/node_modules/pi-vim
  -e /Users/jose/.pi/agent/extensions/polished-footer.ts
  -e /Users/jose/.pi/agent/extensions/question.ts
  -e /Users/jose/.pi/agent/extensions/skill-manage.ts
  -e /Users/jose/.pi/agent/extensions/skills-review-model.ts
  --session-dir /Users/jose/dotfiles/.local/share/weave/adapters/pi/sessions/f0dd29a8-...
  --session .../2026-08-18T00-03-20-040Z_01a0122e-....jsonl
```

Order proof: `--no-extensions`, then the mandatory Weave absolute path **first**, then only the
selected optional extensions in stored order, then Pi's session flags. No `-e npm:<pkg>` form
appears; every path is absolute.

Settlement, verbatim from the parent transcript:

```
{"ok":true,"settlement":{"outcome":"completed","finalOutput":"## Task intake ... Exact stdout observed:
TASK15_ARGV_PROOF_OK
TASK15_DONE
...","interventionCount":0}}
```

Overlay card: `COMPLETED · shuttle · run 1 · settled · 1m 10s · 40.7k tok`. The child's 60-second
sleep kept it alive long enough to read live argv with `ps`.

## Restoration and clean shutdown

- Reopened `/weave:pi-config`, selected `Inherit all extensions (default)` with `space`, saved with
  `enter`. Notice: `Weave children will inherit every Pi extension again. This applies to children
  spawned after this session's next start, never to running children.`
- Stored state verified read-only afterwards:

```
$ bun packages/cli/src/main.ts runtime preferences
Adapter Preferences (all namespaces, limit: 100, showing: 0)
  No preferences stored.

$ select namespace,key,value_json,updated_at from adapter_preferences   → []
```

  This equals the pre-proof state: before Task 15 the same query reported `No preferences stored`,
  which the adapter treats as `inherit-all`.

- Every Pi process I launched was terminated with `ctrl+q`; `ps -p <pid>` afterwards returned no
  rows for `58934/58935`, `33182/33187`, `86030/86041`, `89363/89364`.
- No residual proof child: `ps -eo pid,ppid,command | grep -E "f0dd29a8-...|3ae1d44f-..."` → no match.
- Remaining `--mode rpc` Pi processes on the machine all belong to other live user sessions with
  live parents; none descend from a proof host.
- `weave runtime status` → `No active lease.` (schema version 6).
- The temporary terminal pane created for the proof was closed and the pane layout was restored.

### Recorded exception to "restart every Pi process"

The plan says to stop every Pi process before the fresh TUI. That is not possible here: this
coordinator session and several unrelated user sessions run inside Pi processes on the same machine,
and the task forbids disrupting the coordinator or its ancestors. I therefore:

- started each proof TUI as a **fresh external process**, so it loaded the current extension bytes;
- stopped every process I started, and no other;
- found no stale proof or leftover verification process to clean up before starting;
- left all unrelated Pi sessions untouched.

Unrelated long-lived Pi sessions still hold older extension code in memory. That does not weaken the
proof, because each measurement was taken from a freshly started process.

## Working-tree preservation

These paths were unrelated dirty work owned by another session. They were never staged and are
byte-identical before and after Task 15:

| Path | SHA-256 (before and after) |
| --- | --- |
| `docs/adapters/pi.md` | `f2ec3341b2d392d1054d357300d3b24b50981518beac7ae44e694caec907aa95` |
| `packages/adapters/pi/src/__tests__/config-activator.test.ts` | `b0f070fb6536bee28d4427faf8eac4cb7c4c0e48e364ca56eb806cc2972a379f` |
| `packages/adapters/pi/src/__tests__/extension.test.ts` | `77b47c77cae613fb480d4b3c70368b12697a94e9b95325b7a1428fb9f9add51e` |
| `packages/adapters/pi/src/config-activator.ts` | `a912a4a252268013d202c7925b11379e27744cfc9599c5e1da034537af97580d` |
| `packages/adapters/pi/src/extension-impl.ts` | `77f1e3b1327366b5aa1ea81ea875b482c4059c65beb9f55264f6ff43bbecb4ff` |
| `packages/adapters/pi/src/safe-initializer.ts` | `c19a22c637bd1370e86881d480f5239c132153e41619469ab3b7eb58268d00fa` |
| `packages/adapters/pi/src/config-activation-diagnostics.ts` (untracked) | `3ed82a95e5e14750a572b429b3183c5a337de292dfcb901064016d5e010bcc8d` |

## Deviations from the task wording

1. **Baseline is a synthetic negative control**, not a historical pre-fix process. Labeled as such
   throughout.
2. **`pi-cursor` was already unconfigured** before the task began. It was neither removed nor
   re-added, so no `pi-cursor`-owned copy exists in either measurement.
3. **`shuttle-mini` does not exist** in the active configuration; the delegation used `shuttle`. The
   user's Weave configuration was not modified to create the agent.
4. **Two explicit selections were saved**, not one. The Weave-only selection satisfied the letter of
   the acceptance but produced a failed child (no credential extension). The all-27 selection was
   then saved to obtain a successful delegation and a stronger argv ordering proof.
5. **`ps -M` was used for thread counts** (`ps -M -p <pid>` minus the header row), as permitted.
6. **RSS is reported without interpretation** because it did not discriminate; thread count and
   mapped native modules did.
