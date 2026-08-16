# ADR-015: Delegation is capability invocation under attenuated grants with lineage

> **Post-review status (2026-08-16).** This document predates the adversarial review; the review's
> binding adjudications live in the Amendment log of `research/DESIGN-SPINE.md` (A1–A14), with the
> full findings in `research/ADVERSARIAL-REVIEW.md`.
> **Applied here:** none. **Adopted but not yet reflected in this document's body:** A2 (wording), A8. Where this document conflicts with the Amendment log, **the amendment log governs**; reconciling this body text is tracked as remaining editorial work.


Status: **Proposed**

Deciders: Kyxo architecture program. Related: 04-ORCHESTRATION-MODELS, 10-HARNESS-AND-GRAPH-RUNTIME, ADR-013 (grant substrate), ADR-014 (depth/width/budget units), ADR-012 (result verification), ADR-016 (delegation across the federation edge).

## Context

**Evidence — the ecosystem already converged on a delegation algebra, without a delegation subsystem.**

- INFERENCE/HIGH (from five independent implementations): across the competitive coding-agent landscape, a "subagent" is exactly *a fresh session + a capability/policy diff + a prompt, returning a single result message to a paused or notified parent* — with optional background mode, resume-by-id, and separately tracked budgets rolled into parent totals. "No system needed a graph engine to express this" (research/notes/coding-agents-landscape.md §6, via spine §1).
- SOURCE-CODE OBSERVATION/HIGH — the strongest single dissection: OpenAI handoffs are *literally function tools plus a runner-side interception rule*. `Handoff` serializes as a plain function tool (`transfer_to_<agent>`), indistinguishable on the wire; the runner intercepts the call, applies an input filter, and swaps the active configuration. The same SDK ships two more delegation mechanisms — `agent.as_tool()` (nested run) and Codex subagent profiles (own threads) — none of which compose with the others (research/notes/openai-agents-sdk-codex.md §2, Implication 1: "Delegation needs no primitive — interception does").
- OBSERVED BEHAVIOR/HIGH (indirect): Cursor models delegation as *addressable, resumable child sessions* — named subagents with own context/prompt/tools/model, async, recursive, resumable by agent ID, transcripts persisted (research/notes/cursor.md §7).
- FACT: A2A delegation is `SendMessage` to an opaque peer returning a Task handle; recursive delegation composes by chaining, but "no delegation metadata (depth, originator, purpose) is standardized," and `AUTH_REQUIRED` chains propagate approval needs up the delegation chain as pure signaling (research/notes/a2a-protocol.md, vocabulary + F9).
- FACT: the durable-execution engines have only *structural* delegation (child workflows, durable RPC) — "none are semantic (no capability handoff)" (research/notes/durable-execution.md, vocabulary).

**Evidence — the missing halves.** The convergent algebra has two systematic gaps: **authority** (the policy diff is ad hoc — Claude Code scans subagent output because nothing structural bounds what a child returns; OpenAI's `input_filter` is a history transform, not an authority transform) and **accounting** (child budgets leak or require manual threading — ADR-014's evidence). A2A adds the third gap at the federation edge: no depth/loop protection (F13).

**Evidence — what delegation is in mature capability systems.** FACT: in seL4/Zircon/Cap'n Proto, delegation is uniformly *handing a narrower reference* — "never editing a policy database" (research/notes/prior-art-negotiation-extension.md, vocabulary). Plan 9 expresses it as re-mounting a subset of one's namespace into the child (§13).

**Interpretation.** INFERENCE/HIGH: the ecosystem has empirically discovered the *shape* of delegation (session + diff + result) but implements the diff as convention. The capability-theoretic reading is exact: a subagent is an invocation of an orchestrator capability under an attenuated grant. Making that identification literal gives every convergent feature for free and supplies the three missing halves (authority, accounting, recursion control) from machinery that already exists in the design.

## Decision

1. **There is no delegation subsystem.** Delegation is the invocation of a capability that is itself an orchestrator — a harness, a graph strategy, a remote runtime behind A2A, a human — under an **attenuated Grant** (child ≤ parent on every right and every quantitative unit, ADR-013/014). The word "subagent" never appears in kernel code; it is a userland configuration: harness capability + grant diff + cell.

2. **Recursion control is grant arithmetic, not a feature.** Spawn depth and width are budget units (ADR-014); a delegation chain exhausts depth by construction, and cycles cannot amplify authority because every hop attenuates. There is no global spawn cap to configure and no loop detector to tune — the lineage tree is the control.

3. **Lineage is the causation chain in the journal.** Every invocation carries correlation and causation IDs and a grant reference (spine §3.3); the delegation tree is a projection over Events, queryable without any bookkeeping by harness authors. Cline-style per-child cost rollup and OpenCode-style resume-by-id fall out of cell identity + journal projection.

