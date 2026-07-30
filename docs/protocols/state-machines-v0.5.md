# BPA v0.5 state machines

Status: accepted (human confirmation on 2026-07-30)

This document extends the accepted v0.4 state machines. Run, Assistance,
Dataset and Decision transitions remain unchanged.

## Evidence transfer

```text
declared
  → receiving
  → complete
  → acknowledged
  → linked

declared | receiving
  → rejected
  → expired
```

- `declared` freezes ownership, expected size, chunk count and digest.
- `receiving` advances only the persisted `next_chunk_index`.
- An identical chunk replay is idempotent; conflicting replay is rejected.
- `complete` requires every chunk and the whole-object digest to match.
- `acknowledged` permits the Extension to clear its pending Blob.
- `linked` occurs atomically with application of the owning Runtime Result.
- A terminal Evidence record cannot be rebound to another Run, execution or
  fencing token.

## Blob and asset

```text
staging
  → verified
  → stored
  → referenced
  → eligible_for_retention
  → deleted

staging | verified
  → rejected
  → expired
```

`stored` means the Blob is present under its content digest. `referenced` is a
relationship, not a mutable Blob state; multiple Assets may safely refer to the
same digest. A Blob with any active reference is not eligible for deletion.
Retention only deletes after a compare-and-swap recheck of references and
policy.

## Resource binding

```text
requested
  → validated
  → frozen
  → available
  → authentication_required
  → available

requested | validated
  → rejected

frozen | available | authentication_required
  → revoked
```

- Validation checks the exact Session, Capability Manifest digest, Origin and
  authentication level.
- A Run only starts after every required slot is frozen.
- Dispatch revalidates the frozen slot; it never selects an alternative
  Session.
- Authentication recovery may refresh the same binding. Replacing a Session
  creates a new binding revision and Audit record.
- Revocation prevents new dispatch but does not erase historical evidence.

## Page readiness

```text
observing
  → stable_nonempty
  → stable_empty
  → timed_out
  → authentication_required
  → adapter_anomaly
  → cancelled
```

Only `stable_nonempty` and an explicitly permitted `stable_empty` satisfy a
Readiness Contract. A first zero-item observation does not transition to
`stable_empty`. Refresh returns to `observing` and is bounded by the published
Contract.

## Control negotiation

```text
connected
  → hello_received
  → negotiated
  → application_requests

connected | hello_received
  → incompatible
  → malformed
  → frame_too_large
  → closed
```

An incompatible, malformed or oversized connection is closed independently.
No connection-level failure may terminate the Core daemon.
