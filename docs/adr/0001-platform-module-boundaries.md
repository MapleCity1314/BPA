# ADR 0001: Platform module boundaries

- Status: accepted
- Date: 2026-07-28

## Context

BPA 0.3 proves the local CLI → Core → Engine → Gateway → Extension path,
but several application packages currently share implementation details. The
next execution model, team worker, assistance queue, datasets and authoring
tools must not turn Local Core into a collection of platform-specific branches.

## Decision

The dependency direction is fixed:

```text
schemas
  ↓
workflow-ir / assistance-core / dataset-core / page-model
  ↓
compiler / node-runtime / authoring-core / persistence ports
  ↓
engine / gateway-core / browser-bridge / persistence-sqlite / adapters
  ↓
apps (composition and I/O only)
```

The following rules are enforced:

- Engine consumes `ExecutionPlan` and ports. It does not import Compiler,
  SQLite, Chrome, MCP, adapters or business rule packages.
- Compiler is a pure Workflow → IR adapter. It resolves immutable artifacts
  only through a Catalog port.
- Runtime implementations register through `RuntimeProvider`; Engine does not
  grow a branch for every runtime or platform.
- Persistence exposes generic records and named units of work. SQLite is one
  implementation, not a domain dependency.
- Workflow source never contains selectors, XPath, coordinates or JavaScript.
- Browser page knowledge belongs to an Adapter and its versioned PageModel.
- Company rule code belongs to an allowlisted Team Worker handler. The worker
  does not access the Core database directly.
- Packages do not import applications or another package's private `src` path.
- CLI and MCP share a control protocol/client package rather than importing
  Local Core implementation.

## Consequences

Shared contracts must be frozen before parallel implementation. Adding a new
runtime requires a provider, contract tests and composition registration, but
does not require Engine changes. Doudian and packaging concepts cannot appear
in Engine or generic persistence table names.
