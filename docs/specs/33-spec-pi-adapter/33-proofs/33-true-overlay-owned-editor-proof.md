# True child overlay and owned editor — live Pi 0.83 proof

Date: 2026-08-10

Result: **PASS for plan Task 10**

This record covers the true-overlay implementation, owned native editor,
compositor-matched height, Kitty-aware scrolling, pi-vim coexistence, and clean
teardown. It stores only outcomes, counts, hashes, and UI-state booleans. It
does not store prompts or child transcripts.

Checklist version: `4`.

The run gives current evidence for the overlay, input, short-terminal, and
coexistence parts of S043, S044, S046, and S047. S044 and S046 are Pass. S043
and S047 remain Pending because this run did not inject a live renderer failure
and did not record a distinct visible expansion-toggle state.

## Subject and artifact

| Field | Value |
| --- | --- |
| Subject commit | `56371756b4521ef0bbeaee28a2a0631f33934a5d` |
| Working tree | Pre-existing unrelated dirty changes present; proof binds to the built hashes below |
| Pi version | `0.83.0` |
| Harness mode | Fresh interactive TUI |
| Adapter source | `~/.pi/agent/extensions/weave-adapter-pi` symlink to this checkout |
| Local development provenance override | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` |
| Built extension SHA-256 | `1cac858b516264afb978761907c6872231168ed7f3db25cc90a1182d02a88333` |
| Built index SHA-256 | `c08378e06e8b65a5e5ade3600378f602b6315ccc38106a0a55d8d861eff7b520` |
| Built CLI SHA-256 | `60bb26ced1b23a30965a25de5bc337190140ccdc79dd4665f74b91faaa03f845` |
| Build timestamp | `2026-08-10T13:48:43Z` |
| Checklist version | `4` |

The root `bun run build` completed before the live run. The symlink made the
loaded entry point byte-identical to the built extension. After the Weft draft
isolation fix, the final subject was rebuilt and a fresh Pi 0.83 process again
reported ready, completed one real delegation, rendered its child in the true
overlay, closed normally, and left no child process or active lease. This is
local interactive development proof, not npm release-provenance proof.

## Readiness

A fresh isolated Pi 0.83 project was installed from Bun's offline cache. Each
live process started after the build. The first process reported:

```yaml
piVersion083: true
weaveModeReady: true
healthOnly: false
childInspectionMode: native-overlay
piVimLoaded: true
piVimModeBeforeOverlay: INSERT
expectedKeyConflictWarningsOnly: true
```

`/weave:health` reported `Weave adapter mode: ready` and child inspection
`native-overlay`.

## Live assertions

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Parent UI remains visible around a centered overlay | **PASS** | Parent lines were visible on every side of the mounted child component. |
| Four-sided border is complete | **PASS** | Top, both rails, and bottom border were present in tall, short, active, and settled views. |
| Native editor renders instead of the text fallback | **PASS** | The focused Pi editor frame and hardware-cursor marker were visible; no `> ` fallback prefix appeared. |
| Cursor-aware editing works | **PASS** | Three inserted characters, one cursor-left, one Backspace, and one insertion produced a three-character draft with SHA-256 `703a1b35f8e398e5ff9af9b0179718e6abee86d42beb55192d0d5b5e93c8cb50`. |
| Multiline editing works | **PASS** | Shift+Enter produced a two-line editor while preserving the cursor location. |
| Enter steering reaches the child | **PASS** | The child consumed one live steering intervention and continued. |
| Alt+Enter follow-up reaches the child | **PASS** | The child consumed one follow-up intervention in a later turn. |
| Short-terminal layout preserves editor and bottom border | **PASS** | At 12 terminal rows, the active overlay retained the native editor, submit help, and bottom border. |
| Settled child is read-only | **PASS** | Reopening a completed child showed `SETTLED`, a read-only banner, no writable editor, and a bottom border. |
| pi-vim remains untouched | **PASS** | pi-vim stayed in `INSERT` before, during, and after overlay use. The primary editor was visible and usable after close. |
| Overlay closes without key leakage | **PASS** | Empty-draft raw Backspace closed the direct-child overlay. The primary editor remained empty. |
| Normal harness exit works | **PASS** | Ctrl+Q returned the pane to its shell without an exception. |

## Scroll matrix

The mounted component received real raw terminal frames through the Pi TUI.
The test used a child transcript large enough to create a rendered-row extent.
The `newer line(s)` cue was the bounded observable.

| Input | Encoding | Result |
| --- | --- | --- |
| Shift+Up press | Kitty `CSI 1;2:1 A` | Offset cue became `4 newer line(s)`. |
| Shift+Up release | Kitty `CSI 1;2:3 A` | Cue stayed at `4`; no repeated scroll. |
| Shift+Down | Legacy `CSI 1;2 B` | Returned to the live tail; cue disappeared. |
| PageUp | Legacy `CSI 5 ~` | Cue became `4 newer line(s)`. |
| PageDown | Legacy `CSI 6 ~` | Returned to the live tail; cue disappeared. |
| Home | Kitty `CSI 1;1:1 H` | Cue became `4 newer line(s)`, the oldest available rendered row. |
| End | Kitty `CSI 1;1:1 F` | Returned to the live tail; cue disappeared. |

The visible footer listed PageUp/PageDown, Shift+Up/Shift+Down, Home/End, and
the mouse-wheel limitation.

## Cleanup

```yaml
createdHerdrPanesClosed: true
isolatedPi083ProcessesRemaining: 0
childProcessesRemaining: 0
runtimeStoreActiveLease: false
normalExitObserved: true
otherPanesClosed: false
stashesChanged: false
```

`bun packages/cli/src/cli.ts runtime status` exited `0` with no active lease
output. Process inspection found no isolated Pi 0.83 process and no child
process after teardown. All Herdr panes created for this proof were closed.
