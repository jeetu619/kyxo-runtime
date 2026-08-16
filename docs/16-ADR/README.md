# Kyxo Architecture Decision Records

> **Post-review status (2026-08-16, phase 2).** This index has been reconciled against the
> Amendment log of `research/DESIGN-SPINE.md` (A1–A14) and against the executable semantics in
> `prototypes/kernel-semantics/`. **The one-line summaries below state the decisions as they now
> stand, not as they were first drafted** — where an amendment or a phase-2 ADR changed a
> mechanism, the summary says so and names the superseding record. The ADR *bodies* are revised
> in a separate workstream; until that lands, a body may still describe a superseded mechanism,
> and in that case the amendment log and the phase-2 ADRs (017–021) govern.

This directory holds the twenty-one ADRs of the Kyxo research program. Every ADR is written from
`research/DESIGN-SPINE.md` (the binding design contract) under the claim-labeling discipline of
`research/METHODOLOGY.md`. ADRs 001–016 share one format: Title / Status / Context (forces, with
labeled evidence citations into `research/notes/`) / Decision (imperative) / Alternatives
considered / Consequences (positive **and** negative) / Evidence & confidence block. ADRs
017–021 follow the same shape with an added record of what execution falsified.

**Status legend.**

- **001–016 — Proposed (pre-adversarial-review), as amended.** They state the spine's original
  decisions with their evidence and costs. The adversarial review's binding adjudications
  (A1–A14) amend several of them; each ADR carries a post-review banner naming the amendments
  that apply to it.
- **017–021 — Accepted (2026-08-16, phase 2).** These were forced by the review and by the
  executable kernel: each supersedes or amends a named earlier ADR, and each is backed by tests
  in `prototypes/kernel-semantics/` rather than by argument alone.

## Index

### Kernel identity and truth plane (001–002)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-001](ADR-001-agent-not-a-kernel-primitive.md) | Agent is not a kernel primitive | "Agent" is a userland configuration — harness + bound capability set + Grants + a Cell; the word never appears in kernel code. |
| [ADR-002](ADR-002-journal-first-event-sourcing-with-checkpoint-composite.md) | Journal-first event sourcing with checkpoint composite | Truth is a typed append-only journal composed with checkpoint cuts (journal position + snapshot + pending invocations), two-tier storage, and two-plane events; rejects mutable-state+audit-log, Temporal-style positional replay, and pure snapshots. **Amended by A1 and ADR-018: effect identity is lineage-scoped**, and forking a cut with pending invocations requires an explicit journaled disposition per pending (`adopt` / `re-lease` / `compensate` / `abandon`). **This record is normative for recovery semantics** — where it and ADR-009 overlap, ADR-002 governs. |

### Capability substrate (003)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-003](ADR-003-capability-contract-axis-typed-tiered-manifests.md) | Capability contract: axis-typed tiered manifests with three information sources | Manifests declare typed axes with tiers (three-tier grammar); Bindings compute from declared + probed + observed sources; enforced vs. advisory is explicit; missing required axes fail loudly at bind time. Per A13 the computed Binding gates **eligibility** only — selection among eligible candidates is a routing strategy with a journaled rationale; per A10 a tiered axis carries its ordered ladder in manifest data, so the kernel never learns axis semantics. |

