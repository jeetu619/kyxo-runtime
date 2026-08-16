# ADR-005: Harness Is a Behaviour Contract and a Capability

> **Post-review status (2026-08-16).** This document predates the adversarial review; the review's
> binding adjudications live in the Amendment log of `research/DESIGN-SPINE.md` (A1–A14), with the
> full findings in `research/ADVERSARIAL-REVIEW.md`.
> **Applied here:** A2. **Adopted but not yet reflected in this document's body:** A9(ii). Where this document conflicts with the Amendment log, **the amendment log governs**; reconciling this body text is tracked as remaining editorial work.


- **Status:** Proposed (pre-adversarial-review)
- **Date:** 2026-08-16
- **Spine anchor:** `research/DESIGN-SPINE.md` §1 (C2), §2 (vocabulary: *Harness*, *Agent loop*, *Agent SDK*), §5 (strategies as behaviours), §9 (DX contract)
- **Related:** 10-HARNESS-AND-GRAPH-RUNTIME, 03-HARNESS-COMPARISON, 05-KERNEL-PRIMITIVES

## Context

A harness is the orchestration strategy that turns a model into a competent worker: context compilation, tool exposure, loop policy, termination policy, recovery. The question is where the harness sits relative to the kernel: inside it (the kernel *is* a loop), outside it entirely (opaque black boxes the kernel merely supervises), or split along a contract line. Three forces dominate.

**Force 1 — the loop is thin and convergent; the policies inside it are where systems actually differ.** SOURCE-CODE OBSERVATION (HIGH) across the coding-agent landscape: six systems run the same canonical native-tool-call loop, and their genuine differences are continuation/termination policies — Gemini CLI's LLM side-channel next-speaker check plus per-chunk loop detection; Copilot agent mode's autopilot caps (`MAX_AUTOPILOT_ITERATIONS = 5`); Roo Code's consecutive-mistake budget; Cline's termination anchored to an explicit `submit_and_exit` tool call. Aider is not a tool-call loop at all (a rewrite pipeline with a bounded reflection valve), and Copilot's cloud agent is an artifact-mediated remote pipeline (research/notes/coding-agents-landscape.md). The generic mechanics are shared; the behavioural policy is the product. MAF confirms the same split from the framework side: its `AgentLoopMiddleware` terminates on pluggable predicates — `todos_remaining`, `background_tasks_running`, or an LLM judge returning a structured verdict (SOURCE-CODE OBSERVATION/HIGH, research/notes/microsoft-autogen-sk-agent-framework.md).

**Force 2 — harness quality IS model coupling (spine C2), so the harness cannot be universal — but it also must not be invisible.** The C2 evidence: Cursor spends weeks adapting its harness per model, renamed tools to match one model's RL training distribution, lost ~30% performance when dropping reasoning traces, and trained Composer inside the production harness (FACT/HIGH, research/DESIGN-SPINE.md §1 C2, citing research/notes/cursor.md). FACT: Claude Code's system prompt carries a model-conditional line suppressing Agent-tool use on Opus 5 because "Claude Opus 5 delegates to subagents more readily than earlier models" — the harness patches model-version behavioural drift in its prompt; termination judgment itself lives in the model, with the harness merely detecting the absence of tool calls (research/notes/anthropic-claude-code-agent-sdk.md). Therefore harness×model pairing is a first-class engineering artifact, and the runtime's job is to make pairs *swappable, versioned, and benchmarkable* rather than to pretend one harness fits all models.

**Force 3 — the largest vendor proved harness = composition over an unchanged substrate.** SOURCE-CODE OBSERVATION (HIGH): Microsoft's `create_harness_agent()` assembles a Claude-Code-class harness *entirely* from middleware (loop, tool approval with invocation budgets) and context providers (todo, mode, file memory, skills, background subagents) around an unchanged agent loop; no new kernel-level concept was needed, and the harness GA'd as a promoted product surface (research/notes/microsoft-autogen-sk-agent-framework.md). INFERENCE (HIGH): a kernel needs good interception slots and an injection pipeline with provenance — not harness primitives.

**Force 4 — the opaque-harness pattern exists and matters, but it forfeits guarantees.** SOURCE-CODE OBSERVATION (HIGH): the Claude Agent SDK is a thin supervisor over a closed harness binary — `query()` spawns the bundled `claude` CLI and speaks NDJSON over stdio; the loop, compaction, and permission pipeline live inside the binary (research/notes/anthropic-claude-code-agent-sdk.md). This is a real deployment shape Kyxo must host (vendor harnesses will not rewrite themselves as callbacks). But inside the black box, Kyxo's budget charging, checkpoint cuts, policy interposition, and journal typing do not reach — only the box's own message stream does.

