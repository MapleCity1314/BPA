# ADR 0003: Assistance, datasets and atomic wake-up

- Status: proposed
- Date: 2026-07-28

## Context

A boolean human approval cannot represent Codex analysis, a human correction,
login takeover or a reusable business decision. Large Excel datasets also
cannot be placed in Workflow input or normal Node result payloads.

## Decision

`AssistanceTask` is an independent durable resource with three initial modes:

- `ai_review`
- `human_confirm`
- `human_action`

Creating a blocking Task and moving its Run to a waiting state is one SQLite
unit of work. Completing a Task validates its output Schema, writes its result
and Inbox event, and wakes the Run idempotently. Claim, heartbeat and submit use
a lease and fencing token.

AI auto-continuation follows policy, not model confidence:

- A published R0 profile may opt in.
- R1 additionally requires a reviewed allowlist entry and deterministic result
  validator.
- R2+, durable decisions and results that may authorize a future write always
  require a human confirmation.
- Confidence remains ranking and audit metadata.

Codex accesses Tasks through a provider-neutral queue exposed by MCP. Core does
not call a model API. If no provider claims a non-critical review before its
deadline, its published profile decides whether to remain unresolved or require
human action.

A Dataset is an immutable `DatasetVersion`. Runs and Nodes carry only a
`DatasetRef`; records are read through a bounded query port. Import uses staging
validation followed by atomic publication. Team Worker handlers never receive
an arbitrary filesystem path or direct database connection.

Human-confirmed reusable results are `DecisionRecord`s. Reuse requires exact
agreement on the declared scope and precondition digests. For packaging
matching this includes shop, product, normalized title, target record,
matcher and rule versions; an unrelated Excel row change does not invalidate
the decision.

## Consequences

AI and human work can be retried or resumed without double-advancing a Run.
Business data stays outside protocol-size-limited event payloads. Long-term
decisions remain auditable and revocable.
