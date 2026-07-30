# BPA v0.5 compatibility matrix

Status: candidate, awaiting human confirmation

| Producer | Accepted source | Frozen runtime form | Compatibility rule |
| --- | --- | --- | --- |
| Existing CLI/MCP | `bpa.control/1` through the legacy adapter | Existing request envelope | Small legacy requests remain supported; the client cannot assume v0.5 features |
| New CLI/MCP/Console | `bpa.control/hello/1`, then `bpa.control/1` | Negotiated max frame and feature snapshot | Incompatibility fails before any business request |
| Existing Workflow | `bpa/v1alpha1` or `bpa/v1alpha2` | Existing `bpa.workflow-ir/2` plan | No Resource Slot is invented during recovery |
| Resource-aware Workflow | `bpa/v1alpha3` | IR2 plan plus exact Resource Binding Snapshot | Every required slot must be frozen before Run start |
| Existing Node | `bpa/v1alpha1` | Existing immutable Node closure | Dispatch behavior is unchanged |
| Resource-aware Node | `bpa/v1alpha2` | Exact requirements plus Node closure | Resource requirements cannot be supplied as ordinary Node input |
| Browser runtime | `bpa.browser/1@1.0.0` | Existing Session and Command state | Wire Schema remains unchanged; reserved Evidence messages become enabled |
| Browser Evidence producer | Evidence v1 messages | Complete digest-bearing Evidence record | A Result cannot promote incomplete or foreign Evidence IDs |
| Asset producer | AssetRecord v1alpha1 plus verified Blob | Content-addressed local storage | Caller paths never become storage references |
| Source producer | SourceRecord v1alpha1 | Immutable source metadata and raw digest | Missing access or metric provenance remains explicit |
| Page authoring | PageModel/ElementContract plus Readiness Contract | New exact Adapter version | Existing Adapter versions do not inherit later readiness behavior |

## Upgrade constraints

- `bpa.browser/1@1.0.0`, Evidence v1 and `bpa.workflow-ir/2` retain their
  identifiers.
- Browser Evidence activation must pass two-sided compatibility tests before
  an Extension or Core containing it is distributed.
- SQLite v7/v8 are append-only. Historical Events, Node Executions and plan
  snapshots are not rewritten.
- Runtime 0.3 must refuse a v7/v8 database during an unsafe manual rollback.
- Existing active Runs never acquire Resource Slots or new Adapter readiness
  semantics.
- `parallel`, generic `paginate`, arbitrary back-edges, browser writes and
  untrusted code remain unsupported.

## Formal freeze boundary

The following require a later protocol or ADR:

- changing the Evidence ACK or Result-linking order;
- allowing application frames larger than the negotiated limit;
- resolving a Resource Slot from Workflow input or page content;
- automatically switching Browser Sessions;
- changing Asset retention while active references exist;
- placing selector, XPath, coordinates or script in a Readiness Contract.
