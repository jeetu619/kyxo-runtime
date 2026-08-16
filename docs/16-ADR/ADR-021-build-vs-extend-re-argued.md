# ADR-021 — BUILD vs EXTEND, re-argued on executable evidence

Status: **Accepted** (2026-08-16, phase 2). Supersedes the BUILD reasoning in
`research/DESIGN-SPINE.md` §10 and amendment A6, which retracted "cannot be retrofitted"
as the sole discriminator. This ADR answers the mission's PART 13 question directly.

> **The question:** which unique capability does `kyxo-runtime` require that cannot
> reasonably be obtained by extending LangGraph, the OpenAI Agents SDK, Google ADK,
> Temporal + an agent SDK, or another existing runtime?

The instruction was to answer honestly and to say so if executable work *weakens* the
BUILD case. It weakened one leg and strengthened another. Both are recorded.

---

## 1. What the executable phase changed about the argument

**Weakened — the enforcement-floor leg.** The skeptical-CTO reviewer's FATAL was that
Kyxo V1 binds only cooperative code, exactly like middleware, so the enforcement
differentiator would not exist for several waves. Phase 2 **partly** answers this: the
commit barrier is now structural rather than cooperative, and a deliberately malicious
capability cannot reach the kernel, fabricate truth, or self-certify success past a
gate. But the containment boundary is still the process: the barrier prevents *reaching*
the kernel, not *corrupting shared process state*. Until isolation lands, the honest
claim is "a capability cannot bypass the commit path" — not "a hostile capability cannot
harm the runtime". The CTO's objection is reduced, not eliminated.

**Strengthened — the semantics leg.** Seven findings emerged from making the design
executable, and five were defects that would have been frozen into the record format. The
important observation is *where* they lived: fork/effect-identity inheritance,
authority forgery, recovery-time protection loss, staging lifetime, budget-ceiling
semantics. **Every one is a property of the kernel's own record format and lifecycle** —
precisely the layer that a host framework owns and that an extension cannot redefine.
This is now demonstrated rather than asserted.

---

## 2. The answer, capability by capability

What Kyxo requires that extending an incumbent cannot reasonably supply:

**(a) A lineage-scoped effect identity that a fork inherits with provenance.**
Effect identity, inheritance marking, protected-effect sets and fork dispositions are all
properties of the *host's* checkpoint and dedup format. LangGraph's checkpointer contract
persists channel values and versions; there is no per-effect identity to scope, no place
to record `inherited`, and no fork disposition concept — `source: "fork"` copies a
thread. Retrofitting would mean redefining `BaseCheckpointSaver`'s contract, i.e.
breaking every third-party checkpointer. (SOURCE-CODE OBSERVATION, HIGH,
`research/notes/langgraph.md`.)

**(b) An in-doubt invocation state with typed dispositions.**
Temporal, Restate and DBOS all define success as "no exception"; retry policy classifies
errors but nothing represents "the effect may have landed". Adding `uncertain` means
adding a state to the engine's own execution model, not a library on top. A2A's task
lifecycle likewise has no in-doubt state. (FACT, HIGH, durable-execution and a2a notes.)

**(c) A structurally unbypassable commit gate.**
This requires that the *host* deny userland a write path. On MAF or LangGraph, node code
runs in-process with full access to the framework's state objects; a gate implemented
above them is advisory — which is the enforcement class the incumbents already offer and
which ADR-017 rejects.

**(d) Budget lineage with attenuation as a kernel invariant.**
The evidence for absence is unusually strong: env-var caps (Claude Code), reporting-only
usage (OpenAI), per-run counters that lose delegated spend across an effect boundary
(PydanticAI's own open issue). Adding it to a host means intercepting every effect
boundary the host owns.

**(e) A portable execution record.**
"Durable execution has no MCP-equivalent" — no incumbent offers a portable record format,
and each one's format is its lock-in. A format defined inside a host is hostage to that
host's schema evolution.

## 3. Where EXTEND remains genuinely better

Stated plainly, because a decision note that only argues one way is advocacy:

- **Orchestration.** LangGraph's channel/superstep kernel and MAF's typed-executor
  workflows are better than anything this project should build, and Kyxo deliberately
  does not compete: strategies are userland, and hosting Kyxo cells under either engine
  remains an integration target.
- **Provider coverage and ecosystem.** The incumbents' adapter surface, tooling and
  installed base are years ahead and not worth re-creating.
- **Time to first user.** An extension ships in weeks; a kernel ships in waves. If the
  goal were a product rather than a substrate, EXTEND would win outright.

## 4. Decision

**BUILD WITH CHANGES**, unchanged in direction from phase 1, but now resting on a
narrower and better-evidenced claim:

> Kyxo must own the **record format and the effect/authority lifecycle** — effect
> identity, inheritance, uncertainty, commit promotion, grant lineage — because the
> phase-2 defects proved these are host-owned properties that no extension can redefine
> without breaking the host's public contract. Everything above that line (orchestration,
> harnesses, planners, provider adapters) is explicitly *not* differentiated and should
> integrate with incumbents rather than replace them.

The fallback remains live and now has a sharper trigger: **if the isolation wave's
crossing-cost measurements fail their budget, the enforcement leg does not recover, and
the honest move is to ship the record format as a specification plus strategies hosted on
MAF/LangGraph** — capturing (a), (b), (d) and (e) as a portable contract while conceding
(c).

## 5. Consequences

**Positive.** The claim is now falsifiable and scoped: it names five specific properties
and the reason each is host-owned. It also tells the project what *not* to build.

**Negative.** The scope is narrower than the original ambition. A kernel that owns only
the record and lifecycle layer is less exciting than "the runtime beneath agent
frameworks", and its adoption depends on other people's strategies choosing to sit on
it — an ecosystem bet that executable evidence cannot settle. Governance (amendment A5)
is therefore load-bearing, not administrative.

## Evidence and confidence

- EXECUTABLE (HIGH): the seven findings of doc 20, each localized to the record/lifecycle
  layer.
- SOURCE-CODE OBSERVATION / FACT (HIGH): incumbent absences per the research notes.
- Confidence **HIGH** that the five properties are host-owned; **MEDIUM** that owning
  them is sufficient reason for adopters to take a new substrate; **LOW** confidence in
  any timeline claim.