4. **Result-verification uses the commit gate.** A delegated invocation's outcome enters the parent's truth plane through the same commit-gate machinery as any outcome (ADR-012); policy may require Evidence on delegated results specifically (e.g., taint-screening of child output — replacing Claude Code's text scanning with a structural gate). The child's result Artifacts carry provenance labels naming the child's grant, so the parent's policy can discriminate by origin.

5. **All observed delegation styles are expressible as configurations:**

| Observed mechanism | Kyxo expression |
|---|---|
| OpenAI handoff (swap active config) | parent cell rebinds its harness Binding; interception is a policy stage |
| `agent.as_tool()` (nested run) | synchronous invocation of a harness capability, result as tool output |
| Coding-agent subagent (session + diff) | new cell + harness invocation under attenuated grant |
| Background subagent + resume | async invocation lifecycle + cell activation-on-demand |
| A2A remote delegation | invocation of a remote-runtime capability at the federation edge (ADR-016) |
| Architect→editor model split (Aider) | two model-adapter bindings inside one harness — no delegation at all |

## Alternatives considered

**A. A dedicated subagent primitive** (kernel-level spawn-agent object with its own lifecycle and API). Rejected. OpenAI is the cautionary tale: three delegation mechanisms (handoffs, agents-as-tools, Codex subagents) that cannot compose, because each froze one delegation style into a type. Five CLI systems built subagents as configuration over sessions + permissions with no primitive at all, and Gemini CLI mounted *remote A2A agents* through the same subagent-as-tool surface — evidence that the general mechanism (invocation + policy diff) subsumes every specialization. A primitive would also fail Liedtke's test: competing userland delegation styles demonstrably exist and thrive.

**B. Unrestricted spawn with global caps only** (max concurrent agents, global depth limit — the current Claude Code env-var shape). Rejected. Global caps are not attributable (which subtree is runaway?), not delegable (a parent cannot give a child *less*), and not enforceable across boundaries (the PydanticAI leak generalizes: any accounting not attached to the delegated authority is lost at the first boundary). A2A's F13 shows the same absence at the federation layer, where it becomes unfixable after the fact.

**C. Delegation as a protocol concern only** (adopt A2A semantics internally). Rejected. A2A deliberately standardizes the *envelope* between mutually opaque parties and therefore cannot carry attenuation ("no capability attenuation" — F9) or lineage. Internally we own both sides and can enforce what A2A cannot; externally we project onto A2A (ADR-016). Adopting the weaker contract internally would forfeit exactly the guarantees (containment, attribution) that are the kernel's differentiation (spine §6.6).

## Consequences

**Positive.**
- Subagents, handoffs, boomerang orchestration, retrieval agents, and swarm patterns are configurations, not features — zero kernel surface per style, matching the empirically observed algebra.
- Delegation inherits security (attenuation, revocation), accounting (lineage rollup), recovery (child invocations are journaled like any others), and verification (commit gate) with no delegation-specific code paths to secure or debug.
- Transitive revocation over the grant tree gives "kill this delegation subtree now" as a kernel verb.
- The same contract spans local and remote: a remote runtime is just an orchestrator capability with a different Binding, keeping one mental model from in-process subagent to A2A federation.

**Negative (real costs).**
- **Grant literacy becomes a prerequisite for safe delegation.** Users who today write `spawn_subagent("researcher")` must now understand (or accept defaults for) attenuation diffs. Profiles carry the burden; the failure mode is users granting `parent == child` reflexively, which preserves safety arithmetic but nullifies least-authority in practice.
- **Attenuation stops at the federation edge.** A grant cannot bind an opaque A2A peer; only envelope constraints (budget hints, deadlines, declared requirements) cross, and enforcement degrades to trust + telemetry (ADR-016). The kernel's delegation guarantees are honest only if documentation is explicit that they are *domain-local*.
- **No kernel-level delegation UX affordances.** Because there is no subagent object, product surfaces must build their rosters/trees as journal projections; the kernel offers queries, not widgets. This is deliberate but shifts real work to SDK/product layers.
- **Interception-style handoffs (config swap mid-cell) sit awkwardly** in a model where authority attaches to bindings: swapping a harness binding mid-conversation must re-run bind-time policy, which is correct but makes the OpenAI-style "cheap handoff" less cheap. We accept the cost; silent authority carryover across a config swap is precisely the bug class ocap exists to kill.

## Evidence & confidence

| Claim | Label | Confidence | Source |
|---|---|---|---|
| Five-system convergence: subagent = session + policy diff + single result | INFERENCE (from SOURCE-CODE OBSERVATION across 5 systems) | HIGH | research/notes/coding-agents-landscape.md §6 (via spine §1) |
| Handoffs are function tools + interception (wire-indistinguishable) | SOURCE-CODE OBSERVATION | HIGH | research/notes/openai-agents-sdk-codex.md §2 |
| OpenAI's three delegation mechanisms don't compose | INFERENCE | HIGH | research/notes/openai-agents-sdk-codex.md Implication 1 |
| Cursor: addressable, resumable, recursive child sessions | OBSERVED BEHAVIOR (indirect) | HIGH | research/notes/cursor.md §7 |
| A2A: no delegation metadata, no attenuation, no depth protection | FACT (by absence) | HIGH | research/notes/a2a-protocol.md F9, F13, vocabulary |
| Mature capability systems: delegation = handing a narrower reference | FACT | — | research/notes/prior-art-negotiation-extension.md §7, §13, vocabulary |

Decision confidence: **HIGH**. This is the best-evidenced decision in the 009–016 set: the mechanism is a direct formalization of an independently convergent production pattern, with the additions (attenuation, lineage, gate) each closing a documented gap rather than speculating.
