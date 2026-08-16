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
  16-ADR/                         Architecture Decision Records (001-023)
  17-KERNEL-SEMANTICS.md          Normative semantics: journal, commit, fork, dedup, lineage
  18-KERNEL-INVARIANTS.md         25 invariants: rationale, enforcement, test, failure mode
  19-CRASH-RECOVERY-MODEL.md      Crash matrix and failure semantics
  20-SEMANTIC-TEST-RESULTS.md     What was tested, what was falsified, what remains at risk
  21-AMENDMENT-RECONCILIATION.md  A1-A14 ledger
  22-RECORD-FORMAT-FREEZE-DECISION.md  Freeze gate: NOT READY, with the blocker taxonomy
  23-REPOSITORY-AND-CONSUMER-ARCHITECTURE.md  Repository layout, package boundaries, consumers
prototypes/
  README.md               Why nothing here is production code
  kernel/                 Phase-1 universality demo (eight constructs, one invocation path)
  harness/ graph/ loop/   Phase-1 strategy demos
  kernel-semantics/       Phase-2 executable kernel: src/, tests/, reference-model/, fuzz.ts
```

## Status

**Phase 1 (architecture): complete.** Recommendation: **BUILD WITH CHANGES** — see
`docs/01-EXECUTIVE-THESIS.md` and, for the re-argued version, `docs/16-ADR/ADR-021`.

**Phase 2 (executable kernel semantics): complete.** The semantics are now executable and
were attacked by six specialist reviewers with the code in hand. Record-format decision:
**NOT READY TO FREEZE** — `docs/22-RECORD-FORMAT-FREEZE-DECISION.md`. Ten defects were
found and fixed during the phase; 52 further findings block the freeze and constitute the
specification for the next phase. The kernel *semantics* largely survived; the *record
format* did not.

Run the executable semantics:

```bash
cd prototypes && npm install
npx tsc --noEmit
node --experimental-strip-types --test kernel-semantics/tests/*.test.ts
KYXO_FUZZ_SEEDS=1000 KYXO_FUZZ_LENGTH=70 node --experimental-strip-types kernel-semantics/fuzz.ts
```

### How the two reviews went

**Review #1 (architecture, ten reviewers: eight personas + two auditors)** voted BUILD WITH
CHANGES unanimously and answered the "useful primitive layer or merely another abstraction
layer?" gate question QUALIFIED-YES unanimously, producing 121 findings (7 FATAL, 49
SERIOUS). Its FATAL findings became binding amendments **A1–A14** in the Amendment log of
`research/DESIGN-SPINE.md`; all fourteen are now reconciled across the documents
(`docs/21-AMENDMENT-RECONCILIATION.md`).

**Review #2 (executable semantics, six specialist reviewers with the code and tests in
hand)** voted NOT READY TO FREEZE unanimously, producing 22 FATAL / 40 SERIOUS / 10 MODERATE
findings, 52 of them freeze-blocking, several with working reproductions and several
discovered independently by multiple reviewers. Record: `research/ADVERSARIAL-REVIEW-2.md`.

**Precedence:** the executable semantics (`prototypes/kernel-semantics/`, specified in docs
17–19) govern where they disagree with earlier prose; the Amendment log governs where it
disagrees with document bodies.

## What Kyxo Runtime is, and what it is not

Kyxo Runtime is a capability-oriented AI execution runtime: an execution substrate for
heterogeneous models, tools, harnesses, agents, workflows and capability types that do not
exist yet. It is **independently usable** — a third party with no connection to Kyxo can
build on it using the same contracts Kyxo's own products use.

It does **not** contain business logic, coding-domain logic, or any product concept. The
kernel does not know what an organization, a requirement, a repository, an editor or a
model vendor is.

Reference consumers, integrated through generic contracts rather than built in:

| Consumer | Role | Owns |
|---|---|---|
| **Kyxo Platform** (existing) | Consumer + capability provider | Organizations, projects, requirements, tests, defects, workflows, users, RBAC, business audit |
| **Kyxo Code** (future) | Consumer + capability provider + harness supplier | Repository indexing, code context, patch construction, git/build/test integration, coding harnesses |
| **Third parties** | Any of the four roles | Their own domain |

IDEs (VS Code, JetBrains), CLIs and web UIs are **clients** of a consumer — never of the
runtime, and never able to write runtime truth.

Full model: `docs/23-REPOSITORY-AND-CONSUMER-ARCHITECTURE.md`.
Decisions: `docs/16-ADR/ADR-022-runtime-consumer-boundary.md`,
`docs/16-ADR/ADR-023-coding-engine-is-ide-independent.md`.

## Reading order

1. `docs/01-EXECUTIVE-THESIS.md` — the recommendation, the strongest objections, and the
   answers to the thirty questions the program set out to answer
2. `research/DESIGN-SPINE.md` — the decisions, ending in the binding Amendment log
3. `docs/05-KERNEL-PRIMITIVES.md` + `docs/06-CAPABILITY-SPEC.md` — the core design
4. `docs/07-RUNTIME-ARCHITECTURE.md` — how it fits together
5. `research/ADVERSARIAL-REVIEW.md` — how hard it was attacked and what survived
6. `docs/23-REPOSITORY-AND-CONSUMER-ARCHITECTURE.md` — where each piece belongs, and who
   consumes the runtime
7. `docs/16-ADR/` — the consequential decisions, each with alternatives considered
8. Everything else as reference depth

## Prototypes

Prototypes are TypeScript with zero runtime dependencies, runnable on Node ≥ 22:

```
cd prototypes && npm install
npx tsc --noEmit                                              # type-check everything
node --experimental-strip-types --test kernel-semantics/tests/*.test.ts   # 45 semantic tests
bash kernel/validate.sh                                        # phase-1 universality gates
```

The phase-1 prototypes are throwaway validation artifacts. The phase-2 kernel-semantics
prototype is a **reference implementation of the specification**, not production code: it
exists to make the semantics executable and falsifiable, and doc 22 records why it is not
yet a foundation to build on.
