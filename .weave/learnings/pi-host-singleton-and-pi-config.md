# Learnings: pi-host-singleton-and-pi-config

## Task 14: full repository validation (2026-08-17)

- **Status**: PASS. Every required command exited `0`.
- **Subject**: repository HEAD `81dd8d0` (`docs(pi): document the host singleton and child extension config`), branch `feat/pi-native-child-stream-rendering`.
- **Environment**: Bun `1.4.0` (test runner reported `1.4.0-canary.1`), TypeScript `5.9.3`, Pi host `0.84.2` at `/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`, macOS.
- **Working tree note**: the checkout also carried unrelated, uncommitted config-activation work owned by another session (`docs/adapters/pi.md`, `packages/adapters/pi/src/config-activator.ts`, `src/extension-impl.ts`, `src/safe-initializer.ts`, `src/config-activation-diagnostics.ts`, and two of their tests). Every command below ran against those current bytes. The files were verified byte-identical before and after this task and were never staged.

### Command results

| Command | Exit | Result |
| --- | --- | --- |
| `bun test` | 0 | 9647 pass, 11 skip, 0 fail; 9658 tests across 338 files |
| `bun run --filter '@weaveio/weave-adapter-pi' test` | 0 | **3420 pass, 0 fail** across 160 Pi package test files |
| `bun run typecheck` | 0 | no errors across the root, `scripts/`, and every workspace |
| `bun run lint` | 0 | Biome: 0 errors (362 warnings, 71 infos, all pre-existing); declaration validation clean |
| `bun run build` | 0 | public packages plus the docs site; both Pi extension artifacts emitted |
| `bun run docs:check-links` | 0 | `Checked local documentation links` |
| `bun run validate-config` | 0 | `Weave config is valid.` |
| `bun run changeset:check` | 0 | `Changeset policy passed` |
| `bun run verify:pi-host-singleton` | 0 | `PASS`, positive `single-copy`, negative control `duplicate-detected` |

`bun test` at the repository root is Bun's own runner over the whole workspace, so it prints one aggregate summary and no per-package count. The Pi package count above therefore comes from the package's own `test` script (`bun test src`), run against the same bytes.

### Build artifacts

Rebuilt before the singleton proof so the script inspected current bytes.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `packages/adapters/pi/dist/extension.js` | 486 | `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` |
| `packages/adapters/pi/dist/extension-impl.js` | 1903627 | `0308179f56bb1541a93c5c9da8d91c3cb47ad508c0f99cfa4ae996cb9d65c259` |

`grep -c "@earendil-works/" packages/adapters/pi/dist/extension.js` returned `0`, so the shipped loader entry still carries no bare Pi import.

### Host singleton proof

`bun run verify:pi-host-singleton` reported:

```
PASS hostVersion=0.84.2
artifactSha256=39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae
positive=single-copy negative=duplicate-detected
```

The digest in the proof line equals the freshly built `dist/extension.js` digest, so the proof and the recorded artifact are the same bytes. The negative control (`WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1`) still detects the duplicate, so the detector is not vacuously passing. No spawned `pi` process survived the run.

### Notes

- No production or test file was modified for this task. No validation failure was traced to this plan, so no fix was needed.
- This is a repository-level proof only. Task 15 still owns the real interactive Pi host proof (readiness, `/weave:pi-config`, child argv, `lsof` mapping, lease state).
- Task 14 is the only checkbox changed in `.weave/plans/pi-host-singleton-and-pi-config.md`.

## Task 15: real Pi host proof (2026-08-17)

- **Status**: PASS with recorded deviations. Full evidence:
  `.weave/evidence/pi-host-singleton-and-pi-config-task15.md`.
- **Subject**: HEAD `02db840`, branch `feat/pi-native-child-stream-rendering`, Pi host `0.84.2`,
  adapter loaded through `~/.pi/agent/extensions/weave-adapter-pi -> packages/adapters/pi`.
- **Artifact**: rebuilt `dist/extension.js` digest
  `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` — identical to Task 14, and
  identical to the file the host actually loaded.

### Durable findings

