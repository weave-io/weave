# Task 11 evidence — real-harness verification of the Pi Codex subscription fast mapping

Plan: `.weave/plans/pi-codex-subscription-fast-mode.md`, Task 11.
Guide: [`docs/testing/adapter-verification.md`](../../docs/testing/adapter-verification.md).

- **Date**: 2026-08-18 (America/New_York), 04:05–04:50 EDT (`08:05Z`–`08:50Z`).
- **Worktree**: `<worktree>` = the `pi-codex-subscription-fast-mode` checkout, branch
  `tapestry/pi-codex-subscription-fast-mode`, HEAD `930deb13f39aa062e39aa0157dea02c8be7a7af5`, clean
  before and after (`git status --porcelain` empty; `dist/` is ignored).
  *(Metadata correction, 2026-08-18: this line first named the branch
  `feat/pi-native-child-stream-rendering`, which is the main `weave` checkout's branch, not this
  worktree's. `git branch --contains 930deb1` resolves to
  `tapestry/pi-codex-subscription-fast-mode`. Only the branch name was wrong; the HEAD, the
  cleanliness claim, and every measurement below are unchanged.)*
- **Loading method**: approved local development — global symlink
  `~/.pi/agent/extensions/weave-adapter-pi` pointed at `<worktree>/packages/adapters/pi`, with
  `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` exported by the local launcher only (already
  present before this task; unchanged).

## Verdict

| Stage (adapter-verification) | Result |
| --- | --- |
| 1. Build the public artifact | **Pass** |
| 2. Install that exact artifact | **Pass** |
| 3. Restart the harness | **Pass** |
| 4. Prove loading and readiness | **Pass** |
| 5. Exercise real behavior | **Fail — blocker** |

