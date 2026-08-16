# ADR-011: Objective is a registered Kind over a root invocation, not a kernel primitive

Status: **Proposed**

Deciders: Kyxo architecture program. Related: 05-KERNEL-PRIMITIVES, 09-CONTEXT-AND-MEMORY, ADR-012 (success criteria bind to the commit gate), ADR-014 (budget requests), ADR-015 (hierarchical objectives = invocation tree).

## Context

Every studied system starts an agent run from either a raw prompt or an untyped task description; none has a first-class, schema'd representation of *what success means*. The kernel needs to decide whether "Objective" is a tenth kernel object or userland data.

**Evidence — the state of the art is a prompt or a todo list.** SOURCE-CODE OBSERVATION/HIGH: OpenAI's `Agent` is a configuration dataclass whose closest thing to an objective is `instructions` (a system prompt, possibly a callable); termination is inferred from "no pending tool calls," not from satisfying stated criteria (research/notes/openai-agents-sdk-codex.md §1). FACT: Codex ships a `plan_tool` that is a todo list — a UI affordance, not a contract (§11). FACT: A2A tasks carry a natural-language Message and produce Artifacts, but "nothing represents acceptance criteria, evaluation, or client accept/reject of artifacts" — judgment of an acceptable result is explicitly assigned to the client, out of protocol (research/notes/a2a-protocol.md F13). OBSERVED BEHAVIOR/HIGH (indirect retrieval): Cursor's Plan Mode emits an *editable plan artifact with to-dos* — the plan is data the human amends before execution, produced by the same agent, not by a planner component (research/notes/cursor.md §3).