- **Thread count is the reliable duplicate signal on macOS; RSS is not.** The negative-control run
  held 96 threads, the fixed run 78. RSS moved in the wrong direction and swung 200 MB inside one
  process without any configuration change, so it proves nothing at this scale.
- **`lsof` cannot see a duplicate Pi runtime directly.** Pi reads JavaScript and closes the
  descriptor, so no `@earendil-works` path is ever mapped. The usable fingerprint is the native
  module that `@earendil-works/pi-coding-agent` dlopens through its direct dependency
  `@mariozechner/clipboard@0.3.9`. The checkout's
  `clipboard.darwin-universal.node` is mapped with the redirect disabled and gone with it enabled.
  A JavaScript-only duplicate leaves no OS trace at all (the `afk` extension's nested `0.82.0` copy
  is neither provable nor disprovable this way).
- **The `host runtime:` health line is not a duplicate detector in negative-control mode.** With
  `WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1`, `runResolveHostModules` returns
  `skipAllOutcome({ reason: "redirect-disabled" })` with no `hostVersion`, so the line falls back to
  the imported `VERSION` and prints `single-copy; redirected 0`. It is only meaningful in the fixed
  configuration, where it printed `single-copy; redirected 3`. Do not use that line as the negative
  control; use the OS mapping, the thread count, or `verify:pi-host-singleton`.
- **Other extensions ship their own Pi runtimes.** `bash-audit` (`0.84.2`) and `afk` (`0.82.0`) both
  carry nested `@earendil-works` trees under `~/.pi/agent/extensions/`. `bash-audit`'s copy is
  mapped in every run. The plan puts other-extension copies out of scope; parity claims must exclude
  them explicitly rather than quietly.
- **`pi-cursor` was already unconfigured** before Task 15 began — no entry in
  `~/.pi/agent/settings.json` `packages`, though `@rahularya01/pi-cursor` is still installed under
  `~/.pi/agent/npm/node_modules` and `/Users/jose/projects/pi-cursor` still exists. Task 16's
  settings-removal step is therefore already satisfied; only its measurement steps remain.
- **Weave-only children lose credentials, and the TUI copy is literally true.** With
  `mode: "explicit", entries: []`, the child argv is `--no-extensions -e <weave>` and the
  `shuttle` delegation failed with `provider error · HTTP 400` because
  `~/.pi/agent/extensions/opencode-anthropic-auth` was not loaded. Weave settled the child cleanly
  and reported the typed failure. Any future Weave-only default would break Anthropic-backed agents
  on this machine.
- **The inventory labels directory extensions by their entry filename**, so ten distinct extensions
  all render as `index.ts  user` in `/weave:pi-config`. They are distinguishable only in the stored
  record's `path`. Selecting one specific directory extension from the UI is currently guesswork.
- **`shuttle-mini` does not exist** in the active configuration: the `mini` category is commented
  out in `~/.weave/config.weave`. Plans that assume it must either re-enable the category or name
  `shuttle`.
- **Restart discipline in a shared machine.** "Restart every Pi process" is unachievable when the
  coordinator itself runs inside Pi. Start each measurement in a fresh external process, stop only
  what you started, and record the exception instead of claiming a full restart.

### Reusable measurement commands

```bash
ps -o pid,ppid,rss,vsz,etime,command -p <pid>     # process facts
ps -M -p <pid> | tail -n +2 | wc -l               # macOS thread count
lsof -p <pid> | grep -o '/[^ ]*\.node' | sort -u  # evaluated native modules
ps -o args= -p <child-pid>                        # live child argv
bun packages/cli/src/main.ts runtime preferences  # stored selection, read-only
bun packages/cli/src/main.ts runtime status       # lease state
```

