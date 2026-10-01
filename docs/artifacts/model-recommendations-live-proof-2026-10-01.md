# Live proof: model recommendations on OpenCode 2 (released code)

**Spec**: [Spec 39 — Model Recommendations](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md), work item 8 ([tasks 8.1–8.4](../specs/39-spec-model-recommendations/39-tasks-model-recommendations.md)) · **Issue**: #275 · **Date**: 2026-10-01 (all times UTC) · **Host**: `@opencode/cli@2.0.16`, Bun 1.4.2 · **Weave**: `@weaveio/weave-adapter-opencode2@0.3.0-next.0` and `@weaveio/weave-cli@0.3.0-next.0`, both from npm `next`

This repeats the [spike](model-recommendations-spike.md) with the released packages instead of spike code. Non-normative: it records what was seen on one run and is not kept current.

## Summary

| Check | Result | What was seen |
| --- | --- | --- |
| 8.0 Real site, no URL override | **Pass** | `weave models update` fetched and applied the live tryweave.io `stable` list (issued `2026-10-01T20:00:00Z`). Loom stayed on its builtin resolution, `proof/claude-opus-5-5`. |
| 8.1 A new list reaches a running host | **Pass** | Loom moved `proof-loom-a` → `proof-loom-b` on the first prompt after `weave models update`, with the same service process throughout. |
| 8.2 Tampered remote file | **Pass** | `SignatureInvalid`: cache files unchanged, `weave models status` shows the error, Loom kept `proof-loom-b`. |
| 8.2a Corrupt local `applied.json` | **Partial** | The layer was skipped and Loom fell back to `proof/claude-opus-5-5`, and `weave models status` explained why. But the `weave.status` RPC failed outright instead of reporting `model_updates_unavailable` (#303). |
| 8.2a Recovery | **Pass** | Recovery needed no newer list. A forced `weave models update` got a 304 and re-promoted the verified `latest.json`. Restoring the file by hand also worked. |
| 8.4 `models.changed` event and TUI toast | **Pass** | An SDK subscriber outside the host received the event. The TUI, driven in tmux, showed "Loom now runs on proof-loom-b (model recommendations of 1 Oct 2026)" for about 5 seconds. |
| Request headers | **Pass, one finding** | No cookies, query parameters or Weave-specific headers were sent. The host's `fetch` added `User-Agent: opencode/latest/2.0.16/cli` (#304). |

Issues filed: #303 (`status` RPC fails with `model_updates_unavailable`), #304 (the OpenCode 2 request carries the host's `User-Agent`), #305 (CLI prints raw log lines and reports a no-op list as a change).

## Setup

- **Host.** `bun scripts/proof/opencode2-live/main.ts --host pinned --plugin npm:@weaveio/weave-adapter-opencode2@0.3.0-next.0 --root <root> --keep`, from `main` at `c949d25d`. The script installed the host and wrote the project's `plugins` entry. It then stopped at `service start` with exit 130. That is the known port collision from the spike: another host on the machine holds the default port 49374. In the isolated home, `opencode2 service set port 49411` fixed it. Every command below ran with the script's isolated `HOME`, `XDG_*`, `XDG_RUNTIME_DIR` and `WEAVE_GLOBAL_CONFIG_DIR`.
- **Catalog.** Three entries were added to the `proof` provider in the isolated global `opencode.json`: `proof-loom-a`, `proof-loom-b` and `claude-opus-5-5`. Each list's model then resolves, and so does the builtin fallback. Loom's builtin list is `claude-opus-5.5`, `claude-opus-5-5`, `gpt-6-sol`. Only the second is in this catalog, so Loom's builtin resolution is `proof/claude-opus-5-5`.
- **Weave config.** `$WEAVE_GLOBAL_CONFIG_DIR/config.weave` held only `settings { model_updates { mode auto } }`.
- **Lists.** Three `stable` envelopes signed with the production key, each expiring `2026-10-02T15:27:00Z`, with `default.agents.loom.models` set as follows:
  - list A: issued `2026-10-01T18:57:00Z`, `["proof-loom-a"]`;
  - list B: issued `2026-10-01T19:17:00Z`, `["proof-loom-b"]`;
  - a tampered copy of list B with an edited payload and B's signature.

  They are not committed.
- **Local server.** A small Bun server served one file at `/models/stable.v1.json` with a strong ETag (a hash of the bytes), answered a matching `If-None-Match` with 304, and logged each request's headers. From 8.1 on, the service was started with `WEAVE_MODEL_RECOMMENDATIONS_URL=http://127.0.0.1:49412/models`. `/proc/<pid>/environ` of the `serve --service` process showed that variable and the isolated `WEAVE_GLOBAL_CONFIG_DIR`. The managed service inherits the environment of the shell that runs `opencode2 service start`.
- **Observers.**
  - `opencode2 api agent.list -H x-opencode-directory:<project>` for the registered model.
  - The `loom · <model>` lines of `opencode2 run --agent loom "…" </dev/null` for the model a new session selects.
  - A Bun script using the plugin's own `@opencode/client@2.0.16` and the adapter's `dist/rpc.js` to call `weave.status` and subscribe to `models.changed`.
  - The TUI (`opencode2` in the project) in a private tmux server, captured with `tmux capture-pane` every 0.2 seconds.
- **No model calls.** No model provider was running, so turns retried or timed out. The prompt hook, and with it the catalog refresh, runs before the model call, so this does not affect the results.

## Observations

### 8.0 Real site (no URL override)

- 19:32:09: `weave models status` printed `mode auto`, `channel stable`, `harness opencode2`, `applied nothing yet`, `last check never`, and every agent's list marked `builtin`.
- 19:32:10: `weave models update` printed `Applied the stable list issued 2026-10-01T20:00:00Z.` It then listed every agent as `was (builtin list only)` / `now <the same three models>` (#305, item 2).
- 19:32:10: `weave models status` printed:

  ```
  applied     issued 2026-10-01T20:00:00Z, expires 2026-12-29T20:00:00Z
  evidence    https://github.com/weave-io/weave/blob/main/docs/artifacts/eval-copilot-default-models-2026-09-29.md
  last check  2026-10-01T19:32:10.460Z
  next check  2026-10-02T19:32:10.460Z
  ```

  It also printed every entry as `recommended`. The list repeats the builtins and duplicates are removed, so each entry's first source is the recommendation.
- The stored ETag was `W/"6abeb3ec-9cc"`. nginx weakens the strong ETag on gzip responses. A conditional GET with that weak value got 304, with or without `Accept-Encoding: gzip`, so the ETag round trip works against the real site.
- The service started at 19:32:20 with no URL override. Loom appeared in `agent.list` at 19:33:03, about 40 seconds later, on `proof/claude-opus-5-5`: its builtin resolution.
- A prompt at 19:34:06 selected `loom · claude-opus-5-5`.
- `weave.status` at 19:35:09 returned:
  - `modelUpdates: { mode: auto, channel: stable, state: applied, issued: 2026-10-01T20:00:00Z }`;
  - `model_unavailable` issues for `shuttle`, `thread` and `spindle`. This catalog has no Sonnet, Haiku or GPT entries, so these are expected.

The live list is dated `20:00:00Z`, 28 minutes after this check. The 24-hour future-skew rule accepts it. As a result, both test lists are older than the applied file and would be refused as rollbacks. So the service was stopped (19:35:40) and the `stable` cache directory was moved aside, returning the cache to the state of a fresh install. The service then restarted at 19:35:50 with the URL override. The same service process, pid unchanged, ran every step from here to the end.

### 8.1 A new list on a running host

**List A at startup (19:35:42).**

- The plugin loads for a Location only when a client first uses it. Here that was the TUI, at 19:35:59.
- Its after-first-publish refresh fetched list A at 19:36:00.068 and promoted it at 19:36:00.076.
- At 19:36:00.16 the host emitted `provider.updated` and `model.updated`, a host inventory change. The refresh that followed also found the promoted `applied.json`.
- By the time the TUI drew its prompt box, it showed `Loom · proof-loom-a`. `agent.list` at 19:36:11 agreed.
- No `models.changed` event was emitted. That matches the documented rule: a reload that also carries a host inventory change, or the first publish, emits nothing.

So list A landed at startup without a prompt. It shows the plugin's own fetch and promotion working, but not the prompt path.

**List B through `weave models update`, then a prompt.**

1. 19:36:54: TUI prompt 1 opened a session running on `proof-loom-a`, and the plan panel showed `Weave plan: No plan selected`. The turn was then interrupted.
2. 19:37:11: list B served. `weave models update` at 19:37:12 printed:

   ```
   Applied the stable list issued 2026-10-01T19:17:00Z (was 2026-10-01T18:57:00Z).
     loom
       was  proof-loom-a
       now  proof-loom-b
   ```

3. 19:37:12: `agent.list` still showed `proof-loom-a`. No admitted work had happened yet.
4. 19:37:17: TUI prompt 2, sent in the same session, triggered the source probe and the reload.
   - 19:37:18.593: the host created the event, and the external subscriber received it at 19:37:18.647:

     ```json
     {"type":"rpc.weave.models.changed","location":{"directory":"<project>"},
      "data":{"issued":"2026-10-01T19:17:00Z","agents":[{"agent":"loom","providerID":"proof","model":"proof-loom-b"}]}}
     ```

   - 19:37:18.78–19:37:23.60: the toast was visible in 23 captured frames, top right of the session view:

     ```
     ┃  Weave                                                x  ┃
     ┃                                                          ┃
     ┃  Loom now runs on proof-loom-b (model recommendations    ┃
     ┃  of 1 Oct 2026)                                          ┃
     ```

   - Prompt 2's own turn still ran on `proof-loom-a`, and the session footer kept `Loom · proof-loom-a`. A live session keeps its model, as Spec 39 says.
5. 19:37:29: `agent.list` showed Loom on `proof/proof-loom-b`.
6. 19:37:34: a new headless session selected `loom · proof-loom-b`.

The change landed on the first prompt after the fetch. Here the fetch was made out of band by the CLI. When the plugin fetches during a prompt, the change lands on the following prompt instead, as the spike showed.

### 8.2 Tampered remote file

1. 19:37:59: the tampered envelope was served. `weave models update` exited 1 with:

   ```
   Error: the stable list could not be checked: the signature does not verify: no known key signed this payload
   ```

   The error was preceded on stderr by a raw pino JSON line (#305, item 1).
2. `applied.json` and `latest.json` kept their 19:37:12 timestamps. `state.json` recorded `lastError.code: SignatureInvalid` and kept list B's ETag, so a later fetch downloads again rather than getting a 304 for the bad file.
3. `weave models status` printed:

   ```
   last error  the signature does not verify: no known key signed this payload (2026-10-01T19:38:00.107Z)
   next check  2026-10-01T20:38:00.107Z
   ```

   The next check falls one hour after the failure: the error backoff.
4. 19:38:08: a prompt selected `loom · proof-loom-b`, and `agent.list` agreed.
5. `weave.status` reported `state: applied, issued: 2026-10-01T19:17:00Z`. As documented, the RPC carries no last-check error, so here `weave models status` is the place the rejection shows.

### 8.2a Corrupt local `applied.json`

1. 19:38:34: `applied.json` was truncated to its first 200 bytes. `agent.list` still showed `proof-loom-b`, because nothing had probed yet.
2. 19:38:35: a prompt selected `loom · claude-opus-5-5`. `agent.list` showed Loom and Tapestry on `proof/claude-opus-5-5`, their builtin lists. No `models.changed` event was emitted, as documented for a skipped list.
3. `weave models status` printed:

   ```
   applied     not used: the envelope is not { "payload", "sig" }: JSON Parse error: Unterminated string; agents use their builtin models
   waiting     issued 2026-10-01T19:17:00Z (run weave models apply to use it)
   ```

   Every agent was shown as `builtin`.
4. **`weave.status` failed**, rather than carrying `model_updates_unavailable`:

   ```
   InvalidRequestError: Expected JSON value
     at ["output"]
   ```

   A second corruption at 19:39:59 reproduced the failure. That time the file held a well-formed envelope, `{"payload":"x","sig":"y"}`, that does not verify. The likely cause: the health report copies `agentName: undefined` for the one issue without an agent, and the host's RPC accepts JSON values only. The host double in the adapter tests does not check this. Filed as #303.

**Recovery.** Is a newer list needed once `applied.json` is unusable? No.

1. 19:39:19: list B was served again. `weave models update` sent B's ETag and got a **304**. It still re-promoted the verified `latest.json` into `applied.json` and printed `Applied the stable list issued 2026-10-01T19:17:00Z.`, with Loom `was (builtin list only)` / `now proof-loom-b`.
2. 19:39:28: a prompt selected `loom · proof-loom-b`. A second `models.changed` event followed for the same `issued`, because the previous catalog had no usable list. `weave.status` worked again at 19:39:44.
3. Restoring the file by hand at 19:40:15 also brought `proof-loom-b` back on the next prompt.

So a forced update recovers from the verified `latest.json` without a newer list. Before that, the plugin's own refresh was within its 24-hour throttle and did not fetch. Without the CLI, a host would presumably stay on the builtins until the next due check. That was inferred from the throttle, not waited out.

### Request headers

| Time | Caller | Status | `User-Agent` | `If-None-Match` |
| --- | --- | --- | --- | --- |
| 19:36:00 | plugin (host `fetch`) | 200 | `opencode/latest/2.0.16/cli` | — (fresh cache) |
| 19:37:12 | CLI | 200 | `Bun/1.4.2` | list A's ETag |
| 19:38:00 | CLI | 200 (tampered) | `Bun/1.4.2` | list B's ETag |
| 19:38:08 | CLI | 200 (tampered) | `Bun/1.4.2` | list B's ETag |
| 19:39:20 | CLI | 304 | `Bun/1.4.2` | list B's ETag |

Every request was `GET /models/stable.v1.json` with no query string. The only other headers were `accept: */*`, `accept-encoding`, `connection` and `host`. No cookie, authorization or Weave-specific header was sent. Weave itself sets only `If-None-Match`. The OpenCode 2 host's runtime adds a `User-Agent` naming the harness and its version (#304).

## Not verified

- **Plugin fetch from tryweave.io.** The plugin's own fetch was seen only against the local server. The 8.0 fetch from tryweave.io was made by the CLI.
- **Throttle timing.** Neither the 24-hour nor the 1-hour throttle was waited out live. Nor was a list fetched by the plugin during a prompt, which should land on the following prompt; that path was not repeated here, but the spike showed it.
- **Other modes.** `notify` mode and `weave models apply` were not exercised.
- **Atomic promotion under load.** Several hosts promoting at once were not tested. The "under load" half of 8.2a remains covered only by the unit tests.
- **Notice variants.** A `models.changed` notice naming several agents was not seen, and neither was the toast in a second Location.
- **Other harnesses.** Claude Code (6b) and Pi were not part of this proof.