**Evidence — the admission test.** FACT (quoted from Liedtke, SOSP'95): "a concept is tolerated inside the µ-kernel only if moving it outside the kernel, i.e., permitting competing implementations, would prevent implementation of the system's required functionality" (research/notes/prior-art-negotiation-extension.md §9). Competing userland definitions of objective semantics — different intent schemas, different success-criteria languages, different decomposition ideologies — are obviously permittable; nothing about security, accounting, recovery, or coordination requires the kernel to understand "intent."

**Evidence — the mechanism for userland types.** FACT: Kubernetes CRDs are the most successful userland-types mechanism in production software: the API server supplies storage, schema validation, multi-version serving with one storage version + conversion, watch streams, and policy generically, while semantics live entirely in userland controllers (research/notes/prior-art-negotiation-extension.md §10). The spine adopts this as the Kind object (spine §3.9), naming Objective as its first citizen.

**Evidence — prompts are renderings, not contracts.** FACT: for open models the message-list→token interface is a model-shipped chat template, divergent per family, in at least two incompatible template languages; the "model" is weights + tokenizer + template + parsers (research/notes/open-model-infrastructure.md §2). INFERENCE/HIGH: a prompt is therefore a *per-model rendering artifact*, several layers below intent; making it the root object welds the run's identity to one model paradigm.

**Interpretation.** The absence of a schema'd objective across all systems is not evidence that nobody needs one — verification (ADR-012) and budgets (ADR-014) both dangle without a stated success contract and a stated resource request. It is evidence that the *kernel* never needed to understand it: every system runs fine with objective-as-convention because nothing downstream consumes it mechanically. Kyxo makes objectives mechanically consumable (by verifiers and the commit gate) precisely by making them typed data — which is a Kind, not a primitive.

## Decision

1. **Objective is a registered Kind** (spine §3.9): a schema-validated userland artifact with, at minimum:
   - `intent` — structured statement of what is to be achieved; may *reference* prompt artifacts (per-model renderings live in the context-management system's compile, not in the objective);
   - `successCriteria` — typed references to verifier capabilities and required Evidence artifact classes (the hook ADR-012's commit-gate stages consume);
   - `constraints` — declarative bounds (allowed capability classes, risk classes, data-handling requirements) that the policy pipeline can read;
   - `budgetRequest` — the quantitative ask that, if approved, becomes an attenuated Grant (ADR-014).

2. **Executing an objective = creating a root invocation.** `runtime.run({ objective })` (spine §9) resolves a profile, binds a harness capability, mints a Grant from the budget request, and creates the root Invocation of a Cell. The kernel sees an ordinary invocation carrying a grant; the Objective artifact is referenced from the invocation's correlation metadata, not interpreted by the kernel.

3. **Hierarchical objectives are the invocation tree with grant lineage.** A harness decomposing an objective creates child Objective artifacts and child invocations under attenuated grants (ADR-015). Decomposition ideology (plan-execute, reactive, graph strategy) is entirely the harness's business; the kernel guarantees only lineage (causation IDs) and budget containment.

4. **Kernel supplies to the Objective Kind exactly what it supplies every Kind:** storage, schema validation, multi-version serving with conversion, watch streams. Objective *semantics* — progress evaluation, re-planning, decomposition — live in userland controllers and harnesses.

## Alternatives considered

**A. Objective as a kernel object (a tenth primitive).** Rejected on the admission test. A kernel-frozen objective schema would encode one planning ideology (whose fields? whose success-criteria language? goal-state vs task-list vs utility function?) at the layer that must outlive all of them. The evidence shows objective representations are the *most* volatile layer in the stack — Cursor's plan artifacts, Codex's todo lists, and Roo-style checklist delegation are three shapes in one product generation. The CRD move exists exactly so new concepts arrive without kernel changes; using it for our own flagship concept is the credibility test of the mechanism. (If Kind machinery cannot carry Objective, it cannot carry anything.)

**B. Prompt-as-root: the run's root object is the initial prompt/message list.** Rejected. This is the status quo everywhere, and its costs are documented: success is inferred by termination heuristics (no-pending-tools — research/notes/openai-agents-sdk-codex.md §1) because there is nothing stated to verify against; budgets cannot be requested because nothing carries a resource ask; and the root object is model-paradigm-specific (chat-shaped), which forces non-chat task types (embed, rerank, apply — research/notes/open-model-infrastructure.md §9) and Realtime-session paradigms through a chat impersonation. Prompts remain first-class *artifacts* referenced by intent and compiled per-binding by the context-management system.

**C. Objective as pure convention (documentation, no schema).** Rejected. Without a registered schema there is nothing for commit-gate policy stages to bind success criteria to, nothing for the policy pipeline to read constraints from, and no watch stream for controllers — verification and budgets would regress to convention with it. This is the A2A position (acceptance is the client's out-of-band problem), and F13 lists it among the absences a kernel exists to close.

## Consequences

**Positive.**
- Verification gets a target: commit-gate stages can require the Evidence classes the objective's success criteria name (ADR-012), replacing agent-says-done.
- Budgets get a request/grant boundary: the objective asks, policy decides, the Grant enforces (ADR-014).
- Objective schemas evolve by Kind versioning (storage version + conversion), not kernel releases; competing schemas can coexist under different Kind names.
- The benchmark surface (spine §9) can express "same objective × different harness × different model" because the objective is model- and harness-neutral data.

**Negative (real costs).**
- **Indirection tax on the trivial case.** "Fix this bug" now traverses Objective artifact → profile → binding → grant → root invocation. The default profile hides this, but debugging the simple case means reading five objects where a prompt-in/loop-out system has one. C4 (spine §1) applies with force here.
- **Schema fragmentation risk.** Anyone can register an Objective-like Kind; without a maintained baseline profile schema, the ecosystem fragments into per-vendor objective dialects — the Wayland extension-matrix failure mode (research/notes/prior-art-negotiation-extension.md §5). Owning a versioned baseline Objective schema is a permanent editorial commitment, not a one-time design.
- **The kernel cannot promise objective completion.** It guarantees invocation lifecycle, budget containment, and evidence-gated commit — not that the stated intent was achieved. Marketing and docs must be disciplined about this line, or the kernel inherits blame for userland judgment failures.
- **Success-criteria authorship is hard and unsolved.** Users write vague criteria; verifiers verify what is verifiable, not what was meant. Schema'd objectives make this gap visible rather than closing it.

## Evidence & confidence

| Claim | Label | Confidence | Source |
|---|---|---|---|
| No studied system has schema'd success criteria at the run root | FACT (by absence, cross-corpus) | HIGH | research/notes/a2a-protocol.md F13; research/notes/openai-agents-sdk-codex.md §§1, 11; research/notes/cursor.md §3 |
| Termination inferred from no-pending-tools, not stated criteria | SOURCE-CODE OBSERVATION | HIGH | research/notes/openai-agents-sdk-codex.md §1 |
| Liedtke admission test wording | FACT | — | research/notes/prior-art-negotiation-extension.md §9 |
| CRDs: kernel machinery + userland semantics, multi-version serving | FACT | — | research/notes/prior-art-negotiation-extension.md §10 |
| Prompts are model-specific renderings (chat templates, two template languages) | FACT + INFERENCE | HIGH | research/notes/open-model-infrastructure.md §2 |

Decision confidence: **HIGH** that Objective must not be a kernel primitive (admission test + volatility evidence); **MEDIUM** on the specific four-field schema shape (intent/successCriteria/constraints/budgetRequest is our synthesis with no direct production precedent; the baseline schema will need revision under real use).
