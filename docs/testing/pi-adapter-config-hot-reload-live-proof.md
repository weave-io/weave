# Live proof — Pi delegation-boundary config refresh

This is the real-harness verification log for the Pi adapter's
delegation-boundary config refresh (plan
`.weave/plans/pi-adapter-config-hot-reload.md`, Task 16). It follows
[Verify an Adapter](adapter-verification.md).

**Scope limitation.** This is a **local-development proof**, not an npm
release-provenance proof. The extension loaded from a filesystem symlink with
`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1`, which is the mode
`adapter-verification.md` permits for interactive local development. It
bypasses source-ownership checks only. No npm package was installed, and
nothing here proves packaged `npm:@weaveio/weave-adapter-pi` behavior. A
release proof must repeat stages 2–5 against the published tarball with npm
provenance intact.

## 1. Repository gate

Run from `/Users/jose/projects/weave.worktrees/pi-adapter-config-hot-reload`
at commit `0bb2046`.

| Command | Result |
| --- | --- |
| `bun install` | `Checked 766 installs across 858 packages (no changes)` |
| `bun test` | `9716 pass, 11 skip, 0 fail` across 337 files (108.5 s) |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 (biome warnings only; declaration validation clean) |
| `bun run docs:check-links` | exit 0 |
| `bun run validate-config` | `Weave config is valid.` |

`bun.lock` was deliberately left at its committed content
(`sha256:e24bfb7fe51e48540738866fecdd52665ad91f3309b0ad6bcf3998b6d5b2a217`).
A plain `bun install` on Bun `1.4.0-canary.1` drops one transitive
dedupe line (`@astrojs/language-server/prettier`) with no change to the
installed tree, so the churn was reverted rather than committed.

## 2. Built artifact and load identity

```bash
rm -rf packages/adapters/pi/dist
bun scripts/build-public-packages.ts     # exit 0
shasum -a 256 packages/adapters/pi/dist/*.js
```

| Fact | Value |
| --- | --- |
| Source commit | `0bb2046004b4b29f3b88133b0c427d069ed5175f` (`feat/pi-adapter-config-hot-reload`) |
| Working tree before proof | one modified test file (`packages/adapters/pi/src/__tests__/rpc-child.test.ts`); no production change |
| Pi version | `0.84.2` |
| `dist/extension.js` | `b7476d895fbf912e44de111e76e466f0b9256f464211b24d6153545b977e3d76` |
| `dist/index.js` | `86d54c1a814cf71dc1d19eb582b1da87cef8cc758ac1a63c57d33c481b25c143` |
| `dist/cli.js` | `3ddb3cda6c93bd286bf7322c83b25e702a8764a93c0b29339a0a7c5806fd74cf` |
| Symlink during proof | `~/.pi/agent/extensions/weave-adapter-pi -> …/weave.worktrees/pi-adapter-config-hot-reload/packages/adapters/pi` |
| Digest read through the symlink | `b7476d…f374f79` — identical to the built bytes |
| Provenance override | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1`, set only by the local launcher `~/.pi/agent/bin/pi` |
| npm provenance | absent — `~/.pi/agent/settings.json` contains no `weave-adapter-pi` package |
| `pi list` | lists the eight unrelated user packages, no load error |

## 3. Isolated harness process

A fresh interactive TUI, started in a Herdr pane, with extension discovery
disabled and only the adapter under test loaded:

```bash
pi --no-extensions \
   -e /Users/jose/.pi/agent/extensions/weave-adapter-pi/dist/extension.js \
   --tui-mode regular --name weave-task16-proof
