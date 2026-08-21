# Spec 33 — Pi child sessions threat model

Status: active. Owner: Pi adapter.
Scope: native child sessions, parent refs, the derivative metadata cache, and the
rendering and diagnostic surfaces defined in
[Spec 33](33-spec-pi-adapter.md) and [ADR 0014](../../adr/0014-pi-native-child-sessions.md).

## Boundary statements

Three statements constrain every mitigation below.

1. **Pi concepts stay in the Pi adapter.** Session identity, session files, entry
   parsing, transcript rendering, and child process control are Pi adapter
   responsibilities. `packages/engine` and `packages/core` never scan the session
   root, never parse Pi output, and receive only opaque command envelopes. A
   mitigation that requires the engine to understand a Pi session is invalid.
2. **The cache is not authoritative.** Parent session entries and child session
   files are the only authority. The SQLite metadata cache is derivative and
   fully rebuildable. No security decision — ownership, authority, retryability,
   deletion — may rest on a cache row.
3. **Runtime fallback has a provider-only context boundary.** Pi's optional
   `runtime-model-fallback` path may compose with trusted context handlers that
   run after Weave. Those handlers receive Weave's filtered provider list. This
   composition is not an isolation boundary against a malicious full-access
   extension, which can inspect or rewrite the same session context and history.

## Threats

### T1 — Forged or spoofed custom refs

**Threat.** An attacker who can write into the parent session file injects custom
entries that look like child refs, pointing at sessions the parent does not own,
or claiming statuses that unlock retry, continue, steering, or delete.

**Mitigation.** Refs are strictly schema-validated with bounded field lengths and
a versioned envelope; validation failure yields `ChildRefInvalid` and the entry is
skipped, never partially trusted. Refs are observation-only: no code path may use
a ref to resurrect, re-authorize, or mutate a child without the authoritative
child session file. Every lifecycle action re-resolves the child session and
re-checks ownership and state against it. Session resolution is root-contained
(T3), so a forged `sessionRef` cannot reach outside the adapter root.

**Owner.** `child-session-refs.ts` (schema, validation, read filtering);
`child-native-sessions.ts` (authoritative resolution); `delegation-tool.ts`
(authority and state checks per run).

### T2 — Fork/clone origin mismatch

**Threat.** A user forks, clones, or copies a parent session. The copy inherits
child refs. The new branch then claims children it does not own, and two parents
race to control or settle the same child.

**Mitigation.** Each ref records `originParentSessionId` and `originEntryId` at
creation; both are immutable. A ref is usable only when its recorded origin equals
the live parent session ID. Mismatched refs are excluded from picker, history, and
every lifecycle action, and confer no history and no authority. Exclusions surface
as `ChildRefOriginMismatch` and are reported to doctor as an informational count,
so silent adoption is impossible. Session-transition pre-hooks additionally settle
owned descendants against the origin session before a transition proceeds, and
never write settlement metadata into the destination session.

**Owner.** `child-session-refs.ts` (origin check and exclusion);
`extension.ts` transition pre-hooks and `delegation-controller.ts` (cancel and
origin write-back); `child-doctor.ts` (reporting).

### T3 — Path traversal and symlink escape

**Threat.** A crafted `sessionRef`, a hostile session ID, or a symlink planted
inside the adapter root causes reads or writes outside
`$XDG_DATA_HOME/weave/adapters/pi/sessions/` — for example overwriting user files
or reading unrelated data through a dangling link.

**Mitigation.** The session root is fixed and never caller-supplied. All refs are
root-relative and resolved through the containment helpers: no-follow,
descriptor-relative I/O with containment verification on every open. Traversal
segments and symlinks that leave the root are rejected with
`ChildSessionRootViolation`; regular files with an external hard link are also
rejected, and a bound leaf that is renamed, replaced, or truncated fails closed.
The adapter rejects rather than repairing or normalizing a hostile path. The same
containment applies to the cache file and to tombstone appends.

Containment covers the whole adapter-owned suffix, not only the final directory.
Every component from `weave/adapters/pi` down — the marker components, the
storage root, and each directory below it — is proven through the descriptor the
no-follow walk just opened: it must be a real directory, owned by the current
user where the platform reports ownership, and carry exactly `0700`. This holds
for components the adapter creates and for components it finds already present,
so a planted or loosened intermediate ancestor fails the open before the root
proof or a launch grant is minted. Components *above* the marker belong to the
user and are proven instead by the trusted-data-root canonicalizer
(`trusted-data-root.ts`). Refusals stay path-free: readiness reports
`pi-session-root-unsafe`.

**Owner.** `path-containment.ts` (primitives); `native-session-fs.ts` (the
no-follow chain and the adapter-owned ancestor proof); `child-native-sessions.ts`
and `child-metadata-cache.ts` (all I/O routed through those primitives).

### T4 — Cache poisoning

**Threat.** An attacker edits or replaces the SQLite cache to fabricate children,
change ownership, flip a status to unlock retry or delete, or hide a real child.

**Mitigation.** The cache is derivative by contract. It is used only to speed
discovery listings; any access to a specific child validates against source, and
disagreement marks the row stale (`ChildCacheStale`) and prefers source. Corrupt,
unreadable, or version-drifted caches enter a typed degraded mode
(`ChildCacheDegraded`) where callers fall back to bounded direct entry scans, and
a full rebuild from parent entries plus session files restores state. The cache
holds metadata only — no transcripts and no parent content — so poisoning cannot
inject content into any view. The file is user-only (`0600`) inside the contained
root, and every query is scoped by workspace and parent lineage keys.

**Owner.** `child-metadata-cache.ts` (validation, staleness, degrade, rebuild,
permissions, scoping).