### Orchestration and the model boundary (004–006)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-004](ADR-004-graph-is-an-orchestration-strategy.md) | Graph is an orchestration strategy, not the kernel | No edges or topology in the kernel; graphs compile onto dynamic invocation spawn with deterministic identity, joins, suspension, and checkpoints — as one strategy among peers. Breadth evidence rescoped per A9(i): zero of the **seven source-inspected** coding agents contain a graph engine, Copilot's cloud agent shows none in its documented pipeline, Windsurf is not evidenced either way. |
| [ADR-005](ADR-005-harness-is-a-behaviour-contract-and-a-capability.md) | Harness is a behaviour contract and a capability | OTP split: kernel owns generic loop mechanics, harnesses supply policy callbacks; harnesses are versioned capabilities and harness×model pairs are the benchmarkable unit; opaque harnesses are a declared lower-guarantee class (A3's `declared` grade, above the mediation waterline). |
| [ADR-006](ADR-006-model-adapters-are-code-bearing-plugins.md) | Model adapters are code-bearing plugins with behavior profiles and opaque carry-through | Adapters are encode/decode code plugins with axis manifests, per-model behavior profiles, opaque provider-state carry-through artifacts, a superset internal block model, and a typed passthrough escape hatch; rejects the LCD universal model API and config-only adapters. Per A9(ii), "Realtime/Live cannot be lowered onto function calls" is **INFERENCE/HIGH** grounded in transport FACTs, not FACT. |

### Edges and subsystems (007–008)

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-007](ADR-007-protocol-strategy-project-dont-invent.md) | Protocol strategy: project, don't invent | Speak MCP southbound, A2A at the federation edge, a versioned kernel event protocol to surfaces; the internal Invocation algebra projects onto MCP-tasks/A2A as dialects; no new universal wire protocol, no external protocol as internal architecture. |
| [ADR-008](ADR-008-context-and-memory-are-separate-subsystems.md) | Context and memory are separate subsystems | Context is a deterministic, provenance-bearing compiled view; memory is durable labeled **memory cells — Kind records held in a single-writer store Cell**, never the kernel Cell itself; compaction is a journaled event with pluggable (client/harness/provider-side) executors; rejects messages[]-as-context and provider-session-as-memory. |

### Durability, implementation posture, and objectives (009–011)

*Authored in the parallel workstream.*

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-009](ADR-009-durable-execution-journal-injection.md) | Durability by journal injection, not replay determinism | Recovery is record-and-inject: journaled outcomes are matched by idempotency key — not history position — and injected on re-drive; no positional-replay determinism contract on strategy code. Per A1 those keys are **content-inclusive** (args hash mandatory) and **lineage-scoped**, so a fork does not inherit the parent's post-cut outcomes. This record owns the *injection mechanism*; **recovery semantics are normative in ADR-002** as amended by ADR-018/019. |
| [ADR-010](ADR-010-typescript-reference-kernel-protocol-first.md) | TypeScript reference kernel, protocol-first, single-node V1 | The kernel API is a date-versioned schema first (conformance-enforced, replaceable implementation); V1 is TypeScript, single-node, SQLite/JSONL journal + file CAS, with WASM component hosting as the isolation path. Per A4 the **replaceability claim is scoped to the execution record** until facade conformance fixtures exist — the provider/strategy-facing facade (`KernelApi`/`InvokeCtx`/`HarnessCtx`) is itself a Wave-0 frozen, versioned, conformance-tested contract, not merely the wire schemas. |
| [ADR-011](ADR-011-objective-as-registered-kind.md) | Objective is a registered Kind over a root invocation, not a kernel primitive | Objectives are schema-validated userland artifacts (intent, success criteria, constraints) whose success criteria bind to the commit gate; the kernel sees only invocations. |

### Verification, security, budgets, and delegation (012–016)

