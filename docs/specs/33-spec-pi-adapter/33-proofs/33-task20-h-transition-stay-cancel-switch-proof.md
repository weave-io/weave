# Task 20(h) — Session transition Stay then cancel-then-switch

## Verdict

**PASS**

This proof covers only Task 20 matrix item (h). It contains no prompt text,
transcript text, file path, parent session ID, child ID, or native session ID.

## Environment

Observed at unix `1786007796`.

| Check | Outcome |
| --- | --- |
| Requested existing pane matched | `true` |
| Pane created or split | `false` |
| Nested Pi launched | `false` |
| Pi version | `0.83.0` |
| Weave ready UI | `true` |
| Non-health-only | `true` |
| Health-only true observed | `false` |
| Trusted npm provenance present | `true` |
| Unsafe provenance override present | `false` |
| Local extension shadow present | `false` |
| pi-vim owned editor input | `true` |
| Installed extension SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` |
| Active child running before transition | `true` |
| Runtime lease active before | `false` |

## Stay path

Real session-transition route: host `app.session.new`.

| Check | Outcome |
| --- | --- |
| Transition confirmation shown | `true` |
| Stay option present | `true` |
| Proceed option present | `true` |
| Stay listed before Proceed | `true` |
| Default selection Stay | `true` |
| Enter accepted default Stay | `true` |
| Parent session fingerprint unchanged | `true` |
| Child still running after Stay | `true` |
| Child mutated or cancelled by Stay | `false` |
| Stay phase elapsed ms | `1046` |

## Cancel-then-switch path

Second transition on the same route while the child remained active.
Proceed is the cancel-then-switch confirmation option on this surface.

| Check | Outcome |
| --- | --- |
| Proceed selection attempted | `true` |
| Session fingerprint changed | `true` |
| Child running after switch | `false` |
| Child or subtree cancelled before completion | `true` |
| Old-session child refs visible in new session | `false` |
| Runtime lease active after | `false` |
| Children list count after | `0` |
| New parent ready UI | `true` |
| Editor mode valid after switch | `true` |
| Editor INSERT after switch | `true` |
| Editor NORMAL after switch | `false` |
| Proceed phase elapsed ms | `3664` |

## Isolation

| Check | Outcome |
| --- | --- |
| Production-code change count | `0` |
| Pane left open | `true` |
| Plan or checklist edited | `false` |

