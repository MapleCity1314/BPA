# ADR 0002: IR2, execution identity and recovery

- Status: accepted
- Date: 2026-07-28

## Context

The v1 engine identifies an execution primarily by Run, Node key and retry
attempt. That is insufficient when a structured step is visited once per item.
Runs also recompile the published Workflow during recovery, which cannot prove
that the resumed plan is identical to the original plan.

## Decision

Compiler emits `bpa.workflow-ir/2`. Engine consumes only this format.

At Run creation, one transaction stores:

- Canonical IR2 JSON and its digest.
- Workflow identity and source digest.
- Effective risk snapshot.
- The exact version and digest of every Node, Adapter and Policy in the plan.
- The Run and its creation event.

The identity of a step attempt is:

```text
run_id + scope_path + iteration_key + step_key + attempt
```

`scope_path` is an ordered array of stable scope segments. A `foreach` item
must provide a unique, deterministic `iteration_key`; array index alone is not
a durable identity.

The first structured source model contains:

- `call`
- `decision`
- `foreach`
- `wait.assistance`
- `terminal`

It does not contain arbitrary jumps, graph back-edges, parallel execution,
generic pagination or unbounded loops. `foreach` is sequential and must declare
`maxItems`, `maxDuration` and `onItemError`.

Workflow v1alpha1 remains accepted. Compiler adapts it to a single-scope IR2
plan. Existing active Runs without a saved plan may be compiled once from their
immutable published asset closure, then the plan is persisted before progress.

## Consequences

Recovery never silently picks up a newer Node or Adapter. Retry attempts and
loop iterations are different identities. Late or duplicate results can be
rejected without advancing another iteration.