*Authored in the parallel workstream.*

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-012](ADR-012-verification-commit-gate.md) | Verification is a kernel commit-gate hook with userland verifiers | Policy stages may require Evidence artifacts at two promotion points (outcome-commit, artifact-promotion); verifiers are ordinary capabilities and Evidence is a registered Kind. The decision stands and is no longer aspirational: **the gate is now structurally enforced and executable** — providers hold no kernel handle and can only *propose* effects (ADR-017), so a capability cannot report success past a failed gate; asserted by invariants I4/I17 of `18-KERNEL-INVARIANTS.md` and by the universality suite. |
| [ADR-013](ADR-013-object-capability-security-taint.md) | Object-capability security with taint propagation | Grants are the only authority (no ambient authority, invisible interposition); integrity/confidentiality/taint labels propagate structurally through derivation and survive into the context compile. Per A8 and ADR-020, **authority is unforgeable handle identity, not a string**: userland holds kernel-minted Grant/Binding handles, presents no id for resolution, and journal grant references are deliberately non-resolvable identifiers. |
| [ADR-014](ADR-014-budgets-attenuated-quantitative-grants.md) | Budgets are attenuated quantitative grants — ~~kernel-decremented~~ **reserved and settled** (title superseded by A2) | Budgets ride on Grants as typed units (tokens, money, wall-clock, invocations, spawn depth/width, risk class) and the grant lineage tree is the resource-attribution tree by construction. Per A2, charging is **reserve-at-lease / settle-at-outcome / release-remainder** with three distinct event kinds (`grant.reserved`, `grant.settled`, `grant.released`); reservation is durable before dispatch, so exhaustion is detectable before spend. **Decrement-at-commit is retired everywhere.** Per ADR-020, a grant's limits are chain-enforced **ceilings, not partitions**: siblings may overcommit in aggregate while spend stays bounded by every ancestor. |
| [ADR-015](ADR-015-delegation-capability-invocation-attenuated-grants.md) | Delegation is capability invocation under attenuated grants with lineage | No delegation subsystem: delegation = invoking an orchestrator capability under a child ≤ parent Grant; recursion control is grant arithmetic; lineage is a journal projection; delegated results pass the commit gate. Per A10, child invocations run in **fresh cells**, so single-writer reentrancy deadlock is designed away rather than documented around. |
| [ADR-016](ADR-016-single-node-kernel-portable-checkpoints.md) | Single-node kernel; distribution via portable checkpoints and protocol edges | Single-node execution semantics with distribution at the boundaries: portable definition-scoped checkpoints for state-transfer migration and protocol adapters (A2A/MCP/surfaces) at the edges; no in-kernel mesh. |

### Forced by execution (017–021)

*Accepted 2026-08-16, phase 2. Each is backed by tests in `prototypes/kernel-semantics/`; each
supersedes or amends a named earlier record.*

| ADR | Title | Decision in one line |
|---|---|---|
| [ADR-017](ADR-017-capabilities-are-pure-proposers.md) | Capabilities are pure proposers; the commit barrier is structural | A capability receives data only — `InvokeCtx` carries no kernel, journal, storage or grant object — and yields `EffectProposal`s into a staging area it cannot address; the kernel validates and commits. Supersedes the *enforcement mechanism* assumed by ADR-012, whose decision stands. |
| [ADR-018](ADR-018-resume-continues-fork-branches.md) | Resume continues a lineage; fork branches it; effect identity is lineage-scoped | `resume` keeps the execution identity and folds the committed suffix forward; `fork` mints a new execution inheriting state **at the cut only**, with every pending invocation given an explicit journaled disposition and inherited unsafe effects refusing loudly rather than returning as cache hits. Amends ADR-002 and ADR-009; ADR-002 remains normative for recovery semantics. |
| [ADR-019](ADR-019-uncertainty-is-an-explicit-state.md) | Unknown external outcomes are an explicit lifecycle state, resolved only by disposition | `uncertain` is a first-class non-terminal state entered when an unsafe-class effect may have landed but no outcome was recorded; it is resolved only by a journaled `probe` / `adopt-landed` / `compensate` / `abandon-failed`, and a probe answering `unknown` leaves it uncertain. Extends the ADR-002/009 lifecycle. |
| [ADR-020](ADR-020-authority-is-object-identity.md) | Authority is object identity; grant limits are ceilings, not reservations | Grant handles are kernel-minted objects tracked in a private registry — forgery by known id, prototype or shallow copy all fail — and a grant's limits are ceilings enforced along the whole chain at admission rather than budget partitioned away. Amends ADR-013 and ADR-014; implements A8. |
| [ADR-021](ADR-021-build-vs-extend-re-argued.md) | BUILD vs EXTEND, re-argued on executable evidence | Answers the mission's PART 13 question on what the executable kernel actually demonstrated, recording which leg of the BUILD case the work weakened and which it strengthened. Supersedes the BUILD reasoning of spine §10 as amended by A6 (which retracted "cannot be retrofitted" as the sole discriminator and moved a non-cooperative enforcement floor into the MVP). |

## Reading order

