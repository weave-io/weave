# Task 20(i) fork/clone origin-exclusion proof

**Verdict: FAIL**

The fork and clone exclusion checks passed. The return-to-source checks did not all pass. The unchanged source parent still exposed its completed child through `/weave:inspect`, but `/weave:status` and `/weave:history` both reported zero children after the return.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Pi version | `0.83.0` | PASS |
| Weave ready | `true` | PASS |
| Trusted | `true` | PASS |
| Health-only | `false` | PASS |
| npm provenance present | `true` | PASS |
| Unsafe provenance override present | `false` | PASS |
| Local extension shadow present | `false` | PASS |
| Installed extension SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` | PASS |
| Same pane retained | `true` | PASS |
| New panes created | `0` | PASS |
| Nested Pi processes launched | `0` | PASS |
| Production files edited | `0` | PASS |

## Source child baseline

| Check | Observed | Outcome |
| --- | ---: | --- |
| Bounded shuttle-mini children created | `1` | PASS |
| Completed logical children | `1` | PASS |
| Durable child-ref envelopes | `2` | PASS |
| Durable logical child refs | `1` | PASS |
| Terminal child status | `completed` | PASS |
| Source ref SHA-256 | `228b8abb92f975b54f9133eedff05e1ca339fafeeb1f996f6a33d099da390cf0` | PASS |

## Clone-derived parent

Pi's documented `/clone` route was used in the same pane.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Route completed | `true` | PASS |
| Parent link matched source | `true` | PASS |
| Fingerprint differed from source | `true` | PASS |
| Clone fingerprint SHA-256 | `15314e3f5737efcfac27f72aebc0d0ad3f005a0f037b151a5271fc9feb3d9d1f` | PASS |
| Imported ref envelopes retained | `2` | PASS |
| Imported logical children retained | `1` | PASS |
| Source origin retained | `true` | PASS |
| Origin-mismatch issues | `1` | PASS |
| Origin-mismatched children | `1` | PASS |
| Usable refs | `0` | PASS |
| Source-authority calls | `0` | PASS |
| Active children | `0` | PASS |
| Source history rows | `0` | PASS |
| Source picker rows | `0` | PASS |
| Source overlay mounted | `false` | PASS |

## Fork-derived parent

Pi's documented `/fork` route was used in the same pane.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Route completed | `true` | PASS |
| Parent link matched selected source | `true` | PASS |
| Fingerprint differed from source | `true` | PASS |
| Fingerprint differed from clone | `true` | PASS |
| Fork fingerprint SHA-256 | `ad355cb2fce0e22b43c0ee87b0a76f4e388d0f9202915a3bc11b7c7913d6ed31` | PASS |
| Imported ref envelopes retained | `2` | PASS |
| Imported logical children retained | `1` | PASS |
| Source origin retained | `true` | PASS |
| Origin-mismatch issues | `1` | PASS |
| Origin-mismatched children | `1` | PASS |
| Usable refs | `0` | PASS |
| Active children | `0` | PASS |
| Source history rows | `0` | PASS |
| Source picker rows | `0` | PASS |
| Source overlay mounted | `false` | PASS |

## Return to the source parent

| Check | Observed | Outcome |
| --- | ---: | --- |
| Reopened source parent | `true` | PASS |
| Source fingerprint matched handoff | `true` | PASS |
| Source fingerprint SHA-256 | `700b494230d37c24141e43e8dac4aa05bc513e8be3e476a1a49211f24ce67fee` | PASS |
| Source ref SHA-256 matched handoff | `true` | PASS |
| Durable child-ref envelopes | `2` | PASS |
| Durable logical child refs | `1` | PASS |
| Terminal child status | `completed` | PASS |
| `/weave:status` child count | `0` | **FAIL** |
| `/weave:history` completed rows | `0` | **FAIL** |
| `/weave:history` empty notice | `true` | **FAIL** |
| `/weave:inspect` picker opened | `true` | PASS |
| Source child selectable | `true` | PASS |
| Source overlay opened | `true` | PASS |
| Source overlay showed completed state | `true` | PASS |

The matching source fingerprint and ref SHA-256, the unchanged ref counts, and the reopened source overlay prove exclusion rather than deletion. The two derived parents retained the copied envelopes but classified the one source child as origin-mismatched and exposed no usable source child. The source-parent status and history surfaces did not reconstruct that unchanged child after return.

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| pi-vim ownership retained | `true` | PASS |
| Final pi-vim mode | `NORMAL` | PASS |
| Persisted route-command messages | `0` | PASS |
| Visible queued-input marker | `false` | PASS |
| Picker closed | `true` | PASS |
| Overlay closed | `true` | PASS |
| Residual child processes | `0` | PASS |
| Active Runtime Store lease | `false` | PASS |

## Blocker

The exact sanitized blocker is: `source_return_status_children=0; source_return_history_rows=0; source_ref_count=1; source_overlay_open=true`.
