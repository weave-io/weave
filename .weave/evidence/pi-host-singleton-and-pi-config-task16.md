# Task 16 evidence — remove `pi-cursor` from the local Pi configuration

Plan: `.weave/plans/pi-host-singleton-and-pi-config.md`, Task 16. Refs #21.

- **Date**: 2026-08-17 (America/New_York), 20:13–20:20 EDT (`2026-08-18T00:15Z`–`00:20Z`).
- **Repository**: `/Users/jose/projects/weave`, branch `feat/pi-native-child-stream-rendering`,
  HEAD `bfa4410b9fc2c785e1f7530cff367466d05cf2df`.
- **Pi host**: `0.84.2` at `/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`.
- **Settings file**: `/Users/jose/.pi/agent/settings.json`. `~/.pi/agent` resolves through a symlink
  into `/Users/jose/dotfiles/.pi/agent`, so `readlink -f` reports the dotfiles path. That file is a
  tracked file in the user's dotfiles repository and was **not** committed anywhere by this task.
- **Nature of this task**: local operational only. No repository production, test, or documentation
  file was changed. Only `.weave` evidence, learning, and plan files were committed.

## Claim separation

This report keeps four distinct claims apart, because they are proven by different evidence and
none of them implies another.

| Claim | Status | Proven by |
| --- | --- | --- |
| **Settings entry absent** — no `packages` entry resolves to `/Users/jose/projects/pi-cursor` | true | JSON parse of the settings file, `pi list` |
| **Extension not loaded** — a fresh Pi host loads no `pi-cursor` extension and reports no load error | true | fresh TUI verbose startup inventory, 152 captured lines, zero `pi-cursor` and zero error lines |
| **No mapped checkout path** — the live host maps no file under the `pi-cursor` checkout | true | `lsof -p 1586`, two snapshots, zero matches |
| **Model access retained** — `openai-codex/gpt-5.6-sol` still available | true | `pi --list-models`, `pi auth check`, and a live fresh-host prompt returning `TASK16_MODEL_OK` |

## 1. Backup, taken before any settings operation

```
$ TS=$(date -u +%Y%m%dT%H%M%SZ)
$ cp -p /Users/jose/.pi/agent/settings.json /tmp/pi-settings-task16-$TS.json
```

| Item | Value |
| --- | --- |
| Backup path | `/tmp/pi-settings-task16-20260818T001517Z.json` |
| Backup SHA-256 | `294f62a7abc6ac5039e415aa7b2b3f6b1f4c22077748c1f1e4eb9022c52e900f` |
| Source SHA-256 at backup time | `294f62a7abc6ac5039e415aa7b2b3f6b1f4c22077748c1f1e4eb9022c52e900f` |
| Size | 856 bytes |
| `cmp -s` source vs. backup | byte-identical |

The backup is outside the repository (`/tmp`). It was not committed.

## 2. The `packages` array, before and after

Both lists come from the settings file itself, printed by a bounded helper script kept outside the
repository (`/tmp/weave-task16-remove-pi-cursor.ts`). The script classifies each entry: a `npm:`,
`github:`, `http:`, or `https:` spec can never resolve to a local checkout; any other entry is
resolved to an absolute path (relative entries against `~/.pi/agent`), then through `readlink -f`,
and compared against `/Users/jose/projects/pi-cursor` and its subtree.

**Before** (8 entries):

```
npm:pi-markdown-preview
npm:pi-vim
npm:pi-themes-rose-pine
npm:@ogulcancelik/pi-codex-compaction
npm:pi-intercom
npm:@upstash/context7-pi
npm:pi-clarify
npm:pi-fff
```

**After** (8 entries, same order, no entry removed, no entry added):

```
npm:pi-markdown-preview
npm:pi-vim
npm:pi-themes-rose-pine
npm:@ogulcancelik/pi-codex-compaction
npm:pi-intercom
npm:@upstash/context7-pi
npm:pi-clarify
npm:pi-fff
```

Script result, verbatim fields:

```json
{
  "ok": true,
  "settings": "/Users/jose/.pi/agent/settings.json",
  "target": "/Users/jose/projects/pi-cursor",
  "removed": [],
  "wrote": false,
  "operation": "idempotent-no-op"
}
```

