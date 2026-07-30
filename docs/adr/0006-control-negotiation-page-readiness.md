# ADR 0006: Control hello and page readiness contract candidates

- Status: proposed
- Date: 2026-07-30

## Context

Control clients need to discover compatibility before sending application
requests. Browser Adapters also need a shared way to describe page readiness
without leaking selectors, scripts or other page implementation details into a
Workflow.

This ADR defines contract candidates only. Core, client, transport and Adapter
runtime integration are not implemented by this decision.

## Decision

### Control hello

The first negotiated envelope uses `bpa.control/hello/1`. A client `hello`
contains:

- `requestId`
- ordered `supportedApplicationProtocols`
- `runtime` name and version
- `maxFrameBytes`
- advertised `features`

A successful `welcome` selects one application protocol, reports the server
Runtime, chooses the smaller frame limit and returns the feature intersection.
The existing application protocol remains `bpa.control/1`.

The hard control-frame ceiling is 512 KiB. A malformed hello has no trustworthy
request identity and maps to `MALFORMED_HELLO` with `requestId: null`. No common
application protocol maps to `NO_COMMON_APPLICATION_PROTOCOL`. An unusable
frame ceiling maps to `FRAME_LIMIT_TOO_SMALL`. Every negotiation error carries
`connection: "close"`: only that client connection is closed; the Core process
must remain alive. This repository change defines the wire values and pure
negotiation helper, not the server behavior.

### Page readiness

`bpa.page-readiness/v1alpha1` is an Adapter-owned, all-signals contract. It
contains:

- an immutable id and semantic version;
- one or more semantic target-presence signals;
- optional DOM quiet, network quiet and asset-count-stability signals;
- a finite timeout and at most three bounded refresh attempts.

An asset-count-stability signal requires at least two samples and a positive
minimum count, so an initial zero scan cannot be treated as a stable asset set.
Empty-state detection requires a separate reviewed semantic target.

The contract accepts semantic target and collection ids only. It has no field
for CSS, XPath, JavaScript or screen coordinates. It is compiled into and
versioned with a reviewed Adapter; Workflows continue to reference semantic
Nodes rather than readiness implementation.

## Consequences

Clients can fail compatibility checks before using `bpa.control/1`, and future
Adapter implementations can share deterministic readiness limits. Until
runtime integration is separately implemented and tested, these contracts do
not change live Core, CLI, Extension or browser behavior.
