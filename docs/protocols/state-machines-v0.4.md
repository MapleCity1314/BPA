# BPA v0.4 state machines

Status: accepted

## Run and execution

```text
created → validated → queued → running
                              ├→ waiting_browser ─┐
                              ├→ waiting_assistance
                              ├→ waiting_human ───┤
                              ├→ paused ──────────┤
                              └───────────────────┘
                                      ↓
                   succeeded | failed | cancelled | uncertain
```

Only a compare-and-swap transition with the expected revision may advance the
Run. A late result can be recorded for audit, but cannot change a terminal Run
or another scope/iteration/attempt.

## Assistance

```text
queued → claimed → processing → completed
                         └─────→ awaiting_human → completed

queued | claimed | processing | awaiting_human
  → expired | cancelled | failed
```

Claim, takeover, heartbeat and submit validate owner plus the monotonically
increasing fencing token. Moving a blocking Run into `waiting_assistance` and
creating its Task is one transaction. Completing that Task, consuming the
Inbox message and waking the Run is another transaction.

## Dataset

```text
staged → validated → published
   └──────────────→ rejected
```

Published is immutable. The same Dataset ID and version can only be accepted
again when the canonical digest is identical; different content is a conflict.

## Decision

```text
DecisionCandidate → active → superseded
                         └→ revoked
```

Only `active` records are reusable, and only while every declared scope value
and precondition digest is exactly equal.