**Superseded by §9.** This verdict describes the 04:05–04:50 EDT run against HEAD
`930deb1`. It stands as the audit trail for why the remediation exists. The passing rerun
against HEAD `19c2b9a` is recorded in [§9](#9-rerun-after-the-host-subpath-remediation).

**Task 11 was not complete after this run and stayed unchecked.** Stage 5 did not merely fail to accelerate: on the
first-party transport the adapter put `service_tier: "priority"` on the wire **without** the
`originator: codex_cli_rs` / `x-codex-routing-hint` pair, which is the partial fast request the
spec's rule 8 forbids, and it reported `unsupported (harness-seam-unavailable)` for those same
attempts. Root cause is identified below and is reproducible.

## 1. Host, versions, and provenance

| Item | Value |
| --- | --- |
| Pi host | `@earendil-works/pi-coding-agent` 0.84.2 at `~/.bun/install/global/node_modules/...` |
| Host `pi-ai` | `@earendil-works/pi-ai` 0.84.2 (same global root) |
| Runtime | Bun (launcher runs the host CLI under Bun) |
| Adapter package | `@weaveio/weave-adapter-pi` 0.0.1, loaded from the symlinked worktree |
| `pi list` | 8 npm user packages, all under `~/.pi/agent/npm/node_modules`, no load error |
| Command provenance | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` (local development only) |

Digests of the built artifact (`bun scripts/build-public-packages.ts`, clean `dist/`):

| File | SHA-256 |
| --- | --- |
| `packages/adapters/pi/dist/extension.js` | `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` |
| `packages/adapters/pi/dist/extension-impl.js` | `babc14dbf799a144af72dde6b32c52b26d53dc5d3efdf4d1b28a0cc0cbd66094` |
| `packages/adapters/pi/dist/index.js` | `b5897c854d6dbf8068986718f300f7eb5c50d1e30a01463f5df4b047a88be857` |
| `packages/adapters/pi/dist/cli.js` | `1d06b40e826e92869936a7e8040d3f9fe754a236b21fdf99e1298725d8ec35f2` |
| `packages/adapters/pi/dist/host-module-loader.js` | `2517b782652dc9d2ee1b8b5d1395bf8d3c46be8322ce816c5bce448bd6d0648f` |

The installed entry point read through the symlink hashed to the same
`39204d15…`, so the inspected bytes and the loaded bytes are the same file.

`bun run verify:pi-host-singleton` — run before the live session and again after restoration:

```
PASS hostVersion=0.84.2 artifactSha256=39204d15…44bf381aae
     positive=single-copy negative=duplicate-detected
```

Bundle content markers in `extension-impl.js`: `codex_cli_rs` (1), `x-codex-routing-hint` (1),
`https://chatgpt.com/backend-api` (1), allowlist rule ids `codex-sub-01`…`codex-sub-07` (7 distinct).

## 2. Fixture and instrumentation (temporary, `/tmp` only)

| Artifact | Purpose | SHA-256 |
| --- | --- | --- |
| `/private/tmp/weave-task11-proof/.weave/config.weave` | project fixture: `fast true` on `loom` (`openai-codex/gpt-5.6-sol#low`) and `shuttle` (`openai-codex/gpt-5.6-luna#low`), no `fast` on `tapestry`, one single-step workflow `task11-direct` | `5036427a1d47a73e928cabd7b679bf8e70e99f913705ce9d357c39bbd03a795c` |
| `/private/tmp/weave-task11-proof/.pi/extensions/task11-capture.ts` | outgoing-request capture: wraps `globalThis.fetch`, records only booleans/enums/counts for ChatGPT-backend requests, zstd-decodes the body solely to classify `service_tier` | `6eeadaebf0d07e32b977547054f523b36e0fd35b1b5f023be2dd2ec6e3d75bd5` |
| `/private/tmp/weave-task11-probe/probe.ts` | diagnostic positive control: a Weave-shaped provider wrapper | `3760a94985effb08c7c63d1835538579a6089a02892d5c24377774fe40db7b0e` |
| `/private/tmp/weave-task11-probe/observer.ts` | diagnostic: wraps the provider Weave registered | `51be48bde8a384eb349f6b8ce0486f053bca65b2cc8f0a44c1e709f0c8abf0fc` |
| `/private/tmp/weave-task11-probe/gateway-target.ts` | local capture target for the gateway control | `99911f247e1381886c8005ebb46144dcd2be49534457505da067c08c8784e8dd` |

The capture is instrumentation, not a log grep: it observes the request object the host is about to
send. It never records `Authorization`, account ids, JWTs, other header values, bodies, prompts, or
response text. A self-test with deliberately planted secret-shaped literals produced records
containing none of them.

Nothing was installed globally for instrumentation: the capture is a project-local
`.pi/extensions` file inside the `/tmp` fixture, and the diagnostics were loaded with `-e` only.

Controlled confound: the unrelated user extension `~/.pi/agent/extensions/fast-mode.ts` can inject
`service_tier` — but only when explicitly toggled on (default off, `--fast` not passed) and only for
provider `openai`, never `openai-codex`. It cannot explain any observation below, and the decisive
runs used `-ne` (no extension discovery) anyway.

## 3. Stage 3–4: fresh interactive TUI, loading and readiness

Fresh Herdr tabs with an isolated cwd were used for every host; all created panes were closed
afterwards. Hosts were interactive TUIs (`pi --verbose --provider openai-codex --model gpt-5.6-sol`);
print and RPC modes were never used as substitutes.

Startup inventory (154 captured lines) shows both extensions loading and no load error:

```
[Extensions]
  project
    <fixture>/.pi/extensions/task11-capture.ts
  user
    …
    ~/.pi/agent/extensions/weave-adapter-pi/dist/extension.js
    …
```

`/weave:health`:

```
Weave adapter mode: ready
…
provider-fast-activation: unsupported (declared degraded)
host runtime: single-copy; redirected 3
child inspection: native-overlay
```

`/weave:status`:

```
generation: <uuid>
trust: trusted
mode: tui
health-only: false
fast: unsupported (harness-seam-unavailable)
children: 0
```

The declared ceiling is `degraded` (Task 8) and the runtime status is `unsupported`, which is the
hook-seam fallback the adapter reports when no Codex attempt snapshot exists.

## 4. Stage 5: real behavior — failure

### 4.1 Fast-declared primary generation (first-party transport)

Four generations across two fresh hosts with `loom` (`fast true`, `gpt-5.6-sol`, allowlist rule
`codex-sub-06`). Every one produced a completed answer and this outgoing request shape:

| Field | Observed |
| --- | --- |
| host | `chatgpt.com` |
| method / path tail | `POST` / `responses` |
| `originator` is `codex_cli_rs` | **false** |
| `originator` is `pi` | true |
| `x-codex-routing-hint` present | **false** |
| body `service_tier` | **`priority`** |

Two of those four were captured after the capture gained zstd body decoding, so the
`service_tier: "priority"` value is read from the actual outgoing (compressed) body, not inferred.

Reported state for those same attempts, in the TUI and in the durable journal:

```
fast: unsupported (harness-seam-unavailable)
[WARN] [adapter/pi] provider-fast.unsupported state="unsupported" evidenceKind="none"
       evidenceOutcome="absent" reason="harness-seam-unavailable"
```

That is a two-part failure:

1. **On the wire**: the body carries the mapping's control while neither routing header is present.
   Spec rule 8 ("one attempt carries both parts or neither") is violated, and the wrapper's own
   fail-closed guard for this case (decline / block the request) never runs, because that guard
   lives inside the wrapper's `fetch`, which is never called.
2. **In the report**: `/weave:status` and the journal say no control was sent. The snapshot is
   never emitted at all, so the honest terminal state expected by the plan
   (`not-confirmed` / `standard`) is unreachable, and so is `requested`. The adapter under-reports
   what it actually did.

`applied` was never claimed anywhere, and no positive tier evidence was observed.

### 4.2 No-intent control after fast-on (same process)

`Alt+A` switched the primary to `tapestry` (no `fast`), then one generation ran.

- `/weave:status` after it printed **no `fast:` line at all** — no acceleration state, as required.
- The journal recorded `usage.observation-recorded source="primary" agentName="tapestry"` with **no**
  `provider-fast.*` event, while every `loom` turn produced one.
- The control generation produced **no ChatGPT-backend fetch record**, because with no intent the
  native transport is left alone and the host used its default (`auto`, which prefers WebSocket).
  Fast-declared turns, by contrast, always produced an SSE `POST` — the adapter's forced `sse` is
  visible in that difference.
- Across every capture file in this task, **zero** requests carried `originator: codex_cli_rs` or
  `x-codex-routing-hint` from the adapter, so no stale routing identity survived a fast-on turn.
  The capture is proven able to see those headers when present: the positive control in §4.5 shows
  them set on a request from the same host, account, and model.

### 4.3 Ordinary delegated child and direct workflow step

Both surfaces were exercised with a `fast true` child (`shuttle`, `gpt-5.6-luna`, rule
`codex-sub-05`).

| Check | Result |
| --- | --- |
| `weave_delegate` child settled | Yes — `COMPLETED … run 1 · settled · 4.5s · 21.9k tok`, child returned its token |
| Direct workflow step (`/weave:run task11-direct`) | Yes — `Workflow task11-direct-… is now completed at step probe` |
| Child process remained | No — only the host process remained in the fixture cwd after each run |
| `weave runtime status` | `No active lease.`; workflow instance `Status: completed` |
| Child-side outgoing request | Same defect: `service_tier: priority`, `originator: pi`, no routing hint (ordinary child and direct-step child alike) |

An earlier direct-step attempt failed with `The dispatched step settled without a structured
completion candidate` because the first fixture prompt never called `weave_complete_step`. That was
a fixture defect, not an adapter defect; the prompt was corrected and the step then settled. That
aborted run left an active lease and a `running` instance until the store was reset for the final
run; the final, correctly completing run ended with no active lease.

### 4.4 Gateway negative control (`models.json` baseUrl override)

Run in an **isolated** config directory (`PI_CODING_AGENT_DIR`) so the shared global
`~/.pi/agent/models.json` was never modified — other sessions were live on this machine. The
isolated `models.json` added `providers["openai-codex"].baseUrl = http://127.0.0.1:8791/backend-api`,
pointing at a local capture target.

| Check | Result |
| --- | --- |
| Adapter classification | `fast: unsupported (transport-not-first-party)` in `/weave:status` |
| Durable journal | `provider-fast.unsupported … reason="transport-not-first-party"` |
| What reached the local target | `originator: pi`, **no** routing hint, no acceleration control |
| Global `~/.pi/agent/models.json` | untouched, SHA-256 unchanged (`aac725c4…`) |

This is the one part of the mapping that behaves exactly as specified: a non-first-party effective
transport suppresses the mapping and is reported with its bounded reason. It also proves the
eligibility path runs with the intent visible — the classifier reached rule 4, which is past the
intent rule.

### 4.5 Root cause

Diagnostics, in order:

1. **The registered provider is invoked.** An observer extension wrapped the provider Weave had
   registered (`getRegisteredNativeProvider("openai-codex")`) and saw a real generation flow through
   it (`observer-invoked`, `observer-payload`).
2. **A Weave-shaped probe works on this host.** A disposable probe that wraps
   `openaiCodexProvider()`, chains `onPayload`, sets `service_tier: "priority"`, forces
   `transport: "sse"`, and writes the two routing headers from `options.fetch` produced, on the same
   host, account, and model:
   `originator` was `pi` before the write and `codex_cli_rs` after it, with a shape-valid
   `x-codex-routing-hint` naming an allowlisted model. Audit rows A2, A9, A11, and A12 therefore
   still hold on 2026-08-18.
3. **Weave's own `fetch` is never called.** In the observer run, Weave's wrapper never called the
   observer's `fetch`, yet the request went out over SSE with a `priority` body.
4. **The wrapper does not use the host's `pi-ai`.** The bundle keeps
   `@earendil-works/pi-ai/providers/openai-codex` external. Resolved from the built extension's
   directory, that specifier resolves to the **checkout's** `@earendil-works/pi-ai` **0.81.1**, not
   the host's 0.84.2:

   ```
   $ (from <worktree>/packages/adapters/pi/dist)
     import.meta.resolve("@earendil-works/pi-ai/providers/openai-codex")
   → …/node_modules/.bun/@earendil-works+pi-ai@0.81.1+…/dist/providers/openai-codex.js
   ```

5. **0.81.1 has no `fetch` seam.** Its codex responses api calls the global fetch directly
   (`response = await fetch(resolveCodexUrl(model.baseUrl), {…})`), while the host's 0.84.2 calls
   `await (options?.fetch ?? globalThis.fetch)(…)`. This is exactly audit row A20, which recorded
   that `options.fetch` on the codex SSE path first appears in pi-ai 0.83.0.

Chain: the wrapper builds its native provider from pi-ai 0.81.1 → that api honors `onPayload` and
`transport` (so the body gains `service_tier: "priority"` and SSE is forced) but ignores
`options.fetch` → the routing pair is never written, the attempt correlator is never advanced, no
snapshot is emitted, and the request is sent anyway.

Two shipped guards did not prevent this:

- **The OD-4 version gate probes the wrong thing.** `registerCodexFastProvider` gates on the host's
  public `VERSION` export (0.84.2, passes) while the provider it actually wraps comes from a
  different, older pi-ai copy.
- **The host-module redirect covers package entry paths only.** It installs an exact-path filter per
  bare specifier, so `@earendil-works/pi-ai/providers/openai-codex` escapes it.
  `bun run verify:pi-host-singleton` reports `PASS` / `single-copy` for the same reason: it proves
  the three bare specifiers, not subpath imports.

Scope of the claim: this is proven for the approved local-development loading path (symlinked
worktree with its own `node_modules`). A packaged npm install resolves peers from the install root
and may resolve the subpath to the host copy; that path was **not** tested here, so no claim is made
about it. Either way, the defect classes are real: a fail-open partial request, an under-reported
state, a version gate that checks a package other than the one in use, and a redirect proof that
does not cover subpath imports.

## 5. Sanitization

Everything recorded here is a hash, an enum, a boolean, a count, or an adapter-owned literal
(`codex_cli_rs`, `x-codex-routing-hint`, `service_tier`, `priority`) that the adapter would itself
write. No token, account id, JWT, `Authorization` value, raw body, prompt, or model response text was
captured or stored. A regex scan for `authorization`, `bearer`, `sk-…`, `eyJ…`, account ids, api
keys, and refresh tokens over every captured artifact returned only the deliberately fake literals
inside the `/tmp` self-test fixture (never committed) and the boolean field name `hasApiKey`.

Raw sanitized captures stayed under `/tmp` (`/private/tmp/weave-task11-capture`,
`/private/tmp/weave-task11-probe`) and are transient by design.

## 6. State restored

| Item | Before | After |
| --- | --- | --- |
| `~/.pi/agent/extensions/weave-adapter-pi` | → `~/projects/weave/packages/adapters/pi` | restored to the same target |
| `~/.pi/agent/trust.json` | `5ba0fc38387b1a00639e5a7911b34731835daa80248acf46161c091dc95c15e8` | byte-identical (`cmp` clean); the one fixture key added at the start was removed |
| `~/.pi/agent/models.json` | `aac725c4b3d865a8ac098f9fa3d18030f8558838fa57438f60b05e339fc011c3` | unchanged (never written; the gateway control used an isolated config dir) |
| `~/.pi/agent/bin/pi` (launcher) | `c7649907a34aea371063932324a613a6fb2add4cd1ed01d50c7b54807d596d6a` | unchanged (the unsafe-provenance export was already present) |
| `~/.weave/config.weave` | `9a7939c3cd2f7c6c8fa1ad3d7aa6d402ce92f5a1d71c7824afb4fdeeda7b3974` | unchanged |
| `~/.pi/agent/settings.json` | — | **not written by this task.** A concurrent session changed its default provider/model at 04:05 EDT; that change was deliberately left alone rather than clobbered, and the proof hosts passed `--provider` / `--model` explicitly. |
| Auth state | — | untouched; no credential was read, written, or recorded |
| Herdr panes | — | every tab created by this task was closed |
| Proof processes | — | none remain; `weave runtime status` in the fixture reports `No active lease.` |

Backups taken before any change: `/tmp/weave-task11-backup-20260818T080500Z/` (settings, models,
launcher, symlink target, global config, trust).

Post-restoration checks:

- `bun test packages/adapters/pi/src` → **3699 pass, 0 fail** (163 files).
- `bun run verify:pi-host-singleton` → **PASS**, same artifact digest.
- `git status --porcelain` → empty apart from this evidence commit.

## 7. What must happen before Task 11 can pass

1. Make the wrapper use the proven host `pi-ai` for the provider subpath, or refuse to register when
   the pi-ai copy it would wrap is not the host's (and not ≥ 0.83.0).
2. Make the mapping fail closed when header authority cannot be established: a body this adapter set
   to `service_tier: "priority"` must never reach the network without the routing pair, including
   when `options.fetch` is ignored rather than called.
3. Emit a bounded terminal snapshot for an eligible attempt that never reached `requested`, so
   `/weave:status` and the journal cannot silently report the hook-seam fallback for an attempt that
   really sent a control.
4. Extend the host-runtime proof (or add a sibling proof) to subpath imports, so
   `verify:pi-host-singleton` cannot report `single-copy` while a subpath loads a different copy.
5. Re-run all five stages, including the fast, control, gateway, delegation, and direct-step probes
   in this note.

## 8. Remediation (2026-08-18, later the same day)

The failure record above stands as written. This section records what was
changed in response to it. **Task 11 remains unchecked**: the five stages have
not been re-run, and nothing here is a substitute for them.

### What changed

1. **The closed host-module proof set now has four members.**
   `@earendil-works/pi-ai/providers/openai-codex` joins the three package
   entries as a distinct exact specifier, with its own host resolution, local
   resolution, exact-path `onLoad` override, and proof entry. A subpath
   resolves to its own file, which is exactly why redirecting the `pi-ai`
   package entry proved nothing about it (§4.5, item 4).
2. **Registration now demands positive provenance for that exact module.**
   `registerCodexFastProvider` gains a `readProviderModuleProvenance` probe and
   evaluates it after the host-version floor and *before* the dynamic import.
   Only `host` / `redirected` and `host` / `already-host` allow registration.
   `no-local-copy`, `host-root-unproven`, `host-package-mismatch`,
   `local-path-unsafe`, `plugin-unavailable`, `redirect-disabled`,
   `specifier-unknown` (the bare-package-only proof), `outcome-missing`, and a
   throwing probe all register nothing, import nothing, and report the bounded
   token `provider-module-unproven` with a bounded `provenance` reason. Because
   nothing is registered, the host keeps its native provider and no `onPayload`
   of this adapter's can run — which is the terminal, bounded answer to §7
   items 1 and 2 at the registration seam.
3. **`verify:pi-host-singleton` can no longer print PASS over this gap.** The
   evaluator now requires every closed specifier to appear in the proof line
   (`proof-incomplete` otherwise) and requires the codex subpath's effective
   resolution — `loadedFrom` when redirected, `bareResolution` when not — to be
   a file under the host root, with the new verdict `subpath-not-host`.
4. **Health output stays bounded and path-free.** The line is unchanged in
   shape; only its truthful ceiling moved from 3 to 4
   (`host runtime: single-copy; redirected 4`).

### Checks run for the remediation

| Check | Result |
| --- | --- |
| `bun test packages/adapters/pi/src scripts/pi` | **3746 pass, 0 fail** (164 files) |
| `bun run typecheck` | pass |
| `bun run lint` | pass; 362 warnings / 71 infos, identical to the pre-change baseline |
| `bun scripts/build-public-packages.ts` | pass |
| `bun run docs:check-links` | pass |
| `bun run verify:pi-host-singleton` | **PASS** `hostVersion=0.84.2 positive=single-copy negative=duplicate-detected` |

The real-process proof line from that run shows the previously escaping module
redirected, in the same worktree whose checkout copy caused the failure:

```
@earendil-works/pi-ai/providers/openai-codex
  bareResolution  <worktree>/node_modules/.bun/@earendil-works+pi-ai@0.81.1+…/dist/providers/openai-codex.js
  loadedFrom      <host root>/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js
  redirected      true
```

New unit coverage reproduces the exact old shape — host `0.84.2` with an
unproven provider subpath — and proves registration is refused before the
import, with no wrapped provider and no native provider even constructed.

### Still outstanding for Task 11

Items 3 and 5 of §7 are untouched by this commit: no terminal snapshot is
emitted for an eligible attempt that never reached `requested` beyond the
existing hook-seam fallback, and the five stages must be re-run in full,
including the fast, control, gateway, delegation, and direct-step probes.

## 9. Rerun after the host-subpath remediation

- **Date**: 2026-08-18 (America/New_York), 05:23–06:05 EDT (`09:23Z`–`10:05Z`).
- **Source**: HEAD `19c2b9a926a5440d40d68fd0f9d19dcadb0a1b71` on branch
  `tapestry/pi-codex-subscription-fast-mode`, `git status --porcelain` empty before the run
  (`dist/` is ignored).
- **Loading method**: unchanged from §1 — the global symlink
  `~/.pi/agent/extensions/weave-adapter-pi` repointed at `<worktree>/packages/adapters/pi` for the
  run and restored afterwards, with `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` exported by the
  local launcher only (already present; never written by this task).
- **Relation to §4**: nothing here reuses the failed run. Every stage was executed again from a
  clean build in fresh interactive TUI processes.

### Verdict

| Stage (adapter-verification) | Result |
| --- | --- |
| 1. Build the public artifact | **Pass** |
| 2. Install that exact artifact | **Pass** |
| 3. Restart the harness | **Pass** |
| 4. Prove loading and readiness | **Pass** |
| 5. Exercise real behavior | **Pass** |

**Task 11 is complete.** The wrapped provider now writes both parts of the Codex Fast Mode contract
on the same outgoing attempt in all three surfaces, and reports the honest terminal
`not-confirmed` — never `applied` — because no same-attempt priority evidence was observed.

### 9.1 Stages 1–2: build and installed bytes

`rm -rf packages/adapters/pi/dist && bun scripts/build-public-packages.ts`:

| File | SHA-256 |
| --- | --- |
| `packages/adapters/pi/dist/extension.js` | `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` |
| `packages/adapters/pi/dist/extension-impl.js` | `a1e64cd336dc713dc65d955eea0dcccacec13782950972c1c373b44c7398e933` |
| `packages/adapters/pi/dist/index.js` | `b5897c854d6dbf8068986718f300f7eb5c50d1e30a01463f5df4b047a88be857` |
| `packages/adapters/pi/dist/cli.js` | `1d06b40e826e92869936a7e8040d3f9fe754a236b21fdf99e1298725d8ec35f2` |
| `packages/adapters/pi/dist/host-module-loader.js` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |

`extension.js` read back through the installed symlink hashed to the same `39204d15…`, so the
inspected bytes and the loaded bytes are one file. The final validation rebuild at the end of the
task reproduced all five digests exactly.

`bun run verify:pi-host-singleton`, run before the live session and again after restoration:

```
PASS hostVersion=0.84.2 artifactSha256=39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae
     positive=single-copy negative=duplicate-detected
```

The opt-in proof line from a real `pi --mode rpc` process
(`WEAVE_PI_HOST_MODULE_PROOF=1`, host paths redacted) carries **all four** closed specifiers, and
the codex subpath — the exact module that caused the §4.5 failure — now loads from the host copy:

```
@earendil-works/pi-coding-agent
  bareResolution  <worktree>/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1+…/dist/index.js
  loadedFrom      <host root>/dist/index.js                         redirected true
@earendil-works/pi-ai
  bareResolution  <worktree>/node_modules/.bun/@earendil-works+pi-ai@0.81.1+…/dist/index.js
  loadedFrom      <host node_modules>/@earendil-works/pi-ai/dist/compat.js               redirected true
@earendil-works/pi-tui
  bareResolution  <worktree>/node_modules/.bun/@earendil-works+pi-tui@0.81.1/dist/index.js
  loadedFrom      <host node_modules>/@earendil-works/pi-tui/dist/index.js               redirected true
@earendil-works/pi-ai/providers/openai-codex
  bareResolution  <worktree>/node_modules/.bun/@earendil-works+pi-ai@0.81.1+…/dist/providers/openai-codex.js
  loadedFrom      <host node_modules>/@earendil-works/pi-ai/dist/providers/openai-codex.js
  redirected      true
```

Host: `@earendil-works/pi-coding-agent` 0.84.2 with `@earendil-works/pi-ai` 0.84.2, run under Bun by
the local launcher.

### 9.2 Stage 3: fresh interactive TUIs and fixtures

Every host was a fresh interactive TUI (`pi --verbose --provider openai-codex --model gpt-5.6-sol`)
started in its own Herdr tab with an isolated `/tmp` cwd. Print and RPC modes were never used as a
substitute; the only RPC process was `verify:pi-host-singleton`'s own module proof. Both created
tabs were closed at the end. Temporary fixtures (all under `/tmp`):

| Artifact | Purpose | SHA-256 |
| --- | --- | --- |
| fixture A `.weave/config.weave` | `fast true` on `loom` (`openai-codex/gpt-5.6-sol#low`) and `shuttle` (`openai-codex/gpt-5.6-luna#low`), no `fast` on `tapestry`, one single-step workflow `task11-direct` | `5036427a1d47a73e928cabd7b679bf8e70e99f913705ce9d357c39bbd03a795c` |
| fixture A `.pi/extensions/task11-capture.ts` | outgoing-request capture: wraps `globalThis.fetch`, records only booleans/enums/counts for ChatGPT-backend requests, zstd-decodes the body solely to classify `service_tier` | `5fc7ea5f759a7c404e14317384fd8dce4740f256aa5106ea179f99a5ee8d325e` |
| fixture B `.weave/config.weave` | same, with a direct-step prompt that both calls `weave_complete_step` and returns a terminal assistant line | `2ff2995171f6acee3eeb81ed69a9a2865f72593a087729a6c4be0274e1c8f29f` |
| fixture B `.pi/extensions/task11-capture.ts` | capture v2: adds the **WebSocket** outgoing surface and a bounded, passthrough response-tier diagnostic | `a5491c5ef9a2665e3003bac4da65c1879d1ca6040b532ee5c3e813b768ac9b6a` |
| gateway control `target.ts` | local stand-in for a user gateway on `127.0.0.1:8791`; records sanitized inbound facts, answers 502 | `79e1f08f15dc703951721d9381bced09915dedebb937ba8d07b5a6b9fd978a62` |
| gateway control `models.json` | isolated `PI_CODING_AGENT_DIR` with `providers["openai-codex"].baseUrl = http://127.0.0.1:8791/backend-api` | `069344333cc91cb09119b3785c36502659ca7dd275a6ab31feb3040775d0509a` |

The captures are instrumentation, not a log grep: they observe the request object the host is about
to send and the connection the host is about to open. They never record `Authorization`, account
ids, JWTs, cookies, any other header value, request or response bodies, prompts, or model output.
The response diagnostic is a passthrough `TransformStream`: it enqueues every chunk before looking
at it, never buffers or clones the body, and emits only enums and counts.

### 9.3 Stage 4: loading and readiness

Startup inventory of the decisive host, with no load error:

```
[Extensions]
  project
    <fixture>/.pi/extensions/task11-capture.ts
  user
    ~/.pi/agent/extensions/weave-adapter-pi/dist/extension.js
```

`/weave:health`:

```
Weave adapter mode: ready
…
provider-fast-activation: unsupported (declared degraded)
host runtime: single-copy; redirected 4
child inspection: native-overlay
```

`redirected 4` is the truthful four-module host runtime proof: the three package entries plus the
codex provider subpath. The §3 run of the same line said `redirected 3` while the subpath silently
escaped.

`/weave:status` before any generation:

```
generation: d6e28432-0fb5-4a3a-ac0f-8f2c58fee77a
trust: trusted
mode: tui
health-only: false
fast: unsupported (harness-seam-unavailable)
children: 0
```

The adapter log confirms the seam took effect in this process:
`registered the Weave codex subscription fast provider providerId="openai-codex"`.

### 9.4 Stage 5a: fast-declared primary generation

One generation with `loom` (`fast true`, `gpt-5.6-sol`, allowlist rule `codex-sub-06`) on the
first-party transport. The single outgoing attempt for that turn:

| Field | Observed |
| --- | --- |
| host / method / path tail | `chatgpt.com` / `POST` / `responses` |
| `originator` is `codex_cli_rs` | **true** |
| `originator` is `pi` | false |
| `x-codex-routing-hint` present | **true** |
| routing-hint shape `model=<id>;tier=priority` | **valid**, model allowlisted |
| body `service_tier` | **`priority`** (read from the actual zstd-compressed outgoing body) |
| response status | `200` |

Both parts and the body control belong to the **same** record, so the §4.1 defect — a body-only
partial fast request — did not recur. Across every capture file in this rerun there is no record
carrying `service_tier: "priority"` without both routing parts, and none carrying a routing part
without the body control.

Reported state for that attempt, in `/weave:status` and in the durable journal:

```
fast: not-confirmed (codex-sub-06, response-proof-unavailable, openai-service-tier=ambiguous)

2026-08-18T09:51:18.204Z [INFO] provider-fast.requested     state="requested"     evidenceKind="openai-service-tier" evidenceOutcome="absent"    reason="none"                     ruleId="codex-sub-06"
2026-08-18T09:51:19.188Z [WARN] provider-fast.not-confirmed state="not-confirmed" evidenceKind="openai-service-tier" evidenceOutcome="ambiguous" reason="response-proof-unavailable" ruleId="codex-sub-06"
```

`/weave:status` and the journal agree, and `applied` was never claimed anywhere in this task.

**Why the evidence outcome is `ambiguous` and not `standard`.** The plan expected the backend to
answer `service_tier: "default"`. It does not. A bounded diagnostic — the same passthrough scan with
a deliberately larger 4 MiB window, used only to learn what lies past the adapter's own ceiling —
observed, on four separate generations:

```
sawResponseCreated=true  serviceTierKeyPresent=true  serviceTierValue="auto"
framesParsed=1  scannedBytes=96139…114667  firstEventTypes=["response.created"]
```

Two facts follow, and both make `not-confirmed` the honest terminal:

1. The first SSE event of this transport is `response.created`, and its payload does not complete
   until roughly 96–115 KiB into the body — past the sniffer's deliberate
   `CODEX_EVIDENCE_SCAN_BUDGET_BYTES` of 64 KiB. The sniffer therefore exhausts its budget before
   any conclusive event, which its own resolution order reports as `ambiguous` ("the field was not
   proven missing, it was simply never reached"), not `absent`.
2. Even past that ceiling the value is `"auto"` — neither `"priority"` nor `"default"`. No genuine
   priority appears, so `applied` is unreachable on the evidence, exactly as rule 10 requires, and
   `standard` would have been the wrong label for this backend.

The mapping's request-side behavior is proven; its response-side ceiling remains `not-confirmed`,
which is what the capability declares (`degraded`) and what the spec's OD-2 fallback describes.

### 9.5 Stage 5b: no-intent control after fast-on, on the real outgoing surface

In the same process, `Alt+A` switched the primary to `tapestry` (no `fast`) and one generation ran.
Without intent the wrapper does not force SSE, so the host used its native default and the turn left
the process over a **WebSocket** — a surface no `fetch` wrapper can see. The capture observes that
surface directly:

| Field | Observed |
| --- | --- |
| surface / host | `websocket` / `chatgpt.com` |
| header bag present | true |
| `originator` is `pi` | **true** |
| `originator` is `codex_cli_rs` | **false** |
| `x-codex-routing-hint` present | **false** |
| URL query mentions a routing hint | false |
| URL query mentions `service_tier` | false |

No ChatGPT-backend `fetch` record exists for that turn, no Weave control reached the wire, and no
stale routing identity survived the preceding fast-on turns. `/weave:status` after the control
printed **no `fast:` line at all** — no acceleration state — and the journal recorded only
`usage.observation-recorded source="primary" agentName="tapestry"`, with no `provider-fast.*` event.

### 9.6 Stage 5c: ordinary fast delegation and direct fast workflow step

Both child surfaces ran with a `fast true` child (`shuttle`, `gpt-5.6-luna`, rule `codex-sub-05`).

| Check | Result |
| --- | --- |
| `weave_delegate` child settled | Yes — `COMPLETED … run 1 · settled · 4.3s · 21.9k tok`, child returned its token |
| Direct workflow step (`/weave:run task11-direct`) | Yes — `Workflow task11-direct-1787046792800 is now completed at step probe` |
| Ordinary child's outgoing attempts | `originator: codex_cli_rs` **and** routing hint **and** body `service_tier: priority`, all on the same record, `200` |
| Direct-step child's outgoing attempts | identical shape, on both of its attempts |
| Child processes remaining | none — both child pids were gone after settlement, only the TUI host remained |
| `weave runtime status` | `No active lease.`; the workflow instance is `Status: completed` |

Child-side outcome recording: a Weave child process registers the wrapped provider but deliberately
does not open the Runtime Store (child activation returns right after registration), so a child
writes no `provider-fast.*` journal row of its own. The bounded child-side outcome is therefore
recorded here as the child's own captured outgoing attempts (both parts, priority body, HTTP 200)
plus its settlement, which is the whole of what the child process itself did.

### 9.7 Stage 5d: gateway negative control

Run in an isolated config directory (`PI_CODING_AGENT_DIR`) so the shared global
`~/.pi/agent/models.json` was never modified — other Pi sessions were live on this machine. The
isolated `models.json` pointed `providers["openai-codex"].baseUrl` at the local capture target.
Credentials were made available to that isolated directory by symlink only; no credential file was
read, copied, or recorded by this task.

| Check | Result |
| --- | --- |
| Adapter classification | `fast: unsupported (transport-not-first-party)` in `/weave:status` |
| Durable journal | `provider-fast.unsupported state="unsupported" evidenceKind="none" evidenceOutcome="absent" reason="transport-not-first-party"` |
| What reached the local target | `originator: pi`, **no** routing hint, body `service_tier` **absent** — native passthrough with zero Weave controls |
| Global `~/.pi/agent/models.json` | untouched, SHA-256 unchanged (`aac725c4…`) |

### 9.8 Sanitization

Everything recorded in this section is a hash, an enum, a boolean, a count, a pid, a timestamp, or
an adapter-owned literal (`codex_cli_rs`, `x-codex-routing-hint`, `service_tier`, `priority`,
`auto`) that the adapter or the backend would itself write. No token, account id, JWT,
`Authorization` value, raw body, prompt, or model response text was captured or stored. A regex scan
for `authorization`, `bearer`, `sk-…`, `eyJ…`, `refresh_token`, api-key and account-id spellings,
and absolute home paths over all fourteen captured artifacts returned **zero** hits. Absolute paths
in this section are redacted to `<host root>`, `<host node_modules>`, `<worktree>`, and `<fixture>`.

### 9.9 State restored

| Item | Before | After |
| --- | --- | --- |
| `~/.pi/agent/extensions/weave-adapter-pi` | → `~/projects/weave/packages/adapters/pi` | restored to the same target |
| `~/.pi/agent/trust.json` | `5ba0fc38387b1a00639e5a7911b34731835daa80248acf46161c091dc95c15e8` | byte-identical; the two fixture keys added at the start were removed key-by-key rather than by restoring the file, so a concurrent writer could not be clobbered |
| `~/.pi/agent/models.json` | `aac725c4b3d865a8ac098f9fa3d18030f8558838fa57438f60b05e339fc011c3` | unchanged (never written; the gateway control used an isolated config dir) |
| `~/.pi/agent/bin/pi` (launcher) | `c7649907a34aea371063932324a613a6fb2add4cd1ed01d50c7b54807d596d6a` | unchanged |
| `~/.weave/config.weave` | `9a7939c3cd2f7c6c8fa1ad3d7aa6d402ce92f5a1d71c7824afb4fdeeda7b3974` | unchanged |
| `~/.pi/agent/settings.json` | `294f62a7…` at 09:23Z | **not written by this task.** A concurrent session changed `defaultThinkingLevel` from `high` to `low` at 09:58Z (now `7ef03639…`); that change was deliberately left alone. Every proof host passed `--provider` / `--model` explicitly. |
| Auth state | — | untouched; no credential was read, written, or recorded |
| Temporary fixtures | — | both fixture projects, the isolated config dir, and the gateway target removed; only sanitized capture records remain under `/tmp` |
| Herdr panes | — | both tabs created by this task were closed |
| Proof processes | — | none remain; the gateway target and every TUI and child process exited |

Backups taken before any change: `/tmp/weave-task11-rerun-backup-20260818T092350Z/` (settings,
models, launcher, symlink target, global config, trust), with a `BACKUP-SHA256.txt` manifest.

### 9.10 Validation on the final source

Run after restoration, from the same clean source:

| Command | Result |
| --- | --- |
| `bun test` | **9962 pass, 11 skip, 0 fail** across 341 files |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0; 362 warnings / 71 infos — identical to the §8 baseline, no new warnings |
| `bun run build` | exit 0 |
| `bun run docs:check-links` | exit 0 |
| `bun run validate-config` | exit 0 (`Weave config is valid.`) |
| `bun run verify:pi-host-singleton` | **PASS**, same artifact digest as the live run |

The rebuild produced byte-identical dist digests to the artifact that was proven live, so the
validated source and the verified bytes are the same thing.
