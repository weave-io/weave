# Task 20(g) — ChildResponseMissing retryability

## Verdict

**FAIL**

The real child result was `ChildResponseMissing` with `retryable: true`, but the
settled child was not available through the documented history and overlay
route. The direct shortcut reported no matching child, and the child picker
reported that it was unavailable in the session. The projected failure also
did not provide a thread handle. A documented retry could not start, so this
run cannot prove that retry creates a new run while the old block stays frozen.

No other error was relabeled as `ChildResponseMissing`.

## Environment

Observed at `2026-08-06T09:06:27Z`.

| Check | Outcome |
| --- | --- |
| Requested existing pane matched | `true` |
| Workspace pane count | `1` |
| Pane created or split | `false` |
| Pi version | `0.83.0` |
| Weave status | `ready` |
| Active primary agent | `LOOM` |
| Health-only mode | `false` |
| Trusted npm provenance present | `true` |
| Unsafe provenance override present | `false` |
| pi-vim owned the editor before the run | `true` |
| Installed extension SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` |

The visible ready state, trusted npm package entry, absent unsafe override, and
working Weave delegation surface established the ready, trusted, non-health-only
state.

## Safe trigger

Source inspection showed that an ordinary child turn can send an authenticated
completed settlement without `assistantOutput`. The parent drains final events
and then classifies a missing non-whitespace terminal assistant message as
`ChildResponseMissing`. Exiting before settlement would instead produce
`ChildExitedUnexpectedly`, so this attempt did not terminate a process.

One controlled logical child ran a bounded, no-write turn. It completed with a
whitespace-only terminal assistant message.

| Check | Outcome |
| --- | --- |
| Controlled logical child count | `1` |
| Child process termination count | `0` |
| Baseline global RPC process count | `4` |
| Baseline repository RPC process count | `0` |
| Post-settlement global RPC process count | `4` |
| New repository RPC process count after settlement | `0` |
| Parent error discriminator | `ChildResponseMissing` |
| Missing-response reason | `whitespace-only` |
| Retryable | `true` |
| Recovery | `retry` |
| Other terminal error observed | `false` |

## Preserved failed history

The parent recorded the failed run and the authoritative child session remained
available after settlement.

| Check | Outcome |
| --- | --- |
| Child-ref entry count | `2` |
| Latest ref status | `failed` |
| Recorded run count | `1` |
| Recorded run action | `start` |
| Authoritative session match count | `1` |
| Authoritative session line count | `11` |
| Saved parent history prefix unchanged | `true` |
| Active runtime lease after settlement | `false` |

These observations prove that the failed first run remained append-only history.
They do not substitute for the required post-retry frozen-block comparison.

## Retry route blocker

After settlement, both documented overlay entry routes were exercised without
adding text to the primary editor.

| Check | Outcome |
| --- | --- |
| Direct child shortcut found a matching child | `false` |
| Child picker available | `false` |
| Projected thread handle present | `false` |
| Documented retry offered | `false` |
| Retry started | `false` |
| New retry run observed | `false` |
| Old block compared after retry | `false` |

The exact visible blockers were `no matching child` and `Child picker is
unavailable in this session`. An internal identifier was not extracted and no
undocumented retry path was used.

## Isolation and restoration

| Check | Outcome |
| --- | --- |
| Extra primary-input entry count | `0` |
| Primary editor remained empty | `true` |
| pi-vim editor mode restored | `INSERT` |
| Weave status after the attempt | `ready` |
| Production-code change count | `0` |
| Unrelated process termination count | `0` |
| Residual repository RPC process count | `0` |
| Pane left open | `true` |

The failed history route is the sole acceptance blocker for this matrix item.
