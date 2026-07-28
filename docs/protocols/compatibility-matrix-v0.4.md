# BPA v0.4 compatibility matrix

Status: protocol candidate

| Producer | Accepted source | Frozen runtime form | Recovery rule |
| --- | --- | --- | --- |
| Existing CLI/MCP | Workflow `bpa/v1alpha1` | Adapted to `bpa.workflow-ir/2`, single root scope | Existing active Run is compiled once from its immutable published closure, then the plan snapshot is mandatory |
| New CLI/MCP | Workflow `bpa/v1alpha2` | `bpa.workflow-ir/2` | Always resume the stored canonical plan; never consult newer catalog assets |
| Engine | IR2 only | Exact Node/Adapter/Policy/Profile refs and risk snapshot | Reject missing closure assets and digest drift |
| Browser runtime | Existing `bpa.browser/1` | Exact Node version resolved by the Extension capability manifest | No protocol change; old fencing token and old page epoch remain invalid |
| Assistance provider | `bpa.assistance/v1alpha1` Task | Durable Task plus Lease/fencing state | Duplicate Inbox submission is idempotent; stale Lease submission is rejected |
| Dataset worker | `bpa.data/v1alpha1` DatasetRef/query | Immutable published DatasetVersion | Never reopen a user file path during resume |
| Page authoring | `bpa.page/v1alpha1` Candidate assets | Published contracts compiled into a new Adapter version | An active Run never picks up a later PageModel |

## Upgrade constraints

- v1alpha1 Workflow and Node assets remain readable and publishable.
- The first v0.4 migration is append-only. It adds plan snapshots, scope and
  assistance/dataset records without rewriting historical events.
- A Runtime that cannot read `bpa.workflow-ir/2` must fail its pre-switch health
  check; it must not start a Run and rely on downgrade.
- `parallel`, generic `paginate`, `poll`, arbitrary back-edges and untrusted
  code remain compile-time errors in this compatibility window.

## Formal freeze boundary

Changing any of the following requires a new protocol/ADR version:

- execution identity components;
- IR2 step kinds or terminal meaning;
- AI/human authorization rules;
- Dataset immutability or DecisionRecord reuse identity;
- PageModel-to-Adapter publication mapping;
- `bpa.browser/1` envelope or command/result semantics.
