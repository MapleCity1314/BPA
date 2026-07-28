# ADR 0004: PageModel and Adapter boundary

- Status: accepted
- Date: 2026-07-28

## Context

AI-assisted page discovery is valuable only if it accelerates future Node
creation without turning Workflow into an arbitrary browser agent. The stable
`bpa.browser/1` protocol must not accept dynamic scripts or unreviewed selectors.

## Decision

Page discovery produces Candidate `PageModel` and `ElementContract` assets.
Workflow references only semantic Node versions.

The first runtime uses a hybrid model:

- A constrained declarative reader may implement simple R0/R1 field reads from
  reviewed contracts.
- Pagination, virtual scrolling, navigation recovery and all future writes use
  reviewed Adapter handlers.

An ElementContract may use:

- Stable platform/business identifiers.
- Accessible role and stable name.
- Label or reviewed attributes.
- A relative semantic anchor.
- CSS as a diagnostic fallback only.

Absolute XPath, screen coordinates, arbitrary JavaScript and CSS-only published
contracts are rejected.

Publishing compiles reviewed contracts into an exact Adapter version and
Extension capability manifest. Node publication pins that Adapter version.
`bpa.browser/1` continues to dispatch the exact Node version; the installed
Adapter manifest resolves it to the immutable handler/contract bundle.

Design Mode is explicit, read-only and bound to one profile, tab and exact
Origin for at most 15 minutes. DOM material is reduced and redacted in the
Extension. Raw discovery evidence expires after 24 hours; reviewed fixtures and
contracts may be retained.

## Consequences

Simple read Nodes can be created quickly, while complex browser behavior stays
in testable code. Updating a PageModel produces a new Adapter/Node version and
cannot silently change an active Run.