Every entry classified as `matches: false`, and every `npm:` entry has `resolved: null` because a
registry spec is never resolved against the filesystem.

**The removal was an explicit idempotent no-op.** Task 15 already found the exact
`/Users/jose/projects/pi-cursor` entry absent; it was still absent here, so the script performed no
write at all. `shasum -a 256` on the settings file immediately after the script returned the same
`294f62a7…` digest as before, which proves no write occurred rather than a write of identical bytes.

Not done, deliberately: the installed npm copy
`/Users/jose/.pi/agent/npm/node_modules/@rahularya01/pi-cursor` was left in place, and the checkout
`/Users/jose/projects/pi-cursor` was neither modified nor removed. Both were only listed
(`ls -ld`) and read.

## 3. Post-operation verification of the settings file

Independent parse and resolution check (separate process from the removal script):

```
$ bun -e '...JSON.parse(await Bun.file("/Users/jose/.pi/agent/settings.json").text())...'
{
  "parsed": true,
  "count": 8,
  "packages": [ ...the eight npm specs above... ],
  "nonNpmEntries": [],
  "anyResolvingToPiCursor": false
}
```

`nonNpmEntries` is empty, so no entry can resolve to any local path, `pi-cursor` included.

Pi's own view of the configuration:

```
$ pi list
User packages:
  npm:pi-markdown-preview      /Users/jose/.pi/agent/npm/node_modules/pi-markdown-preview
  npm:pi-vim                   /Users/jose/.pi/agent/npm/node_modules/pi-vim
  npm:pi-themes-rose-pine      /Users/jose/.pi/agent/npm/node_modules/pi-themes-rose-pine
  npm:@ogulcancelik/pi-codex-compaction
                               /Users/jose/.pi/agent/npm/node_modules/@ogulcancelik/pi-codex-compaction
  npm:pi-intercom              /Users/jose/.pi/agent/npm/node_modules/pi-intercom
  npm:@upstash/context7-pi     /Users/jose/.pi/agent/npm/node_modules/@upstash/context7-pi
  npm:pi-clarify               /Users/jose/.pi/agent/npm/node_modules/pi-clarify
  npm:pi-fff                   /Users/jose/.pi/agent/npm/node_modules/pi-fff
```

Eight packages, every installed path under `~/.pi/agent/npm/node_modules`, none under the checkout.

Other configuration sources checked for a `pi-cursor` entry:

```
$ grep -rn "pi-cursor" /Users/jose/.pi/agent/settings.json /Users/jose/projects/weave/.pi
no pi-cursor reference in settings/project config
$ ls /Users/jose/projects/weave/.pi        # contains only `insights/`; no project settings.json
```

## 4. Fresh external Pi TUI

A new Herdr tab (`w23:t1F`, pane `w23:pFF`) was created with `--no-focus` and an isolated working
directory `/private/tmp/weave-task16-proof`, so the proof host never touched the Weave project store
and the coordinator pane was never resized or focused away.

```
$ herdr tab create --workspace w23 --cwd /tmp/weave-task16-proof --label task16-proof --no-focus
$ herdr pane run w23:pFF 'pi --verbose --provider openai-codex --model gpt-5.6-sol --no-session'
```

| Item | Value |
| --- | --- |
| Wrapper PID | `1581` |
| **Host PID** | **`1586`** |
| Host argv | `bun .../pi-coding-agent/dist/cli.js --verbose --provider openai-codex --model gpt-5.6-sol --no-session` |
| RSS at measurement | 223 760 KB |
| macOS threads (`ps -M -p 1586 \| tail -n +2 \| wc -l`) | 77 |

77 threads matches Task 15's fixed-configuration range (77–78) and is far from the 96 threads of
that task's duplicate-runtime negative control.

### Startup and extension inventory

`pi --verbose` prints its full resource inventory at startup. 152 lines were captured with
`herdr pane read w23:pFF --source recent-unwrapped --lines 600`.

```
$ grep -in "cursor" <captured startup>
142: Warning: weave overlay action weave.child.sibling.previous skipped key alt+left:
       already bound to tui.editor.cursorWordLeft
144: Warning: weave overlay action weave.child.sibling.next skipped key alt+right:
       already bound to tui.editor.cursorWordRight

$ grep -inE "error|fail|cannot|missing" <captured startup>
(no matches)
```

