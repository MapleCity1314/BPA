# BPA Authoring v1alpha1 协议候选

Status: accepted (human confirmation on 2026-07-30)

Date: 2026-07-30

## 1. Scope

`bpa.authoring/v1alpha1` defines the durable boundary between business intent,
Codex authoring, Design Mode evidence and human-reviewed candidate assets. It
does not define a model API, a browser recording format or a publication
shortcut.

This family contains four public models:

| Kind | Purpose | Mutable? |
| --- | --- | --- |
| `ScenarioSpec` | Freeze business intent, risk ceiling, resources, outputs and acceptance tests | Versioned asset |
| `AuthoringSession` | Track incremental authoring with CAS revision and idempotent operations | CAS state |
| `PageSnapshot` | Carry a bounded, redacted and provenance-bound semantic page state | Immutable |
| `CandidateBundle` | Freeze candidate files, dependency closure and validation/risk reports | Immutable |

Existing `PageModel`, `ElementContract`, Workflow Draft and Artifact Candidate
remain authoritative. This protocol does not create parallel forms of those
models.

## 2. ScenarioSpec

`ScenarioSpec` is the policy boundary produced before page evidence is read. A
page may provide untrusted observations, but it cannot widen:

- the approved HTTPS Origins;
- the risk ceiling;
- Browser resource authentication requirements;
- the declared inputs, outputs and success criteria;
- failure or `uncertain` handling;
- screenshot or evidence-retention policy.

Screenshot collection is always disabled by default. The first version limits
raw evidence retention to 24 hours and requires at least one deterministic
acceptance test.

The Schema reuses the platform-wide R0–R4 risk vocabulary. The BPA 0.5
authoring policy accepts only R0/R1 scenarios; a higher ceiling fails policy
validation and does not enable an R2+ Runtime.

## 3. AuthoringSession

Every mutation supplies both `expected_revision` and an `operation_id`.
Successful mutation increments the revision. A repeated operation with the
same payload returns the prior result; the same operation id with a different
payload is rejected. A stale revision returns `REVISION_CONFLICT` without
partially applying the change.

The durable state machine is:

```text
intake
  → catalog
  → discovery
  → modeling
  → assembly
  → validation
  → candidate
  → closed

catalog → assembly          when published capabilities close every gap
validation → assembly       when a bounded correction is required
any non-terminal → failed
```

Transitions never publish an asset. `candidate` only means that an immutable
Candidate Bundle has been saved.

## 4. Design Mode grant

A Design Mode grant is a persisted Core record, not authority embedded in page
content. It freezes:

- Authoring Session and human approver;
- Browser Session and Chrome Profile;
- Tab id, exact Origin and PageEpoch;
- allowed capture operations;
- issue and expiry time.

The default and maximum initial TTL is 15 minutes. Version 1 has no renewal
operation. A new human approval creates a new grant.

```text
requested
  → active
  → stopped
  → expired
  → revoked
  → invalidated
```

`active` is the only state that permits capture. Navigating to another Origin,
closing the Tab, changing Browser Session identity or invalidating PageEpoch
terminates the grant. Login, CAPTCHA, membership restriction, throttling and
platform risk are observed states; BPA does not bypass them.

## 5. PageSnapshot

The built-in read-only capture Node runs through the existing Runtime,
Resource Binding and Evidence transfer path:

```text
grant validated
→ semantic capture
→ redaction
→ Evidence upload and ACK
→ Asset persistence
→ PageSnapshot persistence
→ attach to AuthoringSession
```

A snapshot is rejected unless all of these are true:

- exact grant, Session, Profile, Tab, Origin and PageEpoch still match;
- provenance binds the capture Run, Node Execution, Evidence and Asset;
- page content is marked `untrusted`;
- password, token, cookie, hidden-input, personal-data and large-text
  redaction coverage is recorded as complete;
- no more than 5,000 visible or interactive semantic nodes are present;
- each text field is at most 160 characters;
- the structured snapshot is at most 5 MiB.

Screenshots require a separate per-capture approval, are limited to 10 MiB and
remain restricted Evidence. The raw capture expires within 24 hours. Only the
redacted, content-addressed fixture attached to a candidate may be retained
longer.

MCP returns a summary and content reference by default. A restricted query may
return at most 200 semantic nodes per call. Page text never becomes an
instruction, permission, selector, script or source path.

## 6. Candidate generation

Simple text, existence and safe-attribute reads may produce a declarative
Adapter candidate. Pagination, virtual scrolling, complex readiness and page
recovery only produce a Handler skeleton plus replay fixtures and contract
tests.

An `ElementContract` remains invalid unless it is verified against at least two
different PageSnapshot digests and has at least one stable non-CSS locator.
CSS is diagnostic data only.

A Candidate Bundle contains:

- exact Scenario and Authoring Session revision;
- candidate and reused published artifacts;
- repository-relative candidate files;
- complete dependency closure;
- unresolved Capability Gaps;
- schema, contract, replay, permission and risk checks;
- effective permissions and human review points.

Allowed file roots are `adapters/`, `nodes/`, `workflows/` and `tests/`.
Absolute paths, traversal, repeated separators, symlinks and caller-selected
final paths are rejected. The immutable bundle always fixes:

```json
{
  "autoExecute": false,
  "autoPublish": false,
  "autoApplySource": false
}
```

Saving or exporting a bundle does not apply a patch. A later CLI publication
still requires explicit human confirmation and the existing publication
Audit.

## 7. Candidate Bundle lifecycle

```text
assembling
  → validating
  → saved
  → exported

validating → assembling     for bounded corrections
validating → rejected       for policy or trust-boundary violations
```

`saved` is content-addressed and immutable. Re-saving byte-identical content is
idempotent. Reusing an id with a different digest is rejected. Export records
the bundle digest, archive digest, destination lease and actor in Audit.

## 8. Compatibility

- `bpa.browser/1@1.0.0` does not change.
- Snapshot bodies use the accepted Evidence chunk/ACK flow; large bodies do
  not enter Control frames.
- Existing Workflow and Node schemas, IR2 plans, Runs, PageModels and
  ElementContracts are not migrated or recompiled.
- A pre-0.5 Core must reject unknown authoring requests without changing
  existing runtime behavior.
- v1alpha1 is strict: unknown fields are invalid. Additive model changes require
  a new alpha version or an explicitly optional field accepted by every
  producer and consumer.
- SQLite v9 will persist these contracts append-only after this candidate is
  accepted; the Schema decision itself does not mutate a database.

## 9. Canonical examples

- `authoring-scenario-spec-v1alpha1.example.json`
- `authoring-session-v1alpha1.example.json`
- `authoring-page-snapshot-v1alpha1.example.json`
- `authoring-candidate-bundle-v1alpha1.example.json`

The JSON Schemas in `packages/schemas/schema/` remain the machine-readable
source of truth.
