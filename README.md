# Kyxo Runtime — Architecture Research

Research and architecture program investigating whether a **universal, model-independent AI
execution runtime** should exist beneath today's agent SDKs and harnesses — and if so, what its
minimal kernel looks like.

The central question:

> Can models, tools, agents, workflows, skills, computers, humans, remote runtimes, protocols,
> and future constructs be dynamically discoverable and composable **capabilities** rather than
> hard-coded first-class concepts — while the runtime stays simple enough to build, operate,
> debug and adopt?

This repository currently contains **research, architecture and prototypes only** — deliberately
no production implementation. See `docs/15-IMPLEMENTATION-ROADMAP.md` for the build plan and
`docs/01-EXECUTIVE-THESIS.md` for the final recommendation.

## Layout

```
research/
  METHODOLOGY.md          Research discipline: source ledger, claim labeling, confidence levels
  notes/                  Primary research notes, one per ecosystem domain, with citations
  DESIGN-SPINE.md         The load-bearing design decisions + the binding Amendment log (A1–A14)
  ADVERSARIAL-REVIEW.md   Ten-reviewer adversarial review: 121 findings, votes, verdicts
  OPEN-ISSUES.md          Writer self-reports and prototype findings (review input)
docs/
  01-EXECUTIVE-THESIS.md          Problem, thesis, objections, recommendation
  02-ECOSYSTEM-RESEARCH.md        Synthesized ecosystem research with labeled evidence
  03-HARNESS-COMPARISON.md        Comparison matrix of major systems
  04-ORCHESTRATION-MODELS.md      Loop / planner / graph / events / actors / swarm analysis
  05-KERNEL-PRIMITIVES.md         Derivation of the minimal kernel vocabulary
  06-CAPABILITY-SPEC.md           Capability discovery, negotiation, binding, invocation
  07-RUNTIME-ARCHITECTURE.md      Full architecture with diagrams
  08-EVENT-AND-STATE-MODEL.md     Events, state, persistence, replay, checkpoints
  09-CONTEXT-AND-MEMORY.md        Context and memory subsystems
  10-HARNESS-AND-GRAPH-RUNTIME.md Harnesses, loops, graphs, planners on the kernel
  11-SECURITY-AND-POLICY.md       Security and policy model
  12-EXTENSION-MODEL.md           Extension/plugin/compatibility strategy
  13-FUTURE-SCENARIO-TEST.md      Architecture vs 15+ hypothetical future paradigms
  14-MVP-ARCHITECTURE.md          Smallest architecture that tests the hypothesis
  15-IMPLEMENTATION-ROADMAP.md    Implementation waves
  16-ADR/                         Architecture Decision Records
prototypes/
  kernel/                 Type-level and small runnable prototypes validating the kernel
```

## Status

The architecture phase is complete. Recommendation: **BUILD WITH CHANGES** — see
`docs/01-EXECUTIVE-THESIS.md`. Ten adversarial reviewers (eight personas, two auditors) voted
BUILD WITH CHANGES unanimously and answered the "useful primitive layer or merely another
abstraction layer?" gate question QUALIFIED-YES unanimously, producing 121 findings
(7 FATAL, 49 SERIOUS). All FATAL findings are adjudicated as binding amendments **A1–A14** in
the Amendment log of `research/DESIGN-SPINE.md`.

**Reading the amendments correctly:** the amendment log is authoritative. Documents 02–15 and
the ADRs were written before the review; each carries a status banner naming which amendments
are applied in its body and which are adopted-but-not-yet-reflected. Where a document and the
amendment log disagree, the amendment log governs. Reconciling the remaining body text is the
outstanding editorial work (it changes no decision — every decision is recorded in the
amendment log and summarized in the thesis).

## Reading order

1. `docs/01-EXECUTIVE-THESIS.md` — the recommendation, the strongest objections, and the
   answers to the thirty questions the program set out to answer
2. `research/DESIGN-SPINE.md` — the decisions, ending in the binding Amendment log
3. `docs/05-KERNEL-PRIMITIVES.md` + `docs/06-CAPABILITY-SPEC.md` — the core design
4. `docs/07-RUNTIME-ARCHITECTURE.md` — how it fits together
5. `research/ADVERSARIAL-REVIEW.md` — how hard it was attacked and what survived
6. `docs/16-ADR/` — the consequential decisions, each with alternatives considered
7. Everything else as reference depth

## Prototypes

Prototypes are TypeScript with zero runtime dependencies, runnable on Node ≥ 22:

```
cd prototypes && npx tsc --noEmit   # type-check
node --experimental-strip-types kernel/demo.ts
```

They are throwaway validation artifacts, not the beginning of the implementation.
