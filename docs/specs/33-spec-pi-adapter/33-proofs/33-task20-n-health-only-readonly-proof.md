# Task 20(n)/21 health-only read-only proof — PASS

## Verdict

**PASS.** On 2026-08-06, owned pane `w23:p9V` ran fresh Pi 0.83.0 TUI processes with the exact installed npm artifact. A process-local temporary extension created one `/weave:run` ownership collision. The collision changed only `command-entrypoints` from `native` to `unsupported` and put Weave in health-only mode. History and doctor stayed registered, bounded, sanitized, and read-only. All exposed mutation routes were disabled or failed closed. Removing the process environment switch restored normal ready mode.

This proof contains no raw prompt, delegated task text, transcript, session identifier, child identifier, or unsanitized diagnostic path.

## Scope and starting state

- Owned pane: `w23:p9V`; it remained open.
- Repository parent before the proof: `d23001f0d8cb6da994d0a4fd6dc52f72a5795f27`.
- The working tree was clean.
- No production source file changed.
- Workspace `w23` contained panes `p79`, `p9V`, `p8W`, `p70`, `p82`, and `p98` before the proof.
- Global Pi session inventory: 943 files.
- Child RPC processes: 0.
- Runtime Store active leases: 0.

All live checks used fresh Pi TUI processes with isolated session directories below a temporary `/tmp` root. The proof did not install an extension or write a Pi setting.

## Host, trust, provenance, and editor

| Check | Sanitized evidence | Result |
| --- | --- | --- |
| Pi version | `pi --version` returned `0.83.0`. | PASS |
| Real process mode | `/weave:status` reported `mode: tui` in the injected process. | PASS |
| Trust | `/weave:status` reported `trust: trusted`. | PASS |
| npm provenance | `~/.pi/agent/settings.json` still contained `npm:@weaveio/weave-adapter-pi`. All 15 adapter-owned `/weave` and `/weave:*` commands reported package/user ownership from `npm:@weaveio/weave-adapter-pi`. | PASS |
| Unsafe override | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent. | PASS |
| pi-vim | `npm:pi-vim` remained configured. Both injected and restored TUI processes reached `INSERT`, then `NORMAL` after Escape, then `INSERT` again. | PASS |

### Exact installed artifact

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Artifact: `~/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz`
- Artifact SHA-256: `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6`
- Installed `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`
- Installed `dist/index.js`: `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e`
- Installed `dist/cli.js`: `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd`

## Reversible failure injection

The supported process-local `pi -e <path>` mechanism loaded one temporary extension. The extension registered a duplicate `weave:run` only when this process variable was set:

```text
WEAVE_TASK20N_FAIL_COMMAND_ENTRYPOINTS=1
```

Pi exposed the temporary command as `weave:run:1` with temporary/top-level provenance and the npm adapter command as `weave:run:2` with package/user provenance. The proof invoked only the npm-owned `weave:run:2`. It never invoked the temporary collision handler.

The injected `/weave:health` report showed:

```text
Weave adapter mode: health-only
command-entrypoints: unsupported (declared native)
```

A sanitized failed-versus-restored capability comparison had one changed row:

```text
failed:   command-entrypoints | unsupported | declared native
restored: command-entrypoints | native      | declared native
```

All other reported capability rows were identical. Thus the process had exactly one artificial required-capability failure.

## Read-only surfaces

| Surface | Sanitized result | Bound and read-only evidence | Result |
| --- | --- | --- | --- |
| `/weave:history` | `No child history for this workspace.` | One line; no path, prompt, transcript, child identifier, cursor, or mutation. | PASS |
| `/weave:doctor` | `Doctor status: degraded` | Seven bounded rows: capabilities and cache failed; permissions, sessions, refs, stale, and orphans passed. No raw path or identifier was retained. | PASS |
| `/weave:health` | Health-only with `command-entrypoints` unsupported. | Bounded capability report; no mutation. | PASS |
| `/weave:status` | Trusted TUI mode with `health-only: true`. | Bounded state report; no mutation. | PASS |

History was empty, so no child detail, steering, follow-up, delete, retry, or continue control was exposed through child state.

## Mutation and fail-closed checks

| Route | Sanitized result | Result |
| --- | --- | --- |
| `/weave:start` | Rejected because `weave:start` was unavailable until required capabilities recover. | PASS |
| npm-owned `/weave:run:2` | Rejected because `weave:run` was unavailable until required capabilities recover. | PASS |
| `/weave:advance` | Rejected because `weave:advance` was unavailable until required capabilities recover. | PASS |
| `/weave:resume` | Rejected because `weave:resume` was unavailable until required capabilities recover. | PASS |
| `/weave:artifact` | Rejected because `weave:artifact` was unavailable until required capabilities recover. | PASS |
| `/weave:recover-children` | Failed closed: child recovery was unavailable in this session. | PASS |
| `/weave:abort` | Read-only no-op: no active Weave execution existed. | PASS |
| `/weave:clear-children` | Read-only no-op: no terminal child history existed. | PASS |
| Bare `/weave` palette | The visible Start Plan action carried the health-only disabled reason and did not start work. | PASS |
| Primary-agent cycle | Alt+A reported that primary-agent cycling was unavailable in this session. | PASS |
| `weave_delegate` start | Tool absent from both all-tools and active-tools surfaces. | PASS |
| `weave_delegate` retry | Same absent tool surface; no thread identifier existed. | PASS |
| `weave_delegate` continue | Same absent tool surface; no thread identifier existed. | PASS |

The sanitized injected tool surface was `tools=none active=none`. No child RPC process appeared, and no Runtime Store lease became active.

## Restoration and cleanup

The injected process exited. The failure variable was absent from the next process. With the same temporary inspection extension but no duplicate command, a fresh TUI reported:

```text
Weave adapter mode: ready
health-only: false
```

The restored command/tool surface reported one unsuffixed npm-owned `weave:run`; `weave_delegate` was registered and active again. The restored process also passed the pi-vim `INSERT → NORMAL → INSERT` check.

Final checks:

- `weave runtime status` reported Runtime Store schema 5 and `No active lease.`
- Child RPC process count: 0.
- Global Pi session inventory: 943 files, unchanged.
- Workspace pane set: `p79`, `p9V`, `p8W`, `p70`, `p82`, and `p98`, unchanged.
- Global settings, config, npm provenance, installed package, and user sessions were not edited.
- The temporary extension, automation helpers, isolated session directories, and captured terminal data were removed.
- The owned pane remained open.
- `bun run docs:check-links` passed.

## Conclusion

Task 20(n)/21 passes. A single reversible command-ownership failure forced a trusted Pi 0.83 TUI into health-only mode. Read-only diagnostics remained usable, every exposed mutation path was disabled or failed closed, pi-vim continued to work, and normal ready mode returned after restoration with no child process, lease, persistent session change, pane loss, or production-source change.
