# ADR 0007: Author from semantic evidence without granting execution authority

- Status: proposed
- Date: 2026-07-30

## Context

BPA needs to turn a business goal and real page observations into reusable
automation assets. A conventional recorder would capture brittle selectors and
imperative gestures. Allowing generated code to run or modify the repository
would also collapse the separation between observation, generation, review and
publication.

## Decision

Introduce `bpa.authoring/v1alpha1` as a durable authoring model family.
ScenarioSpec freezes intent and authority before page capture. Design Mode
creates a short-lived, exact grant for one Browser Session, Profile, Tab,
Origin and PageEpoch. The capture Runtime produces bounded, redacted semantic
PageSnapshots through the existing Browser Evidence protocol.

Page content remains untrusted input. It cannot alter the ScenarioSpec,
permission set, risk ceiling, executable behavior or candidate destination.
Stable page semantics are represented by the existing PageModel and
ElementContract models. Simple reads may generate declarative candidates;
complex behavior generates a non-executable Handler skeleton and tests.

Candidate Bundles are immutable content-addressed review packages. They may be
exported as repository-relative files and a patch, but Core and MCP cannot
apply, execute or publish them. Formal publication remains a separate
human-confirmed CLI operation.

The accepted `bpa.browser/1@1.0.0` wire protocol is unchanged. Snapshot payloads
use Evidence chunking and Asset references rather than Control frames.

## Consequences

- Existing published assets remain the preferred solution; Design Mode is used
  only for real Capability Gaps.
- Page evidence can improve AI authoring without becoming AI instructions.
- Replay and contract validation can happen before any code is trusted.
- Complex page automation still requires engineering review.
- The product does not become a general gesture recorder or an automatic
  source-code writer.
- SQLite v9 and the authoring services can be implemented after the model
  family is formally accepted.
