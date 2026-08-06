# Task 20 isolated Pi 0.83 Herdr proof harness

This record covers Task 20 preparation only. It establishes a task-local Pi 0.83.0 environment that later Task 20 acceptance-matrix delegations can reuse. It does not run, satisfy, or claim any acceptance-matrix scenario.

The user's global Pi install is 0.84.0. The earlier record
[`33-task-20-release-setup-proof.md`](33-task-20-release-setup-proof.md) installed the adapter into the
global `~/.pi/agent` tree. That approach is no longer valid, because the global host is now 0.84.0 and must
stay untouched. This harness therefore installs Pi 0.83.0 and the adapter into isolated paths and leaves the
global installation unchanged.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `ef87047b9c8144946acde8e130bd9eb450ce30b1` |
| Subject HEAD subject line | `refactor(pi): extract overlay terminal-input binding` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Isolated Pi version | `0.83.0` |
| Global Pi version (unchanged) | `0.84.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |

## Isolated paths

All harness state lives under one root. Nothing outside this root was created or modified.

```sh
ISO="$HOME/.local/share/weave/task20-pi083-harness"
```

| Path | Purpose |
| --- | --- |
| `$ISO/bun` | Isolated `BUN_INSTALL` holding `@earendil-works/pi-coding-agent@0.83.0` |
| `$ISO/pi-agent` | Isolated `PI_CODING_AGENT_DIR` |
| `$ISO/pi-agent/sessions` | Isolated `PI_CODING_AGENT_SESSION_DIR` |
| `$ISO/pi-agent/npm/node_modules/@weaveio/weave-adapter-pi` | Installed adapter package |
| `$ISO/pi-agent/npm/artifacts` | Durable release artifact |
| `$ISO/bin/pi` | Isolated launcher |
| `$ISO/shim/pi` | Symlink to the launcher, used to make `herdr agent start --kind pi` resolve Pi 0.83.0 from `PATH` |

## Artifact and hashes

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-ef87047-task20iso-d3c93a792468.tgz` |
| Artifact SHA-256 | `d3c93a792468ccc0dbcd702a1572af7bdcfd516249f8655931664af282b6cd2c` |
| Built, shipped, and installed `dist/extension.js` SHA-256 | `daba72e0c64b1c5c3013e3d1f57d137f7a2ed75f7099540bdd6c1fc9aa684611` |
| Built, shipped, and installed `dist/index.js` SHA-256 | `ac00dabf4b9532c3222b896db7ccdbee9c9edd042e687d6ca4d38728864f5d0f` |
| Built, shipped, and installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Launcher `$ISO/bin/pi` SHA-256 | `67d8424d947c9c5eed2331905a070c41fb8ffd6f2f940d8612528607513d810b` |