**Force 5 — LangChain's own taxonomy separates the layers.** FACT: LangChain's published taxonomy distinguishes agent *runtimes* (LangGraph, Temporal), *frameworks* (LangChain, OpenAI Agents SDK, ADK), and *harnesses* (Deep Agents, Claude Agent SDK, Manus) — the harness is an industry-recognized layer above the runtime, packaged and swappable (research/notes/langgraph.md, products.mdx).

## Decision

**A harness in Kyxo SHALL be (a) a behaviour contract implemented against kernel-owned loop mechanics, and (b) a capability — invocable, versioned, manifest-bearing, benchmarkable. Harness×model pairs SHALL be versioned, benchmarkable artifacts.**

1. **The OTP split.** The kernel/stdlib owns the generic loop mechanics every observed harness shares: event intake, checkpoint cuts at yield-is-commit points, budget charging at commit, cancellation propagation, typed suspension (input-required / approval-required / budget-exceeded), and journal writing. The harness supplies **callbacks**: context-compilation policy (what the context-management system assembles per invocation), tool-exposure policy (which bindings the model sees, under which dialects), continuation/termination policy (next-speaker checks, mistake budgets, judge verdicts, completion-tool contracts — all observed variants expressible, none hard-coded), and recovery policy. This is the gen_server discipline: the behaviour cannot skip the substrate's guarantees because the substrate calls *it*, never the reverse.
2. **Harness as capability.** A harness ships with an axis-typed manifest (per ADR-003) declaring: required model-adapter axes (e.g., needs reasoning-replay tier ≥ opaque-carry-through), tool-dialect requirements, context-budget envelope, and termination-policy class. It is discovered, negotiated, bound, invoked, and telemetered like any other capability. `runtime.run({ objective })` binds the default reactive harness through exactly this path (spine §9).
3. **Harness×model pairs are the benchmarkable unit.** Because harness and model adapter are both capabilities with manifests, a pair is an addressable, versionable configuration; the benchmark harness expresses `model × harness` matrices natively, and outcome telemetry accrues per pair — the empirical substrate the C2 world requires (Aider's per-model edit formats and Copilot's per-model learned tool preferences are pair-level facts, not harness-level facts — research/notes/coding-agents-landscape.md).
4. **Opaque harnesses are a supported capability class, with explicitly degraded guarantees.** A closed harness binary (Claude Agent SDK shape) binds as a capability whose manifest declares `enforcement: advisory` for the guarantees Kyxo cannot see inside it; its cell journals the supervisor-visible message stream, budgets enforce at its invocation boundary only, and its manifest MUST declare this guarantee class so policy can distinguish contract-native from opaque harnesses.

## Alternatives considered

**A. Harness-as-kernel-loop.** Hard-code the canonical tool-call loop into the kernel: the kernel calls the model, executes tools, repeats. Rejected: it fails the minimality test and the evidence. The loop's *shape* is not universal — Aider's rewrite pipeline, Copilot cloud's artifact-mediated pipeline, and bidirectional Realtime/Live sessions (which "cannot be lowered onto function calls" — FACT/HIGH, research/DESIGN-SPINE.md §4) all break it — and the loop's *policies* are precisely where eight systems differ and compete (Force 1). A kernel loop would also hard-couple the kernel to model-interaction assumptions the model-adapter layer exists to absorb (ADR-006), and would make harness×model pairing a kernel-patch exercise instead of a capability swap. ADK's own trajectory — the flow pipeline is per-flow-class hard-coded and extensible only by subclassing — shows the cost even one level up (research/notes/google-adk.md).

**B. Harness-as-opaque-black-box-only.** Define no behaviour contract; every harness is an external process supervised over a message protocol (the Claude Agent SDK generalized). Rejected as the *only* model: inside the box, the kernel's differentiating guarantees — budget settlement at commit, checkpoint cuts, deny-class policy interposition, typed journal, provenance labels — are unenforceable; Kyxo would be reduced to a process supervisor around competing proprietary runtimes, owning none of §6's gap map. The Claude Agent SDK's own gaps illustrate what opacity costs: budgets retrofitted late and enforced via mixed mechanisms, best-effort session mirroring, no external-effect journal (FACT/INFERENCE-MEDIUM, research/notes/anthropic-claude-code-agent-sdk.md). Opacity is kept as a *supported class* (Decision 4) because the ecosystem ships closed harnesses — but the contract-native path is the architecture.

