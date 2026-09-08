# OpenCode 2 Core UI Proof

> Non-normative verification record. See [the verification
> guide](../testing/opencode2-verification.md) for the maintained procedure.

Proof date: 2026-09-08

## Identity

- Host: `opencode2 v0.0.0-beta-19086`
- Adapter: `@weaveio/weave-adapter-opencode@0.1.2`
- Packed tarball SHA-256:
  `65e53c8bedf0ae9cff9bebcb2af6ecfadbc20880186ee317427755380b600af6`
- Installed `dist/plugin.js` SHA-256:
  `252b3a075d1385e7a3041059d93049f702dfe17ff1f2a157872d061b18b8419d`
- Terminal widths: 196 columns (normal) and 39 columns (narrow)

The interactive check used the same packed bytes as the final runtime proof.
It ran in an isolated HOME/XDG environment through a Herdr-owned pane. The
provider and service used local ephemeral ports.

## Observed states and interactions

| Check | Result | Observation |
| --- | --- | --- |
| No selected plan | Pass | A new session showed `Weave plan: No plan selected`. |
| Active plan | Pass | The panel showed the name, `0/2 done`, current task, and next task. |
| Complete plan | Pass | The panel showed `2/2 done`, `Plan complete`, and `Next None`. |
| Missing plan | Pass | The read-only panel returned to no-plan and a bounded synthetic result appeared. |
| Malformed plan | Pass | A nonconsecutive task ID was rejected and the panel returned to no-plan. |
| Refresh failure | Pass | The active plan remained visible with the bounded last-valid-config warning. |
| Disconnection | Pass | After the isolated service stopped, the transport check showed `Weave plan: Disconnected`. |
| Reconnection | Pass | A new isolated service restored the selected plan from server state. |
| Task dialog | Pass | The palette opened the read-only task dialog. It stayed open through the five-second poll, keyboard filtering isolated the next task, and Escape closed it. The selected plan did not change. |
| Session switch | Pass | A second session showed no-plan. Switching back restored the first session's active plan. |
| Widths | Pass | The composer contribution stayed bounded and legible at 196 and 39 columns. |
| Plugin coexistence | Pass | Native inventory reported both Weave and a harmless no-output UI plugin active. |
| Remote Location | Pass | The CLI was launched from a different working directory. The panel and public session inventory used the server session's fixture-project Location. |

Opening, moving within, and closing the task dialog did not start, cancel,
resume, or change plan work. Session switching did not let the second session's
no-plan response replace the first session's active-plan display.

The check retained no credentials, request bodies, paths, or raw conversation
output. After the check, the CLI, service, and provider stopped, and all proof
roots were removed.
