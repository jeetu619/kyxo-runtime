# Design Spine (internal coordination document)

Status: SKELETON — hypotheses registered before research synthesis; answers are filled in only
after the research notes in `notes/` land. Nothing here is a conclusion until marked DECIDED
with evidence. This document exists so that the 16 deliverable documents are written from one
coherent set of decisions instead of sixteen divergent ones.

## Hypotheses under test

H1. **Kernel hypothesis** — loop, graph, workflow, planner, swarm and agent are orchestration
strategies implementable on a smaller execution kernel; they do not need to be kernel
primitives. (User's initial hypothesis; to be challenged, not assumed.)

H2. **Capability hypothesis** — a single negotiated "capability" contract can represent models,
tools, agents, humans, remote runtimes and unknown future constructs without `switch(type)` in
the kernel, and without collapsing into a lowest-common-denominator interface.

H3. **Determinism split** — resource governance, lifecycle, persistence, policy and replay can
be fully deterministic while all reasoning stays in capabilities; no LLM behavior needs to
live inside kernel responsibilities.

H4. **Negotiation over identity** — "what can you do" (declared/negotiated capability sets,
LSP/MCP-style) is a workable substitute for "what provider are you", provided provider-native
extensions remain reachable through typed escape hatches.

H5. **Event-sourced truth** — an append-only event log is the correct source of truth for
execution history, enabling replay/branching/audit, with projected state for speed; and this
does NOT require Temporal-style determinism constraints on strategy code.

Counter-hypotheses that research must take seriously:

C1. The layer already exists piecemeal (MCP + A2A + a durable engine + any SDK) and the glue is
thin enough that a new kernel adds abstraction without power.
C2. Harnesses win on model-specific tuning; a model-independent kernel structurally forfeits
the quality that makes harnesses valuable (the "harness quality IS model coupling" objection).
C3. Negotiated capability sets describe *availability*, not *competence*; routing needs
empirical performance data, which no contract can declare.
C4. The simple case cannot stay simple: kernels grow APIs, and adoption dies in the gap
between `runtime.run(objective)` and the real configuration surface.

## Decisions to make (ADR register)

| ADR | Question | Status |
|---|---|---|
| 001 | Is Agent a kernel primitive? | pending |
| 002 | Event sourcing vs mutable state | pending |
| 003 | Capability contract design | pending |
| 004 | Graph: kernel vs orchestration layer | pending |
| 005 | Harness abstraction | pending |
| 006 | Model provider abstraction & escape hatches | pending |
| 007 | Protocol strategy (MCP, A2A, own wire format?) | pending |
| 008 | Context vs memory separation | pending |
| 009 | Durable execution approach (checkpoint vs journal vs replay) | pending |
| 010 | Language/runtime choice | pending |
| 011 | Objective as primitive vs prompt | pending |
| 012 | Verification as kernel concern vs capability | pending |
| 013 | Security model (object-capability vs ACL/policy engine) | pending |
| 014 | Budgets/leases as kernel primitive | pending |
| 015 | Delegation/lineage model | pending |

## The 30 questions (final answers land in 01-EXECUTIVE-THESIS)

Tracked verbatim from the mission brief; each must be answered explicitly with evidence.
1. What exactly constitutes an AI harness? …30. Is there enough differentiation to justify
building this instead of extending an existing project? (Full list mirrored in
`docs/01-EXECUTIVE-THESIS.md` at completion.)

## Vocabulary (to be finalized in 05-KERNEL-PRIMITIVES)

The 26 terms from the mission brief get precise, non-interchangeable definitions. Working rule
until then: *model* = weights+inference; *model API* = wire protocol to inference; *model
adapter* = code translating runtime intent to one model API; *harness* = the opinionated layer
that turns a model into a competent worker (context assembly, tool exposure, loop, recovery);
*runtime* = the substrate that hosts harnesses and other capabilities; *kernel* = the minimal
deterministic core of the runtime.

## Fill-in sections (after research)

### Kernel primitive set — PENDING RESEARCH
### Capability contract shape — PENDING RESEARCH
### Event taxonomy core — PENDING RESEARCH
### Orchestration stance — PENDING RESEARCH
### Context/memory split — PENDING RESEARCH
### Security stance — PENDING RESEARCH
### Positioning + build recommendation — PENDING RESEARCH & ADVERSARIAL REVIEW