The built files, tarball entries, and installed entry points have the same SHA-256 digests. All eight shipped
files compared byte-identical against the tarball: `README.md`, `package.json`, `dist/cli.js`,
`dist/cli.d.ts`, `dist/extension.js`, `dist/extension.d.ts`, `dist/index.js`, `dist/index.d.ts`. The tarball
inventory matched the approved release inventory. Installation used `--production --omit=peer
--ignore-scripts`; the installed adapter has no nested copy of `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, or `@earendil-works/pi-tui`.

## Reproducible setup commands

### 1. Install Pi 0.83.0 into the isolated Bun root

```sh
ISO="$HOME/.local/share/weave/task20-pi083-harness"
mkdir -p "$ISO/bun" "$ISO/pi-agent/npm/artifacts" "$ISO/pi-agent/sessions" "$ISO/bin" "$ISO/shim"
BUN_INSTALL="$ISO/bun" bun install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
```

### 2. Build and pack the adapter from the subject commit

```sh
cd /Users/jose/projects/weave
git log -1 --pretty='%H%n%s'
git status --porcelain
bun run build
SUBJECT_HEAD=ef87047b9c8144946acde8e130bd9eb450ce30b1 bun -e '
import { join } from "node:path";
import { PublicPackagePackager, BunPackageCommandRunner } from "./scripts/release/packager.ts";
import { PackagePolicyValidator } from "./scripts/release/package-policy.ts";
const root = `.release/task20-iso-${process.env.SUBJECT_HEAD}`;
const result = await new PublicPackagePackager(
  new BunPackageCommandRunner(),
  new PackagePolicyValidator(),
).pack("@weaveio/weave-adapter-pi", root, join(root, "out"));
if (result.isErr()) { console.error(result.error); process.exit(1); }
console.log(result.value);
'
```

### 3. Install the artifact into the isolated package root

```sh
ART="$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-ef87047-task20iso-d3c93a792468.tgz"
cp .release/task20-iso-ef87047b9c8144946acde8e130bd9eb450ce30b1/out/weaveio-weave-adapter-pi-0.0.1.tgz "$ART"
INSTALL="$ISO/pi-agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-task20-iso-stage.XXXXXX)
tar -xzf "$ART" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
mkdir -p "$ISO/pi-agent/npm/node_modules/@weaveio"
rm -rf "$INSTALL"
cp -R "$STAGE/package" "$INSTALL"
shasum -a 256 "$INSTALL/dist/extension.js" "$INSTALL/dist/index.js" "$INSTALL/dist/cli.js"
```

### 4. Isolated Pi configuration

`$ISO/pi-agent/npm/package.json` declares only the adapter runtime dependencies. `$ISO/pi-agent/settings.json`
declares exactly one package:

```json
{
  "packages": ["npm:@weaveio/weave-adapter-pi"]
}
```

`$ISO/pi-agent` has no `extensions` directory, so no local extension shadows the npm package. Model and
credential configuration was copied from the global agent directory without inspection: `auth.json`,
`models.json`, `models-store.json`, `cursor-sdk-context-windows.json`, `cursor-sdk-model-list.json`, and
`trust.json`.

### 5. Isolated launcher

`$ISO/bin/pi`:

```sh
#!/bin/sh
# Task 20 isolated Pi 0.83.0 launcher. Does not touch the global Pi 0.84.0 install.
set -eu
ISO="$HOME/.local/share/weave/task20-pi083-harness"
BUN_INSTALL="$ISO/bun"
export BUN_INSTALL
PI_CODING_AGENT_DIR="$ISO/pi-agent"
export PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR="$ISO/pi-agent/sessions"
export PI_CODING_AGENT_SESSION_DIR
PI_OFFLINE=1
export PI_OFFLINE
PI_SKIP_VERSION_CHECK=1
export PI_SKIP_VERSION_CHECK
unset WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE
exec bun "$BUN_INSTALL/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"
```

`$ISO/shim/pi` is a symlink to `$ISO/bin/pi`. Herdr's `agent start --kind pi` resolves the canonical `pi`
executable from `PATH`, so the shim directory must be prepended in the pane before starting the agent.

### 6. Create and prepare the Herdr pane

```sh
herdr pane split --current --direction down --cwd "$PWD" --no-focus
# read the new pane id from .result.pane.pane_id
herdr pane run <PANE> 'unset WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE; export PATH="$HOME/.local/share/weave/task20-pi083-harness/shim:$PATH"; echo "WHICH=$(command -v pi)"; echo "VER=$(pi --version)"; echo "OVERRIDE=[${WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE:-unset}]"'
herdr pane read <PANE> --source recent-unwrapped --lines 30
herdr agent start <NAME> --kind pi --pane <PANE> --timeout 120000
```

### 7. Invoke Weave commands and read output

```sh
herdr agent prompt <NAME> "/weave:status"
herdr agent read <NAME> --source recent-unwrapped --lines 60
herdr agent prompt <NAME> "/weave:health"
herdr agent read <NAME> --source recent-unwrapped --lines 45
```

`herdr agent prompt` was used without `--wait`, because Pi slash commands resolve locally and do not always
produce a lifecycle transition.

### 8. Close only the test-created pane

```sh
herdr pane close <PANE>
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent get <NAME>            # expect agent_not_found
ps -Ao pid,args | grep -F "task20-pi083-harness" | grep -v grep
```

## Verified harness behavior

### Host isolation

Inside the test-created pane, before starting the agent:

```text
WHICH=/Users/jose/.local/share/weave/task20-pi083-harness/shim/pi
VER=0.83.0
OVERRIDE=[unset]
```

The global launcher reported `0.84.0` before and after the run.

### Command-provenance override

`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` is absent from the isolated `settings.json`, the isolated
launcher (which explicitly unsets it), the global launcher `~/.pi/agent/bin/pi`, the global
`~/.pi/agent/settings.json`, and `~/.zshrc`. The variable is present in the delegated Weave child process
environment that drove this setup; the pane preparation command and the isolated launcher both unset it, and
the pane reported `OVERRIDE=[unset]`.

### Loaded host and extension

Pi's startup banner in the pane reported `pi v0.83.0` and this extension list:

```text
[Extensions]
  @weaveio/weave-adapter-pi:dist/extension.js
