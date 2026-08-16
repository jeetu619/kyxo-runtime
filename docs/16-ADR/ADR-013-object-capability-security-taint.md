# ADR-013: Object-capability security with taint propagation

> **Post-review status (2026-08-16).** This document predates the adversarial review; the review's
> binding adjudications live in the Amendment log of `research/DESIGN-SPINE.md` (A1–A14), with the
> full findings in `research/ADVERSARIAL-REVIEW.md`.
> **Applied here:** none. **Adopted but not yet reflected in this document's body:** A3, A6, A8. Where this document conflicts with the Amendment log, **the amendment log governs**; reconciling this body text is tracked as remaining editorial work.


Status: **Proposed**

Deciders: Kyxo architecture program. Related: 11-SECURITY-AND-POLICY, ADR-014 (budgets ride on Grants), ADR-015 (attenuation-on-delegation), ADR-009 (checkpoint interaction — see the open question).

## Context

The mission's security requirement reduces to one sentence: *the AI cannot grant itself privilege.* The evidence base contains a four-way independent convergence on the mechanism that delivers this, and a set of shipped retrofits showing what its absence costs.

**Evidence — the ocap convergence.** FACT: four unrelated systems — the E language lineage, Cap'n Proto RPC, seL4, and Fuchsia/Zircon — independently converged on the same invariants: capabilities are unforgeable references; possession = authority ("they both designate an object to call and confer permission to call it" — Cap'n Proto); copies are minted with a *subset* of rights, never amplified (seL4); revocation is transitive over derivations (`seL4_CNode_Revoke` deletes a capability and every capability derived from it); "an empty process has no ambient authority" (Zircon); "kernel objects do not have an intrinsic notion of security... security rights are held by each handle" (research/notes/prior-art-negotiation-extension.md §7). INFERENCE/HIGH (from the same note): this convergence — a language, an RPC protocol, a verified microkernel, a production OS — is the strongest signal in the entire prior-art corpus.

**Evidence — interposition is the policy mechanism.** FACT: seL4 interposes on references the holder cannot distinguish from the real thing; the WASM Component Model makes every import virtualizable — "a 'filesystem' import can be a sandbox, a recorder, or a policy filter, and the component cannot tell" (research/notes/prior-art-negotiation-extension.md §§6–7). Plan 9 shows attenuation-by-construction: what a process can touch is exactly what was mounted into its namespace (§13).

**Evidence — what the incumbents do instead, and where it leaks.**
- SOURCE-CODE OBSERVATION/HIGH: Codex's model is a two-axis policy matrix (`AskForApproval` × `SandboxPolicy`) with OS mechanisms beneath — declarative and effective, but names-based: the model emits a tool *name* and policy adjudicates; nothing distinguishes holding authority from knowing a string (research/notes/openai-agents-sdk-codex.md §11).
- OBSERVED BEHAVIOR/HIGH (indirect): Cursor's permission grammar (`Shell(git)`, `Read(src/**)`, `Mcp(datadog:*)`) plus hooks is likewise pattern-matching over names, with hooks as the only interposition point (research/notes/cursor.md §§6–7).
- Claude Code's pipeline ends in *subagent output scanning* — pattern-scanning text after the fact because no structural label says where content came from; the note's own conclusion: "a kernel should carry provenance/taint metadata on every message and artifact rather than pattern-scanning text after the fact" (research/notes/anthropic-claude-code-agent-sdk.md, Implication 6, via spine §3.5).
- FACT: A2A has "no policy language... no machine-readable policy exchange or capability attenuation"; its `AUTH_REQUIRED` chaining is a signaling convention whose semantic payload is undefined (research/notes/a2a-protocol.md F9, F13).
- FACT: FIDES (information-flow control) shipped in MAF as a *security layer bolted above* the framework — the retrofit Kyxo replaces with an invariant (spine §3.5).

**Interpretation.** INFERENCE/HIGH: prompt injection and confused-deputy failures are the same problem — authority reachable by name rather than by held reference. Systems are converging on interposition points (hooks) and permission grammars, but without an unforgeable substrate these remain adjudication over forgeable names. The model layer cannot be made trustworthy (persuasion is not enforcement); therefore authority must be structural.

## Decision

1. **Grants are the only authority.** A Grant (spine §3.7) is a kernel-issued, unforgeable, attenuable, revocable reference carrying rights (what) and quantitative budget (how much — ADR-014). No ambient authority: a Cell's reachable world is exactly its granted capability set, Plan-9-namespace style. A model emitting the name of a capability is inert unless the invoking harness's cell holds a matching Grant through a Binding.

2. **Attenuation-on-delegation is mandatory and kernel-checked** (child ≤ parent in rights, budget, depth, risk class — ADR-015). Revocation is transitive over the grant lineage tree: revoking an agent's grant kills everything it delegated.

3. **Interposition is invisible to the holder.** Policy wraps capabilities (virtualized imports at the WASM boundary, proxy bindings in-process); a holder cannot distinguish a filtered capability from a raw one. Vendor hook idioms (Cursor/Claude Code stdin-JSON hooks) become thin adapters over kernel policy events.

4. **Structural taint propagation.** Artifacts and compiled context carry integrity/confidentiality/taint labels set at origin (which capability produced this, under what trust class) and propagated by the kernel through derivation: an Artifact produced by an invocation whose inputs were tainted is tainted unless a policy-sanctioned declassifier (a verifier capability + commit-gate evidence, ADR-012) clears it. Labels survive into the context compile (spine §5), so "web content reached the prompt" is a queryable fact, not a forensic reconstruction.