### T5 — Terminal control injection from child output

**Threat.** Child output contains ANSI or other terminal control sequences —
cursor manipulation, screen clears, OSC title or clipboard sequences, hyperlink
escapes — that corrupt the parent TUI, forge UI chrome, or exfiltrate data through
the terminal.

**Mitigation.** All child-sourced text is sanitized for terminal control sequences
before it reaches any renderer, in both the compact block and the full-screen
overlay, and in picker titles and diagnostics. Fragment selection skips
control-only and whitespace-only fragments, so a control-only burst cannot become
the displayed activity line. Rendering runs through Pi's normal render scheduling
with a failure boundary: a renderer error degrades to a plain native block instead
of leaving the terminal in an unknown state.

**Owner.** `child-compact-render.ts` and `child-overlay.ts` (sanitize-then-render);
`child-session-events.ts` (fragment selection); `telemetry.ts` (diagnostic
sanitization).

### T6 — Parent-context leakage into children, and child-content leakage into the parent

**Threat.** Parent transcript, prompts, or credentials leak into a delegated child
task; or child transcript content leaks into the parent model context, the
Runtime Store, journals, logs, telemetry, or proof artifacts, widening what a
compromised child can read or reveal.

**Mitigation.** Children receive only their explicit task and configured policy;
child UI must not inject parent text or transcript into a child task. In the other
direction, the export boundary is closed: the parent model sees only the bounded
`assistantOutput` projection, optional transfer metadata, and existing numeric
delegation metadata. Raw transcripts, thinking text, prompts and previews derived
from them, tool arguments and results, images, steering and follow-up text,
extension UI payloads, session paths, and raw RPC bodies never cross that
boundary. Refs and cache rows hold metadata only, so neither persistence layer can
become a leakage channel.

**Owner.** `delegation-controller.ts` (projection and settlement export);
`child-session-refs.ts` and `child-metadata-cache.ts` (metadata-only schemas);
`child-overlay.ts` (input isolation between overlay and primary editor).

### T7 — Session file permissions

**Threat.** Child transcripts are readable or writable by other local users, or a
pre-existing world-writable directory at the root path lets another user inject or
alter session content.

**Mitigation.** The adapter creates the session root, per-child directories, and
the cache with user-only permissions: directories `0700`, files `0600`. Unsafe
permissions on the root, a directory, or a file are reported as
`ChildSessionPermissionError` rather than being used, and the doctor permission
check makes the condition discoverable. Session creation must succeed under these
constraints before a child task starts; the adapter never falls back to an
ephemeral non-persistent child when persistence fails.

**Owner.** `child-native-sessions.ts` (creation modes and permission checks);
`child-metadata-cache.ts` (cache file mode); `child-doctor.ts` (permission check).

### T8 — Sensitive content in diagnostics

**Threat.** Error messages, doctor reports, health output, or acceptance proofs
embed raw prompts, task text, or transcript fragments, exporting private content
to logs, CI output, or committed artifacts.

**Mitigation.** Diagnostics carry stable codes plus child, run, parent, and
correlation IDs only. A central diagnostic registry validates shapes, and a
sanitizer defensively strips transcript-like fields before emission. Diagnostics
and results expose no filesystem path except behind an explicit diagnostic flag,
and no native session path at all. The doctor report is returned to the caller
only; the adapter writes no standalone log file. Proof and smoke artifacts follow
the same rule: no raw prompt or transcript content.

**Owner.** `errors.ts` (code registry and shapes); `telemetry.ts` (sanitizer);
`child-doctor.ts` (report assembly); `adapter-cli-commands.ts` (output redaction).

### T9 — Runtime fallback context and lifecycle confusion

**Threat.** A provider failure could cause Weave to remove the wrong message,
join failed partial output to a successful retry, add a synthetic provider user
message, or claim one uninterrupted low-level run. A later extension could also
misread the hidden recovery marker or receive unfiltered context.

**Mitigation.** Pi completes native retry, overflow-compaction, and queued-message
recovery before its payloadless `agent_settled`; Weave then keeps its visible
child, tool, and session pending while it starts a new low-level run in the same
process and native session. Recovery dispatch requires the exact custom marker's
`message_start` and a bounded timeout. The provider-only `context` clone removes
only the immediately preceding failed assistant and its exact marker after
bounded fingerprint and token checks. Both entries remain in durable history; no
synthetic provider user message is created, and fallback output remains a
separate assistant entry. Later context handlers are trusted composition partners
and receive the filtered list. A malicious full-access extension is outside this
isolation guarantee.

**Owner.** `model-failover-coordinator.ts` and `model-failover-context.ts`
(marker, fingerprint, context repair, and timeout); `extension-impl.ts`
(public lifecycle routing and settlement deferral); `child-session-events.ts`
and `child-overlay-search.ts` (hidden-marker suppression);
`model-failover-record.ts` (durable event validation).

## Residual risks

- A local user with the ability to write as the Weave user can still alter parent
  entries and session files. That user already has the account's authority; the
  mitigations above bound blast radius (schema validation, origin checks,
  containment) but do not defend against a compromised account.
- No automatic pruning means child sessions accumulate until explicit cleanup.
  Disk growth and long-lived transcript retention are user-managed concerns,
  documented rather than mitigated in code.
- Prior JSONL child history is not migrated and not deleted. Any sensitive
  content in those files remains on disk under the user's control.

## Related contracts

- [Spec 33 — Pi adapter](33-spec-pi-adapter.md)
- [Spec 33 smoke checklist](33-smoke-checklist.md)
- [ADR 0014 — Pi Native Child Sessions](../../adr/0014-pi-native-child-sessions.md)
- [Adapter boundary](../../architecture/adapter-boundary.md)