The only two `cursor` hits are Pi keybinding identifiers (`tui.editor.cursorWordLeft/Right`) in
pre-existing Weave overlay warnings. Neither mentions the `pi-cursor` package, and there is **no
extension load error of any kind** in the startup output.

The `[Extensions]` section, verbatim and complete — this is inventory evidence, not an inference
from the settings file:

```
[Extensions]
  user
    ~/.pi/agent/extensions/afk
    ~/.pi/agent/extensions/bash-audit
    ~/.pi/agent/extensions/context-inspector.ts
    ~/.pi/agent/extensions/context-token-status.ts
    ~/.pi/agent/extensions/fast-mode.ts
    ~/.pi/agent/extensions/force-queued-on-enter.ts
    ~/.pi/agent/extensions/goal
    ~/.pi/agent/extensions/herdr-agent-state.ts
    ~/.pi/agent/extensions/herdr-git-metadata.ts
    ~/.pi/agent/extensions/honcho-memory
    ~/.pi/agent/extensions/insights
    ~/.pi/agent/extensions/learn.ts
    ~/.pi/agent/extensions/message-timestamps
    ~/.pi/agent/extensions/obsidian-note
    ~/.pi/agent/extensions/opencode-anthropic-auth
    ~/.pi/agent/extensions/polished-footer.ts
    ~/.pi/agent/extensions/question.ts
    ~/.pi/agent/extensions/skill-manage.ts
    ~/.pi/agent/extensions/skills-review-model.ts
    ~/.pi/agent/extensions/tavily
    ~/.pi/agent/extensions/weave-adapter-pi/dist/extension.js
    npm:@ogulcancelik/pi-codex-compaction   index.ts
    npm:@upstash/context7-pi                extensions/context7.ts
    npm:pi-clarify                          extensions/clarify.ts
    npm:pi-fff                              index.ts
    npm:pi-intercom                         index.ts
    npm:pi-markdown-preview                 index.ts
    npm:pi-vim                              index.ts
```

28 loaded extensions. No `pi-cursor` entry, in any scope, from any evidence source.

The host reached a working TUI: the status line rendered
`openai-codex/gpt-5.6-sol high · … · ready · /private/tmp/weave-task16-proof` and the Weave badge
`◆ WEAVE · LOOM · Alt+A cycle`.

### `lsof` on the live host

Two snapshots were taken while PID `1586` was alive: one right after startup and one after a
completed model turn (so the second covers everything the process loaded during real work).

```
$ lsof -p 1586 > /tmp/weave-task16-lsof-1586.txt              # 47 lines
$ lsof -p 1586 > /tmp/weave-task16-lsof-post-1586.txt         # 50 lines, post-inference
```

| Query | Startup snapshot | Post-inference snapshot |
| --- | --- | --- |
| `grep -c '/Users/jose/projects/pi-cursor'` | `0` | `0` |
| `grep -ci 'cursor'` | `0` | `0` |
| `grep -c '@earendil-works'` | `0` | `0` |

Distinct mapped `.node` modules, identical in both snapshots:

```
/Users/jose/.bun/install/global/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/extensions/bash-audit/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
/Users/jose/dotfiles/.pi/agent/npm/node_modules/@yuuang/ffi-rs-darwin-arm64/ffi-rs.darwin-arm64.node
```

This is exactly Task 15's fixed-configuration set. The first is the Pi host's own copy, the second
belongs to the `bash-audit` extension (an other-extension copy, explicitly out of scope for this
plan), and the third is `pi-fff`'s FFI module. **Zero mapped path under
`/Users/jose/projects/pi-cursor`, including zero mapped `@earendil-works` path there.**

Why that absence is meaningful rather than vacuous: the checkout does contain the native fingerprint
Task 15 identified. `find /Users/jose/projects/pi-cursor/node_modules -name '*.node'` returns 14
files, including

```
/Users/jose/projects/pi-cursor/node_modules/@earendil-works/pi-coding-agent/node_modules/
  @mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node
```

so a loaded `pi-cursor` carrying its own Pi runtime would have dlopened a clipboard module from
under the checkout and appeared in `lsof`. It did not.

## 5. Model access

The task states the coordinator currently runs `openai-codex/gpt-5.6-sol`. Three independent checks,
none of which printed a credential:

