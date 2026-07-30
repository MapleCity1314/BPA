# ADR 0005: Separate evidence, blobs, sources and browser resources

- Status: proposed
- Date: 2026-07-30

## Context

BPA 0.3 persists execution state and small JSON results, but Browser Evidence
transport is disabled. A real ecommerce research smoke run produced 36 images,
authenticated metrics and public assets from different browser contexts. It
also demonstrated that carrying binary data or large snapshots through the
Control Protocol can exceed frame limits and can destabilize an older Core.

Treating a source URL, a downloaded file, a verification screenshot and a
business claim as the same object would make retention, integrity, access and
recovery ambiguous. Letting Workflow input choose a Browser Session would also
allow untrusted page or user data to cross the capability boundary.

## Decision

1. A `SourceRecord` describes provenance and access context. It is not proof
   that a Blob was successfully stored.
2. An `AssetRecord` describes an immutable, digest-addressed Blob and its
   derivation. SQLite stores metadata and references, not the Blob body.
3. Evidence v1 remains execution-scoped verification metadata. Explicit
   `EvidenceLink` records connect Evidence to Sources and Assets.
4. Only Core creates storage references. Ingest uses a Core-issued staging
   lease or the existing Browser Evidence messages; arbitrary caller paths are
   rejected.
5. Browser Evidence is linked to a Runtime Result only after ownership, chunks,
   size and digest are complete and durable.
6. Browser Sessions are frozen as Run Resource Bindings. Workflow input and
   page content cannot select or replace them.
7. Node and Workflow alpha versions may add resource declarations, while IR2
   execution identity and Browser Protocol v1 remain unchanged.

## Consequences

- Control messages remain bounded metadata even when a Run handles many images.
- Duplicate content shares one Blob without merging provenance or business
  meaning.
- Retention can remove unreferenced data without breaking active packs or
  historical execution records.
- Multi-source workflows can use authenticated and public browser contexts
  without silently changing sessions.
- Console uploads require a staging-lease flow.
- Enabling Browser Evidence and Resource Bindings requires append-only
  persistence migrations and new conformance tests.

## Rejected alternatives

- **SQLite Blob storage:** increases transaction and backup cost and makes
  multi-gigabyte Runs unsafe.
- **Absolute local paths in Node output:** creates path traversal, portability
  and resume ambiguity.
- **Binary Control frames:** couples business payload size to daemon control
  health.
- **Automatic Browser Session selection at dispatch:** makes recovery and audit
  non-deterministic.
- **Putting selectors or readiness expressions in Workflow:** bypasses the
  Adapter and PageModel publication boundary.