5. **The policy pipeline is ordered, declarative, and evaluated at bind time and at every effectful invocation**, with deny-class stages non-bypassable by any configuration (the Claude Code six-step pipeline is the proven shape — spine §3, mechanisms). Approval routing, allowlists, and taint rules are stages; the ocap substrate is what the stages adjudicate *over*.

## Alternatives considered

**A. ACL/RBAC-only.** Rejected as the substrate (retained as an *expression layer* for enterprise admin above grants). RBAC requires central policy evaluation on every request and cannot express delegation cheaply: a subagent tree three levels deep needs either role explosion or shared roles (no attenuation). INFERENCE/MEDIUM from the prior-art note: ocap scales better for delegation-heavy workloads (research/notes/prior-art-negotiation-extension.md, vocabulary — K8s RBAC named as the ACL counterexample). The delegation algebra the coding-agent landscape converged on (session + policy diff — spine §1) is attenuation in all but name; RBAC would re-centralize what the ecosystem already decentralized.

**B. Policy-engine-only (OPA-style external adjudication, no ocap substrate).** Rejected. An external engine evaluating "may principal P call tool T with args A" leaves authority ambient between decisions: the names are forgeable, the engine is bypassable by any code path that doesn't consult it, and revocation is a policy-data update racing live executions. This is the Codex/Cursor position generalized — production-credible for a single vendor's closed loop, structurally insufficient for a kernel whose plugins are third-party code. Policy engines remain valuable *as pipeline stages*; they cannot be the floor.

**C. Prompt-level defense only (instructions, output scanning, guardrail models).** Rejected as a security boundary. This is context-persuasion, and the evidence base's own retrofits (subagent output scanning, guardrail tripwires at fixed positions) exist because persuasion fails open. Guard models are useful in-loop observers (ADR-012 altitude 1); they are not enforcement.

## Consequences

**Positive.**
- "The AI cannot grant itself privilege" holds by construction, not by review: fabricated tool names, injected instructions, and confused deputies all bottom out in "no grant, no invocation."
- Policy interposition and testing come free at the isolation boundary (virtualized imports — ADR-010).
- Taint labels replace after-the-fact scanning with queryable provenance, closing the cross-boundary provenance gap (spine §6.4).
- Transitive revocation gives an incident-response verb no studied agent system has: kill a subtree's authority instantly, including its delegations.

**Negative (real costs).**
- **Label creep is real.** Naive propagation converges on "everything is tainted" (any run that ever touched the web taints its whole derivation cone). Declassification reintroduces judgment — a policy decision about when taint is cleansed — and a bad declassifier is a laundering machine. This is the known IFC usability problem; FIDES productizes it as middleware precisely because invariant-grade IFC is hard. We accept a coarse label vocabulary in V1 and expect iteration.
- **DX friction.** Ocap discipline is unfamiliar; developers will reach for ambient patterns (global fetch, env credentials) and find them absent. Profiles and default grants mitigate; they do not eliminate the learning curve.
- **Interposition overhead** on every effectful invocation (policy stages + label propagation) sits on the hot path; the crossing-cost budget of ADR-010 must include it.
- **The ocap-vs-checkpoint-resurrection question is open and honestly unresolved.** Transitive revocation conflicts with resumable Checkpoints that embed grant references: if a checkpoint holds live refs, revocation breaks resumption (resurrection-fragile); if it holds petnames re-resolved under current policy at resume, resumed executions may hold *different* authority than they were cut with — safer, but weaker than pure ocap and a source of subtle resume-behavior changes (research/notes/prior-art-negotiation-extension.md, open question 3). The spine does not settle this; V1 leans petname-re-resolution (policy-current authority at resume) as the conservative default, and the adversarial review should attack it.

## Evidence & confidence

| Claim | Label | Confidence | Source |
|---|---|---|---|
| Four-system ocap convergence (unforgeable, attenuate, transitive revoke, no ambient authority) | FACT | — | research/notes/prior-art-negotiation-extension.md §7 |
| Interposition/virtualizable imports as policy mechanism | FACT | — | research/notes/prior-art-negotiation-extension.md §§6–7, 13 |
| Codex two-axis policy matrix; names-based adjudication | SOURCE-CODE OBSERVATION | HIGH | research/notes/openai-agents-sdk-codex.md §11 |
| Cursor permission grammar + hooks as sole interposition | OBSERVED BEHAVIOR (indirect) | HIGH | research/notes/cursor.md §§6–7 |
| A2A: no attenuation, no policy language; AUTH_REQUIRED payload undefined | FACT | — | research/notes/a2a-protocol.md F9, F13 |
| Output scanning / FIDES as retrofits of missing structural labels | FACT / spine-carried | HIGH | spine §3.5; research/notes/anthropic-claude-code-agent-sdk.md Implication 6 |
| Ocap scales better than RBAC for delegation-heavy workloads | INFERENCE | MEDIUM | research/notes/prior-art-negotiation-extension.md |

Decision confidence: **HIGH** on ocap substrate + interposition + non-bypassable deny stages; **MEDIUM** on taint-label granularity and declassification design (limited production precedent — FIDES is the only shipped analog); **LOW-MEDIUM** on the checkpoint-resurrection resolution (explicitly open).