```
$ pi --list-models gpt-5.6-sol
provider      model        context  max-out  thinking  images
openai-codex  gpt-5.6-sol  272K     128K     yes       yes

$ pi auth check --provider openai-codex --json --no-refresh
{"status":"ready","provider":"openai-codex","authType":"oauth"}
```

Live proof in the fresh host (strongest form: the proof TUI itself ran the required model):

```
$ herdr agent prompt w23:pFF 'Reply with exactly this token and nothing else: TASK16_MODEL_OK' --wait
… agent_status: done
```

Pane transcript:

```
 Reply with exactly this token and nothing else: TASK16_MODEL_OK

 TASK16_MODEL_OK
 Aug 17, 2026 at 8:18:18 PM
```

Status line during and after the turn: `openai-codex/gpt-5.6-sol high · … 24k/272k`. So the required
model is listed, authenticated, and answered a real request in a host started after the settings
operation.

`cursor/*` models are **not** available (`pi --list-models cursor` → `No models matching "cursor"`).
That is pre-existing state, not a consequence of this task: `pi-cursor` was already unconfigured
before Task 15 began, and this task wrote nothing to the settings file. The provider used by the
active setup (`openai-codex`) is unaffected.

## 6. Settings drift caused by the proof, and its restoration

Starting the proof TUI with `--provider openai-codex --model gpt-5.6-sol` made Pi **persist those
flags as the user's defaults**. This is Pi behavior, not an effect of the removal step, but it did
change the file, so it is reported and reversed.

```
$ diff -u /tmp/pi-settings-task16-20260818T001517Z.json /Users/jose/.pi/agent/settings.json
-  "defaultProvider": "anthropic",
-  "defaultModel": "claude-opus-5",
+  "defaultProvider": "openai-codex",
+  "defaultModel": "gpt-5.6-sol",
```

Only those two fields differed; `packages` was untouched. The drifted file was snapshotted to
`/tmp/pi-settings-task16-drift-20260818T001943Z.json`, then the pre-task bytes were restored from
the backup:

```
$ cp /tmp/pi-settings-task16-20260818T001517Z.json /Users/jose/.pi/agent/settings.json
$ shasum -a 256 /Users/jose/.pi/agent/settings.json
294f62a7abc6ac5039e415aa7b2b3f6b1f4c22077748c1f1e4eb9022c52e900f
```

The final file is byte-identical to the pre-task state, so the net settings change from Task 16 is
**none**.

`/Users/jose/dotfiles` reports `.pi/agent/settings.json` as modified relative to its own HEAD. That
drift is pre-existing (it includes `lastChangelogVersion 0.80.3 → 0.84.2` and package additions from
long before this task) and was neither introduced nor committed here.

## 7. Shutdown and residual state

```
$ herdr agent send-keys w23:pFF ctrl+c   # twice, in rapid succession
$ ps -o pid,ppid,command -p 1581 1586
  PID  PPID COMMAND
$ ps -eo pid,command | grep -F "gpt-5.6-sol --no-session" | grep -v grep
(no output)
$ lsof -a -d cwd -c bun | grep -c "weave-task16-proof"
0
$ herdr tab close w23:t1F
{"id":"cli:tab:close","result":{"type":"ok"}}
$ herdr tab list --workspace w23 | grep -c "w23:t1F"
0
```

Both proof processes are gone, no process holds the proof working directory, and the tab I created
is closed. The first single `ctrl+c` pair (sent one second apart) did not exit Pi; two presses in
rapid succession did. Both attempts are reported.

Runtime Store, read-only:

```
$ bun packages/cli/src/main.ts runtime status
  DB path:        /Users/jose/projects/weave/.weave/runtime/weave.db
  Schema version: 6
  No active lease.

$ bun packages/cli/src/main.ts runtime preferences
Adapter Preferences (all namespaces, limit: 100, showing: 0)
  No preferences stored.
```

No active lease, and the child-extension preference is still absent — the `inherit-all` default that
Task 15 restored.

## 8. Recorded exception to "stop every running Pi process"

The plan step says to stop every running Pi process before starting the fresh TUI. That is
impossible here and the task forbids it: this coordinator session, the shuttle child executing this
task, and several unrelated user sessions all run inside Pi processes on the same machine. So:

