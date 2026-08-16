# Kyxo Architecture Decision Records

This directory holds the sixteen ADRs of the Kyxo research program. Every ADR is written from
`research/DESIGN-SPINE.md` (the binding design contract) under the claim-labeling discipline of
`research/METHODOLOGY.md`. All ADRs share one format: Title / Status / Context (forces, with
labeled evidence citations into `research/notes/`) / Decision (imperative) / Alternatives
considered / Consequences (positive **and** negative) / Evidence & confidence block.

**Status legend.** All records are currently **Proposed (pre-adversarial-review)**: they state the
spine's decisions with their evidence and costs, and are inputs to the adversarial review phase,
which may amend them (amendments land in the spine's amendment log and in each ADR's status line).

## Index

### Kernel identity and truth plane (001–002)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-001](ADR-001-agent-not-a-kernel-primitive.md) | Agent is not a kernel primitive | "Agent" is a userland configuration — harness + bound capability set + Grants + a Cell; the word never appears in kernel code. |
| [ADR-002](ADR-002-journal-first-event-sourcing-with-checkpoint-composite.md) | Journal-first event sourcing with checkpoint composite | Truth is a typed append-only journal composed with checkpoint cuts (journal position + snapshot + pending invocations), two-tier storage, and two-plane events; rejects mutable-state+audit-log, Temporal-style positional replay, and pure snapshots. |

### Capability substrate (003)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-003](ADR-003-capability-contract-axis-typed-tiered-manifests.md) | Capability contract: axis-typed tiered manifests with three information sources | Manifests declare typed axes with tiers (three-tier grammar); Bindings compute from declared + probed + observed sources; enforced vs. advisory is explicit; missing required axes fail loudly at bind time. |

### Orchestration and the model boundary (004–006)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-004](ADR-004-graph-is-an-orchestration-strategy.md) | Graph is an orchestration strategy, not the kernel | No edges or topology in the kernel; graphs compile onto dynamic invocation spawn with deterministic identity, joins, suspension, and checkpoints — as one strategy among peers. |
| [ADR-005](ADR-005-harness-is-a-behaviour-contract-and-a-capability.md) | Harness is a behaviour contract and a capability | OTP split: kernel owns generic loop mechanics, harnesses supply policy callbacks; harnesses are versioned capabilities and harness×model pairs are the benchmarkable unit; opaque harnesses are a declared lower-guarantee class. |
| [ADR-006](ADR-006-model-adapters-are-code-bearing-plugins.md) | Model adapters are code-bearing plugins with behavior profiles and opaque carry-through | Adapters are encode/decode code plugins with axis manifests, per-model behavior profiles, opaque provider-state carry-through artifacts, a superset internal block model, and a typed passthrough escape hatch; rejects the LCD universal model API and config-only adapters. |

### Edges and subsystems (007–008)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-007](ADR-007-protocol-strategy-project-dont-invent.md) | Protocol strategy: project, don't invent | Speak MCP southbound, A2A at the federation edge, a versioned kernel event protocol to surfaces; the internal Invocation algebra projects onto MCP-tasks/A2A as dialects; no new universal wire protocol, no external protocol as internal architecture. |
| [ADR-008](ADR-008-context-and-memory-are-separate-subsystems.md) | Context and memory are separate subsystems | Context is a deterministic, provenance-bearing compiled view; memory is durable labeled cells with a compile hook; compaction is a journaled event with pluggable (client/harness/provider-side) executors; rejects messages[]-as-context and provider-session-as-memory. |

### Durability, implementation posture, and objectives (009–011)

*Authored in the parallel workstream.*

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-009](ADR-009-durable-execution-journal-injection.md) | Durability by journal injection, not replay determinism | Recovery is record-and-inject: journaled outcomes are matched by idempotency key — not history position — and injected on re-drive; no positional-replay determinism contract on strategy code. |
| [ADR-010](ADR-010-typescript-reference-kernel-protocol-first.md) | TypeScript reference kernel, protocol-first, single-node V1 | The kernel API is a date-versioned schema first (conformance-enforced, replaceable implementation); V1 is TypeScript, single-node, SQLite/JSONL journal + file CAS, with WASM component hosting as the isolation path. |
| [ADR-011](ADR-011-objective-as-registered-kind.md) | Objective is a registered Kind over a root invocation, not a kernel primitive | Objectives are schema-validated userland artifacts (intent, success criteria, constraints) whose success criteria bind to the commit gate; the kernel sees only invocations. |

### Verification, security, budgets, and delegation (012–016)

*Authored in the parallel workstream.*

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-012](ADR-012-verification-commit-gate.md) | Verification is a kernel commit-gate hook with userland verifiers | Policy stages may require Evidence artifacts at two promotion points (outcome-commit, artifact-promotion); verifiers are ordinary capabilities and Evidence is a registered Kind. |
| [ADR-013](ADR-013-object-capability-security-taint.md) | Object-capability security with taint propagation | Grants are the only authority (no ambient authority, invisible interposition); integrity/confidentiality/taint labels propagate structurally through derivation and survive into the context compile. |
| [ADR-014](ADR-014-budgets-attenuated-quantitative-grants.md) | Budgets are attenuated quantitative grants, kernel-decremented | Budgets ride on Grants as typed units (tokens, money, wall-clock, invocations, spawn depth/width, risk class); the grant lineage tree is the resource-attribution tree by construction. |
| [ADR-015](ADR-015-delegation-capability-invocation-attenuated-grants.md) | Delegation is capability invocation under attenuated grants with lineage | No delegation subsystem: delegation = invoking an orchestrator capability under a child ≤ parent Grant; recursion control is grant arithmetic; lineage is a journal projection; delegated results pass the commit gate. |
| [ADR-016](ADR-016-single-node-kernel-portable-checkpoints.md) | Single-node kernel; distribution via portable checkpoints and protocol edges | Single-node execution semantics with distribution at the boundaries: portable definition-scoped checkpoints for state-transfer migration and protocol adapters (A2A/MCP/surfaces) at the edges; no in-kernel mesh. |

## Reading order

- For the kernel thesis: 001 → 004 → 005 → 002 → 009.
- For the capability substrate: 003 → 006 → 007.
- For authority and safety: 013 → 014 → 015 → 012.
- For state and subsystems: 002 → 008 → 011.
- For implementation posture: 010 → 016.
- Cross-references into the main doc set: 05-KERNEL-PRIMITIVES (vocabulary and objects),
  06-CAPABILITY-SPEC (manifest schema), 08-EVENT-AND-STATE-MODEL (journal/checkpoint detail),
  09-CONTEXT-AND-MEMORY, 10-HARNESS-AND-GRAPH-RUNTIME, 11-SECURITY-AND-POLICY,
  12-EXTENSION-MODEL, 14-MVP-ARCHITECTURE.
