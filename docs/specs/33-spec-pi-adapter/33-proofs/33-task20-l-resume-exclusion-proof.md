# Task 20(l)/21 Pi `/resume` exclusion proof

**Date:** 2026-08-06  
**Pane:** `w23:p9S`  
**Verdict:** **BLOCKED**

The adapter-private storage and Pi discovery checks support the exclusion contract. However, neither bounded automation attempt opened the real Pi `/resume` selector. This proof therefore does not claim that the private child was absent from, or unselectable in, the real UI. It also does not claim restart persistence.

## Requirement results

| Requirement | Result | Evidence |
| --- | --- | --- |
| Use only the fresh owned pane | PASS | All work remained in `w23:p9S`; no pane was created, split, moved, or closed. |
| Pi 0.83 | PASS | `pi --version` returned `0.83.0`. |
| Exact trusted npm artifact | PASS | Settings contained one `npm:@weaveio/weave-adapter-pi` entry and no local adapter package reference or extension shadow. The installed hashes matched the release artifact below. |
| Unsafe provenance override absent | PASS | The environment, Pi launcher, settings, and shell configuration did not contain `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE`. |
| Ready and not health-only | PASS | The initial real TUI snapshot rendered `Connected ready ◆ WEAVE · LOOM`. The installed adapter renders `ready` only for a trusted generation outside health-only mode. |
| pi-vim coexistence | PASS | The real TUI rendered `INSERT`. |
| Sanitized baseline | PASS | Counts and hash manifests were recorded without prompts, transcripts, raw session IDs, or machine-specific absolute paths. |
| Reuse an existing disposable child | PASS | One existing private native Pi v3 fixture was selected by hash. No new child was created. |
| Private storage outside host resume tree | PASS | The roots were disjoint; every discovered path was in the host tree; no discovered path was in the private tree. |
| Private child absent from host discovery | PASS | The fixed fixture ID hash existed in private storage, was absent from host discovery, and private-to-host ID overlap was zero. |
| Normal persisted parent remains discoverable | PASS | The fixed parent ID hash existed in host discovery and was absent from private storage. This is API evidence only, not UI evidence. |
| Open the real `/resume` UI | **BLOCKED** | Both bounded drivers failed before the selector opened. |
| Prove private child is not listed or selectable | **BLOCKED** | No real selector result was obtained. Storage/API evidence cannot replace the required UI proof. |
| Prove behavior after restart | **BLOCKED** | No controlled Pi restart occurred after either driver failed. |
| Final cleanup | PASS | Zero child RPC processes, Runtime Store schema 5 with no active lease, no task temporary files, and the owned Pi pane remained open. |

## Installed artifact

- Artifact: `weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz`
- Artifact SHA-256: `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6`
- Installed `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`
- Installed `dist/index.js`: `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e`
- Installed `dist/cli.js`: `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd`

## Sanitized baseline and correlation

Adapter-private storage used the documented root `~/.local/share/weave/adapters/pi/sessions/`. Host discovery used Pi's normal project session tree under `~/.pi/agent/sessions/<project-key>/`.

- Private native session files: `116`
- Private path-hash manifest: `8459478c2bc8b5cf2343aaa233b41955d27cf89b95741c640b588372083bbaca`
- Private content-hash manifest: `e942d6ce6b80be86a58214c11b6516224e02fb9adedb530a4f712b846474bf87`
- Existing fixture session-ID hash: `13bbc6c2fedf3759725b7609e96476ff5b7f592c9022aaa390be7b2eb23bc236`
- Existing fixture file SHA-256: `b7eca09f06d633ad3b4a9de9e47dbb4eff05f980723fc8c4760cc8a17835400a`
- Existing fixture file mode: `0600`
- Existing fixture header: native Pi v3
- Host-discovered sessions: `270`
- Host discovery ID-hash manifest: `c07054cdbdeb05c8d375a713a32d84d0e668b552f5b6c132a0ca995b11f2eae2`
- Fixed parent session-ID hash: `c3e20ab65d7d8ec5557754eba16e792ae2478754b31286acbae08d4933a27adf`
- Private-to-host session-ID overlap: `0`
- Fixed fixture exists in private storage: `true`
- Fixed fixture absent from host discovery: `true`
- Fixed parent exists in host discovery: `true`
- Fixed parent absent from private storage: `true`
- All host discovery paths under host root: `true`
- Any host discovery path under private root: `false`
- Private and host roots disjoint: `true`

The post-attempt private file count and both private manifests matched the baseline. The attempts did not create or modify private child storage.

## Bounded real-UI attempts

### Attempt 1

A PTY probe could not render the real Pi startup UI because the pseudo-terminal did not provide the terminal behavior required by the TUI. A same-pane driver then raced the active agent turn and failed before opening `/resume`. Its sanitized result marked all selector, restart, readiness, and parent-selection checks `false`. It left no Pi or RPC child process.

### Attempt 2

An idle-aware same-pane driver waited for the current agent to become idle before sending UI input. The handoff timed out:

```text
created_new_child=false
idle_handoff=false
driver_completed=false
```

It sent no selector input, did not restart Pi, and created no child. Work stopped after this second bounded same-pane attempt.

## Why the verdict is BLOCKED

Pi's `SessionSelectorComponent` loads current-folder entries through `SessionManager.list(cwd, sessionDir)` and can select only a path in that discovered array. The API returned 270 host sessions, excluded every private session ID, and contained the expected persisted parent. This is strong contract evidence, but Task 20(l)/21 explicitly requires the real `/resume` UI. Because the selector never opened, PASS would overstate the result.

## Cleanup and validation

Final checks:

- Child RPC process count: `0`
- Runtime Store schema: `5`
- Active Runtime Store lease: none
- New disposable child count: `0`
- Task temporary files: `0`
- Production source changes: none
- Owned pane `w23:p9S`: open
- `bun run docs:check-links`: PASS
