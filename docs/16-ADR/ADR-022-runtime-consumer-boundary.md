# ADR-022 — Kyxo Runtime is an independently usable runtime; Kyxo Platform and Kyxo Code are consumers

Status: **Accepted** (2026-08-16). Related: ADR-001 (Agent is not a kernel primitive),
ADR-017 (capabilities are pure proposers), ADR-021 (BUILD vs EXTEND), and
`docs/23-REPOSITORY-AND-CONSUMER-ARCHITECTURE.md`, which elaborates the decision.

## Context

Kyxo Runtime is being built inside an organization that also owns an existing QA/ALM
product (Kyxo Platform) and intends to build a coding product (Kyxo Code). The default
organizational gravity is for a runtime built by a product company to become *that
product's* runtime: business concepts leak inward, the first consumer's needs become
structural, and the "generic" layer quietly acquires an `if (platform)`.

Two facts make the question urgent now rather than later.

**First, the architecture's central claim depends on the answer.** ADR-021 re-argued BUILD
over EXTEND on the grounds that Kyxo must own the record and lifecycle layer *because it is
generic* — a portable execution record, capability negotiation with no home in incumbents,
governance freedom. A runtime that encodes one company's business objects forfeits every
one of those arguments and would be better implemented as a Platform subsystem.

**Second, the invariant is currently intact and cheap to keep.** A scan of the kernel
sources finds no product name, no provider name and no IDE name; the CI universality test
already fails the build on capability-identity branching (invariant I1, doc 18). The cost
of holding this line today is a documented boundary. The cost of recovering it after
consumer code lands is a rewrite.

Evidence from the research base also cuts one way. Every runtime studied that stayed
generic (LangGraph's channel kernel, MAF's typed executors) hosts orchestration it does not
understand; the systems that fused product and substrate (Claude Code's closed engine,
Cursor's server-coupled loop) are excellent products and are not reusable substrates. The
program chose to build a substrate.

## Decision

**Kyxo Runtime is an independently usable, generic AI execution runtime. Kyxo Platform and
Kyxo Code are reference consumers that integrate exclusively through contracts available to
any third party.**

Concretely:

1. **No consumer concept is a kernel concept.** The kernel knows capabilities, bindings,
   invocations, effects with declared classes, grants, events, artifacts, checkpoints and
   registered Kinds. It does not know organizations, projects, requirements, tests,
   defects, workflows, repositories, editors, tenants or roles.
2. **No kernel behaviour branches on consumer identity** (invariant C4, already enforced).
3. **Consumers integrate in one or more of four distinct roles** — consumer, capability
   provider, model provider, client — and the runtime cannot tell which product occupies
   them.
4. **Identity terminates at the grant.** Consumer identity systems (tenant, RBAC, roles)
   translate *at the consumer's boundary* into generic grants carrying rights, quantitative
   limits and TTL. The kernel enforces authority and spend; the consumer enforces its own
   domain permissions. Two layers, deliberately.
5. **Kyxo Platform remains the system of record for its business objects; the runtime is
   the system of record for executions.** Neither stores the other's truth, and the runtime
   never receives direct database access.
6. **Kyxo Code and Kyxo Platform pass the same conformance suites as any third-party
   provider.** An exemption request is the signal that the boundary has broken.
7. **Production consumer code lives in separate repositories.** The runtime repository may
   contain integration documentation, generic contracts and minimal examples — never
   product code, not even interfaces.

## Alternatives considered

**A. Runtime as an internal Kyxo Platform subsystem.** Genuinely faster to build: the
Platform's identity, storage and business objects would be available directly, and the
generality tax disappears. Rejected because it invalidates ADR-021's BUILD argument — a
Platform-internal execution engine has no portable record format, no reason for capability
negotiation, and no third-party adoption path. If this alternative is ever chosen, the
correct move is not to adapt this architecture but to stop building a runtime and extend an
incumbent framework instead (the documented EXTEND fallback).

**B. Runtime as a coding-agent framework, with Kyxo Platform as one user.** The coding
domain is where the ecosystem energy is, and a coding-shaped runtime would be more
immediately compelling. Rejected on evidence: the research found coding harnesses to be
deeply model-coupled (weeks of per-model adaptation, ~30% swings from reasoning-trace
handling). Baking coding assumptions into a substrate would inherit that coupling
permanently, and it would make the QA/ALM consumer — the one that exists today — a
second-class citizen of its own company's runtime.

**C. Generic runtime, but with a blessed "Kyxo profile" inside it.** Superficially
attractive: keep the kernel clean, put the Kyxo-shaped conveniences in a first-party
package. Rejected because a blessed profile becomes the de facto API. Third parties would
integrate against it, its assumptions would harden, and the generic layer would ossify
around one company's shape while nominally staying pure. Examples in `examples/` are the
sanctioned version of this idea, precisely because they are not shipped as a dependency.

## Consequences

**Positive.**
- The BUILD argument of ADR-021 survives intact; the runtime's differentiators remain
  genuinely portable.
- Kyxo Code and Kyxo Platform get an unusually strong integration test: if a boundary is
  awkward for them, it would be awkward for every third party, and the fix benefits both.
- Multiple consumers with conflicting needs (QA workflows, coding, research) force the
  contracts to stay honest — the Acme Research test in doc 23 §12.4 is a standing check.
- Governance (amendment A5) becomes coherent: a generic runtime can plausibly be donated to
  a neutral home; a product subsystem cannot.

**Negative (real, and accepted).**
- **The first consumer pays a generality tax.** Kyxo Platform must build an AI Gateway and
  a capability provider it would not need if the runtime simply read its database. This is
  the single largest cost of this decision and it lands on the team with the most immediate
  delivery pressure.
- **Some capability designs will be worse than a bespoke integration** — a generic
  capability contract cannot exploit Platform-specific batching or transactional semantics.
- **Cross-repository coordination is slower** than a monorepo, deliberately.
- **The temptation recurs at every deadline.** This ADR will be re-litigated; the
  mechanized invariants (C1–C13, doc 23 §10) exist so the answer does not depend on whoever
  is reviewing that day.

## Evidence and confidence

- SOURCE-CODE OBSERVATION (HIGH): the current kernel contains no product, provider or IDE
  name; CI enforces no-identity-branching (I1).
- EXECUTABLE (HIGH): eight heterogeneous constructs traverse one invocation path with the
  kernel naming none of them (doc 20 §4).
- FACT (HIGH): the research base's separation of reusable substrates from product-fused
  engines (`research/notes/langgraph.md`, `microsoft-autogen-sk-agent-framework.md`,
  `anthropic-claude-code-agent-sdk.md`, `cursor.md`).
- Confidence **HIGH** that this is the right boundary given the BUILD decision;
  **MEDIUM** that the organization will hold it under delivery pressure — which is why the
  invariants are mechanized rather than merely documented.
