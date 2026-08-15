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
  DESIGN-SPINE.md         Internal coordination document: the load-bearing design decisions
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

## Reading order

1. `docs/01-EXECUTIVE-THESIS.md` — the conclusion and why
2. `docs/05-KERNEL-PRIMITIVES.md` + `docs/06-CAPABILITY-SPEC.md` — the core design
3. `docs/07-RUNTIME-ARCHITECTURE.md` — how it fits together
4. `docs/16-ADR/` — the consequential decisions, each with alternatives considered
5. Everything else as reference depth

## Prototypes

Prototypes are TypeScript with zero runtime dependencies, runnable on Node ≥ 22:

```
cd prototypes && npx tsc --noEmit   # type-check
node --experimental-strip-types kernel/demo.ts
```

They are throwaway validation artifacts, not the beginning of the implementation.