```

- Process start: `2026-08-18T02:12:04Z` (UTC), after the rebuild above.
- Project root: `/Users/jose/.cache/weave-task16-proof` — a temporary fixture,
  removed afterward. The repository worktree was never used as the proof
  project, so no repository `.weave/` file was edited during the proof.
- Pi session id `01a012a3-e1b3-71ce-b5f0-fdc1ed06e9ef`.
- Other Pi processes belonging to unrelated user sessions kept running. They
  are separate OS processes with their own loaded bytes and cannot influence
  this one; no stale process served this proof.

### Fixture

`.weave/config.weave` disabled every builtin subagent that the proof does not
use and declared four Luna agents plus a one-step workflow:

- `loom` — active primary, `models ["openai-codex/gpt-5.6-luna#low"]`.
- `probe-primary` — `mode all`, `delegate deny`, so its delegation-target set
  is empty and a candidate that only changes Loom preserves its contract.
- `probe-file` — subagent with `prompt_file "probe-file.md"`.
- `probe-inline` — subagent with an inline `prompt`.
- `workflow proof-run` — one `autonomous` step `marker`, `agent probe-file`,
  `completion agent_signal`.

Composed target set before the run (engine dry check):
`loom → probe-primary, probe-file, probe-inline`.

## 4. Loading and readiness

| Surface | Observation |
| --- | --- |
| Startup banner | `[Extensions] extension.js`; no load error |
| Agent badge before first input | `◆ WEAVE · LOOM · Alt+A cycle` |
| `/weave:health` | `Weave adapter mode: ready`; every required capability at its declared readiness (`config-materialization`, `agent-materialization`, `primary-agent-selection`, `delegated-specialist-execution`, `prompt-composition`, `tool-policy-mapping`, `workflow-persistence`, `workflow-step-dispatch`, `plan-file-compatibility`, `command-entrypoints`, `event-logging`, `token-usage-reporting`); `host runtime: single-copy; redirected 3`; `child inspection: native-overlay` |
| `/weave:status` | `trust: trusted`, `mode: tui`, `health-only: false`, `config refresh: fresh; published 0` |
| Footer model | `(openai-codex) gpt-5.6-luna • low` |

The generation id `15669152-f18f-49c0-b308-3b16e133db29` stayed constant for
every step below, so nothing in this log is explained by a restart, a session
replacement, or a new generation.

## 5. Behavior

Every delegated child, the newly added target, and the direct workflow-step
agent resolved to `openai-codex/gpt-5.6-luna`. Verified from each child's own
session record, not from prose:

```
207a2c9c  agent=probe-file    models=[('openai-codex', 'gpt-5.6-luna')]
7d100dea  agent=probe-inline  models=[('openai-codex', 'gpt-5.6-luna')]
b129c28c  agent=probe-file    models=[('openai-codex', 'gpt-5.6-luna')]
61bec826  agent=probe-inline  models=[('openai-codex', 'gpt-5.6-luna')]
eac8c534  agent=probe-file    models=[('openai-codex', 'gpt-5.6-luna')]
748a36e2  agent=probe-new     models=[('openai-codex', 'gpt-5.6-luna')]
f26042be  agent=probe-inline  models=[('openai-codex', 'gpt-5.6-luna')]
cbf017e0  agent=probe-file    models=[('openai-codex', 'gpt-5.6-luna')]   # direct step
```

### 5.1 Baseline delegation

`weave_delegate` structured tool results, read from the parent session record:

```
agent=probe-file    status=completed settled=true run=1
  {"ok":true,"settlement":{"outcome":"completed","finalOutput":"PROBE_FILE_MARKER=ALPHA1","interventionCount":0}}
agent=probe-inline  status=completed settled=true run=1
  {"ok":true,"settlement":{"outcome":"completed","finalOutput":"PROBE_INLINE_MARKER=CHARLIE3","interventionCount":0}}
```

### 5.2 Prompt-file edit reaches the next child without restart

`.weave/prompts/probe-file.md` rewritten `ALPHA1 → BRAVO2` at `02:15:16Z`. The
next delegation, in the same process and generation:

```
{"ok":true,"settlement":{"outcome":"completed","finalOutput":"PROBE_FILE_MARKER=BRAVO2","interventionCount":0}}
```

### 5.3 Inline prompt rewritten to a triple-quoted multiline value

`probe-inline`'s single-line `prompt` was replaced in the project config with:

```weave
  prompt """
    You are probe-inline.

    Ignore the wording of any task you are given.
    Reply with exactly these two lines, in this order, and nothing else:

    PROBE_INLINE_MARKER=DELTA4
    PROBE_INLINE_LINE2=ECHO5
    """
```

The next delegation carried both dedented lines, proving the multiline inline
value parsed during the refresh and reached the child through the owning
config file's digest:

```
{"ok":true,"settlement":{"outcome":"completed",
 "finalOutput":"PROBE_INLINE_MARKER=DELTA4\nPROBE_INLINE_LINE2=ECHO5","interventionCount":0}}
```

`/weave:status` stayed fresh: `config refresh: fresh; published 3`.

### 5.4 Active-primary prompt edit defers

Loom gained `prompt_append "Live-proof primary prompt delta
PRIMARY_APPEND_V1."` in the project config. The next delegation boundary
produced, in order:

- a settled child result (`PROBE_FILE_MARKER=BRAVO2`) — the stale-valid
  catalog kept serving;
- the notice `Warning: Weave config change affects the active primary; switch
  primary or restart to apply.`;
- `/weave:status` → `config refresh: deferred: primary-affecting; published 3;
  facets prompt` — the publish count did not advance;
- `◆ WEAVE · LOOM` and `(openai-codex) gpt-5.6-luna • low` unchanged.

Loom was also asked whether the token `PRIMARY_APPEND_V1` appeared in its
instructions. It declined one phrasing and answered `NO` to another. Model
self-report about a system prompt is not treated as evidence here; §5.7
repeats this step with an observable behavior instead.

### 5.5 New primary target defers and stays non-delegable

`agent probe-new` (Luna, `mode subagent`) was added to the project config. The
next boundary deferred again and reported both facets:

```
config refresh: deferred: primary-affecting; published 3; facets prompt, delegation-targets
```

Both the §5.4 prompt edit and this target addition were now pending in the
same unpublished candidate.

