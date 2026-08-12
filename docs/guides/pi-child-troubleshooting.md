# Troubleshoot Pi Child Sessions

Use this guide when a delegated Pi child fails to start, fails to settle, or cannot be inspected. Every step here is read-only unless it says otherwise.

**Related:** [Pi Adapter](../adapters/pi.md) · [CLI](../reference/cli.md#weave-adapter) · [Delegation](../reference/delegation.md) · [Adapter Capabilities](../reference/adapter-capabilities.md)

---

## Start here

1. Run `/weave:health` in the Pi TUI. A required capability gap puts the generation into health-only mode, which blocks delegation.
2. Run `/weave:doctor`. It prints the report status and each of the seven storage checks.
3. Outside the TUI, run `weave adapter pi doctor --json` for the same report in machine form.

Health-only mode still allows read-only inspection: `/weave:history` and `/weave:doctor` keep working while delegation stays blocked.

## Read the doctor report

| Check | Meaning of a failure |
| --- | --- |
| `doctor.capabilities` | A required host surface is missing. The detail reads `ok=<n> degraded=<n> unavailable=<n>`, with code `RequiredCapabilityUnavailable`. |
| `doctor.permissions` | A storage directory is not `0700` or a file is not `0600`. |
| `doctor.sessions` | The session tree is unreadable, or a session header is missing, unsupported, or bound to a different parent. |
| `doctor.refs` | A parent child reference is invalid or its recorded origin does not match this session. |
| `doctor.cache` | The metadata cache is unopenable, corrupt, or on a different schema version. |
| `doctor.stale` | Recorded children no longer resolve to a readable session. |
| `doctor.orphans` | Children have lost their parent session. |

The report status is `ok` when nothing fails, `degraded` when any check fails, and `unavailable` when every check is skipped. Scans are bounded to 50 rows and details carry counters only, never child text.

## Diagnostic codes

| Code | Cause | What to do |
| --- | --- | --- |
| `RequiredCapabilityUnavailable` | The host lacks a `required-for-delegation` surface | Upgrade Pi to at least `0.81.1` and re-check `/weave:health` |
| `RequiredCapabilityUnavailable` with reason `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable` | Pi's native create/open API, the private session root, or the Pi process surface did not pass readiness | Use `/weave:health` to identify the closed reason. Verify Pi 0.84.1, private `0700` data directories, and a runnable `pi` command. Read-only status, health, history, inspection, doctor, list, and show still work |
| `PersistentParentSessionRequired` | The parent Pi session is not persistent, typically `--no-session` | Restart Pi with a persistent session; child surfaces stay read-only until then |
| `ChildSessionRootViolation` | `XDG_DATA_HOME` is relative or empty, or a path component is unsafe | Set `XDG_DATA_HOME` to an absolute path, or unset it to use `~/.local/share` |
| `ChildSessionPermissionError` | A storage directory or file has permissive modes | Restore `0700` on directories and `0600` on files under the storage roots |
| `ChildSessionMissing` | A referenced child session is gone from disk | Inspect with `weave adapter pi children show <id>`; delete the reference with `children delete <id>` if it is no longer wanted |
| `ChildSessionCorrupt` | A session is unreadable, missing its header, on an unsupported version, or bound to another parent | Do not guess a resume; retry the thread or tombstone the child |
| `ChildTombstoneAppendFailed` | The append-only tombstone file could not be extended | Check permissions and free space on the session root |
| `ChildRefInvalid` | A parent child reference does not parse | Run `/weave:doctor` again after the next delegation; the cache rebuilds from valid references |
| `ChildRefOriginMismatch` | The session was forked or cloned, so the reference belongs to another origin | Expected after a fork or clone; the mismatched reference is excluded, not adopted |
| `ChildCacheDegraded` | The metadata cache could not open or validate | Nothing is lost: reads fall back to parent references. Delete the cache file to force a rebuild |
| `ChildCacheStale` | Cached rows no longer match their source | Rebuilds on the next successful read |
| `ChildResponseMissing` | A run settled with no terminal assistant response | Retry the thread; the recorded session is intact |
| `ChildOrphanReadOnly` | The child's parent session is gone | Read the child, then tombstone it if you no longer need it |
| `ThreadAlreadyRunning` | A `retry` or `continue` targeted a running thread | Wait for settlement, or cancel the subtree first |
| `ThreadStale`, `ThreadIntegrityError`, `ThreadNotRetryable` | The thread cannot be reused as requested | Start a new thread |

## Inspect one child

```bash
weave adapter pi children list
weave adapter pi children show <id>
weave adapter pi children show <id> --cursor <c>
```

`list` returns the newest 50 children for the workspace, including tombstoned rows. `show` returns bounded metadata plus the newest 100 native entry descriptors and a `nextCursor` for older pages.

Add `--diagnostic` only when you need filesystem paths. Without it, absolute paths are replaced with `[path omitted]` and the `sessionPath` field is dropped. Add `--json` for stable machine output.

## Remove a child

```bash
weave adapter pi children delete <id>
weave adapter pi children delete <id> --yes
```

Deletion appends a tombstone. It never rewrites or truncates stored data, and the row stays visible marked `tombstoned`. Without `--yes` the command prompts and defaults to no. In a non-interactive terminal, `--yes` is required.

Nothing else deletes child data. The adapter runs no retention timer, prunes nothing on a schedule, and enforces no byte quota, so storage shrinks only when you tombstone a child or clear terminal records with `/weave:clear-children`.

## Recover interrupted children

`/weave:recover-children` recovers interrupted top-level children when `recovery_enabled` is true. It does not recursively recover nested children, does not recover a workflow process, and does not continue a workflow. A workflow resume is a separate, explicitly authorized `/weave:resume`.

## Overlay keys do not work

Weave never overwrites an existing binding. If an overlay key is already bound in your effective Pi keybindings, the adapter skips its own binding and reports:

```
weave overlay action <id> skipped key <key>: already bound to <owner>
```

Rebind the action under `settings.adapters.pi.child_inspection.keys`, keyed by action id (`weave.child.picker.open`, `weave.child.slot.1` through `weave.child.slot.9`, `weave.child.sibling.previous`, `weave.child.sibling.next`). The map is strict: an unknown action id or malformed key is a validation error.

If Escape appears to do nothing, remember it is a two-step control: press it twice within 750 ms to reach the confirmation, which defaults to `Keep running`.

## Upgrading from the JSONL child-history store

There is no migration. Weave does not read, convert, quarantine, or delete the old `child-history/<parent-session-id>/` files; they stay on disk and are invisible to Weave. Remove them yourself if you want the space.

Configuration that still sets `persist_history`, `max_bytes_per_child`, `max_bytes_total`, or `orphan_retention_days` fails validation, because `settings.adapters.pi.child_inspection` is strict. Delete those fields.