- I started the measurement host as a **fresh external process** in a new Herdr tab, so it loaded
  current configuration and current extension bytes. That is what the acceptance actually needs.
- I found **no stale proof process of my own** to stop: `pgrep` over
  `pi-coding-agent/dist/cli.js` before the run listed only live user sessions and live Weave RPC
  children with live parents, and no leftover from Task 15's PIDs (`58934/58935`, `33182/33187`,
  `86030/86041`, `89363/89364` — none present).
- I terminated **every process I started** (`1581`, `1586`) and closed the only tab I created.
- I touched no other Pi process.

Long-lived unrelated Pi sessions still hold older configuration in memory. That does not weaken the
claims, because every measurement came from the freshly started host.

## 9. Honest limits

- **The removal was a no-op.** Nothing in this task proves the removal *mechanism* works, only that
  the desired end state holds and that the operation is safely idempotent. The script's removal
  branch never executed.
- **`lsof` cannot see a JavaScript-only duplicate.** Pi reads JavaScript and closes the descriptor,
  so no `@earendil-works` JavaScript path is ever mapped, in any run. The absence of a `pi-cursor`
  mapping is strong here only because that checkout ships a native clipboard module that would have
  been mapped. A hypothetical extension with no native dependency would leave no trace.
- **Startup inventory is the load claim's real evidence**, not `lsof`. The two are reported
  separately for that reason.
- **`bash-audit`'s nested Pi runtime is still mapped.** Other-extension copies are out of scope for
  this plan; this task does not claim to have removed them.
- **The model check covers the model this setup needs**, `openai-codex/gpt-5.6-sol`. It does not
  survey every provider the user might want later. `cursor/*` models remain unavailable, unchanged
  by this task.
- **The coordinator's runtime model was not read directly.** `ps -Eww` on the coordinator host
  (PID `3812`) shows no `PI_PROVIDER`/`PI_MODEL` in its environment, because the model is chosen at
  runtime. The task statement supplied the coordinator's current model, and that model was verified
  available and working; the coordinator's own live selection was not inspected.

## 10. Working-tree preservation

Unrelated dirty work owned by another session. Never staged, byte-identical before and after
Task 16:

| Path | SHA-256 (before and after) |
| --- | --- |
| `docs/adapters/pi.md` | `f2ec3341b2d392d1054d357300d3b24b50981518beac7ae44e694caec907aa95` |
| `packages/adapters/pi/src/__tests__/config-activator.test.ts` | `b0f070fb6536bee28d4427faf8eac4cb7c4c0e48e364ca56eb806cc2972a379f` |
| `packages/adapters/pi/src/__tests__/extension.test.ts` | `77b47c77cae613fb480d4b3c70368b12697a94e9b95325b7a1428fb9f9add51e` |
| `packages/adapters/pi/src/config-activator.ts` | `a912a4a252268013d202c7925b11379e27744cfc9599c5e1da034537af97580d` |
| `packages/adapters/pi/src/extension-impl.ts` | `77f1e3b1327366b5aa1ea81ea875b482c4059c65beb9f55264f6ff43bbecb4ff` |
| `packages/adapters/pi/src/safe-initializer.ts` | `c19a22c637bd1370e86881d480f5239c132153e41619469ab3b7eb58268d00fa` |
| `packages/adapters/pi/src/config-activation-diagnostics.ts` (untracked) | `3ed82a95e5e14750a572b429b3183c5a337de292dfcb901064016d5e010bcc8d` |

## 11. Artifacts kept outside the repository

| Path | Contents |
| --- | --- |
| `/tmp/pi-settings-task16-20260818T001517Z.json` | pre-task settings backup, SHA-256 `294f62a7…` |
| `/tmp/pi-settings-task16-drift-20260818T001943Z.json` | settings as Pi rewrote them during the proof, SHA-256 `36e924ac…` |
| `/tmp/weave-task16-remove-pi-cursor.ts` | the bounded idempotent removal helper |
| `/tmp/weave-task16-startup.txt` | 152-line fresh-TUI verbose startup capture |
| `/tmp/weave-task16-lsof-1586.txt` | `lsof` at startup (47 lines) |
| `/tmp/weave-task16-lsof-post-1586.txt` | `lsof` after a completed model turn (50 lines) |

`/tmp` is not durable across reboots. The values that matter are transcribed above.