**C. Universal harness.** Ship one Kyxo harness tuned to work acceptably on all models. Rejected by C2 directly: per-model harness adaptation is weeks of work per model with double-digit performance swings at stake (research/DESIGN-SPINE.md §1 C2); a universal harness is either mediocre everywhere or secretly N harnesses behind one name. Kyxo promises a universal *substrate* beneath swappable pairs — model-independence lives in the kernel and the record format; model-specificity lives in adapters and harnesses, first-class and unashamed.

## Consequences

**Positive:**

- Every kernel guarantee applies to every contract-native harness automatically: budgets charge at commit, checkpoints cut at yields, policy interposes on every effectful invocation, journals stay typed. Harness authors write policy, not plumbing — the MAF composition result reproduced with kernel-grade enforcement underneath.
- The continuation-policy menagerie (next-speaker, autopilot caps, mistake budgets, judges, completion tools) becomes a library of reusable termination policies rather than eight private reimplementations.
- Harness×model benchmarking is native: pairs are addressable artifacts, telemetry accrues per pair, and regressions from a model version bump (the Opus-5-delegation-drift class of problem) are detectable as pair-level telemetry shifts rather than anecdotes.
- Vendor harnesses interoperate today (opaque class) with a declared, honest guarantee gap — no pretense, and an upgrade path to contract-native.

**Negative (real costs):**

- **The callback surface is a hard API to get right, and a breaking-change treadmill if wrong.** The behaviour contract must anticipate context compilation, tool exposure, termination, recovery, *and* future policy classes; every gap discovered post-V1 either breaks harness implementations or accretes optional callbacks. The Codex precedent — per-release protocol drift as the documented failure mode (research/DESIGN-SPINE.md §8) — is the named risk; versioning the contract as a real spec from day one is the mitigation, and it is expensive.
- **Two-class world.** Contract-native and opaque harnesses have visibly different guarantee levels; users must understand which they are running, and policy authors must write for both. Marketing pressure to blur the distinction will be constant.
- **Inversion-of-control is unfamiliar.** OTP-style "the substrate calls you" is second nature to Erlang engineers and alien to most Python/TypeScript agent developers, whose mental model is "I own the loop." The DX burden lands on the SDK to make behaviours feel like plain code (spine §9 profiles are the mitigation, C4 is the risk).
- **Benchmark matrices cost real money.** N harnesses × M models × the eval suite is a combinatorial spend; pair-level telemetry only accumulates where users actually run pairs, so cold-start selection data will be thin and the runtime's routing promises must degrade honestly.
- **The kernel/stdlib line inside "loop mechanics" will be contested.** E.g., is parallel tool dispatch (annotation-driven in Claude Code, asyncio-gather in ADK) mechanics or policy? Each boundary call made wrong either bloats the kernel or forces boilerplate into every harness. This ADR fixes the principle; doc 10 must fix the line item by item.

## Evidence & confidence

```
Evidence      — Continuation/termination policies as the locus of divergence across eight systems
                (SOURCE-CODE OBSERVATION/HIGH, research/notes/coding-agents-landscape.md); MAF
                harness as pure composition, judge/predicate termination middleware, GA'd
                (SOURCE-CODE OBSERVATION/HIGH + OBSERVED BEHAVIOR/MEDIUM, research/notes/
                microsoft-autogen-sk-agent-framework.md); Claude Code as named "agentic harness",
                model-conditional prompt patches, closed-binary supervisor shape, budget/durability
                gaps (FACT + SOURCE-CODE OBSERVATION/HIGH, research/notes/anthropic-claude-code-
                agent-sdk.md); C2 model-coupling evidence (FACT/HIGH, research/DESIGN-SPINE.md §1,
                citing research/notes/cursor.md); LangChain runtime/framework/harness taxonomy
                (FACT, research/notes/langgraph.md); session-shaped invocations that cannot lower
                onto function calls (FACT/HIGH, research/DESIGN-SPINE.md §4, citing research/notes/
                open-model-infrastructure.md).
Interpretation— The generic loop mechanics are convergent and belong below the line; behavioural
                policy is divergent, model-coupled, and belongs above it as swappable, versioned
                artifacts. The industry already recognizes the harness as a distinct layer; no one
                yet gives it a contract with kernel-enforced guarantees underneath.
Implication   — Kyxo defines the behaviour contract (callbacks over kernel loop mechanics), makes
                harnesses capabilities with manifests, treats harness×model pairs as the
                benchmarkable unit, and hosts opaque harnesses as a declared lower-guarantee class.
Confidence    — HIGH for the split's direction and for harness-as-capability. MEDIUM for the
                specific callback surface (unvalidated until the doc-14 prototype and harness A/B
                exercise); the kernel/stdlib line placement is flagged for adversarial review.
```