Poll `pgrep -P <host-pid>` in a short loop to catch a child's argv: the delegated task must stay
alive long enough (a `sleep` inside the child's own shell command works) or the process exits before
`ps` can read it.

## Task 16: remove `pi-cursor` from the local Pi configuration (2026-08-17)

- **Status**: PASS, with the removal itself an explicit idempotent no-op. Full evidence:
  `.weave/evidence/pi-host-singleton-and-pi-config-task16.md`.
- **Subject**: HEAD `bfa4410`, branch `feat/pi-native-child-stream-rendering`, Pi host `0.84.2`.
  Fresh proof host PID `1586` (wrapper `1581`), started in a new Herdr tab with an isolated cwd.
- **Net change to `~/.pi/agent/settings.json`**: none. Pre-task and post-task SHA-256 are both
  `294f62a7abc6ac5039e415aa7b2b3f6b1f4c22077748c1f1e4eb9022c52e900f`.

### Durable findings

- **`pi --verbose` is the load-claim evidence; `lsof` is not.** Pi's verbose startup prints a full
  `[Extensions]` inventory across every scope (directory files, directories, npm packages). That
  inventory — 28 loaded extensions, zero `pi-cursor`, zero error lines — is what proves an extension
  did not load. `lsof` can only corroborate, and only for packages that dlopen a native module.
- **The `pi-cursor` checkout does ship the native fingerprint**, at
  `node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node`.
  Its absence from `lsof` is therefore meaningful rather than vacuous. Always check that the thing
  you expect to see would have been visible before treating absence as proof.
- **Starting a proof TUI with `--provider`/`--model` rewrites the user's saved defaults.** Pi
  persisted `defaultProvider: openai-codex` and `defaultModel: gpt-5.6-sol` into
  `~/.pi/agent/settings.json` at startup, silently. Any future proof that passes those flags must
  diff the settings file afterwards and restore from the backup. Taking the backup first is what made
  the restore exact.
- **Prove a no-op by digest, not by output.** The helper script reported `wrote: false`; the settings
  digest being unchanged immediately afterwards is the actual proof that no write happened, as
  opposed to a write of identical bytes.
- **`pi list` and a direct JSON parse answer different questions.** `pi list` shows how Pi resolves
  each configured package (installed path per entry); the JSON parse shows that no entry is a local
  path at all (`nonNpmEntries: []`). Record both; the second is the stronger claim.
- **`cursor/*` models were already gone** before this task, because `pi-cursor` had been unconfigured
  since before Task 15. Do not attribute that loss to Task 16. `openai-codex/gpt-5.6-sol` is listed,
  `pi auth check --provider openai-codex --json --no-refresh` reports
  `{"status":"ready","authType":"oauth"}`, and a fresh host answered a live prompt with the
  deterministic marker `TASK16_MODEL_OK`.
- **`ps -Eww` cannot reveal a Pi session's current model.** The coordinator host's environment
  carries no `PI_PROVIDER`/`PI_MODEL`; the model is a runtime selection. Verify model *availability*
  and a *live turn* instead of trying to read another session's choice.
- **Pi needs two `ctrl+c` presses in rapid succession to exit.** Two presses one second apart did
  nothing. Send them back to back with no sleep between.
- **A new Herdr tab is less disruptive than a pane split** when the coordinator must not be
  disturbed: `herdr tab create --no-focus --cwd <isolated dir>` neither resizes nor refocuses the
  coordinator's pane, and `herdr tab close <id>` reverses it completely.
- **`~/.pi/agent` is a symlink into `/Users/jose/dotfiles/.pi/agent`.** `readlink -f` therefore
  reports dotfiles paths for extension and npm locations, and `settings.json` is tracked in the
  user's dotfiles repository. That repository already carries unrelated pre-existing drift for the
  file; never commit it, and check `git -C ~/dotfiles diff` before assuming you caused a change.

### Reusable commands

```bash
pi list                                                # configured packages and resolved paths
pi --verbose ...                                       # full startup resource inventory
pi --list-models <pattern>                             # model availability
pi auth check --provider <p> --json --no-refresh       # readiness, prints no credential
herdr tab create --workspace <w> --cwd <dir> --no-focus --label <l>
herdr pane run <pane> '<cmd>'                          # start the proof host
herdr pane read <pane> --source recent-unwrapped --lines 600
herdr agent prompt <pane> '<text>' --wait --timeout 120000
herdr agent send-keys <pane> ctrl+c                    # twice, back to back, to exit Pi
herdr tab close <tab>
```