- For the kernel thesis: 001 → 004 → 005 → 002 → 009 → 018.
- For the capability substrate: 003 → 006 → 007 → 017.
- For authority and safety: 013 → 020 → 014 → 015 → 012 → 017.
- For state, recovery and subsystems: 002 → 018 → 019 → 008 → 011.
- For implementation posture and the build decision: 010 → 016 → 021.
- Normative companions to the phase-2 records: `17-KERNEL-SEMANTICS.md` (semantics),
  `18-KERNEL-INVARIANTS.md` (invariants and their tests), `19-CRASH-RECOVERY-MODEL.md`,
  `20-SEMANTIC-TEST-RESULTS.md` (the five prose-vs-code corrections).
- Cross-references into the main doc set: 05-KERNEL-PRIMITIVES (vocabulary and objects),
  06-CAPABILITY-SPEC (manifest schema), 08-EVENT-AND-STATE-MODEL (journal/checkpoint detail),
  09-CONTEXT-AND-MEMORY, 10-HARNESS-AND-GRAPH-RUNTIME, 11-SECURITY-AND-POLICY,
  12-EXTENSION-MODEL, 14-MVP-ARCHITECTURE.

---

## Revision record (2026-08-16, phase 2)

Index-only reconciliation. **No ADR body was edited** — those are owned by a separate
workstream. What changed here is what the index *claims each ADR decides*, so that a reader of
the index is never told a superseded mechanism is current.

| Amendment / record | Change to the index |
|---|---|
| **A2** (budgets) | ADR-014's decision line rewritten to reserve-at-lease / settle-at-outcome / release-remainder with the three distinct event kinds, reservation durable before dispatch, and "decrement-at-commit is retired everywhere". The ADR's own title contains the superseded word "kernel-decremented"; since the body is out of scope, the title cell now strikes that word and names A2 as the superseding adjudication. Ceilings-not-partitions added from ADR-020. |
| **A8 / ADR-020** (authority) | ADR-013's decision line now states that authority is unforgeable **handle identity**, that userland never presents an id string for resolution, and that journal grant references are non-resolvable identifiers. |
| **A4** (facade freeze) | ADR-010's decision line now scopes the replaceability claim to the execution record until facade conformance fixtures exist, and names `KernelApi`/`InvokeCtx`/`HarnessCtx` as a Wave-0 frozen, versioned, conformance-tested contract in its own right. |
| **A1 / ADR-018** (effect identity) | ADR-002 and ADR-009 decision lines now both state **lineage-scoped, content-inclusive** effect identity and the mandatory journaled fork dispositions, with the ownership split made explicit: **ADR-002 is normative for recovery semantics**; ADR-009 owns the injection mechanism. This resolves the overlap the two records previously carried without adjudication. |
| **ADR-017** (commit barrier) | ADR-012's decision line now records that the gate is **structurally enforced and executable** — providers hold no kernel handle and can only propose effects — with the asserting invariants (I4, I17) named. The ADR-012 decision itself is unchanged. |
| **A9(i)** | ADR-004's decision line carries the rescoped breadth claim (seven source-inspected + Copilot-by-documented-pipeline + Windsurf not evidenced), matching docs 02 §2.4/§3.1, 03 §2.2/B1 and 04 §2.A/§4.1. |
| **A9(ii)** | ADR-006's decision line records the Realtime/Live lowering claim as INFERENCE/HIGH, not FACT. |
| **A3, A10, A13** | Reflected where they change a summary: ADR-005 (opaque harnesses are the `declared` grade above the mediation waterline), ADR-003 (eligibility-not-selection; tier ladders carried in manifest data), ADR-015 (child invocations run in fresh cells). |
| **Vocabulary** | ADR-008's summary now uses the ruled terms — memory cells are **Kind records held in a single-writer store Cell**, never the kernel Cell itself (see `09-CONTEXT-AND-MEMORY.md`). |
| **Completeness** | ADRs **017–021 existed on disk but were absent from this index**, and the header claimed "sixteen ADRs" with a status legend saying all records were Proposed. Added the *Forced by execution* section with one-line summaries drawn from each record's own context and status lines, corrected the count to twenty-one, split the status legend (001–016 Proposed-as-amended; 017–021 Accepted), and extended the reading orders and normative companions. |