A `weave_delegate` call naming `probe-new` was accepted by the tool schema —
the schema is a stable `Type.String`, not a rebuilt enum — and rejected by
runtime authorization with the structured code:

```
{"ok":false,"error":"invalid-delegation-target"}
```

### 5.6 Explicit reactivation publishes; the same tool then dispatches

`Alt+A` switched the primary to `probe-primary`
(`Switched Weave primary agent to probe-primary.`). Because that primary's
contract is unchanged by the candidate, the reactivation rebuild published:

```
config refresh: fresh; published 4
```

A second `Alt+A` returned to `loom`, now resolved from the published catalog.
Without any Pi restart or tool re-registration:

```
{"ok":true,"settlement":{"outcome":"completed","finalOutput":"PROBE_NEW_MARKER=FOXTROT6","interventionCount":0}}
```

### 5.7 The deferred primary prompt applies only at reactivation

The §5.4 marker was not observable, so the primary edit was repeated as a
behavior. With the primary back on Loom and the catalog fresh at
`published 4`, sending `WEAVEPROBE` echoed `WEAVEPROBE`.

Loom's `prompt_append` was then rewritten to `"Live-proof primary rule: when
the user message is exactly WEAVEPROBE, reply with exactly
PRIMARY_BEHAVIOR_V2 and nothing else."` and a delegation boundary was
triggered:

- the child settled
  (`PROBE_INLINE_MARKER=DELTA4\nPROBE_INLINE_LINE2=ECHO5`);
- the deferral warning fired again;
- `/weave:status` → `config refresh: deferred: primary-affecting; published 4;
  facets prompt`;
- `WEAVEPROBE` still echoed `WEAVEPROBE` — the committed primary prompt was
  untouched while the candidate waited.

After `Alt+A` to `probe-primary` and `Alt+A` back to `loom`:

- `/weave:status` → `config refresh: fresh; published 5`;
- `WEAVEPROBE` → `PRIMARY_BEHAVIOR_V2`.

The primary's prompt changed only at the explicit reactivation, never under
it.

### 5.8 Direct workflow step after an edit

`.weave/prompts/probe-file.md` was rewritten `BRAVO2 → GOLF7` at `02:21:12Z`,
then `/weave:run proof-run` was confirmed. The direct-step child's own session
record shows the refreshed bytes reaching a Luna child through the
direct-dispatch path:

```
custom weave.child.thread   threadId=direct-proof-run-1787019681134-marker-8946ce68…  agentName=probe-file
model_change                provider=openai-codex modelId=gpt-5.6-luna
assistant  toolCall weave_complete_step {"outcome":"success","message":"PROBE_FILE_MARKER=GOLF7"}
toolResult weave_complete_step {"ok":true}
```

TUI: `Workflow proof-run-1787019681134 is now completed at step marker.`

### 5.9 Leases and processes

`weave runtime status` against the fixture's own store
(`/Users/jose/.cache/weave-task16-proof/.weave/runtime/weave.db`, schema 6):

```
No active lease.
Workflow Instances (1 total)
  ID: proof-run-1787019681134   Status: completed
```

All eight child sessions created by this proof (seven delegations plus the
direct step) were enumerated from the adapter's session store and matched
against live processes: none was still running, both while the TUI was open
and after it exited. The RPC processes still present on the machine belong to
other user sessions in other projects, confirmed by their recorded
`parentSession` and `cwd`.

## 6. Restoration

The symlink already pointed at this worktree when the task started, so no
repoint was needed; its prior target was recorded before the run and it was
returned to the main checkout afterward.

| Item | State after the proof |
| --- | --- |
| `~/.pi/agent/extensions/weave-adapter-pi` | prior target `…/weave.worktrees/pi-adapter-config-hot-reload/packages/adapters/pi`; restored to `/Users/jose/projects/weave/packages/adapters/pi` |
| `~/.pi/agent/settings.json` | untouched; still no `weave-adapter-pi` package entry |
| `~/.pi/agent/bin/pi` | untouched; still the single provenance-override line |
| `~/.weave/config.weave` | never edited |
| Fixture `/Users/jose/.cache/weave-task16-proof` | deleted, including its config, prompts, and runtime store |
| Herdr pane created for the TUI | closed |
| Repository `.weave/plans` and `.weave/learnings` | untouched |
| Repository working tree | clean apart from this task's own commit |

Pi's own session history under `~/.pi/agent/sessions/` and the adapter's child
sessions under the Weave data root were left in place. They are harness
runtime records, not configuration, and they are the structured evidence cited
above.

## 7. Verdict

Every stage of `adapter-verification.md` passed for local-development loading:
the artifact was built and its digest matched what the harness loaded, a fresh
isolated interactive process loaded it, `/weave:health` and `/weave:status`
reported readiness, and real delegation, deferral, reactivation, and direct
workflow-step behavior was exercised and read from structured results. No
defect was found, so no production or test file was changed for this task.