```

The running processes were:

```text
24177 bun /Users/jose/.local/share/weave/task20-pi083-harness/bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
24178 /Users/jose/.volta/tools/image/packages/bun/bin/bun /Users/jose/.local/share/weave/task20-pi083-harness/bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

Two non-fatal startup warnings appeared: the `rose-pine` theme is not installed in the isolated agent
directory, so Pi fell back to the dark theme; and the overlay actions `weave.child.sibling.previous` and
`weave.child.sibling.next` skipped `alt+left` and `alt+right` because those keys are already bound to
`tui.editor.cursorWordLeft` and `tui.editor.cursorWordRight`.

### `/weave:status`

```text
generation: 07f1100a-31c7-4189-8fd2-d5c61cbbc9a3
trust: trusted
mode: tui
health-only: false
children: 0
```

The status line read `ready ◆ WEAVE · LOOM`.

### `/weave:health`

```text
Weave adapter mode: ready
config-materialization: emulated (declared emulated)
agent-materialization: emulated (declared emulated)
primary-agent-selection: emulated (declared emulated)
delegated-specialist-execution: emulated (declared emulated)
prompt-composition: emulated (declared emulated)
tool-policy-mapping: native (declared native)
workflow-persistence: emulated (declared emulated)
workflow-step-dispatch: emulated (declared emulated)
plan-file-compatibility: emulated (declared emulated)
command-entrypoints: native (declared native)
event-logging: emulated (declared emulated)
token-usage-reporting: native (declared native)
idle-continuation: unsupported (declared emulated)
compaction-recovery: unsupported (declared emulated)
context-window-monitor: unsupported (declared native)
analytics-dashboard: unsupported (declared degraded)
eval-integration: unsupported (declared unsupported)
static-artifact-generation: unsupported (declared degraded)
multiple-active-workflows: unsupported (declared unsupported)
model-thinking-activation: unsupported (declared emulated)
child inspection: native-overlay
```

Health also reported the overlay named-action emulation note, the two skipped `alt+left`/`alt+right`
bindings, and a `[temperature] loom` warning that Pi has no stable sampling API.

## Cleanup

The test-created pane `w23:pA2` was closed. After closure:

- `herdr pane list --workspace w23` returned only the pre-existing panes `w23:p79`, `w23:p8W`, `w23:p70`, and
  `w23:p82`.
- `herdr agent get task20iso` returned `agent_not_found`.
- No process matching `task20-pi083-harness` remained.
- No Runtime Store database file exists anywhere under `$ISO`, so no lease remains.
- No session JSONL file was written under `$ISO`, and no new session file appeared in the global
  `~/.pi/agent/sessions/--Users-jose-projects-weave--/` directory.
- The staging directories `/tmp/weave-task20-iso-stage.*` and `/tmp/weave-task20-iso-verify.*` were removed.
- The global launcher digest remained `1ab6836d2ecfee255f0fb85ddc1d564408d5f4c0ccd8a1f213e610dcd3efd110`, and
  the global adapter install was left in place unchanged.
- `git status --porcelain` was empty; `HEAD` remained `ef87047b9c8144946acde8e130bd9eb450ce30b1`. The ignored
  `.release/` staging root did not change the tracked working tree.

## Scope boundary

This record proves harness construction, host isolation, artifact identity, exact-byte install, npm package
provenance, and command reachability only.

No acceptance-matrix scenario was executed. `/weave:status` and `/weave:health` were invoked solely to prove
that the isolated host loads the correct adapter and reports readiness. The Task 20 plan checkbox, acceptance
manifest, and smoke checklist remain unchanged.
